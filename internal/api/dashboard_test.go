package api

import (
	"context"
	"fmt"
	"io"
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
	// A stream without usage options settles with no cost and no tokens, yet
	// it answered: it is traffic, and the ranking has to show it.
	h.logCall(t, model.RequestLog{Model: "no-usage", UpstreamModel: "no-usage", StatusCode: 200})

	var stats struct {
		ByModel []store.NamedStat `json:"by_model"`
	}
	h.do(http.MethodGet, "/api/admin/stats?days=1", h.admin, nil, &stats)

	names := []string{}
	for _, row := range stats.ByModel {
		names = append(names, row.Name)
	}
	if fmt.Sprint(names) != "[one-dear many-cheap no-usage]" {
		t.Fatalf("ranking %v, want spend first, the unbilled success last, the failures nowhere", names)
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
	// Disabled too, but opened by keepalive every day: its models do get routed.
	h.createChannel(channelInput{Name: "keepalive", BaseURL: "https://upstream.invalid", APIKey: "k",
		Models: []string{"unpriced-keepalive"}, Groups: []string{"default"}, Status: model.StatusDisabled,
		KeepaliveEnabled: true, KeepaliveAt: "03:00", KeepaliveTarget: 5})

	var report struct {
		Data []string `json:"data"`
	}
	h.do(http.MethodGet, "/api/admin/prices/unpriced", h.admin, nil, &report)
	if fmt.Sprint(report.Data) != "[unpriced-keepalive unpriced-live]" {
		t.Fatalf("unpriced %v, want the models a routable or keepalive channel serves", report.Data)
	}
}

func (h *harness) channelHealth(t *testing.T) map[string]store.ChannelHealth {
	t.Helper()
	var report struct {
		Data map[string]store.ChannelHealth `json:"data"`
	}
	h.do(http.MethodGet, "/api/admin/channels/health", h.admin, nil, &report)
	return report.Data
}

// A request that fails over logs one row, against the channel that answered.
// The health view counts attempts instead, so the channel that failed first is
// not hidden behind the one that rescued it.
func TestChannelHealthCountsEveryAttempt(t *testing.T) {
	h := newHarness(t)
	failing := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	})
	healthy := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	primary := h.createChannel(channelInput{Name: "primary", BaseURL: failing.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"}, Priority: 10})
	backup := h.createChannel(channelInput{Name: "backup", BaseURL: healthy.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"}, Priority: 1})

	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", h.createKey(), `{"model":"gpt-4o"}`)
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("relay: HTTP %d, want the backup's answer", resp.StatusCode)
	}

	want := map[int64]store.HealthCount{primary: {Attempts: 1, Failures: 1}, backup: {Attempts: 1}}
	h.waitFor(t, "both attempts to be counted", func() bool {
		got := h.channelHealth(t)
		for id, count := range want {
			if got[fmt.Sprint(id)].Hour != count || got[fmt.Sprint(id)].Day != count {
				return false
			}
		}
		return true
	})
}

// A call its caller or an operator ended is nobody's failure, and every count
// of failures agrees: the summary, the series, the error filter, the heatmap.
func TestCancelledCallsAreNotFailures(t *testing.T) {
	h := newHarness(t)
	h.logCall(t, model.RequestLog{Model: "m", StatusCode: 200})
	h.logCall(t, model.RequestLog{Model: "m", StatusCode: 502, Error: "bad gateway"})
	h.logCall(t, model.RequestLog{Model: "m", StatusCode: 200, Cancelled: true,
		Error: "stream interrupted: context canceled"})
	h.logCall(t, model.RequestLog{Model: "m", StatusCode: 499, Cancelled: true,
		Error: "client closed request"})

	var stats struct {
		Summary store.Summary      `json:"summary"`
		Series  []store.TimeBucket `json:"series"`
	}
	h.do(http.MethodGet, "/api/admin/stats?days=1", h.admin, nil, &stats)
	seriesErrors := int64(0)
	for _, b := range stats.Series {
		seriesErrors += b.Errors
	}
	if stats.Summary.Requests != 4 || stats.Summary.Errors != 1 || stats.Summary.Cancelled != 2 ||
		seriesErrors != 1 {
		t.Fatalf("summary %+v, series errors %d; want 4 calls, the 502 the only failure, 2 cancelled",
			stats.Summary, seriesErrors)
	}

	var listed struct {
		Data []*model.RequestLog `json:"data"`
	}
	h.do(http.MethodGet, "/api/admin/logs?only_error=true", h.admin, nil, &listed)
	if len(listed.Data) != 1 || listed.Data[0].StatusCode != 502 {
		t.Fatalf("only_error listed %d rows, want the 502 alone", len(listed.Data))
	}

	var heatmap struct {
		Days []store.UsageDay `json:"days"`
	}
	h.do(http.MethodGet, "/api/admin/stats/heatmap?tz=UTC", h.admin, nil, &heatmap)
	if len(heatmap.Days) != 1 || heatmap.Days[0].Requests != 4 || heatmap.Days[0].Errors != 1 {
		t.Fatalf("heatmap %+v, want one day with 4 calls and 1 failure", heatmap.Days)
	}
}
