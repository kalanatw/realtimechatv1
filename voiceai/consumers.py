"""
WebSocket consumers for the voiceai app.

These consumers handle WebSocket connections for real-time voice conversations,
reusing the existing agent logic from the HTTP views.
"""
import json
import base64
import asyncio
import tempfile
import os
from io import BytesIO
from channels.generic.websocket import AsyncWebsocketConsumer
from django.core.files.base import ContentFile
from django.conf import settings
from .utils import transcribe_audio, generate_response, text_to_speech, text_to_speech_kokoro_stream
from .logger import logger

class VoiceAIConsumer(AsyncWebsocketConsumer):
    """
    WebSocket consumer for handling voice conversations.
    This consumer mimics the behavior of the HTTP-based converse endpoint.
    """
    async def connect(self):
        """Handle WebSocket connection."""
        logger.info("WebSocket connection established for voice conversation")
        await self.accept()

    async def disconnect(self, close_code):
        """Handle WebSocket disconnection."""
        logger.info(f"WebSocket connection closed with code: {close_code}")

    async def receive(self, text_data=None, bytes_data=None):
        """
        Handle incoming WebSocket messages.
        
        Args:
            text_data: JSON text data (for metadata and commands)
            bytes_data: Binary data (for audio)
        """
        try:
            # Handle text data (metadata, commands)
            if text_data:
                data = json.loads(text_data)
                message_type = data.get('type')
                
                if message_type == 'metadata':
                    # Store metadata for use when processing audio
                    self.use_offline_tts = data.get('use_offline_tts', True)
                    self.tts_engine = data.get('tts_engine', 'pyttsx3')
                    self.conversation_id = data.get('conversation_id')
                    
                    logger.info(f"WebSocket metadata received: TTS={self.tts_engine}, Offline={self.use_offline_tts}, ConvID={self.conversation_id}")
                    await self.send(text_data=json.dumps({
                        'type': 'metadata_received',
                        'success': True
                    }))
                
                elif message_type == 'ping':
                    # Simple ping/pong for connection testing
                    await self.send(text_data=json.dumps({
                        'type': 'pong',
                        'timestamp': data.get('timestamp')
                    }))
            
            # Handle binary data (audio)
            elif bytes_data:
                logger.info("WebSocket binary audio data received")
                
                # Process the audio data asynchronously
                asyncio.create_task(self.process_audio(bytes_data))
        
        except Exception as e:
            logger.error(f"Error in WebSocket receive: {str(e)}")
            await self.send(text_data=json.dumps({
                'type': 'error',
                'message': str(e)
            }))

    async def process_audio(self, audio_data):
        """
        Process audio data received via WebSocket.
        This reuses the existing logic from the HTTP views.
        
        Args:
            audio_data: Binary audio data
        """
        try:
            logger.info("===== WEBSOCKET - NEW CONVERSATION REQUEST =====")
            
            # Create a temporary file for the audio
            with tempfile.NamedTemporaryFile(delete=False, suffix='.webm') as tmp_file:
                tmp_file.write(audio_data)
                tmp_file_path = tmp_file.name
            
            logger.info(f"WEBSOCKET - Saved audio to temp file: {tmp_file_path}")
            
            # Get conversation context from instance variables or use defaults
            use_offline_tts = getattr(self, 'use_offline_tts', True)
            tts_engine = getattr(self, 'tts_engine', 'pyttsx3')
            conversation_id = getattr(self, 'conversation_id', None)
            
            # Open the file and create a file-like object with chunks method for transcription
            class ChunkedFile:
                def __init__(self, file_path):
                    self.file_path = file_path
                    self.file = open(file_path, 'rb')
                
                def chunks(self):
                    # Read the entire file as one chunk
                    self.file.seek(0)
                    yield self.file.read()
                
                def __del__(self):
                    if hasattr(self, 'file') and self.file:
                        self.file.close()
            
            audio_file = ChunkedFile(tmp_file_path)
            
            # Run transcription in a thread pool to avoid blocking the event loop
            transcribed_text = await asyncio.to_thread(
                transcribe_audio, 
                audio_file
            )
            
            # Clean up resources
            del audio_file
            
            if not transcribed_text or transcribed_text.strip() == "":
                await self.send(text_data=json.dumps({
                    'type': 'error',
                    'message': 'Could not transcribe audio. Please try again with clearer audio.'
                }))
                os.unlink(tmp_file_path)
                return
            
            # Send transcription result
            await self.send(text_data=json.dumps({
                'type': 'transcription',
                'text': transcribed_text
            }))
            
            # Generate response using the agent (run in thread pool)
            ai_response, new_conversation_id, tool_used = await asyncio.to_thread(
                generate_response,
                transcribed_text,
                conversation_id
            )
            
            # Convert response to speech
            speech_audio = await asyncio.to_thread(
                text_to_speech,
                ai_response,
                use_offline=use_offline_tts,
                tts_engine=tts_engine
            )
            
            # Save conversation for analytics and caching (in background)
            asyncio.create_task(self.save_conversation(
                transcribed_text,
                ai_response,
                audio_data,
                speech_audio,
                new_conversation_id,
                conversation_id
            ))
            
            # Send the AI response as text
            await self.send(text_data=json.dumps({
                'type': 'ai_response',
                'text': ai_response,
                'conversation_id': new_conversation_id,
                'tool_used': tool_used
            }))
            
            # Send the audio response as binary data
            # First send message with audio metadata
            await self.send(text_data=json.dumps({
                'type': 'audio_metadata',
                'size': len(speech_audio)
            }))
            
            # Then send actual audio data
            await self.send(bytes_data=speech_audio)
            
            # Clean up temporary file
            os.unlink(tmp_file_path)
            
            logger.info("WEBSOCKET - Voice conversation processing complete")
            
        except Exception as e:
            logger.error(f"WEBSOCKET ERROR - Voice processing: {str(e)}")
            await self.send(text_data=json.dumps({
                'type': 'error',
                'message': str(e)
            }))
    
    async def save_conversation(self, user_message, ai_response, audio_data, speech_audio, new_conversation_id, old_conversation_id=None):
        """
        Save the conversation to the database.
        This is run as a background task to avoid blocking the WebSocket.
        
        Args:
            user_message: The transcribed user message
            ai_response: The AI-generated response
            audio_data: The user's audio data
            speech_audio: The AI's speech audio
            new_conversation_id: The conversation ID
            old_conversation_id: The previous conversation ID if any
        """
        try:
            from .models import Conversation
            
            # Run the database operations in a thread pool
            await asyncio.to_thread(self._save_conversation_sync, 
                user_message, 
                ai_response, 
                audio_data, 
                speech_audio,
                new_conversation_id,
                old_conversation_id
            )
            
        except Exception as e:
            logger.error(f"WEBSOCKET ERROR - Error saving conversation: {str(e)}")
    
    def _save_conversation_sync(self, user_message, ai_response, audio_data, speech_audio, new_conversation_id, old_conversation_id=None):
        """
        Synchronous method to save conversation to database.
        This is run in a thread pool.
        """
        from .models import Conversation
        
        try:
            # Check if conversation with this ID already exists
            if old_conversation_id == new_conversation_id and Conversation.objects.filter(id=new_conversation_id).exists():
                # Update existing conversation instead of creating a new one
                conversation = Conversation.objects.get(id=new_conversation_id)
                conversation.user_message = user_message
                conversation.ai_response = ai_response
                logger.info(f"WEBSOCKET - Updating existing conversation with ID: {conversation.id}")
            else:
                # Create new conversation
                conversation = Conversation(
                    id=new_conversation_id,
                    user_message=user_message,
                    ai_response=ai_response
                )
                logger.info(f"WEBSOCKET - Creating new conversation with ID: {new_conversation_id}")
            
            # Save the audio files
            import time
            file_suffix = f"_{int(time.time())}" if old_conversation_id == new_conversation_id else ""
            
            # Save input audio
            conversation.audio_file.save(
                f"{conversation.id}_input{file_suffix}.webm", 
                ContentFile(audio_data)
            )
            
            # Save response audio
            conversation.response_audio.save(
                f"{conversation.id}_response{file_suffix}.mp3", 
                ContentFile(speech_audio)
            )
            
            conversation.save()
            logger.info(f"WEBSOCKET - Conversation saved with ID: {conversation.id}")
            
        except Exception as e:
            logger.error(f"WEBSOCKET ERROR - Database error: {str(e)}")
            raise


class VoiceAIStreamConsumer(AsyncWebsocketConsumer):
    """
    WebSocket consumer for streaming voice conversations.
    This consumer mimics the behavior of the HTTP-based streaming endpoints
    but with WebSocket-based real-time communication.
    """
    async def connect(self):
        """Handle WebSocket connection."""
        logger.info("WebSocket connection established for streaming voice conversation")
        await self.accept()

    async def disconnect(self, close_code):
        """Handle WebSocket disconnection."""
        logger.info(f"WebSocket streaming connection closed with code: {close_code}")

    async def receive(self, text_data=None, bytes_data=None):
        """
        Handle incoming WebSocket messages for streaming.
        
        Args:
            text_data: JSON text data (for metadata and commands)
            bytes_data: Binary data (for audio)
        """
        try:
            # Handle text data (metadata, commands)
            if text_data:
                data = json.loads(text_data)
                message_type = data.get('type')
                
                if message_type == 'metadata':
                    # Store metadata for use when processing audio
                    self.use_offline_tts = data.get('use_offline_tts', True)
                    self.tts_engine = data.get('tts_engine', 'kokoro')
                    self.conversation_id = data.get('conversation_id')
                    
                    logger.info(f"WebSocket stream metadata received: TTS={self.tts_engine}, Offline={self.use_offline_tts}, ConvID={self.conversation_id}")
                    await self.send(text_data=json.dumps({
                        'type': 'metadata_received',
                        'success': True
                    }))
                
                elif message_type == 'tts_request':
                    # Handle direct TTS request (text to speech)
                    text = data.get('text', '')
                    if text:
                        asyncio.create_task(self.stream_tts(text))
                    else:
                        await self.send(text_data=json.dumps({
                            'type': 'error',
                            'message': 'No text provided for TTS'
                        }))
            
            # Handle binary data (audio)
            elif bytes_data:
                logger.info("WebSocket stream binary audio data received")
                
                # Process the audio data with streaming response
                asyncio.create_task(self.process_streaming_audio(bytes_data))
        
        except Exception as e:
            logger.error(f"Error in WebSocket stream receive: {str(e)}")
            await self.send(text_data=json.dumps({
                'type': 'error',
                'message': str(e)
            }))

    async def process_streaming_audio(self, audio_data):
        """
        Process audio data and stream the response.
        
        Args:
            audio_data: Binary audio data
        """
        try:
            logger.info("===== WEBSOCKET STREAM - NEW CONVERSATION REQUEST =====")
            
            # Create a temporary file for the audio
            with tempfile.NamedTemporaryFile(delete=False, suffix='.webm') as tmp_file:
                tmp_file.write(audio_data)
                tmp_file_path = tmp_file.name
            
            # Get conversation context from instance variables or use defaults
            use_offline_tts = getattr(self, 'use_offline_tts', True)
            tts_engine = getattr(self, 'tts_engine', 'kokoro')
            conversation_id = getattr(self, 'conversation_id', None)
            
            # Create a ChunkedFile class like the one in VoiceAIConsumer
            class ChunkedFile:
                def __init__(self, file_path):
                    self.file_path = file_path
                    self.file = open(file_path, 'rb')
                
                def chunks(self):
                    # Read the entire file as one chunk
                    self.file.seek(0)
                    yield self.file.read()
                
                def __del__(self):
                    if hasattr(self, 'file') and self.file:
                        self.file.close()
            
            audio_file = ChunkedFile(tmp_file_path)
            
            # Run transcription in a thread pool
            transcribed_text = await asyncio.to_thread(
                transcribe_audio, 
                audio_file
            )
            
            # Clean up resources
            del audio_file
            
            if not transcribed_text or transcribed_text.strip() == "":
                await self.send(text_data=json.dumps({
                    'type': 'error',
                    'message': 'Could not transcribe audio. Please try again with clearer audio.'
                }))
                os.unlink(tmp_file_path)
                return
            
            # Send transcription result immediately
            await self.send(text_data=json.dumps({
                'type': 'transcription',
                'text': transcribed_text
            }))
            
            # Generate response using the agent (run in thread pool)
            ai_response, new_conversation_id, tool_used = await asyncio.to_thread(
                generate_response,
                transcribed_text,
                conversation_id
            )
            
            # Send the complete AI response as text
            await self.send(text_data=json.dumps({
                'type': 'ai_response',
                'text': ai_response,
                'conversation_id': new_conversation_id,
                'tool_used': tool_used
            }))
            
            # Save conversation in background
            asyncio.create_task(self.save_conversation(
                transcribed_text,
                ai_response,
                audio_data,
                None,  # No complete audio file yet
                new_conversation_id,
                conversation_id
            ))
            
            # Stream the TTS audio segments
            await self.stream_tts(ai_response)
            
            # Clean up temporary file
            os.unlink(tmp_file_path)
            
            logger.info("WEBSOCKET STREAM - Voice conversation processing complete")
            
        except Exception as e:
            logger.error(f"WEBSOCKET STREAM ERROR - Voice processing: {str(e)}")
            await self.send(text_data=json.dumps({
                'type': 'error',
                'message': str(e)
            }))
    
    async def stream_tts(self, text):
        """
        Stream TTS output segment by segment.
        
        Args:
            text: Text to convert to speech
        """
        try:
            logger.info(f"WEBSOCKET STREAM - Starting TTS streaming for text: {text[:50]}...")
            
            # Use the generator from the existing streaming implementation
            tts_generator = text_to_speech_kokoro_stream(text)
            
            segment_number = 0
            async for segment_text, audio_data in self._wrap_generator_as_async(tts_generator):
                if audio_data is None:
                    await self.send(text_data=json.dumps({
                        'type': 'tts_error',
                        'message': 'Failed to generate audio segment'
                    }))
                    continue
                
                # Send segment metadata
                await self.send(text_data=json.dumps({
                    'type': 'tts_segment',
                    'segment': segment_number,
                    'text': segment_text,
                    'size': len(audio_data)
                }))
                
                # Send audio data
                await self.send(bytes_data=audio_data)
                
                segment_number += 1
            
            # Send completion marker
            await self.send(text_data=json.dumps({
                'type': 'tts_complete',
                'segments': segment_number
            }))
            
        except Exception as e:
            logger.error(f"WEBSOCKET STREAM ERROR - TTS streaming: {str(e)}")
            await self.send(text_data=json.dumps({
                'type': 'error',
                'message': f"TTS streaming error: {str(e)}"
            }))
    
    async def _wrap_generator_as_async(self, generator):
        """
        Wrap a synchronous generator as an async generator.
        
        Args:
            generator: Synchronous generator to wrap
            
        Yields:
            Items from the synchronous generator
        """
        loop = asyncio.get_event_loop()
        for item in generator:
            # Convert synchronous generator to async by yielding in the event loop
            yield item
            # Allow other tasks to run between iterations
            await asyncio.sleep(0)
    
    async def save_conversation(self, user_message, ai_response, audio_data, speech_audio, new_conversation_id, old_conversation_id=None):
        """
        Save the conversation to the database.
        This is run as a background task.
        
        Args:
            user_message: The transcribed user message
            ai_response: The AI-generated response
            audio_data: The user's audio data
            speech_audio: The AI's speech audio (may be None for streaming)
            new_conversation_id: The conversation ID
            old_conversation_id: The previous conversation ID if any
        """
        # Reuse the same implementation as the non-streaming consumer
        from .models import Conversation
        
        # Run the database operations in a thread pool
        await asyncio.to_thread(
            self._save_conversation_sync,
            user_message, 
            ai_response, 
            audio_data, 
            speech_audio,
            new_conversation_id,
            old_conversation_id
        )
    
    def _save_conversation_sync(self, user_message, ai_response, audio_data, speech_audio, new_conversation_id, old_conversation_id=None):
        """
        Synchronous method to save conversation to database.
        This is run in a thread pool.
        """
        from .models import Conversation
        
        try:
            # Check if conversation with this ID already exists
            if old_conversation_id == new_conversation_id and Conversation.objects.filter(id=new_conversation_id).exists():
                # Update existing conversation
                conversation = Conversation.objects.get(id=new_conversation_id)
                conversation.user_message = user_message
                conversation.ai_response = ai_response
                logger.info(f"WEBSOCKET STREAM - Updating existing conversation with ID: {conversation.id}")
            else:
                # Create new conversation
                conversation = Conversation(
                    id=new_conversation_id,
                    user_message=user_message,
                    ai_response=ai_response
                )
                logger.info(f"WEBSOCKET STREAM - Creating new conversation with ID: {new_conversation_id}")
            
            # Save the input audio file
            import time
            file_suffix = f"_{int(time.time())}" if old_conversation_id == new_conversation_id else ""
            
            conversation.audio_file.save(
                f"{conversation.id}_input{file_suffix}.webm", 
                ContentFile(audio_data)
            )
            
            # Save response audio if available (might be None for streaming)
            if speech_audio:
                conversation.response_audio.save(
                    f"{conversation.id}_response{file_suffix}.mp3", 
                    ContentFile(speech_audio)
                )
            
            conversation.save()
            logger.info(f"WEBSOCKET STREAM - Conversation saved with ID: {conversation.id}")
            
        except Exception as e:
            logger.error(f"WEBSOCKET STREAM ERROR - Database error: {str(e)}")