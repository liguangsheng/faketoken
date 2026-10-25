package api

import (
	"context"
	"fmt"
	"net/http"
	"testing"

	"github.com/faketoken/faketoken/internal/model"
	"github.com/faketoken/faketoken/internal/store"
)

// logCall writes a settled call straight into the log, the way the relay's
// bookkeeping does, so a test can shape the history it reads back.
func (h *harness) logCall(t *testing.T, l model.RequestLog) {
	t.Helper()
	if l.UserID == 0 {
		l.UserID, l.Username = 1, "admin"
	}
	if err := h.store.InsertLog(context.Background(), &l); err != nil {
		t.Fatal(err)
	}
}

func TestRankingsAreBySpendAndSkipCallsThatCostNothing(t *testing.T) {
	h := newHarness(t)
	for range 3 {
		h.logCall(t, model.RequestLog{Model: "many-cheap", UpstreamModel: "many-cheap",
			StatusCode: 200, Cost: 1_000, TotalTokens: 10})
	}
	h.logCall(t, model.RequestLog{Model: "one-dear", UpstreamModel: "one-dear",
		StatusCode: 200, Cost: 50_000, TotalTokens: 10})
	for range 5 {
		h.logCall(t, model.RequestLog{Model: "only-failed", UpstreamModel: "only-failed",
			StatusCode: 502, Error: "bad gateway"})
	}

	var stats struct {
		ByModel []store.NamedStat `json:"by_model"`
	}
	h.do(http.MethodGet, "/api/admin/stats?days=1", h.admin, nil, &stats)

	if len(stats.ByModel) != 2 {
		t.Fatalf("ranking %+v, want the two models that cost something", stats.ByModel)
	}
	if stats.ByModel[0].Name != "one-dear" || stats.ByModel[1].Name != "many-cheap" {
		t.Fatalf("ranking %+v, want the dearer model first despite fewer calls", stats.ByModel)
	}
}

func TestDashboardCountsOnlyLiveChannels(t *testing.T) {
	h := newHarness(t)
	live := channelInput{BaseURL: "https://upstream.invalid", APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"}}
	for _, name := range []string{"enabled", "disabled", "archived"} {
		in := live
		in.Name = name
		id := h.createChannel(in)
		switch name {
		case "disabled":
			if err := h.store.SetChannelStatus(context.Background(), id, model.StatusDisabled, ""); err != nil {
				t.Fatal(err)
			}
		case "archived":
			if _, err := h.store.SetChannelArchived(context.Background(), id, true); err != nil {
				t.Fatal(err)
			}
		}
	}

	var stats struct {
		ChannelCount   int64 `json:"channel_count"`
		ChannelEnabled int64 `json:"channel_enabled"`
	}
	h.do(http.MethodGet, "/api/admin/stats?days=1", h.admin, nil, &stats)
	if stats.ChannelCount != 2 || stats.ChannelEnabled != 1 {
		t.Fatalf("channels %d (enabled %d), want 2 (1): an archived one is retired",
			stats.ChannelCount, stats.ChannelEnabled)
	}
}

// The audit lists what is missing a price among models that can actually be
// routed; a disabled channel's catalogue only buries those.
func TestUnpricedAuditIgnoresChannelsThatCannotRoute(t *testing.T) {
	h := newHarness(t)
	h.createChannel(channelInput{Name: "live", BaseURL: "https://upstream.invalid", APIKey: "k",
		Models: []string{"unpriced-live"}, Groups: []string{"default"}})
	idle := h.createChannel(channelInput{Name: "idle", BaseURL: "https://upstream.invalid", APIKey: "k",
		Models: []string{"unpriced-idle"}, Groups: []string{"default"}})
	if err := h.store.SetChannelStatus(context.Background(), idle, model.StatusDisabled, ""); err != nil {
		t.Fatal(err)
	}

	var report struct {
		Data []string `json:"data"`
	}
	h.do(http.MethodGet, "/api/admin/prices/unpriced", h.admin, nil, &report)
	if fmt.Sprint(report.Data) != "[unpriced-live]" {
		t.Fatalf("unpriced %v, want only the model a routable channel serves", report.Data)
	}
}

func TestChannelHealthCountsRecentFailuresTheChannelOwns(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	call := func(status int32, errText string) model.RequestLog {
		return model.RequestLog{ChannelID: 7, ChannelName: "ch", Model: "m", StatusCode: status, Error: errText}
	}
	for _, l := range []model.RequestLog{
		call(200, ""),
		call(502, "bad gateway"),
		call(200, "上游在响应体中返回错误：overloaded_error"),
		call(499, "client closed request"),
		call(200, "cancelled by an administrator"),
	} {
		h.logCall(t, l)
	}
	// Older than a day: out of both windows.
	h.logCall(t, call(502, "bad gateway"))
	if _, err := h.pool.Exec(ctx, `UPDATE request_logs SET created_at = now() - interval '2 days'
		WHERE id = (SELECT max(id) FROM request_logs)`); err != nil {
		t.Fatal(err)
	}
	// Within the day but not the hour.
	h.logCall(t, call(502, "bad gateway"))
	if _, err := h.pool.Exec(ctx, `UPDATE request_logs SET created_at = now() - interval '3 hours'
		WHERE id = (SELECT max(id) FROM request_logs)`); err != nil {
		t.Fatal(err)
	}

	var report struct {
		Data map[string]store.ChannelHealth `json:"data"`
	}
	h.do(http.MethodGet, "/api/admin/channels/health", h.admin, nil, &report)
	got := report.Data["7"]
	want := store.ChannelHealth{
		Hour: store.HealthCount{Requests: 5, Failures: 2},
		Day:  store.HealthCount{Requests: 6, Failures: 3},
	}
	if got != want {
		t.Fatalf("health %+v, want %+v", got, want)
	}
}
