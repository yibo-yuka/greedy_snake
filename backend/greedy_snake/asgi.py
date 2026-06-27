"""ASGI config — Django Channels (Phase 4 WebSocket)."""
import os
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'greedy_snake.settings.production')

from django.core.asgi import get_asgi_application
from channels.routing import ProtocolTypeRouter, URLRouter
from channels.auth import AuthMiddlewareStack
from apps.leaderboard.routing import websocket_urlpatterns

django_asgi_app = get_asgi_application()

application = ProtocolTypeRouter({
    'http':      django_asgi_app,
    'websocket': AuthMiddlewareStack(
        URLRouter(websocket_urlpatterns)
    ),
})
