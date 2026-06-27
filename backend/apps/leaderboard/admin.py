"""Django Admin config for leaderboard."""

from django.contrib import admin
from .models import GameMode, Score


@admin.register(GameMode)
class GameModeAdmin(admin.ModelAdmin):
    list_display  = ('name', 'display_name', 'is_active', 'created_at')
    list_editable = ('is_active',)
    ordering      = ('name',)


@admin.register(Score)
class ScoreAdmin(admin.ModelAdmin):
    list_display   = ('nickname', 'mode', 'score', 'apples_eaten', 'level_reached', 'created_at')
    list_filter    = ('mode', 'is_guest')
    search_fields  = ('nickname',)
    readonly_fields = ('ip_hash', 'created_at')
    ordering       = ('-score',)
    date_hierarchy = 'created_at'

    def get_queryset(self, request):
        return super().get_queryset(request).select_related('mode')
