#!/usr/bin/env bash
# soundboard-install.sh — sets up the soundboard on your Arch Linux / Hyprland box
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$SCRIPT_DIR"          # run in place — no copying to ~/.local
BIN_DIR="$HOME/.local/bin"
SOUNDS_DIR="$HOME/Music/soundboard"

echo ""
echo "╔══════════════════════════════════════╗"
echo "║  🎛️  Soundboard Installer             ║"
echo "╚══════════════════════════════════════╝"
echo ""

# ── Check Node.js ─────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo "⚠️  Node.js not found. Installing via pacman..."
  sudo pacman -S --noconfirm nodejs
fi
echo "✓ Node.js $(node --version)"

# ── Check ffplay ──────────────────────────────────────────────────────────────
if ! command -v ffplay &>/dev/null; then
  echo "⚠️  ffplay not found. Installing ffmpeg..."
  sudo pacman -S --noconfirm ffmpeg
fi
echo "✓ ffplay found"

# ── Create sounds folder ──────────────────────────────────────────────────────
mkdir -p "$SOUNDS_DIR"
echo "✓ Sounds folder: $SOUNDS_DIR"

# ── Verify app files are present ─────────────────────────────────────────────
if [[ ! -f "$INSTALL_DIR/server.js" || ! -f "$INSTALL_DIR/public/index.html" ]]; then
  echo "❌  server.js or public/index.html not found in $INSTALL_DIR"
  echo "    Make sure you're running install.sh from the soundboard folder."
  exit 1
fi
echo "✓ App files found in: $INSTALL_DIR"

# ── Write uninstall script into the install dir ───────────────────────────────
cat > "$BIN_DIR/soundboard-uninstall" << 'UNINSTALL'
#!/usr/bin/env bash
BIN="$HOME/.local/bin/soundboard"
LAUNCHER_UNINSTALL="$HOME/.local/bin/soundboard-uninstall"
DESKTOP="$HOME/.local/share/applications/soundboard.desktop"
SOUNDS_DIR="$HOME/Music/soundboard"

echo ""
echo "╔══════════════════════════════════════╗"
echo "║  🗑️  Soundboard Uninstaller           ║"
echo "╚══════════════════════════════════════╝"
echo ""

if pgrep -f "server.js" &>/dev/null; then
  echo "⚠️  Soundboard server is running — stopping it..."
  pkill -f "server.js" || true
  sleep 0.5
fi

remove() {
  if [ -e "$1" ] || [ -L "$1" ]; then rm -rf "$1" && echo "✓ Removed: $1"
  else echo "  (not found, skipping): $1"; fi
}

remove "$BIN"
remove "$DESKTOP"

echo ""
if [ -d "$SOUNDS_DIR" ]; then
  read -r -p "  Remove sounds folder ($SOUNDS_DIR)? [y/N] " answer
  case "$answer" in
    [yY][eE][sS]|[yY]) rm -rf "$SOUNDS_DIR" && echo "✓ Removed: $SOUNDS_DIR" ;;
    *) echo "  Kept: $SOUNDS_DIR" ;;
  esac
fi

echo ""
echo "╔══════════════════════════════════════╗"
echo "║  ✅  Uninstall complete!              ║"
echo "╚══════════════════════════════════════╝"
echo ""
# Remove this script last
rm -f "$LAUNCHER_UNINSTALL"
UNINSTALL
chmod +x "$BIN_DIR/soundboard-uninstall"

# ── Create launcher script ────────────────────────────────────────────────────
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/soundboard" << EOF
#!/usr/bin/env bash
SOUNDS="\${1:-$SOUNDS_DIR}"
PORT="\${2:-3000}"
exec node "$INSTALL_DIR/server.js" "\$SOUNDS" "\$PORT"
EOF
chmod +x "$BIN_DIR/soundboard"
echo "✓ Launcher: $BIN_DIR/soundboard"

# ── Create update launcher ────────────────────────────────────────────────────
cat > "$BIN_DIR/soundboard-update" << EOF
#!/usr/bin/env bash
exec bash "$INSTALL_DIR/update.sh"
EOF
chmod +x "$BIN_DIR/soundboard-update"
echo "✓ Updater:  $BIN_DIR/soundboard-update"

# Make sure ~/.local/bin is in PATH
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  echo ""
  echo "⚠️  Add this to your ~/.bashrc or ~/.zshrc:"
  echo "   export PATH=\"\$HOME/.local/bin:\$PATH\""
fi

# ── Optional: create a .desktop entry for KDE ─────────────────────────────────
DESKTOP_DIR="$HOME/.local/share/applications"
mkdir -p "$DESKTOP_DIR"
cat > "$DESKTOP_DIR/soundboard.desktop" << EOF
[Desktop Entry]
Type=Application
Name=Soundboard
Comment=Phone-controlled soundboard for Hyprland/KDE
Exec=bash -c '$BIN_DIR/soundboard'
Icon=multimedia-volume-control
Terminal=true
Categories=AudioVideo;Audio;
Keywords=soundboard;audio;dj;
EOF
echo "✓ .desktop entry created (searchable in KDE app launcher)"

echo ""
echo "╔══════════════════════════════════════╗"
echo "║  ✅  Installation complete!           ║"
echo "╚══════════════════════════════════════╝"
echo ""
echo "  START:  soundboard"
echo "  SOUNDS: $SOUNDS_DIR"
echo ""
echo "  Drop your audio files into the sounds folder,"
echo "  then open the URL shown in the terminal on your phone."
echo ""