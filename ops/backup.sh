#!/usr/bin/env bash
# Daily mongodump, kept locally. Pair with off-box sync of backups/ — a backup on the same
# disk as the database is not a backup.
#
#   ops/backup.sh
#
# Exit non-zero if no dump was written, so cron surfaces a broken run instead of quietly
# collecting nothing.
set -euo pipefail

cd "$(dirname "$0")/.."

KEEP_DAYS="${KEEP_DAYS:-14}"
DEST="backups"
mkdir -p "$DEST"

# Compose reads .env itself, which is where MONGO_USER / MONGO_PASSWORD live.
CONTAINER="expense-tracker-api-mongo-1"
FILE="$DEST/mongo-$(date -u +%Y%m%dT%H%M%SZ).archive.gz"

echo "Dumping $CONTAINER -> $FILE"
docker exec "$CONTAINER" \
  mongodump --archive --gzip --quiet \
  -u "$(grep -m1 '^MONGO_USER=' .env | cut -d= -f2-)" \
  -p "$(grep -m1 '^MONGO_PASSWORD=' .env | cut -d= -f2-)" \
  --authenticationDatabase admin \
  --db expense-tracker \
  > "$FILE"

# A zero-byte dump is the classic silent failure: mongodump exits 0 having written nothing.
if [ ! -s "$FILE" ]; then
  echo "Backup is empty — treating this run as failed." >&2
  rm -f "$FILE"
  exit 1
fi

gzip -t "$FILE" || { echo "Archive is corrupt." >&2; exit 1; }

find "$DEST" -name 'mongo-*.archive.gz' -mtime "+$KEEP_DAYS" -print -delete
echo "OK: $(du -h "$FILE" | cut -f1) at $FILE"