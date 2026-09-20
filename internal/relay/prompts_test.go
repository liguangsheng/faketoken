package relay

import (
	"encoding/json"
	"testing"

	"github.com/faketoken/faketoken/internal/model"
)

func TestPromptTemplatesAreUsable(t *testing.T) {
	templates := PromptTemplates()
	if len(templates) != 10 {
		t.Fatalf("got %d templates, want 10", len(templates))
	}

	seenID := map[string]bool{}
	seenName := map[string]bool{}
	for _, template := range templates {
		if template.ID == "" || template.Name == "" || template.Prompt == "" {
			t.Fatalf("incomplete template: %+v", template)
		}
		if seenID[template.ID] {
			t.Fatalf("duplicate template id %q", template.ID)
		}
		if seenName[template.Name] {
			t.Fatalf("duplicate template name %q", template.Name)
		}
		seenID[template.ID] = true
		seenName[template.Name] = true

		if _, found := PromptTemplateByID(template.ID); !found {
			t.Fatalf("template %q is not resolvable by id", template.ID)
		}
	}

	if _, found := PromptTemplateByID("no-such-template"); found {
		t.Fatal("an unknown id must not resolve")
	}
}

func TestPromptTemplatesAreImmutableFromOutside(t *testing.T) {
	PromptTemplates()[0].Prompt = "mutated"
	if PromptTemplates()[0].Prompt == "mutated" {
		t.Fatal("callers can mutate the built-in templates")
	}
}

func TestProbeRequestSizesTheReplyBudget(t *testing.T) {
	// Without a prompt the probe only proves the credential works, so one
	// token keeps it nearly free.
	for _, protocol := range []string{model.ProtocolChatCompletions, model.ProtocolMessages} {
		_, payload := probeRequest(protocol, "m", "")
		var decoded struct {
			MaxTokens int `json:"max_tokens"`
		}
		if err := json.Unmarshal(payload, &decoded); err != nil {
			t.Fatal(err)
		}
		if decoded.MaxTokens != 1 {
			t.Fatalf("%s: unprompted probe asks for %d tokens", protocol, decoded.MaxTokens)
		}
	}

	path, payload := probeRequest(model.ProtocolChatCompletions, "m", "讲个笑话")
	if path != "/v1/chat/completions" {
		t.Fatalf("path = %q", path)
	}
	var chat struct {
		MaxTokens int `json:"max_tokens"`
		Messages  []struct {
			Content string `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(payload, &chat); err != nil {
		t.Fatal(err)
	}
	if chat.MaxTokens != 1024 {
		t.Fatalf("prompted probe budget = %d", chat.MaxTokens)
	}
	if len(chat.Messages) != 1 || chat.Messages[0].Content != "讲个笑话" {
		t.Fatalf("prompt was not carried: %s", payload)
	}

	responsePath, responsePayload := probeRequest(model.ProtocolResponses, "m", "讲个笑话")
	if responsePath != "/v1/responses" {
		t.Fatalf("responses path = %q", responsePath)
	}
	var responses struct {
		Input           string `json:"input"`
		MaxOutputTokens int    `json:"max_output_tokens"`
	}
	if err := json.Unmarshal(responsePayload, &responses); err != nil {
		t.Fatal(err)
	}
	if responses.Input != "讲个笑话" || responses.MaxOutputTokens != 1024 {
		t.Fatalf("unexpected responses payload: %s", responsePayload)
	}
}

func TestExtractReply(t *testing.T) {
	tests := []struct {
		name string
		body string
		want string
	}{
		{
			name: "openai chat completions",
			body: `{"choices":[{"message":{"role":"assistant","content":"你好"}}]}`,
			want: "你好",
		},
		{
			name: "openai legacy completion",
			body: `{"choices":[{"text":"你好"}]}`,
			want: "你好",
		},
		{
			name: "anthropic messages joins text blocks and skips others",
			body: `{"content":[{"type":"thinking","thinking":"..."},{"type":"text","text":"第一段"},{"type":"text","text":"第二段"}]}`,
			want: "第一段\n第二段",
		},
		{
			name: "openai responses output content",
			body: `{"output":[{"content":[{"type":"output_text","text":"你好"}]}]}`,
			want: "你好",
		},
		{
			name: "gemini candidates",
			body: `{"candidates":[{"content":{"parts":[{"text":"你好"}]}}]}`,
			want: "你好",
		},
		{
			name: "empty choice yields nothing",
			body: `{"choices":[{"message":{"content":""}}]}`,
			want: "",
		},
		{
			name: "not json",
			body: `<html>502</html>`,
			want: "",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := extractReply([]byte(tc.body)); got != tc.want {
				t.Fatalf("extractReply = %q, want %q", got, tc.want)
			}
		})
	}
}
