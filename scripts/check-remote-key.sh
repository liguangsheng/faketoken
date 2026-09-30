#!/bin/sh
# Smoke-checks a deployed faketoken instance: does this key authenticate, and
# what does /v1/models hand back?
#
#   scripts/check-remote-key.sh [base-url] [api-key]
#   BASE_URL=https://api.dustsignal.cc API_KEY=sk-image scripts/check-remote-key.sh
#
# Exit 0 only on HTTP 200. Everything else fails loudly, because a key that is
# merely wrong and a backend that is not listening look identical from here:
# both reach the client as a non-200. The status code and the body are printed
# so the two can be told apart — a 502 with "error code: 502" is the gateway,
# not the key.
set -eu

BASE_URL=${1:-${BASE_URL:-https://api.dustsignal.cc}}
API_KEY=${2:-${API_KEY:-sk-image}}

body=$(mktemp)
trap 'rm -f "$body"' EXIT

code=$(curl -sS -m 15 -o "$body" -w '%{http_code}' \
	"$BASE_URL/v1/models" -H "Authorization: Bearer $API_KEY") || {
	echo "[check] 连不上 $BASE_URL" >&2
	exit 1
}

echo "[check] GET $BASE_URL/v1/models -> HTTP $code"

case "$code" in
200)
	if command -v jq >/dev/null 2>&1; then
		echo "[check] $(jq -r '.data | length' "$body" 2>/dev/null || echo '?') 个模型："
		jq -r '.data[].id' "$body" 2>/dev/null || cat "$body"
	else
		cat "$body"
	fi
	;;
401 | 403)
	echo "[check] 密钥被拒绝，后端是通的" >&2
	cat "$body" >&2
	exit 1
	;;
*)
	echo "[check] 非密钥问题（网关或后端未就绪），响应体：" >&2
	cat "$body" >&2
	exit 1
	;;
esac
