#!/usr/bin/env bash
# Keep the Cloudflare edge copy of every public board warm: the board JSON and each image (card
# thumbnail and full size) are requested through the public host, as a browser that accepts AVIF/WebP
# would. The Worker (worker/src/index.js) serves a copy up to an hour old at once and refreshes it in the
# background, so a visitor from this region finds a warm copy. Run every 20 minutes by the systemd user
# timer moodboard-warm.timer. Only reads; a failed request is ignored.
set -u
DB="${MB_DB:-$HOME/.local/share/moodboard/pb_data/data.db}"
HOST="${MB_PUBLIC_HOST:-https://moodboard-api.haroldpoi.dev}"
ACCEPT='image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'

for project in $(sqlite3 -readonly "$DB" "select id from projects where public = 1"); do
	board=$(curl -fsS --max-time 20 "$HOST/api/mb/public/$project") || continue
	printf '%s' "$board" | python3 -c '
import json, sys
for i in json.load(sys.stdin).get("inspirations", []):
    print(i["id"])' | while read -r id; do
		for q in "?thumb=480x0" ""; do
			printf '%s\0' "$HOST/api/mb/public/$project/files/$id$q"
		done
	done | xargs -0 -r -n1 -P4 curl -fsS -o /dev/null --max-time 60 -H "accept: $ACCEPT" || true
done
