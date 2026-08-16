package relay

import (
	"encoding/json"
	"strings"
	"testing"
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
