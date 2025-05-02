import os
import tempfile
import logging
from django.conf import settings
import openai
from openai import OpenAI
import pyttsx3
from gtts import gTTS
import uuid
import io
import platform
import time
from .logger import logger  # Import the correctly configured logger

# Initialize OpenAI client with API key
try:
    if not settings.OPENAI_API_KEY:
        raise ValueError("OPENAI_API_KEY is not set in Django settings")
        
    client = OpenAI(api_key=settings.OPENAI_API_KEY)
    # Test the client with a simple API call
    client.models.list()
    logger.info("OpenAI client initialized successfully")
except ValueError as ve:
    logger.error(f"Configuration error: {str(ve)}")
    raise
except Exception as e:
    logger.error(f"Error initializing OpenAI client: {str(e)}")
    raise

def transcribe_audio(audio_file):
    """
    Transcribe audio using OpenAI's Whisper model
    
    Args:
        audio_file: Audio file object uploaded by the user
        
    Returns:
        String containing the transcribed text
    """
    try:
        logger.info(f"PIPELINE LOG - STEP 1: Starting audio transcription process")
        start_time = time.time()
        
        # Create a temporary file to store the audio for processing
        with tempfile.NamedTemporaryFile(delete=False, suffix='.webm') as tmp_file:
            for chunk in audio_file.chunks():
                tmp_file.write(chunk)
            tmp_file_path = tmp_file.name
        
        logger.info(f"PIPELINE LOG - STEP 1.1: Saved audio to temp file: {tmp_file_path}")
        
        # Transcribe the audio using OpenAI Whisper
        with open(tmp_file_path, 'rb') as audio:
            logger.info(f"PIPELINE LOG - STEP 1.2: Sending audio to OpenAI Whisper API")
            response = client.audio.transcriptions.create(
                model="whisper-1",
                file=audio
            )
        
        # Clean up the temporary file
        os.unlink(tmp_file_path)
        
        end_time = time.time()
        duration = round(end_time - start_time, 2)
        
        logger.info(f"PIPELINE LOG - STEP 1.3: Transcription completed in {duration}s")
        logger.info(f"PIPELINE LOG - STEP 1.4: Transcribed text: \"{response.text}\"")
        
        # Return the transcribed text
        return response.text
    
    except Exception as e:
        logger.error(f"PIPELINE ERROR - STEP 1: Error transcribing audio: {str(e)}")
        raise Exception(f"Error transcribing audio: {str(e)}")

def generate_response(text, conversation_id=None):
    """
    Generate a response using the VoiceAgent with tools and memory
    
    Args:
        text: The transcribed text to process
        conversation_id: Optional ID to maintain conversation context
        
    Returns:
        String containing the AI-generated response and additional metadata
    """
    try:
        logger.info(f"PIPELINE LOG - STEP 2: Generating AI response for: \"{text}\"")
        start_time = time.time()
        
        # Use the VoiceAgent instead of direct API calls
        from .agent import VoiceAgent
        
        logger.info(f"PIPELINE LOG - STEP 2.1: Creating VoiceAgent")
        voice_agent = VoiceAgent()
        
        logger.info(f"PIPELINE LOG - STEP 2.2: Processing message with agent")
        result = voice_agent.process_message(text, conversation_id)
        
        ai_response = result["response"]
        new_conversation_id = result["conversation_id"]
        tool_used = result.get("tool_used")
        
        # Log the outcome including whether tools were used
        end_time = time.time()
        duration = round(end_time - start_time, 2)
        
        logger.info(f"PIPELINE LOG - STEP 2.3: Response generated in {duration}s")
        logger.info(f"PIPELINE LOG - STEP 2.4: AI response: \"{ai_response}\"")
        
        if tool_used:
            logger.info(f"PIPELINE LOG - STEP 2.5: Tool used by agent: {tool_used}")
        
        if conversation_id != new_conversation_id:
            logger.info(f"PIPELINE LOG - STEP 2.6: New conversation created with ID: {new_conversation_id}")
        
        # Return the generated response, conversation ID, and tool usage information
        return ai_response, new_conversation_id, tool_used
    
    except Exception as e:
        logger.error(f"PIPELINE ERROR - STEP 2: Error generating response: {str(e)}")
        raise Exception(f"Error generating response: {str(e)}")

def text_to_speech_pyttsx3(text):
    """
    Convert text to speech using pyttsx3 (offline)
    
    Args:
        text: The text to convert to speech
        
    Returns:
        Bytes containing the audio data
    """
    try:
        logger.info(f"PIPELINE LOG - STEP 3.1: Converting text to speech with pyttsx3")
        start_time = time.time()
        
        # Due to issues with pyttsx3 on macOS, we'll use a more reliable approach
        # Create a BytesIO object to store the audio directly in memory
        audio_data = io.BytesIO()
        
        # Check platform for specific handling
        system = platform.system()
        logger.info(f"PIPELINE LOG - STEP 3.1.1: Detected platform: {system}")
        
        if system == 'Darwin':  # macOS
            # On macOS, ensure we use a custom temp directory that's definitely accessible
            temp_dir = os.path.join(settings.MEDIA_ROOT, 'tmp')
            os.makedirs(temp_dir, exist_ok=True)
            
            filename = f"{uuid.uuid4()}.mp3"
            filepath = os.path.join(temp_dir, filename)
            logger.info(f"PIPELINE LOG - STEP 3.1.2: Using macOS path: {filepath}")
            
            # Initialize the TTS engine
            engine = pyttsx3.init()
            engine.setProperty('rate', 175)  # Speed of speech
            
            # Save to file
            logger.info(f"PIPELINE LOG - STEP 3.1.3: Saving speech to file")
            engine.save_to_file(text, filepath)
            engine.runAndWait()
            
            # Check if file exists
            if not os.path.exists(filepath):
                logger.warning(f"PIPELINE LOG - STEP 3.1.4: pyttsx3 failed to create file, falling back to gTTS")
                return text_to_speech_gtts(text)
            
            # Read the file into memory
            logger.info(f"PIPELINE LOG - STEP 3.1.5: Reading audio from file")
            with open(filepath, 'rb') as f:
                audio_data = f.read()
            
            file_size = len(audio_data)
            logger.info(f"PIPELINE LOG - STEP 3.1.6: Audio file size: {file_size} bytes")
            
            # Clean up the file
            if os.path.exists(filepath):
                os.remove(filepath)
                logger.info(f"PIPELINE LOG - STEP 3.1.7: Removed temporary audio file")
        else:
            # For other platforms, continue with the original approach
            filename = f"{uuid.uuid4()}.mp3"
            filepath = os.path.join(tempfile.gettempdir(), filename)
            logger.info(f"PIPELINE LOG - STEP 3.1.2: Using path: {filepath}")
            
            # Initialize the TTS engine
            engine = pyttsx3.init()
            engine.setProperty('rate', 175)  # Speed of speech
            
            # Save to file
            engine.save_to_file(text, filepath)
            engine.runAndWait()
            
            # Read the file into memory
            with open(filepath, 'rb') as f:
                audio_data = f.read()
            
            # Clean up the file
            if os.path.exists(filepath):
                os.remove(filepath)
        
        end_time = time.time()
        duration = round(end_time - start_time, 2)
        logger.info(f"PIPELINE LOG - STEP 3.1.8: pyttsx3 conversion completed in {duration}s")
        
        return audio_data
    
    except Exception as e:
        logger.error(f"PIPELINE ERROR - STEP 3.1: Error converting text to speech with pyttsx3: {str(e)}")
        logger.info(f"PIPELINE LOG - STEP 3.1.9: Falling back to gTTS for text-to-speech conversion")
        return text_to_speech_gtts(text)

def text_to_speech_gtts(text):
    """
    Convert text to speech using Google Text-to-Speech (online)
    
    Args:
        text: The text to convert to speech
        
    Returns:
        Bytes containing the audio data
    """
    try:
        logger.info(f"PIPELINE LOG - STEP 3.2: Converting text to speech with gTTS")
        start_time = time.time()
        
        # Create a BytesIO object to store the audio
        mp3_io = io.BytesIO()
        
        # Initialize gTTS and generate speech
        logger.info(f"PIPELINE LOG - STEP 3.2.1: Sending text to Google TTS API")
        tts = gTTS(text=text, lang='en', slow=False)
        tts.write_to_fp(mp3_io)
        mp3_io.seek(0)
        
        audio_data = mp3_io.read()
        file_size = len(audio_data)
        logger.info(f"PIPELINE LOG - STEP 3.2.2: Received audio data, size: {file_size} bytes")
        
        end_time = time.time()
        duration = round(end_time - start_time, 2)
        logger.info(f"PIPELINE LOG - STEP 3.2.3: gTTS conversion completed in {duration}s")
        
        # Return the audio data
        return audio_data
    
    except Exception as e:
        logger.error(f"PIPELINE ERROR - STEP 3.2: Error converting text to speech with gTTS: {str(e)}")
        raise Exception(f"Error converting text to speech: {str(e)}")

def text_to_speech(text, use_offline=True):
    """
    Convert text to speech using the specified method
    
    Args:
        text: The text to convert to speech
        use_offline: Whether to use the offline (pyttsx3) or online (gTTS) method
        
    Returns:
        Bytes containing the audio data
    """
    logger.info(f"PIPELINE LOG - STEP 3: Starting text-to-speech conversion")
    logger.info(f"PIPELINE LOG - STEP 3.0: TTS method selected: {'pyttsx3 (offline)' if use_offline else 'gTTS (online)'}")
    
    if use_offline:
        return text_to_speech_pyttsx3(text)
    else:
        return text_to_speech_gtts(text)