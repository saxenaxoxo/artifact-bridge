#!/bin/zsh
# Artifact Bridge — one-time panel install (no sudo: user-level CEP extensions dir).
#
#   ./panel/install-panel.sh            symlink install (default — repo edits go live on AE restart)
#   ./panel/install-panel.sh --copy     copy install (static snapshot + repo.json pointer)
#
# Then quit AE fully (⌘Q), reopen, and find it under Window ▸ Extensions ▸ Artifact Bridge.

set -euo pipefail

PANEL_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$PANEL_DIR")"
EXT_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions"
TARGET="$EXT_DIR/com.creo.aereplica.panel"

echo "Artifact Bridge installer"
echo "  panel:  $PANEL_DIR"
echo "  target: $TARGET"

# Unsigned-extension switch for the CSXS runtimes AE 2024–2026 may use (harmless extras).
for v in 11 12 13; do
  defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1 2>/dev/null || true
done
echo "  ✓ PlayerDebugMode=1 (CSXS 11/12/13)"

mkdir -p "$EXT_DIR"
rm -rf "$TARGET"

if [[ "${1:-}" == "--copy" ]]; then
  cp -R "$PANEL_DIR" "$TARGET"
  printf '{ "root": "%s" }\n' "$REPO_DIR" > "$TARGET/repo.json"
  echo "  ✓ copied (repo.json → $REPO_DIR)"
else
  ln -s "$PANEL_DIR" "$TARGET"
  echo "  ✓ symlinked (panel edits go live on next AE restart)"
fi

echo ""
echo "Now: quit After Effects fully (⌘Q) → reopen → Window ▸ Extensions ▸ Artifact Bridge"
