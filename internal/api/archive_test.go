package api

import (
	"context"
	"fmt"
	"net/http"
	"testing"

	"github.com/faketoken/faketoken/internal/model"
)

// archive is the request the console's 归档 / 取消归档 actions make.
func (h *harness) archive(id int64, archived bool) model.Channel {
	h.t.Helper()
	var updated model.Channel
	resp := h.do(http.MethodPut, fmt.Sprintf("/api/admin/channels/%d/archive", id), h.admin,
		map[string]any{"archived": archived}, &updated)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		h.t.Fatalf("archive(%t): HTTP %d", archived, resp.StatusCode)
	}
	return updated
}

// The whole point of the feature: a channel folded away in the console must not
// keep answering requests from behind that fold. Archiving an enabled channel
// disables it and clears its routing in the same step.
func TestArchivingAChannelTakesItOutOfRotation(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	id := h.createChannel(channelInput{
		Name: "to-archive", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	// Served before, so the 404 below is the archive's doing and not a channel
	// that never worked.
	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"gpt-4o"}`)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("channel did not serve before archiving: HTTP %d", resp.StatusCode)
	}

	archived := h.archive(id, true)
	if !archived.Archived {
		t.Fatal("the response does not report the channel as archived")
	}
	if archived.Status != model.StatusDisabled {
		t.Fatalf("archiving left status = %d, want disabled", archived.Status)
	}

	// The routing tables carry their own copy of enabled, and they are what
	// selection actually reads.
	candidates, err := h.store.Candidates(context.Background(), "default", "gpt-4o", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 0 {
		t.Fatalf("an archived channel is still routable: %+v", candidates)
	}

	resp = h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"gpt-4o"}`)
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("an archived channel still served traffic: HTTP %d", resp.StatusCode)
	}
}

// The console renders two lists, so each side has to report a total that
// matches the rows it hands back.
func TestArchivedChannelsLeaveTheMainListing(t *testing.T) {
	h := newHarness(t)

	live := h.createChannel(channelInput{
		Name: "live", Type: "openai", BaseURL: "https://example.invalid", APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	shelved := h.createChannel(channelInput{
		Name: "shelved", Type: "openai", BaseURL: "https://example.invalid", APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	h.archive(shelved, true)

	if rows := h.listChannels("archived=false"); len(rows) != 1 || rows[0].ID != live {
		t.Fatalf("the live listing should hold only #%d, got %+v", live, rows)
	}
	if rows := h.listChannels("archived=true"); len(rows) != 1 || rows[0].ID != shelved {
		t.Fatalf("the archive should hold only #%d, got %+v", shelved, rows)
	}
	// A client that never learned about the parameter keeps seeing every
	// channel, rather than silently losing the archived ones.
	if rows := h.listChannels(""); len(rows) != 2 {
		t.Fatalf("an unfiltered listing should hold both channels, got %d", len(rows))
	}
}

// Unarchiving restores the row and nothing else. Putting a channel back into
// rotation is a separate, deliberate act — otherwise clearing a shelf quietly
// sends traffic to every upstream that was on it.
func TestUnarchivingRestoresTheRowButLeavesItDisabled(t *testing.T) {
	h := newHarness(t)

	id := h.createChannel(channelInput{
		Name: "round-trip", Type: "openai", BaseURL: "https://example.invalid", APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	h.archive(id, true)

	restored := h.archive(id, false)
	if restored.Archived {
		t.Fatal("the channel is still archived")
	}
	if restored.Status != model.StatusDisabled {
		t.Fatalf("unarchiving enabled the channel: status = %d", restored.Status)
	}
	candidates, err := h.store.Candidates(context.Background(), "default", "gpt-4o", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 0 {
		t.Fatalf("unarchiving put the channel straight back into rotation: %+v", candidates)
	}

	// Enabling by hand is what returns it to service, and that has to work.
	resp := h.do(http.MethodPut, fmt.Sprintf("/api/admin/channels/%d/status", id), h.admin,
		map[string]any{"status": 1}, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("enabling an unarchived channel = %d, want 200", resp.StatusCode)
	}
	candidates, err = h.store.Candidates(context.Background(), "default", "gpt-4o", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 1 {
		t.Fatalf("an unarchived, enabled channel is not routable: %+v", candidates)
	}
}

// Every other way to enable a channel has to respect the archive too, or the
// invariant holds only for the one path the console happens to use.
func TestAnArchivedChannelCannotBeEnabledWithoutUnarchiving(t *testing.T) {
	h := newHarness(t)

	id := h.createChannel(channelInput{
		Name: "shelved", Type: "openai", BaseURL: "https://example.invalid", APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	h.archive(id, true)

	// The status toggle is refused outright: it belongs to the listing this row
	// has left, so a request naming an archived channel is a stale one.
	resp := h.do(http.MethodPut, fmt.Sprintf("/api/admin/channels/%d/status", id), h.admin,
		map[string]any{"status": 1}, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status toggle on an archived channel = %d, want 400", resp.StatusCode)
	}

	// The edit form carries a status field, so saving it must not be a way in
	// either. The rest of the edit still applies.
	var edited model.Channel
	resp = h.do(http.MethodPut, fmt.Sprintf("/api/admin/channels/%d", id), h.admin,
		channelInput{
			Name: "shelved", Type: "openai", BaseURL: "https://example.invalid",
			Models: []string{"gpt-4o"}, Groups: []string{"default"},
			Status: model.StatusEnabled, Note: "edited while archived",
		}, &edited)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("editing an archived channel = %d, want 200", resp.StatusCode)
	}
	if edited.Status != model.StatusDisabled {
		t.Fatalf("an edit enabled an archived channel: status = %d", edited.Status)
	}
	if edited.Note != "edited while archived" {
		t.Fatalf("the edit itself was not applied: note = %q", edited.Note)
	}

	// A bulk enable skips archived rows instead of failing: the selection was
	// made in a listing they are not part of.
	var bulk struct {
		Updated int64 `json:"updated"`
	}
	h.do(http.MethodPost, "/api/admin/channels/batch/status", h.admin,
		map[string]any{"ids": []int64{id}, "status": 1}, &bulk)
	if bulk.Updated != 0 {
		t.Fatalf("a bulk enable touched %d archived channels, want 0", bulk.Updated)
	}

	candidates, err := h.store.Candidates(context.Background(), "default", "gpt-4o", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 0 {
		t.Fatalf("an archived channel became routable: %+v", candidates)
	}
	if fetched := h.channel(id); !fetched.Archived {
		t.Fatal("the channel lost its archived flag")
	}
}

// A rebuild derives the routing tables from the channel rows, so it has to
// arrive at the same answer archiving did. Without this it is a way to hand an
// archived channel its routes back.
func TestRebuildKeepsArchivedChannelsUnroutable(t *testing.T) {
	h := newHarness(t)

	id := h.createChannel(channelInput{
		Name: "shelved", Type: "openai", BaseURL: "https://example.invalid", APIKey: "k",
		Models: []string{"gpt-4o"}, ModelPrefixes: []string{"gpt-"}, Groups: []string{"default"},
	})
	h.archive(id, true)

	resp := h.do(http.MethodPost, "/api/admin/channels/rebuild", h.admin, nil, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("rebuild = %d, want 200", resp.StatusCode)
	}

	// Both routing sources: the exact model list and the prefix table.
	for _, requested := range []string{"gpt-4o", "gpt-4.1"} {
		candidates, err := h.store.Candidates(context.Background(), "default", requested, "")
		if err != nil {
			t.Fatal(err)
		}
		if len(candidates) != 0 {
			t.Fatalf("a rebuild made the archived channel routable for %s: %+v",
				requested, candidates)
		}
	}
}

// Cloning an archived channel is how a retired configuration gets reused, so
// the copy belongs in the listing — disabled, like every other clone.
func TestCloningAnArchivedChannelProducesALiveRow(t *testing.T) {
	h := newHarness(t)

	id := h.createChannel(channelInput{
		Name: "shelved", Type: "openai", BaseURL: "https://example.invalid", APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	h.archive(id, true)

	var clone model.Channel
	resp := h.do(http.MethodPost, fmt.Sprintf("/api/admin/channels/%d/clone", id), h.admin,
		nil, &clone)
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("clone = %d, want 201", resp.StatusCode)
	}
	if clone.Archived {
		t.Fatal("the clone was created archived")
	}
	if clone.Status != model.StatusDisabled {
		t.Fatalf("clone status = %d, want disabled", clone.Status)
	}
}
