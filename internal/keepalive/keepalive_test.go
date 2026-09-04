package keepalive

import (
	"testing"
	"time"

	"github.com/faketoken/faketoken/internal/model"
)

// A fixed zone, so the test says what it means regardless of where it runs. The
// scheduler itself reads time.Local, which the deployment sets via TZ.
var zone = time.FixedZone("+08", 8*60*60)

func at(day, hour, minute int) time.Time {
	return time.Date(2026, time.August, day, hour, minute, 0, 0, zone)
}

func channel(opts ...func(*model.Channel)) *model.Channel {
	ch := &model.Channel{
		ID: 1,
		// Disabled is the state a window exists to lift; an enabled channel is
		// left alone, which the cases below cover explicitly.
		Status:           model.StatusDisabled,
		KeepaliveEnabled: true,
		KeepaliveAt:      "03:00",
		KeepaliveTarget:  5,
	}
	for _, opt := range opts {
		opt(ch)
	}
	return ch
}

func openedAt(t time.Time) func(*model.Channel) {
	return func(ch *model.Channel) { ch.KeepaliveOpenedAt = &t }
}

func enabled(ch *model.Channel) { ch.Status = model.StatusEnabled }

func TestDue(t *testing.T) {
	for _, tc := range []struct {
		name string
		ch   *model.Channel
		now  time.Time
		want bool
	}{
		{
			name: "before the trigger",
			ch:   channel(),
			now:  at(20, 2, 59),
			want: false,
		},
		{
			name: "at the trigger, never opened",
			ch:   channel(),
			now:  at(20, 3, 0),
			want: true,
		},
		{
			// The tick is a minute wide, so landing exactly on HH:MM cannot be
			// the condition.
			name: "a minute late",
			ch:   channel(),
			now:  at(20, 3, 1),
			want: true,
		},
		{
			name: "already opened today",
			ch:   channel(openedAt(at(20, 3, 0))),
			now:  at(20, 9, 0),
			want: false,
		},
		{
			// Closed after reaching its target; must not reopen the same day.
			name: "opened and closed today",
			ch: channel(openedAt(at(20, 3, 0)), func(ch *model.Channel) {
				ch.KeepaliveOpen = false
				ch.KeepaliveSuccess = 5
			}),
			now:  at(20, 23, 59),
			want: false,
		},
		{
			name: "opened yesterday",
			ch:   channel(openedAt(at(19, 3, 0))),
			now:  at(20, 3, 0),
			want: true,
		},
		{
			// The server was down at 03:00 and came up at 05:00. Keeping the
			// account alive late beats skipping the day.
			name: "missed window is caught up",
			ch:   channel(openedAt(at(19, 3, 0))),
			now:  at(20, 5, 0),
			want: true,
		},
		{
			// Yesterday's late catch-up must not count as today's run.
			name: "yesterday's catch-up does not satisfy today",
			ch:   channel(openedAt(at(19, 22, 0))),
			now:  at(20, 3, 0),
			want: true,
		},
		{
			// Already carrying traffic, so there is nothing to keep alive. The
			// window would otherwise end by disabling a channel that was on.
			name: "enabled at the trigger",
			ch:   channel(enabled),
			now:  at(20, 3, 0),
			want: false,
		},
		{
			// Switched off hours after the trigger passed: the day's window has
			// not run, so it opens now rather than waiting for tomorrow.
			name: "switched off later the same day",
			ch:   channel(openedAt(at(19, 3, 0))),
			now:  at(20, 10, 0),
			want: true,
		},
		{
			// Same day, but the window already ran and closed at its target.
			// One window a day still holds, however the status got here.
			name: "enabled by hand after today's window, then switched off",
			ch:   channel(openedAt(at(20, 3, 0))),
			now:  at(20, 10, 0),
			want: false,
		},
		{
			name: "keepalive off",
			ch:   channel(func(ch *model.Channel) { ch.KeepaliveEnabled = false }),
			now:  at(20, 3, 0),
			want: false,
		},
		{
			name: "no target",
			ch:   channel(func(ch *model.Channel) { ch.KeepaliveTarget = 0 }),
			now:  at(20, 3, 0),
			want: false,
		},
		{
			name: "unset time",
			ch:   channel(func(ch *model.Channel) { ch.KeepaliveAt = "" }),
			now:  at(20, 3, 0),
			want: false,
		},
		{
			name: "unparseable time",
			ch:   channel(func(ch *model.Channel) { ch.KeepaliveAt = "3pm" }),
			now:  at(20, 3, 0),
			want: false,
		},
		{
			name: "midnight schedule",
			ch:   channel(func(ch *model.Channel) { ch.KeepaliveAt = "00:00" }),
			now:  at(20, 0, 0),
			want: true,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := Due(tc.ch, tc.now); got != tc.want {
				t.Fatalf("Due(%s at %s) = %v, want %v",
					tc.ch.KeepaliveAt, tc.now.Format(time.RFC3339), got, tc.want)
			}
		})
	}
}

func TestDueIgnoresNilChannel(t *testing.T) {
	if Due(nil, at(20, 3, 0)) {
		t.Fatal("a nil channel is never due")
	}
}

func TestParseAt(t *testing.T) {
	for _, tc := range []struct {
		in           string
		hour, minute int
		ok           bool
	}{
		{in: "03:00", hour: 3, minute: 0, ok: true},
		{in: "23:59", hour: 23, minute: 59, ok: true},
		{in: "00:00", ok: true},
		// Go's parser does not require the leading zero, and there is no reason
		// to be stricter than it: the picker always emits "HH:MM", and an
		// operator typing "3:00" into the API means three in the morning.
		{in: "3:00", hour: 3, minute: 0, ok: true},
		{in: "24:00"},
		{in: "03:60"},
		{in: ""},
		{in: "0300"},
		{in: "3pm"},
		{in: "03:00:00"},
	} {
		hour, minute, ok := ParseAt(tc.in)
		if ok != tc.ok || hour != tc.hour || minute != tc.minute {
			t.Fatalf("ParseAt(%q) = %d, %d, %v; want %d, %d, %v",
				tc.in, hour, minute, ok, tc.hour, tc.minute, tc.ok)
		}
	}
}

func TestNextRun(t *testing.T) {
	// Before today's trigger: today.
	if next, ok := NextRun(channel(), at(20, 1, 0)); !ok || !next.Equal(at(20, 3, 0)) {
		t.Fatalf("next run before the trigger = %v (%v), want %v", next, ok, at(20, 3, 0))
	}
	// Already ran today: tomorrow.
	if next, ok := NextRun(channel(openedAt(at(20, 3, 0))), at(20, 9, 0)); !ok ||
		!next.Equal(at(21, 3, 0)) {
		t.Fatalf("next run after today's window = %v (%v), want %v", next, ok, at(21, 3, 0))
	}
	// Due right now (the missed-window case): now.
	now := at(20, 5, 0)
	if next, ok := NextRun(channel(openedAt(at(19, 3, 0))), now); !ok || !next.Equal(now) {
		t.Fatalf("next run while due = %v (%v), want %v", next, ok, now)
	}
	// Enabled past today's trigger: the log names tomorrow's trigger, the
	// earliest instant a window could open on its own.
	if next, ok := NextRun(channel(enabled), at(20, 5, 0)); !ok || !next.Equal(at(21, 3, 0)) {
		t.Fatalf("next run for an enabled channel = %v (%v), want %v", next, ok, at(21, 3, 0))
	}
	if _, ok := NextRun(channel(func(ch *model.Channel) { ch.KeepaliveEnabled = false }),
		at(20, 1, 0)); ok {
		t.Fatal("a channel without keepalive has no next run")
	}
}
