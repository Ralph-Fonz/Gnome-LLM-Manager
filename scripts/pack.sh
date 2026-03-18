#!/usr/bin/env bash
# Pack the extension into a .zip for distribution / EGO upload.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")/../src" && pwd)"
OUT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Compiling GSettings schemas…"
glib-compile-schemas "$SRC_DIR/schemas/"

echo "==> Packing extension…"
gnome-extensions pack "$SRC_DIR" \
    --extra-source=icons/ \
    --extra-source=schemas/ \
    --out-dir="$OUT_DIR" \
    --force

echo ""
echo "Done! Package created at:"
ls -la "$OUT_DIR"/*.shell-extension.zip
