#!/usr/bin/env bash
# redeploy.sh — pull + rebuild + restart the live beatmap.jamsesh.co box.
#
# Unlike deploy.sh (which provisions a FRESH Ubuntu droplet from scratch), this
# updates an already-running install in place. Run it ON the droplet, as root:
#
#     ssh beatmap 'bash /opt/madmom/web/redeploy.sh'
#
# It only does the expensive steps (pip install, npm build, Cython rebuild) when
# the relevant files actually changed in the pull, so a docs-only change is a
# few seconds and a code change restarts just what it needs.
#
# The one thing it will REFUSE to do: let a dependency install reinstall or
# downgrade torch / torchaudio / torchcodec. Those bind to torchcodec's compiled
# libraries, and a patch-level torch change silently breaks every stem write
# with "Could not load libtorchcodec". This exact trap (an exact torch pin
# meeting the droplet's patch version) is what the guard below catches.
#
# Flags:
#   --force-deps      run the pip installs even if requirements didn't change
#   --force-frontend  rebuild the frontend even if web/frontend didn't change
#   --force-cython    rebuild the Cython extensions even if no .pyx changed
#   --allow-torch     bypass the torch-reinstall guard (you had better be sure)
set -euo pipefail

REPO_DIR="/opt/madmom"
WEB_DIR="$REPO_DIR/web"
BACKEND_DIR="$WEB_DIR/backend"
FRONTEND_DIR="$WEB_DIR/frontend"
VENV_PY="$BACKEND_DIR/venv/bin/python"
VENV_PIP="$BACKEND_DIR/venv/bin/pip"
CONSTRAINTS="$BACKEND_DIR/constraints.txt"
SERVICE="beatmap-backend"
DOMAIN="beatmap.jamsesh.co"

force_deps=0 force_frontend=0 force_cython=0 allow_torch=0
for arg in "$@"; do
    case "$arg" in
        --force-deps)     force_deps=1 ;;
        --force-frontend) force_frontend=1 ;;
        --force-cython)   force_cython=1 ;;
        --allow-torch)    allow_torch=1 ;;
        *) echo "Unknown flag: $arg" >&2; exit 2 ;;
    esac
done

say() { echo -e "\n=== $* ==="; }

cd "$REPO_DIR"

# ── pull ────────────────────────────────────────────────────────────────────
say "Pull"
OLD_HEAD=$(git rev-parse HEAD)
git pull --ff-only --recurse-submodules origin main
NEW_HEAD=$(git rev-parse HEAD)

if [ "$OLD_HEAD" = "$NEW_HEAD" ] \
    && [ "$force_deps$force_frontend$force_cython" = "000" ]; then
    echo "Already up to date ($NEW_HEAD) — nothing to rebuild."
    echo "(pass --force-deps / --force-frontend / --force-cython to rebuild anyway)"
    if systemctl is-active --quiet "$SERVICE"; then
        echo "service: active — nothing to do."
        exit 0
    fi
    echo "service is not active — restarting it."
    systemctl restart "$SERVICE"; sleep 4
    systemctl is-active --quiet "$SERVICE" && { echo "service: active"; exit 0; }
    echo "!! service failed to start" >&2
    systemctl status "$SERVICE" --no-pager -l | tail -20 >&2
    exit 1
fi

CHANGED=$(git diff --name-only "$OLD_HEAD" "$NEW_HEAD" 2>/dev/null || true)
touched() { echo "$CHANGED" | grep -qE "$1"; }

deps_changed=0
touched '^web/backend/(requirements.*\.txt|constraints\.txt)$' && deps_changed=1
[ "$force_deps" = 1 ] && deps_changed=1

frontend_changed=0
touched '^web/frontend/' && frontend_changed=1
[ "$force_frontend" = 1 ] && frontend_changed=1

cython_changed=0
touched '\.(pyx|pxd)$|^setup\.py$' && cython_changed=1
[ "$force_cython" = 1 ] && cython_changed=1

backend_changed=0
touched '^web/backend/app/' && backend_changed=1

# ── backend dependencies ─────────────────────────────────────────────────────
if [ "$deps_changed" = 1 ]; then
    say "Backend dependencies"

    # Torch-reinstall guard. A safe install shows torch as "already satisfied"
    # and NOT under "Would install". If bare torch/torchaudio (or triton, its
    # Linux backend) appears there, the install is about to change the torch
    # build and break torchcodec — abort before any damage. torchvision is
    # exempt: it's installed --no-deps from requirements-extras on purpose.
    if [ "$allow_torch" != 1 ]; then
        WOULD=$("$VENV_PIP" install --dry-run -c "$CONSTRAINTS" \
            -r "$BACKEND_DIR/requirements.txt" 2>&1 | grep -E '^Would install' || true)
        if echo "$WOULD" | grep -qE '\b(torch|torchaudio|triton)-[0-9]'; then
            echo "!! ABORT: the dependency install would reinstall torch:" >&2
            echo "     $WOULD" >&2
            echo "!! That breaks torchcodec (libtorchcodec load failure) and every" >&2
            echo "!! stem separation with it. Fix the pins so torch is 'already" >&2
            echo "!! satisfied', or re-run with --allow-torch if this is intended" >&2
            echo "!! (e.g. a deliberate torch upgrade — then also reinstall" >&2
            echo "!! torchcodec/torchvision to match)." >&2
            exit 1
        fi
        echo "torch guard OK — install leaves torch/torchaudio untouched."
    fi

    "$VENV_PIP" install -c "$CONSTRAINTS" -r "$BACKEND_DIR/requirements.txt"
    # Extras carry packages whose metadata pins would break the resolver
    # (audio-separator's diffq/beartype caps; torchvision's torch patch pin).
    # --no-deps installs them as-is against the torch already present.
    "$VENV_PIP" install -c "$CONSTRAINTS" --no-deps \
        -r "$BACKEND_DIR/requirements-extras.txt"
else
    echo "Dependencies unchanged — skipping pip install."
fi

# ── Cython extensions ────────────────────────────────────────────────────────
if [ "$cython_changed" = 1 ]; then
    say "Cython extensions"
    ( cd "$REPO_DIR" && "$VENV_PY" setup.py build_ext --inplace )
else
    echo "No .pyx/setup.py change — skipping Cython rebuild."
fi

# ── frontend ─────────────────────────────────────────────────────────────────
if [ "$frontend_changed" = 1 ]; then
    say "Frontend build"
    cd "$FRONTEND_DIR"
    # npm ci only when the lockfile moved; otherwise the existing node_modules
    # is fine and a full ci is wasted minutes.
    if echo "$CHANGED" | grep -qE '^web/frontend/package(-lock)?\.json$' \
        || [ "$force_frontend" = 1 ]; then
        npm ci
    fi
    npm run build
    cd "$REPO_DIR"
else
    echo "No web/frontend change — skipping frontend build."
fi

# ── restart ──────────────────────────────────────────────────────────────────
# Restart when backend code or deps changed (frontend is static, served by
# nginx — a pure frontend change needs no restart).
if [ "$backend_changed" = 1 ] || [ "$deps_changed" = 1 ] || [ "$cython_changed" = 1 ]; then
    say "Restart backend"
    systemctl restart "$SERVICE"
    sleep 4
else
    echo "Backend code/deps unchanged — not restarting the service."
fi

# ── verify ───────────────────────────────────────────────────────────────────
say "Verify"
if ! systemctl is-active --quiet "$SERVICE"; then
    echo "!! Service is not active after redeploy:" >&2
    systemctl status "$SERVICE" --no-pager -l | tail -20 >&2
    exit 1
fi
echo "service: $(systemctl is-active "$SERVICE")"

HEALTH=$(curl -s -m 10 http://127.0.0.1:8000/api/health || true)
echo "health:  ${HEALTH:-<no response>}"
echo "$HEALTH" | grep -q '"ok"' || { echo "!! health check failed" >&2; exit 1; }

# Read the studio version from source, not the minified bundle: the bundle is
# full of other `1.x.y` dependency strings, so grepping it reports nonsense.
# The build came from this exact file at the current commit.
VERSION=$(grep -oE "STUDIO_VERSION = '[0-9]+\.[0-9]+\.[0-9]+'" \
    "$FRONTEND_DIR/src/version.ts" 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || true)
echo "frontend: v${VERSION:-unknown} (now at commit $(git rev-parse --short HEAD))"

echo -e "\nDone → https://$DOMAIN"
