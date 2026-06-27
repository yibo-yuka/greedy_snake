"""WSGI config for Greedy Snake backend."""

import os
from django.core.wsgi import get_wsgi_application

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'greedy_snake.settings.production')
application = get_wsgi_application()
