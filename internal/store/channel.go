package store

import (
	"context"
	"errors"
	"fmt"
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

const channelColumns = `id, name, type, base_url, api_key_enc, status, priority, weight,
	channel_groups, models, model_mapping, headers, timeout_secs, proxy_url, price_ratio,
	used_quota, request_count, error_count, last_error, last_error_at, tested_at,
	models_synced_at, note, created_at, updated_at, model_prefixes, test_model`

func (s *Store) scanChannel(row pgx.Row) (*model.Channel, error) {
	var c model.Channel
	var enc string
	err := row.Scan(&c.ID, &c.Name, &c.Type, &c.BaseURL, &enc, &c.Status, &c.Priority,
		&c.Weight, &c.Groups, &c.Models, &c.ModelMapping, &c.Headers, &c.TimeoutSecs,
		&c.ProxyURL, &c.PriceRatio, &c.UsedQuota, &c.RequestCount, &c.ErrorCount,
		&c.LastError, &c.LastErrorAt, &c.TestedAt, &c.ModelsSyncedAt, &c.Note,
		&c.CreatedAt, &c.UpdatedAt, &c.ModelPrefixes, &c.TestModel)
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
	return &c, nil
}

func (s *Store) CreateChannel(ctx context.Context, c *model.Channel) (*model.Channel, error) {
	enc, err := s.cipher.Encrypt(c.APIKey)
	if err != nil {
		return nil, err
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op after a successful commit

	row := tx.QueryRow(ctx, `INSERT INTO channels
		(name, type, base_url, api_key_enc, status, priority, weight, channel_groups,
		 models, model_mapping, headers, timeout_secs, proxy_url, price_ratio, note,
		 model_prefixes, test_model)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING `+channelColumns,
		c.Name, c.Type, strings.TrimRight(c.BaseURL, "/"), enc, c.Status, c.Priority, c.Weight,
		c.Groups, c.Models, c.ModelMapping, c.Headers, c.TimeoutSecs, c.ProxyURL, c.PriceRatio, c.Note,
		c.ModelPrefixes, c.TestModel)
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
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// An empty api_key means "keep the stored one" so the UI never has to
	// round-trip the secret back to the browser.
	keyClause := "api_key_enc"
	args := []any{c.ID, c.Name, c.Type, strings.TrimRight(c.BaseURL, "/"), c.Status, c.Priority,
		c.Weight, c.Groups, c.Models, c.ModelMapping, c.Headers, c.TimeoutSecs, c.ProxyURL,
		c.PriceRatio, c.Note, c.ModelPrefixes, c.TestModel}
	if c.APIKey != "" {
		enc, err := s.cipher.Encrypt(c.APIKey)
		if err != nil {
			return nil, err
		}
		args = append(args, enc)
		keyClause = fmt.Sprintf("$%d", len(args))
	}

	row := tx.QueryRow(ctx, fmt.Sprintf(`UPDATE channels SET
		name = $2, type = $3, base_url = $4, status = $5, priority = $6, weight = $7,
		channel_groups = $8, models = $9, model_mapping = $10, headers = $11,
		timeout_secs = $12, proxy_url = $13, price_ratio = $14, note = $15,
		model_prefixes = $16, test_model = $17,
		api_key_enc = %s, updated_at = now()
		WHERE id = $1 RETURNING %s`, keyClause, channelColumns), args...)

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
	Type    string
	Group   string
	Model   string
	Offset  int
	Limit   int
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
			OR strpos(lower(type), lower($%[1]d)) > 0
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
	if f.Type != "" {
		add("type = $%d", f.Type)
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
	rows, err := s.pool.Query(ctx, fmt.Sprintf(
		`SELECT %s FROM channels WHERE %s ORDER BY priority DESC, id DESC LIMIT $%d OFFSET $%d`,
		channelColumns, where, len(args)-1, len(args)), args...)
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

func (s *Store) SetChannelStatus(ctx context.Context, id int64, status int16, reason string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if _, err := tx.Exec(ctx, `UPDATE channels
		SET status = $2, last_error = CASE WHEN $3 = '' THEN last_error ELSE $3 END,
		    last_error_at = CASE WHEN $3 = '' THEN last_error_at ELSE now() END,
		    updated_at = now()
		WHERE id = $1`, id, status, reason); err != nil {
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

	tag, err := tx.Exec(ctx, `UPDATE channels SET status = $2, updated_at = now()
		WHERE id = ANY($1)`, ids, status)
	if err != nil {
		return 0, err
	}
	enabled := status == model.StatusEnabled
	if _, err := tx.Exec(ctx, `UPDATE abilities SET enabled = $2 WHERE channel_id = ANY($1)`,
		ids, enabled); err != nil {
		return 0, err
	}
	if _, err := tx.Exec(ctx, `UPDATE ability_prefixes SET enabled = $2 WHERE channel_id = ANY($1)`,
		ids, enabled); err != nil {
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

// ---------------------------------------------------------------- routing

// Candidates returns every enabled channel able to serve (group, model),
// ordered by priority. Selection among equal priorities happens in the relay.
//
// An exact model row always wins: a channel that explicitly lists the model is
// a deliberate configuration, while a prefix is a catch-all. Prefixes are only
// consulted when nothing matched exactly, so adding one can never steal traffic
// from an existing exact route.
func (s *Store) Candidates(ctx context.Context, group, requestModel string) ([]model.Candidate, error) {
	exact, err := s.queryCandidates(ctx, `SELECT channel_id, priority, weight
		FROM abilities
		WHERE group_name = $1 AND model = $2 AND enabled = TRUE
		ORDER BY priority DESC`, group, requestModel)
	if err != nil || len(exact) > 0 {
		return exact, err
	}

	// starts_with is a literal comparison, so a prefix containing % or _ stays
	// harmless (unlike LIKE). DISTINCT ON keeps a channel from appearing twice
	// when several of its prefixes match the same request.
	return s.queryCandidates(ctx, `SELECT channel_id, priority, weight FROM (
			SELECT DISTINCT ON (channel_id) channel_id, priority, weight, length(prefix) AS depth
			FROM ability_prefixes
			WHERE group_name = $1 AND enabled = TRUE AND starts_with($2, prefix)
			ORDER BY channel_id, length(prefix) DESC
		) matched ORDER BY priority DESC, depth DESC`, group, requestModel)
}

func (s *Store) queryCandidates(ctx context.Context, sql, group, requestModel string) ([]model.Candidate, error) {
	rows, err := s.pool.Query(ctx, sql, group, requestModel)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []model.Candidate{}
	for rows.Next() {
		var c model.Candidate
		if err := rows.Scan(&c.ChannelID, &c.Priority, &c.Weight); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// GroupModels lists every model reachable by a user group, for GET /v1/models.
func (s *Store) GroupModels(ctx context.Context, group string) ([]string, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT DISTINCT model FROM abilities WHERE group_name = $1 AND enabled = TRUE ORDER BY model`,
		group)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	models := []string{}
	for rows.Next() {
		var m string
		if err := rows.Scan(&m); err != nil {
			return nil, err
		}
		models = append(models, m)
	}
	return models, rows.Err()
}

// AllModels lists every model any channel serves, in any group. It backs the
// audit that tells administrators which models are still missing a price.
func (s *Store) AllModels(ctx context.Context) ([]string, error) {
	rows, err := s.pool.Query(ctx, `SELECT DISTINCT model FROM abilities ORDER BY model`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	models := []string{}
	for rows.Next() {
		var m string
		if err := rows.Scan(&m); err != nil {
			return nil, err
		}
		models = append(models, m)
	}
	return models, rows.Err()
}

func rebuildAbilities(ctx context.Context, tx pgx.Tx, c *model.Channel) error {
	if _, err := tx.Exec(ctx, `DELETE FROM abilities WHERE channel_id = $1`, c.ID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM ability_prefixes WHERE channel_id = $1`, c.ID); err != nil {
		return err
	}
	if err := rebuildAbilityPrefixes(ctx, tx, c); err != nil {
		return err
	}
	if len(c.Groups) == 0 || len(c.Models) == 0 {
		return nil
	}

	enabled := c.Status == model.StatusEnabled
	seen := make(map[string]struct{}, len(c.Groups)*len(c.Models))
	rows := make([][]any, 0, len(c.Groups)*len(c.Models))
	for _, g := range c.Groups {
		g = strings.TrimSpace(g)
		if g == "" {
			continue
		}
		for _, m := range c.Models {
			m = strings.TrimSpace(m)
			if m == "" {
				continue
			}
			key := g + "\x00" + m
			if _, dup := seen[key]; dup {
				continue
			}
			seen[key] = struct{}{}
			rows = append(rows, []any{g, m, c.ID, c.Priority, c.Weight, enabled})
		}
	}
	if len(rows) == 0 {
		return nil
	}

	_, err := tx.CopyFrom(ctx,
		pgx.Identifier{"abilities"},
		[]string{"group_name", "model", "channel_id", "priority", "weight", "enabled"},
		pgx.CopyFromRows(rows))
	return err
}

// rebuildAbilityPrefixes expands (group × prefix) for one channel. The caller
// has already cleared the channel's old rows.
func rebuildAbilityPrefixes(ctx context.Context, tx pgx.Tx, c *model.Channel) error {
	if len(c.Groups) == 0 || len(c.ModelPrefixes) == 0 {
		return nil
	}

	enabled := c.Status == model.StatusEnabled
	seen := make(map[string]struct{}, len(c.Groups)*len(c.ModelPrefixes))
	rows := make([][]any, 0, len(c.Groups)*len(c.ModelPrefixes))
	for _, g := range c.Groups {
		g = strings.TrimSpace(g)
		if g == "" {
			continue
		}
		for _, p := range c.ModelPrefixes {
			p = strings.TrimSpace(p)
			if p == "" {
				continue
			}
			key := g + "\x00" + p
			if _, dup := seen[key]; dup {
				continue
			}
			seen[key] = struct{}{}
			rows = append(rows, []any{g, p, c.ID, c.Priority, c.Weight, enabled})
		}
	}
	if len(rows) == 0 {
		return nil
	}

	_, err := tx.CopyFrom(ctx,
		pgx.Identifier{"ability_prefixes"},
		[]string{"group_name", "prefix", "channel_id", "priority", "weight", "enabled"},
		pgx.CopyFromRows(rows))
	return err
}

// RebuildAllAbilities repairs the routing table, e.g. after a manual DB edit.
func (s *Store) RebuildAllAbilities(ctx context.Context) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// Every channel row has to stay still until this commits. Reading the
	// channel list outside the transaction would put the list and the DELETE
	// below on two different snapshots, and a channel written in between would
	// have its rows deleted without being re-inserted — leaving it unroutable,
	// which is the corruption this function exists to repair.
	//
	// Route lookups read abilities and ability_prefixes, not channels, so live
	// traffic is unaffected. The relay does write channels to bump its
	// counters, but that runs detached from the response on its own budget.
	if _, err := tx.Exec(ctx, `LOCK TABLE channels IN SHARE ROW EXCLUSIVE MODE`); err != nil {
		return err
	}

	channels, err := routingSources(ctx, tx)
	if err != nil {
		return err
	}

	// DELETE rather than TRUNCATE: TRUNCATE takes an ACCESS EXCLUSIVE lock that
	// blocks every concurrent route lookup until this transaction commits, so a
	// rebuild would answer live traffic with "model not found". Under MVCC a
	// DELETE lets readers keep seeing the previous routing table until commit.
	if _, err := tx.Exec(ctx, `DELETE FROM abilities`); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM ability_prefixes`); err != nil {
		return err
	}
	for _, c := range channels {
		if err := rebuildAbilities(ctx, tx, c); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// routingSources reads every channel inside the caller's transaction, limited
// to the columns the routing tables are derived from.
//
// Unpaginated on purpose: a rebuild that quietly stopped at some limit would
// leave the table it just reported as repaired missing entries.
func routingSources(ctx context.Context, tx pgx.Tx) ([]*model.Channel, error) {
	rows, err := tx.Query(ctx, `SELECT id, status, priority, weight,
		channel_groups, models, model_prefixes FROM channels ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var channels []*model.Channel
	for rows.Next() {
		var c model.Channel
		if err := rows.Scan(&c.ID, &c.Status, &c.Priority, &c.Weight,
			&c.Groups, &c.Models, &c.ModelPrefixes); err != nil {
			return nil, err
		}
		channels = append(channels, &c)
	}
	return channels, rows.Err()
}

// ---------------------------------------------------------- stats & catalogue

// RecordChannelResult updates the per-channel counters after a relayed request.
func (s *Store) RecordChannelResult(ctx context.Context, id int64, cost int64, failure string) {
	if failure == "" {
		_, _ = s.pool.Exec(ctx, `UPDATE channels
			SET request_count = request_count + 1, used_quota = used_quota + $2
			WHERE id = $1`, id, cost)
		return
	}
	_, _ = s.pool.Exec(ctx, `UPDATE channels
		SET request_count = request_count + 1, error_count = error_count + 1,
		    last_error = $2, last_error_at = now()
		WHERE id = $1`, id, truncate(failure, 500))
}

func (s *Store) ReplaceChannelModels(ctx context.Context, channelID int64, models []string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if _, err := tx.Exec(ctx, `DELETE FROM channel_models WHERE channel_id = $1`, channelID); err != nil {
		return err
	}
	for _, m := range models {
		if _, err := tx.Exec(ctx,
			`INSERT INTO channel_models (channel_id, model) VALUES ($1,$2)
			 ON CONFLICT (channel_id, model) DO UPDATE SET fetched_at = now()`,
			channelID, m); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx,
		`UPDATE channels SET models_synced_at = now() WHERE id = $1`, channelID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) ListChannelModels(ctx context.Context, channelID int64) ([]model.ChannelModel, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT channel_id, model, fetched_at FROM channel_models WHERE channel_id = $1 ORDER BY model`,
		channelID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []model.ChannelModel{}
	for rows.Next() {
		var cm model.ChannelModel
		if err := rows.Scan(&cm.ChannelID, &cm.Model, &cm.FetchedAt); err != nil {
			return nil, err
		}
		out = append(out, cm)
	}
	return out, rows.Err()
}

// SetChannelModels overwrites the served model list and refreshes routing.
func (s *Store) SetChannelModels(ctx context.Context, channelID int64, models []string) (*model.Channel, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	row := tx.QueryRow(ctx, `UPDATE channels SET models = $2, updated_at = now()
		WHERE id = $1 RETURNING `+channelColumns, channelID, models)
	updated, err := s.scanChannel(row)
	if err != nil {
		return nil, err
	}
	if err := rebuildAbilities(ctx, tx, updated); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return updated, nil
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
