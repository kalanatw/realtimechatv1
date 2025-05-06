from django.apps import AppConfig
import logging

class VoiceaiConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'voiceai'
    
    def ready(self):
        """
        Initialize Kokoro TTS when Django starts up to avoid
        initialization delay during the first request
        """
        from .utils import initialize_kokoro, preheat_kokoro
        
        # Initialize the logger here to avoid circular imports
        logger = logging.getLogger('voiceai')
        
        try:
            # Initialize Kokoro
            logger.info("Initializing Kokoro TTS on application startup...")
            initialize_kokoro()
            
            # Pre-heat the model with a sample text
            logger.info("Pre-heating Kokoro TTS model...")
            preheat_kokoro()
            
            logger.info("Kokoro TTS initialized and ready for use")
        except Exception as e:
            logger.error(f"Error initializing Kokoro TTS on startup: {str(e)}")
            logger.warning("Will fall back to alternative TTS methods if Kokoro is unavailable")
