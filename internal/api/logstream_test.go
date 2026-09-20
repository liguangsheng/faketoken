package api

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/faketoken/faketoken/internal/model"
)

// A live entry must be appended exactly when a reload would have listed it;
// otherwise the feed contradicts the search that is on screen.
func TestLogStreamHonoursTheKeyword(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "streamy", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	matching, closeMatching := h.openStream(t, "/api/admin/logs/stream?keyword=streamy", h.admin)
	defer closeMatching()
	other, closeOther := h.openStream(t, "/api/admin/logs/stream?keyword=nothing-like-this", h.admin)
	defer closeOther()

	relayed := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"gpt-4o"}`)
	_, _ = io.Copy(io.Discard, relayed.Body)
	relayed.Body.Close()

	select {
	case entry := <-matching:
		if entry == nil || entry.ChannelName != "streamy" {
			t.Fatalf("unexpected entry: %+v", entry)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("a matching entry never arrived")
	}

	select {
	case entry := <-other:
		t.Fatalf("an entry that does not match the search was pushed: %+v", entry)
	case <-time.After(time.Second):
		// Correct: the feed agrees with the search.
	}
}

// openStream connects to an SSE endpoint and returns a channel of decoded log
// events, mirroring what the console's reader does.
// streamEvent is one event as a console sees it.
type streamEvent struct {
	// name is the SSE event: "log" for a settled row, "inflight" for a call that
	// is still running, "inflight_sync" for the periodic full statement of the
	// running set.
	name string
	// key ties a call's in-flight announcements to the row that ends it.
	key   string
	entry *model.RequestLog
	// calls is what an inflight_sync named.
	calls []streamEvent
}

// openFeed reads the raw event feed, every event kind included.
func (h *harness) openFeed(t *testing.T, path, token string) (<-chan streamEvent, func()) {
	t.Helper()

	req, err := http.NewRequest(http.MethodGet, h.server.URL+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := h.server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		t.Fatalf("stream %s: HTTP %d", path, resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, "text/event-stream") {
		resp.Body.Close()
		t.Fatalf("Content-Type = %q", ct)
	}

	events := make(chan streamEvent, 64)
	go func() {
		defer close(events)
		scanner := bufio.NewScanner(resp.Body)
		scanner.Buffer(make([]byte, 0, 64<<10), 1<<20)

		name, data := "", ""
		for scanner.Scan() {
			line := scanner.Text()
			if value, found := strings.CutPrefix(line, "event: "); found {
				name = value
				continue
			}
			if value, found := strings.CutPrefix(line, "data: "); found {
				data = value
				continue
			}
			// A blank line closes the frame; anything else is a comment, which
			// is what the keepalive rides on.
			if line != "" || data == "" {
				continue
			}

			if name == "inflight_sync" {
				var payload struct {
					Calls []struct {
						Key   string            `json:"key"`
						Entry *model.RequestLog `json:"entry"`
					} `json:"calls"`
				}
				if json.Unmarshal([]byte(data), &payload) == nil {
					sync := streamEvent{name: name}
					for _, call := range payload.Calls {
						sync.calls = append(sync.calls,
							streamEvent{name: "inflight", key: call.Key, entry: call.Entry})
					}
					events <- sync
				}
				name, data = "", ""
				continue
			}

			var payload struct {
				Key   string            `json:"key"`
				Entry *model.RequestLog `json:"entry"`
			}
			if json.Unmarshal([]byte(data), &payload) == nil && payload.Entry != nil {
				events <- streamEvent{name: name, key: payload.Key, entry: payload.Entry}
			}
			name, data = "", ""
		}
	}()
	return events, func() { resp.Body.Close() }
}

// openStream reports only the settled rows, which is what most of these tests
// are about.
func (h *harness) openStream(t *testing.T, path, token string) (<-chan *model.RequestLog, func()) {
	t.Helper()

	feed, closeFeed := h.openFeed(t, path, token)
	entries := make(chan *model.RequestLog, 16)
	go func() {
		defer close(entries)
		for event := range feed {
			if event.name == "log" {
				entries <- event.entry
			}
		}
	}()
	return entries, closeFeed
}

func TestLogStreamPushesNewEntries(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "streamed", 3, 2)
	})
	h.createChannel(channelInput{
		Name: "stream-src", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	events, closeStream := h.openStream(t, "/api/logs/stream", h.admin)
	defer closeStream()

	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"gpt-4o"}`)
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()

	select {
	case entry := <-events:
		if entry == nil {
			t.Fatal("stream closed before delivering an entry")
		}
		if entry.Model != "gpt-4o" || entry.StatusCode != http.StatusOK {
			t.Fatalf("unexpected entry: %+v", entry)
		}
		// The row must already be durable, otherwise a reload would show less
		// than the live view did.
		if entry.ID == 0 {
			t.Fatalf("entry was published before it was persisted: %+v", entry)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("no log event arrived")
	}
}

// The call still running is the one an operator most wants to see, so the
// administrator's feed announces it on the way out, names the channel once one
// is picked, and finally replaces it with the durable row.
func TestAdminLogStreamAnnouncesRunningCalls(t *testing.T) {
	h := newHarness(t)

	release := make(chan struct{})
	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		<-release
		chatResponse(w, "eventually", 3, 2)
	})
	h.createChannel(channelInput{
		Name: "slowpoke", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	feed, closeFeed := h.openFeed(t, "/api/admin/logs/stream", h.admin)
	defer closeFeed()

	// Issued from its own goroutine because the upstream holds it open: the
	// assertions below all happen while the call is genuinely in flight.
	relayed := make(chan error, 1)
	go func() {
		req, err := http.NewRequest(http.MethodPost,
			h.server.URL+"/v1/chat/completions", strings.NewReader(`{"model":"gpt-4o"}`))
		if err != nil {
			relayed <- err
			return
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+key)
		resp, err := h.server.Client().Do(req)
		if err != nil {
			relayed <- err
			return
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		relayed <- resp.Body.Close()
	}()

	// Announced while the upstream is still holding the call, and re-announced
	// once it has been routed.
	var liveKey string
	for liveKey == "" {
		select {
		case event := <-feed:
			if event.name != "inflight" {
				continue
			}
			if event.key == "" {
				t.Fatalf("a running call was announced without a key: %+v", event.entry)
			}
			if event.entry.ID != 0 {
				t.Fatalf("a running call carried a row id: %+v", event.entry)
			}
			if event.entry.Model != "gpt-4o" {
				t.Fatalf("unexpected running call: %+v", event.entry)
			}
			if event.entry.ChannelName != "slowpoke" {
				// The first announcement happens before a channel is picked.
				continue
			}
			liveKey = event.key
		case <-time.After(10 * time.Second):
			t.Fatal("the running call was never announced")
		}
	}

	close(release)
	if err := <-relayed; err != nil {
		t.Fatal(err)
	}

	for {
		select {
		case event := <-feed:
			if event.name != "log" {
				continue
			}
			// The same key, so the console replaces the placeholder it drew
			// rather than listing the one call twice.
			if event.key != liveKey {
				t.Fatalf("the settled row carried key %q, want %q", event.key, liveKey)
			}
			if event.entry.ID == 0 {
				t.Fatalf("the settled row was published before it was persisted: %+v", event.entry)
			}
			if event.entry.StatusCode != http.StatusOK {
				t.Fatalf("unexpected settled row: %+v", event.entry)
			}
			return
		case <-time.After(10 * time.Second):
			t.Fatal("the settled row never arrived")
		}
	}
}

// An operator can end a call that is stuck on an upstream. The caller has to
// be told, because unlike a client hang-up they are still there waiting.
func TestAdminCancelsARunningCall(t *testing.T) {
	h := newHarness(t)

	// Never released: the point is that only the cancel ends this call. The
	// handler returns when the relay drops the connection.
	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	})
	h.createChannel(channelInput{
		Name: "stuck", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	feed, closeFeed := h.openFeed(t, "/api/admin/logs/stream", h.admin)
	defer closeFeed()

	type relayResult struct {
		status int
		body   string
		err    error
	}
	// Built by hand rather than through relayRequest: that helper reports
	// failures with t.Fatal, which is not valid from a goroutine other than the
	// test's own.
	relayed := make(chan relayResult, 1)
	go func() {
		req, err := http.NewRequest(http.MethodPost,
			h.server.URL+"/v1/chat/completions", strings.NewReader(`{"model":"gpt-4o"}`))
		if err != nil {
			relayed <- relayResult{err: err}
			return
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+key)
		resp, err := h.server.Client().Do(req)
		if err != nil {
			relayed <- relayResult{err: err}
			return
		}
		defer resp.Body.Close()
		body, err := io.ReadAll(resp.Body)
		relayed <- relayResult{status: resp.StatusCode, body: string(body), err: err}
	}()

	var liveKey string
	for liveKey == "" {
		select {
		case event := <-feed:
			if event.name == "inflight" && event.entry.ChannelName == "stuck" {
				liveKey = event.key
			}
		case <-time.After(10 * time.Second):
			t.Fatal("the running call was never announced")
		}
	}

	cancelled := h.do(http.MethodPost,
		"/api/admin/logs/inflight/"+liveKey+"/cancel", h.admin, nil, nil)
	cancelled.Body.Close()
	if cancelled.StatusCode != http.StatusOK {
		t.Fatalf("cancel: HTTP %d", cancelled.StatusCode)
	}

	select {
	case result := <-relayed:
		if result.err != nil {
			t.Fatal(result.err)
		}
		// Not an empty 200: a cancelled call that never got upstream headers
		// has to say so, or net/http answers for it and the caller reads the
		// silence as success.
		if result.status != 499 {
			t.Fatalf("the cancelled caller got HTTP %d: %s", result.status, result.body)
		}
		if !strings.Contains(result.body, "administrator") {
			t.Fatalf("the cancelled caller was not told why: %s", result.body)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the cancelled call never returned to its caller")
	}

	for {
		select {
		case event := <-feed:
			if event.name != "log" || event.key != liveKey {
				continue
			}
			if event.entry.StatusCode != 499 {
				t.Fatalf("the cancelled call settled as %d", event.entry.StatusCode)
			}
			// Named, not merely aborted: a row reading "client closed request"
			// would send the next reader after a caller who never left.
			if !strings.Contains(event.entry.Error, "administrator") {
				t.Fatalf("the settled row did not name the cancel: %q", event.entry.Error)
			}
			return
		case <-time.After(10 * time.Second):
			t.Fatal("the cancelled call never settled")
		}
	}
}

// Cancelling a call that already finished is a race the console loses often
// enough that it must not read as a failure.
func TestCancelUnknownInflightKeyIsNotFound(t *testing.T) {
	h := newHarness(t)

	resp := h.do(http.MethodPost, "/api/admin/logs/inflight/nope/cancel", h.admin, nil, nil)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("HTTP %d, want 404", resp.StatusCode)
	}
}

// A running call has no durable row yet, so a console that reconnects mid-call
// has to be handed the set outright or the request stays invisible for as long
// as it runs.
func TestAdminLogStreamReplaysRunningCallsOnConnect(t *testing.T) {
	h := newHarness(t)

	release := make(chan struct{})
	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		<-release
		chatResponse(w, "eventually", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "held", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	relayed := make(chan error, 1)
	go func() {
		req, err := http.NewRequest(http.MethodPost,
			h.server.URL+"/v1/chat/completions", strings.NewReader(`{"model":"gpt-4o"}`))
		if err != nil {
			relayed <- err
			return
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+key)
		resp, err := h.server.Client().Do(req)
		if err != nil {
			relayed <- err
			return
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		relayed <- resp.Body.Close()
	}()

	// Wait until the upstream is holding the call, then connect: everything the
	// feed says about it from here is a replay, not a live announcement.
	deadline := time.Now().Add(10 * time.Second)
	for up.requests.Load() == 0 {
		if time.Now().After(deadline) {
			close(release)
			t.Fatal("the upstream was never called")
		}
		time.Sleep(10 * time.Millisecond)
	}

	feed, closeFeed := h.openFeed(t, "/api/admin/logs/stream", h.admin)
	defer closeFeed()

	select {
	case event := <-feed:
		if event.name != "inflight_sync" {
			t.Fatalf("the feed opened with %q, want the running set", event.name)
		}
		if len(event.calls) != 1 {
			t.Fatalf("the feed replayed %d running calls, want 1", len(event.calls))
		}
		if got := event.calls[0].entry.Model; got != "gpt-4o" {
			t.Fatalf("replayed the wrong call: %+v", event.calls[0].entry)
		}
	case <-time.After(10 * time.Second):
		close(release)
		t.Fatal("the feed never stated what was running")
	}

	close(release)
	if err := <-relayed; err != nil {
		t.Fatal(err)
	}
}

// A regular account's page does not draw these, so its feed must not carry
// them either.
func TestUserLogStreamOmitsRunningCalls(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "plain", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	feed, closeFeed := h.openFeed(t, "/api/logs/stream", h.admin)
	defer closeFeed()

	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"gpt-4o"}`)
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()

	// Only the settled row, and nothing before it: no announcement of the call
	// while it was running, and no periodic statement of the running set.
	select {
	case event := <-feed:
		if event.name != "log" {
			t.Fatalf("a personal feed carried %q", event.name)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the settled row never arrived")
	}
}

func TestLogStreamIsScopedToTheCaller(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "scoped", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})

	// A second account listens while the admin generates traffic.
	h.do(http.MethodPost, "/api/admin/users", h.admin, map[string]any{
		"username": "bystander", "password": "password123",
	}, nil)
	var session sessionResponse
	h.do(http.MethodPost, "/api/auth/login", "",
		credentials{Username: "bystander", Password: "password123"}, &session)

	theirs, closeTheirs := h.openStream(t, "/api/logs/stream", session.Token)
	defer closeTheirs()
	mine, closeMine := h.openStream(t, "/api/logs/stream", h.admin)
	defer closeMine()

	key := h.createKey() // belongs to the admin
	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"gpt-4o"}`)
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()

	select {
	case <-mine:
	case <-time.After(10 * time.Second):
		t.Fatal("the owner never received their own entry")
	}

	select {
	case entry := <-theirs:
		t.Fatalf("another user's entry leaked into the feed: %+v", entry)
	case <-time.After(time.Second):
		// Correct: nothing for them.
	}
}
