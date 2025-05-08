# WebSocket Migration Guide for RealTalk

This document explains how the RealTalk voice conversation application has been migrated from HTTP to WebSocket communication while maintaining backward compatibility.

## Overview

The application now supports both traditional HTTP requests and real-time WebSocket communication for voice conversations. WebSockets provide lower latency and more efficient communication by maintaining a persistent connection between the client and server.

## Architecture Changes

1. **WebSocket Consumers**: Two WebSocket consumers have been implemented:
   - `VoiceAIConsumer`: Handles standard voice conversations
   - `VoiceAIStreamConsumer`: Handles streaming voice conversations with progressive TTS

2. **Client-Side Integration**: A new `VoiceWebSocketClient` class handles WebSocket communication with fallback to HTTP when needed.

3. **ASGI Configuration**: The application now uses Django Channels to support both HTTP and WebSocket protocols.

4. **Backward Compatibility**: The existing HTTP endpoints are maintained for compatibility and fallback.

## Using WebSockets

### Client-Side

1. The WebSocket connection is enabled by default via the "Use WebSocket" toggle in the UI.
2. The client automatically falls back to HTTP if WebSocket connection fails.
3. WebSocket communication handles the same user preferences (TTS engine, offline/online) as HTTP.

### Server-Side

The WebSocket consumers reuse the existing voice conversation logic from the HTTP views:
- Audio transcription
- Response generation
- Text-to-speech conversion

The only difference is the transport layer (WebSocket instead of HTTP).

## Benefits

1. **Lower Latency**: WebSockets reduce connection setup overhead.
2. **Real-Time Streaming**: Audio segments can be streamed more efficiently.
3. **Reduced Server Load**: Fewer connections needed for the same conversation.
4. **Improved User Experience**: More responsive voice interactions.

## Implementation Details

### Required Dependencies

- Django Channels (channels>=4.0.0)
- Daphne ASGI server (daphne>=4.0.0)
- Channels Redis (channels-redis>=4.1.0) for production deployments

### New Files

- `/voiceai/consumers.py`: WebSocket consumers
- `/voiceai/routing.py`: WebSocket URL routing
- `/static/js/voiceai-websocket.js`: WebSocket client implementation

### Modified Files

- `/realtalk/asgi.py`: Updated to support both HTTP and WebSocket
- `/static/js/voiceai.js`: Updated to use WebSockets with HTTP fallback
- `/templates/voiceai/home.html`: Added WebSocket toggle and JS reference
- `/requirements.txt`: Added Django Channels dependencies

## Production Deployment

For production deployment, configure a Redis channel layer in settings.py:

```python
CHANNEL_LAYERS = {
    'default': {
        'BACKEND': 'channels_redis.core.RedisChannelLayer',
        'CONFIG': {
            'hosts': [('redis-server-address', 6379)],
        },
    },
}
```

Run the application with Daphne ASGI server:

```bash
daphne -b 0.0.0.0 -p 8000 realtalk.asgi:application
```

## Testing WebSocket Functionality

1. Start the development server with `python manage.py runserver`
2. Open the application in a browser
3. Ensure the "Use WebSocket" toggle is enabled
4. Check the browser console for "WebSocket connection established" message
5. Speak into the microphone and verify the conversation works
6. Try disabling WebSockets to test the fallback mechanism