import os
import json
import logging
import time
import uuid
from django.shortcuts import render
from django.http import JsonResponse, HttpResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods
from django.core.files.base import ContentFile
from django.conf import settings
from .models import Conversation
from .utils import transcribe_audio, generate_response, text_to_speech
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
        conversation_id = request.POST.get('conversation_id')
        
        logger.info(f"PIPELINE LOG - REQUEST: TTS preference: {'Offline' if use_offline_tts else 'Online'}")
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
        
        # Convert the response to speech
        logger.info("PIPELINE LOG - MAIN STEP 3: Beginning text-to-speech conversion...")
        speech_audio = text_to_speech(ai_response, use_offline=use_offline_tts)
        
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
