#!/usr/bin/env bash
# Mobil-Simulation: headless Edge als iPhone (375x812), Screenshots + Overflow-Diagnose.
# Ergebnis landet im Session-Scratchpad unter shots/.
set -e

SP="C:/Users/Gotts/AppData/Local/Temp/claude/C--Users-Gotts-Documents-claude-code-Minecraft-server-hosting-panel/3471d1e7-dd84-4ecf-8f05-3a1f1b6ecd84/scratchpad"
EDGE="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
BACKEND_DIR="C:/Users/Gotts/Documents/claude code/Minecraft server hosting panel/backend"

# Altlasten beenden – sonst hält ein laufender Edge Port und Profil.
taskkill //F //IM msedge.exe //T >/dev/null 2>&1 || true
sleep 1

# Profil jedes Mal frisch: sonst liefern HTTP-Cache und ein registrierter
# Service Worker das alte Bundle aus und die Messung prüft veralteten Code.
PROFILE="$SP/edge-profile-$(date +%s)"
mkdir -p "$SP/shots" "$PROFILE"

"$EDGE" --headless=new --remote-debugging-port=9222 \
  --user-data-dir="$PROFILE" --no-first-run --disable-application-cache \
  --window-size=375,812 about:blank &
sleep 4

# 'ws' liegt in den Backend-Abhängigkeiten (socket.io). Node löst Pakete
# relativ zur Skriptdatei auf – deshalb muss sie dort liegen, nicht im Scratchpad.
cp "$SP/mobile-shots.mjs" "$BACKEND_DIR/.mobile-shots.mjs"
cd "$BACKEND_DIR"
OUT_DIR="$SP/shots" TOKEN="$(cat "$SP/token.txt")" node .mobile-shots.mjs | tee "$SP/shots/log.txt"
rm -f "$BACKEND_DIR/.mobile-shots.mjs"

taskkill //F //IM msedge.exe //T >/dev/null 2>&1 || true
rm -rf "$SP"/edge-profile-* 2>/dev/null || true
echo "Screenshots: $SP/shots/"
