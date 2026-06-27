"""ASGI config — used by Django Channels (Phase 4 WebSocket)."""

import os
from django.core.asgi import get_asgi_application

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'greedy_snake.settings.production')

# Phase 4: Will be replaced with Channels routing
# from channels.routing import ProtocolTypeRouter, URLRouter
# from apps.multiplayer.routing import websocket_urlpatterns
application = get_asgi_application()
