package store

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/faketoken/faketoken/internal/chunk"
	"github.com/faketoken/faketoken/internal/model"
)

const logColumns = `id, created_at, user_id, username, token_id, token_name, channel_id,
	channel_name, model, upstream_model, endpoint, method, status_code, stream,
	prompt_tokens, completion_tokens, cached_tokens, total_tokens, cost,
	duration_ms, ttfb_ms, retries, client_ip, error, cache_creation_tokens,
	reasoning_effort, client_type, upstream_status, prompt_estimated`

// InsertLog persists one entry and fills in the values the database
// generates, so the caller holds a complete row — the live log stream forwards
// this struct straight to the console, where the id is the list key and the
// timestamp is displayed.
//
// The usage_hourly rollup is bumped in the same statement, so the heatmap can
// never drift from the log. The error test matches Summary's.
func (s *Store) InsertLog(ctx context.Context, l *model.RequestLog) error {
	return s.pool.QueryRow(ctx, `WITH row AS (INSERT INTO request_logs
		(user_id, username, token_id, token_name, channel_id, channel_name, model,
		 upstream_model, endpoint, method, status_code, stream, prompt_tokens,
		 completion_tokens, cached_tokens, total_tokens, cost, duration_ms, ttfb_ms,
		 retries, client_ip, error, cache_creation_tokens, reasoning_effort, client_type,
		 upstream_status, prompt_estimated)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
		RETURNING id, created_at, user_id, status_code, error, cost, total_tokens),
	rollup AS (INSERT INTO usage_hourly AS u (user_id, hour, requests, errors, cost, total_tokens)
		SELECT user_id, date_trunc('hour', created_at), 1,
		       CASE WHEN status_code >= 400 OR error <> '' THEN 1 ELSE 0 END,
		       cost, total_tokens
		FROM row
		ON CONFLICT (user_id, hour) DO UPDATE SET
			requests = u.requests + 1,
			errors = u.errors + EXCLUDED.errors,
			cost = u.cost + EXCLUDED.cost,
			total_tokens = u.total_tokens + EXCLUDED.total_tokens)
	SELECT id, created_at FROM row`,
		l.UserID, l.Username, l.TokenID, l.TokenName, l.ChannelID, l.ChannelName, l.Model,
		l.UpstreamModel, l.Endpoint, l.Method, l.StatusCode, l.Stream, l.PromptTokens,
		l.CompletionTokens, l.CachedTokens, l.TotalTokens, l.Cost, l.DurationMS, l.TTFBMS,
		l.Retries, l.ClientIP, truncate(l.Error, 2000), l.CacheCreationTokens,
		truncate(l.ReasoningEffort, 64), truncate(l.ClientType, 64), l.UpstreamStatus,
		l.PromptEstimated).
		Scan(&l.ID, &l.CreatedAt)
}

type LogFilter struct {
	UserID    int64
	ChannelID int64
	TokenID   int64
	TokenName string
	Model     string
	Username  string
	// Keyword matches loosely across the text columns, for when the operator
	// knows something about a call but not which field it was.
	Keyword   string
	OnlyError bool
	// HideErrorPrefix withholds one class of error text from a keyword search:
	// a row whose error starts with it still matches on every other column, but
	// not on that one.
	//
	// The block policy records which group matched and on which keyword. A
	// caller able to search that text would not need to see it — a query that
	// returns their own blocked call confirms the word, one guess at a time.
	// Empty searches everything, which is what an administrator gets.
	HideErrorPrefix string
	// HideOperatorColumns leaves LogOperatorColumns out of a keyword search,
	// for an account reading its own calls: those columns are withheld from
	// its rows, and a search on them would confirm a value just as well.
	HideOperatorColumns bool
	Start               *time.Time
	End                 *time.Time
	Offset              int
	Limit               int
}

// LogKeywordColumns are the columns a keyword search covers. Named once
// because the live feed has to match on exactly the same set: if the two
// disagree, a search shows rows that the stream then refuses to append, or the
// reverse.
var LogKeywordColumns = []string{
	"username", "token_name", "model", "upstream_model",
	"channel_name", "endpoint", "client_ip", "error",
}

// LogOperatorColumns are routing internals only an administrator is shown:
// which upstream model a name was mapped to, and where a call came from.
var LogOperatorColumns = map[string]bool{"upstream_model": true, "client_ip": true}

func (f LogFilter) build() (string, []any) {
	conds := []string{"TRUE"}
	args := []any{}
	add := func(format string, value any) {
		args = append(args, value)
		conds = append(conds, fmt.Sprintf(format, len(args)))
	}
	if f.UserID > 0 {
		add("user_id = $%d", f.UserID)
	}
	if f.ChannelID > 0 {
		add("channel_id = $%d", f.ChannelID)
	}
	if f.TokenID > 0 {
		add("token_id = $%d", f.TokenID)
	}
	if f.TokenName != "" {
		add("lower(token_name) = lower($%d)", f.TokenName)
	}
	if f.Model != "" {
		add("model = $%d", f.Model)
	}
	if f.Username != "" {
		add("lower(username) = lower($%d)", f.Username)
	}
	if kw := strings.TrimSpace(f.Keyword); kw != "" {
		// Placed by hand rather than through add(): the needle is referenced by
		// every column, and the withheld prefix needs a placeholder of its own.
		args = append(args, kw)
		needle := len(args)

		// strpos rather than LIKE: the box takes literal text, and a value
		// containing % or _ would otherwise turn into a wildcard pattern.
		matches := make([]string, 0, len(LogKeywordColumns)+1)
		for _, column := range LogKeywordColumns {
			if f.HideOperatorColumns && LogOperatorColumns[column] {
				continue
			}
			hit := fmt.Sprintf("strpos(lower(%s), lower($%d)) > 0", column, needle)
			if column == "error" && f.HideErrorPrefix != "" {
				// strpos is 1-based, so "not at position 1" is "does not start
				// with". Compared as stored, against text we wrote ourselves.
				args = append(args, f.HideErrorPrefix)
				hit = fmt.Sprintf("(%s AND strpos(error, $%d) <> 1)", hit, len(args))
			}
			matches = append(matches, hit)
		}
		// An id is what someone pastes in after reading it off a row, so the
		// search has to accept one. Compared as text: a number too large for
		// bigint would otherwise fail the whole query rather than match
		// nothing.
		matches = append(matches, fmt.Sprintf("id::text = $%d", needle))
		conds = append(conds, "("+strings.Join(matches, " OR ")+")")
	}
	if f.OnlyError {
		conds = append(conds, "(status_code >= 400 OR error <> '')")
	}
	if f.Start != nil {
		add("created_at >= $%d", *f.Start)
	}
	if f.End != nil {
		add("created_at <= $%d", *f.End)
	}
	return strings.Join(conds, " AND "), args
}

func (s *Store) ListLogs(ctx context.Context, f LogFilter) ([]*model.RequestLog, int64, error) {
	where, args := f.build()

	var total int64
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM request_logs WHERE `+where, args...).
		Scan(&total); err != nil {
		return nil, 0, err
	}

	args = append(args, f.Limit, f.Offset)
	// Assembled from the logColumns constant, the clause built above and two
	// placeholder indices. Every caller-supplied value travels in args.
	//
	// Newest first by time, not by id: rows imported later carry their own
	// timestamps and new ids, and would otherwise lead the list. id breaks ties.
	query := fmt.Sprintf(
		`SELECT %s FROM request_logs WHERE %s ORDER BY created_at DESC, id DESC LIMIT $%d OFFSET $%d`,
		logColumns, where, len(args)-1, len(args))
	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	logs := []*model.RequestLog{}
	for rows.Next() {
		var l model.RequestLog
		if err := rows.Scan(&l.ID, &l.CreatedAt, &l.UserID, &l.Username, &l.TokenID,
			&l.TokenName, &l.ChannelID, &l.ChannelName, &l.Model, &l.UpstreamModel,
			&l.Endpoint, &l.Method, &l.StatusCode, &l.Stream, &l.PromptTokens,
			&l.CompletionTokens, &l.CachedTokens, &l.TotalTokens, &l.Cost,
			&l.DurationMS, &l.TTFBMS, &l.Retries, &l.ClientIP, &l.Error,
			&l.CacheCreationTokens, &l.ReasoningEffort, &l.ClientType, &l.UpstreamStatus,
			&l.PromptEstimated); err != nil {
			return nil, 0, err
		}
		logs = append(logs, &l)
	}
	return logs, total, rows.Err()
}

func (s *Store) DeleteLogsBefore(ctx context.Context, before time.Time) (int64, error) {
	tag, err := s.pool.Exec(ctx, `DELETE FROM request_logs WHERE created_at < $1`, before)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// ------------------------------------------------------- full request bodies

// DefaultLogDetailKeep is how many calls keep their full request and response.
// A rolling window rather than a time span: the useful guarantee is a bounded
// count of bodies to read back, not a bounded age. Chunk dedup keeps a call to
// tens of kilobytes on average, which is what lets the window run this long.
const DefaultLogDetailKeep = 20000

// SetLogDetailKeep updates the window without a restart. Zero stops recording
// bodies altogether and lets the next write clear what is already stored.
func (s *Store) SetLogDetailKeep(count int) {
	if count >= 0 {
		s.detailKeep.Store(int64(count))
	}
}

func (s *Store) logDetailKeep() int {
	return int(s.detailKeep.Load())
}

// LogDetailEnabled reports whether bodies are being retained at all, so a
// caller can skip preparing them when nothing will be stored.
func (s *Store) LogDetailEnabled() bool { return s.logDetailKeep() > 0 }

// chunkGrace is how long a chunk is safe from collection after a writer last
// stored or reused it. A writer that finds a chunk and skips storing it bumps
// last_used when the chunk is near the edge, so the collector can only take a
// chunk no write has touched for this long — far longer than any write takes.
const chunkGrace = 10 * time.Minute

// InsertLogDetail stores the bodies for one call and drops whatever has fallen
// out of the window.
//
// Each body is cut into content-defined chunks and only the chunks not stored
// before are written, so a conversation resent turn after turn costs the new
// turn rather than the whole history again.
//
// Called from the same detached goroutine as InsertLog, so the cost never
// reaches the client. Failure is the caller's to log and ignore: losing a
// diagnostic body must not affect a request that already succeeded.
func (s *Store) InsertLogDetail(ctx context.Context, d *model.RequestLogDetail) error {
	keep := s.logDetailKeep()
	if keep <= 0 {
		// Recording is off. Clear anything left from when it was on, so
		// turning it off actually removes the stored bodies.
		_, err := s.pool.Exec(ctx, `DELETE FROM request_log_details; DELETE FROM body_chunks`)
		return err
	}

	reqParts := chunk.Split([]byte(d.RequestBody))
	respParts := chunk.Split([]byte(d.ResponseBody))
	reqHashes, respHashes := hashes(reqParts), hashes(respParts)

	// The chunks and the row that points at them commit together: a row
	// naming a chunk that is not stored would read back as a broken body.
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if err := storeChunks(ctx, tx, append(reqParts, respParts...),
		append(reqHashes, respHashes...)); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO request_log_details
		(log_id, request_headers, request_chunks, request_truncated,
		 response_headers, response_chunks, response_truncated)
		VALUES ($1,$2,$3,$4,$5,$6,$7)
		ON CONFLICT (log_id) DO NOTHING`,
		d.LogID, d.RequestHeaders, reqHashes, d.RequestTruncated,
		d.ResponseHeaders, respHashes, d.ResponseTruncated); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}

	// Keep the newest `keep` rows and drop everything below them. Their chunks
	// stay until the collector finds nothing pointing at them.
	//
	// After the commit, so the chunk rows this call locked are released
	// before a scan whose cost grows with the window.
	//
	// Expressed as "the oldest id still inside the window" rather than
	// arithmetic on the newest id: request_logs ids stop being dense once a
	// purge has run, and subtracting from the maximum would discard rows that
	// are still within the window. While fewer than `keep` rows exist the
	// subquery returns the smallest id present, so nothing matches.
	_, err = s.pool.Exec(ctx, `DELETE FROM request_log_details
		WHERE log_id < (SELECT min(log_id) FROM
			(SELECT log_id FROM request_log_details
			 ORDER BY log_id DESC LIMIT $1) newest)`, keep)
	return err
}

func hashes(parts [][]byte) [][]byte {
	out := make([][]byte, len(parts))
	for i, p := range parts {
		h := chunk.Sum(p)
		out[i] = h[:]
	}
	return out
}

// storeChunks writes whichever of parts are not stored yet, compressing only
// those: most of a resent conversation is already there. all holds the parts'
// hashes, index for index.
//
// A chunk found already stored is renewed in the same statement that finds
// it, if it is old enough that the collector might take it: the UPDATE locks
// the row, so a collection that started first either finishes the delete
// before this sees it (and the chunk is stored again below) or finds it
// renewed and leaves it. Renewing only stale chunks keeps the common case to
// a read.
func storeChunks(ctx context.Context, tx pgx.Tx, parts, all [][]byte) error {
	if len(parts) == 0 {
		return nil
	}
	rows, err := tx.Query(ctx, `WITH renewed AS (
			UPDATE body_chunks SET last_used = now()
			WHERE hash = ANY($1) AND last_used < now() - $2::interval
			RETURNING hash)
		SELECT hash FROM renewed
		UNION
		SELECT hash FROM body_chunks
		WHERE hash = ANY($1) AND last_used >= now() - $2::interval`,
		all, (chunkGrace / 2).String())
	if err != nil {
		return err
	}
	stored, err := pgx.CollectRows(rows, pgx.RowTo[[]byte])
	if err != nil {
		return err
	}
	have := make(map[chunk.Hash]bool, len(stored))
	for _, h := range stored {
		have[chunk.Hash(h)] = true
	}

	type fresh struct{ hash, data []byte }
	var pending []fresh
	for i, p := range parts {
		h := chunk.Hash(all[i])
		if have[h] {
			continue
		}
		have[h] = true // a body can repeat a chunk within itself
		packed, err := chunk.Pack(p)
		if err != nil {
			return err
		}
		pending = append(pending, fresh{all[i], packed})
	}
	if len(pending) == 0 {
		return nil
	}

	// In hash order: two calls from one conversation store the same new
	// chunks at once, and taking the row locks in one order is what keeps
	// them from deadlocking on each other.
	slices.SortFunc(pending, func(a, b fresh) int { return bytes.Compare(a.hash, b.hash) })
	newHashes, newData := make([][]byte, len(pending)), make([][]byte, len(pending))
	for i, f := range pending {
		newHashes[i], newData[i] = f.hash, f.data
	}

	// ON CONFLICT covers a concurrent writer storing the same chunk first; the
	// row it wrote is fresh, so it is safe to point at.
	_, err = tx.Exec(ctx, `INSERT INTO body_chunks (hash, data)
		SELECT * FROM unnest($1::bytea[], $2::bytea[])
		ON CONFLICT (hash) DO UPDATE SET last_used = now()`, newHashes, newData)
	return err
}

// GetLogDetail returns the stored bodies for one call. ErrNotFound means the
// call is older than the window, or was never recorded.
//
// The row and its chunks are read in one repeatable-read snapshot, so a
// trim and a collection running meanwhile cannot leave half a body behind.
func (s *Store) GetLogDetail(ctx context.Context, logID int64) (*model.RequestLogDetail, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	var d model.RequestLogDetail
	var reqHashes, respHashes [][]byte
	err = tx.QueryRow(ctx, `SELECT log_id, created_at, request_headers, request_chunks,
		request_truncated, response_headers, response_chunks, response_truncated
		FROM request_log_details WHERE log_id = $1`, logID).
		Scan(&d.LogID, &d.CreatedAt, &d.RequestHeaders, &reqHashes,
			&d.RequestTruncated, &d.ResponseHeaders, &respHashes, &d.ResponseTruncated)
	if err != nil {
		return nil, mapErr(err)
	}

	rows, err := tx.Query(ctx, `SELECT hash, data FROM body_chunks
		WHERE hash = ANY($1)`, append(reqHashes, respHashes...))
	if err != nil {
		return nil, err
	}
	packed := map[chunk.Hash][]byte{}
	for rows.Next() {
		var h, data []byte
		if err := rows.Scan(&h, &data); err != nil {
			return nil, err
		}
		packed[chunk.Hash(h)] = data
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	if d.RequestBody, err = assemble(reqHashes, packed); err != nil {
		return nil, fmt.Errorf("log %d request body: %w", logID, err)
	}
	if d.ResponseBody, err = assemble(respHashes, packed); err != nil {
		return nil, fmt.Errorf("log %d response body: %w", logID, err)
	}
	return &d, nil
}

// assemble joins a body's chunks back together. A missing chunk is an error
// rather than a gap: a body with a hole in it would read as the real one.
func assemble(order [][]byte, packed map[chunk.Hash][]byte) (string, error) {
	var b strings.Builder
	for i, h := range order {
		data, ok := packed[chunk.Hash(h)]
		if !ok {
			return "", fmt.Errorf("chunk %d of %d is missing", i+1, len(order))
		}
		part, err := chunk.Unpack(data)
		if err != nil {
			return "", fmt.Errorf("chunk %d of %d: %w", i+1, len(order), err)
		}
		b.Write(part)
	}
	return b.String(), nil
}

// CollectChunks deletes the chunks no stored body refers to any more: those
// whose bodies fell out of the window, or went with a purged log. It returns
// how many went.
//
// A chunk is only taken once no write has stored or renewed it for
// chunkGrace, which is what keeps it off a chunk a writer has just decided to
// reuse. The delete locks each row it takes, so a writer renewing the same
// chunk waits for it and then stores the chunk again.
//
// Written as one anti-join over every reference, not a lookup per chunk: the
// planner hashes the chunks and streams the references past them. Measured
// at 20 000 retained calls (2.5M references) it takes 1.7 s, and 8.6 s at the
// 100 000 ceiling; = ANY per chunk did not finish in a minute at 2 000.
func (s *Store) CollectChunks(ctx context.Context) (int64, error) {
	tag, err := s.pool.Exec(ctx, `DELETE FROM body_chunks c
		WHERE c.last_used < now() - $1::interval
		  AND NOT EXISTS (
			SELECT 1 FROM request_log_details d,
				unnest(d.request_chunks || d.response_chunks) AS r(hash)
			WHERE r.hash = c.hash)`,
		chunkGrace.String())
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// StartChunkCollector runs CollectChunks every interval until ctx ends.
func (s *Store) StartChunkCollector(ctx context.Context, every time.Duration) {
	go func() {
		ticker := time.NewTicker(every)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				started := time.Now()
				removed, err := s.CollectChunks(ctx)
				if err != nil {
					slog.Error("body chunk collection failed", "error", err)
					continue
				}
				if removed > 0 {
					slog.Info("collected unreferenced body chunks",
						"removed", removed, "took", time.Since(started).Round(time.Millisecond))
				}
			}
		}
	}()
}

// ------------------------------------------------------------------ analytics

type Summary struct {
	Requests    int64 `json:"requests"`
	Errors      int64 `json:"errors"`
	Cost        int64 `json:"cost"`
	TotalTokens int64 `json:"total_tokens"`
}

type TimeBucket struct {
	Bucket      time.Time `json:"bucket"`
	Requests    int64     `json:"requests"`
	Errors      int64     `json:"errors"`
	Cost        int64     `json:"cost"`
	TotalTokens int64     `json:"total_tokens"`
}

type NamedStat struct {
	Name        string `json:"name"`
	Requests    int64  `json:"requests"`
	Cost        int64  `json:"cost"`
	TotalTokens int64  `json:"total_tokens"`
}

func (s *Store) Summary(ctx context.Context, f LogFilter) (Summary, error) {
	where, args := f.build()
	var out Summary
	err := s.pool.QueryRow(ctx, `SELECT
		count(*),
		count(*) FILTER (WHERE status_code >= 400 OR error <> ''),
		coalesce(sum(cost), 0),
		coalesce(sum(total_tokens), 0)
		FROM request_logs WHERE `+where, args...).
		Scan(&out.Requests, &out.Errors, &out.Cost, &out.TotalTokens)
	return out, err
}

func (s *Store) TimeSeries(ctx context.Context, f LogFilter, interval string) ([]TimeBucket, error) {
	if interval != "hour" && interval != "day" {
		interval = "day"
	}
	where, args := f.build()
	// interval is one of the two literals forced above; the rest is the clause
	// built by f.build(). Every caller-supplied value travels in args.
	query := fmt.Sprintf(`SELECT
		date_trunc('%s', created_at) AS bucket,
		count(*),
		count(*) FILTER (WHERE status_code >= 400 OR error <> ''),
		coalesce(sum(cost), 0),
		coalesce(sum(total_tokens), 0)
		FROM request_logs WHERE %s GROUP BY bucket ORDER BY bucket`, interval, where)
	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []TimeBucket{}
	for rows.Next() {
		var b TimeBucket
		if err := rows.Scan(&b.Bucket, &b.Requests, &b.Errors, &b.Cost, &b.TotalTokens); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// TopBy aggregates spend grouped by "model", "upstream_model", "channel_name"
// or "username". Rows with the column empty are skipped.
func (s *Store) TopBy(ctx context.Context, f LogFilter, column string, limit int) ([]NamedStat, error) {
	switch column {
	case "model", "upstream_model", "channel_name", "username":
	default:
		return nil, fmt.Errorf("%w: unsupported group column %q", ErrInvalidInput, column)
	}
	where, args := f.build()
	args = append(args, limit)
	// column is one of the names the switch above accepts; the rest is the
	// clause built by f.build() and a placeholder index.
	query := fmt.Sprintf(`SELECT %s, count(*),
		coalesce(sum(cost),0), coalesce(sum(total_tokens),0)
		FROM request_logs WHERE %s AND %s <> ''
		GROUP BY %s ORDER BY count(*) DESC LIMIT $%d`,
		column, where, column, column, len(args))
	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []NamedStat{}
	for rows.Next() {
		var st NamedStat
		if err := rows.Scan(&st.Name, &st.Requests, &st.Cost, &st.TotalTokens); err != nil {
			return nil, err
		}
		out = append(out, st)
	}
	return out, rows.Err()
}

// ------------------------------------------------------------------ heatmap

// UsageDay is one calendar day of the heatmap.
type UsageDay struct {
	Day         string `json:"day"` // 2026-10-22, in the viewer's zone
	Requests    int64  `json:"requests"`
	Errors      int64  `json:"errors"`
	Cost        int64  `json:"cost"`
	TotalTokens int64  `json:"total_tokens"`
}

// UsageDays folds the hourly rollup into days in loc, from start onwards.
// userID 0 sums every account. Days without traffic are omitted.
func (s *Store) UsageDays(ctx context.Context, userID int64, start time.Time,
	loc *time.Location) ([]UsageDay, error) {

	rows, err := s.pool.Query(ctx, `SELECT
		to_char((hour AT TIME ZONE $3::text)::date, 'YYYY-MM-DD') AS day,
		sum(requests), sum(errors), sum(cost), sum(total_tokens)
		FROM usage_hourly
		WHERE hour >= $1 AND ($2::bigint = 0 OR user_id = $2)
		GROUP BY day ORDER BY day`, start, userID, loc.String())
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []UsageDay{}
	for rows.Next() {
		var d UsageDay
		if err := rows.Scan(&d.Day, &d.Requests, &d.Errors, &d.Cost, &d.TotalTokens); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}
