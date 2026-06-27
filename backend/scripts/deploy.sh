#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# Greedy Snake — Quick Deploy / Update Script
# Run on the GCE instance to pull latest code and restart services
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

APP_DIR="/opt/greedy_snake"
COMPOSE="docker compose -f docker-compose.prod.yml"

echo "📦 Pulling latest code..."
git -C "$APP_DIR" pull origin main

cd "$APP_DIR/backend"

echo "🐳 Rebuilding & restarting containers..."
$COMPOSE pull --quiet
$COMPOSE up -d --build

echo "⏳ Waiting for web service..."
sleep 10

echo "🔄 Running migrations..."
$COMPOSE exec -T web python manage.py migrate --noinput

echo "📂 Collecting static files..."
$COMPOSE exec -T web python manage.py collectstatic --noinput --clear

echo "📊 Container status:"
$COMPOSE ps

echo ""
echo "✅ Deployment complete!"
