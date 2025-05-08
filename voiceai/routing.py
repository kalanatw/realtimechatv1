"""
WebSocket routing configuration for the voiceai app.

This module defines WebSocket URL patterns for real-time voice conversations.
"""
from django.urls import re_path
from . import consumers

websocket_urlpatterns = [
    re_path(r'ws/voiceai/converse/$', consumers.VoiceAIConsumer.as_asgi()),
    re_path(r'ws/voiceai/stream/$', consumers.VoiceAIStreamConsumer.as_asgi()),
]