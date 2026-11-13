#!/usr/bin/env bash
# Build the Moodboard backend and install it on this machine (the mini PC), as a systemd USER service.
# Served at https://moodboard-api.haroldpoi.dev through the cloudflared tunnel `moodboard`
# (user unit moodboard-tunnel.service, config ~/.cloudflared/moodboard.yml) -> 127.0.0.1:8190.
# Moved from the Oracle VPS on 2026-11-13 (CPU steal 80% made the API unreachable).
set -euo pipefail
cd "$(dirname "$0")"
D="$HOME/.local/share/moodboard"
go test ./...
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /tmp/moodboard-server .
mkdir -p "$D"
install -m 755 /tmp/moodboard-server "$D/moodboard.new"
mv "$D/moodboard.new" "$D/moodboard"
systemctl --user restart moodboard
for i in $(seq 20); do curl -fsS http://127.0.0.1:8190/api/health && exit 0; sleep 1; done; exit 1
