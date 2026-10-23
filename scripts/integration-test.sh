#!/bin/sh
# Runs the integration suite against the throwaway Postgres instance, and takes
# that instance back down when it is done — including on failure and on Ctrl-C.
#
# The suite needs a real cluster, but only for the length of a run: leaving it
# up afterwards means a second Postgres sitting on the host indefinitely, next
# to the deployment one, holding a published port. So the container's lifetime
# is scoped to this script rather than to "whenever someone last tested".
#
# Two ways to keep it up anyway, for a tight edit/run loop where the ~2s start
# is worth avoiding:
#   - start it yourself with `make test-db` first. An instance that was already
#     running when this script started is left exactly as it was found.
#   - KEEP_TEST_DB=1 make test-integration
set -eu

SERVICE=postgres-test
# Resolved the same way docker-compose.yml resolves them, so the DSN matches
# the container even when .env overrides the credentials. Sourced in a subshell:
# only the DSN crosses back, never the deployment DATABASE_URL or the secrets
# next to it in that file.
DSN=$(
	set -a
	[ -f .env ] && . ./.env
	set +a
	printf 'postgres://%s:%s@localhost:%s/faketoken_test?sslmode=disable' \
		"${POSTGRES_USER:-faketoken}" "${POSTGRES_PASSWORD:-faketoken}" \
		"${TEST_POSTGRES_PORT:-5434}"
)

# Anything already up was started deliberately and is not ours to remove.
if [ -n "$(docker compose ps --status running --format '{{.Name}}' "$SERVICE" 2>/dev/null)" ]; then
	KEEP_TEST_DB=1
	echo "[integration] $SERVICE already running, leaving it up afterwards"
fi

teardown() {
	status=$?
	trap - EXIT INT TERM
	if [ -n "${KEEP_TEST_DB:-}" ]; then
		echo "[integration] keeping $SERVICE up (KEEP_TEST_DB)"
	else
		# rm -sf, not stop: the storage is tmpfs, so a stopped container keeps
		# nothing worth reusing while still occupying the name and the port.
		echo "[integration] removing $SERVICE"
		docker compose --profile test rm -sf "$SERVICE" >/dev/null 2>&1 || true
	fi
	exit "$status"
}
# EXIT alone does not fire on a signal in every /bin/sh, and Ctrl-C during a
# long suite is exactly when the container must still come down.
trap teardown EXIT INT TERM

docker compose --profile test up -d --wait "$SERVICE"

TEST_DATABASE_URL="$DSN" go test ./internal/api -count=1 "$@"
