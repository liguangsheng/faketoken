package provider

import (
	"bytes"
	"encoding/json"
	"strings"
)

// contentProbe reads just enough of a streamed payload to tell whether it
// carries part of the answer, in any dialect this relay serves.
type contentProbe struct {
	// Anthropic Messages and the Responses API name each event in "type".
	Type    string `json:"type"`
	Choices []struct {
		Text  string `json:"text"`
		Delta struct {
			Content          json.RawMessage   `json:"content"`
			ReasoningContent string            `json:"reasoning_content"`
			Reasoning        string            `json:"reasoning"`
			Refusal          string            `json:"refusal"`
			ToolCalls        []json.RawMessage `json:"tool_calls"`
		} `json:"delta"`
	} `json:"choices"`
	Candidates []struct {
		Content struct {
			Parts []json.RawMessage `json:"parts"`
		} `json:"content"`
	} `json:"candidates"`
}

// ContentEvent reports whether one streamed event carries part of the answer
// itself — text, reasoning or a tool call — rather than bookkeeping such as a
// message start, a ping, a usage report or an error. It is what tells a stream
// that broke after answering from one that broke before: output counts cannot,
// since Anthropic reports them only in the closing message_delta.
func ContentEvent(event string, payload []byte) bool {
	if event == "content_block_delta" {
		return true
	}
	var p contentProbe
	if err := json.Unmarshal(payload, &p); err != nil {
		return false
	}

	switch {
	case p.Type == "content_block_delta":
		return true
	case strings.HasPrefix(p.Type, "response.") && strings.HasSuffix(p.Type, ".delta"):
		return true
	}
	for _, choice := range p.Choices {
		d := choice.Delta
		if choice.Text != "" || d.ReasoningContent != "" || d.Reasoning != "" || d.Refusal != "" ||
			len(d.ToolCalls) > 0 || hasValue(d.Content) {
			return true
		}
	}
	for _, candidate := range p.Candidates {
		if len(candidate.Content.Parts) > 0 {
			return true
		}
	}
	return false
}

// hasValue is false for an absent field, null and the empty string, which is
// how a chat chunk that only announces the role spells "no content yet".
func hasValue(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) > 0 && !bytes.Equal(trimmed, []byte("null")) && !bytes.Equal(trimmed, []byte(`""`))
}
