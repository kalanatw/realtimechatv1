from django.db import models
import os
import uuid

class Conversation(models.Model):
    """Model to store conversation data for caching and analytics purposes"""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user_message = models.TextField()
    ai_response = models.TextField()
    audio_file = models.FileField(upload_to='audio_inputs/', blank=True, null=True)
    response_audio = models.FileField(upload_to='audio_responses/', blank=True, null=True)
    created_at = models.DateTimeField(auto_now_add=True)
    
    class Meta:
        ordering = ['-created_at']
    
    def __str__(self):
        return f"Conversation {self.id} at {self.created_at.strftime('%Y-%m-%d %H:%M')}"
    
    def delete_audio_files(self):
        """Delete associated audio files when the conversation is deleted"""
        if self.audio_file:
            if os.path.isfile(self.audio_file.path):
                os.remove(self.audio_file.path)
        if self.response_audio:
            if os.path.isfile(self.response_audio.path):
                os.remove(self.response_audio.path)
    
    def delete(self, *args, **kwargs):
        """Override delete to also remove audio files"""
        self.delete_audio_files()
        super().delete(*args, **kwargs)
