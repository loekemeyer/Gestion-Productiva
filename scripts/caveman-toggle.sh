#!/bin/bash
# Toggle caveman mode: actualiza config-claude.json y caveman-state.json

CMD="$1"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="$REPO_ROOT/config-claude.json"
STATE="$REPO_ROOT/caveman-state.json"

if [[ "$CMD" == "activa" ]]; then
  jq '.caveman = true' "$CONFIG" > /tmp/cfg && mv /tmp/cfg "$CONFIG"
  echo '{"enabled": true, "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' > "$STATE"
  cd "$REPO_ROOT"
  git add config-claude.json caveman-state.json 2>/dev/null
  git commit -m "caveman mode: ON" 2>/dev/null
  git push origin claude/caveman-configuration-au6muv 2>/dev/null
  echo "Caveman ON"
  exit 0
elif [[ "$CMD" == "desactiva" ]]; then
  jq '.caveman = false' "$CONFIG" > /tmp/cfg && mv /tmp/cfg "$CONFIG"
  echo '{"enabled": false, "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' > "$STATE"
  cd "$REPO_ROOT"
  git add config-claude.json caveman-state.json 2>/dev/null
  git commit -m "caveman mode: OFF" 2>/dev/null
  git push origin claude/caveman-configuration-au6muv 2>/dev/null
  echo "Caveman OFF"
  exit 0
else
  echo "Usage: $0 activa|desactiva"
  exit 1
fi
