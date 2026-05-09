#!/usr/bin/env bash
# soundboard-update.sh — pulls the latest files from git and restarts the server
set -e

INSTALL_DIR="/home/jenu/Documents/Code/soundboard"
BIN_DIR="$HOME/.local/bin"

echo ""
echo "╔══════════════════════════════════════╗"
echo "║  🔄  Soundboard Updater              ║"
echo "╚══════════════════════════════════════╝"
echo ""

# ── Check the install dir exists ─────────────────────────────────────────────
if [[ ! -d "$INSTALL_DIR" ]]; then
  echo "❌  Install directory not found: $INSTALL_DIR"
  echo "    Run install.sh first."
  exit 1
fi

cd "$INSTALL_DIR"

# ── Pull latest changes ───────────────────────────────────────────────────────
if [[ ! -d ".git" ]]; then
  echo "❌  $INSTALL_DIR is not a git repo."
  echo "    To use soundboard-update, initialise git or clone into that folder."
  echo ""
  echo "    Quick setup:"
  echo "      cd $INSTALL_DIR"
  echo "      git init && git remote add origin <your-repo-url>"
  exit 1
fi

echo "  Fetching latest changes..."
git pull --ff-only
echo "✓ Code up to date"

# ── Stop running server if any ────────────────────────────────────────────────
WAS_RUNNING=false
if pgrep -f "soundboard/server.js\|$INSTALL_DIR/server.js" &>/dev/null; then
  WAS_RUNNING=true
  echo "  Stopping running server..."
  pkill -f "$INSTALL_DIR/server.js" || true
  sleep 0.8
  echo "✓ Server stopped"
fi

# ── Re-register the soundboard-update launcher itself ────────────────────────
# (in case update.sh changed)
cat > "$BIN_DIR/soundboard-update" << EOF
#!/usr/bin/env bash
exec bash "$INSTALL_DIR/update.sh"
EOF
chmod +x "$BIN_DIR/soundboard-update"
echo "✓ soundboard-update refreshed"

echo ""
echo "╔══════════════════════════════════════╗"
echo "║  ✅  Update complete!                 ║"
echo "╚══════════════════════════════════════╝"
echo ""

if $WAS_RUNNING; then
  echo "  Server was running — restart it with:  soundboard"
else
  echo "  Start the server with:  soundboard"
fi
echo ""
