#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$HOME/SimpleHub"
TMP_TAR="$HOME/simplehub-prebuilt.tar.gz"
ARTIFACT_URL="https://github.com/clawbackup/alwaysdata/releases/latest/download/simplehub-prebuilt.tar.gz"

rm -rf "$APP_DIR"
rm -f "$TMP_TAR"

curl -L "$ARTIFACT_URL" -o "$TMP_TAR"
tar -xzf "$TMP_TAR" -C "$HOME"
mkdir -p "$APP_DIR/server/data"
chmod +x "$APP_DIR/run-simplehub.sh"

echo 'Start command: bash $HOME/SimpleHub/run-simplehub.sh'
