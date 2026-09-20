package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/faketoken/faketoken/internal/model"
	"github.com/faketoken/faketoken/internal/store"
)

func TestQuickImportParsesPastedTextAndPullsModels(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []map[string]string{{"id": "gpt-4o"}, {"id": "gpt-4o-mini"}},
		})
	})

	var preview channelImportPreview
	resp := h.do(http.MethodPost, "/api/admin/channels/import", h.admin, channelImportInput{
		Text: fmt.Sprintf("接口地址 %s/v1/chat/completions\nAPI Key: sk-import-test-0123456789", up.URL),
	}, &preview)
	resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("import status = %d", resp.StatusCode)
	}
	if preview.APIKey != "sk-import-test-0123456789" {
		t.Fatalf("api key = %q", preview.APIKey)
	}
	if !strings.HasSuffix(preview.BaseURL, "/v1") {
		t.Fatalf("base url kept the endpoint path: %q", preview.BaseURL)
	}
	if preview.AuthStyle != model.AuthStyleAuto {
		t.Fatalf("auth style = %q", preview.AuthStyle)
	}
	if len(preview.Models) != 2 || preview.ModelError != "" {
		t.Fatalf("models = %v, error = %q", preview.Models, preview.ModelError)
	}
	if preview.Existing != nil {
		t.Fatalf("unexpected existing channel: %+v", preview.Existing)
	}
	// Nothing may be written before the operator saves the reviewed draft.
	if _, total, err := h.store.ListChannels(context.Background(), store.ChannelFilter{Limit: 10}); err != nil || total != 0 {
		t.Fatalf("import created %d channel(s) (err %v)", total, err)
	}
}

func TestQuickImportReportsAnExistingChannelAndAProbeFailure(t *testing.T) {
	h := newHarness(t)

	// A channel named after the host the paste points at.
	id := h.createChannel(channelInput{
		Name: "example.com", Type: "openai", BaseURL: "https://api.example.com",
		APIKey: "k", Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})

	var preview channelImportPreview
	h.do(http.MethodPost, "/api/admin/channels/import", h.admin, channelImportInput{
		Text: "https://api.example.com/v1 sk-existing-channel-0123456789",
	}, &preview)

	if preview.Existing == nil || preview.Existing.ID != id {
		t.Fatalf("existing channel not reported: %+v", preview.Existing)
	}
	// The upstream is unreachable, which must degrade to a message rather than
	// throwing away the address and credential the operator just pasted.
	if preview.ModelError == "" {
		t.Fatal("a failed probe must be reported")
	}
	if preview.BaseURL == "" || preview.APIKey == "" {
		t.Fatalf("a failed probe discarded the draft: %+v", preview)
	}
}

func TestImportPreviewReusesTheStoredKeyWithoutEchoingIt(t *testing.T) {
	h := newHarness(t)

	var seenAuth atomic.Value
	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		seenAuth.Store(r.Header.Get("Authorization"))
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []map[string]string{{"id": "gpt-4o"}},
		})
	})
	id := h.createChannel(channelInput{
		Name: "stored-key", Type: "openai", BaseURL: up.URL, APIKey: "sk-stored-secret",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})

	// The edit form leaves the key blank to mean "keep the stored one", so the
	// probe has to reach for it server-side.
	var preview channelImportPreview
	h.do(http.MethodPost, "/api/admin/channels/import", h.admin, channelImportInput{
		ChannelID: id, BaseURL: up.URL,
	}, &preview)

	if len(preview.Models) != 1 || preview.ModelError != "" {
		t.Fatalf("probe failed: models=%v error=%q", preview.Models, preview.ModelError)
	}
	if got, _ := seenAuth.Load().(string); got != "Bearer sk-stored-secret" {
		t.Fatalf("upstream saw %q, want the stored credential", got)
	}
	if preview.APIKey != "" {
		t.Fatalf("the stored credential was echoed back to the browser: %q", preview.APIKey)
	}
}

func TestQuickImportRejectsTextWithoutAnAddress(t *testing.T) {
	h := newHarness(t)

	resp := h.do(http.MethodPost, "/api/admin/channels/import", h.admin,
		channelImportInput{Text: "请联系管理员开通", SkipModels: true}, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
}

func TestQuickImportHonoursExplicitOverrides(t *testing.T) {
	h := newHarness(t)

	var preview channelImportPreview
	h.do(http.MethodPost, "/api/admin/channels/import", h.admin, channelImportInput{
		Text:       "https://api.wrong.test/v1 sk-wrong-key-0123456789",
		BaseURL:    "https://api.right.test/v1/chat/completions",
		APIKey:     "sk-ant-corrected-0123456789",
		AuthStyle:  model.AuthStyleXAPIKey,
		SkipModels: true,
	}, &preview)

	if preview.BaseURL != "https://api.right.test/v1" {
		t.Fatalf("override ignored: %q", preview.BaseURL)
	}
	if preview.APIKey != "sk-ant-corrected-0123456789" {
		t.Fatalf("key override ignored: %q", preview.APIKey)
	}
	if preview.AuthStyle != model.AuthStyleXAPIKey {
		t.Fatalf("auth style override ignored: %q", preview.AuthStyle)
	}
	if preview.SuggestedName != "right.test" {
		t.Fatalf("name = %q", preview.SuggestedName)
	}
}
