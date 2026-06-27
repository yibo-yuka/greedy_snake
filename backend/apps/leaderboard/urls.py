"""URL routing for leaderboard API."""

from django.urls import path
from . import views

urlpatterns = [
    path('modes/',                      views.GameModeListView.as_view(),  name='api-modes'),
    path('leaderboard/<str:mode_name>/', views.LeaderboardView.as_view(),  name='api-leaderboard'),
    path('scores/',                     views.ScoreSubmitView.as_view(),   name='api-scores-submit'),
]
