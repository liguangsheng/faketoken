package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

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

	// Matched by content, not position: each row is written by its own
	// detached goroutine, so under load the second call's row can land first.
	held := map[string]int64{}
	for _, entry := range listed.Data[:2] {
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
		for _, prompt := range []string{"first-question", "second-question"} {
			if strings.Contains(detail.RequestBody, prompt) {
				held[prompt] = entry.ID
			}
		}
		if detail.ResponseBody == "" {
			t.Fatalf("log %d kept no response body", entry.ID)
		}
	}
	// Collapsed into one record per conversation, both rows would hold the
	// same prompt and one of the two would be missing here.
	if len(held) != 2 || held["first-question"] == held["second-question"] {
		t.Fatalf("the two calls hold %v, want each prompt on its own row", held)
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

	// The window is by log id. A count of 3 alone can hold for a moment
	// while later bodies are still being written, so wait for the exact set.
	ids := logIDs(listed.Data)
	want := ids[len(ids)-3:]
	var stored []int64
	waitFor(t, func() bool {
		stored = h.storedBodyIDs(t)
		return slices.Equal(stored, want)
	}, func() string { return fmt.Sprintf("the window to settle at %v, saw %v", want, stored) })

	newest := h.do(http.MethodGet,
		fmt.Sprintf("/api/admin/logs/%d/detail", ids[len(ids)-1]), h.admin, nil, nil)
	newest.Body.Close()
	if newest.StatusCode != http.StatusOK {
		t.Fatalf("the newest call lost its bodies: HTTP %d", newest.StatusCode)
	}

	oldest := h.do(http.MethodGet,
		fmt.Sprintf("/api/admin/logs/%d/detail", ids[0]), h.admin, nil, nil)
	oldest.Body.Close()
	if oldest.StatusCode != http.StatusGone {
		t.Fatalf("the oldest call still has bodies: HTTP %d, want 410", oldest.StatusCode)
	}
}

// logIDs returns the rows' ids in ascending order, which is the order the
// detail window is cut in.
func logIDs(rows []*model.RequestLog) []int64 {
	ids := make([]int64, len(rows))
	for i, r := range rows {
		ids[i] = r.ID
	}
	slices.Sort(ids)
	return ids
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
		stored = h.storedBodies(t)
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

	// The chunks go too: turning recording off is a promise that no body is
	// left on disk, and a chunk is a piece of one.
	var chunks int
	waitFor(t, func() bool {
		stored, chunks = h.storedBodies(t), h.storedChunks(t)
		return stored == 0 && chunks == 0
	}, func() string {
		return fmt.Sprintf("stored bodies to be cleared, saw %d rows and %d chunks", stored, chunks)
	})
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
		stored = h.storedBodies(t)
		return stored == 1
	}, waiting("the body to be recorded"))

	// days=0 purges everything up to now.
	resp := h.do(http.MethodDelete, "/api/admin/logs?days=0", h.admin, nil, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("purge: HTTP %d", resp.StatusCode)
	}

	if stored = h.storedBodies(t); stored != 0 {
		t.Fatalf("%d bodies outlived the purged logs", stored)
	}

	// The chunks are shared, so the purge cannot take them; the collector
	// does, once nothing points at them. Collected here rather than waited
	// for, with the grace period already behind them.
	h.ageChunks(t)
	if _, err := h.store.CollectChunks(context.Background()); err != nil {
		t.Fatal(err)
	}
	if chunks := h.storedChunks(t); chunks != 0 {
		t.Fatalf("%d chunks outlived the purged logs", chunks)
	}
}

// A coding agent resends the whole conversation every turn. Stored as chunks,
// the second turn has to cost its new tail rather than the history again, and
// both turns still have to read back exactly as they were sent.
func TestRequestDetailSharesRepeatedHistory(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "c", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	// A long, varied history: dedup only shows on bodies several chunks long.
	var history strings.Builder
	for i := range 4000 {
		fmt.Fprintf(&history, "turn %d said something particular to %d. ", i, i*7919)
	}
	turn := func(tail string) string {
		return `{"model":"gpt-4o","messages":[{"role":"user","content":"` +
			history.String() + tail + `"}]}`
	}
	first, second := turn("first question"), turn("second question")

	send := func(body string) {
		r := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, body)
		_, _ = io.Copy(io.Discard, r.Body)
		r.Body.Close()
	}

	send(first)
	waitFor(t, func() bool { return h.storedBodies(t) == 1 }, waiting("the first body"))
	afterFirst := h.storedChunks(t)

	send(second)
	waitFor(t, func() bool { return h.storedBodies(t) == 2 }, waiting("the second body"))
	added := h.storedChunks(t) - afterFirst

	if afterFirst < 10 {
		t.Fatalf("the first body made %d chunks; the history is too short to test dedup", afterFirst)
	}
	// The changed tail, plus the response, which is new each time.
	if added > 4 {
		t.Fatalf("the second turn stored %d new chunks of %d, want only its tail", added, afterFirst)
	}

	var listed page[*model.RequestLog]
	r := h.do(http.MethodGet, "/api/admin/logs", h.admin, nil, &listed)
	r.Body.Close()
	for i, want := range []string{"second question", "first question"} {
		var detail model.RequestLogDetail
		resp := h.do(http.MethodGet,
			fmt.Sprintf("/api/admin/logs/%d/detail", listed.Data[i].ID), h.admin, nil, &detail)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("detail %d: HTTP %d", listed.Data[i].ID, resp.StatusCode)
		}
		if got := promptOf(t, detail.RequestBody); got != history.String()+want {
			t.Fatalf("log %d read back a %d-byte prompt, want the %d sent",
				listed.Data[i].ID, len(got), len(history.String()+want))
		}
	}
}

// promptOf is the user message of a stored chat request. The capture
// re-indents JSON, so a body is compared by what it says, not byte for byte.
func promptOf(t *testing.T, body string) string {
	t.Helper()
	var req struct {
		Messages []struct {
			Content string `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal([]byte(body), &req); err != nil || len(req.Messages) != 1 {
		t.Fatalf("stored body is not the chat request: %v", err)
	}
	return req.Messages[0].Content
}

// Parallel calls from one conversation store the same new chunks at the same
// moment. None of them may lose its body to a deadlock or a conflict, and
// every one has to read back as sent.
func TestRequestDetailSurvivesConcurrentSharedWrites(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "c", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	var history strings.Builder
	for i := range 4000 {
		fmt.Fprintf(&history, "turn %d said something particular to %d. ", i, i*7919)
	}

	const calls = 12
	var wg sync.WaitGroup
	for i := range calls {
		wg.Go(func() {
			r := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
				fmt.Sprintf(`{"model":"gpt-4o","messages":[{"role":"user","content":"%stail-%02d"}]}`,
					history.String(), i))
			_, _ = io.Copy(io.Discard, r.Body)
			r.Body.Close()
		})
	}
	wg.Wait()

	var listed page[*model.RequestLog]
	waitFor(t, func() bool {
		r := h.do(http.MethodGet, "/api/admin/logs?limit=50", h.admin, nil, &listed)
		r.Body.Close()
		return len(listed.Data) >= calls && h.storedBodies(t) == calls
	}, func() string {
		return fmt.Sprintf("%d bodies, saw %d rows and %d bodies", calls, len(listed.Data), h.storedBodies(t))
	})

	tails := map[string]bool{}
	for _, entry := range listed.Data {
		var detail model.RequestLogDetail
		r := h.do(http.MethodGet,
			fmt.Sprintf("/api/admin/logs/%d/detail", entry.ID), h.admin, nil, &detail)
		r.Body.Close()
		if r.StatusCode != http.StatusOK {
			t.Fatalf("log %d: HTTP %d", entry.ID, r.StatusCode)
		}
		prompt := promptOf(t, detail.RequestBody)
		tail, ok := strings.CutPrefix(prompt, history.String())
		if !ok || !strings.HasPrefix(tail, "tail-") {
			t.Fatalf("log %d read back a damaged %d-byte prompt", entry.ID, len(prompt))
		}
		tails[tail] = true
	}
	if len(tails) != calls {
		t.Fatalf("%d distinct calls read back, want %d", len(tails), calls)
	}
}

// The collector takes what nothing points at and nothing else: a chunk shared
// by a body still in the window has to survive the one that left.
func TestChunkCollectorKeepsSharedChunks(t *testing.T) {
	h := newHarness(t)

	settings := h.settings(t)
	settings.LogDetailKeep = 1
	resp := h.do(http.MethodPut, "/api/admin/settings", h.admin, settings, nil)
	resp.Body.Close()

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "c", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	var history strings.Builder
	for i := range 4000 {
		fmt.Fprintf(&history, "turn %d said something particular to %d. ", i, i*7919)
	}
	for _, tail := range []string{"first", "second"} {
		r := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
			`{"model":"gpt-4o","messages":[{"role":"user","content":"`+history.String()+tail+`"}]}`)
		_, _ = io.Copy(io.Discard, r.Body)
		r.Body.Close()
	}

	// The window holds one: the newer call's body, once both are written.
	var listed page[*model.RequestLog]
	waitFor(t, func() bool {
		r := h.do(http.MethodGet, "/api/admin/logs", h.admin, nil, &listed)
		r.Body.Close()
		return len(listed.Data) >= 2
	}, waiting("two log rows"))
	ids := logIDs(listed.Data)
	newest := ids[len(ids)-1]
	waitFor(t, func() bool {
		return slices.Equal(h.storedBodyIDs(t), []int64{newest})
	}, waiting("only the newer body left in the window"))

	h.ageChunks(t)
	removed, err := h.store.CollectChunks(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if removed == 0 {
		t.Fatal("the first call's own chunks were not collected")
	}

	var detail model.RequestLogDetail
	r := h.do(http.MethodGet,
		fmt.Sprintf("/api/admin/logs/%d/detail", newest), h.admin, nil, &detail)
	r.Body.Close()
	if r.StatusCode != http.StatusOK {
		t.Fatalf("the surviving body cannot be read after collection: HTTP %d", r.StatusCode)
	}
	// Either call can hold the newer id, so either prompt may be the survivor.
	if got := promptOf(t, detail.RequestBody); got != history.String()+"first" &&
		got != history.String()+"second" {
		t.Fatal("the surviving body did not read back intact")
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

// An account reading its own calls sees what it asked for, not how the gateway
// routed it: the mapped upstream model and the source address are withheld
// from its rows, from its keyword search and from its live feed. The
// administrator's view keeps both.
func TestOwnLogsWithholdRoutingInternals(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "mapped", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
		ModelMapping: map[string]string{"gpt-4o": "secret-upstream-model"},
	})
	key := h.createKey()

	events, closeStream := h.openStream(t, "/api/logs/stream", h.admin)
	defer closeStream()

	relayed := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"gpt-4o"}`)
	_, _ = io.Copy(io.Discard, relayed.Body)
	relayed.Body.Close()

	select {
	case entry := <-events:
		if entry == nil || entry.UpstreamModel != "" || entry.ClientIP != "" {
			t.Fatalf("the owner's feed carried routing internals: %+v", entry)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("no log event arrived")
	}

	var operator page[*model.RequestLog]
	waitFor(t, func() bool {
		r := h.do(http.MethodGet, "/api/admin/logs", h.admin, nil, &operator)
		r.Body.Close()
		return len(operator.Data) >= 1
	}, waiting("the call to be logged"))
	row := operator.Data[0]
	if row.UpstreamModel != "secret-upstream-model" || row.ClientIP == "" {
		t.Fatalf("the administrator lost the routing details: %+v", row)
	}

	var own page[*model.RequestLog]
	r := h.do(http.MethodGet, "/api/logs", h.admin, nil, &own)
	r.Body.Close()
	if len(own.Data) != 1 || own.Data[0].UpstreamModel != "" || own.Data[0].ClientIP != "" {
		t.Fatalf("the owner's rows carried routing internals: %+v", own.Data)
	}

	for _, keyword := range []string{"secret-upstream", row.ClientIP} {
		var found page[*model.RequestLog]
		r := h.do(http.MethodGet, "/api/logs?keyword="+url.QueryEscape(keyword), h.admin, nil, &found)
		r.Body.Close()
		if len(found.Data) != 0 {
			t.Errorf("the owner's search matched on withheld %q", keyword)
		}
		r = h.do(http.MethodGet, "/api/admin/logs?keyword="+url.QueryEscape(keyword), h.admin, nil, &found)
		r.Body.Close()
		if len(found.Data) != 1 {
			t.Errorf("the administrator's search on %q found %d rows", keyword, len(found.Data))
		}
	}
}

// The operator's model ranking counts the model each call really went out as.
// An account's own ranking keeps the names it asked for, since the mapping is
// withheld from it.
func TestStatsRankMappedModel(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "mapped", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
		ModelMapping: map[string]string{"gpt-4o": "secret-upstream-model"},
	})
	key := h.createKey()

	// The second model has no channel: refused before routing, no upstream model.
	for _, name := range []string{"gpt-4o", "no-such-model"} {
		resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
			fmt.Sprintf(`{"model":%q}`, name))
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
	}
	h.waitForLog(t, 2)

	ranked := func(path string) []string {
		var stats struct {
			ByModel []store.NamedStat `json:"by_model"`
		}
		r := h.do(http.MethodGet, path, h.admin, nil, &stats)
		r.Body.Close()
		names := []string{}
		for _, row := range stats.ByModel {
			names = append(names, row.Name)
		}
		// Tied counts come back in no particular order.
		slices.Sort(names)
		return names
	}

	if got := ranked("/api/admin/stats"); !slices.Equal(got, []string{"secret-upstream-model"}) {
		t.Errorf("operator ranking = %v, want the mapped model only", got)
	}
	// The refused call cost nothing and used no tokens, so it holds no place in
	// a ranking of spend; the one that answered ranks under the name asked for.
	if got := ranked("/api/stats"); !slices.Equal(got, []string{"gpt-4o"}) {
		t.Errorf("own ranking = %v, want the requested name only", got)
	}
}

// The heatmap reads its own rollup: a log purge must not empty it, and a day
// is the viewer's day, not UTC's.
func TestUsageHeatmapSurvivesLogPurge(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 10, 5)
	})
	h.createChannel(channelInput{
		Name: "c", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	for range 2 {
		resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"gpt-4o"}`)
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
	}
	h.waitForLog(t, 2)

	purge := h.do(http.MethodDelete, "/api/admin/logs?days=0", h.admin, nil, nil)
	purge.Body.Close()
	if purge.StatusCode != http.StatusOK {
		t.Fatalf("purge: HTTP %d", purge.StatusCode)
	}

	heatmap := func(path string) []store.UsageDay {
		var out struct {
			Days []store.UsageDay `json:"days"`
		}
		resp := h.do(http.MethodGet, path, h.admin, nil, &out)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("%s: HTTP %d", path, resp.StatusCode)
		}
		return out.Days
	}

	// +14:00 is a calendar day ahead of UTC for ten hours of every day, so
	// UTC bucketing would show the wrong date for part of each run.
	const zone = "Pacific/Kiritimati"
	loc, err := time.LoadLocation(zone)
	if err != nil {
		t.Skip(err)
	}
	today := time.Now().In(loc).Format(time.DateOnly)

	for _, path := range []string{"/api/stats/heatmap?tz=" + zone, "/api/admin/stats/heatmap?tz=" + zone} {
		days := heatmap(path)
		if len(days) != 1 {
			t.Fatalf("%s: %d days, want 1: %+v", path, len(days), days)
		}
		d := days[0]
		if d.Day != today || d.Requests != 2 || d.TotalTokens != 30 || d.Errors != 0 {
			t.Fatalf("%s: %+v, want %s with 2 requests and 30 tokens", path, d, today)
		}
	}

	bad := h.do(http.MethodGet, "/api/stats/heatmap?tz=Not/AZone", h.admin, nil, nil)
	bad.Body.Close()
	if bad.StatusCode != http.StatusBadRequest {
		t.Fatalf("bad tz: HTTP %d, want 400", bad.StatusCode)
	}
}

// Rows imported from another gateway get new ids but keep their own times, so
// the list orders by time: a month-old import must not lead it.
func TestLogListOrdersByTime(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 10, 5)
	})
	h.createChannel(channelInput{
		Name: "c", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"gpt-4o"}`)
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	live := h.waitForLog(t, 1)

	var imported int64
	if err := h.pool.QueryRow(context.Background(), `INSERT INTO request_logs
		(user_id, username, model, endpoint, method, status_code, created_at)
		VALUES ($1, 'admin', 'gpt-4o', '/v1/chat/completions', 'POST', 200, now() - interval '30 days')
		RETURNING id`, live.UserID).Scan(&imported); err != nil {
		t.Fatal(err)
	}
	if imported <= live.ID {
		t.Fatalf("imported id %d, want above %d", imported, live.ID)
	}

	var out struct {
		Data []model.RequestLog `json:"data"`
	}
	list := h.do(http.MethodGet, "/api/admin/logs?limit=10", h.admin, nil, &out)
	list.Body.Close()
	if list.StatusCode != http.StatusOK {
		t.Fatalf("list: HTTP %d", list.StatusCode)
	}
	if len(out.Data) != 2 || out.Data[0].ID != live.ID || out.Data[1].ID != imported {
		got := make([]int64, len(out.Data))
		for i, l := range out.Data {
			got[i] = l.ID
		}
		t.Fatalf("order %v, want [%d %d]", got, live.ID, imported)
	}
}
