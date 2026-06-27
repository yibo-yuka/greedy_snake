"""Serializers for leaderboard API."""

from rest_framework import serializers
from .models import Score, GameMode


class GameModeSerializer(serializers.ModelSerializer):
    class Meta:
        model  = GameMode
        fields = ['name', 'display_name', 'is_active']


class LeaderboardEntrySerializer(serializers.Serializer):
    """Read-only leaderboard row (aggregated best-per-nickname)."""
    rank          = serializers.IntegerField()
    nickname      = serializers.CharField()
    score         = serializers.IntegerField()
    apples_eaten  = serializers.IntegerField()
    level_reached = serializers.IntegerField(allow_null=True)
    created_at    = serializers.DateTimeField(format='%Y-%m-%dT%H:%M:%SZ')
    is_me         = serializers.BooleanField(default=False)


class ScoreSubmitSerializer(serializers.Serializer):
    """Validates an incoming score submission."""
    nickname      = serializers.CharField(min_length=2, max_length=16)
    mode          = serializers.ChoiceField(choices=['infinite', 'level', 'ladder'])
    score         = serializers.IntegerField(min_value=0, max_value=9_999_999)
    apples_eaten  = serializers.IntegerField(min_value=0)
    level_reached = serializers.IntegerField(
        min_value=1, required=False, allow_null=True, default=None
    )

    def validate(self, data):
        """Anti-cheat: score must be plausible given apples eaten."""
        SCORE_PER_APPLE = 10
        MAX_LEVEL_BONUS = 50 * 20   # 50 levels × 20 bonus per level (generous)
        MAX_COMBO_DEPTH = 20        # cap streak depth for calculation

        # With the combo streak mechanic each apple can double:
        # streak 0→+10, 1→+20, 2→+40 … so max score = 10*(2^n − 1) for n apples.
        n             = min(data['apples_eaten'], MAX_COMBO_DEPTH)
        max_apple_pts = SCORE_PER_APPLE * ((2 ** n) - 1) if n > 0 else 0
        max_possible  = max_apple_pts + MAX_LEVEL_BONUS + 500   # +500 buffer

        if data['score'] > max_possible:
            raise serializers.ValidationError(
                {'score': f'Score {data["score"]} is not achievable with {data["apples_eaten"]} apples.'}
            )
        return data


class ScoreResponseSerializer(serializers.Serializer):
    """Response after submitting a score."""
    id       = serializers.IntegerField()
    rank     = serializers.IntegerField()
    score    = serializers.IntegerField()
    is_best  = serializers.BooleanField()
