#!/usr/bin/env bash
# Build the Moodboard backend and install it on the Oracle VPS (ssh alias oracle-vm).
# Served at https://moodboard-api.haroldpoi.dev through the existing cloudflared tunnel -> 127.0.0.1:8190.
set -euo pipefail
cd "$(dirname "$0")"
go test ./...
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /tmp/moodboard-server .
scp -q /tmp/moodboard-server oracle-vm:/tmp/moodboard-server
ssh oracle-vm 'set -e
sudo install -d -o ubuntu -g ubuntu /opt/moodboard
install -m 755 /tmp/moodboard-server /opt/moodboard/moodboard.new
mv /opt/moodboard/moodboard.new /opt/moodboard/moodboard
sudo tee /etc/systemd/system/moodboard.service >/dev/null <<UNIT
[Unit]
Description=Moodboard backend (PocketBase + MCP, Go) for moodboard-api.haroldpoi.dev
After=network-online.target

[Service]
User=ubuntu
WorkingDirectory=/opt/moodboard
ExecStart=/opt/moodboard/moodboard serve --http 127.0.0.1:8190 --dir /opt/moodboard/pb_data
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/opt/moodboard

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now moodboard
sudo systemctl restart moodboard
for i in $(seq 20); do curl -fsS http://127.0.0.1:8190/api/health && exit 0; sleep 1; done; exit 1'
echo
