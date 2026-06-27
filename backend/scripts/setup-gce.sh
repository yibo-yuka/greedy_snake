#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# Greedy Snake — GCE Initial Setup Script
# Target OS : Ubuntu 22.04 LTS (Jammy)
# Run once  : bash setup-gce.sh
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

# ── Colour helpers ──────────────────────────────────────────────────────────
GRN='\033[0;32m'; YLW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
ok()   { echo -e "${GRN}[✓]${NC} $*"; }
info() { echo -e "${YLW}[→]${NC} $*"; }
err()  { echo -e "${RED}[✗]${NC} $*" >&2; exit 1; }

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║   🐍  Greedy Snake — GCE Deployment Setup           ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# ── User inputs ─────────────────────────────────────────────────────────────
read -rp "DuckDNS subdomain (e.g. mysnake → mysnake.duckdns.org): " DUCK_SUB
read -rp "DuckDNS token: "       DUCK_TOKEN
read -rp "Let's Encrypt email: " LE_EMAIL
read -rp "GitHub repo URL [https://github.com/yibo-yuka/greedy_snake.git]: " REPO_URL
REPO_URL="${REPO_URL:-https://github.com/yibo-yuka/greedy_snake.git}"

DOMAIN="${DUCK_SUB}.duckdns.org"
APP_DIR="/opt/greedy_snake"

echo ""
info "Domain   : $DOMAIN"
info "Repo     : $REPO_URL"
info "App dir  : $APP_DIR"
echo ""

# ═══════════════════════════════════════════════════════════════════════════
# 1. System update
# ═══════════════════════════════════════════════════════════════════════════
info "[1/9] Updating system packages..."
sudo apt-get update -y -q
sudo apt-get upgrade -y -q
sudo apt-get install -y -q git curl wget unzip python3 jq
ok "System updated"

# ═══════════════════════════════════════════════════════════════════════════
# 2. Docker CE + Compose v2
# ═══════════════════════════════════════════════════════════════════════════
info "[2/9] Installing Docker..."
if ! command -v docker &>/dev/null; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
  ok "Docker installed"
else
  ok "Docker already installed ($(docker --version))"
fi

sudo apt-get install -y -q docker-compose-plugin
ok "Docker Compose plugin installed"

# ═══════════════════════════════════════════════════════════════════════════
# 3. Firewall
# ═══════════════════════════════════════════════════════════════════════════
info "[3/9] Configuring UFW firewall..."
sudo ufw --force reset  >/dev/null
sudo ufw default deny incoming >/dev/null
sudo ufw default allow outgoing >/dev/null
sudo ufw allow ssh   >/dev/null
sudo ufw allow 80/tcp  >/dev/null
sudo ufw allow 443/tcp >/dev/null
sudo ufw --force enable >/dev/null
ok "Firewall: SSH / 80 / 443 open"

# ═══════════════════════════════════════════════════════════════════════════
# 4. Clone repository
# ═══════════════════════════════════════════════════════════════════════════
info "[4/9] Cloning repository..."
sudo mkdir -p "$APP_DIR"
sudo chown "$USER":"$USER" "$APP_DIR"

if [ -d "$APP_DIR/.git" ]; then
  info "  Repo already exists — pulling latest..."
  git -C "$APP_DIR" pull origin main
else
  git clone "$REPO_URL" "$APP_DIR"
fi
ok "Repository ready at $APP_DIR"

# ═══════════════════════════════════════════════════════════════════════════
# 5. Environment file
# ═══════════════════════════════════════════════════════════════════════════
info "[5/9] Creating .env.prod..."
cd "$APP_DIR/backend"

# Generate strong secrets
SECRET_KEY=$(python3 -c "import secrets,string; print(''.join(secrets.choice(string.ascii_letters+string.digits+'!@#\$%^&*') for _ in range(60)))")
DB_PASS=$(python3 -c "import secrets; print(secrets.token_urlsafe(24))")

cat > .env.prod << EOF
DJANGO_SETTINGS_MODULE=greedy_snake.settings.production
SECRET_KEY=${SECRET_KEY}
DEBUG=False
ALLOWED_HOSTS=${DOMAIN}
CORS_ALLOWED_ORIGINS=https://yibo-yuka.github.io,https://${DOMAIN}

# PostgreSQL
DATABASE_URL=postgresql://snake:${DB_PASS}@db:5432/greedy_snake
POSTGRES_DB=greedy_snake
POSTGRES_USER=snake
POSTGRES_PASSWORD=${DB_PASS}
POSTGRES_HOST=db
POSTGRES_PORT=5432

# Redis
REDIS_URL=redis://redis:6379/0

# DuckDNS (for reference)
DUCKDNS_DOMAIN=${DOMAIN}
EOF

chmod 600 .env.prod
ok ".env.prod created (permissions: 600)"

# ═══════════════════════════════════════════════════════════════════════════
# 6. DuckDNS auto-update
# ═══════════════════════════════════════════════════════════════════════════
info "[6/9] Setting up DuckDNS auto-update..."

sudo tee /usr/local/bin/update-duckdns.sh > /dev/null << EOF
#!/usr/bin/env bash
TOKEN="${DUCK_TOKEN}"
SUBDOMAIN="${DUCK_SUB}"
CURRENT_IP=\$(curl -s https://api.ipify.org)
RESULT=\$(curl -s "https://www.duckdns.org/update?domains=\${SUBDOMAIN}&token=\${TOKEN}&ip=\${CURRENT_IP}")
echo "\$(date '+%Y-%m-%d %H:%M:%S') [\${RESULT}] \${SUBDOMAIN}.duckdns.org → \${CURRENT_IP}"
EOF

sudo chmod +x /usr/local/bin/update-duckdns.sh

# Run once immediately
/usr/local/bin/update-duckdns.sh | tee -a /var/log/duckdns.log

# Cron every 5 minutes
(crontab -l 2>/dev/null | grep -v duckdns; \
 echo "*/5 * * * * /usr/local/bin/update-duckdns.sh >> /var/log/duckdns.log 2>&1") \
 | crontab -

ok "DuckDNS will auto-update every 5 minutes"

# ═══════════════════════════════════════════════════════════════════════════
# 7. Let's Encrypt SSL
# ═══════════════════════════════════════════════════════════════════════════
info "[7/9] Obtaining SSL certificate from Let's Encrypt..."
info "  Domain: $DOMAIN — make sure DNS is resolving to this server!"
echo ""
read -rp "  Press Enter once DuckDNS points to this IP, or Ctrl+C to abort..."

sudo apt-get install -y -q certbot

sudo certbot certonly \
  --standalone \
  --non-interactive \
  --agree-tos \
  --email "$LE_EMAIL" \
  -d "$DOMAIN"

# Auto-renewal cron
(sudo crontab -l 2>/dev/null | grep -v certbot; \
 echo "0 3 * * * certbot renew --quiet --pre-hook 'docker compose -f ${APP_DIR}/backend/docker-compose.prod.yml stop nginx' --post-hook 'docker compose -f ${APP_DIR}/backend/docker-compose.prod.yml start nginx'") \
 | sudo crontab -

ok "SSL certificate obtained — auto-renewal configured"

# ═══════════════════════════════════════════════════════════════════════════
# 8. Nginx config — patch domain placeholder
# ═══════════════════════════════════════════════════════════════════════════
info "[8/9] Configuring Nginx..."
sed -i "s|SNAKE_DOMAIN_PLACEHOLDER|${DOMAIN}|g" \
  "$APP_DIR/backend/nginx/nginx.prod.conf"
ok "Nginx configured for $DOMAIN"

# ═══════════════════════════════════════════════════════════════════════════
# 9. Start services
# ═══════════════════════════════════════════════════════════════════════════
info "[9/9] Building and starting Docker services..."
cd "$APP_DIR/backend"

# Run as current user (must be in docker group)
# Use newgrp workaround if needed
if id -nG "$USER" | grep -qw docker; then
  docker compose -f docker-compose.prod.yml pull --quiet
  docker compose -f docker-compose.prod.yml up -d --build
else
  # Restart shell to apply docker group, then run
  err "User $USER is not in docker group yet. Please run: newgrp docker && bash deploy.sh"
fi

info "Waiting 20s for services to start..."
sleep 20

# Migrations & static files
docker compose -f docker-compose.prod.yml exec -T web \
  python manage.py migrate --noinput

docker compose -f docker-compose.prod.yml exec -T web \
  python manage.py collectstatic --noinput --clear

# ── Summary ──────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║   ✅  Setup Complete!                                ║"
echo "╠══════════════════════════════════════════════════════╣"
printf "║   🌐  API    : https://%-32s ║\n" "${DOMAIN}/api/"
printf "║   🔧  Admin  : https://%-32s ║\n" "${DOMAIN}/admin/"
printf "║   💚  Health : https://%-32s ║\n" "${DOMAIN}/api/health/"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
echo "📋 Next steps:"
echo ""
echo "  1. Create Django superuser:"
echo "     cd $APP_DIR/backend"
echo "     docker compose -f docker-compose.prod.yml exec web python manage.py createsuperuser"
echo ""
echo "  2. Connect frontend — edit frontend/js/config.js:"
echo "     apiUrl: 'https://${DOMAIN}/api'"
echo "     Then: git add . && git commit -m 'feat: connect to backend' && git push origin main"
echo ""
echo "  3. Add GitHub Secrets for auto-deploy:"
echo "     GCE_SSH_HOST  = $(curl -s https://api.ipify.org)"
echo "     GCE_SSH_USER  = $USER"
echo "     GCE_SSH_KEY   = (contents of ~/.ssh/id_ed25519 or your deploy key)"
