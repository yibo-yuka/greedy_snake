"""URL configuration for Greedy Snake backend."""

from django.contrib import admin
from django.urls import path, include
from django.http import JsonResponse


def health_check(request):
    """Simple health check endpoint for load balancers & uptime monitors."""
    return JsonResponse({'status': 'ok', 'service': 'greedy-snake-api'})


urlpatterns = [
    path('admin/',        admin.site.urls),
    path('api/',          include('apps.leaderboard.urls')),
    path('api/health/',   health_check, name='health-check'),
]
