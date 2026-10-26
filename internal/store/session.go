package store

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/faketoken/faketoken/internal/chunk"
	"github.com/faketoken/faketoken/internal/conversation"
	"github.com/faketoken/faketoken/internal/model"
)

// linkCandidates bounds how far back a call looks for the one it continues.
// A session interleaves its main line with subagents and side calls, so the
// parent is not always the call just before it.
const linkCandidates = 64

// linkWindow bounds the search for a call that names no session, among the
// same key's calls: content is all that ties those together, so the search
// stays recent.
const linkWindow = 6 * time.Hour

// CallLink is where a call sits in its conversation; see migration 0036.
type CallLink struct {
	SessionID string
	ParentID  int64
	ThreadID  int64
	Shared    int32
	Messages  int32
}

type linkCandidate struct {
	id, thread int64
	session    string
	messages   []int64
}

// LinkCall finds the earlier call this one continues and records it on the
// row: among the session's recent calls — or, with no session named, the same
// key's — the one whose messages it repeats from the start. One repeated
// whole beats one repeated in part, then the longer run wins, then the more
// recent call: a side call that copied the conversation and added a question
// of its own must not become the next turn's parent instead of the turn before.
//
// A call that repeats its parent whole continues the parent's line; one that
// dropped part of it — an edited or rewound conversation — starts a line of
// its own. Calls that name no session and link up share "~<first call>".
func (s *Store) LinkCall(ctx context.Context, id int64, session string, tokenID int64,
	messages []int64) (CallLink, error) {

	link := CallLink{SessionID: session, Messages: int32(len(messages))}
	if len(messages) == 0 {
		return link, nil
	}
	link.ThreadID = id

	candidates, err := s.linkCandidates(ctx, id, session, tokenID)
	if err != nil {
		return link, err
	}
	var best *linkCandidate
	bestShared, bestWhole := 0, false
	for i := range candidates {
		c := &candidates[i]
		shared := conversation.Shared(messages, c.messages)
		if shared == 0 {
			continue
		}
		whole := shared == len(c.messages)
		// Newest first, so only a strictly better match displaces one.
		if best == nil || (whole && !bestWhole) || (whole == bestWhole && shared > bestShared) {
			best, bestShared, bestWhole = c, shared, whole
		}
	}

	if best != nil {
		link.ParentID, link.Shared = best.id, int32(bestShared)
		if bestWhole {
			link.ThreadID = best.thread
			if link.ThreadID == 0 {
				link.ThreadID = best.id
			}
		}
		if session == "" {
			link.SessionID = best.session
			if link.SessionID == "" {
				root := best.thread
				if root == 0 {
					root = best.id
				}
				link.SessionID = "~" + strconv.FormatInt(root, 10)
			}
		}
	}

	// An empty session leaves the stored one alone: a chain's first call is
	// given its "~" id by the call that links to it, and relinking it later
	// must not take that away.
	if _, err := s.pool.Exec(ctx, `UPDATE request_logs SET
			session_id = CASE WHEN $2 = '' THEN session_id ELSE $2 END,
			parent_id = $3, thread_id = $4, shared_messages = $5, message_count = $6
		WHERE id = $1`,
		id, link.SessionID, link.ParentID, link.ThreadID, link.Shared, link.Messages); err != nil {
		return link, err
	}
	if best != nil && best.session == "" {
		if _, err := s.pool.Exec(ctx, `UPDATE request_logs SET session_id = $1
			WHERE id = $2 AND session_id = ''`, link.SessionID, best.id); err != nil {
			return link, err
		}
	}
	return link, nil
}

// linkCandidates returns the recent calls a call may continue, newest first.
// Only calls whose messages are hashed qualify, which is every call with its
// bodies still kept.
func (s *Store) linkCandidates(ctx context.Context, id int64, session string,
	tokenID int64) ([]linkCandidate, error) {

	var rows pgx.Rows
	var err error
	switch {
	case session != "":
		rows, err = s.pool.Query(ctx, `SELECT l.id, l.thread_id, l.session_id, d.request_messages
			FROM request_logs l JOIN request_log_details d ON d.log_id = l.id
			WHERE l.session_id = $1 AND l.id < $2 AND cardinality(d.request_messages) > 0
			ORDER BY l.id DESC LIMIT $3`, session, id, linkCandidates)
	case tokenID > 0:
		// Walked from the bodies' side: that table holds the window only, so
		// the scan stays short however few calls the key made. The window is
		// measured back from the call itself, which the backfill runs days late.
		rows, err = s.pool.Query(ctx, `SELECT l.id, l.thread_id, l.session_id, d.request_messages
			FROM request_log_details d JOIN request_logs l ON l.id = d.log_id
			WHERE d.log_id < $2 AND l.token_id = $1
			  AND l.created_at > (SELECT created_at FROM request_logs WHERE id = $2) - $3::interval
			  AND cardinality(d.request_messages) > 0
			ORDER BY d.log_id DESC LIMIT $4`, tokenID, id, linkWindow.String(), linkCandidates)
	default:
		// A console probe has no key and no conversation to belong to.
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []linkCandidate
	for rows.Next() {
		var c linkCandidate
		if err := rows.Scan(&c.id, &c.thread, &c.session, &c.messages); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// ------------------------------------------------------------------ sessions

// SessionSummary is one conversation at a glance.
type SessionSummary struct {
	ID          string    `json:"id"`
	Calls       int64     `json:"calls"`
	Threads     int64     `json:"threads"`
	Failures    int64     `json:"failures"`
	FirstAt     time.Time `json:"first_at"`
	LastAt      time.Time `json:"last_at"`
	Cost        int64     `json:"cost"`
	TotalTokens int64     `json:"total_tokens"`
	// The latest call's, which is what the conversation is using now.
	ClientType string `json:"client_type"`
	Username   string `json:"username"`
	Model      string `json:"model"`
}

const sessionColumns = `session_id, count(*),
	count(DISTINCT thread_id) FILTER (WHERE thread_id <> 0),
	count(*) FILTER (WHERE %s), min(created_at), max(created_at),
	coalesce(sum(cost), 0), coalesce(sum(total_tokens), 0),
	(array_agg(client_type ORDER BY id DESC))[1],
	(array_agg(username ORDER BY id DESC))[1],
	(array_agg(model ORDER BY id DESC))[1]`

func scanSession(row pgx.Row) (SessionSummary, error) {
	var s SessionSummary
	err := row.Scan(&s.ID, &s.Calls, &s.Threads, &s.Failures, &s.FirstAt, &s.LastAt,
		&s.Cost, &s.TotalTokens, &s.ClientType, &s.Username, &s.Model)
	return s, err
}

// ListSessions returns the conversations active since a moment, the most
// recent first, with their calls counted from then on.
func (s *Store) ListSessions(ctx context.Context, since time.Time, offset, limit int) (
	[]SessionSummary, int64, error) {

	var total int64
	if err := s.pool.QueryRow(ctx, `SELECT count(DISTINCT session_id) FROM request_logs
		WHERE session_id <> '' AND created_at >= $1`, since).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := s.pool.Query(ctx, fmt.Sprintf(`SELECT `+sessionColumns+`
		FROM request_logs WHERE session_id <> '' AND created_at >= $1
		GROUP BY session_id ORDER BY max(created_at) DESC LIMIT $2 OFFSET $3`, failedSQL),
		since, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	out := []SessionSummary{}
	for rows.Next() {
		summary, err := scanSession(rows)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, summary)
	}
	return out, total, rows.Err()
}

// ThreadSummary is one line of a conversation: the main one, a subagent's, a
// side call's, or a branch where the conversation was edited. Thread 0 holds
// the session's calls that were never linked, for want of a body.
type ThreadSummary struct {
	ID          int64     `json:"id"`
	Calls       int64     `json:"calls"`
	Failures    int64     `json:"failures"`
	FirstAt     time.Time `json:"first_at"`
	LastAt      time.Time `json:"last_at"`
	Cost        int64     `json:"cost"`
	TotalTokens int64     `json:"total_tokens"`
	Model       string    `json:"model"`
	// Messages is what the longest request of the line carried.
	Messages int32 `json:"messages"`
	// LatestWithBody is the newest call whose bodies are still kept: its
	// request carries every earlier turn, so the transcript is read from it.
	LatestWithBody int64 `json:"latest_with_body"`
	// BranchOf and BranchAt name the call this line split from, and after how
	// many of its messages. Zero for a line that started fresh.
	BranchOf int64 `json:"branch_of"`
	BranchAt int32 `json:"branch_at"`
}

// SessionThreads returns one conversation and its lines, the busiest first.
// ErrNotFound when no call carries the id.
func (s *Store) SessionThreads(ctx context.Context, session string) (SessionSummary, []ThreadSummary, error) {
	summary, err := scanSession(s.pool.QueryRow(ctx, fmt.Sprintf(`SELECT `+sessionColumns+`
		FROM request_logs WHERE session_id = $1 GROUP BY session_id`, failedSQL), session))
	if err != nil {
		return summary, nil, mapErr(err)
	}

	rows, err := s.pool.Query(ctx, `SELECT l.thread_id, count(*),
			count(*) FILTER (WHERE `+failedOn("l")+`),
			min(l.created_at), max(l.created_at),
			coalesce(sum(l.cost), 0), coalesce(sum(l.total_tokens), 0),
			(array_agg(l.model ORDER BY l.id DESC))[1], max(l.message_count),
			coalesce(max(l.id) FILTER (WHERE d.log_id IS NOT NULL), 0),
			coalesce(min(r.parent_id), 0), coalesce(min(r.shared_messages), 0)
		FROM request_logs l
		LEFT JOIN request_log_details d ON d.log_id = l.id
		LEFT JOIN request_logs r ON r.id = l.thread_id
		WHERE l.session_id = $1
		GROUP BY l.thread_id ORDER BY count(*) DESC, l.thread_id`, session)
	if err != nil {
		return summary, nil, err
	}
	defer rows.Close()

	threads := []ThreadSummary{}
	for rows.Next() {
		var t ThreadSummary
		if err := rows.Scan(&t.ID, &t.Calls, &t.Failures, &t.FirstAt, &t.LastAt, &t.Cost,
			&t.TotalTokens, &t.Model, &t.Messages, &t.LatestWithBody,
			&t.BranchOf, &t.BranchAt); err != nil {
			return summary, nil, err
		}
		threads = append(threads, t)
	}
	return summary, threads, rows.Err()
}

// maxThreadCalls bounds one read of a line. The longest seen ran to a few
// thousand calls; the cap is there for the pathological one.
const maxThreadCalls = 20000

// ThreadCalls returns a line's calls in the order they were made.
func (s *Store) ThreadCalls(ctx context.Context, session string, thread int64) ([]*model.RequestLog, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+logColumns+` FROM request_logs
		WHERE session_id = $1 AND thread_id = $2 ORDER BY id LIMIT $3`,
		session, thread, maxThreadCalls)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []*model.RequestLog{}
	for rows.Next() {
		l, err := scanLog(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// ------------------------------------------------------------------ backfill

// linkBackfillOption marks the bodies stored before calls were linked as
// linked too, so a restart does not walk them again.
const linkBackfillOption = "logs.link_backfill"

// StartLinkBackfill runs BackfillLinks once, in the background, and records
// that it finished so a restart does not walk the bodies again.
func (s *Store) StartLinkBackfill(ctx context.Context) {
	go func() {
		if done, err := s.GetOption(ctx, linkBackfillOption); err == nil && done == "v1" {
			return
		}
		started := time.Now()
		hashed, linked, err := s.BackfillLinks(ctx)
		if err != nil {
			slog.Error("linking stored calls failed", "hashed", hashed, "linked", linked, "error", err)
			return
		}
		if err := s.SetOption(ctx, linkBackfillOption, "v1"); err != nil {
			slog.Error("could not record the link backfill", "error", err)
		}
		slog.Info("linked the calls stored before linking", "hashed", hashed, "linked", linked,
			"took", time.Since(started).Round(time.Second))
	}()
}

// BackfillLinks links the calls whose bodies were stored before linking
// existed. Each request is hashed newest first, so a call arriving meanwhile
// finds its recent candidates ready; then every kept call is linked oldest
// first, so a parent is in place before its children. Both passes resume
// where an interrupted run left them: hashing skips what is done, and linking
// a call twice gives the same answer.
func (s *Store) BackfillLinks(ctx context.Context) (hashed, linked int, err error) {
	if hashed, err = s.hashStoredRequests(ctx); err != nil {
		return hashed, 0, err
	}
	linked, err = s.relinkStored(ctx)
	return hashed, linked, err
}

// backfillPause spaces the rows out: a request runs to a megabyte of JSON, and
// the backfill must not crowd out the calls being served meanwhile.
const backfillPause = 2 * time.Millisecond

func (s *Store) hashStoredRequests(ctx context.Context) (int, error) {
	done := 0
	for {
		rows, err := s.pool.Query(ctx, `SELECT log_id FROM request_log_details
			WHERE request_messages IS NULL ORDER BY log_id DESC LIMIT 100`)
		if err != nil {
			return done, err
		}
		ids, err := pgx.CollectRows(rows, pgx.RowTo[int64])
		if err != nil || len(ids) == 0 {
			return done, err
		}
		for _, id := range ids {
			// A body that cannot be read back is marked done all the same: it
			// cannot be linked, and leaving it NULL would loop on it forever.
			messages := []int64{}
			if body, err := s.requestBody(ctx, id); err == nil {
				if hashed := conversation.Messages([]byte(body)); hashed != nil {
					messages = hashed
				}
			}
			if _, err := s.pool.Exec(ctx, `UPDATE request_log_details SET request_messages = $2
				WHERE log_id = $1`, id, messages); err != nil {
				return done, err
			}
			done++
			select {
			case <-ctx.Done():
				return done, ctx.Err()
			case <-time.After(backfillPause):
			}
		}
	}
}

func (s *Store) relinkStored(ctx context.Context) (int, error) {
	done, after := 0, int64(0)
	for {
		rows, err := s.pool.Query(ctx, `SELECT d.log_id, l.session_id, l.token_id, d.request_messages
			FROM request_log_details d JOIN request_logs l ON l.id = d.log_id
			WHERE d.log_id > $1 AND cardinality(d.request_messages) > 0
			ORDER BY d.log_id LIMIT 500`, after)
		if err != nil {
			return done, err
		}
		type stored struct {
			id, token int64
			session   string
			messages  []int64
		}
		var batch []stored
		for rows.Next() {
			var row stored
			if err := rows.Scan(&row.id, &row.session, &row.token, &row.messages); err != nil {
				rows.Close()
				return done, err
			}
			batch = append(batch, row)
		}
		rows.Close()
		if err := rows.Err(); err != nil || len(batch) == 0 {
			return done, err
		}
		for _, row := range batch {
			// A "~" id was derived by an earlier link, so it is worked out
			// again rather than taken as something the client named.
			session := row.session
			if strings.HasPrefix(session, "~") {
				session = ""
			}
			if _, err := s.LinkCall(ctx, row.id, session, row.token, row.messages); err != nil {
				return done, err
			}
			done++
			after = row.id
		}
		if ctx.Err() != nil {
			return done, ctx.Err()
		}
	}
}

// requestBody reads back one call's stored request, for the backfill: the
// response is not needed, and it can be large.
func (s *Store) requestBody(ctx context.Context, logID int64) (string, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)

	var order [][]byte
	if err := tx.QueryRow(ctx, `SELECT request_chunks FROM request_log_details
		WHERE log_id = $1`, logID).Scan(&order); err != nil {
		return "", mapErr(err)
	}
	rows, err := tx.Query(ctx, `SELECT hash, data FROM body_chunks WHERE hash = ANY($1)`, order)
	if err != nil {
		return "", err
	}
	packed := map[chunk.Hash][]byte{}
	for rows.Next() {
		var h, data []byte
		if err := rows.Scan(&h, &data); err != nil {
			rows.Close()
			return "", err
		}
		packed[chunk.Hash(h)] = data
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return "", err
	}
	return assemble(order, packed)
}
