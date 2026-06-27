"""
Greedy Snake — Django Settings (Development)
Uses SQLite, DEBUG=True, wide CORS.
"""

from .base import *

SECRET_KEY = os.getenv('SECRET_KEY', 'dev-secret-key-not-for-production-use-only')
DEBUG      = True

ALLOWED_HOSTS = ['*']

# ── Database: SQLite for quick dev setup ─────────────────────────────────
# Switch to PostgreSQL by setting DATABASE_URL
_db_url = os.getenv('DATABASE_URL', '')
if _db_url and _db_url.startswith('postgresql'):
    import re
    m = re.match(
        r'postgresql://(?P<user>[^:]+):(?P<password>[^@]+)@(?P<host>[^:/]+):?(?P<port>\d+)?/(?P<name>.+)',
        _db_url
    )
    if m:
        DATABASES = {
            'default': {
                'ENGINE':   'django.db.backends.postgresql',
                'NAME':     m.group('name'),
                'USER':     m.group('user'),
                'PASSWORD': m.group('password'),
                'HOST':     m.group('host'),
                'PORT':     m.group('port') or '5432',
            }
        }
    else:
        raise ValueError(f"Cannot parse DATABASE_URL: {_db_url}")
else:
    DATABASES = {
        'default': {
            'ENGINE': 'django.db.backends.sqlite3',
            'NAME':   BASE_DIR / 'db.sqlite3',
        }
    }

# ── Cache: local memory in dev ───────────────────────────────────────────
REDIS_URL = os.getenv('REDIS_URL', '')
if REDIS_URL:
    CACHES = {
        'default': {
            'BACKEND': 'django_redis.cache.RedisCache',
            'LOCATION': REDIS_URL,
            'OPTIONS': {'CLIENT_CLASS': 'django_redis.client.DefaultClient'},
            'TIMEOUT': 60,
        }
    }
else:
    CACHES = {
        'default': {
            'BACKEND': 'django.core.cache.backends.locmem.LocMemCache',
        }
    }

# ── CORS: open in dev ────────────────────────────────────────────────────
CORS_ALLOW_ALL_ORIGINS = True
CORS_ALLOW_CREDENTIALS = True

# ── DRF: show browsable API in dev ───────────────────────────────────────
REST_FRAMEWORK['DEFAULT_RENDERER_CLASSES'] = [  # type: ignore[index]
    'rest_framework.renderers.JSONRenderer',
    'rest_framework.renderers.BrowsableAPIRenderer',
]
