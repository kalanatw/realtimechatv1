from django.core.management.base import BaseCommand
from voiceai.utils import kokoro_cache, kokoro_lock

class Command(BaseCommand):
    help = 'Clean the Kokoro TTS cache to free up memory'

    def handle(self, *args, **options):
        with kokoro_lock:
            cache_size = len(kokoro_cache)
            kokoro_cache.clear()
            self.stdout.write(self.style.SUCCESS(f'Successfully cleared {cache_size} items from Kokoro TTS cache'))
