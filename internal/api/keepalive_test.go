package api

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/faketoken/faketoken/internal/model"
)

// The point of the feature: an upstream that reclaims an idle account gets a
// few real requests a day and is then taken back out of rotation. The count is
// asserted after every single request, not just at the end — a channel that
// closes one request early or late is a different feature.
func TestKeepaliveClosesTheChannelExactlyAtItsTarget(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	id := h.createChannel(channelInput{
		Name: "keepalive", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
		KeepaliveEnabled: true, KeepaliveAt: "03:00", KeepaliveTarget: 3,
	})
	// A keepalive channel is configured while disabled; the scheduler is what
	// opens it. Opening it directly keeps the test off the wall clock.
	if err := h.store.OpenKeepaliveWindow(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	if ch := h.channel(id); ch.Status != model.StatusEnabled || !ch.KeepaliveOpen ||
		ch.KeepaliveSuccess != 0 {
		t.Fatalf("after opening: status %d, open %v, success %d",
			ch.Status, ch.KeepaliveOpen, ch.KeepaliveSuccess)
	}

	key := h.createKey()
	body := `{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}`

	for want := int32(1); want <= 3; want++ {
		resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("request %d: HTTP %d", want, resp.StatusCode)
		}
		// Still open below the target, closed on reaching it.
		wantStatus, wantOpen := int16(model.StatusEnabled), true
		if want == 3 {
			wantStatus, wantOpen = model.StatusDisabled, false
		}
		// The counter and the close are two statements, so the counter can
		// read 3/3 an instant before the window shuts. Wait for the state the
		// assertion is about, not for the step before it.
		waitFor(t, func() bool {
			ch := h.channel(id)
			return ch.KeepaliveSuccess >= want && ch.KeepaliveOpen == wantOpen
		}, waiting(fmt.Sprintf("keepalive to reach %d/3 (open=%v)", want, wantOpen)))

		ch := h.channel(id)
		if ch.KeepaliveSuccess != want {
			t.Fatalf("after %d successful requests the counter is %d", want, ch.KeepaliveSuccess)
		}
		if ch.Status != wantStatus || ch.KeepaliveOpen != wantOpen {
			t.Fatalf("after %d/3 requests: status %d (want %d), open %v (want %v)",
				want, ch.Status, wantStatus, ch.KeepaliveOpen, wantOpen)
		}
	}

	// Closed means out of rotation for real: selection reads the routing tables,
	// not channels.status, so a channel disabled without syncing them would keep
	// serving traffic while the console showed it as off.
	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, body)
	resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		t.Fatal("a closed keepalive channel still served a request")
	}

	// The window stamp survives closing: it is what stops the scheduler
	// reopening the channel for the same day.
	if h.channel(id).KeepaliveOpenedAt == nil {
		t.Fatal("keepalive_opened_at was cleared on close")
	}
}

// Only successes count. An upstream erroring its way through the window would
// otherwise satisfy a keepalive that never actually kept anything alive.
func TestKeepaliveIgnoresFailedRequests(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":{"message":"nope"}}`))
	})
	id := h.createChannel(channelInput{
		Name: "keepalive-failing", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
		KeepaliveEnabled: true, KeepaliveAt: "03:00", KeepaliveTarget: 1,
	})
	if err := h.store.OpenKeepaliveWindow(context.Background(), id); err != nil {
		t.Fatal(err)
	}

	key := h.createKey()
	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
		`{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}`)
	resp.Body.Close()

	// 400 is passed straight through rather than retried, so the attempt is
	// certainly recorded by the time the error count moves.
	waitFor(t, func() bool { return h.channel(id).ErrorCount > 0 },
		waiting("the failed attempt to be recorded"))

	ch := h.channel(id)
	if ch.KeepaliveSuccess != 0 {
		t.Fatalf("a failed request advanced the keepalive counter to %d", ch.KeepaliveSuccess)
	}
	if ch.Status != model.StatusEnabled || !ch.KeepaliveOpen {
		t.Fatalf("the window closed on a failure: status %d, open %v", ch.Status, ch.KeepaliveOpen)
	}
}

// Turning the channel off by hand abandons the window. Otherwise the counter
// would keep standing against a channel that serves nothing, and the operator's
// decision would be undone by the next success that trickled in.
func TestKeepaliveWindowIsAbandonedWhenDisabledByHand(t *testing.T) {
	h := newHarness(t)

	id := h.createChannel(channelInput{
		Name: "keepalive-manual", BaseURL: "https://unused.test", APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
		KeepaliveEnabled: true, KeepaliveAt: "03:00", KeepaliveTarget: 5,
	})
	ctx := context.Background()

	for _, tc := range []struct {
		name string
		// Takes the subtest's own t: these closures are built before t.Run, so
		// a captured t would be the parent, and failing a parent from inside a
		// subtest is not allowed.
		disable func(t *testing.T)
	}{
		{
			name: "the listing toggle",
			disable: func(t *testing.T) {
				resp := h.do(http.MethodPut, fmt.Sprintf("/api/admin/channels/%d/status", id),
					h.admin, map[string]any{"status": model.StatusDisabled}, nil)
				resp.Body.Close()
				if resp.StatusCode != http.StatusOK {
					t.Fatalf("disable via the status endpoint: HTTP %d", resp.StatusCode)
				}
			},
		},
		{
			// The edit form submits status alongside everything else, so it is a
			// second, easily missed way to disable a channel.
			name: "saving the edit form as disabled",
			disable: func(t *testing.T) {
				resp := h.do(http.MethodPut, fmt.Sprintf("/api/admin/channels/%d", id), h.admin,
					channelInput{
						Name: "keepalive-manual", BaseURL: "https://unused.test",
						Models: []string{"gpt-4o"}, Groups: []string{"default"},
						Status:           model.StatusDisabled,
						KeepaliveEnabled: true, KeepaliveAt: "03:00", KeepaliveTarget: 5,
					}, nil)
				resp.Body.Close()
				if resp.StatusCode != http.StatusOK {
					t.Fatalf("disable via the edit form: HTTP %d", resp.StatusCode)
				}
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := h.store.OpenKeepaliveWindow(ctx, id); err != nil {
				t.Fatal(err)
			}
			if ch := h.channel(id); !ch.KeepaliveOpen {
				t.Fatal("the window did not open")
			}

			tc.disable(t)

			ch := h.channel(id)
			if ch.Status != model.StatusDisabled {
				t.Fatalf("status = %d, want disabled", ch.Status)
			}
			if ch.KeepaliveOpen {
				t.Fatal("the keepalive window survived a manual disable")
			}
			// Kept, so the scheduler treats today's window as already run.
			if ch.KeepaliveOpenedAt == nil {
				t.Fatal("keepalive_opened_at was cleared")
			}
		})
	}
}

// The configuration is refused rather than accepted and silently ignored: a
// channel that claims to be kept alive and never opens is worse than an error.
func TestKeepaliveConfigurationIsValidated(t *testing.T) {
	h := newHarness(t)

	for _, tc := range []struct {
		name string
		in   channelInput
		want int
	}{
		{
			name: "no time",
			in:   channelInput{KeepaliveEnabled: true, KeepaliveTarget: 3},
			want: http.StatusBadRequest,
		},
		{
			name: "unparseable time",
			in:   channelInput{KeepaliveEnabled: true, KeepaliveAt: "3pm", KeepaliveTarget: 3},
			want: http.StatusBadRequest,
		},
		{
			name: "hour out of range",
			in:   channelInput{KeepaliveEnabled: true, KeepaliveAt: "25:00", KeepaliveTarget: 3},
			want: http.StatusBadRequest,
		},
		{
			name: "zero target",
			in:   channelInput{KeepaliveEnabled: true, KeepaliveAt: "03:00", KeepaliveTarget: 0},
			want: http.StatusBadRequest,
		},
		{
			name: "valid",
			in:   channelInput{KeepaliveEnabled: true, KeepaliveAt: "03:00", KeepaliveTarget: 1},
			want: http.StatusCreated,
		},
		{
			// The schedule fields are only read when keepalive is on, so junk
			// left behind by an operator switching it off must not block a save.
			name: "off, so the schedule is not checked",
			in:   channelInput{KeepaliveEnabled: false, KeepaliveAt: "", KeepaliveTarget: 0},
			want: http.StatusCreated,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in := tc.in
			in.Name = "keepalive-" + strings.ReplaceAll(tc.name, " ", "-")
			in.BaseURL = "https://unused.test"
			in.APIKey = "k"
			in.Models = []string{"gpt-4o"}
			resp := h.do(http.MethodPost, "/api/admin/channels", h.admin, in, nil)
			resp.Body.Close()
			if resp.StatusCode != tc.want {
				t.Fatalf("HTTP %d, want %d", resp.StatusCode, tc.want)
			}
		})
	}
}

// Saving the form must not disturb a window that is counting: the operator
// edited a note, not the keepalive progress.
func TestKeepaliveProgressSurvivesAnEdit(t *testing.T) {
	h := newHarness(t)

	id := h.createChannel(channelInput{
		Name: "keepalive-edit", BaseURL: "https://unused.test", APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
		KeepaliveEnabled: true, KeepaliveAt: "03:00", KeepaliveTarget: 5,
	})
	ctx := context.Background()
	if err := h.store.OpenKeepaliveWindow(ctx, id); err != nil {
		t.Fatal(err)
	}
	// Two successes into the window.
	h.store.RecordChannelResult(ctx, id, 0, "")
	h.store.RecordChannelResult(ctx, id, 0, "")
	if got := h.channel(id).KeepaliveSuccess; got != 2 {
		t.Fatalf("keepalive success = %d, want 2", got)
	}

	resp := h.do(http.MethodPut, fmt.Sprintf("/api/admin/channels/%d", id), h.admin,
		channelInput{
			Name: "keepalive-edit", BaseURL: "https://unused.test",
			Models: []string{"gpt-4o"}, Groups: []string{"default"},
			Status: model.StatusEnabled, Note: "edited",
			KeepaliveEnabled: true, KeepaliveAt: "04:30", KeepaliveTarget: 5,
		}, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("edit: HTTP %d", resp.StatusCode)
	}

	ch := h.channel(id)
	if ch.KeepaliveSuccess != 2 || !ch.KeepaliveOpen {
		t.Fatalf("the edit reset the window: success %d, open %v",
			ch.KeepaliveSuccess, ch.KeepaliveOpen)
	}
	if ch.KeepaliveAt != "04:30" {
		t.Fatalf("keepalive_at = %q, want 04:30", ch.KeepaliveAt)
	}
}

// A clone points at the same upstream and starts disabled; it must not also
// inherit a window that is mid-count.
func TestKeepaliveCloneStartsWithNoWindow(t *testing.T) {
	h := newHarness(t)

	id := h.createChannel(channelInput{
		Name: "keepalive-source", BaseURL: "https://unused.test", APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
		KeepaliveEnabled: true, KeepaliveAt: "03:00", KeepaliveTarget: 5,
	})
	ctx := context.Background()
	if err := h.store.OpenKeepaliveWindow(ctx, id); err != nil {
		t.Fatal(err)
	}
	h.store.RecordChannelResult(ctx, id, 0, "")

	var clone model.Channel
	resp := h.do(http.MethodPost, fmt.Sprintf("/api/admin/channels/%d/clone", id), h.admin,
		map[string]string{"name": "keepalive-clone"}, &clone)
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("clone: HTTP %d", resp.StatusCode)
	}

	// The configuration is worth inheriting; the running window is not.
	if !clone.KeepaliveEnabled || clone.KeepaliveAt != "03:00" || clone.KeepaliveTarget != 5 {
		t.Fatalf("the clone lost its keepalive configuration: %+v", clone)
	}
	if clone.KeepaliveOpen || clone.KeepaliveSuccess != 0 || clone.KeepaliveOpenedAt != nil {
		t.Fatalf("the clone inherited a running window: open %v, success %d, opened %v",
			clone.KeepaliveOpen, clone.KeepaliveSuccess, clone.KeepaliveOpenedAt)
	}
}

// Keepalive exists to prove an idle account is still being used, and an error
// delivered inside a 200 proves nothing. It used to count, because the counter
// advances on every request the relay does not call a failure.
func TestKeepaliveIgnoresErrorsInsideAStream(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, `data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`+"\n\n")
		w.(http.Flusher).Flush()
	})
	id := h.createChannel(channelInput{
		Name: "keepalive-stream-error", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
		KeepaliveEnabled: true, KeepaliveAt: "03:00", KeepaliveTarget: 1,
	})
	if err := h.store.OpenKeepaliveWindow(context.Background(), id); err != nil {
		t.Fatal(err)
	}

	key := h.createKey()
	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
		`{"model":"gpt-4o","stream":true,"messages":[{"role":"user","content":"hi"}]}`)
	resp.Body.Close()

	waitFor(t, func() bool { return h.channel(id).ErrorCount > 0 },
		waiting("the in-stream failure to be recorded"))

	ch := h.channel(id)
	if ch.KeepaliveSuccess != 0 {
		t.Fatalf("an in-stream failure advanced the keepalive counter to %d", ch.KeepaliveSuccess)
	}
	if ch.Status != model.StatusEnabled || !ch.KeepaliveOpen {
		t.Fatalf("the window closed on a failure: status %d, open %v", ch.Status, ch.KeepaliveOpen)
	}
}

// Keepalive exists to enable a channel on a schedule, which is exactly what
// archiving forbids. The scheduler must not undo an archive overnight.
func TestKeepaliveSkipsArchivedChannels(t *testing.T) {
	h := newHarness(t)

	id := h.createChannel(channelInput{
		Name: "kept-alive", Type: "openai", BaseURL: "https://example.invalid", APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
		KeepaliveEnabled: true, KeepaliveAt: "03:00", KeepaliveTarget: 3,
	})
	h.archive(id, true)

	due, err := h.store.ListKeepaliveChannels(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, channel := range due {
		if channel.ID == id {
			t.Fatal("the scheduler still considers an archived channel for keepalive")
		}
	}
}
