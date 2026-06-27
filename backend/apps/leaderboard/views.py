"""
Leaderboard API Views
======================
GET  /api/leaderboard/<mode>/   — top scores for a mode
POST /api/scores/               — submit a score
GET  /api/modes/                — list available modes
GET  /api/health/               — health check (root urls.py)
"""

import hashlib
import logging

from django.core.cache import cache
from django.db.models import Max
from rest_framework import status
from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle
from rest_framework.views import APIView

from .models import GameMode, Score
from .serializers import (
    GameModeSerializer,
    LeaderboardEntrySerializer,
    ScoreResponseSerializer,
    ScoreSubmitSerializer,
)

logger = logging.getLogger(__name__)


class ScoreSubmitThrottle(AnonRateThrottle):
    """Stricter rate limit specifically for score submission."""
    rate = '10/min'
    scope = 'score_submit'


class GameModeListView(APIView):
    """GET /api/modes/ — list active game modes."""

    def get(self, request):
        modes = GameMode.objects.filter(is_active=True)
        return Response(GameModeSerializer(modes, many=True).data)


class LeaderboardView(APIView):
    """
    GET /api/leaderboard/<mode>/
    Query params:
      ?limit=10       — number of entries (max 100)
      ?nickname=xxx   — highlight player's own entry
    """

    def get(self, request, mode_name: str):
        limit    = min(int(request.query_params.get('limit', 10)), 100)
        my_nick  = request.query_params.get('nickname', '').strip()
        sort_by  = request.query_params.get('sort_by', 'score')   # 'score' | 'apples' | 'ratio'
        cache_key = f'lb:{mode_name}:{limit}:{sort_by}'

        # Try cache first (only when no personalisation)
        cached = cache.get(cache_key)
        if cached and not my_nick:
            return Response(cached)

        try:
            mode = GameMode.objects.get(name=mode_name)
        except GameMode.DoesNotExist:
            return Response(
                {'error': f"Game mode '{mode_name}' not found."},
                status=status.HTTP_404_NOT_FOUND,
            )

        def _enrich(record, rank, best_val=None):
            """Build a serialisable entry dict from a Score record."""
            apples = record.apples_eaten if record else 0
            score  = record.score        if record else 0
            ratio  = round(score / apples, 1) if apples > 0 else 0.0
            return {
                'rank':          rank,
                'nickname':      record.nickname if record else '',
                'score':         score,
                'apples_eaten':  apples,
                'ratio':         ratio,
                'level_reached': record.level_reached if record else None,
                'created_at':    record.created_at    if record else None,
                'is_me':         (record.nickname if record else '') == my_nick,
            }

        if sort_by == 'apples':
            rows = (
                Score.objects.filter(mode=mode)
                .values('nickname')
                .annotate(best=Max('apples_eaten'))
                .order_by('-best')[:limit]
            )
            entries = []
            for i, row in enumerate(rows):
                rec = (Score.objects
                       .filter(mode=mode, nickname=row['nickname'], apples_eaten=row['best'])
                       .order_by('created_at').first())
                entries.append(_enrich(rec, i + 1))

        elif sort_by == 'ratio':
            rows = (
                Score.objects.filter(mode=mode, apples_eaten__gt=0)
                .values('nickname')
                .annotate(best_score=Max('score'))
                .order_by('-best_score')[:limit * 4]   # oversample to re-sort
            )
            raw = []
            for row in rows:
                rec = (Score.objects
                       .filter(mode=mode, nickname=row['nickname'], score=row['best_score'])
                       .order_by('created_at').first())
                if rec and rec.apples_eaten > 0:
                    raw.append({**_enrich(rec, 0), 'ratio': round(rec.score / rec.apples_eaten, 1)})
            raw.sort(key=lambda x: -x['ratio'])
            entries = [{**e, 'rank': i + 1} for i, e in enumerate(raw[:limit])]

        else:   # score (default)
            rows = (
                Score.objects.filter(mode=mode)
                .values('nickname')
                .annotate(best_score=Max('score'))
                .order_by('-best_score')[:limit]
            )
            entries = []
            for i, row in enumerate(rows):
                rec = (Score.objects
                       .filter(mode=mode, nickname=row['nickname'], score=row['best_score'])
                       .order_by('created_at').first())
                entries.append(_enrich(rec, i + 1))

        data = LeaderboardEntrySerializer(entries, many=True).data

        # Cache (no personalisation)
        if not my_nick:
            cache.set(cache_key, data, 30)

        return Response(data)


class ScoreSubmitView(APIView):
    """POST /api/scores/ — submit a new score."""
    throttle_classes = [ScoreSubmitThrottle]

    def post(self, request):
        serializer = ScoreSubmitSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

        data = serializer.validated_data
        logger.info("Score submit: %s / %s / %d pts", data['nickname'], data['mode'], data['score'])

        try:
            mode = GameMode.objects.get(name=data['mode'])
        except GameMode.DoesNotExist:
            return Response({'error': 'Invalid game mode.'}, status=status.HTTP_400_BAD_REQUEST)

        if not mode.is_active:
            return Response({'error': 'This mode is not yet active.'}, status=status.HTTP_400_BAD_REQUEST)

        # Hash IP for privacy (store only first 32 chars of SHA-256)
        raw_ip  = self._get_client_ip(request)
        ip_hash = hashlib.sha256(raw_ip.encode()).hexdigest()[:32]

        # Check if this is a new personal best
        prev_best = (
            Score.objects
            .filter(mode=mode, nickname=data['nickname'])
            .aggregate(best=Max('score'))['best']
        ) or 0
        is_best = data['score'] > prev_best

        # Save the score
        score_obj = Score(
            nickname      = data['nickname'],
            mode          = mode,
            score         = data['score'],
            apples_eaten  = data['apples_eaten'],
            level_reached = data.get('level_reached'),
            ip_hash       = ip_hash,
        )
        try:
            score_obj.full_clean()
        except Exception as exc:
            return Response({'error': str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        score_obj.save()

        # Compute global rank (distinct better players + 1)
        rank = (
            Score.objects
            .filter(mode=mode, score__gt=data['score'])
            .values('nickname')
            .distinct()
            .count()
        ) + 1

        # Invalidate cached leaderboards for this mode
        for lim in [10, 20, 50, 100]:
            cache.delete(f'lb:{data["mode"]}:{lim}')

        resp_data = {
            'id':      score_obj.pk,
            'rank':    rank,
            'score':   score_obj.score,
            'is_best': is_best,
        }
        return Response(
            ScoreResponseSerializer(resp_data).data,
            status=status.HTTP_201_CREATED,
        )

    @staticmethod
    def _get_client_ip(request) -> str:
        x_fwd = request.META.get('HTTP_X_FORWARDED_FOR', '')
        if x_fwd:
            return x_fwd.split(',')[0].strip()
        return request.META.get('REMOTE_ADDR', '0.0.0.0')
