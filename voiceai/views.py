import os
import json
import logging
import time
import uuid
from django.shortcuts import render
from django.http import JsonResponse, HttpResponse, StreamingHttpResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods
from django.core.files.base import ContentFile
from django.conf import settings
from .models import Conversation
from .utils import transcribe_audio, generate_response, text_to_speech, text_to_speech_kokoro_stream
from .logger import logger  # Import the correctly configured logger

def home(request):
    """
    Render the home page with the voice conversation interface
    """
    return render(request, 'voiceai/home.html')

@csrf_exempt
@require_http_methods(["POST"])
def converse(request):
    """
    API endpoint to handle voice conversation with agent capabilities
    
    Process:
    1. Receive audio from the frontend
    2. Transcribe audio to text using OpenAI Whisper
    3. Generate a response using the VoiceAgent with tools and memory
    4. Convert the response to speech
    5. Return the audio and text responses with conversation context
    """
    try:
        logger.info("===== PIPELINE LOG - NEW CONVERSATION REQUEST =====")
        request_start_time = time.time()
        
        # Check if we have audio in the request
        if 'audio' not in request.FILES:
            logger.error("PIPELINE ERROR - REQUEST: No audio file provided")
            return JsonResponse({
                'success': False,
                'error': 'No audio file provided'
            }, status=400)
        
        audio_file = request.FILES['audio']
        logger.info(f"PIPELINE LOG - REQUEST: Received audio file: {audio_file.name}, size: {audio_file.size} bytes")
        
        # Get TTS method preference and conversation context
        use_offline_tts = request.POST.get('use_offline_tts', 'true').lower() == 'true'
        tts_engine = request.POST.get('tts_engine', 'pyttsx3')  # Default to pyttsx3
        conversation_id = request.POST.get('conversation_id')
        
        logger.info(f"PIPELINE LOG - REQUEST: TTS preference: {'Offline' if use_offline_tts else 'Online'}, Engine: {tts_engine}")
        logger.info(f"PIPELINE LOG - REQUEST: Conversation ID: {conversation_id or 'New conversation'}")
        
        # Transcribe the audio
        logger.info("PIPELINE LOG - MAIN STEP 1: Beginning audio transcription...")
        transcribed_text = transcribe_audio(audio_file)
        
        if not transcribed_text or transcribed_text.strip() == "":
            logger.warning("PIPELINE WARNING - EMPTY TRANSCRIPTION: Could not transcribe audio")
            return JsonResponse({
                'success': False,
                'error': 'Could not transcribe audio. Please try again with clearer audio.'
            }, status=400)
        
        # Generate a response using the agentic VoiceAgent
        logger.info("PIPELINE LOG - MAIN STEP 2: Beginning response generation with agent...")
        ai_response, new_conversation_id, tool_used = generate_response(transcribed_text, conversation_id)
        
        # Convert the response to speech using the selected engine
        logger.info("PIPELINE LOG - MAIN STEP 3: Beginning text-to-speech conversion...")
        speech_audio = text_to_speech(ai_response, use_offline=use_offline_tts, tts_engine=tts_engine)
        
        # Save the conversation for analytics and caching
        logger.info("PIPELINE LOG - MAIN STEP 4: Saving conversation to database...")
        start_save_time = time.time()
        
        try:
            # Check if conversation with this ID already exists
            if conversation_id == new_conversation_id and Conversation.objects.filter(id=new_conversation_id).exists():
                # Update existing conversation instead of creating a new one
                conversation = Conversation.objects.get(id=new_conversation_id)
                conversation.user_message = transcribed_text
                conversation.ai_response = ai_response
                logger.info(f"PIPELINE LOG - MAIN STEP 4.0: Updating existing conversation with ID: {conversation.id}")
            else:
                # Create new conversation
                conversation = Conversation(
                    id=new_conversation_id,
                    user_message=transcribed_text,
                    ai_response=ai_response
                )
                logger.info(f"PIPELINE LOG - MAIN STEP 4.0: Creating new conversation with ID: {new_conversation_id}")
            
            # Save the audio files
            audio_file.seek(0)  # Reset file pointer to beginning
            logger.info("PIPELINE LOG - MAIN STEP 4.1: Saving input audio file...")
            file_suffix = f"_{int(time.time())}" if conversation_id == new_conversation_id else ""
            conversation.audio_file.save(f"{conversation.id}_input{file_suffix}.webm", ContentFile(audio_file.read()))
            
            logger.info("PIPELINE LOG - MAIN STEP 4.2: Saving response audio file...")
            conversation.response_audio.save(f"{conversation.id}_response{file_suffix}.mp3", ContentFile(speech_audio))
            
            conversation.save()
            logger.info(f"PIPELINE LOG - MAIN STEP 4.3: Conversation saved with ID: {conversation.id}")
            
        except Exception as db_error:
            logger.error(f"PIPELINE ERROR - DB: Error saving conversation: {str(db_error)}")
            # Create a new ID if there was a conflict
            if "UNIQUE constraint failed" in str(db_error):
                new_conversation_id = str(uuid.uuid4())
                logger.info(f"PIPELINE LOG - MAIN STEP 4.0: Generated new conversation ID due to conflict: {new_conversation_id}")
                conversation = Conversation(
                    id=new_conversation_id,
                    user_message=transcribed_text,
                    ai_response=ai_response
                )
                # Save the audio files
                audio_file.seek(0)
                conversation.audio_file.save(f"{conversation.id}_input.webm", ContentFile(audio_file.read()))
                conversation.response_audio.save(f"{conversation.id}_response.mp3", ContentFile(speech_audio))
                conversation.save()
                logger.info(f"PIPELINE LOG - MAIN STEP 4.3: Conversation saved with new ID: {conversation.id}")
            else:
                # Re-raise if it's not a UNIQUE constraint issue
                raise
        
        save_duration = round(time.time() - start_save_time, 2)
        logger.info(f"PIPELINE LOG - MAIN STEP 4.4: Database save completed in {save_duration}s")
        
        # Calculate total request processing time
        total_duration = round(time.time() - request_start_time, 2)
        logger.info(f"PIPELINE LOG - COMPLETE: Total request processed in {total_duration}s")
        
        # Return the response including the conversation ID for context and tool usage
        logger.info("PIPELINE LOG - MAIN STEP 5: Returning response to client")
        return JsonResponse({
            'success': True,
            'transcribed_text': transcribed_text,
            'ai_response': ai_response,
            'audio_url': conversation.response_audio.url,
            'processing_time': total_duration,
            'conversation_id': new_conversation_id,  # Return conversation ID for subsequent requests
            'tool_used': tool_used  # Include which tool was used (if any)
        })
    
    except Exception as e:
        logger.error(f"PIPELINE ERROR - CRITICAL: Error in conversation endpoint: {str(e)}")
        return JsonResponse({
            'success': False,
            'error': str(e)
        }, status=500)

@csrf_exempt
@require_http_methods(["POST"])
def stream_tts(request):
    """
    Stream TTS output segment by segment for progressive playback
    """
    try:
        if 'text' not in request.POST:
            return JsonResponse({'error': 'No text provided'}, status=400)
            
        text = request.POST.get('text')
        logger.info(f"TTS Stream request for text: {text[:50]}...")
        
        def stream_generator():
            for segment_text, audio_data in text_to_speech_kokoro_stream(text):
                if audio_data is None:
                    # Error occurred
                    yield json.dumps({
                        'success': False,
                        'error': 'Failed to generate audio'
                    }).encode('utf-8') + b'\n'
                    return
                
                # Yield segment info and audio data as JSON
                segment_info = {
                    'success': True,
                    'text': segment_text,
                    'segment_size': len(audio_data)
                }
                
                # First yield the segment info as JSON
                yield json.dumps(segment_info).encode('utf-8') + b'\n'
                
                # Then yield the binary audio data
                yield audio_data + b'\n'
        
        return StreamingHttpResponse(
            stream_generator(),
            content_type='application/octet-stream'
        )
    
    except Exception as e:
        logger.error(f"Error in stream_tts: {str(e)}")
        return JsonResponse({'error': str(e)}, status=500)

@csrf_exempt
@require_http_methods(["POST"])
def converse_stream(request):
    """
    API endpoint that handles streamed voice conversation for lower perceived latency
    
    Process:
    1. Receive audio from the frontend
    2. Transcribe audio to text using OpenAI Whisper
    3. Generate a response using the VoiceAgent
    4. Stream the TTS output as it's generated
    """
    try:
        logger.info("===== PIPELINE LOG - NEW STREAMING CONVERSATION REQUEST =====")
        request_start_time = time.time()
        
        # Check if we have audio in the request
        if 'audio' not in request.FILES:
            return JsonResponse({'success': False, 'error': 'No audio file provided'}, status=400)
        
        # Extract request parameters
        audio_file = request.FILES['audio']
        use_offline_tts = request.POST.get('use_offline_tts', 'true').lower() == 'true'
        tts_engine = request.POST.get('tts_engine', 'kokoro')
        conversation_id = request.POST.get('conversation_id')
        
        logger.info(f"PIPELINE LOG - STREAM REQUEST: Received audio file: {audio_file.name}, size: {audio_file.size} bytes")
        logger.info(f"PIPELINE LOG - STREAM REQUEST: TTS preference: {'Offline' if use_offline_tts else 'Online'}, Engine: {tts_engine}")
        logger.info(f"PIPELINE LOG - STREAM REQUEST: Conversation ID: {conversation_id or 'New conversation'}")
        
        # --- STEP 1: Transcribe the audio ---
        transcription_start = time.time()
        transcribed_text = transcribe_audio(audio_file)
        transcription_time = time.time() - transcription_start
        
        if not transcribed_text or transcribed_text.strip() == "":
            return JsonResponse({
                'success': False,
                'error': 'Could not transcribe audio. Please try again with clearer audio.'
            }, status=400)
            
        logger.info(f"PIPELINE LOG - STREAM STEP 1: Transcription completed in {transcription_time:.2f}s: '{transcribed_text}'")
        
        # --- STEP 2: Generate AI response ---
        response_start = time.time()
        ai_response, new_conversation_id, tool_used = generate_response(transcribed_text, conversation_id)
        response_time = time.time() - response_start
        
        logger.info(f"PIPELINE LOG - STREAM STEP 2: Response generated in {response_time:.2f}s")
        
        # Create or update conversation entry in database async
        if not new_conversation_id:
            new_conversation_id = str(uuid.uuid4())
            
        # Create save function to run in background
        def save_conversation():
            try:
                if conversation_id == new_conversation_id and Conversation.objects.filter(id=new_conversation_id).exists():
                    conversation = Conversation.objects.get(id.new_conversation_id)
                    conversation.user_message = transcribed_text
                    conversation.ai_response = ai_response
                else:
                    conversation = Conversation(
                        id=new_conversation_id,
                        user_message=transcribed_text,
                        ai_response=ai_response
                    )
                    
                # Save the audio file
                audio_file.seek(0)
                file_suffix = f"_{int(time.time())}" if conversation_id == new_conversation_id else ""
                conversation.audio_file.save(f"{conversation.id}_input{file_suffix}.webm", ContentFile(audio_file.read()))
                conversation.save()
                
                logger.info(f"PIPELINE LOG - STREAM STEP 4: Conversation saved to database with ID: {conversation.id}")
            except Exception as db_error:
                logger.error(f"PIPELINE ERROR - STREAM DB: Error saving conversation: {str(db_error)}")
        
        # Start database save in background (non-blocking)
        import threading
        save_thread = threading.Thread(target=save_conversation)
        save_thread.start()
        
        # --- STEP 3: Stream the response with progressive TTS ---
        segments = split_text_into_sentences(ai_response)
        
        def generate_stream():
            # First yield the initial response data as JSON
            initial_data = {
                'success': True,
                'transcribed_text': transcribed_text,
                'ai_response': ai_response,
                'conversation_id': new_conversation_id,
                'tool_used': tool_used,
                'streaming': True,
                'segments_count': len(segments)
            }
            
            yield json.dumps(initial_data).encode('utf-8') + b'\n'
            
            # Now stream the audio segments
            segment_number = 0
            for segment_text, audio_data in text_to_speech_kokoro_stream(ai_response):
                if audio_data is None:
                    # Error occurred
                    error_data = {
                        'success': False,
                        'error': 'Failed to generate audio segment',
                        'segment': segment_number
                    }
                    yield json.dumps(error_data).encode('utf-8') + b'\n'
                    continue
                
                # Create segment metadata
                segment_info = {
                    'segment': segment_number,
                    'text': segment_text,
                    'size': len(audio_data)
                }
                
                # First yield the segment info as JSON
                yield json.dumps(segment_info).encode('utf-8') + b'\n'
                
                # Then yield the binary audio data
                yield audio_data + b'\n'
                
                segment_number += 1
                
            # All done - send completion marker
            completion_data = {
                'success': True,
                'complete': True,
                'total_segments': segment_number,
                'processing_time': round(time.time() - request_start_time, 2)
            }
            yield json.dumps(completion_data).encode('utf-8') + b'\n'
        
        return StreamingHttpResponse(
            generate_stream(),
            content_type='application/octet-stream'
        )
    
    except Exception as e:
        logger.error(f"PIPELINE ERROR - STREAM CRITICAL: Error in streaming conversation: {str(e)}")
        return JsonResponse({'success': False, 'error': str(e)}, status=500)
