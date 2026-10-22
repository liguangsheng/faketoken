package relay

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/faketoken/faketoken/internal/model"
)

func TestRewriteModelPreservesEverythingElse(t *testing.T) {
	in := `{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}],"temperature":0.7,"stream":true}`
	out := string(rewriteModel([]byte(in), "gpt-4o-2024-11-20"))

	want := `{"model":"gpt-4o-2024-11-20","messages":[{"role":"user","content":"hi"}],"temperature":0.7,"stream":true}`
	if out != want {
		t.Fatalf("byte-for-byte splice failed\n got: %s\nwant: %s", out, want)
	}
}

func TestRewriteModelKeepsNumericPrecision(t *testing.T) {
	// A naive decode/encode round-trip would turn this into 1e+30.
	in := `{"model":"m","seed":100000000000000000000000000000,"top_p":0.10}`
	out := string(rewriteModel([]byte(in), "n"))

	if !strings.Contains(out, "100000000000000000000000000000") {
		t.Fatalf("large integer was mangled: %s", out)
	}
	if !strings.Contains(out, "0.10") {
		t.Fatalf("float formatting was mangled: %s", out)
	}
}

func TestRewriteModelHandlesWhitespaceAndOrder(t *testing.T) {
	in := "{\n  \"messages\": [],\n  \"model\"  :   \"a\",\n  \"n\": 1\n}"
	out := string(rewriteModel([]byte(in), "b"))

	var decoded struct {
		Model string `json:"model"`
		N     int    `json:"n"`
	}
	if err := json.Unmarshal([]byte(out), &decoded); err != nil {
		t.Fatalf("result is not valid JSON: %v (%s)", err, out)
	}
	if decoded.Model != "b" || decoded.N != 1 {
		t.Fatalf("unexpected result: %s", out)
	}
	if !strings.Contains(out, "\"messages\": []") {
		t.Fatalf("original formatting was lost: %s", out)
	}
}

func TestRewriteModelFallsBackWhenKeyMissing(t *testing.T) {
	in := `{"input":"hello"}`
	out := string(rewriteModel([]byte(in), "m"))

	var decoded map[string]any
	if err := json.Unmarshal([]byte(out), &decoded); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if decoded["model"] != "m" || decoded["input"] != "hello" {
		t.Fatalf("unexpected result: %s", out)
	}
}

func TestInspect(t *testing.T) {
	tests := []struct {
		name        string
		path        string
		contentType string
		body        string
		wantModel   string
		wantStream  bool
	}{
		{
			name: "openai chat", path: "/v1/chat/completions", contentType: "application/json",
			body: `{"model":"gpt-4o","stream":true}`, wantModel: "gpt-4o", wantStream: true,
		},
		{
			name: "anthropic messages", path: "/v1/messages", contentType: "application/json",
			body: `{"model":"claude-sonnet-4","max_tokens":10}`, wantModel: "claude-sonnet-4",
		},
		{
			name: "gemini generate", path: "/v1beta/models/gemini-2.5-pro:generateContent",
			contentType: "application/json", body: `{"contents":[]}`, wantModel: "gemini-2.5-pro",
		},
		{
			name: "gemini stream", path: "/v1beta/models/gemini-2.0-flash:streamGenerateContent",
			contentType: "application/json", body: `{}`,
			wantModel: "gemini-2.0-flash", wantStream: true,
		},
		{
			name: "multipart audio", path: "/v1/audio/transcriptions",
			contentType: "multipart/form-data; boundary=xyz",
			body:        "--xyz\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\nwhisper-1\r\n--xyz--",
			wantModel:   "whisper-1",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := inspect(tc.path, tc.contentType, []byte(tc.body))
			if got.Model != tc.wantModel {
				t.Errorf("model = %q, want %q", got.Model, tc.wantModel)
			}
			if got.Stream != tc.wantStream {
				t.Errorf("stream = %v, want %v", got.Stream, tc.wantStream)
			}
		})
	}
}

func TestHasConversationAttachment(t *testing.T) {
	tests := []struct {
		name string
		body string
		want bool
	}{
		{name: "messages image like log 7105", body: `{"messages":[{"role":"user","content":[{"type":"text","text":"judge"},{"type":"image","source":{"type":"url","url":"https://example.test/a.jpg"}}]}]}`, want: true},
		{name: "messages document", body: `{"messages":[{"content":[{"type":"document","source":{"type":"base64","data":"AA=="}}]}]}`, want: true},
		{name: "chat image url", body: `{"messages":[{"content":[{"type":"text","text":"look"},{"type":"image_url","image_url":{"url":"data:image/png;base64,AA=="}}]}]}`, want: true},
		{name: "responses input file", body: `{"input":[{"role":"user","content":[{"type":"input_file","file_id":"file_1"}]}]}`, want: true},
		{name: "gemini inline data", body: `{"contents":[{"parts":[{"text":"look"},{"inlineData":{"mimeType":"image/png","data":"AA=="}}]}]}`, want: true},
		{name: "generic attachments", body: `{"messages":[{"content":"look","attachments":[{"url":"https://example.test/a.pdf"}]}]}`, want: true},
		{name: "plain text", body: `{"messages":[{"role":"user","content":[{"type":"text","text":"hello"}]}]}`},
		{name: "tools are not attachments", body: `{"messages":[{"role":"assistant","content":[{"type":"tool_use","id":"1","name":"weather","input":{}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"1","content":"sunny"}]}]}`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := hasConversationAttachment("application/json", []byte(tc.body)); got != tc.want {
				t.Fatalf("hasConversationAttachment() = %v, want %v", got, tc.want)
			}
		})
	}
}

// An upstream that reports output but zero input still gets an input count.
func TestEstimateMissingPrompt(t *testing.T) {
	body := []byte(`{"model":"claude-opus-5-5","system":"` + strings.Repeat("be brief ", 50) +
		`","messages":[{"role":"user","content":[{"type":"image","source":{"type":"base64","data":"` +
		strings.Repeat("A", 4096) + `"}}]}]}`)

	got, estimated := estimateMissingPrompt(model.Usage{CompletionTokens: 10, TotalTokens: 10}, model.ProtocolMessages, body)
	if !estimated {
		t.Fatal("estimate not flagged")
	}
	if got.PromptTokens < imageTokens+50 || got.PromptTokens > imageTokens+300 {
		t.Fatalf("PromptTokens = %d", got.PromptTokens)
	}
	if got.TotalTokens != got.PromptTokens+10 {
		t.Fatalf("TotalTokens = %d", got.TotalTokens)
	}

	// A reported count is never overwritten.
	kept, estimated := estimateMissingPrompt(model.Usage{PromptTokens: 7}, model.ProtocolMessages, body)
	if kept.PromptTokens != 7 || estimated {
		t.Fatalf("overwrote reported count: %d", kept.PromptTokens)
	}

	// Non-chat endpoints are left alone.
	if u, estimated := estimateMissingPrompt(model.Usage{}, "", body); u.PromptTokens != 0 || estimated {
		t.Fatalf("estimated a non-chat body: %d", u.PromptTokens)
	}
}
