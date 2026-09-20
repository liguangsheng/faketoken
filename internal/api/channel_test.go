package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"slices"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/faketoken/faketoken/internal/model"
)

// One box, everything an operator might remember about a channel — except the
// one field that holds secrets.
func TestChannelSearchSpansEveryDescriptiveField(t *testing.T) {
	h := newHarness(t)

	h.createChannel(channelInput{
		Name: "north-gateway", Type: "anthropic", BaseURL: "https://relay.example.test",
		AuthStyle: model.AuthStyleXAPIKey,
		APIKey:    "sk-upstream-secret",
		Models:    []string{"claude-opus-5"}, ModelPrefixes: []string{"gemini-"},
		Groups: []string{"vip"}, TestModel: "claude-haiku",
		ModelMapping: map[string]string{"gpt-4o": "claude-sonnet-4"},
		Note:         "备用线路",
	})
	// A second channel that must not match any of the searches below.
	h.createChannel(channelInput{
		Name: "south", Type: "openai", BaseURL: "https://other.test", APIKey: "k",
		Models: []string{"gpt-3.5"}, Groups: []string{"default"},
	})

	for _, tc := range []struct{ name, keyword string }{
		{"name", "north"},
		{"base url", "relay.example"},
		{"auth style", "x-api-key"},
		{"note", "备用"},
		{"test model", "haiku"},
		{"served model", "opus"},
		{"model prefix", "gemini-"},
		{"group", "vip"},
		{"mapping source", "gpt-4o"},
		{"mapping target", "claude-sonnet"},
		{"case insensitive", "NORTH-GATEWAY"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var listed page[*model.Channel]
			resp := h.do(http.MethodGet,
				"/api/admin/channels?keyword="+url.QueryEscape(tc.keyword), h.admin, nil, &listed)
			resp.Body.Close()
			if len(listed.Data) != 1 || listed.Data[0].Name != "north-gateway" {
				t.Fatalf("searching %q matched %d channels", tc.keyword, len(listed.Data))
			}
		})
	}

	// The upstream credential is not searchable: a field that can be probed a
	// character at a time can be read a character at a time.
	var listed page[*model.Channel]
	resp := h.do(http.MethodGet, "/api/admin/channels?keyword=sk-upstream", h.admin, nil, &listed)
	resp.Body.Close()
	if len(listed.Data) != 0 {
		t.Fatalf("the upstream key is searchable: %d matches", len(listed.Data))
	}

	// And a literal wildcard stays literal.
	resp = h.do(http.MethodGet, "/api/admin/channels?keyword="+url.QueryEscape("%"),
		h.admin, nil, &listed)
	resp.Body.Close()
	if len(listed.Data) != 0 {
		t.Fatalf("%% behaved as a wildcard and matched %d channels", len(listed.Data))
	}
}

// The list is ordered the way traffic is: enabled channels first, then by
// priority, then by the weight that splits one priority band. A disabled
// channel sorted among the live ones by its old priority reads as part of the
// routing when it serves nothing.
func TestChannelListOrdersEnabledFirstThenPriorityThenWeight(t *testing.T) {
	h := newHarness(t)

	// Insertion order matches none of the sort keys, and the heavier of the two
	// priority-500 channels is created first on purpose: with a descending id
	// as the only tiebreaker the lighter one would come out on top, so the
	// weight step is what has to put the heavier one there.
	for _, c := range []struct {
		name     string
		status   int16
		priority int32
		weight   int32
	}{
		{"disabled-top-priority", model.StatusDisabled, 900, 50},
		{"enabled-high-priority-heavier", model.StatusEnabled, 500, 9},
		{"enabled-low-priority", model.StatusEnabled, 10, 99},
		{"enabled-high-priority", model.StatusEnabled, 500, 1},
		{"disabled-low-priority", model.StatusDisabled, 5, 1},
	} {
		h.createChannel(channelInput{
			Name: c.name, BaseURL: "https://" + c.name + ".test", APIKey: "k",
			Status: c.status, Priority: c.priority, Weight: c.weight,
			Models: []string{"gpt-4o"},
		})
	}

	var listed page[*model.Channel]
	resp := h.do(http.MethodGet, "/api/admin/channels", h.admin, nil, &listed)
	resp.Body.Close()

	want := []string{
		"enabled-high-priority-heavier", // priority 500, weight 9, lower id
		"enabled-high-priority",         // priority 500, weight 1
		"enabled-low-priority",          // priority 10 — weight 99 does not lift it
		"disabled-top-priority",         // disabled, despite priority 900
		"disabled-low-priority",
	}
	got := make([]string, 0, len(listed.Data))
	for _, c := range listed.Data {
		got = append(got, c.Name)
	}
	if !slices.Equal(got, want) {
		t.Fatalf("channel order\n got %v\nwant %v", got, want)
	}
}

// The console masks the upstream key everywhere it is listed, so moving a
// channel elsewhere used to mean reading it out of the database. This endpoint
// exists to hand it over deliberately — and only to an administrator.
func TestChannelCredentialIsRevealedToAdminsOnly(t *testing.T) {
	h := newHarness(t)

	id := h.createChannel(channelInput{
		Name: "movable", Type: "openai", BaseURL: "https://upstream.test/v1",
		APIKey: "sk-the-real-upstream-key",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})

	var cred struct {
		BaseURL string `json:"base_url"`
		APIKey  string `json:"api_key"`
	}
	resp := h.do(http.MethodGet, fmt.Sprintf("/api/admin/channels/%d/credential", id),
		h.admin, nil, &cred)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("credential: HTTP %d, want 200", resp.StatusCode)
	}
	if cred.APIKey != "sk-the-real-upstream-key" {
		t.Fatalf("returned %q, want the key in the clear", cred.APIKey)
	}
	if cred.BaseURL != "https://upstream.test/v1" {
		t.Fatalf("returned base url %q", cred.BaseURL)
	}

	// The listing must still hide it, or this endpoint would be pointless.
	var listed page[*model.Channel]
	resp = h.do(http.MethodGet, "/api/admin/channels", h.admin, nil, &listed)
	resp.Body.Close()
	if listed.Data[0].APIKey == "sk-the-real-upstream-key" {
		t.Fatal("the listing exposed the upstream key")
	}

	// A regular account has no business reading an upstream credential.
	h.do(http.MethodPost, "/api/admin/users", h.admin, map[string]any{
		"username": "peon3", "password": "password123",
	}, nil)
	var session sessionResponse
	h.do(http.MethodPost, "/api/auth/login", "",
		credentials{Username: "peon3", Password: "password123"}, &session)

	resp = h.do(http.MethodGet, fmt.Sprintf("/api/admin/channels/%d/credential", id),
		session.Token, nil, nil)
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("a regular user read the credential: HTTP %d", resp.StatusCode)
	}
	if strings.Contains(string(body), "sk-the-real-upstream-key") {
		t.Fatalf("the key leaked in the refusal: %s", body)
	}
}

func TestChannelRequiresABaseURL(t *testing.T) {
	h := newHarness(t)

	resp := h.do(http.MethodPost, "/api/admin/channels", h.admin, channelInput{
		Name: "default-host", Type: "anthropic", APIKey: "k",
		Models: []string{"claude-3"}, Groups: []string{"default"},
	}, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
}

func TestChannelTypeIsCompatibilityInputOnly(t *testing.T) {
	h := newHarness(t)

	resp := h.do(http.MethodPost, "/api/admin/channels", h.admin, map[string]any{
		"name": "type-free", "type": "anthropic", "base_url": "https://upstream.test",
		"api_key": "k", "models": []string{"gpt-4o"}, "groups": []string{"default"},
	}, nil)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		raw, _ := io.ReadAll(resp.Body)
		t.Fatalf("HTTP %d: %s", resp.StatusCode, raw)
	}

	var created map[string]json.RawMessage
	if err := json.NewDecoder(resp.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	if _, exists := created["type"]; exists {
		t.Fatalf("channel response still contains type: %v", created)
	}
	var authStyle string
	if err := json.Unmarshal(created["auth_style"], &authStyle); err != nil {
		t.Fatal(err)
	}
	if authStyle != model.AuthStyleAuto {
		t.Fatalf("auth_style = %q, want auto", authStyle)
	}

	var hasType, hasAuthStyle bool
	err := h.pool.QueryRow(context.Background(), `SELECT
		EXISTS (SELECT 1 FROM information_schema.columns
			WHERE table_schema = 'public' AND table_name = 'channels' AND column_name = 'type'),
		EXISTS (SELECT 1 FROM information_schema.columns
			WHERE table_schema = 'public' AND table_name = 'channels' AND column_name = 'auth_style')`).
		Scan(&hasType, &hasAuthStyle)
	if err != nil {
		t.Fatal(err)
	}
	if hasType || !hasAuthStyle {
		t.Fatalf("schema columns: type=%v auth_style=%v", hasType, hasAuthStyle)
	}
}

// The console edits priority and weight straight from the channel table, which
// has no plaintext credential to send back. That is why they get a narrow
// endpoint rather than reusing the full update: this test pins both halves of
// the deal — the change has to reach the selector, and the upstream key has to
// survive it.
func TestChannelRoutingEditMovesTrafficAndKeepsTheCredential(t *testing.T) {
	h := newHarness(t)

	preferred := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "from the preferred channel", 2, 3)
	})
	promoted := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "from the promoted channel", 2, 3)
	})

	h.createChannel(channelInput{
		Name: "incumbent", Type: "openai", BaseURL: preferred.URL, APIKey: "sk-incumbent",
		Models: []string{"gpt-4o"}, Groups: []string{"default"}, Priority: 100, Weight: 1,
	})
	id := h.createChannel(channelInput{
		Name: "challenger", Type: "openai", BaseURL: promoted.URL, APIKey: "sk-challenger",
		Models: []string{"gpt-4o"}, Groups: []string{"default"}, Priority: 1, Weight: 1,
	})

	key := h.createKey()
	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"gpt-4o"}`)
	resp.Body.Close()
	if preferred.requests.Load() != 1 || promoted.requests.Load() != 0 {
		t.Fatalf("the higher priority channel should have served the call, got %d and %d",
			preferred.requests.Load(), promoted.requests.Load())
	}

	// Weight 0 goes in deliberately: selection treats weight as a share of the
	// draw, so the server clamps it rather than leaving a channel that is
	// enabled but can never be picked.
	var updated model.Channel
	resp = h.do(http.MethodPut, fmt.Sprintf("/api/admin/channels/%d/routing", id), h.admin,
		map[string]any{"priority": 500, "weight": 0}, &updated)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("routing update: HTTP %d, want 200", resp.StatusCode)
	}
	if updated.Priority != 500 || updated.Weight != 1 {
		t.Fatalf("stored priority %d weight %d, want 500 and the clamped 1",
			updated.Priority, updated.Weight)
	}
	if updated.APIKey == "sk-challenger" {
		t.Fatal("the response exposed the upstream key")
	}

	// The routing rows carry their own copy of both numbers, so a write that
	// only touched the channel row would leave the selector on the old order.
	resp = h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"gpt-4o"}`)
	resp.Body.Close()
	if promoted.requests.Load() != 1 {
		t.Fatalf("the promoted channel was not selected, got %d calls", promoted.requests.Load())
	}
	if preferred.requests.Load() != 1 {
		t.Fatalf("the demoted channel served %d calls, want the original 1",
			preferred.requests.Load())
	}

	// The listing only ever holds a masked key. Had the console reused the full
	// update, that mask is what would now be encrypted in the database.
	var cred struct {
		APIKey string `json:"api_key"`
	}
	resp = h.do(http.MethodGet, fmt.Sprintf("/api/admin/channels/%d/credential", id),
		h.admin, nil, &cred)
	resp.Body.Close()
	if cred.APIKey != "sk-challenger" {
		t.Fatalf("credential is now %q, want the original upstream key", cred.APIKey)
	}
}

func TestChannelKeysAreEncryptedAtRestAndMaskedInTheAPI(t *testing.T) {
	h := newHarness(t)

	id := h.createChannel(channelInput{
		Name: "secretive", Type: "openai", BaseURL: "https://example.invalid",
		APIKey: "sk-super-secret-value", Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})

	var stored string
	if err := h.pool.QueryRow(context.Background(),
		`SELECT api_key_enc FROM channels WHERE id = $1`, id).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(stored, "super-secret") {
		t.Fatal("the upstream credential was stored in plaintext")
	}

	var fetched model.Channel
	h.do(http.MethodGet, fmt.Sprintf("/api/admin/channels/%d", id), h.admin, nil, &fetched)
	if strings.Contains(fetched.APIKey, "super-secret") {
		t.Fatalf("the API returned the raw credential: %q", fetched.APIKey)
	}

	// An empty api_key on update must preserve the stored one.
	h.do(http.MethodPut, fmt.Sprintf("/api/admin/channels/%d", id), h.admin, channelInput{
		Name: "secretive", Type: "openai", BaseURL: "https://example.invalid",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	}, nil)

	ch, err := h.store.GetChannel(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	if ch.APIKey != "sk-super-secret-value" {
		t.Fatalf("the credential was lost on update: %q", ch.APIKey)
	}
}

func TestChannelModelFilterMatchesFragments(t *testing.T) {
	h := newHarness(t)

	h.createChannel(channelInput{
		Name: "claude-house", Type: "anthropic", BaseURL: "https://example.invalid", APIKey: "k",
		Models: []string{"claude-opus-5", "claude-sonnet-5"}, Groups: []string{"default"},
	})
	h.createChannel(channelInput{
		Name: "gpt-house", Type: "openai", BaseURL: "https://example.invalid", APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	// A prefix channel serves the family without listing any model name.
	h.createChannel(channelInput{
		Name: "prefix-house", Type: "anthropic", BaseURL: "https://example.invalid", APIKey: "k",
		ModelPrefixes: []string{"claude-"}, Groups: []string{"default"},
	})
	// A literal percent sign must stay literal rather than acting as a wildcard.
	h.createChannel(channelInput{
		Name: "odd-house", Type: "openai", BaseURL: "https://example.invalid", APIKey: "k",
		Models: []string{"weird%model"}, Groups: []string{"default"},
	})

	names := func(query string) []string {
		t.Helper()
		var listed page[*model.Channel]
		h.do(http.MethodGet, "/api/admin/channels?page_size=50&"+query, h.admin, nil, &listed)
		out := make([]string, 0, len(listed.Data))
		for _, channel := range listed.Data {
			out = append(out, channel.Name)
		}
		sort.Strings(out)
		return out
	}

	// A fragment matches both an exact model list and a prefix entry.
	got := names("model=claude")
	want := []string{"claude-house", "prefix-house"}
	if !slices.Equal(got, want) {
		t.Fatalf("model=claude -> %v, want %v", got, want)
	}

	// Case-insensitive, and a mid-string fragment still matches.
	if got := names("model=OPUS"); !slices.Equal(got, []string{"claude-house"}) {
		t.Fatalf("model=OPUS -> %v", got)
	}

	// A full name keeps working, so the filter stays a superset of the old one.
	if got := names("model=gpt-4o"); !slices.Equal(got, []string{"gpt-house"}) {
		t.Fatalf("model=gpt-4o -> %v", got)
	}

	if got := names("model=nothing-here"); len(got) != 0 {
		t.Fatalf("unmatched fragment returned %v", got)
	}

	// "%" would match everything if the term were treated as a LIKE pattern.
	if got := names("model=%25"); !slices.Equal(got, []string{"odd-house"}) {
		t.Fatalf("a literal %% was treated as a wildcard: %v", got)
	}
}

func TestChannelNamesAreUnique(t *testing.T) {
	h := newHarness(t)

	in := channelInput{
		Name: "duplicate", Type: "openai", BaseURL: "https://example.invalid", APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	}
	h.createChannel(in)

	resp := h.do(http.MethodPost, "/api/admin/channels", h.admin, in, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("duplicate name status = %d, want 409", resp.StatusCode)
	}
}

func TestUpdateChannelRejectsAnEmptyName(t *testing.T) {
	h := newHarness(t)

	id := h.createChannel(channelInput{
		Name: "named", Type: "openai", BaseURL: "https://example.invalid", APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})

	resp := h.do(http.MethodPut, fmt.Sprintf("/api/admin/channels/%d", id), h.admin,
		channelInput{Name: "  ", Type: "openai", Models: []string{"gpt-4o"}}, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("blank name status = %d, want 400", resp.StatusCode)
	}

	ch, err := h.store.GetChannel(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	if ch.Name != "named" {
		t.Fatalf("the name was overwritten: %q", ch.Name)
	}
}

func TestCloneChannelCopiesTheCredentialAndStaysDisabled(t *testing.T) {
	h := newHarness(t)

	id := h.createChannel(channelInput{
		Name: "origin", Type: "openai", BaseURL: "https://example.invalid",
		APIKey: "sk-original-secret", Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})

	var clone model.Channel
	resp := h.do(http.MethodPost, fmt.Sprintf("/api/admin/channels/%d/clone", id), h.admin, nil, &clone)
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("clone status = %d, want 201", resp.StatusCode)
	}
	if clone.Name != "origin 副本" {
		t.Fatalf("clone name = %q", clone.Name)
	}
	if clone.Status != model.StatusDisabled {
		t.Fatalf("a clone must start disabled, got status %d", clone.Status)
	}
	if strings.Contains(clone.APIKey, "original") {
		t.Fatalf("the clone response leaked the credential: %q", clone.APIKey)
	}

	stored, err := h.store.GetChannel(context.Background(), clone.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.APIKey != "sk-original-secret" {
		t.Fatalf("the credential was not copied: %q", stored.APIKey)
	}

	// Cloning twice must not collide on the generated name.
	var second model.Channel
	resp = h.do(http.MethodPost, fmt.Sprintf("/api/admin/channels/%d/clone", id), h.admin, nil, &second)
	resp.Body.Close()
	if second.Name != "origin 副本 2" {
		t.Fatalf("second clone name = %q", second.Name)
	}
}

func TestBatchStatusAndDeleteChannels(t *testing.T) {
	h := newHarness(t)

	first := h.createChannel(channelInput{
		Name: "bulk-a", Type: "openai", BaseURL: "https://example.invalid", APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	second := h.createChannel(channelInput{
		Name: "bulk-b", Type: "openai", BaseURL: "https://example.invalid", APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	ids := []int64{first, second}

	var disabled struct {
		Updated int64 `json:"updated"`
	}
	h.do(http.MethodPost, "/api/admin/channels/batch/status", h.admin,
		map[string]any{"ids": ids, "status": 2}, &disabled)
	if disabled.Updated != 2 {
		t.Fatalf("updated = %d, want 2", disabled.Updated)
	}

	// Routing must follow the bulk switch, not just the channel rows.
	candidates, err := h.store.Candidates(context.Background(), "default", "gpt-4o", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 0 {
		t.Fatalf("disabled channels are still routable: %+v", candidates)
	}

	var removed struct {
		Deleted int64 `json:"deleted"`
	}
	h.do(http.MethodPost, "/api/admin/channels/batch/delete", h.admin,
		map[string]any{"ids": ids}, &removed)
	if removed.Deleted != 2 {
		t.Fatalf("deleted = %d, want 2", removed.Deleted)
	}
}

func TestBatchActionsRejectAnEmptySelection(t *testing.T) {
	h := newHarness(t)

	resp := h.do(http.MethodPost, "/api/admin/channels/batch/delete", h.admin,
		map[string]any{"ids": []int64{}}, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("empty selection status = %d, want 400", resp.StatusCode)
	}
}

// listChannels reads one side of the split listing, the way the console does.
// It also asserts the reported total matches the rows handed back: the console
// prints that count in a collapsed header, so a total describing a different
// set than the rows is its own bug.
func (h *harness) listChannels(query string) []*model.Channel {
	h.t.Helper()
	var listed page[*model.Channel]
	resp := h.do(http.MethodGet, "/api/admin/channels?"+query, h.admin, nil, &listed)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		h.t.Fatalf("list channels %q: HTTP %d", query, resp.StatusCode)
	}
	if int64(len(listed.Data)) != listed.Total {
		h.t.Fatalf("list %q reported total %d but returned %d rows",
			query, listed.Total, len(listed.Data))
	}
	return listed.Data
}

// A rebuild has to serialise against channel writes, because it clears the
// whole routing table and refills it from a list of channels.
//
// Any rebuild that runs to completion while a channel write is in flight has by
// definition built the table from a snapshot that excludes that channel, having
// cleared rows that may include it — so whether the row survives comes down to
// which side commits first. Holding an uncommitted insert pins that ordering:
// the rebuild must wait rather than quietly finish without the channel.
func TestRebuildKeepsAChannelWrittenWhileItRuns(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	h.createChannel(channelInput{
		Name: "existing", Type: "openai", BaseURL: "http://upstream.test", APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})

	// Stand in for a CreateChannel that has not committed yet: the channel row
	// and its routing rows, written together as the store writes them.
	tx, err := h.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var racerID int64
	if err := tx.QueryRow(ctx, `INSERT INTO channels
		(name, base_url, auth_style, status, priority, weight, channel_groups, models)
		VALUES ('racer', 'http://upstream.test', 'auto', 1, 0, 1,
		        ARRAY['default'], ARRAY['racer-model'])
		RETURNING id`).Scan(&racerID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO abilities
		(group_name, model, channel_id, priority, weight, enabled)
		VALUES ('default', 'racer-model', $1, 0, 1, TRUE)`, racerID); err != nil {
		t.Fatal(err)
	}

	rebuilt := make(chan int, 1)
	go func() {
		resp := h.do(http.MethodPost, "/api/admin/channels/rebuild", h.admin, nil, nil)
		resp.Body.Close()
		rebuilt <- resp.StatusCode
	}()

	// Give the rebuild time to reach the point where it reads the channel list
	// and starts clearing the table.
	select {
	case status := <-rebuilt:
		t.Fatalf("rebuild finished before the concurrent write committed (HTTP %d); "+
			"it must not be able to skip past an in-flight channel", status)
	case <-time.After(500 * time.Millisecond):
	}

	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	select {
	case status := <-rebuilt:
		if status != http.StatusOK {
			t.Fatalf("rebuild: HTTP %d, want 200", status)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("rebuild never completed")
	}

	for _, tc := range []struct{ name, served string }{
		{"racer", "racer-model"},
		{"existing", "gpt-4o"},
	} {
		candidates, err := h.store.Candidates(ctx, "default", tc.served, "")
		if err != nil {
			t.Fatal(err)
		}
		if len(candidates) == 0 {
			t.Fatalf("%s lost its routing: the rebuild cleared it without writing it back",
				tc.name)
		}
	}
}

// A channel's own retry policy has to survive a create and an update: the relay
// reads it per attempt, so a column that quietly stayed 0 would make the
// console's field do nothing at all.
func TestChannelRetryPolicyRoundTrip(t *testing.T) {
	h := newHarness(t)

	id := h.createChannel(channelInput{
		Name: "retry-persist", Type: "openai", BaseURL: "https://up.test", APIKey: "k",
		Models: []string{"gpt-5"}, Groups: []string{"default"},
		RetryCount: 4, RetryBackoffMS: 750,
	})

	saved := h.channel(id)
	if saved.RetryCount != 4 || saved.RetryBackoffMS != 750 {
		t.Fatalf("retry policy did not persist: count=%d backoff=%d",
			saved.RetryCount, saved.RetryBackoffMS)
	}

	// Clearing it is the same write path, and the way a channel goes back to the
	// global behaviour.
	var updated model.Channel
	body := map[string]any{
		"name": "retry-persist", "base_url": "https://up.test", "api_key": "",
		"models": []string{"gpt-5"}, "groups": []string{"default"},
		"retry_count": 0, "retry_backoff_ms": 0,
	}
	resp := h.do(http.MethodPut, fmt.Sprintf("/api/admin/channels/%d", id), h.admin, body, &updated)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("update channel: HTTP %d", resp.StatusCode)
	}
	if cleared := h.channel(id); cleared.RetryCount != 0 || cleared.RetryBackoffMS != 0 {
		t.Fatalf("cleared policy did not persist: count=%d backoff=%d",
			cleared.RetryCount, cleared.RetryBackoffMS)
	}
}

// A count the relay would have to honour by hammering one upstream is refused
// at write time instead of being clamped silently.
func TestChannelRetryPolicyRejectsOutOfRange(t *testing.T) {
	h := newHarness(t)

	var created map[string]any
	resp := h.do(http.MethodPost, "/api/admin/channels", h.admin, map[string]any{
		"name": "retry-range", "type": "openai", "base_url": "https://up.test",
		"api_key": "k", "models": []string{"gpt-5"}, "groups": []string{"default"},
		"retry_count": 21,
	}, &created)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("retry_count 21: HTTP %d, want 400", resp.StatusCode)
	}
}
