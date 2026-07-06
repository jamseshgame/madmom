#!/usr/bin/env bash
# deploy.sh — provision a fresh Ubuntu droplet for beatmap.jamsesh.co
set -euo pipefail

REPO_DIR="/opt/madmom"
WEB_DIR="$REPO_DIR/web"
BACKEND_DIR="$WEB_DIR/backend"
FRONTEND_DIR="$WEB_DIR/frontend"
DOMAIN="beatmap.jamsesh.co"

echo "=== System packages ==="
apt-get update
apt-get install -y \
    python3 python3-venv python3-dev python3-pip \
    ffmpeg libfftw3-dev \
    nginx certbot python3-certbot-nginx \
    git curl unzip build-essential

# Node.js via nodesource
if ! command -v node &>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi

# Deno — JS runtime yt-dlp uses to solve YouTube's signature challenges.
# Without it every YouTube download fails with "Requested format is not
# available" (Node 20 is below yt-dlp-ejs's minimum, so Deno it is).
if ! command -v deno &>/dev/null; then
    curl -fsSL -o /tmp/deno.zip \
        https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip
    unzip -o -q /tmp/deno.zip -d /usr/local/bin
    rm /tmp/deno.zip
fi

echo "=== Clone repo ==="
if [ ! -d "$REPO_DIR/.git" ]; then
    git clone --recursive https://github.com/CPJKU/madmom.git "$REPO_DIR"
fi
cd "$REPO_DIR"
git pull --recurse-submodules

echo "=== Python venv + madmom ==="
python3 -m venv "$BACKEND_DIR/venv"
source "$BACKEND_DIR/venv/bin/activate"

pip install --upgrade pip
# -c constraints.txt caps numpy on every install (madmom's editable install
# declares only `numpy>2`, which would otherwise pull 2.5 and break numba).
CONSTRAINTS="$BACKEND_DIR/constraints.txt"
pip install -c "$CONSTRAINTS" -e "$REPO_DIR"  # install madmom in dev mode
pip install -c "$CONSTRAINTS" -r "$BACKEND_DIR/requirements.txt"
# Extras carry packages with conflicting metadata pins; --no-deps installs
# them as-is. See requirements-extras.txt for the rationale.
pip install -c "$CONSTRAINTS" --no-deps -r "$BACKEND_DIR/requirements-extras.txt"

# Build Cython extensions
cd "$REPO_DIR"
python setup.py build_ext --inplace

echo "=== Frontend build ==="
cd "$FRONTEND_DIR"
npm ci
npm run build

echo "=== .env file ==="
if [ ! -f "$WEB_DIR/.env" ]; then
    cp "$WEB_DIR/.env.example" "$WEB_DIR/.env"
    echo "!! Edit $WEB_DIR/.env with real values (GITHUB_TOKEN etc) !!"
fi

echo "=== Nginx ==="
cp "$WEB_DIR/nginx/$DOMAIN.conf" "/etc/nginx/sites-available/$DOMAIN"
ln -sf "/etc/nginx/sites-available/$DOMAIN" "/etc/nginx/sites-enabled/$DOMAIN"
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

echo "=== SSL ==="
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --email admin@jamsesh.co

echo "=== Systemd service ==="
cp "$WEB_DIR/systemd/beatmap-backend.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable beatmap-backend
systemctl restart beatmap-backend

echo "=== Done ==="
echo "Site: https://$DOMAIN"
echo "API:  https://$DOMAIN/api/health"
systemctl status beatmap-backend --no-pager
