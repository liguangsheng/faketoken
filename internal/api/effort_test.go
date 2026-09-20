package api

import (
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/faketoken/faketoken/internal/model"
)

// The channel's own vocabulary is applied on the way out: a caller asking for a
// level this upstream has never heard of is rewritten into the one it accepts,
// rather than having the whole request rejected.
func TestChannelRewritesReasoningEffort(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "effort-map", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-5"}, Groups: []string{"default"},
		ReasoningEffortMapping: model.EffortMapping{"*": {"max": "xhigh"}},
	})
	key := h.createKey()

	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
		`{"model":"gpt-5","reasoning_effort":"max","temperature":0.7}`)
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()

	body := up.body()
	if !strings.Contains(body, `"reasoning_effort":"xhigh"`) {
		t.Fatalf("upstream did not receive the mapped level: %s", body)
	}
	if strings.Contains(body, `"max"`) {
		t.Fatalf("the original level was still sent: %s", body)
	}
	// Everything around the rewritten field has to survive untouched, exactly
	// as it does for a model rewrite.
	if !strings.Contains(body, `"temperature":0.7`) {
		t.Fatalf("the rest of the payload was altered: %s", body)
	}

	// The log says what was asked for and what went out, so an operator can see
	// the substitution happened rather than guessing from a bare level.
	entry := h.waitForLog(t, 1)
	if entry.ReasoningEffort != "max → xhigh" {
		t.Fatalf("reasoning effort = %q, want %q", entry.ReasoningEffort, "max → xhigh")
	}
}

// A channel with no rule for the level the caller sent must stay transparent.
func TestChannelWithoutMatchingEffortRuleForwardsVerbatim(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "effort-partial", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-5"}, Groups: []string{"default"},
		ReasoningEffortMapping: model.EffortMapping{"*": {"max": "xhigh"}},
	})
	key := h.createKey()

	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
		`{"model":"gpt-5","reasoning_effort":"low"}`)
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()

	if body := up.body(); !strings.Contains(body, `"reasoning_effort":"low"`) {
		t.Fatalf("an unmapped level was not forwarded verbatim: %s", body)
	}
	entry := h.waitForLog(t, 1)
	if entry.ReasoningEffort != "low" {
		t.Fatalf("reasoning effort = %q, want low", entry.ReasoningEffort)
	}
}

// The rule survives the round trip through the console API, including the
// case-folding the store applies to the level names.
func TestChannelEffortMappingRoundTrip(t *testing.T) {
	h := newHarness(t)

	id := h.createChannel(channelInput{
		Name: "effort-persist", Type: "openai", BaseURL: "https://up.test", APIKey: "k",
		Models: []string{"gpt-5"}, Groups: []string{"default"},
		ReasoningEffortMapping: model.EffortMapping{
			"*": {"MAX": "xhigh", "  ": "ignored", "medium": "  "},
			// A heading with nothing under it, and one with no name: both are
			// a form still being filled in rather than a rule.
			"gpt-5": {},
			"   ":   {"max": "high"},
		},
	})

	saved := h.channel(id)
	if got := saved.ReasoningEffortMapping["*"]["max"]; got != "xhigh" {
		t.Fatalf("mapping did not persist folded: %+v", saved.ReasoningEffortMapping)
	}
	// A half-filled row is a line still being typed, not a rule.
	if len(saved.ReasoningEffortMapping["*"]) != 1 {
		t.Fatalf("incomplete rules were kept: %+v", saved.ReasoningEffortMapping)
	}
	if len(saved.ReasoningEffortMapping) != 1 {
		t.Fatalf("empty or unnamed selectors were kept: %+v", saved.ReasoningEffortMapping)
	}
}

// The per-model shape replaced a flat table of renames. A script still posting
// the old shape has to keep working, and it means what it always meant: every
// model this channel serves.
func TestChannelEffortMappingAcceptsTheFlatLegacyShape(t *testing.T) {
	h := newHarness(t)

	var created model.Channel
	resp := h.do(http.MethodPost, "/api/admin/channels", h.admin, map[string]any{
		"name": "effort-legacy", "type": "openai", "base_url": "https://up.test",
		"api_key": "k", "models": []string{"gpt-5"}, "groups": []string{"default"},
		"reasoning_effort_mapping": map[string]string{"max": "xhigh"},
	}, &created)
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create with the flat shape: HTTP %d", resp.StatusCode)
	}

	saved := h.channel(created.ID)
	if got := saved.ReasoningEffortMapping["*"]["max"]; got != "xhigh" {
		t.Fatalf("the flat shape did not land under \"*\": %+v", saved.ReasoningEffortMapping)
	}
}

// A rule written against one model must not reach the others, and the wildcard
// keeps covering the levels that model says nothing about.
func TestChannelEffortMappingIsPerModel(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "effort-per-model", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-5", "gpt-5.1", "claude-4"}, Groups: []string{"default"},
		ReasoningEffortMapping: model.EffortMapping{
			"*":       {"max": "xhigh", "minimal": "low"},
			"gpt-5.1": {"max": "high"},
		},
	})
	key := h.createKey()

	send := func(model, effort string) string {
		resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
			fmt.Sprintf(`{"model":%q,"reasoning_effort":%q}`, model, effort))
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		return up.body()
	}

	// The model's own rule wins over the wildcard's for the same level.
	if body := send("gpt-5.1", "max"); !strings.Contains(body, `"reasoning_effort":"high"`) {
		t.Fatalf("the model's own rule did not win: %s", body)
	}
	// A level it says nothing about still comes from the wildcard — merged,
	// not replaced.
	if body := send("gpt-5.1", "minimal"); !strings.Contains(body, `"reasoning_effort":"low"`) {
		t.Fatalf("the wildcard did not cover an unlisted level: %s", body)
	}
	// Another model on the same channel is untouched by that rule.
	if body := send("gpt-5", "max"); !strings.Contains(body, `"reasoning_effort":"xhigh"`) {
		t.Fatalf("a sibling model picked up the per-model rule: %s", body)
	}
}

// One rule should be able to cover a family without naming every snapshot.
func TestChannelEffortMappingMatchesTheLongestPrefix(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "effort-prefix", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-5-mini", "gpt-5.1-codex"}, Groups: []string{"default"},
		ReasoningEffortMapping: model.EffortMapping{
			"*":        {"max": "xhigh"},
			"gpt-5*":   {"max": "high"},
			"gpt-5.1*": {"max": "medium"},
		},
	})
	key := h.createKey()

	send := func(model string) string {
		resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
			fmt.Sprintf(`{"model":%q,"reasoning_effort":"max"}`, model))
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		return up.body()
	}

	if body := send("gpt-5-mini"); !strings.Contains(body, `"reasoning_effort":"high"`) {
		t.Fatalf("the gpt-5* rule did not apply: %s", body)
	}
	// Both prefixes match this one; the longer is the one that meant it.
	if body := send("gpt-5.1-codex"); !strings.Contains(body, `"reasoning_effort":"medium"`) {
		t.Fatalf("the shorter prefix won: %s", body)
	}
}
