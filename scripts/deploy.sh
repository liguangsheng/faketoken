#!/usr/bin/env bash
# Rebuilds and replaces the server alone, then checks that the new build is
# the one answering; on any failure the previous image goes back. One command
# from end to end, because whoever runs it may reach the server through
# itself: a coding agent pointed at this gateway loses its connection for the
# seconds the container is swapped, and cannot step in halfway.
#
#   make deploy              or scripts/deploy.sh
#   WAIT=300 make deploy     wait up to five minutes for running calls
#
# Postgres and the backup service are left as they are (--no-deps): a change
# to their configuration waits for an explicit `docker compose up -d`.
set -euo pipefail
cd "$(dirname "$0")/.."

WAIT=${WAIT:-90}
log() { printf '[deploy] %s %s\n' "$(date +%H:%M:%S)" "$*"; }

for tool in docker curl jq python3; do
	command -v "$tool" >/dev/null || { log "needs $tool"; exit 1; }
done

# Resolved by compose from .env, so the port and the database are the ones the
# stack really runs with.
config=$(docker compose config --format json)
port=$(jq -r '.services.server.ports[0].published' <<<"$config")
pguser=$(jq -r '.services.postgres.environment.POSTGRES_USER' <<<"$config")
pgdb=$(jq -r '.services.postgres.environment.POSTGRES_DB' <<<"$config")
unset config
base="http://127.0.0.1:$port"

# A dirty tree gets a timestamp: two deploys of one HEAD would otherwise carry
# the same version. The compose file passes it to the build.
VERSION=$(git describe --always --dirty="-dirty.$(date +%m%d%H%M%S)" --abbrev=7)
export VERSION
build_log=$(mktemp -t faketoken-deploy.XXXXXX)

# admin_token signs a one-minute administrator token for the running server,
# with its secret and the account's current token version (a password change
# bumps it). Both reach python through the environment, never argv.
admin_token() {
	local account secret
	account=$(docker exec faketoken-postgres psql -U "$pguser" -d "$pgdb" -Atc \
		"SELECT id || ' ' || token_version FROM users
		 WHERE role >= 100 AND status = 1 ORDER BY id LIMIT 1") || return 1
	[ -n "$account" ] || return 1
	secret=$(docker exec faketoken printenv JWT_SECRET) || return 1
	ACCOUNT=$account JWT_SECRET=$secret python3 - <<'PY'
import base64, hashlib, hmac, json, os, time
uid, ver = map(int, os.environ["ACCOUNT"].split())
b64 = lambda raw: base64.urlsafe_b64encode(raw).rstrip(b"=").decode()
now = int(time.time())
head = b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
body = b64(json.dumps({"uid": uid, "role": 100, "name": "deploy", "sub": str(uid),
                       "ver": ver, "iat": now, "exp": now + 60}).encode())
sig = b64(hmac.new(os.environ["JWT_SECRET"].encode(), f"{head}.{body}".encode(),
                   hashlib.sha256).digest())
print(f"{head}.{body}.{sig}")
PY
}

# inflight prints how many calls are running, from the first inflight_sync the
# administrator's log stream sends; -1 when it cannot tell. The token goes to
# curl as a header file, so it stays out of the process list as well.
inflight() {
	local token count
	token=$(admin_token 2>/dev/null) || { echo -1; return; }
	count=$(curl -sN --max-time 5 -H @<(printf 'Authorization: Bearer %s\n' "$token") \
		"$base/api/admin/logs/stream" 2>/dev/null |
		awk '/^event: inflight_sync/ { getline; sub(/^data: /, ""); print; exit }' |
		jq -r '.calls | length' 2>/dev/null) || true
	echo "${count:--1}"
}

# verify passes once the new build is the one serving: healthy, from the image
# just built — a recreate that never happened leaves the old container
# answering just as well — and with the console's CSP in place.
verify() {
	local health running headers
	health=$(docker inspect -f '{{.State.Health.Status}}' faketoken 2>/dev/null) || health=missing
	[ "$health" = healthy ] || { log "verify: container $health"; return 1; }
	running=$(docker inspect -f '{{.Image}}' faketoken)
	[ "$running" = "$built" ] || { log "verify: running ${running:7:12}, built ${built:7:12}"; return 1; }
	curl -fsS -o /dev/null --max-time 5 "$base/healthz" || { log "verify: /healthz failed"; return 1; }
	# Read whole before matching: grep -q leaving mid-stream kills curl with
	# SIGPIPE, which pipefail reports as a missing header.
	headers=$(curl -s -D - -o /dev/null --max-time 5 "$base/") || headers=
	grep -qi "^content-security-policy: script-src 'self' 'sha256-" <<<"$headers" ||
		{ log "verify: CSP header missing"; return 1; }
}

rollback() {
	set +e
	trap - ERR
	log "ROLLBACK to the previous image"
	docker tag faketoken-server:rollback faketoken-server:latest
	docker compose up -d --no-deps --wait --wait-timeout 120 server
	log "after rollback: container $(docker inspect -f '{{.State.Health.Status}}' faketoken 2>/dev/null)"
	exit 1
}

if docker image inspect faketoken-server:latest >/dev/null 2>&1; then
	docker tag faketoken-server:latest faketoken-server:rollback
else
	log "no previous image: nothing to roll back to"
fi
docker compose build server >"$build_log" 2>&1 || { tail -30 "$build_log"; exit 1; }
built=$(docker image inspect -f '{{.Id}}' faketoken-server:latest)
log "built $VERSION (${built:7:12})"

# Running calls are cut when the container goes, so wait for a quiet moment —
# at most WAIT seconds. A server that cannot say is not waited on: it may be
# the very thing this deploy fixes.
deadline=$(( $(date +%s) + WAIT ))
while :; do
	n=$(inflight)
	if [ "$n" -le 0 ]; then
		log "in-flight: $([ "$n" = 0 ] && echo 0 || echo unknown)"
		break
	fi
	[ "$(date +%s)" -ge "$deadline" ] && { log "in-flight: $n after ${WAIT}s, deploying anyway"; break; }
	sleep 5
done

trap rollback ERR
# Not piped: a failed recreate has to reach the ERR trap.
docker compose up -d --no-deps --wait --wait-timeout 120 server >>"$build_log" 2>&1
for i in $(seq 1 12); do
	verify && break
	[ "$i" = 12 ] && false
	sleep 5
done
trap - ERR
log "done: $VERSION"
