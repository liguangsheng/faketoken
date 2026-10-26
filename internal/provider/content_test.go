package provider

import "testing"

func TestContentEvent(t *testing.T) {
	cases := []struct {
		name    string
		event   string
		payload string
		want    bool
	}{
		{"anthropic start", "message_start", `{"type":"message_start","message":{"usage":{"input_tokens":0,"output_tokens":0}}}`, false},
		{"anthropic ping", "ping", `{"type":"ping"}`, false},
		{"anthropic block start", "content_block_start", `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`, false},
		{"anthropic text delta", "content_block_delta", `{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}`, true},
		{"anthropic delta, unnamed", "", `{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"…"}}`, true},
		{"anthropic error", "error", `{"type":"error","error":{"type":"overloaded_error"}}`, false},
		{"chat role only", "", `{"choices":[{"delta":{"role":"assistant","content":""}}]}`, false},
		{"chat null content", "", `{"choices":[{"delta":{"content":null}}]}`, false},
		{"chat text", "", `{"choices":[{"delta":{"content":"he"}}]}`, true},
		{"chat reasoning", "", `{"choices":[{"delta":{"reasoning_content":"think"}}]}`, true},
		{"chat tool call", "", `{"choices":[{"delta":{"tool_calls":[{"index":0}]}}]}`, true},
		{"chat usage only", "", `{"choices":[],"usage":{"prompt_tokens":3}}`, false},
		{"responses created", "response.created", `{"type":"response.created"}`, false},
		{"responses text", "response.output_text.delta", `{"type":"response.output_text.delta","delta":"x"}`, true},
		{"gemini parts", "", `{"candidates":[{"content":{"parts":[{"text":"x"}]}}]}`, true},
		{"gemini usage only", "", `{"usageMetadata":{"promptTokenCount":3}}`, false},
		{"not json", "", `[DONE]`, false},
	}
	for _, c := range cases {
		if got := ContentEvent(c.event, []byte(c.payload)); got != c.want {
			t.Errorf("%s: ContentEvent = %v, want %v", c.name, got, c.want)
		}
	}
}
