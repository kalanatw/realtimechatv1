"""
ASGI config for realtalk project.

It exposes the ASGI callable as a module-level variable named ``application``.

For more information on this file, see
https://docs.djangoproject.com/en/5.2/howto/deployment/asgi/
"""

import os
from django.core.asgi import get_asgi_application
from channels.routing import ProtocolTypeRouter, URLRouter
from channels.auth import AuthMiddlewareStack
from channels.security.websocket import AllowedHostsOriginValidator

# Set the Django settings module
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'realtalk.settings')

# Initialize Django ASGI application (for HTTP)
django_asgi_app = get_asgi_application()

# Import WebSocket URL patterns (after Django is set up)
from voiceai.routing import websocket_urlpatterns

# Create the ASGI application
application = ProtocolTypeRouter({
    # Django's built-in ASGI application for HTTP requests
    "http": django_asgi_app,
    
    # WebSocket handler with URL routing and authentication
    "websocket": AllowedHostsOriginValidator(
        AuthMiddlewareStack(
            URLRouter(
                websocket_urlpatterns
            )
        )
    ),
})
