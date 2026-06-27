"""WebSocket URL routing for the Ladder Race game."""
from django.urls import re_path
from .consumers import LadderConsumer

websocket_urlpatterns = [
    re_path(r'^ws/ladder/$', LadderConsumer.as_asgi()),
]
