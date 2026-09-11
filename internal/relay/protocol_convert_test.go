package relay

import (
	"bufio"
	"encoding/json"
	"io"
	"strings"
	"testing"
)

func TestMessagesToChat(t *testing.T) {
	in := []byte(`{
		"model":"claude-client","system":"be concise","max_tokens":128,
		"stop_sequences":["END"],"stream":true,
		"tools":[{"name":"weather","description":"lookup","input_schema":{"type":"object"}}],
		"tool_choice":{"type":"tool","name":"weather"},
		"messages":[
			{"role":"user","content":[{"type":"text","text":"hello"}]},
			{"role":"assistant","content":[{"type":"tool_use","id":"call_1","name":"weather","input":{"city":"SG"}}]},
			{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_1","content":"sunny"}]}
		]
	}`)
	out, ok := messagesToChat(in, "gpt-upstream")
	if !ok {
		t.Fatal("conversion failed")
	}
	var got map[string]any
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}
	if got["model"] != "gpt-upstream" || got["stop"] == nil {
		t.Fatalf("top-level conversion = %#v", got)
	}
	messages := got["messages"].([]any)
	if len(messages) != 4 {
		t.Fatalf("messages = %d, want system + 3 turns", len(messages))
	}
	assistant := messages[2].(map[string]any)
	if len(assistant["tool_calls"].([]any)) != 1 {
		t.Fatalf("tool calls = %#v", assistant["tool_calls"])
	}
	toolResult := messages[3].(map[string]any)
	if toolResult["role"] != "tool" || toolResult["tool_call_id"] != "call_1" {
		t.Fatalf("tool result = %#v", toolResult)
	}
	if got["stream_options"] == nil {
		t.Fatal("stream usage was not requested")
	}
}

func TestChatResponseToMessages(t *testing.T) {
	in := []byte(`{
		"id":"chatcmpl-1","model":"gpt-4.1",
		"choices":[{"message":{"role":"assistant","content":"done","tool_calls":[{"id":"call_1","type":"function","function":{"name":"weather","arguments":"{\"city\":\"SG\"}"}}]},"finish_reason":"tool_calls"}],
		"usage":{"prompt_tokens":12,"completion_tokens":4,"prompt_tokens_details":{"cached_tokens":3}}
	}`)
	out, ok := chatResponseToMessages(in)
	if !ok {
		t.Fatal("conversion failed")
	}
	var got map[string]any
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}
	if got["type"] != "message" || got["stop_reason"] != "tool_use" {
		t.Fatalf("response = %#v", got)
	}
	content := got["content"].([]any)
	if len(content) != 2 || content[1].(map[string]any)["type"] != "tool_use" {
		t.Fatalf("content = %#v", content)
	}
	usage := got["usage"].(map[string]any)
	if usage["input_tokens"] != float64(12) || usage["cache_read_input_tokens"] != float64(3) {
		t.Fatalf("usage = %#v", usage)
	}
}

func TestConvertedChatStream(t *testing.T) {
	raw := strings.Join([]string{
		`data: {"id":"chatcmpl-1","model":"gpt-4.1","choices":[{"delta":{"role":"assistant"},"finish_reason":""}]}`,
		``,
		`data: {"id":"chatcmpl-1","model":"gpt-4.1","choices":[{"delta":{"content":"hello"},"finish_reason":""}]}`,
		``,
		`data: {"id":"chatcmpl-1","model":"gpt-4.1","choices":[{"delta":{},"finish_reason":"stop"}]}`,
		``,
		`data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":2}}`,
		``,
		`data: [DONE]`,
		``,
	}, "\n")
	stream := &convertedStream{
		src: bufio.NewReader(strings.NewReader(raw)), pending: make([]byte, 0, 4096),
		blocks: make(map[int]streamBlock),
	}
	out, err := io.ReadAll(stream)
	if err != nil {
		t.Fatal(err)
	}
	text := string(out)
	for _, want := range []string{"event: message_start", "event: content_block_start",
		`"text":"hello"`, "event: content_block_stop", `"input_tokens":9`,
		`"output_tokens":2`, "event: message_stop"} {
		if !strings.Contains(text, want) {
			t.Fatalf("stream missing %q:\n%s", want, text)
		}
	}
}

func TestResponsesToChat(t *testing.T) {
	in := []byte(`{
		"model":"gpt-client","instructions":"be concise","max_output_tokens":64,
		"input":[{"role":"user","content":[{"type":"input_text","text":"hello"}]}],
		"tools":[{"type":"function","name":"weather","description":"lookup","parameters":{"type":"object"}}],
		"tool_choice":{"type":"function","name":"weather"},"stream":true
	}`)
	out, ok := responsesToChat(in, "gpt-upstream")
	if !ok {
		t.Fatal("conversion failed")
	}
	var got map[string]any
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}
	if got["model"] != "gpt-upstream" || got["max_tokens"] != float64(64) {
		t.Fatalf("top-level conversion = %#v", got)
	}
	messages := got["messages"].([]any)
	if len(messages) != 2 || messages[0].(map[string]any)["role"] != "system" ||
		messages[1].(map[string]any)["content"] != "hello" {
		t.Fatalf("messages = %#v", messages)
	}
	if got["stream_options"] == nil || got["tool_choice"] == nil {
		t.Fatalf("stream/tool choice conversion = %#v", got)
	}
	tools := got["tools"].([]any)
	if len(tools) != 1 || tools[0].(map[string]any)["function"] == nil {
		t.Fatalf("tools = %#v", tools)
	}
}

func TestChatResponseToResponses(t *testing.T) {
	in := []byte(`{
		"id":"chatcmpl-1","model":"gpt-4.1",
		"choices":[{"message":{"role":"assistant","content":"done","tool_calls":[{"id":"call_1","type":"function","function":{"name":"weather","arguments":"{\"city\":\"SG\"}"}}]},"finish_reason":"tool_calls"}],
		"usage":{"prompt_tokens":12,"completion_tokens":4}
	}`)
	out, ok := chatResponseToResponses(in)
	if !ok {
		t.Fatal("conversion failed")
	}
	var got map[string]any
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}
	if got["object"] != "response" || got["status"] != "completed" || got["output_text"] != "done" {
		t.Fatalf("response = %#v", got)
	}
	output := got["output"].([]any)
	if len(output) != 2 || output[1].(map[string]any)["type"] != "function_call" {
		t.Fatalf("output = %#v", output)
	}
	usage := got["usage"].(map[string]any)
	if usage["input_tokens"] != float64(12) || usage["total_tokens"] != float64(16) {
		t.Fatalf("usage = %#v", usage)
	}
}

func TestResponsesStream(t *testing.T) {
	raw := strings.Join([]string{
		`data: {"id":"chatcmpl-1","model":"gpt-4.1","choices":[{"delta":{"role":"assistant"},"finish_reason":""}]}`,
		``,
		`data: {"id":"chatcmpl-1","model":"gpt-4.1","choices":[{"delta":{"content":"hello"},"finish_reason":""}]}`,
		``,
		`data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":2}}`,
		``,
		`data: [DONE]`,
		``,
	}, "\n")
	stream := &responsesStream{src: bufio.NewReader(strings.NewReader(raw))}
	out, err := io.ReadAll(stream)
	if err != nil {
		t.Fatal(err)
	}
	text := string(out)
	for _, want := range []string{"event: response.created", "event: response.output_text.delta",
		`"delta":"hello"`, "event: response.output_text.done", "event: response.completed",
		`"input_tokens":9`, `"output_tokens":2`} {
		if !strings.Contains(text, want) {
			t.Fatalf("stream missing %q:\n%s", want, text)
		}
	}
}

// An upstream that fails mid-stream sends an error chunk instead of a delta.
// The converter used to drop it, handing the caller a well-formed empty message
// and leaving the log with nothing to report.
func TestConvertedChatStreamForwardsUpstreamError(t *testing.T) {
	raw := strings.Join([]string{
		`data: {"id":"chatcmpl-1","model":"gpt-4.1","choices":[{"delta":{"content":"he"}}]}`,
		``,
		`data: {"error":{"message":"Concurrency limit exceeded","type":"rate_limit_error"}}`,
		``,
	}, "\n")
	stream := &convertedStream{
		src: bufio.NewReader(strings.NewReader(raw)), pending: make([]byte, 0, 4096),
		blocks: make(map[int]streamBlock),
	}
	out, err := io.ReadAll(stream)
	if err != nil {
		t.Fatal(err)
	}

	text := string(out)
	for _, want := range []string{"event: error", `"type":"rate_limit_error"`,
		`"message":"Concurrency limit exceeded"`} {
		if !strings.Contains(text, want) {
			t.Fatalf("converted stream lost the upstream error, missing %q:\n%s", want, text)
		}
	}
	// A message_stop here would tell the client the message completed normally.
	if strings.Contains(text, "event: message_stop") {
		t.Fatalf("a failed stream still claimed completion:\n%s", text)
	}
}

func TestResponsesStreamForwardsUpstreamError(t *testing.T) {
	raw := strings.Join([]string{
		`data: {"id":"chatcmpl-1","model":"gpt-4.1","choices":[{"delta":{"content":"he"}}]}`,
		``,
		`data: {"error":{"message":"Overloaded","type":"overloaded_error"}}`,
		``,
	}, "\n")
	stream := &responsesStream{src: bufio.NewReader(strings.NewReader(raw))}
	out, err := io.ReadAll(stream)
	if err != nil {
		t.Fatal(err)
	}

	text := string(out)
	for _, want := range []string{"event: response.failed", `"status":"failed"`,
		`"message":"Overloaded"`} {
		if !strings.Contains(text, want) {
			t.Fatalf("converted stream lost the upstream error, missing %q:\n%s", want, text)
		}
	}
	if strings.Contains(text, "event: response.completed") {
		t.Fatalf("a failed stream still claimed completion:\n%s", text)
	}
}
