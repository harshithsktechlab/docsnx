#!/usr/bin/env bash
#
# Nightly logical backup of the docsnx database.
#
#   sudo -u postgres bash /opt/docsnx/scripts/pg-backup.sh
#
# Written after 2026-09-02, when `docsnx_db` was dropped and there was nothing
# to restore from: archive_mode was off, so there was no PITR, and no dump of
# this cluster had ever been taken. Every tenant's data was lost outright.
#
# ── WHY IT RUNS AS `postgres` OVER THE LOCAL SOCKET ────────────────────────
# So that no password exists anywhere in this file, in the unit, or in the
# process table. Passing a connection string on an argv is what puts a live
# credential into `Error.message` and then into the journal on any failure.
#
# ── WHY -Fc ───────────────────────────────────────────────────────────────
# The custom format is compressed and restores selectively with pg_restore, so
# one table can be recovered without replaying the whole database.
set -euo pipefail

# Add the sibling databases here to cover the other apps on this cluster
# (vastipatraknx_db arogyam_db evolution_db). The whole cluster is ~113 MB, so
# the cost is minutes of disk, not hours.
DATABASES=(docsnx_db)

BACKUP_DIR=${BACKUP_DIR:-/var/backups/postgres}
RETENTION_DAYS=${RETENTION_DAYS:-14}
STAMP=$(date -u +%Y%m%d-%H%M%S)

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

for db in "${DATABASES[@]}"; do
  out="$BACKUP_DIR/${db}-${STAMP}.dump"
  # Write to a .partial and rename only on success, so a backup killed halfway
  # (disk full — this host runs hot) can never be mistaken for a good one by
  # the retention sweep or by whoever is restoring at 3am.
  pg_dump --format=custom --compress=9 --file="${out}.partial" "$db"
  # Prove it is readable before it counts as a backup. A dump nobody can list
  # is not a backup, and the cheapest moment to find that out is now.
  pg_restore --list "${out}.partial" > /dev/null
  mv "${out}.partial" "$out"
  echo "ok: $out ($(du -h "$out" | cut -f1))"
done

# Roles and their passwords live outside any single database; a restore into a
# fresh cluster needs them or every GRANT lands on a missing role.
globals="$BACKUP_DIR/globals-${STAMP}.sql"
pg_dumpall --globals-only --file="${globals}.partial"
mv "${globals}.partial" "$globals"
echo "ok: $globals"

# Retention. `-mmin` rather than `-mtime` so a re-run on the same day cannot
# leave a day with no copy at all.
find "$BACKUP_DIR" -maxdepth 1 -type f \
  \( -name '*.dump' -o -name 'globals-*.sql' \) \
  -mmin "+$((RETENTION_DAYS * 24 * 60))" -delete

# Leftover .partial files mean a previous run died; clear them so they cannot
# accumulate on a host that is already at 93% disk.
find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.partial' -mmin +1440 -delete

echo "retained $(find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.dump' | wc -l) database backup(s) in $BACKUP_DIR"
