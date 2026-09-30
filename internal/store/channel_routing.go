package store

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/faketoken/faketoken/internal/model"
)

// Candidates returns every enabled channel able to serve (group, model),
// ordered by priority. Selection among equal priorities happens in the relay.
//
// An exact model row always wins: a channel that explicitly lists the model is
// a deliberate configuration, while a prefix is a catch-all. Prefixes are only
// consulted when nothing matched exactly, so adding one can never steal traffic
// from an existing exact route.
//
// protocol is the upstream dialect the caller is using ("chat_completions",
// "responses" or "messages"); an empty value skips the filter so callers that
// do not care (the models list, tests) keep seeing every channel.
func (s *Store) Candidates(ctx context.Context, group, requestModel, protocol string) ([]model.Candidate, error) {
	exact, err := s.queryCandidates(ctx, `SELECT channel_id, priority, weight, rpm_limit
		FROM abilities
		WHERE group_name = $1 AND model = $2 AND enabled = TRUE
			AND ($3 = '' OR supported_protocols = '{}' OR $3 = ANY(supported_protocols))
		ORDER BY priority DESC`, group, requestModel, protocol)
	if err != nil || len(exact) > 0 {
		return exact, err
	}

	return s.queryCandidates(ctx, `SELECT channel_id, priority, weight, rpm_limit FROM (
			SELECT DISTINCT ON (channel_id) channel_id, priority, weight, rpm_limit, length(prefix) AS depth
			FROM ability_prefixes
			WHERE group_name = $1 AND enabled = TRUE AND starts_with($2, prefix)
				AND ($3 = '' OR supported_protocols = '{}' OR $3 = ANY(supported_protocols))
			ORDER BY channel_id, length(prefix) DESC
		) matched ORDER BY priority DESC, depth DESC`, group, requestModel, protocol)
}

func (s *Store) queryCandidates(ctx context.Context, sql, group, requestModel, protocol string) ([]model.Candidate, error) {
	rows, err := s.pool.Query(ctx, sql, group, requestModel, protocol)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []model.Candidate{}
	for rows.Next() {
		var c model.Candidate
		if err := rows.Scan(&c.ChannelID, &c.Priority, &c.Weight, &c.RPMLimit); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// PinnedCandidate asks whether one channel would serve the model on its own,
// by exact name or prefix, in any of its groups. It is Candidates without the
// ranking: a pinned test must reach a prefix channel even though an exact
// match elsewhere would always outrank it. ErrNotFound when it would not.
func (s *Store) PinnedCandidate(ctx context.Context, channelID int64, requestModel, protocol string) (*model.Candidate, error) {
	var c model.Candidate
	err := s.pool.QueryRow(ctx, `SELECT channel_id, priority, weight, rpm_limit FROM (
			SELECT channel_id, priority, weight, rpm_limit, supported_protocols
			FROM abilities WHERE channel_id = $1 AND model = $2 AND enabled = TRUE
			UNION ALL
			SELECT channel_id, priority, weight, rpm_limit, supported_protocols
			FROM ability_prefixes WHERE channel_id = $1 AND starts_with($2, prefix) AND enabled = TRUE
		) served
		WHERE $3 = '' OR supported_protocols = '{}' OR $3 = ANY(supported_protocols)
		LIMIT 1`, channelID, requestModel, protocol).
		Scan(&c.ChannelID, &c.Priority, &c.Weight, &c.RPMLimit)
	if err != nil {
		return nil, mapErr(err)
	}
	return &c, nil
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
	// A model_mapping key is an alias the caller can request by; the channel
	// has to be routable under that name so the mapping actually takes effect.
	models := make([]string, 0, len(c.Models)+len(c.ModelMapping))
	models = append(models, c.Models...)
	for m := range c.ModelMapping {
		models = append(models, m)
	}

	if len(c.Groups) == 0 || len(models) == 0 {
		return nil
	}

	enabled := c.Routable()
	seen := make(map[string]struct{}, len(c.Groups)*len(models))
	rows := make([][]any, 0, len(c.Groups)*len(models))
	protocols := normaliseProtocols(c.SupportedProtocols)
	for _, g := range c.Groups {
		g = strings.TrimSpace(g)
		if g == "" {
			continue
		}
		for _, m := range models {
			m = strings.TrimSpace(m)
			if m == "" {
				continue
			}
			key := g + "\x00" + m
			if _, dup := seen[key]; dup {
				continue
			}
			seen[key] = struct{}{}
			rows = append(rows, []any{g, m, c.ID, c.Priority, c.Weight, enabled, c.RPMLimit,
				protocols})
		}
	}
	if len(rows) == 0 {
		return nil
	}

	_, err := tx.CopyFrom(ctx,
		pgx.Identifier{"abilities"},
		[]string{"group_name", "model", "channel_id", "priority", "weight", "enabled", "rpm_limit", "supported_protocols"},
		pgx.CopyFromRows(rows))
	return err
}

// rebuildAbilityPrefixes expands (group × prefix) for one channel. The caller
// has already cleared the channel's old rows.
func rebuildAbilityPrefixes(ctx context.Context, tx pgx.Tx, c *model.Channel) error {
	if len(c.Groups) == 0 || len(c.ModelPrefixes) == 0 {
		return nil
	}

	enabled := c.Routable()
	seen := make(map[string]struct{}, len(c.Groups)*len(c.ModelPrefixes))
	rows := make([][]any, 0, len(c.Groups)*len(c.ModelPrefixes))
	protocols := normaliseProtocols(c.SupportedProtocols)
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
			rows = append(rows, []any{g, p, c.ID, c.Priority, c.Weight, enabled, c.RPMLimit,
				protocols})
		}
	}
	if len(rows) == 0 {
		return nil
	}

	_, err := tx.CopyFrom(ctx,
		pgx.Identifier{"ability_prefixes"},
		[]string{"group_name", "prefix", "channel_id", "priority", "weight", "enabled", "rpm_limit", "supported_protocols"},
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
		channel_groups, models, model_prefixes, model_mapping, rpm_limit,
		supported_protocols, archived
		FROM channels ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var channels []*model.Channel
	for rows.Next() {
		var c model.Channel
		if err := rows.Scan(&c.ID, &c.Status, &c.Priority, &c.Weight,
			&c.Groups, &c.Models, &c.ModelPrefixes, &c.ModelMapping, &c.RPMLimit,
			&c.SupportedProtocols, &c.Archived); err != nil {
			return nil, err
		}
		channels = append(channels, &c)
	}
	return channels, rows.Err()
}
