"""App config for leaderboard."""

from django.apps import AppConfig


class LeaderboardConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name               = 'apps.leaderboard'
    verbose_name       = '🏆 排行榜'

    def ready(self):
        """Create default GameMode entries on startup (idempotent)."""
        try:
            from .models import GameMode
            GameMode.get_or_create_defaults()
        except Exception:
            pass  # DB might not be migrated yet during first setup
