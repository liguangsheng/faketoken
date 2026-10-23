#!/bin/sh
# Periodic pg_dump of the deployment database, run by the backup service in
# docker-compose.yml. It lives in the stack rather than a host cron so it
# starts, stops and moves with everything else, and so the dump always runs
# with a client matching the server version.
#
# Dumps are custom-format (-Fc): compressed, and restorable selectively with
# pg_restore, which a plain SQL dump cannot do.
set -eu

: "${BACKUP_DIR:=/backup}"
: "${BACKUP_AT:=05:00}"       # local time in TZ, HH:MM
: "${BACKUP_KEEP:=10}"        # how many dumps to keep, newest first
# Tables whose rows are dropped from the dump, schema kept. The request and
# response bodies (request_log_details and the body_chunks they point into)
# are a rolling diagnostic window: restoring them buys nothing, and including
# them would make the backup a log archive that happens to also carry the
# data you cannot lose.
: "${BACKUP_EXCLUDE_DATA:=request_log_details body_chunks}"
: "${PGHOST:=postgres}"
: "${PGUSER:=faketoken}"
: "${PGDATABASE:=faketoken}"

log() { echo "[pg-backup] $(date '+%Y-%m-%d %H:%M:%S') $*"; }

# POSIX arithmetic reads a leading zero as octal, so "08" and "09" would fail.
unpad() { v=${1#0}; echo "${v:-0}"; }
now_secs() {
	echo $(( $(unpad "$(date +%H)") * 3600 + $(unpad "$(date +%M)") * 60 + $(unpad "$(date +%S)") ))
}

count_dumps() { find "$BACKUP_DIR" -maxdepth 1 -name "$PGDATABASE-*.dump" | wc -l; }

# prune keeps the newest BACKUP_KEEP dumps and removes the rest. The stamp in
# the filename is fixed-width and zero-padded, so a lexical sort is also a
# chronological one — no reliance on mtime, which a copy or a restore rewrites.
prune() {
	total=$(count_dumps)
	drop=$(( total - BACKUP_KEEP ))
	[ "$drop" -gt 0 ] || return 0
	find "$BACKUP_DIR" -maxdepth 1 -name "$PGDATABASE-*.dump" | sort | head -n "$drop" |
		while read -r old; do
			rm -f "$old" && log "pruned $(basename "$old")"
		done
}

dump() {
	out="$BACKUP_DIR/$PGDATABASE-$(date +%Y%m%d-%H%M%S).dump"

	# Deliberately unquoted: each table has to arrive as its own argument.
	excludes=""
	for table in $BACKUP_EXCLUDE_DATA; do
		excludes="$excludes --exclude-table-data=$table"
	done

	# Write to .part and rename only once the archive reads back, so a dump cut
	# short by a restart or a full disk can never be mistaken for a usable one.
	# shellcheck disable=SC2086
	if ! pg_dump -Fc --compress=9 $excludes -f "$out.part"; then
		log "FAILED: pg_dump errored"
		rm -f "$out.part"
		return 1
	fi
	if ! pg_restore --list "$out.part" >/dev/null 2>&1; then
		log "FAILED: archive did not read back, discarding"
		rm -f "$out.part"
		return 1
	fi
	mv "$out.part" "$out"
	log "wrote $(basename "$out") ($(du -h "$out" | cut -f1))"

	# Prune only after a success. A run of failures must not erode the history
	# that is standing in for the dump that did not happen.
	prune
	log "retention: $(count_dumps)/$BACKUP_KEEP dump(s) kept"
}

mkdir -p "$BACKUP_DIR"

# `once` takes a single dump and exits — what `make backup` runs before a
# migration or anything else worth a fresh restore point.
if [ "${1:-}" = "once" ]; then
	log "one-off dump; database=$PGDATABASE host=$PGHOST dir=$BACKUP_DIR"
	dump
	exit $?
fi

log "started; database=$PGDATABASE host=$PGHOST at=$BACKUP_AT tz=${TZ:-UTC} keep=$BACKUP_KEEP dir=$BACKUP_DIR excluding=[$BACKUP_EXCLUDE_DATA]"

# A restart should not cost a day, but it should not re-dump on every container
# bounce either — only catch up when nothing has landed in the last day.
if [ -z "$(find "$BACKUP_DIR" -maxdepth 1 -name "$PGDATABASE-*.dump" -mtime -1 2>/dev/null)" ]; then
	log "no dump in the last day, taking one now"
	dump || true
fi

target=$(( $(unpad "${BACKUP_AT%%:*}") * 3600 + $(unpad "${BACKUP_AT##*:}") * 60 ))
while true; do
	wait=$(( target - $(now_secs) ))
	[ "$wait" -le 0 ] && wait=$(( wait + 86400 ))
	log "next dump in ${wait}s"
	sleep "$wait"
	dump || true
	sleep 60   # never dump twice if the sleep wakes a hair early
done
