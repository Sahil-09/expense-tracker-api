#!/usr/bin/env bash
# Restores the newest backup into a throwaway database and checks it against the live one.
#
#   ops/restore-test.sh
#
# This is the point of the whole exercise. A backup nobody has restored is a guess, and
# the failure mode is discovered on the day the database is already gone. Running this on a
# schedule — not once, at setup — is what turns "we have backups" into "we can recover".
#
# It never touches the live database or the mongo-data volume.
set -euo pipefail

cd "$(dirname "$0")/.."

CONTAINER="expense-tracker-api-mongo-1"
RESTORE_CONTAINER="expense-tracker-restore-check"
RESTORE_PORT=27099
USER_="$(grep -m1 '^MONGO_USER=' .env | cut -d= -f2-)"
PASS_="$(grep -m1 '^MONGO_PASSWORD=' .env | cut -d= -f2-)"

cleanup() {
  docker rm -f "$RESTORE_CONTAINER" >/dev/null 2>&1 || true
  docker volume rm expense-tracker-restore-check >/dev/null 2>&1 || true
}
trap cleanup EXIT

ARCHIVE="$(ls -t backups/mongo-*.archive.gz 2>/dev/null | head -1 || true)"
if [ -z "$ARCHIVE" ]; then
  echo "No backup in backups/. Run ops/backup.sh first." >&2
  exit 1
fi
echo "Testing $ARCHIVE"

# Counts straight from the live database, so this compares a restore against reality and
# not against the dump's own bookkeeping.
counts() {
  docker exec "$1" mongosh --quiet \
    -u "$USER_" -p "$PASS_" --authenticationDatabase admin \
    --eval 'const d=db.getSiblingDB("expense-tracker");const c={};d.getCollectionNames().sort().forEach(function(n){c[n]=d.getCollection(n).countDocuments();});print(JSON.stringify(c));'
}

# Index specs, sorted so the comparison is stable. A collection that does not exist yet
# reports an empty list rather than throwing, because getIndexes() on a missing namespace
# is an error and would otherwise abort the whole check on a fresh database.
#
# Checking these is not optional. Without the unique index on (userId, dedupeKey) the
# server will happily accept the same bank SMS twice, and without (userId, clientId) a
# push stops upserting and starts writing a second document. A restore that brings back
# the rows but not the indexes produces a database that looks healthy and quietly corrupts.
indexes() {
  docker exec "$1" mongosh --quiet \
    -u "$USER_" -p "$PASS_" --authenticationDatabase admin \
    --eval 'const d=db.getSiblingDB("expense-tracker");const names=d.getCollectionNames();const out={};["expenses","budgets","exclusions","devices"].forEach(function(n){out[n]=names.indexOf(n)<0?[]:d.getCollection(n).getIndexes().map(function(i){return JSON.stringify(i.key)+(i.unique?"!":"")}).sort();});print(JSON.stringify(out));'
}

LIVE="$(counts "$CONTAINER")"
echo "Live:  $LIVE"

docker rm -f "$RESTORE_CONTAINER" >/dev/null 2>&1 || true
docker volume rm expense-tracker-restore-check >/dev/null 2>&1 || true
docker run -d --name "$RESTORE_CONTAINER" \
  -e MONGO_INITDB_ROOT_USERNAME="$USER_" \
  -e MONGO_INITDB_ROOT_PASSWORD="$PASS_" \
  -p "127.0.0.1:$RESTORE_PORT:27017" \
  -v expense-tracker-restore-check:/data/db \
  mongo:8 >/dev/null

echo "Waiting for the throwaway database..."
for _ in $(seq 1 60); do
  if docker exec "$RESTORE_CONTAINER" mongosh --quiet \
       -u "$USER_" -p "$PASS_" --authenticationDatabase admin \
       --eval 'db.adminCommand("ping")' >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

# `mongorestore --archive` with no filename reads the archive from stdin.
docker cp "$ARCHIVE" "$RESTORE_CONTAINER:/tmp/restore.archive.gz"
docker exec "$RESTORE_CONTAINER" sh -c \
  "gunzip -c /tmp/restore.archive.gz > /tmp/restore.archive && \
   mongorestore --archive --drop \
     -u '$USER_' -p '$PASS_' --authenticationDatabase admin \
     --nsInclude='expense-tracker.*' \
     < /tmp/restore.archive"

RESTORED="$(counts "$RESTORE_CONTAINER")"
echo "Backup: $RESTORED"

LIVE_IDX="$(indexes "$CONTAINER")"
RESTORED_IDX="$(indexes "$RESTORE_CONTAINER")"

FAILED=0
if [ "$LIVE" = "$RESTORED" ]; then
  echo "PASS  row counts match"
else
  echo "FAIL  row counts differ" >&2
  echo "  live:     $LIVE" >&2
  echo "  restored: $RESTORED" >&2
  FAILED=1
fi

if [ "$LIVE_IDX" = "$RESTORED_IDX" ]; then
  echo "PASS  indexes match, including the unique ones"
else
  echo "FAIL  indexes differ — the restored database is missing a uniqueness guarantee" >&2
  echo "  live:     $LIVE_IDX" >&2
  echo "  restored: $RESTORED_IDX" >&2
  FAILED=1
fi

# An empty comparison would pass both checks above and mean nothing.
if [ "$LIVE" = "{}" ]; then
  echo "FAIL  the live database is empty — nothing was actually tested" >&2
  FAILED=1
fi

exit $FAILED