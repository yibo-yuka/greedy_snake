"""
Leaderboard models
==================
GameMode  — available game modes (infinite / level / ladder)
Score     — individual score submission records
"""

from django.db import models
from django.core.validators import MinValueValidator, MaxValueValidator


class GameMode(models.Model):
    MODE_CHOICES = [
        ('infinite', '無限模式'),
        ('level',    '關卡模式'),
        ('ladder',   '爬梯競速'),
    ]

    name         = models.CharField(max_length=20, unique=True, choices=MODE_CHOICES)
    display_name = models.CharField(max_length=50)
    is_active    = models.BooleanField(default=True)
    created_at   = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['name']

    def __str__(self):
        return self.display_name

    @classmethod
    def get_or_create_defaults(cls):
        """Idempotent: create all default modes if not present."""
        defaults = [
            ('infinite', '無限模式', True),
            ('level',    '關卡模式', True),
            ('ladder',   '爬梯競速', True),   # Phase 4 active
        ]
        for name, display, active in defaults:
            cls.objects.get_or_create(
                name=name,
                defaults={'display_name': display, 'is_active': active}
            )


class Score(models.Model):
    """
    Each row = one score submission.
    Leaderboard queries use best-per-nickname aggregation.
    """
    nickname      = models.CharField(max_length=16, db_index=True)
    is_guest      = models.BooleanField(default=False)
    mode          = models.ForeignKey(
        GameMode, on_delete=models.CASCADE,
        related_name='scores', db_index=True
    )

    score         = models.IntegerField(
        validators=[MinValueValidator(0), MaxValueValidator(9_999_999)]
    )
    apples_eaten  = models.IntegerField(
        default=0, validators=[MinValueValidator(0)]
    )
    # Level mode only — which level was the player on when they died
    level_reached = models.PositiveSmallIntegerField(null=True, blank=True)

    # Privacy: store hashed IP, not raw IP
    ip_hash       = models.CharField(max_length=64, blank=True, editable=False)

    created_at    = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-score', 'created_at']
        indexes  = [
            models.Index(fields=['mode', '-score']),
            models.Index(fields=['nickname', 'mode']),
            models.Index(fields=['created_at']),
        ]

    def __str__(self):
        return f"{self.nickname} | {self.mode.name} | {self.score}pts"

    def clean(self):
        """Server-side anti-cheat: score must be consistent with apples eaten."""
        from django.core.exceptions import ValidationError

        SCORE_PER_APPLE = 10
        MAX_LEVEL_BONUS = 50 * 20   # up to 50 levels × 20 pts each = 1000
        MAX_COMBO_DEPTH = 20        # cap streak depth to avoid astronomical numbers

        # With the combo streak mechanic each apple can double:
        # streak 0→+10, 1→+20, 2→+40 … → max total = 10 × (2^n − 1) for n apples.
        n               = min(self.apples_eaten, MAX_COMBO_DEPTH)
        max_apple_pts   = SCORE_PER_APPLE * ((2 ** n) - 1) if n > 0 else 0
        theoretical_max = max_apple_pts + MAX_LEVEL_BONUS + 500   # +500 buffer

        if self.score > theoretical_max:
            raise ValidationError(
                f"Score {self.score} is inconsistent with {self.apples_eaten} apples eaten."
            )
