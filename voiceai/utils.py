import os
import tempfile
import logging
import subprocess  # Add this import for espeak-ng checks
from django.conf import settings
import openai
from openai import OpenAI
import pyttsx3
from gtts import gTTS
import uuid
import io
import platform
import time
import threading
import numpy as np
import functools
from concurrent.futures import ThreadPoolExecutor
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

# Global variables for Kokoro
KOKORO_AVAILABLE = False
kokoro_pipeline = None
kokoro_lock = threading.RLock()  # Add thread lock for pipeline access
kokoro_cache = {}  # Simple cache for TTS results
MAX_CACHE_SIZE = 100  # Maximum number of items to cache

# Thread pool for parallel processing
executor = ThreadPoolExecutor(max_workers=2)

def initialize_kokoro():
    """
    Initialize the Kokoro TTS pipeline
    Returns True if successful, False otherwise
    """
    global KOKORO_AVAILABLE, kokoro_pipeline
    
    with kokoro_lock:
        if KOKORO_AVAILABLE and kokoro_pipeline is not None:
            return True
            
        try:
            # Check if espeak-ng is installed (required by Kokoro)
            espeak_check = subprocess.run(['which', 'espeak-ng'], 
                                        stdout=subprocess.PIPE, 
                                        stderr=subprocess.PIPE)
            
            if espeak_check.returncode != 0:
                logger.warning("espeak-ng not found. Kokoro requires espeak-ng to function properly.")
                logger.warning("Install it with: apt-get -y install espeak-ng")
                logger.warning("Kokoro will be unavailable for TTS")
                return False
                
            # Now try to import and initialize Kokoro
            import torch
            from kokoro import KPipeline
            import soundfile as sf
            
            # Create a global pipeline instance
            logger.info("Initializing Kokoro TTS pipeline with American English voice...")
            kokoro_pipeline = KPipeline(lang_code='a')  # 'a' is American English
            
            # Verify pipeline is working with a simple test
            test_text = "Kokoro initialization test."
            logger.info("Testing Kokoro pipeline with sample text...")
            generator = kokoro_pipeline(test_text, voice='af_heart')
            
            # Just try to get the first item to verify it works
            for i, (gs, ps, audio) in enumerate(generator):
                if i == 0 and audio is not None:
                    KOKORO_AVAILABLE = True
                    logger.info("Kokoro TTS pipeline initialized and tested successfully!")
                    return True
                break
                
            logger.warning("Kokoro pipeline initialization test failed - no audio generated")
            return False
            
        except ImportError as e:
            logger.warning(f"Kokoro import error: {str(e)}")
            logger.warning("Install Kokoro with: pip install kokoro>=0.9.4 soundfile")
            KOKORO_AVAILABLE = False
            return False
        except Exception as e:
            logger.error(f"Error initializing Kokoro TTS: {str(e)}")
            KOKORO_AVAILABLE = False
            return False

def preheat_kokoro():
    """
    Pre-heat the Kokoro model by generating a short sample
    to avoid cold-start latency on first real request
    """
    if not KOKORO_AVAILABLE or kokoro_pipeline is None:
        return
    
    try:
        # Use a short text to warm up the model
        warmup_text = "Hello, the system is ready."
        logger.info("Pre-heating Kokoro TTS with sample text")
        
        # Run the generator but just iterate through it without saving
        generator = kokoro_pipeline(warmup_text, voice='af_heart')
        for i, (gs, ps, audio) in enumerate(generator):
            pass  # Just iterate through to warm up the model
            
        logger.info("Kokoro TTS model pre-heated successfully")
    except Exception as e:
        logger.error(f"Error pre-heating Kokoro TTS: {str(e)}")

# Try to initialize Kokoro on module import
try:
    initialize_kokoro()
except Exception:
    # Log error is handled inside the function
    pass

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

def split_text_into_sentences(text, max_length=100):
    """Split text into manageable sentences for parallel processing"""
    import re
    
    # First split by sentence-ending punctuation
    sentences = re.split(r'(?<=[.!?])\s+', text)
    
    # Further split long sentences
    result = []
    for sentence in sentences:
        if len(sentence) <= max_length:
            result.append(sentence)
        else:
            # Split by commas or other natural pauses
            parts = re.split(r'(?<=[:;,])\s+', sentence)
            for part in parts:
                if len(part) <= max_length:
                    result.append(part)
                else:
                    # Break down by words if still too long
                    words = part.split()
                    current_chunk = []
                    current_length = 0
                    
                    for word in words:
                        if current_length + len(word) + 1 <= max_length:
                            current_chunk.append(word)
                            current_length += len(word) + 1
                        else:
                            if current_chunk:
                                result.append(' '.join(current_chunk))
                            current_chunk = [word]
                            current_length = len(word)
                    
                    if current_chunk:
                        result.append(' '.join(current_chunk))
    
    return result

def process_text_segment(segment, voice='af_heart'):
    """Process a single text segment with Kokoro"""
    global kokoro_pipeline, kokoro_cache
    
    # Check cache first
    cache_key = f"{segment}_{voice}"
    with kokoro_lock:
        if cache_key in kokoro_cache:
            logger.info(f"Cache hit for segment: '{segment[:20]}...'")
            return kokoro_cache[cache_key]
    
    # Not in cache, process with Kokoro
    try:
        # Process segment
        generator = kokoro_pipeline(segment, voice=voice)
        audio_segment = None
        for i, (gs, ps, audio) in enumerate(generator):
            audio_segment = audio
            break
        
        # Cache result if we got audio
        if audio_segment is not None:
            with kokoro_lock:
                # Manage cache size
                if len(kokoro_cache) >= MAX_CACHE_SIZE:
                    # Remove oldest item (simple approach)
                    kokoro_cache.pop(next(iter(kokoro_cache)))
                
                # Add to cache
                kokoro_cache[cache_key] = audio_segment
        
        return audio_segment
    except Exception as e:
        logger.error(f"Error processing segment '{segment[:20]}...': {str(e)}")
        return None

def text_to_speech_kokoro(text):
    """
    Convert text to speech using Kokoro TTS with optimized performance
    
    Args:
        text: The text to convert to speech
        
    Returns:
        Bytes containing the audio data
    """
    try:
        logger.info(f"PIPELINE LOG - STEP 3.3: Converting text to speech with Kokoro TTS")
        start_time = time.time()
        
        # Check if Kokoro is available
        if not KOKORO_AVAILABLE or kokoro_pipeline is None:
            # Try to initialize it one more time
            logger.info("Attempting to reinitialize Kokoro...")
            if not initialize_kokoro():
                logger.warning("Kokoro TTS not available, falling back to Google TTS")
                return text_to_speech_gtts(text)
        
        # Process the text with Kokoro directly
        logger.info(f"PIPELINE LOG - STEP 3.3.1: Generating speech with Kokoro")
        
        # Check if the entire text is in cache
        cache_key = f"{text}_af_heart"
        with kokoro_lock:
            if cache_key in kokoro_cache:
                logger.info(f"Full cache hit for text: '{text[:30]}...'")
                audio_data = kokoro_cache[cache_key]
                
                # Convert to bytes using in-memory buffer
                audio_buffer = io.BytesIO()
                import soundfile as sf
                sf.write(audio_buffer, audio_data, 24000, format='WAV')
                audio_buffer.seek(0)
                file_data = audio_buffer.read()
                
                end_time = time.time()
                duration = round(end_time - start_time, 2)
                logger.info(f"PIPELINE LOG - STEP 3.3.2: Cache retrieval completed in {duration}s")
                
                return file_data
        
        # Split text into smaller segments for parallel processing
        segments = split_text_into_sentences(text)
        
        # Process segments in parallel
        futures = []
        for segment in segments:
            if segment.strip():  # Skip empty segments
                futures.append(executor.submit(process_text_segment, segment))
        
        # Collect audio segments
        all_audio = []
        for i, future in enumerate(futures):
            try:
                audio = future.result(timeout=3.0)  # Add timeout to prevent hangs
                if audio is not None:
                    all_audio.append(audio)
                    logger.info(f"PIPELINE LOG - STEP 3.3.2: Generated segment {i}: '{segments[i][:30]}...'")
            except Exception as e:
                logger.error(f"Error processing segment {i}: {str(e)}")
        
        # Check if we got any audio segments
        if not all_audio:
            logger.warning("PIPELINE LOG - STEP 3.3.3: No audio generated by Kokoro, falling back to Google TTS")
            return text_to_speech_gtts(text)
        
        # If we have multiple segments, concatenate them
        if len(all_audio) > 1:
            final_audio = np.concatenate(all_audio)
        else:
            final_audio = all_audio[0]
        
        # Write to in-memory buffer
        audio_buffer = io.BytesIO()
        import soundfile as sf
        sf.write(audio_buffer, final_audio, 24000, format='WAV')
        audio_buffer.seek(0)
        audio_data = audio_buffer.read()
        
        # Cache entire audio if it's not too large
        if len(final_audio) < 1000000:  # Don't cache files larger than ~1MB
            with kokoro_lock:
                if len(kokoro_cache) >= MAX_CACHE_SIZE:
                    # Remove oldest item
                    kokoro_cache.pop(next(iter(kokoro_cache)))
                
                # Add to cache
                kokoro_cache[cache_key] = final_audio
        
        file_size = len(audio_data)
        logger.info(f"PIPELINE LOG - STEP 3.3.4: Memory audio buffer size: {file_size} bytes")
        
        end_time = time.time()
        duration = round(end_time - start_time, 2)
        logger.info(f"PIPELINE LOG - STEP 3.3.6: Kokoro TTS conversion completed in {duration}s")
        
        return audio_data
        
    except Exception as e:
        logger.error(f"PIPELINE ERROR - STEP 3.3: Error converting text to speech with Kokoro: {str(e)}")
        logger.info(f"PIPELINE LOG - STEP 3.3.7: Falling back to Google TTS for text-to-speech conversion")
        return text_to_speech_gtts(text)

def text_to_speech_kokoro_stream(text):
    """
    Convert text to speech using Kokoro TTS with streaming support
    
    Args:
        text: The text to convert to speech
        
    Returns:
        Generator yielding (segment_text, audio_data) tuples
    """
    try:
        logger.info(f"PIPELINE LOG - STREAM STEP 3: Converting text to speech with Kokoro TTS streaming")
        start_time = time.time()
        
        # Check if Kokoro is available
        if not KOKORO_AVAILABLE or kokoro_pipeline is None:
            # Try to initialize it one more time
            logger.info("Attempting to reinitialize Kokoro...")
            if not initialize_kokoro():
                logger.warning("Kokoro TTS not available, cannot stream")
                yield None, None
                return
                
        # Split text into smaller segments for faster processing
        sentences = split_text_into_sentences(text)
        logger.info(f"PIPELINE LOG - STREAM STEP 3.1: Split text into {len(sentences)} segments")
        
        import soundfile as sf
        import io
        
        for i, segment in enumerate(sentences):
            segment_start = time.time()
            logger.info(f"PIPELINE LOG - STREAM STEP 3.2: Processing segment {i}: '{segment[:30]}...'")
            
            # Check cache first for quicker response
            cache_key = f"{segment}_af_heart"
            with kokoro_lock:
                if cache_key in kokoro_cache:
                    logger.info(f"Cache hit for segment: '{segment[:20]}...'")
                    audio_data = kokoro_cache[cache_key]
                    
                    # Convert to audio file bytes
                    audio_buffer = io.BytesIO()
                    sf.write(audio_buffer, audio_data, 24000, format='WAV')
                    audio_buffer.seek(0)
                    
                    segment_duration = round(time.time() - segment_start, 2)
                    logger.info(f"PIPELINE LOG - STREAM STEP 3.3: Segment {i} from cache in {segment_duration}s")
                    
                    yield segment, audio_buffer.read()
                    continue
            
            # Not in cache, process with Kokoro
            try:
                # Process segment
                generator = kokoro_pipeline(segment, voice='af_heart')
                for j, (gs, ps, audio) in enumerate(generator):
                    if audio is not None:
                        # Cache the result
                        with kokoro_lock:
                            if len(kokoro_cache) >= MAX_CACHE_SIZE:
                                kokoro_cache.pop(next(iter(kokoro_cache)))
                            kokoro_cache[cache_key] = audio
                        
                        # Convert to audio file bytes
                        audio_buffer = io.BytesIO()
                        sf.write(audio_buffer, audio, 24000, format='WAV')
                        audio_buffer.seek(0)
                        
                        segment_duration = round(time.time() - segment_start, 2)
                        logger.info(f"PIPELINE LOG - STREAM STEP 3.3: Generated segment {i} in {segment_duration}s")
                        
                        yield segment, audio_buffer.read()
                        break
            except Exception as e:
                logger.error(f"Error processing segment {i}: {str(e)}")
                # Continue to next segment on error
                continue
                
        stream_duration = round(time.time() - start_time, 2)
        logger.info(f"PIPELINE LOG - STREAM STEP 3.4: All segments processed in {stream_duration}s")
        
    except Exception as e:
        logger.error(f"PIPELINE ERROR - STREAM STEP 3: Error in streaming TTS: {str(e)}")
        yield None, None

def text_to_speech(text, use_offline=True, tts_engine='kokoro'):
    """
    Convert text to speech using the specified method
    
    Args:
        text: The text to convert to speech
        use_offline: Whether to use offline TTS methods
        tts_engine: Which TTS engine to use ('pyttsx3', 'gtts', or 'kokoro')
        
    Returns:
        Bytes containing the audio data
    """
    logger.info(f"PIPELINE LOG - STEP 3: Starting text-to-speech conversion")
    
    # Always try Kokoro first unless explicitly overridden
    if tts_engine == 'kokoro' or tts_engine == 'pyttsx3':
        if KOKORO_AVAILABLE or initialize_kokoro():
            logger.info(f"PIPELINE LOG - STEP 3.0: TTS method selected: Kokoro TTS")
            return text_to_speech_kokoro(text)
        else:
            # Kokoro unavailable, follow fallback chain
            logger.info(f"PIPELINE LOG - STEP 3.0: Kokoro unavailable, falling back to alternative TTS")
            if use_offline and tts_engine != 'gtts':
                logger.info(f"PIPELINE LOG - STEP 3.0: Falling back to pyttsx3 (offline)")
                return text_to_speech_pyttsx3(text)
            else:
                logger.info(f"PIPELINE LOG - STEP 3.0: Falling back to gTTS (online)")
                return text_to_speech_gtts(text)
    elif tts_engine == 'gtts' or not use_offline:
        logger.info(f"PIPELINE LOG - STEP 3.0: TTS method selected: gTTS (online)")
        return text_to_speech_gtts(text)
    else:
        logger.info(f"PIPELINE LOG - STEP 3.0: TTS method selected: pyttsx3 (offline)")
        return text_to_speech_pyttsx3(text)