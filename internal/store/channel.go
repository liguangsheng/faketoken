package store

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/faketoken/faketoken/internal/model"
)

// nameConflict turns the unique-index violation into a message that names the
// channel, since "already exists" alone leaves the operator guessing.
func nameConflict(err error, name string) error {
	if errors.Is(err, ErrDuplicate) {
		return fmt.Errorf("%w: channel name %q", ErrDuplicate, name)
	}
	return err
}

// normaliseProtocols cleans the dialect list. An empty result means every
// dialect — stored as an empty array so the default routing keeps treating
// the channel as universally routable.
func normaliseProtocols(in []string) []string { return model.NormaliseList(in) }

// statusMapping stores a missing mapping as {} rather than JSON null, which the
// NOT NULL column would refuse.
func statusMapping(in map[int]int) map[int]int {
	if in == nil {
		return map[int]int{}
	}
	return in
}

const channelColumns = `id, name, base_url, auth_style, api_key_enc, status, priority, weight,
	channel_groups, models, model_mapping, headers, timeout_secs, proxy_url, price_ratio,
	rpm_limit, retry_count, retry_backoff_ms, used_quota, request_count, error_count, last_error, last_error_at, tested_at,
	models_synced_at, note, created_at, updated_at, model_prefixes, test_model, supported_protocols,
	reasoning_effort_mapping, status_code_mapping,
	allow_attachments, lock_user_agent, locked_user_agents,
	keepalive_enabled, keepalive_at, keepalive_target, keepalive_open, keepalive_success,
	keepalive_opened_at, archived`

func (s *Store) scanChannel(row pgx.Row) (*model.Channel, error) {
	var c model.Channel
	var enc string
	err := row.Scan(&c.ID, &c.Name, &c.BaseURL, &c.AuthStyle, &enc, &c.Status, &c.Priority,
		&c.Weight, &c.Groups, &c.Models, &c.ModelMapping, &c.Headers, &c.TimeoutSecs,
		&c.ProxyURL, &c.PriceRatio, &c.RPMLimit, &c.RetryCount, &c.RetryBackoffMS,
		&c.UsedQuota, &c.RequestCount, &c.ErrorCount,
		&c.LastError, &c.LastErrorAt, &c.TestedAt, &c.ModelsSyncedAt, &c.Note,
		&c.CreatedAt, &c.UpdatedAt, &c.ModelPrefixes, &c.TestModel, &c.SupportedProtocols,
		&c.ReasoningEffortMapping, &c.StatusCodeMapping,
		&c.AllowAttachments, &c.LockUserAgent, &c.LockedUserAgents,
		&c.KeepaliveEnabled, &c.KeepaliveAt, &c.KeepaliveTarget, &c.KeepaliveOpen,
		&c.KeepaliveSuccess, &c.KeepaliveOpenedAt, &c.Archived)
	if err != nil {
		return nil, mapErr(err)
	}
	if c.APIKey, err = s.cipher.Decrypt(enc); err != nil {
		// A key that cannot be decrypted (rotated ENCRYPTION_KEY) must not take
		// the whole listing down; surface it as empty so the admin can re-enter it.
		c.APIKey = ""
	}
	if c.Groups == nil {
		c.Groups = []string{}
	}
	if c.Models == nil {
		c.Models = []string{}
	}
	if c.ModelPrefixes == nil {
		c.ModelPrefixes = []string{}
	}
	if c.ModelMapping == nil {
		c.ModelMapping = map[string]string{}
	}
	if c.Headers == nil {
		c.Headers = map[string]string{}
	}
	s.openHeaders(c.Headers)
	c.ProxyURL = s.open(c.ProxyURL)
	if c.SupportedProtocols == nil {
		c.SupportedProtocols = []string{}
	}
	if c.LockedUserAgents == nil {
		c.LockedUserAgents = map[string]string{}
	}
	if c.ReasoningEffortMapping == nil {
		c.ReasoningEffortMapping = model.EffortMapping{}
	}
	if c.StatusCodeMapping == nil {
		c.StatusCodeMapping = map[int]int{}
	}
	return &c, nil
}

func (s *Store) CreateChannel(ctx context.Context, c *model.Channel) (*model.Channel, error) {
	enc, err := s.cipher.Encrypt(c.APIKey)
	if err != nil {
		return nil, err
	}
	headers, proxy, err := s.sealedSecrets(c.Headers, c.ProxyURL)
	if err != nil {
		return nil, err
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op after a successful commit

	// Only the three keepalive configuration fields are written. The window
	// state keeps its column defaults, which is also what makes CloneChannel
	// produce a channel with no window running.
	row := tx.QueryRow(ctx, `INSERT INTO channels
		(name, base_url, auth_style, api_key_enc, status, priority, weight, channel_groups,
		 models, model_mapping, headers, timeout_secs, proxy_url, price_ratio, rpm_limit, note,
		 retry_count, retry_backoff_ms,
		 model_prefixes, test_model, supported_protocols,
		 reasoning_effort_mapping,
		 allow_attachments, lock_user_agent, locked_user_agents, keepalive_enabled, keepalive_at, keepalive_target,
		 status_code_mapping)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
		RETURNING `+channelColumns,
		c.Name, strings.TrimRight(c.BaseURL, "/"), c.AuthStyle, enc, c.Status, c.Priority, c.Weight,
		c.Groups, c.Models, c.ModelMapping, headers, c.TimeoutSecs, proxy, c.PriceRatio,
		c.RPMLimit, c.Note, c.RetryCount, c.RetryBackoffMS, c.ModelPrefixes, c.TestModel, normaliseProtocols(c.SupportedProtocols),
		model.NormaliseEffortMapping(c.ReasoningEffortMapping),
		c.AllowAttachments,
		c.LockUserAgent, c.LockedUserAgents,
		c.KeepaliveEnabled, c.KeepaliveAt, c.KeepaliveTarget,
		statusMapping(c.StatusCodeMapping))
	created, err := s.scanChannel(row)
	if err != nil {
		return nil, nameConflict(err, c.Name)
	}
	if err := rebuildAbilities(ctx, tx, created); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return created, nil
}

func (s *Store) UpdateChannel(ctx context.Context, c *model.Channel) (*model.Channel, error) {
	headers, proxy, err := s.sealedSecrets(c.Headers, c.ProxyURL)
	if err != nil {
		return nil, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// An empty api_key means "keep the stored one" so the UI never has to
	// round-trip the secret back to the browser.
	keyClause := "api_key_enc"
	args := []any{c.ID, c.Name, strings.TrimRight(c.BaseURL, "/"), c.AuthStyle, c.Status, c.Priority,
		c.Weight, c.Groups, c.Models, c.ModelMapping, headers, c.TimeoutSecs, proxy,
		c.PriceRatio, c.RPMLimit, c.Note, c.RetryCount, c.RetryBackoffMS, c.ModelPrefixes, c.TestModel,
		normaliseProtocols(c.SupportedProtocols),
		model.NormaliseEffortMapping(c.ReasoningEffortMapping),
		c.AllowAttachments, c.LockUserAgent, c.LockedUserAgents,
		c.KeepaliveEnabled, c.KeepaliveAt, c.KeepaliveTarget,
		statusMapping(c.StatusCodeMapping)}
	if c.APIKey != "" {
		enc, err := s.cipher.Encrypt(c.APIKey)
		if err != nil {
			return nil, err
		}
		args = append(args, enc)
		keyClause = fmt.Sprintf("$%d", len(args))
	}

	// archived in the SET clause reads the row as it was before this statement,
	// which is what lets an archived channel keep its status pinned: the form
	// carries a status field, and the listing hides archived rows, so honouring
	// it here would let an edit send traffic to a channel nobody can see.
	// Unarchiving is the way to make a channel eligible again.
	row := tx.QueryRow(ctx, fmt.Sprintf(`UPDATE channels SET
		name = $2, base_url = $3, auth_style = $4,
		status = CASE WHEN archived THEN %[1]d::smallint ELSE $5::smallint END,
		priority = $6, weight = $7,
		channel_groups = $8, models = $9, model_mapping = $10, headers = $11,
		timeout_secs = $12, proxy_url = $13, price_ratio = $14, rpm_limit = $15, note = $16,
		retry_count = $17, retry_backoff_ms = $18,
		model_prefixes = $19, test_model = $20, supported_protocols = $21,
		reasoning_effort_mapping = $22,
		allow_attachments = $23, lock_user_agent = $24, locked_user_agents = $25,
		keepalive_enabled = $26, keepalive_at = $27, keepalive_target = $28,
		status_code_mapping = $29,
		-- The form carries status, so saving a channel as disabled abandons its
		-- keepalive window here just as the listing toggle does. Progress is
		-- otherwise left alone: saving the form must not reset the counter.
		keepalive_open = CASE WHEN archived OR $5::smallint <> %[2]d::smallint
		                     THEN FALSE ELSE keepalive_open END,
		api_key_enc = %[3]s, updated_at = now()
		WHERE id = $1 RETURNING %[4]s`,
		model.StatusDisabled, model.StatusEnabled, keyClause, channelColumns), args...)

	updated, err := s.scanChannel(row)
	if err != nil {
		return nil, nameConflict(err, c.Name)
	}
	if err := rebuildAbilities(ctx, tx, updated); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return updated, nil
}

// SetChannelRouting writes just the two selection knobs. It exists next to the
// full update because the console edits these from the listing, where it holds
// only a masked credential: sending that row back through UpdateChannel would
// store the mask as the upstream key.
//
// The routing rows carry their own copy of both numbers, so they are updated in
// the same transaction. A targeted UPDATE rather than rebuildAbilities: nothing
// about the (group × model) product changed, and a channel serving hundreds of
// models would otherwise have every routing row deleted and re-inserted to
// change one number.
func (s *Store) SetChannelRouting(ctx context.Context, id int64, priority, weight int32) (*model.Channel, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	row := tx.QueryRow(ctx, `UPDATE channels SET priority = $2, weight = $3, updated_at = now()
		WHERE id = $1 RETURNING `+channelColumns, id, priority, weight)
	updated, err := s.scanChannel(row)
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE abilities SET priority = $2, weight = $3
		WHERE channel_id = $1`, id, priority, weight); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE ability_prefixes SET priority = $2, weight = $3
		WHERE channel_id = $1`, id, priority, weight); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return updated, nil
}

func (s *Store) GetChannel(ctx context.Context, id int64) (*model.Channel, error) {
	return s.scanChannel(s.pool.QueryRow(ctx,
		`SELECT `+channelColumns+` FROM channels WHERE id = $1`, id))
}

// GetChannelByName backs the quick import, which needs to know whether a paste
// describes an upstream that is already configured.
func (s *Store) GetChannelByName(ctx context.Context, name string) (*model.Channel, error) {
	return s.scanChannel(s.pool.QueryRow(ctx,
		`SELECT `+channelColumns+` FROM channels WHERE name = $1`, name))
}

type ChannelFilter struct {
	Keyword string
	Status  int
	Group   string
	Model   string
	// Archived selects on the archive flag: false lists the live channels, true
	// the archived ones, nil every channel. The console asks for one side at a
	// time, so the total it reports matches the rows it shows.
	Archived *bool
	Offset   int
	Limit    int
}

func (s *Store) ListChannels(ctx context.Context, f ChannelFilter) ([]*model.Channel, int64, error) {
	conds := []string{"TRUE"}
	args := []any{}
	add := func(format string, value any) {
		args = append(args, value)
		conds = append(conds, fmt.Sprintf(format, len(args)))
	}
	// One box across everything an operator might remember about a channel:
	// its name, where it points, what it serves, and what it rewrites.
	//
	// strpos rather than LIKE: a search box takes literal text, and a value
	// containing % or _ would otherwise turn into a wildcard pattern.
	//
	// headers is deliberately absent. It carries whatever an operator needed
	// to add for an upstream, which in practice includes credentials, and a
	// field that can be probed a character at a time is a field that can be
	// read a character at a time.
	if kw := strings.TrimSpace(f.Keyword); kw != "" {
		add(`(strpos(lower(name), lower($%[1]d)) > 0
			OR strpos(lower(base_url), lower($%[1]d)) > 0
			OR strpos(lower(auth_style), lower($%[1]d)) > 0
			OR strpos(lower(note), lower($%[1]d)) > 0
			OR strpos(lower(test_model), lower($%[1]d)) > 0
			OR EXISTS (SELECT 1 FROM unnest(models) m WHERE strpos(lower(m), lower($%[1]d)) > 0)
			OR EXISTS (SELECT 1 FROM unnest(model_prefixes) p WHERE strpos(lower(p), lower($%[1]d)) > 0)
			OR EXISTS (SELECT 1 FROM unnest(channel_groups) g WHERE strpos(lower(g), lower($%[1]d)) > 0)
			OR EXISTS (SELECT 1 FROM jsonb_each_text(model_mapping) mm
				WHERE strpos(lower(mm.key), lower($%[1]d)) > 0
				   OR strpos(lower(mm.value), lower($%[1]d)) > 0))`, kw)
	}
	if f.Status > 0 {
		add("status = $%d", f.Status)
	}
	if f.Archived != nil {
		add("archived = $%d", *f.Archived)
	}
	if f.Group != "" {
		add("$%d = ANY(channel_groups)", f.Group)
	}
	// Substring match across both routing sources: typing "claude" should find
	// the channel that serves claude-opus-5 as well as the one that carries a
	// "claude-" prefix, since both are ways of serving that model.
	if kw := strings.TrimSpace(f.Model); kw != "" {
		add(`(EXISTS (SELECT 1 FROM unnest(models) m WHERE strpos(lower(m), lower($%[1]d)) > 0)
			OR EXISTS (SELECT 1 FROM unnest(model_prefixes) p WHERE strpos(lower(p), lower($%[1]d)) > 0))`, kw)
	}
	where := strings.Join(conds, " AND ")

	var total int64
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM channels WHERE `+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}

	args = append(args, f.Limit, f.Offset)
	// Enabled first, then the routing order itself: priority descending, and
	// within one priority the weight that decides how the traffic splits. That
	// makes the list read top-down as "what actually serves requests" — a
	// disabled channel sorted among the live ones by its old priority looks
	// like part of the routing when it is not.
	//
	// id last as the tiebreaker: with a paginated list, two rows equal on every
	// sort key must still have one fixed order, or a row can appear on two
	// pages or on none.
	rows, err := s.pool.Query(ctx, fmt.Sprintf(
		`SELECT %s FROM channels WHERE %s
		ORDER BY (status = %d) DESC, priority DESC, weight DESC, id DESC
		LIMIT $%d OFFSET $%d`,
		channelColumns, where, model.StatusEnabled, len(args)-1, len(args)), args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	channels := []*model.Channel{}
	for rows.Next() {
		c, err := s.scanChannel(rows)
		if err != nil {
			return nil, 0, err
		}
		channels = append(channels, c)
	}
	return channels, total, rows.Err()
}

func (s *Store) DeleteChannel(ctx context.Context, id int64) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM channels WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// SetChannelArchived retires a channel or brings it back.
//
// Archiving disables in the same transaction. The console folds archived rows
// into a collapsed section, and a channel that kept serving traffic from behind
// that fold is the kind of surprise that costs an afternoon to track down.
//
// Unarchiving only clears the flag. The channel returns to the listing still
// disabled, so putting it back into rotation stays a deliberate second step.
func (s *Store) SetChannelArchived(ctx context.Context, id int64, archived bool) (*model.Channel, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// Archiving abandons any keepalive window, for the same reason disabling by
	// hand does: the channel serves nothing, so a counter left standing would
	// misreport what the window achieved. keepalive_opened_at is kept, which is
	// what stops the scheduler reopening the channel for the same day.
	var row pgx.Row
	if archived {
		row = tx.QueryRow(ctx, `UPDATE channels
			SET archived = TRUE, status = $2, keepalive_open = FALSE, updated_at = now()
			WHERE id = $1 RETURNING `+channelColumns, id, int16(model.StatusDisabled))
	} else {
		row = tx.QueryRow(ctx, `UPDATE channels
			SET archived = FALSE, updated_at = now()
			WHERE id = $1 RETURNING `+channelColumns, id)
	}
	updated, err := s.scanChannel(row)
	if err != nil {
		return nil, err
	}

	// Derived from the row that was actually written rather than assumed from
	// the direction: the routing tables carry their own copy of enabled, and
	// this is the only place that knows what the channel now reads as.
	enabled := updated.Routable()
	if _, err := tx.Exec(ctx, `UPDATE abilities SET enabled = $2 WHERE channel_id = $1`,
		id, enabled); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE ability_prefixes SET enabled = $2 WHERE channel_id = $1`,
		id, enabled); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return updated, nil
}

// liveChannelIDs narrows a selection to the channels that are not archived, and
// locks them for the rest of the transaction so a concurrent archive cannot
// land between the check and the write that follows.
func liveChannelIDs(ctx context.Context, tx pgx.Tx, ids []int64) ([]int64, error) {
	rows, err := tx.Query(ctx, `SELECT id FROM channels
		WHERE id = ANY($1) AND NOT archived ORDER BY id FOR UPDATE`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]int64, 0, len(ids))
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

func (s *Store) SetChannelStatus(ctx context.Context, id int64, status int16, reason string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// An archived channel is not in the listing this toggle lives in, so a
	// status change aimed at one is a stale request — refused rather than
	// applied, so nothing gets enabled from behind the fold. Locked for the
	// rest of the transaction so a concurrent archive cannot slip in after.
	var archived bool
	if err := tx.QueryRow(ctx,
		`SELECT archived FROM channels WHERE id = $1 FOR UPDATE`, id).Scan(&archived); err != nil {
		return mapErr(err)
	}
	if archived {
		return fmt.Errorf("%w: channel %d is archived; unarchive it before changing its status",
			ErrInvalidInput, id)
	}

	// Taking a channel out of rotation abandons any keepalive window it was
	// running: a disabled channel serves nothing, so the counter must not keep
	// standing. keepalive_opened_at is left alone, which is what stops the
	// scheduler reopening the channel for the same day.
	if _, err := tx.Exec(ctx, `UPDATE channels
		SET status = $2, last_error = CASE WHEN $3 = '' THEN last_error ELSE $3 END,
		    last_error_at = CASE WHEN $3 = '' THEN last_error_at ELSE now() END,
		    keepalive_open = CASE WHEN $2::smallint <> $4::smallint
		                         THEN FALSE ELSE keepalive_open END,
		    updated_at = now()
		WHERE id = $1`, id, status, reason, int16(model.StatusEnabled)); err != nil {
		return err
	}
	enabled := status == model.StatusEnabled
	if _, err := tx.Exec(ctx, `UPDATE abilities SET enabled = $2 WHERE channel_id = $1`,
		id, enabled); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE ability_prefixes SET enabled = $2 WHERE channel_id = $1`,
		id, enabled); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// SetChannelsStatus flips several channels at once so a bulk console action is
// one atomic change instead of N racing writes.
func (s *Store) SetChannelsStatus(ctx context.Context, ids []int64, status int16) (int64, error) {
	if len(ids) == 0 {
		return 0, nil
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// Archived channels drop out of the selection instead of failing it: they
	// are not in the listing the selection was made from, and one stale id must
	// not cost the operator the other 199 rows they meant to flip.
	eligible, err := liveChannelIDs(ctx, tx, ids)
	if err != nil {
		return 0, err
	}
	if len(eligible) == 0 {
		return 0, nil
	}

	tag, err := tx.Exec(ctx, `UPDATE channels SET status = $2, updated_at = now(),
		keepalive_open = CASE WHEN $2::smallint <> $3::smallint
		                     THEN FALSE ELSE keepalive_open END
		WHERE id = ANY($1)`, eligible, status, int16(model.StatusEnabled))
	if err != nil {
		return 0, err
	}
	enabled := status == model.StatusEnabled
	if _, err := tx.Exec(ctx, `UPDATE abilities SET enabled = $2 WHERE channel_id = ANY($1)`,
		eligible, enabled); err != nil {
		return 0, err
	}
	if _, err := tx.Exec(ctx, `UPDATE ability_prefixes SET enabled = $2 WHERE channel_id = ANY($1)`,
		eligible, enabled); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// DeleteChannels removes several channels; routing rows follow via ON DELETE CASCADE.
func (s *Store) DeleteChannels(ctx context.Context, ids []int64) (int64, error) {
	if len(ids) == 0 {
		return 0, nil
	}
	tag, err := s.pool.Exec(ctx, `DELETE FROM channels WHERE id = ANY($1)`, ids)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// CloneChannel copies an existing channel, credential included. The secret is
// re-encrypted from the decrypted original rather than round-tripped through
// the browser, so cloning never exposes it.
func (s *Store) CloneChannel(ctx context.Context, id int64, name string) (*model.Channel, error) {
	source, err := s.GetChannel(ctx, id)
	if err != nil {
		return nil, err
	}

	clone := *source
	clone.ID = 0
	clone.UsedQuota = 0
	clone.RequestCount = 0
	clone.ErrorCount = 0
	clone.LastError = ""
	clone.LastErrorAt = nil
	clone.TestedAt = nil
	clone.ModelsSyncedAt = nil
	// A clone starts disabled: it still points at the source's credential and
	// would otherwise silently double the traffic share of that upstream.
	clone.Status = model.StatusDisabled
	// Cloning an archived channel is how a retired configuration gets reused, so
	// the copy belongs in the main listing where it can be edited and enabled.
	clone.Archived = false

	clone.Name, err = s.freeChannelName(ctx, strings.TrimSpace(name), source.Name)
	if err != nil {
		return nil, err
	}
	return s.CreateChannel(ctx, &clone)
}

// freeChannelName returns the requested name when it is available, otherwise
// the first free "<source> 副本 N" variant.
func (s *Store) freeChannelName(ctx context.Context, requested, source string) (string, error) {
	if requested != "" {
		taken, err := s.channelNameTaken(ctx, requested)
		if err != nil {
			return "", err
		}
		if taken {
			return "", fmt.Errorf("%w: channel name %q", ErrDuplicate, requested)
		}
		return requested, nil
	}

	for i := 1; i <= 100; i++ {
		candidate := source + " 副本"
		if i > 1 {
			candidate = fmt.Sprintf("%s 副本 %d", source, i)
		}
		taken, err := s.channelNameTaken(ctx, candidate)
		if err != nil {
			return "", err
		}
		if !taken {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("%w: too many copies of %q", ErrDuplicate, source)
}

func (s *Store) channelNameTaken(ctx context.Context, name string) (bool, error) {
	var exists bool
	err := s.pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM channels WHERE name = $1)`, name).Scan(&exists)
	return exists, err
}

// ---------------------------------------------------------- stats & catalogue

// RecordChannelResult updates the per-channel counters after a relayed request.
func (s *Store) RecordChannelResult(ctx context.Context, id int64, cost int64, failure string) {
	s.countAttempt(ctx, id, failure != "")

	if failure == "" {
		// The keepalive counter rides along on the write that was happening
		// anyway. It only advances while a window is open, so a channel an
		// operator enabled by hand never accumulates progress.
		var open bool
		var success, target int32
		if err := s.pool.QueryRow(ctx, `UPDATE channels
			SET request_count = request_count + 1, used_quota = used_quota + $2,
			    keepalive_success = keepalive_success + CASE WHEN keepalive_open THEN 1 ELSE 0 END
			WHERE id = $1
			RETURNING keepalive_open, keepalive_success, keepalive_target`, id, cost).
			Scan(&open, &success, &target); err != nil {
			return
		}
		// Closing is the point of the window, so it happens here rather than in
		// the relay: this is the only place that knows a success just landed.
		// Two concurrent successes can both see the target reached; closing
		// twice is the same as closing once.
		if open && target > 0 && success >= target {
			if err := s.CloseKeepaliveWindow(ctx, id); err != nil {
				slog.Error("keepalive close failed", "channel", id, "error", err)
				return
			}
			slog.Info("keepalive target reached, channel disabled",
				"channel", id, "successes", success, "target", target)
		}
		return
	}
	_, _ = s.pool.Exec(ctx, `UPDATE channels
		SET request_count = request_count + 1, error_count = error_count + 1,
		    last_error = $2, last_error_at = now()
		WHERE id = $1`, id, truncate(failure, 500))
}

func (s *Store) MarkChannelTested(ctx context.Context, id int64, at time.Time, failure string) {
	_, _ = s.pool.Exec(ctx, `UPDATE channels SET tested_at = $2,
		last_error = $3, last_error_at = CASE WHEN $3 = '' THEN last_error_at ELSE now() END
		WHERE id = $1`, id, at, truncate(failure, 500))
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
