#!/usr/bin/env bash
# Copy the nightly PocketBase backup zips off this machine, to the Oracle VPS (ssh alias oracle-vm).
#
# The backend runs on the mini PC since 2026-11-13. It writes one zip per night into
# ~/.local/share/moodboard/pb_data/backups/ (last 7 kept). The zips already contain pb_data/storage.
# The file name stays "backup-pull" so the existing systemd timer keeps working.
set -euo pipefail

SRC_DIR="/home/harold/.local/share/moodboard/pb_data/backups/"
REMOTE_HOST="oracle-vm"
REMOTE_DIR="/home/ubuntu/moodboard-backups/"

zip_count=$(find "$SRC_DIR" -maxdepth 1 -name '*.zip' | wc -l)
if [ "$zip_count" -eq 0 ]; then
	echo "FAIL: no .zip in ${SRC_DIR}" >&2
	exit 1
fi

ssh "$REMOTE_HOST" "mkdir -p '$REMOTE_DIR'"
# No --delete: whatever happens here, the remote copies stay.
rsync -a "$SRC_DIR" "$REMOTE_HOST:$REMOTE_DIR"
ssh "$REMOTE_HOST" "find '$REMOTE_DIR' -maxdepth 1 -name 'pb_backup_*' -mtime +60 -delete"

total_bytes=$(find "$SRC_DIR" -maxdepth 1 -name '*.zip' -printf '%s\n' | awk '{s += $1} END {print s + 0}')
total_size=$(numfmt --to=iec --suffix=B "$total_bytes")
echo "moodboard backups: ${zip_count} zip files, ${total_size} copied to ${REMOTE_HOST}:${REMOTE_DIR}"
