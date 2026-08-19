package store

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/faketoken/faketoken/internal/model"
)

const logColumns = `id, created_at, user_id, username, token_id, token_name, channel_id,
	channel_name, model, upstream_model, endpoint, method, status_code, stream,
	prompt_tokens, completion_tokens, cached_tokens, total_tokens, cost,
	duration_ms, ttfb_ms, retries, client_ip, error, cache_creation_tokens,
	reasoning_effort, client_type`

// InsertLog persists one entry and fills in the values the database
// generates, so the caller holds a complete row — the live log stream forwards
// this struct straight to the console, where the id is the list key and the
// timestamp is displayed.
func (s *Store) InsertLog(ctx context.Context, l *model.RequestLog) error {
	return s.pool.QueryRow(ctx, `INSERT INTO request_logs
		(user_id, username, token_id, token_name, channel_id, channel_name, model,
		 upstream_model, endpoint, method, status_code, stream, prompt_tokens,
		 completion_tokens, cached_tokens, total_tokens, cost, duration_ms, ttfb_ms,
		 retries, client_ip, error, cache_creation_tokens, reasoning_effort, client_type)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
		RETURNING id, created_at`,
		l.UserID, l.Username, l.TokenID, l.TokenName, l.ChannelID, l.ChannelName, l.Model,
		l.UpstreamModel, l.Endpoint, l.Method, l.StatusCode, l.Stream, l.PromptTokens,
		l.CompletionTokens, l.CachedTokens, l.TotalTokens, l.Cost, l.DurationMS, l.TTFBMS,
		l.Retries, l.ClientIP, truncate(l.Error, 2000), l.CacheCreationTokens,
		truncate(l.ReasoningEffort, 64), truncate(l.ClientType, 64)).
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
	Start     *time.Time
	End       *time.Time
	Offset    int
	Limit     int
}

// LogKeywordColumns are the columns a keyword search covers. Named once
// because the live feed has to match on exactly the same set: if the two
// disagree, a search shows rows that the stream then refuses to append, or the
// reverse.
var LogKeywordColumns = []string{
	"username", "token_name", "model", "upstream_model",
	"channel_name", "endpoint", "client_ip", "error",
}

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
		// strpos rather than LIKE: the box takes literal text, and a value
		// containing % or _ would otherwise turn into a wildcard pattern.
		matches := make([]string, 0, len(LogKeywordColumns)+1)
		for _, column := range LogKeywordColumns {
			matches = append(matches, fmt.Sprintf("strpos(lower(%s), lower($%%[1]d)) > 0", column))
		}
		// An id is what someone pastes in after reading it off a row, so the
		// search has to accept one. Compared as text: a number too large for
		// bigint would otherwise fail the whole query rather than match
		// nothing.
		matches = append(matches, "id::text = $%[1]d")
		add("("+strings.Join(matches, " OR ")+")", kw)
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
	rows, err := s.pool.Query(ctx, fmt.Sprintf(
		`SELECT %s FROM request_logs WHERE %s ORDER BY id DESC LIMIT $%d OFFSET $%d`,
		logColumns, where, len(args)-1, len(args)), args...)
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
			&l.CacheCreationTokens, &l.ReasoningEffort, &l.ClientType); err != nil {
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
// A rolling window rather than a time span: the bodies are large, so the useful
// guarantee is a bounded footprint, not a bounded age.
const DefaultLogDetailKeep = 1000

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

// InsertLogDetail stores the bodies for one call and drops whatever has fallen
// out of the window.
//
// Called from the same detached goroutine as InsertLog, so the cost never
// reaches the client. Failure is the caller's to log and ignore: losing a
// diagnostic body must not affect a request that already succeeded.
func (s *Store) InsertLogDetail(ctx context.Context, d *model.RequestLogDetail) error {
	keep := s.logDetailKeep()
	if keep <= 0 {
		// Recording is off. Clear anything left from when it was on, so
		// turning it off actually removes the stored bodies.
		_, err := s.pool.Exec(ctx, `DELETE FROM request_log_details`)
		return err
	}

	if _, err := s.pool.Exec(ctx, `INSERT INTO request_log_details
		(log_id, request_headers, request_body, request_truncated,
		 response_headers, response_body, response_truncated)
		VALUES ($1,$2,$3,$4,$5,$6,$7)
		ON CONFLICT (log_id) DO NOTHING`,
		d.LogID, d.RequestHeaders, d.RequestBody, d.RequestTruncated,
		d.ResponseHeaders, d.ResponseBody, d.ResponseTruncated); err != nil {
		return err
	}

	// Keep the newest `keep` rows and drop everything below them.
	//
	// Expressed as "the oldest id still inside the window" rather than
	// arithmetic on the newest id: request_logs ids stop being dense once a
	// purge has run, and subtracting from the maximum would discard rows that
	// are still within the window. While fewer than `keep` rows exist the
	// subquery returns the smallest id present, so nothing matches.
	_, err := s.pool.Exec(ctx, `DELETE FROM request_log_details
		WHERE log_id < (SELECT min(log_id) FROM
			(SELECT log_id FROM request_log_details
			 ORDER BY log_id DESC LIMIT $1) newest)`, keep)
	return err
}

// GetLogDetail returns the stored bodies for one call. ErrNotFound means the
// call is older than the window, or was never recorded.
func (s *Store) GetLogDetail(ctx context.Context, logID int64) (*model.RequestLogDetail, error) {
	var d model.RequestLogDetail
	err := s.pool.QueryRow(ctx, `SELECT log_id, created_at, request_headers, request_body,
		request_truncated, response_headers, response_body, response_truncated
		FROM request_log_details WHERE log_id = $1`, logID).
		Scan(&d.LogID, &d.CreatedAt, &d.RequestHeaders, &d.RequestBody,
			&d.RequestTruncated, &d.ResponseHeaders, &d.ResponseBody, &d.ResponseTruncated)
	if err != nil {
		return nil, mapErr(err)
	}
	return &d, nil
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
	rows, err := s.pool.Query(ctx, fmt.Sprintf(`SELECT
		date_trunc('%s', created_at) AS bucket,
		count(*),
		count(*) FILTER (WHERE status_code >= 400 OR error <> ''),
		coalesce(sum(cost), 0),
		coalesce(sum(total_tokens), 0)
		FROM request_logs WHERE %s GROUP BY bucket ORDER BY bucket`, interval, where), args...)
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

// TopBy aggregates spend grouped by "model", "channel_name" or "username".
func (s *Store) TopBy(ctx context.Context, f LogFilter, column string, limit int) ([]NamedStat, error) {
	switch column {
	case "model", "channel_name", "username":
	default:
		return nil, fmt.Errorf("%w: unsupported group column %q", ErrInvalidInput, column)
	}
	where, args := f.build()
	args = append(args, limit)
	rows, err := s.pool.Query(ctx, fmt.Sprintf(`SELECT %s, count(*),
		coalesce(sum(cost),0), coalesce(sum(total_tokens),0)
		FROM request_logs WHERE %s AND %s <> ''
		GROUP BY %s ORDER BY count(*) DESC LIMIT $%d`,
		column, where, column, column, len(args)), args...)
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
