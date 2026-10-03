#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
"$ROOT/scripts/export-icons.sh"
ICON_THEME="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor"
for size in 16 32 48 128 256; do
  dir="$ICON_THEME/${size}x${size}/apps"
  mkdir -p "$dir"
  cp "$ROOT/extension/icons/icon-${size}.png" "$dir/ubuntu-shared-browser-agent.png"
done
DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$DESKTOP_DIR"
sed "s|@REPO_ROOT@|$ROOT|g" "$ROOT/assets/ubuntu-shared-browser-agent.desktop" > "$DESKTOP_DIR/ubuntu-shared-browser-agent.desktop"
chmod +x "$DESKTOP_DIR/ubuntu-shared-browser-agent.desktop"
chmod +x "$ROOT/scripts/launch-usba.sh"
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
	gtk-update-icon-cache -f -t "$ICON_THEME" 2>/dev/null || true
fi
if command -v update-desktop-database >/dev/null 2>&1; then
	update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
fi
echo "Installed icon theme entries and desktop launcher."
echo "If the app does not appear in search yet, log out and back in or run: update-desktop-database ~/.local/share/applications"
