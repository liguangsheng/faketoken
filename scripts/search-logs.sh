#!/bin/sh
# Full-text search over the captured request/response bodies, exported to a file.
#
# The console's keyword box deliberately does not reach the bodies — it searches
# ids, users, keys, models, channels, IPs and errors, all short indexed columns.
# Grepping several hundred MB of stored HTTP bodies is a different operation and
# belongs here, driven from the host, not from a page that has to stay fast.
#
# Only the bodies still inside the retention window can be found: the newest
# `log_detail_keep` calls (「全局设置 → 完整日志」). A miss therefore means "not
# in the retained window", never "never happened" — the summary prints the
# window it actually searched so the result can be read correctly.
#
# Usage:
#   scripts/search-logs.sh [options] <keyword>
#
#   -f, --field req|resp|both   which body to search (default: both)
#   -i, --ignore-case           case-insensitive
#   -E, --regex                 treat the keyword as a POSIX regular expression
#       --since <ts>            only calls at/after this time (any Postgres ts)
#       --until <ts>            only calls before this time
#   -n, --limit <n>             cap the exported records (default: 500)
#   -C, --context <n>           snippet radius in characters (default: 120)
#       --no-bodies             export metadata + snippets only, omit full bodies
#   -o, --out <path>            output file, or - for stdout (default:
#                               .search/logs-<keyword>-<timestamp>.jsonl)
#
# Output is JSONL — one record per line, bodies intact with newlines escaped, so
# it survives `jq` and does not need a parser that understands a log format.
# Timestamps in and out are Asia/Singapore (TZ in .env), matching the console.
#
# The export carries other people's prompts verbatim. It is written under 0600
# into a gitignored directory; treat the file as you would the database itself.
#
# Note: Claude Code's own calls relay through this deployment, so a search run
# from an agent session will match that session's transcript, including the
# keyword you just typed. Use --until to exclude the current conversation.
set -eu

CONTAINER=${PG_CONTAINER:-faketoken-postgres}
FIELD=both
FOLD=0
REGEX=0
SINCE=
UNTIL=
LIMIT=500
CONTEXT=120
BODIES=1
OUT=
KEYWORD=

die() { echo "search-logs: $*" >&2; exit 2; }

while [ $# -gt 0 ]; do
	case $1 in
	-f | --field) FIELD=${2:?} ; shift 2 ;;
	-i | --ignore-case) FOLD=1 ; shift ;;
	-E | --regex) REGEX=1 ; shift ;;
	--since) SINCE=${2:?} ; shift 2 ;;
	--until) UNTIL=${2:?} ; shift 2 ;;
	-n | --limit) LIMIT=${2:?} ; shift 2 ;;
	-C | --context) CONTEXT=${2:?} ; shift 2 ;;
	--no-bodies) BODIES=0 ; shift ;;
	-o | --out) OUT=${2:?} ; shift 2 ;;
	-h | --help) awk 'NR > 1 { if (!/^#/) exit; sub(/^# ?/, ""); print }' "$0" ; exit 0 ;;
	--) shift ; break ;;
	-*) die "unknown option $1 (see --help)" ;;
	*) [ -n "$KEYWORD" ] && die "only one keyword (quote it if it has spaces)"
	   KEYWORD=$1 ; shift ;;
	esac
done
[ $# -gt 0 ] && [ -z "$KEYWORD" ] && { KEYWORD=$1; shift; }

[ -n "$KEYWORD" ] || die "no keyword given (see --help)"
case $FIELD in req | resp | both) ;; *) die "--field must be req, resp or both" ;; esac
case $LIMIT in '' | *[!0-9]*) die "--limit must be a number" ;; esac
case $CONTEXT in '' | *[!0-9]*) die "--context must be a number" ;; esac

# A keyword worth putting in a filename is one that survives the trip: an ASCII
# slug when there is one, otherwise the timestamp alone identifies the run.
if [ -z "$OUT" ]; then
	slug=$(printf '%s' "$KEYWORD" | LC_ALL=C tr -c 'A-Za-z0-9._' '-' |
		sed -e 's/--*/-/g' -e 's/^-//' -e 's/-$//' | cut -c1-32)
	OUT=".search/logs-${slug:+$slug-}$(date +%Y%m%d-%H%M%S).jsonl"
fi

# The keyword reaches SQL as a psql variable interpolated with :'kw', which
# applies literal quoting — never spliced into the statement text. A keyword of
# «海鸥' OR 1=1 --» searches for that string and finds nothing, rather than
# rewriting the query.
#
# strpos/replace for literal mode, not LIKE: a keyword containing % or _ is a
# plain character here, and needs no escaping pass of its own.
match_expr() {
	if [ "$REGEX" = 1 ]; then
		[ "$FOLD" = 1 ] && echo "$1 ~* :'kw'" || echo "$1 ~ :'kw'"
	else
		[ "$FOLD" = 1 ] && echo "strpos(lower($1), lower(:'kw')) > 0" ||
			echo "strpos($1, :'kw') > 0"
	fi
}

# 0 when absent, so it doubles as the "matched here" flag for the snippet.
pos_expr() {
	if [ "$REGEX" = 1 ]; then
		[ "$FOLD" = 1 ] && echo "regexp_instr($1, :'kw', 1, 1, 0, 'i')" ||
			echo "regexp_instr($1, :'kw')"
	else
		[ "$FOLD" = 1 ] && echo "strpos(lower($1), lower(:'kw'))" ||
			echo "strpos($1, :'kw')"
	fi
}

# Occurrence count. The literal form measures how much shorter the body gets
# with every occurrence removed, which avoids handing a user's keyword to the
# regex engine as a pattern.
hits_expr() {
	if [ "$REGEX" = 1 ]; then
		[ "$FOLD" = 1 ] && echo "(SELECT count(*) FROM regexp_matches($1, :'kw', 'gi'))" ||
			echo "(SELECT count(*) FROM regexp_matches($1, :'kw', 'g'))"
	else
		[ "$FOLD" = 1 ] &&
			echo "((length($1) - length(replace(lower($1), lower(:'kw'), ''))) / length(:'kw'))" ||
			echo "((length($1) - length(replace($1, :'kw', ''))) / length(:'kw'))"
	fi
}

# A window of the body centred on the first match, whitespace collapsed: a
# pretty-printed JSON body would otherwise spend the whole snippet on
# indentation. Radius is a parameter because the on-screen table wants a much
# tighter window than the exported record — clipped to the file's radius, the
# terminal column would end before the match it is supposed to show.
snippet_expr() {
	pos=$(pos_expr "$1")
	echo "CASE WHEN $pos > 0 THEN regexp_replace(
		substr($1, greatest($pos - $2, 1), $2 * 2 + length(:'kw')),
		'[[:space:]]+', ' ', 'g') END"
}

# Radius of the snippet shown in the terminal table, in characters per side.
DISPLAY_CONTEXT=24

REQ_MATCH=$(match_expr d.request_body)
RESP_MATCH=$(match_expr d.response_body)
case $FIELD in
req) COND="($REQ_MATCH)" ;;
resp) COND="($RESP_MATCH)" ;;
both) COND="($REQ_MATCH OR $RESP_MATCH)" ;;
esac
[ -n "$SINCE" ] && COND="$COND AND l.created_at >= :'since'::timestamptz"
[ -n "$UNTIL" ] && COND="$COND AND l.created_at < :'until'::timestamptz"

# Whichever side matched is the one worth a snippet; both when both did.
REQ_SNIP=$(snippet_expr d.request_body "$CONTEXT")
RESP_SNIP=$(snippet_expr d.response_body "$CONTEXT")
REQ_DISP=$(snippet_expr d.request_body "$DISPLAY_CONTEXT")
RESP_DISP=$(snippet_expr d.response_body "$DISPLAY_CONTEXT")
BODY_FIELDS=
[ "$BODIES" = 1 ] && BODY_FIELDS="
	'request_body', d.request_body,
	'response_body', d.response_body,"

# The bodies are large and the summary must describe exactly what landed in the
# file, so both statements read one REPEATABLE READ snapshot: a call arriving
# mid-run cannot appear in one and not the other.
#
# The records go to stdout (which the caller redirects into the file) and the
# summary to stderr, so `-o -` pipes cleanly into jq with nothing mixed in.
SQL=$(cat <<SQL
BEGIN ISOLATION LEVEL REPEATABLE READ;

\\o | cat >&2
\\pset format aligned
\\pset tuples_only off
SELECT d.log_id,
	to_char(l.created_at, 'MM-DD HH24:MI:SS') AS "时间",
	l.username AS "用户", l.token_name AS "密钥", l.model AS "模型",
	l.status_code AS "状态",
	array_to_string(array_remove(ARRAY[
		CASE WHEN $REQ_MATCH THEN 'req' END,
		CASE WHEN $RESP_MATCH THEN 'resp' END], NULL), '+') AS "命中",
	coalesce(nullif($REQ_DISP, ''), $RESP_DISP) AS "上下文"
FROM request_log_details d JOIN request_logs l ON l.id = d.log_id
WHERE $COND
ORDER BY d.log_id DESC
LIMIT least($LIMIT, 20);

\\pset format unaligned
\\pset tuples_only on
SELECT format(
	'检索范围：%s 条已保留正文，%s ~ %s（更早的正文已滚出保留窗口，查不到）',
	count(*), to_char(min(created_at), 'MM-DD HH24:MI'),
	to_char(max(created_at), 'MM-DD HH24:MI'))
FROM request_log_details;

\\o
SELECT json_build_object(
	'log_id', d.log_id,
	'created_at', to_char(l.created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
	'username', l.username,
	'token_name', l.token_name,
	'client_type', l.client_type,
	'client_ip', l.client_ip,
	'endpoint', l.endpoint,
	'method', l.method,
	'model', l.model,
	'upstream_model', l.upstream_model,
	'reasoning_effort', l.reasoning_effort,
	'channel_id', l.channel_id,
	'channel_name', l.channel_name,
	'status_code', l.status_code,
	'stream', l.stream,
	'retries', l.retries,
	'duration_ms', l.duration_ms,
	'ttfb_ms', l.ttfb_ms,
	'prompt_tokens', l.prompt_tokens,
	'completion_tokens', l.completion_tokens,
	'total_tokens', l.total_tokens,
	'cost_usd', round(l.cost / 1e6, 6),
	'error', l.error,
	'matched_in', array_to_json(array_remove(ARRAY[
		CASE WHEN $REQ_MATCH THEN 'request' END,
		CASE WHEN $RESP_MATCH THEN 'response' END], NULL)),
	'request_hits', CASE WHEN $REQ_MATCH THEN $(hits_expr d.request_body) ELSE 0 END,
	'response_hits', CASE WHEN $RESP_MATCH THEN $(hits_expr d.response_body) ELSE 0 END,
	'request_snippet', $REQ_SNIP,
	'response_snippet', $RESP_SNIP,$BODY_FIELDS
	'request_truncated', d.request_truncated,
	'response_truncated', d.response_truncated)
FROM request_log_details d JOIN request_logs l ON l.id = d.log_id
WHERE $COND
ORDER BY d.log_id DESC
LIMIT $LIMIT;

COMMIT;
SQL
)

# Credentials resolved the way docker-compose.yml resolves them, in a subshell
# so only what is needed crosses back out of .env.
eval "$(
	set -a
	[ -f .env ] && . ./.env
	set +a
	echo "PGUSER='${POSTGRES_USER:-llmproxy}'"
	echo "PGDATABASE='${POSTGRES_DB:-llmproxy}'"
	echo "PGTZ='${TZ:-Asia/Singapore}'"
)"

docker inspect -f '{{.State.Running}}' "$CONTAINER" >/dev/null 2>&1 ||
	die "container $CONTAINER is not running (set PG_CONTAINER to override)"

# The export carries other people's prompts verbatim: 0600, and by default into
# a gitignored directory rather than anywhere near a commit.
umask 077
# ON_ERROR_STOP: without it a rejected --since timestamp aborts the transaction,
# every later statement reports "current transaction is aborted", and psql still
# exits 0 — the run would then look like a search that found nothing.
psql_run() {
	printf '%s\n' "$SQL" | docker exec -i \
		-e PGTZ="$PGTZ" -e PGUSER="$PGUSER" -e PGDATABASE="$PGDATABASE" \
		"$CONTAINER" psql -q -v ON_ERROR_STOP=1 \
		-v kw="$KEYWORD" -v since="$SINCE" -v until="$UNTIL"
}

# The export carries other people's prompts verbatim: 0600, and by default into
# a gitignored directory rather than anywhere near a commit.
umask 077
if [ "$OUT" = - ]; then
	psql_run
	exit
fi

mkdir -p "$(dirname "$OUT")"
# The redirect creates the file before psql runs, so a failed query would leave
# an empty one behind — indistinguishable from a search that matched nothing.
trap 'if [ ! -s "$OUT" ]; then rm -f "$OUT"; fi' EXIT
psql_run >"$OUT"

# Counted from the file itself, so the number reported is what is actually in it.
found=$(wc -l <"$OUT" | tr -d ' ')
if [ "$found" -eq 0 ]; then
	rm -f "$OUT"
	echo "search-logs: 「$KEYWORD」无匹配，未生成文件" >&2
	exit 0
fi

echo "search-logs: 导出 $found 条记录 → $OUT ($(du -h "$OUT" | cut -f1))" >&2
if [ "$found" -gt 20 ]; then
	echo "search-logs: 上表只列出最新 20 条，其余在文件里" >&2
fi
if [ "$found" -ge "$LIMIT" ]; then
	echo "search-logs: 已达 --limit $LIMIT，可能还有更多匹配未导出" >&2
fi



