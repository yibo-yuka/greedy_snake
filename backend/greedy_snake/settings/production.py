"""
Greedy Snake — Django Settings (Production)
PostgreSQL, Redis, strict CORS, HTTPS.
"""

import re
from .base import *

# ── Security ──────────────────────────────────────────────────────────────
SECRET_KEY = os.environ['SECRET_KEY']   # Must be set — no default in prod
DEBUG      = False

_allowed = os.getenv('ALLOWED_HOSTS', '')
ALLOWED_HOSTS = [h.strip() for h in _allowed.split(',') if h.strip()]

# HTTPS settings
SECURE_SSL_REDIRECT          = True
SECURE_HSTS_SECONDS          = 31536000  # 1 year
SECURE_HSTS_INCLUDE_SUBDOMAINS = True
SECURE_HSTS_PRELOAD          = True
SESSION_COOKIE_SECURE        = True
CSRF_COOKIE_SECURE           = True
SECURE_PROXY_SSL_HEADER      = ('HTTP_X_FORWARDED_PROTO', 'https')

# ── Database: PostgreSQL ──────────────────────────────────────────────────
_db_url = os.environ['DATABASE_URL']
m = re.match(
    r'postgresql://(?P<user>[^:]+):(?P<password>[^@]+)@(?P<host>[^:/]+):?(?P<port>\d+)?/(?P<name>.+)',
    _db_url
)
if not m:
    raise ValueError(f"Invalid DATABASE_URL: {_db_url}")

DATABASES = {
    'default': {
        'ENGINE':  'django.db.backends.postgresql',
        'NAME':    m.group('name'),
        'USER':    m.group('user'),
        'PASSWORD':m.group('password'),
        'HOST':    m.group('host'),
        'PORT':    m.group('port') or '5432',
        'OPTIONS': {'sslmode': 'prefer'},
        'CONN_MAX_AGE': 60,
    }
}

# ── Cache: Redis ──────────────────────────────────────────────────────────
REDIS_URL = os.environ['REDIS_URL']
CACHES = {
    'default': {
        'BACKEND': 'django_redis.cache.RedisCache',
        'LOCATION': REDIS_URL,
        'OPTIONS': {
            'CLIENT_CLASS': 'django_redis.client.DefaultClient',
            'IGNORE_EXCEPTIONS': True,  # Degrade gracefully if Redis is down
        },
        'TIMEOUT': 60,
    }
}

# ── CORS ──────────────────────────────────────────────────────────────────
CORS_ALLOW_ALL_ORIGINS = False
CORS_ALLOW_CREDENTIALS = True

_origins = os.getenv('CORS_ALLOWED_ORIGINS', '')
CORS_ALLOWED_ORIGINS = [o.strip() for o in _origins.split(',') if o.strip()]

# Always allow GitHub Pages
if 'https://yibo-yuka.github.io' not in CORS_ALLOWED_ORIGINS:
    CORS_ALLOWED_ORIGINS.append('https://yibo-yuka.github.io')

CORS_ALLOW_METHODS = ['GET', 'POST', 'OPTIONS']
CORS_ALLOW_HEADERS = ['Content-Type', 'Accept', 'X-Requested-With']

# ── DRF: no browsable API in production ──────────────────────────────────
REST_FRAMEWORK['DEFAULT_RENDERER_CLASSES'] = [  # type: ignore[index]
    'rest_framework.renderers.JSONRenderer',
]
