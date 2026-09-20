package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/faketoken/faketoken/internal/model"
	"github.com/faketoken/faketoken/internal/store"
)

// The search box exists for when the operator knows something about a call but
// not which field it was, so it has to reach across columns — and the live feed
// has to agree with the list about what matches.
func TestLogKeywordSearchSpansColumns(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "searchable-channel", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	relayed := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"gpt-4o"}`)
	_, _ = io.Copy(io.Discard, relayed.Body)
	relayed.Body.Close()

	var listed page[*model.RequestLog]
	waitFor(t, func() bool {
		r := h.do(http.MethodGet, "/api/admin/logs", h.admin, nil, &listed)
		r.Body.Close()
		return len(listed.Data) >= 1
	}, waiting("the call to be logged"))

	// Each of these lives in a different column.
	for _, tc := range []struct{ name, keyword string }{
		{"channel name", "searchable"},
		{"model", "gpt-4"},
		{"username", "admin"},
		{"endpoint", "chat/completions"},
		{"key name", "test"},
		{"case insensitive", "SEARCHABLE-CHANNEL"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var found page[*model.RequestLog]
			r := h.do(http.MethodGet, "/api/admin/logs?keyword="+url.QueryEscape(tc.keyword),
				h.admin, nil, &found)
			r.Body.Close()
			if len(found.Data) == 0 {
				t.Fatalf("searching %q found nothing", tc.keyword)
			}
		})
	}

	// The id is shown on every row precisely so it can be quoted back; a
	// search that ignored it would make the column decorative.
	target := listed.Data[0]
	var byID page[*model.RequestLog]
	r := h.do(http.MethodGet,
		fmt.Sprintf("/api/admin/logs?keyword=%d", target.ID), h.admin, nil, &byID)
	r.Body.Close()
	if len(byID.Data) != 1 || byID.Data[0].ID != target.ID {
		t.Fatalf("searching for id %d returned %d rows", target.ID, len(byID.Data))
	}

	var empty page[*model.RequestLog]
	r = h.do(http.MethodGet, "/api/admin/logs?keyword=definitely-not-present",
		h.admin, nil, &empty)
	r.Body.Close()
	if len(empty.Data) != 0 {
		t.Fatalf("an unrelated keyword matched %d rows", len(empty.Data))
	}

	// A value containing SQL wildcards must be taken literally, not as a
	// pattern that matches everything.
	r = h.do(http.MethodGet, "/api/admin/logs?keyword="+url.QueryEscape("%"), h.admin, nil, &empty)
	r.Body.Close()
	if len(empty.Data) != 0 {
		t.Fatalf("%% was treated as a wildcard and matched %d rows", len(empty.Data))
	}
}

// The point of the feature: after a call, its full request and reply can be
// read back, and what is stored is the body of that call rather than some
// other call in the same conversation.
func TestRequestDetailKeepsEachCallsOwnBodies(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, fmt.Sprintf("reply-%d", u.requests.Load()), 1, 1)
	})
	h.createChannel(channelInput{
		Name: "c", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	// Same session id on both calls, to be sure the bodies are stored per
	// call rather than collapsed into one record per conversation.
	for _, prompt := range []string{"first-question", "second-question"} {
		req, err := http.NewRequest(http.MethodPost, h.server.URL+"/v1/chat/completions",
			strings.NewReader(`{"model":"gpt-4o","messages":[{"role":"user","content":"`+prompt+`"}]}`))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+key)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Session-ID", "shared-session")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
	}

	var listed page[*model.RequestLog]
	waitFor(t, func() bool {
		resp := h.do(http.MethodGet, "/api/admin/logs", h.admin, nil, &listed)
		resp.Body.Close()
		return len(listed.Data) >= 2
	}, waiting("two log rows"))

	// Newest first, so the second call is listed first.
	for index, want := range []string{"second-question", "first-question"} {
		entry := listed.Data[index]
		// The bodies are written just after the log row they belong to, so a
		// list that already has the row can still be a moment ahead of them.
		var detail model.RequestLogDetail
		var status int
		waitFor(t, func() bool {
			resp := h.do(http.MethodGet,
				fmt.Sprintf("/api/admin/logs/%d/detail", entry.ID), h.admin, nil, &detail)
			resp.Body.Close()
			status = resp.StatusCode
			return status == http.StatusOK
		}, func() string {
			return fmt.Sprintf("detail for log %d, last saw HTTP %d", entry.ID, status)
		})
		if !strings.Contains(detail.RequestBody, want) {
			t.Fatalf("log %d holds the wrong request: want %q in %s",
				entry.ID, want, detail.RequestBody)
		}
		if detail.ResponseBody == "" {
			t.Fatalf("log %d kept no response body", entry.ID)
		}
	}
}

// Credentials must not survive into the stored bodies: the whole request is
// kept, so anything sensitive in it would be kept too.
func TestRequestDetailRedactsCredentials(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "c", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	req, err := http.NewRequest(http.MethodPost, h.server.URL+"/v1/chat/completions",
		strings.NewReader(`{"model":"gpt-4o","api_key":"sk-should-not-be-stored"}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()

	var listed page[*model.RequestLog]
	waitFor(t, func() bool {
		r := h.do(http.MethodGet, "/api/admin/logs", h.admin, nil, &listed)
		r.Body.Close()
		return len(listed.Data) >= 1
	}, waiting("the log row"))

	var detail model.RequestLogDetail
	r := h.do(http.MethodGet,
		fmt.Sprintf("/api/admin/logs/%d/detail", listed.Data[0].ID), h.admin, nil, &detail)
	r.Body.Close()

	if strings.Contains(detail.RequestBody, "sk-should-not-be-stored") {
		t.Fatalf("a credential in the body was stored verbatim: %s", detail.RequestBody)
	}
	if raw, _ := json.Marshal(detail.RequestHeaders); strings.Contains(string(raw), key) {
		t.Fatalf("the caller's key was stored in the headers: %s", raw)
	}
}

// The window is the whole point: bodies are large, so the table must stay
// bounded no matter how much traffic passes through.
func TestRequestDetailWindowDropsTheOldest(t *testing.T) {
	h := newHarness(t)

	settings := h.settings(t)
	settings.LogDetailKeep = 3
	resp := h.do(http.MethodPut, "/api/admin/settings", h.admin, settings, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("set window: HTTP %d", resp.StatusCode)
	}

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "c", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	const calls = 6
	for range calls {
		r := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"gpt-4o"}`)
		_, _ = io.Copy(io.Discard, r.Body)
		r.Body.Close()
	}

	// Every call has to be logged before the window can be judged: the detail
	// count reaches 3 while later calls are still being written, so waiting on
	// it alone would inspect a half-finished picture.
	var listed page[*model.RequestLog]
	waitFor(t, func() bool {
		r := h.do(http.MethodGet, "/api/admin/logs", h.admin, nil, &listed)
		r.Body.Close()
		return len(listed.Data) >= calls
	}, func() string { return fmt.Sprintf("%d log rows, saw %d", calls, len(listed.Data)) })

	var stored int
	waitFor(t, func() bool {
		if err := h.pool.QueryRow(context.Background(),
			`SELECT count(*) FROM request_log_details`).Scan(&stored); err != nil {
			t.Fatal(err)
		}
		return stored == 3
	}, func() string { return fmt.Sprintf("the window to settle at 3 rows, saw %d", stored) })

	newest := h.do(http.MethodGet,
		fmt.Sprintf("/api/admin/logs/%d/detail", listed.Data[0].ID), h.admin, nil, nil)
	newest.Body.Close()
	if newest.StatusCode != http.StatusOK {
		t.Fatalf("the newest call lost its bodies: HTTP %d", newest.StatusCode)
	}

	oldest := h.do(http.MethodGet,
		fmt.Sprintf("/api/admin/logs/%d/detail", listed.Data[calls-1].ID), h.admin, nil, nil)
	oldest.Body.Close()
	if oldest.StatusCode != http.StatusGone {
		t.Fatalf("the oldest call still has bodies: HTTP %d, want 410", oldest.StatusCode)
	}
}

// Turning the window off has to clear what was already recorded, otherwise
// "stop keeping request bodies" would leave the existing ones on disk.
func TestRequestDetailWindowOfZeroClearsStoredBodies(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "c", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	relayed := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"gpt-4o"}`)
	_, _ = io.Copy(io.Discard, relayed.Body)
	relayed.Body.Close()

	var stored int
	waitFor(t, func() bool {
		if err := h.pool.QueryRow(context.Background(),
			`SELECT count(*) FROM request_log_details`).Scan(&stored); err != nil {
			t.Fatal(err)
		}
		return stored == 1
	}, waiting("the first body to be recorded"))

	settings := h.settings(t)
	settings.LogDetailKeep = 0
	resp := h.do(http.MethodPut, "/api/admin/settings", h.admin, settings, nil)
	resp.Body.Close()

	// The next call is what applies the change.
	relayed = h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"gpt-4o"}`)
	_, _ = io.Copy(io.Discard, relayed.Body)
	relayed.Body.Close()

	waitFor(t, func() bool {
		if err := h.pool.QueryRow(context.Background(),
			`SELECT count(*) FROM request_log_details`).Scan(&stored); err != nil {
			t.Fatal(err)
		}
		return stored == 0
	}, func() string { return fmt.Sprintf("stored bodies to be cleared, saw %d", stored) })
}

// Purging the metadata must take the bodies with it: a body outliving the row
// that says who sent it would be unattributable and unreachable.
func TestPurgingLogsRemovesTheirBodies(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "c", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	relayed := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"gpt-4o"}`)
	_, _ = io.Copy(io.Discard, relayed.Body)
	relayed.Body.Close()

	var stored int
	waitFor(t, func() bool {
		if err := h.pool.QueryRow(context.Background(),
			`SELECT count(*) FROM request_log_details`).Scan(&stored); err != nil {
			t.Fatal(err)
		}
		return stored == 1
	}, waiting("the body to be recorded"))

	// days=0 purges everything up to now.
	resp := h.do(http.MethodDelete, "/api/admin/logs?days=0", h.admin, nil, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("purge: HTTP %d", resp.StatusCode)
	}

	if err := h.pool.QueryRow(context.Background(),
		`SELECT count(*) FROM request_log_details`).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != 0 {
		t.Fatalf("%d bodies outlived the purged logs", stored)
	}
}

// The bodies are an operator diagnostic: a regular account must not reach
// them, not even for its own traffic.
func TestRequestDetailIsAdminOnly(t *testing.T) {
	h := newHarness(t)

	h.do(http.MethodPost, "/api/admin/users", h.admin, map[string]any{
		"username": "curious", "password": "password123",
	}, nil)
	var session sessionResponse
	h.do(http.MethodPost, "/api/auth/login", "",
		credentials{Username: "curious", Password: "password123"}, &session)

	resp := h.do(http.MethodGet, "/api/admin/logs/1/detail", session.Token, nil, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("a regular user reached the bodies: HTTP %d", resp.StatusCode)
	}
}

func TestCacheCreationTokensAreRecordedWithoutChangingCost(t *testing.T) {
	h := newHarness(t)

	// Anthropic-shaped usage: 100 fresh + 20 read from cache + 5 written to it.
	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"content": []map[string]string{{"type": "text", "text": "ok"}},
			"usage": map[string]int{
				"input_tokens": 100, "output_tokens": 40,
				"cache_read_input_tokens": 20, "cache_creation_input_tokens": 5,
			},
		})
	})
	h.createChannel(channelInput{
		Name: "cache-src", Type: "anthropic", BaseURL: up.URL, APIKey: "k",
		Models: []string{"claude-sonnet-4-5-20250929"}, Groups: []string{"default"},
	})
	key := h.createKey()

	resp := h.relayRequest(http.MethodPost, "/v1/messages", key,
		`{"model":"claude-sonnet-4-5-20250929","max_tokens":16}`)
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()

	entry := h.waitForLog(t, 1)
	if entry.CacheCreationTokens != 5 {
		t.Fatalf("cache creation = %d, want 5", entry.CacheCreationTokens)
	}
	if entry.CachedTokens != 20 {
		t.Fatalf("cached = %d, want 20", entry.CachedTokens)
	}
	// The write half stays inside the prompt total, which is what billing
	// charges on — breaking it out must not have moved any money.
	if entry.PromptTokens != 125 {
		t.Fatalf("prompt = %d, want 125 (100 fresh + 20 read + 5 written)", entry.PromptTokens)
	}

	// claude-sonnet-4-5: $3/1M in, $15/1M out, $0.30/1M cached.
	// (125-20)*3 + 20*0.30 + 40*15 = 315 + 6 + 600 = 921 micro-USD.
	if entry.Cost != 921 {
		t.Fatalf("cost = %d micro-USD, want 921", entry.Cost)
	}

	logs, _, err := h.store.ListLogs(context.Background(), store.LogFilter{Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if logs[0].CacheCreationTokens != 5 {
		t.Fatalf("cache creation did not survive the round trip: %+v", logs[0])
	}
}

func TestReasoningEffortAndClientTypeAreLogged(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "hints", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	req, err := http.NewRequest(http.MethodPost, h.server.URL+"/v1/chat/completions",
		strings.NewReader(`{"model":"gpt-4o","reasoning_effort":"high"}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Originator", "codex-tui")

	resp, err := h.server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()

	entry := h.waitForLog(t, 1)
	if entry.ReasoningEffort != "high" {
		t.Fatalf("reasoning effort = %q, want high", entry.ReasoningEffort)
	}
	// The TUI is reported as itself rather than folded into the family, so a
	// report can tell it apart from Codex Desktop.
	if entry.ClientType != "codex-tui" {
		t.Fatalf("client type = %q, want codex-tui", entry.ClientType)
	}

	// The upstream must receive the body unchanged: these labels are read, not
	// injected.
	if body := up.body(); !strings.Contains(body, `"reasoning_effort":"high"`) {
		t.Fatalf("request body was altered: %s", body)
	}
}
