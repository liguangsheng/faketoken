// Package keepalive opens channels on a daily schedule so an upstream account
// that is reclaimed when idle keeps seeing traffic.
//
// The window is closed by the store, not here: the counter advances inside the
// same write that records a relayed request, and only that write knows when a
// success just took the channel to its target. This package is the other half —
// deciding when a window is due and opening it.
package keepalive

import (
	"context"
	"log/slog"
	"time"

	"github.com/faketoken/faketoken/internal/model"
	"github.com/faketoken/faketoken/internal/store"
)

// Scheduler opens due keepalive windows. One tick a minute is enough: the
// schedule is configured to the minute.
type Scheduler struct {
	st *store.Store
}

func New(st *store.Store) *Scheduler { return &Scheduler{st: st} }

// Start runs the scheduler until ctx is cancelled, following the same shape as
// Pricer.StartRefresh. It ticks once immediately so a restart that happened
// after the trigger time does not wait a full interval to catch up.
func (s *Scheduler) Start(ctx context.Context, every time.Duration) {
	go func() {
		ticker := time.NewTicker(every)
		defer ticker.Stop()
		s.runOnce(ctx)
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				s.runOnce(ctx)
			}
		}
	}()
}

func (s *Scheduler) runOnce(ctx context.Context) {
	channels, err := s.st.ListKeepaliveChannels(ctx)
	if err != nil {
		slog.Warn("keepalive scan failed", "error", err)
		return
	}
	now := time.Now()
	for _, ch := range channels {
		if !Due(ch, now) {
			continue
		}
		if err := s.st.OpenKeepaliveWindow(ctx, ch.ID); err != nil {
			slog.Error("keepalive open failed", "channel", ch.ID, "error", err)
			continue
		}
		slog.Info("keepalive window opened", "channel", ch.ID, "name", ch.Name,
			"at", ch.KeepaliveAt, "target", ch.KeepaliveTarget)
	}
}

// ParseAt reads the "HH:MM" schedule. The second return reports whether the
// value is usable at all; a channel with an unparseable time is never opened,
// which is why the API layer rejects one at write time.
func ParseAt(value string) (hour, minute int, ok bool) {
	t, err := time.Parse("15:04", value)
	if err != nil {
		return 0, 0, false
	}
	return t.Hour(), t.Minute(), true
}

// Due reports whether the channel's window should be opened now.
//
// The comparison is against today's trigger instant rather than "is it exactly
// HH:MM": a tick can be late, and a server that was down at 03:00 and came up
// at 05:00 should still keep the account alive that day rather than skip it.
// KeepaliveOpenedAt is what makes that a single catch-up instead of an open
// every minute for the rest of the day.
//
// now is in the server's local zone, which is also how the operator's "HH:MM"
// is meant — see the TZ setting on the server service in docker-compose.yml.
func Due(ch *model.Channel, now time.Time) bool {
	if ch == nil || !ch.KeepaliveEnabled || ch.KeepaliveTarget < 1 {
		return false
	}
	hour, minute, ok := ParseAt(ch.KeepaliveAt)
	if !ok {
		return false
	}
	trigger := time.Date(now.Year(), now.Month(), now.Day(), hour, minute, 0, 0, now.Location())
	if now.Before(trigger) {
		return false
	}
	// Already opened for today's trigger, whether that window is still counting
	// or has since closed.
	if ch.KeepaliveOpenedAt != nil && !ch.KeepaliveOpenedAt.Before(trigger) {
		return false
	}
	return true
}

// NextRun is the instant the channel's next window opens, for the startup log
// that makes a timezone mistake visible before it costs a day.
func NextRun(ch *model.Channel, now time.Time) (time.Time, bool) {
	if ch == nil || !ch.KeepaliveEnabled || ch.KeepaliveTarget < 1 {
		return time.Time{}, false
	}
	hour, minute, ok := ParseAt(ch.KeepaliveAt)
	if !ok {
		return time.Time{}, false
	}
	if Due(ch, now) {
		return now, true
	}
	trigger := time.Date(now.Year(), now.Month(), now.Day(), hour, minute, 0, 0, now.Location())
	if !now.Before(trigger) {
		trigger = trigger.AddDate(0, 0, 1)
	}
	return trigger, true
}
