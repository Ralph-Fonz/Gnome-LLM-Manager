#!/usr/bin/env bash
# Install (symlink) the extension for development.
set -euo pipefail

EXT_UUID="llm-manager@gnome.local"
SRC_DIR="$(cd "$(dirname "$0")/../src" && pwd)"
TARGET_DIR="$HOME/.local/share/gnome-shell/extensions/$EXT_UUID"

echo "==> Compiling GSettings schemas…"
glib-compile-schemas "$SRC_DIR/schemas/"

if [[ -L "$TARGET_DIR" ]]; then
    echo "==> Symlink already exists: $TARGET_DIR"
elif [[ -d "$TARGET_DIR" ]]; then
    echo "==> WARNING: $TARGET_DIR exists as a real directory."
    echo "    Remove it manually if you want to use the symlink workflow."
    exit 1
else
    echo "==> Creating symlink: $TARGET_DIR → $SRC_DIR"
    ln -sf "$SRC_DIR" "$TARGET_DIR"
fi

echo "==> Enabling extension…"
gnome-extensions enable "$EXT_UUID" 2>/dev/null || true

echo ""
echo "Done! On Wayland you need to log out and back in to load the extension."
echo "On X11 you can press Alt+F2 → r → Enter to reload the shell."
