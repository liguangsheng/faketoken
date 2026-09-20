package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/faketoken/faketoken/internal/model"
	"github.com/faketoken/faketoken/internal/relay"
)

// A probe reaches an upstream and spends real money, so it belongs in the log
// like anything else — but marked, so reports can tell it from client traffic.
func TestChannelTestIsLogged(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "pong", 11, 3)
	})
	id := h.createChannel(channelInput{
		Name: "probed", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})

	var result relay.TestResult
	resp := h.do(http.MethodPost, fmt.Sprintf("/api/admin/channels/%d/test", id), h.admin,
		map[string]any{"model": "gpt-4o", "prompt": "say pong"}, &result)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !result.OK {
		t.Fatalf("probe: HTTP %d, result %+v", resp.StatusCode, result)
	}

	var listed page[*model.RequestLog]
	waitFor(t, func() bool {
		r := h.do(http.MethodGet, "/api/admin/logs", h.admin, nil, &listed)
		r.Body.Close()
		return len(listed.Data) >= 1
	}, waiting("the probe to be logged"))

	entry := listed.Data[0]
	switch {
	case entry.ChannelID != id:
		t.Fatalf("logged against channel %d, want %d", entry.ChannelID, id)
	case entry.Model != "gpt-4o":
		t.Fatalf("logged model %q", entry.Model)
	case entry.Username != "admin":
		t.Fatalf("logged user %q, want the administrator who ran it", entry.Username)
	case entry.StatusCode != http.StatusOK:
		t.Fatalf("logged status %d", entry.StatusCode)
	case entry.TotalTokens == 0:
		t.Fatal("the probe's token usage was not recorded")
	}
	// Filterable, so a report can exclude console probes from real traffic.
	if entry.ClientType != ChannelTestClient || entry.TokenName != ChannelTestClient {
		t.Fatalf("the probe is not marked: client=%q token=%q",
			entry.ClientType, entry.TokenName)
	}

	// The marker has to be reachable from the search box too.
	var found page[*model.RequestLog]
	r := h.do(http.MethodGet, "/api/admin/logs?keyword="+ChannelTestClient, h.admin, nil, &found)
	r.Body.Close()
	if len(found.Data) != 1 {
		t.Fatalf("searching for the marker found %d rows", len(found.Data))
	}

	// The exchange is the most useful part of a probe: what was asked, and
	// exactly how the upstream answered.
	var detail model.RequestLogDetail
	r = h.do(http.MethodGet, fmt.Sprintf("/api/admin/logs/%d/detail", entry.ID),
		h.admin, nil, &detail)
	r.Body.Close()
	if r.StatusCode != http.StatusOK {
		t.Fatalf("probe detail: HTTP %d, want 200", r.StatusCode)
	}
	if !strings.Contains(detail.RequestBody, "say pong") {
		t.Fatalf("the probe's request was not stored: %s", detail.RequestBody)
	}
	if !strings.Contains(detail.ResponseBody, "pong") {
		t.Fatalf("the upstream's reply was not stored: %s", detail.ResponseBody)
	}
	// The channel's own credential travels on a probe; storing it verbatim
	// would put an upstream key in the log.
	if raw, _ := json.Marshal(detail.RequestHeaders); strings.Contains(string(raw), "\"k\"") {
		t.Fatalf("the upstream credential was stored: %s", raw)
	}
}

// An upstream that never answers still produced a probe, and that attempt is
// the thing worth seeing in the log.
func TestFailedChannelTestIsLogged(t *testing.T) {
	h := newHarness(t)

	id := h.createChannel(channelInput{
		Name: "unreachable", Type: "openai",
		// Refused immediately rather than timing out, so the test stays fast.
		BaseURL: "http://127.0.0.1:1", APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})

	resp := h.do(http.MethodPost, fmt.Sprintf("/api/admin/channels/%d/test", id), h.admin,
		map[string]any{"model": "gpt-4o"}, nil)
	resp.Body.Close()

	var listed page[*model.RequestLog]
	waitFor(t, func() bool {
		r := h.do(http.MethodGet, "/api/admin/logs?only_error=true", h.admin, nil, &listed)
		r.Body.Close()
		return len(listed.Data) >= 1
	}, waiting("the failed probe to be logged"))

	entry := listed.Data[0]
	// A probe that never reached the upstream has no status of its own; it
	// must not be filed as a success.
	if entry.StatusCode < 400 {
		t.Fatalf("a failed probe was logged as HTTP %d", entry.StatusCode)
	}
	if entry.Error == "" {
		t.Fatal("the failure reason was not recorded")
	}
	if entry.Cost != 0 {
		t.Fatalf("a failed probe was billed %d", entry.Cost)
	}
}

func TestFetchModelsFromUpstream(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"object": "list",
			"data": []map[string]string{
				{"id": "gpt-4o"}, {"id": "gpt-4o-mini"}, {"id": "o3"},
			},
		})
	})
	id := h.createChannel(channelInput{
		Name: "pullable", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Groups: []string{"default"},
	})

	var pulled struct {
		Models  []string `json:"models"`
		Count   int      `json:"count"`
		Applied bool     `json:"applied"`
	}
	resp := h.do(http.MethodPost,
		fmt.Sprintf("/api/admin/channels/%d/fetch-models?apply=true", id), h.admin, nil, &pulled)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("HTTP %d", resp.StatusCode)
	}
	if pulled.Count != 3 || !pulled.Applied {
		t.Fatalf("unexpected pull result: %+v", pulled)
	}
	if up.path() != "/v1/models" {
		t.Errorf("model catalogue path = %q", up.path())
	}

	// Applying the pull must make the models routable immediately.
	models, err := h.store.GroupModels(context.Background(), "default")
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 3 {
		t.Fatalf("routing table not refreshed, got %v", models)
	}
}

func TestFetchModelsAutoTriesGoogleCatalogueAuthentication(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1beta/models" ||
			r.Header.Get("X-Goog-Api-Key") != "opaque-key" {
			http.Error(w, `{"error":"wrong catalogue authentication"}`, http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"models":[{"name":"models/gemini-2.5-pro"}]}`)
	})
	id := h.createChannel(channelInput{
		Name: "google-catalogue", BaseURL: up.URL, AuthStyle: model.AuthStyleAuto,
		APIKey: "opaque-key", Groups: []string{"default"},
	})

	var pulled struct {
		Models []string `json:"models"`
		Count  int      `json:"count"`
	}
	resp := h.do(http.MethodPost,
		fmt.Sprintf("/api/admin/channels/%d/fetch-models", id), h.admin, nil, &pulled)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("HTTP %d", resp.StatusCode)
	}
	if pulled.Count != 1 || !slices.Equal(pulled.Models, []string{"gemini-2.5-pro"}) {
		t.Fatalf("unexpected pull result: %+v", pulled)
	}
	if got := up.requests.Load(); got != 3 {
		t.Fatalf("catalogue attempts = %d, want bearer, x-api-key, then Google", got)
	}
	if got := up.path(); got != "/v1beta/models?pageSize=1000" {
		t.Fatalf("last catalogue path = %q", got)
	}
}

func TestConfiguredTestModelIsUsedByTheProbe(t *testing.T) {
	h := newHarness(t)

	var probed atomic.Value
	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		probed.Store(u.body())
		chatResponse(w, "ok", 1, 1)
	})
	id := h.createChannel(channelInput{
		Name: "probe", Type: "openai", BaseURL: up.URL, APIKey: "k",
		ModelPrefixes: []string{"gpt-4"}, TestModel: "gpt-4o-mini",
		Groups: []string{"default"},
	})

	var result relay.TestResult
	h.do(http.MethodPost, fmt.Sprintf("/api/admin/channels/%d/test", id), h.admin, nil, &result)
	if !result.OK {
		t.Fatalf("probe failed: %+v", result)
	}
	if body, _ := probed.Load().(string); !strings.Contains(body, "gpt-4o-mini") {
		t.Fatalf("the configured test model was not used: %s", body)
	}
}

func TestPromptedChannelTestReturnsTheModelReply(t *testing.T) {
	h := newHarness(t)

	var seenBody atomic.Value
	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		seenBody.Store(u.body())
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{
				{"message": map[string]string{"role": "assistant", "content": "这是模型的回答"}},
			},
			"usage": map[string]int{"prompt_tokens": 30, "completion_tokens": 12, "total_tokens": 42},
		})
	})
	id := h.createChannel(channelInput{
		Name: "prompted", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o", "gpt-4o-mini"}, Groups: []string{"default"},
	})

	var result relay.TestResult
	h.do(http.MethodPost, fmt.Sprintf("/api/admin/channels/%d/test", id), h.admin,
		map[string]any{"model": "gpt-4o-mini", "prompt_template": "json-output"}, &result)

	if !result.OK {
		t.Fatalf("probe failed: %+v", result)
	}
	if result.Reply != "这是模型的回答" {
		t.Fatalf("reply = %q", result.Reply)
	}
	if result.Model != "gpt-4o-mini" {
		t.Fatalf("the selected model was ignored: %q", result.Model)
	}
	if result.Usage.TotalTokens != 42 {
		t.Fatalf("usage not reported: %+v", result.Usage)
	}
	if result.Prompt == "" {
		t.Fatal("the resolved prompt should come back for display")
	}

	// The template text must actually reach the upstream, and the budget has to
	// leave room for an answer.
	body, _ := seenBody.Load().(string)
	if !strings.Contains(body, "gpt-4o-mini") || !strings.Contains(body, "next_step") {
		t.Fatalf("prompt not forwarded: %s", body)
	}
	if !strings.Contains(body, `"max_tokens":1024`) {
		t.Fatalf("prompted probe did not raise the token budget: %s", body)
	}
}

func TestChannelTestCanChooseEachRequestProtocol(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/responses":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"output": []map[string]any{{"content": []map[string]string{{
					"type": "output_text", "text": "responses-ok",
				}}}},
			})
		case "/v1/messages":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"content": []map[string]string{{"type": "text", "text": "messages-ok"}},
			})
		case "/v1/chat/completions":
			chatResponse(w, "chat-ok", 1, 1)
		default:
			http.NotFound(w, r)
		}
	})
	id := h.createChannel(channelInput{
		Name: "protocol-probe", BaseURL: up.URL, APIKey: "upstream-key",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})

	tests := []struct {
		protocol, endpoint, reply, auth, xAPIKey string
	}{
		{protocol: model.ProtocolResponses, endpoint: "/v1/responses", reply: "responses-ok", auth: "Bearer upstream-key"},
		{protocol: model.ProtocolChatCompletions, endpoint: "/v1/chat/completions", reply: "chat-ok", auth: "Bearer upstream-key"},
		{protocol: model.ProtocolMessages, endpoint: "/v1/messages", reply: "messages-ok", xAPIKey: "upstream-key"},
	}
	for _, tc := range tests {
		t.Run(tc.protocol, func(t *testing.T) {
			var result relay.TestResult
			resp := h.do(http.MethodPost, fmt.Sprintf("/api/admin/channels/%d/test", id), h.admin,
				map[string]any{"model": "gpt-4o", "protocol": tc.protocol, "prompt": "ping"}, &result)
			resp.Body.Close()
			if resp.StatusCode != http.StatusOK || !result.OK {
				t.Fatalf("HTTP %d, result %+v", resp.StatusCode, result)
			}
			if result.Endpoint != tc.endpoint || result.Reply != tc.reply {
				t.Fatalf("endpoint/reply = %q/%q, want %q/%q", result.Endpoint, result.Reply, tc.endpoint, tc.reply)
			}
			hdrs := up.headers()
			if got := up.auth(); got != tc.auth {
				t.Errorf("Authorization = %q, want %q", got, tc.auth)
			}
			if got := hdrs.Get("X-Api-Key"); got != tc.xAPIKey {
				t.Errorf("X-Api-Key = %q, want %q", got, tc.xAPIKey)
			}
		})
	}
}

func TestPromptedChannelTestFlagsAnEmptyReply(t *testing.T) {
	h := newHarness(t)

	// A gateway that answers 200 with no content is broken in a way a plain
	// status check would call healthy.
	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{"message": map[string]string{"content": ""}}},
		})
	})
	id := h.createChannel(channelInput{
		Name: "empty-reply", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})

	var result relay.TestResult
	h.do(http.MethodPost, fmt.Sprintf("/api/admin/channels/%d/test", id), h.admin,
		map[string]any{"prompt": "你好"}, &result)

	if result.OK {
		t.Fatalf("an empty reply must not pass: %+v", result)
	}
	if result.Message == "" {
		t.Fatal("an empty reply needs an explanation")
	}
}

func TestChannelTestRejectsAnUnknownTemplate(t *testing.T) {
	h := newHarness(t)

	id := h.createChannel(channelInput{
		Name: "tpl", Type: "openai", BaseURL: "https://example.invalid", APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})

	resp := h.do(http.MethodPost, fmt.Sprintf("/api/admin/channels/%d/test", id), h.admin,
		map[string]any{"prompt_template": "no-such-template"}, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
}

func TestPromptTemplatesEndpoint(t *testing.T) {
	h := newHarness(t)

	var listed struct {
		Data []relay.PromptTemplate `json:"data"`
	}
	resp := h.do(http.MethodGet, "/api/admin/prompt-templates", h.admin, nil, &listed)
	resp.Body.Close()

	if resp.StatusCode != http.StatusOK || len(listed.Data) != 10 {
		t.Fatalf("HTTP %d with %d templates", resp.StatusCode, len(listed.Data))
	}
	for _, template := range listed.Data {
		if template.ID == "" || template.Name == "" || template.Prompt == "" {
			t.Fatalf("incomplete template in response: %+v", template)
		}
	}
}
