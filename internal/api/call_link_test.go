package api

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/faketoken/faketoken/internal/model"
	"github.com/faketoken/faketoken/internal/store"
)

// conversationChannel serves chat completions; a message saying "fail" gets a
// 400, which is not retried and logs as a failure.
func (h *harness) conversationChannel(t *testing.T) {
	t.Helper()
	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		if strings.Contains(u.body(), `"fail"`) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, `{"error":{"message":"bad request"}}`)
			return
		}
		chatResponse(w, "ok", 10, 5)
	})
	h.createChannel(channelInput{
		Name: "conversation", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
}

// converse sends one turn of a conversation — the messages alternate user and
// assistant — optionally naming a session, and returns the call once it is
// logged and linked. Turns are sent one after another, as a client does.
func (h *harness) converse(t *testing.T, key, session string, messages ...string) *model.RequestLog {
	t.Helper()
	list := make([]map[string]string, len(messages))
	for i, text := range messages {
		role := "user"
		if i%2 == 1 {
			role = "assistant"
		}
		list[i] = map[string]string{"role": role, "content": text}
	}
	body, _ := json.Marshal(map[string]any{"model": "gpt-4o", "messages": list})

	// The previous turn already looks linked, so the wait is for a newer row.
	before := int64(0)
	if logs, _, err := h.store.ListLogs(context.Background(), store.LogFilter{Limit: 1}); err == nil && len(logs) > 0 {
		before = logs[0].ID
	}

	req, err := http.NewRequest(http.MethodPost, h.server.URL+"/v1/chat/completions",
		strings.NewReader(string(body)))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+key)
	if session != "" {
		req.Header.Set("X-Claude-Code-Session-Id", session)
	}
	resp, err := h.server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()

	var newest *model.RequestLog
	h.waitFor(t, "the call to be linked", func() bool {
		logs, _, err := h.store.ListLogs(context.Background(), store.LogFilter{Limit: 1})
		if err != nil || len(logs) == 0 {
			return false
		}
		newest = logs[0]
		return newest.ID > before && newest.MessageCount == int32(len(messages)) && newest.ThreadID != 0
	})
	return newest
}

func (h *harness) logRow(t *testing.T, id int64) *model.RequestLog {
	t.Helper()
	logs, _, err := h.store.ListLogs(context.Background(), store.LogFilter{Limit: 200})
	if err != nil {
		t.Fatal(err)
	}
	for _, l := range logs {
		if l.ID == id {
			return l
		}
	}
	t.Fatalf("no log %d", id)
	return nil
}

func wantLink(t *testing.T, name string, got *model.RequestLog, parent, thread int64, shared, count int32) {
	t.Helper()
	if got.ParentID != parent || got.ThreadID != thread || got.SharedMessages != shared ||
		got.MessageCount != count {
		t.Fatalf("%s: parent %d thread %d shared %d of %d; want parent %d thread %d shared %d of %d",
			name, got.ParentID, got.ThreadID, got.SharedMessages, got.MessageCount,
			parent, thread, shared, count)
	}
}

// A conversation's turns chain onto each other, a subagent in the same
// session starts a line of its own, and a resent turn continues the one it
// repeats.
func TestCallsLinkIntoTheirConversation(t *testing.T) {
	h := newHarness(t)
	h.conversationChannel(t)
	key := h.createKey()

	c1 := h.converse(t, key, "s-1", "u1")
	c2 := h.converse(t, key, "s-1", "u1", "a1", "u2")
	side := h.converse(t, key, "s-1", "a subagent's task")
	c3 := h.converse(t, key, "s-1", "u1", "a1", "u2", "a2", "u3")
	again := h.converse(t, key, "s-1", "u1", "a1", "u2", "a2", "u3")

	wantLink(t, "first turn", c1, 0, c1.ID, 0, 1)
	wantLink(t, "second turn", c2, c1.ID, c1.ID, 1, 3)
	wantLink(t, "subagent", side, 0, side.ID, 0, 1)
	wantLink(t, "third turn", c3, c2.ID, c1.ID, 3, 5)
	wantLink(t, "resent turn", again, c3.ID, c1.ID, 5, 5)
	if c3.SessionID != "s-1" {
		t.Fatalf("session %q, want the one the client named", c3.SessionID)
	}

	// A conversation edited before its last turn shares only part of any
	// earlier call: it branches into a line of its own.
	d1 := h.converse(t, key, "s-2", "x1", "x2", "x3")
	d2 := h.converse(t, key, "s-2", "x1", "y2", "y3")
	wantLink(t, "branch", d2, d1.ID, d2.ID, 1, 3)

	var listed struct {
		Data []store.SessionSummary `json:"data"`
	}
	h.do(http.MethodGet, "/api/admin/sessions", h.admin, nil, &listed)
	if len(listed.Data) != 2 || listed.Data[0].ID != "s-2" || listed.Data[1].Calls != 5 ||
		listed.Data[1].Threads != 2 {
		t.Fatalf("sessions %+v, want s-2 first and s-1 with 5 calls on 2 lines", listed.Data)
	}

	var detail struct {
		Session store.SessionSummary  `json:"session"`
		Threads []store.ThreadSummary `json:"threads"`
	}
	h.do(http.MethodGet, "/api/admin/sessions/s-1", h.admin, nil, &detail)
	if len(detail.Threads) != 2 || detail.Threads[0].ID != c1.ID || detail.Threads[0].Calls != 4 ||
		detail.Threads[0].LatestWithBody != again.ID || detail.Threads[0].Messages != 5 {
		t.Fatalf("threads %+v, want the main line first: 4 calls, latest body %d", detail.Threads, again.ID)
	}
	var branched struct {
		Threads []store.ThreadSummary `json:"threads"`
	}
	h.do(http.MethodGet, "/api/admin/sessions/s-2", h.admin, nil, &branched)
	for _, th := range branched.Threads {
		if th.ID == d2.ID && (th.BranchOf != d1.ID || th.BranchAt != 1) {
			t.Fatalf("branch %+v, want it to name %d after 1 message", th, d1.ID)
		}
	}

	var calls struct {
		Data []*model.RequestLog `json:"data"`
	}
	h.do(http.MethodGet, fmt.Sprintf("/api/admin/sessions/s-1/threads/%d/calls", c1.ID), h.admin, nil, &calls)
	ids := []int64{}
	for _, c := range calls.Data {
		ids = append(ids, c.ID)
	}
	if fmt.Sprint(ids) != fmt.Sprint([]int64{c1.ID, c2.ID, c3.ID, again.ID}) {
		t.Fatalf("thread calls %v, want the main line in order", ids)
	}

	var page struct {
		Total int64 `json:"total"`
	}
	h.do(http.MethodGet, "/api/admin/logs?session=s-1", h.admin, nil, &page)
	if page.Total != 5 {
		t.Fatalf("session filter listed %d calls, want 5", page.Total)
	}
	if r := h.do(http.MethodGet, "/api/admin/sessions/nope", h.admin, nil, nil); r.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown session: HTTP %d, want 404", r.StatusCode)
	}
}

// With no session named, content alone ties a key's turns together, under an
// id taken from the first call; another key's identical opening does not join.
func TestCallsWithoutASessionLinkByContent(t *testing.T) {
	h := newHarness(t)
	h.conversationChannel(t)
	key, other := h.createKey(), h.createKey()

	n1 := h.converse(t, key, "", "hello")
	n2 := h.converse(t, key, "", "hello", "hi", "how are you")
	stranger := h.converse(t, other, "", "hello")

	session := fmt.Sprintf("~%d", n1.ID)
	if n2.SessionID != session || h.logRow(t, n1.ID).SessionID != session {
		t.Fatalf("sessions %q and %q, want both %q", h.logRow(t, n1.ID).SessionID, n2.SessionID, session)
	}
	wantLink(t, "second turn", n2, n1.ID, n1.ID, 1, 3)
	if stranger.ParentID != 0 || stranger.SessionID != "" {
		t.Fatalf("another key's call linked to parent %d in %q", stranger.ParentID, stranger.SessionID)
	}
}

// Bodies stored before linking existed get the same links from the backfill
// that new calls get as they are logged.
func TestLinkBackfillMatchesLiveLinking(t *testing.T) {
	h := newHarness(t)
	h.conversationChannel(t)
	key := h.createKey()

	calls := []*model.RequestLog{
		h.converse(t, key, "s-1", "u1"),
		h.converse(t, key, "s-1", "u1", "a1", "u2"),
		h.converse(t, key, "", "solo"),
		h.converse(t, key, "", "solo", "reply", "again"),
	}
	// Read back once all are in: linking a turn names its parent's session too.
	for i, c := range calls {
		calls[i] = h.logRow(t, c.ID)
	}

	ctx := context.Background()
	if _, err := h.store.Pool().Exec(ctx, `UPDATE request_log_details SET request_messages = NULL,
		created_at = created_at - interval '2 days'`); err != nil {
		t.Fatal(err)
	}
	// Two days back: the backfill reaches calls well past the window that
	// ties a key's calls by content, measured from now.
	if _, err := h.store.Pool().Exec(ctx, `UPDATE request_logs SET parent_id = 0, thread_id = 0,
		shared_messages = 0, message_count = 0, created_at = created_at - interval '2 days',
		session_id = CASE WHEN session_id LIKE '~%' THEN '' ELSE session_id END`); err != nil {
		t.Fatal(err)
	}

	hashed, linked, err := h.store.BackfillLinks(ctx)
	if err != nil || hashed != 4 || linked != 4 {
		t.Fatalf("backfill hashed %d, linked %d, err %v; want 4 and 4", hashed, linked, err)
	}
	for i, want := range calls {
		got := h.logRow(t, want.ID)
		if got.SessionID != want.SessionID || got.ParentID != want.ParentID ||
			got.ThreadID != want.ThreadID || got.SharedMessages != want.SharedMessages ||
			got.MessageCount != want.MessageCount {
			t.Fatalf("call %d after backfill %+v, want %+v", i, got, want)
		}
	}
}

// Past the window, a failed call keeps its bodies for the configured days;
// at zero days it goes with the rest.
func TestFailedCallsKeepTheirBodiesLonger(t *testing.T) {
	h := newHarness(t)
	h.conversationChannel(t)
	key := h.createKey()
	h.store.SetLogDetailKeep(2)

	failed := h.converse(t, key, "", "fail")
	first := h.converse(t, key, "", "one")
	h.converse(t, key, "", "two")
	h.converse(t, key, "", "three")
	if !failed.Failed() {
		t.Fatalf("the failing call logged as %d %q", failed.StatusCode, failed.Error)
	}

	kept := func(id int64) bool {
		_, err := h.store.GetLogDetail(context.Background(), id)
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			t.Fatal(err)
		}
		return err == nil
	}
	if !kept(failed.ID) || kept(first.ID) {
		t.Fatalf("failed kept %v, first kept %v; want the failure kept past the window",
			kept(failed.ID), kept(first.ID))
	}

	h.store.SetFailedDetailDays(0)
	h.converse(t, key, "", "four")
	if kept(failed.ID) {
		t.Fatal("with 0 days the failed call's bodies outlived the window")
	}
}

// A streamed answer records when its bytes went out: from the headers, with
// nothing relayed yet, to the last byte.
func TestStreamedResponseRecordsItsTiming(t *testing.T) {
	h := newHarness(t)
	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher := w.(http.Flusher)
		for i := range 3 {
			fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"content\":\"part %d\"}}]}\n\n", i)
			flusher.Flush()
			time.Sleep(60 * time.Millisecond)
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
		flusher.Flush()
	})
	h.createChannel(channelInput{
		Name: "timed", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})

	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", h.createKey(),
		`{"model":"gpt-4o","stream":true,"messages":[{"role":"user","content":"hi"}]}`)
	raw, _ := io.ReadAll(bufio.NewReader(resp.Body))
	resp.Body.Close()
	entry := h.waitForLog(t, 1)

	var detail model.RequestLogDetail
	h.waitFor(t, "the bodies to be stored", func() bool {
		r := h.do(http.MethodGet, fmt.Sprintf("/api/admin/logs/%d/detail", entry.ID), h.admin, nil, &detail)
		return r.StatusCode == http.StatusOK
	})
	s := detail.ResponseTiming
	if len(s) < 4 || s[1] != 0 || s[len(s)-1] != int32(len(raw)) {
		t.Fatalf("timing %v, want it to run from 0 bytes to all %d", s, len(raw))
	}
	for i := 2; i < len(s); i += 2 {
		if s[i] < s[i-2] || s[i+1] < s[i-1] {
			t.Fatalf("timing %v goes backwards at %d", s, i/2)
		}
	}
	if s[len(s)-2]-s[0] < 150 {
		t.Fatalf("timing %v spans %dms, want the ~180ms the stream took", s, s[len(s)-2]-s[0])
	}
}
