#!/usr/bin/env bash
# Pull the nightly PocketBase backup zips from the VPS to this machine.
#
# The VPS writes one zip per night into /opt/moodboard/pb_data/backups/ (last 7 kept).
# The zips already contain pb_data/storage, so nothing else is copied.
set -euo pipefail

REMOTE_HOST="oracle-vm"
REMOTE_DIR="/opt/moodboard/pb_data/backups/"
LOCAL_DIR="/home/harold/backups/moodboard"

mkdir -p "$LOCAL_DIR"

# No --delete: whatever happens on the VPS, local copies stay. Prune here by age only.
rsync -a "$REMOTE_HOST:$REMOTE_DIR" "$LOCAL_DIR/"
find "$LOCAL_DIR" -maxdepth 1 -name 'pb_backup_*' -mtime +60 -delete

zip_count=$(find "$LOCAL_DIR" -maxdepth 1 -name '*.zip' | wc -l)
if [ "$zip_count" -eq 0 ]; then
	echo "FAIL: no .zip in ${LOCAL_DIR} after rsync" >&2
	exit 1
fi

total_bytes=$(find "$LOCAL_DIR" -maxdepth 1 -name '*.zip' -printf '%s\n' | awk '{s += $1} END {print s + 0}')
total_size=$(numfmt --to=iec --suffix=B "$total_bytes")
echo "moodboard backups: ${zip_count} zip files, ${total_size} total in ${LOCAL_DIR}"
