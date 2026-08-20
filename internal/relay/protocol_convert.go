package relay

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// messagesToChat translates an Anthropic Messages request into the OpenAI
// Chat Completions shape used by the selected upstream channel.
func messagesToChat(body []byte, upstreamModel string) ([]byte, bool) {
	var in map[string]any
	if err := json.Unmarshal(body, &in); err != nil {
		return nil, false
	}
	out := make(map[string]any, len(in)+1)
	for key, value := range in {
		switch key {
		case "system", "messages", "tools", "tool_choice", "stop_sequences",
			"metadata", "thinking", "top_k", "container", "mcp_servers":
			continue
		default:
			out[key] = value
		}
	}
	out["model"] = upstreamModel
	if stop, ok := in["stop_sequences"]; ok {
		out["stop"] = stop
	}
	if stream, _ := in["stream"].(bool); stream {
		out["stream_options"] = map[string]any{"include_usage": true}
	}

	messages := make([]any, 0)
	if system, ok := in["system"]; ok {
		if content := textContent(system); content != "" {
			messages = append(messages, map[string]any{"role": "system", "content": content})
		}
	}
	if rawMessages, ok := in["messages"].([]any); ok {
		for _, raw := range rawMessages {
			message, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			messages = append(messages, convertMessagesTurn(message)...)
		}
	}
	out["messages"] = messages

	if tools, ok := in["tools"].([]any); ok {
		converted := make([]any, 0, len(tools))
		for _, raw := range tools {
			tool, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			function := map[string]any{"name": tool["name"]}
			if description, ok := tool["description"]; ok {
				function["description"] = description
			}
			if schema, ok := tool["input_schema"]; ok {
				function["parameters"] = schema
			}
			converted = append(converted, map[string]any{"type": "function", "function": function})
		}
		out["tools"] = converted
	}
	if choice, ok := in["tool_choice"]; ok {
		out["tool_choice"] = convertToolChoice(choice)
	}

	encoded, err := json.Marshal(out)
	return encoded, err == nil
}

func convertMessagesTurn(message map[string]any) []any {
	role, _ := message["role"].(string)
	if role == "" {
		role = "user"
	}
	blocks, blocksOK := message["content"].([]any)
	if !blocksOK {
		return []any{map[string]any{"role": role, "content": message["content"]}}
	}

	if role == "assistant" {
		content := make([]any, 0, len(blocks))
		toolCalls := make([]any, 0)
		for _, raw := range blocks {
			block, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			switch block["type"] {
			case "tool_use":
				arguments, _ := json.Marshal(block["input"])
				toolCalls = append(toolCalls, map[string]any{
					"id": block["id"], "type": "function",
					"function": map[string]any{"name": block["name"], "arguments": string(arguments)},
				})
			default:
				if part := chatContentPart(block); part != nil {
					content = append(content, part)
				}
			}
		}
		out := map[string]any{"role": "assistant", "content": collapseTextContent(content)}
		if len(toolCalls) > 0 {
			out["tool_calls"] = toolCalls
		}
		return []any{out}
	}

	turns := make([]any, 0, len(blocks)+1)
	content := make([]any, 0, len(blocks))
	flushContent := func() {
		if len(content) == 0 {
			return
		}
		turns = append(turns, map[string]any{"role": role, "content": collapseTextContent(content)})
		content = nil
	}
	for _, raw := range blocks {
		block, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if block["type"] == "tool_result" {
			flushContent()
			turns = append(turns, map[string]any{
				"role": "tool", "tool_call_id": block["tool_use_id"],
				"content": textContent(block["content"]),
			})
			continue
		}
		if part := chatContentPart(block); part != nil {
			content = append(content, part)
		}
	}
	flushContent()
	if len(turns) == 0 {
		turns = append(turns, map[string]any{"role": role, "content": ""})
	}
	return turns
}

func chatContentPart(block map[string]any) any {
	switch block["type"] {
	case "text":
		return map[string]any{"type": "text", "text": block["text"]}
	case "image":
		source, _ := block["source"].(map[string]any)
		var imageURL string
		switch source["type"] {
		case "base64":
			imageURL = fmt.Sprintf("data:%v;base64,%v", source["media_type"], source["data"])
		case "url":
			imageURL, _ = source["url"].(string)
		}
		if imageURL != "" {
			return map[string]any{"type": "image_url", "image_url": map[string]any{"url": imageURL}}
		}
	}
	return nil
}

func collapseTextContent(parts []any) any {
	if len(parts) == 1 {
		if part, ok := parts[0].(map[string]any); ok && part["type"] == "text" {
			return part["text"]
		}
	}
	return parts
}

func textContent(value any) string {
	switch content := value.(type) {
	case string:
		return content
	case []any:
		var texts []string
		for _, raw := range content {
			if block, ok := raw.(map[string]any); ok && block["type"] == "text" {
				if text, ok := block["text"].(string); ok && text != "" {
					texts = append(texts, text)
				}
			}
		}
		return strings.Join(texts, "\n")
	default:
		encoded, _ := json.Marshal(content)
		return string(encoded)
	}
}

func convertToolChoice(value any) any {
	choice, ok := value.(map[string]any)
	if !ok {
		return value
	}
	switch choice["type"] {
	case "any":
		return "required"
	case "auto", "none":
		return choice["type"]
	case "tool":
		return map[string]any{"type": "function", "function": map[string]any{"name": choice["name"]}}
	default:
		return value
	}
}

func messagesChatPath(path string) string {
	return strings.Replace(path, "/v1/messages", "/v1/chat/completions", 1)
}

func responsesChatPath(path string) string {
	return strings.Replace(path, "/v1/responses", "/v1/chat/completions", 1)
}

// responsesToChat translates the OpenAI Responses request shape to Chat
// Completions. The Responses API accepts input as a string or role/content
// items; both forms are normalised into chat messages.
func responsesToChat(body []byte, upstreamModel string) ([]byte, bool) {
	var in map[string]any
	if err := json.Unmarshal(body, &in); err != nil {
		return nil, false
	}
	out := make(map[string]any, len(in)+1)
	for key, value := range in {
		switch key {
		case "input", "instructions", "tools", "tool_choice", "max_output_tokens",
			"text", "reasoning", "include", "metadata", "previous_response_id",
			"background", "conversation", "prompt", "truncation", "max_tool_calls":
			continue
		default:
			out[key] = value
		}
	}
	out["model"] = upstreamModel
	if maxTokens, ok := in["max_output_tokens"]; ok {
		out["max_tokens"] = maxTokens
	}
	if stream, _ := in["stream"].(bool); stream {
		out["stream_options"] = map[string]any{"include_usage": true}
	}
	if instructions, ok := in["instructions"]; ok {
		if text := textContent(instructions); text != "" {
			out["messages"] = []any{map[string]any{"role": "system", "content": text}}
		}
	}
	messages := make([]any, 0)
	if existing, ok := out["messages"].([]any); ok {
		messages = append(messages, existing...)
	}
	if input, ok := in["input"]; ok {
		messages = append(messages, responsesInputMessages(input)...)
	}
	out["messages"] = messages
	if tools, ok := in["tools"].([]any); ok {
		converted := make([]any, 0, len(tools))
		for _, raw := range tools {
			tool, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			if _, wrapped := tool["function"]; wrapped {
				converted = append(converted, tool)
				continue
			}
			function := map[string]any{"name": tool["name"]}
			for _, key := range []string{"description", "parameters", "strict"} {
				if value, found := tool[key]; found {
					function[key] = value
				}
			}
			converted = append(converted, map[string]any{"type": "function", "function": function})
		}
		out["tools"] = converted
	}
	if choice, ok := in["tool_choice"]; ok {
		out["tool_choice"] = responsesToolChoice(choice)
	}
	if reasoning, ok := in["reasoning"].(map[string]any); ok {
		if effort, found := reasoning["effort"]; found {
			out["reasoning_effort"] = effort
		}
	}
	if text, ok := in["text"].(map[string]any); ok {
		if format, ok := text["format"].(map[string]any); ok {
			typ, _ := format["type"].(string)
			switch typ {
			case "json_schema":
				out["response_format"] = map[string]any{"type": "json_schema", "json_schema": map[string]any{
					"name": format["name"], "schema": format["schema"], "strict": format["strict"],
				}}
			case "json_object":
				out["response_format"] = map[string]any{"type": "json_object"}
			}
		}
	}
	encoded, err := json.Marshal(out)
	return encoded, err == nil
}

func responsesInputMessages(input any) []any {
	if text, ok := input.(string); ok {
		return []any{map[string]any{"role": "user", "content": text}}
	}
	items, ok := input.([]any)
	if !ok {
		return nil
	}
	out := make([]any, 0, len(items))
	for _, raw := range items {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		role, _ := item["role"].(string)
		if role == "" {
			role = "user"
		}
		content := item["content"]
		if content == nil {
			content = item["text"]
		}
		if typ, _ := item["type"].(string); typ == "input_text" || typ == "input_image" {
			if part := responsesContentPart(item); part != nil {
				content = collapseTextContent([]any{part})
			}
		}
		if blocks, ok := content.([]any); ok {
			parts := make([]any, 0, len(blocks))
			for _, block := range blocks {
				if converted := responsesContentPart(block); converted != nil {
					parts = append(parts, converted)
				}
			}
			content = collapseTextContent(parts)
		}
		message := map[string]any{"role": role, "content": content}
		if typ, _ := item["type"].(string); typ == "function_call_output" {
			message["role"] = "tool"
			message["tool_call_id"] = item["call_id"]
			message["content"] = textContent(item["output"])
		}
		if typ, _ := item["type"].(string); typ == "function_call" {
			arguments, _ := item["arguments"].(string)
			message = map[string]any{"role": "assistant", "content": nil,
				"tool_calls": []any{map[string]any{"id": item["call_id"], "type": "function",
					"function": map[string]any{"name": item["name"], "arguments": arguments}}}}
		}
		out = append(out, message)
	}
	return out
}

func responsesContentPart(value any) any {
	block, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	switch block["type"] {
	case "input_text", "output_text", "text":
		return map[string]any{"type": "text", "text": block["text"]}
	case "input_image":
		url, _ := block["image_url"].(string)
		if url != "" {
			return map[string]any{"type": "image_url", "image_url": map[string]any{"url": url}}
		}
	}
	return nil
}

func responsesToolChoice(value any) any {
	if choice, ok := value.(map[string]any); ok {
		if typ, _ := choice["type"].(string); typ == "function" {
			return map[string]any{"type": "function", "function": map[string]any{"name": choice["name"]}}
		}
	}
	return value
}

func convertChatResponseToResponses(resp *http.Response) (io.ReadCloser, http.Header, error) {
	headers := resp.Header.Clone()
	headers.Del("Content-Length")
	if strings.Contains(strings.ToLower(resp.Header.Get("Content-Type")), "event-stream") {
		headers.Set("Content-Type", "text/event-stream")
		return &responsesStream{src: bufio.NewReader(resp.Body), closer: resp.Body}, headers, nil
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxRequestBody+1))
	if err != nil || len(body) > maxRequestBody {
		return nil, nil, fmt.Errorf("chat response body is unavailable or too large")
	}
	converted, ok := chatResponseToResponses(body)
	if !ok {
		return nil, nil, fmt.Errorf("invalid chat response JSON")
	}
	headers.Set("Content-Type", "application/json")
	return io.NopCloser(bytes.NewReader(converted)), headers, nil
}

func chatResponseToResponses(body []byte) ([]byte, bool) {
	var in struct {
		ID      string `json:"id"`
		Model   string `json:"model"`
		Choices []struct {
			Message struct {
				Content   string `json:"content"`
				ToolCalls []struct {
					ID       string `json:"id"`
					Function struct {
						Name      string `json:"name"`
						Arguments string `json:"arguments"`
					} `json:"function"`
				} `json:"tool_calls"`
			} `json:"message"`
			Finish string `json:"finish_reason"`
		} `json:"choices"`
		Usage chatUsage `json:"usage"`
	}
	if err := json.Unmarshal(body, &in); err != nil || len(in.Choices) == 0 {
		return nil, false
	}
	choice := in.Choices[0]
	output := make([]any, 0, len(choice.Message.ToolCalls)+1)
	if choice.Message.Content != "" {
		output = append(output, map[string]any{"id": in.ID + "-message", "type": "message", "status": "completed", "role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": choice.Message.Content, "annotations": []any{}}}})
	}
	for _, call := range choice.Message.ToolCalls {
		output = append(output, map[string]any{"type": "function_call", "call_id": call.ID, "name": call.Function.Name, "arguments": call.Function.Arguments})
	}
	out := map[string]any{"id": in.ID, "object": "response", "status": "completed", "model": in.Model,
		"output": output, "output_text": choice.Message.Content,
		"usage": map[string]int{"input_tokens": in.Usage.Prompt, "output_tokens": in.Usage.Completion, "total_tokens": in.Usage.Prompt + in.Usage.Completion}}
	encoded, err := json.Marshal(out)
	return encoded, err == nil
}

type responsesStream struct {
	src             *bufio.Reader
	closer          io.Closer
	pending         []byte
	started         bool
	finished        bool
	textStarted     bool
	id, model, text string
	textItemID      string
	textOutputIndex int
	nextOutputIndex int
	usage           chatUsage
	tools           map[int]*responsesToolStream
	sequence        int
}

type responsesToolStream struct {
	itemID, callID, name, arguments string
	outputIndex                     int
}

func (s *responsesStream) Read(p []byte) (int, error) {
	for len(s.pending) == 0 {
		payload, done, err := readSSEData(s.src)
		if len(payload) > 0 && !bytes.Equal(payload, []byte("[DONE]")) {
			s.consume(payload)
		} else if bytes.Equal(payload, []byte("[DONE]")) {
			done = true
		}
		if done || err == io.EOF {
			s.finish()
			if len(s.pending) == 0 {
				return 0, io.EOF
			}
		} else if err != nil {
			return 0, err
		}
	}
	n := copy(p, s.pending)
	s.pending = s.pending[n:]
	return n, nil
}

func (s *responsesStream) Close() error {
	if s.closer != nil {
		return s.closer.Close()
	}
	return nil
}

func (s *responsesStream) consume(payload []byte) {
	var chunk struct {
		ID      string `json:"id"`
		Model   string `json:"model"`
		Choices []struct {
			Delta struct {
				Content   string `json:"content"`
				ToolCalls []struct {
					Index    int    `json:"index"`
					ID       string `json:"id"`
					Function struct {
						Name      string `json:"name"`
						Arguments string `json:"arguments"`
					} `json:"function"`
				} `json:"tool_calls"`
			} `json:"delta"`
		} `json:"choices"`
		Usage chatUsage `json:"usage"`
	}
	if json.Unmarshal(payload, &chunk) != nil {
		return
	}
	if chunk.ID != "" {
		s.id = chunk.ID
	}
	if chunk.Model != "" {
		s.model = chunk.Model
	}
	if chunk.Usage.Prompt > 0 || chunk.Usage.Completion > 0 {
		s.usage = chunk.Usage
	}
	if !s.started {
		s.started = true
		s.event("response.created", map[string]any{"type": "response.created", "response": map[string]any{"id": s.id, "object": "response", "status": "in_progress", "model": s.model, "output": []any{}}})
	}
	for _, choice := range chunk.Choices {
		if choice.Delta.Content != "" {
			s.startText()
			s.text += choice.Delta.Content
			s.event("response.output_text.delta", map[string]any{
				"type": "response.output_text.delta", "response_id": s.id,
				"item_id": s.textItemID, "output_index": s.textOutputIndex,
				"content_index": 0, "delta": choice.Delta.Content,
			})
		}
		for _, call := range choice.Delta.ToolCalls {
			tool := s.startTool(call.Index, call.ID, call.Function.Name)
			if call.Function.Arguments != "" {
				tool.arguments += call.Function.Arguments
				s.event("response.function_call_arguments.delta", map[string]any{
					"type": "response.function_call_arguments.delta", "response_id": s.id,
					"item_id": tool.itemID, "output_index": tool.outputIndex,
					"delta": call.Function.Arguments,
				})
			}
		}
	}
}

func (s *responsesStream) startText() {
	if s.textStarted {
		return
	}
	s.textStarted = true
	s.textItemID = s.id + "-message"
	s.textOutputIndex = s.nextOutputIndex
	s.nextOutputIndex++
	s.event("response.output_item.added", map[string]any{
		"type": "response.output_item.added", "response_id": s.id,
		"output_index": s.textOutputIndex,
		"item":         map[string]any{"id": s.textItemID, "type": "message", "status": "in_progress", "role": "assistant", "content": []any{}},
	})
	s.event("response.content_part.added", map[string]any{
		"type": "response.content_part.added", "response_id": s.id,
		"item_id": s.textItemID, "output_index": s.textOutputIndex, "content_index": 0,
		"part": map[string]any{"type": "output_text", "text": "", "annotations": []any{}},
	})
}

func (s *responsesStream) startTool(index int, callID, name string) *responsesToolStream {
	if s.tools == nil {
		s.tools = make(map[int]*responsesToolStream)
	}
	if tool := s.tools[index]; tool != nil {
		if tool.callID == "" {
			tool.callID = callID
		}
		if tool.name == "" {
			tool.name = name
		}
		return tool
	}
	itemID := callID
	if itemID == "" {
		itemID = fmt.Sprintf("%s-call-%d", s.id, index)
	}
	tool := &responsesToolStream{itemID: itemID, callID: callID, name: name, outputIndex: s.nextOutputIndex}
	s.nextOutputIndex++
	s.tools[index] = tool
	s.event("response.output_item.added", map[string]any{
		"type": "response.output_item.added", "response_id": s.id,
		"output_index": tool.outputIndex,
		"item":         map[string]any{"id": tool.itemID, "type": "function_call", "status": "in_progress", "call_id": tool.callID, "name": tool.name, "arguments": ""},
	})
	return tool
}

func (s *responsesStream) finish() {
	if s.finished {
		return
	}
	if !s.started {
		s.started = true
		s.event("response.created", map[string]any{"type": "response.created", "response": map[string]any{"id": s.id, "object": "response", "status": "in_progress", "model": s.model, "output": []any{}}})
	}
	output := make([]any, s.nextOutputIndex)
	if s.textStarted {
		part := map[string]any{"type": "output_text", "text": s.text, "annotations": []any{}}
		item := map[string]any{"id": s.textItemID, "type": "message", "status": "completed", "role": "assistant", "content": []any{part}}
		s.event("response.output_text.done", map[string]any{"type": "response.output_text.done", "response_id": s.id, "item_id": s.textItemID, "output_index": s.textOutputIndex, "content_index": 0, "text": s.text})
		s.event("response.content_part.done", map[string]any{"type": "response.content_part.done", "response_id": s.id, "item_id": s.textItemID, "output_index": s.textOutputIndex, "content_index": 0, "part": part})
		s.event("response.output_item.done", map[string]any{"type": "response.output_item.done", "response_id": s.id, "output_index": s.textOutputIndex, "item": item})
		output[s.textOutputIndex] = item
	}
	for outputIndex := 0; outputIndex < s.nextOutputIndex; outputIndex++ {
		for _, tool := range s.tools {
			if tool.outputIndex != outputIndex {
				continue
			}
			item := map[string]any{"id": tool.itemID, "type": "function_call", "status": "completed", "call_id": tool.callID, "name": tool.name, "arguments": tool.arguments}
			s.event("response.function_call_arguments.done", map[string]any{"type": "response.function_call_arguments.done", "response_id": s.id, "item_id": tool.itemID, "output_index": tool.outputIndex, "arguments": tool.arguments})
			s.event("response.output_item.done", map[string]any{"type": "response.output_item.done", "response_id": s.id, "output_index": tool.outputIndex, "item": item})
			output[tool.outputIndex] = item
			break
		}
	}
	s.event("response.completed", map[string]any{"type": "response.completed", "response": map[string]any{"id": s.id, "object": "response", "status": "completed", "model": s.model, "output": output, "output_text": s.text, "usage": map[string]int{"input_tokens": s.usage.Prompt, "output_tokens": s.usage.Completion, "total_tokens": s.usage.Prompt + s.usage.Completion}}})
	s.finished = true
}

func (s *responsesStream) event(name string, payload any) {
	if object, ok := payload.(map[string]any); ok {
		object["sequence_number"] = s.sequence
		s.sequence++
	}
	encoded, _ := json.Marshal(payload)
	s.pending = append(s.pending, "event: "...)
	s.pending = append(s.pending, name...)
	s.pending = append(s.pending, "\ndata: "...)
	s.pending = append(s.pending, encoded...)
	s.pending = append(s.pending, '\n', '\n')
}

func convertChatResponse(resp *http.Response) (io.ReadCloser, http.Header, error) {
	headers := resp.Header.Clone()
	headers.Del("Content-Length")
	if strings.Contains(strings.ToLower(resp.Header.Get("Content-Type")), "event-stream") {
		headers.Set("Content-Type", "text/event-stream")
		return &convertedStream{
			src: bufio.NewReader(resp.Body), closer: resp.Body,
			pending: make([]byte, 0, 4096), blocks: make(map[int]streamBlock),
		}, headers, nil
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxRequestBody+1))
	if err != nil {
		return nil, nil, err
	}
	if len(body) > maxRequestBody {
		return nil, nil, fmt.Errorf("chat response exceeds %d bytes", maxRequestBody)
	}
	converted, ok := chatResponseToMessages(body)
	if !ok {
		return nil, nil, fmt.Errorf("invalid chat response JSON")
	}
	headers.Set("Content-Type", "application/json")
	return io.NopCloser(bytes.NewReader(converted)), headers, nil
}

func chatResponseToMessages(body []byte) ([]byte, bool) {
	var in struct {
		ID      string `json:"id"`
		Model   string `json:"model"`
		Choices []struct {
			Message struct {
				Content   any `json:"content"`
				ToolCalls []struct {
					ID       string `json:"id"`
					Function struct {
						Name      string `json:"name"`
						Arguments string `json:"arguments"`
					} `json:"function"`
				} `json:"tool_calls"`
			} `json:"message"`
			Finish string `json:"finish_reason"`
		} `json:"choices"`
		Usage chatUsage `json:"usage"`
	}
	if err := json.Unmarshal(body, &in); err != nil || len(in.Choices) == 0 {
		return nil, false
	}
	choice := in.Choices[0]
	content := make([]any, 0, len(choice.Message.ToolCalls)+1)
	if text, ok := choice.Message.Content.(string); ok && text != "" {
		content = append(content, map[string]any{"type": "text", "text": text})
	}
	for _, call := range choice.Message.ToolCalls {
		var input any = map[string]any{}
		if strings.TrimSpace(call.Function.Arguments) != "" {
			if err := json.Unmarshal([]byte(call.Function.Arguments), &input); err != nil {
				input = map[string]any{"raw": call.Function.Arguments}
			}
		}
		content = append(content, map[string]any{
			"type": "tool_use", "id": call.ID, "name": call.Function.Name, "input": input,
		})
	}
	out := map[string]any{
		"id": in.ID, "type": "message", "role": "assistant", "model": in.Model,
		"content": content, "stop_reason": messagesStopReason(choice.Finish), "stop_sequence": nil,
		"usage": messagesUsage(in.Usage),
	}
	encoded, err := json.Marshal(out)
	return encoded, err == nil
}

type chatUsage struct {
	Prompt     int `json:"prompt_tokens"`
	Completion int `json:"completion_tokens"`
	Details    *struct {
		Cached int `json:"cached_tokens"`
	} `json:"prompt_tokens_details"`
}

func messagesUsage(usage chatUsage) map[string]int {
	out := map[string]int{"input_tokens": usage.Prompt, "output_tokens": usage.Completion}
	if usage.Details != nil && usage.Details.Cached > 0 {
		out["cache_read_input_tokens"] = usage.Details.Cached
	}
	return out
}

func messagesStopReason(reason string) string {
	switch reason {
	case "length":
		return "max_tokens"
	case "tool_calls", "function_call":
		return "tool_use"
	default:
		return "end_turn"
	}
}

type streamBlock struct {
	index int
}

type convertedStream struct {
	src      *bufio.Reader
	closer   io.Closer
	pending  []byte
	started  bool
	finished bool
	message  string
	model    string
	stop     string
	usage    chatUsage
	blocks   map[int]streamBlock
	next     int
	toolKeys map[int]int
}

func (s *convertedStream) Read(p []byte) (int, error) {
	for len(s.pending) == 0 {
		payload, done, err := readSSEData(s.src)
		if len(payload) > 0 {
			if bytes.Equal(payload, []byte("[DONE]")) {
				done = true
			} else {
				s.consume(payload)
			}
		}
		if done || err == io.EOF {
			s.finish()
			if len(s.pending) == 0 {
				return 0, io.EOF
			}
		} else if err != nil {
			return 0, err
		}
	}
	n := copy(p, s.pending)
	s.pending = s.pending[n:]
	return n, nil
}

func (s *convertedStream) Close() error {
	if s.closer != nil {
		return s.closer.Close()
	}
	return nil
}

func readSSEData(reader *bufio.Reader) ([]byte, bool, error) {
	var data []byte
	for {
		line, err := reader.ReadBytes('\n')
		trimmed := bytes.TrimSpace(line)
		if payload, ok := bytes.CutPrefix(trimmed, []byte("data:")); ok {
			if len(data) > 0 {
				data = append(data, '\n')
			}
			data = append(data, bytes.TrimSpace(payload)...)
		}
		if len(trimmed) == 0 && len(data) > 0 {
			return data, false, nil
		}
		if err != nil {
			return data, false, err
		}
	}
}

func (s *convertedStream) consume(payload []byte) {
	var chunk struct {
		ID      string    `json:"id"`
		Model   string    `json:"model"`
		Usage   chatUsage `json:"usage"`
		Choices []struct {
			Delta struct {
				Role      string `json:"role"`
				Content   string `json:"content"`
				ToolCalls []struct {
					Index    int    `json:"index"`
					ID       string `json:"id"`
					Function struct {
						Name      string `json:"name"`
						Arguments string `json:"arguments"`
					} `json:"function"`
				} `json:"tool_calls"`
			} `json:"delta"`
			Finish string `json:"finish_reason"`
		} `json:"choices"`
	}
	if json.Unmarshal(payload, &chunk) != nil {
		return
	}
	if chunk.ID != "" {
		s.message = chunk.ID
	}
	if chunk.Model != "" {
		s.model = chunk.Model
	}
	if chunk.Usage.Prompt > 0 || chunk.Usage.Completion > 0 {
		s.usage = chunk.Usage
	}
	s.start()
	for _, choice := range chunk.Choices {
		if choice.Delta.Content != "" {
			block := s.ensureBlock(-1, "text", "", "")
			s.event("content_block_delta", map[string]any{
				"type": "content_block_delta", "index": block.index,
				"delta": map[string]any{"type": "text_delta", "text": choice.Delta.Content},
			})
		}
		for _, call := range choice.Delta.ToolCalls {
			block := s.ensureToolBlock(call.Index, call.ID, call.Function.Name)
			if call.Function.Arguments != "" {
				s.event("content_block_delta", map[string]any{
					"type": "content_block_delta", "index": block.index,
					"delta": map[string]any{"type": "input_json_delta", "partial_json": call.Function.Arguments},
				})
			}
		}
		if choice.Finish != "" {
			s.stop = choice.Finish
		}
	}
}

func (s *convertedStream) ensureToolBlock(sourceIndex int, id, name string) streamBlock {
	if s.toolKeys == nil {
		s.toolKeys = make(map[int]int)
	}
	if key, ok := s.toolKeys[sourceIndex]; ok {
		return s.blocks[key]
	}
	// Text owns the synthetic -1 key; tool-call indices start at zero, so
	// offset them to keep the two block namespaces distinct.
	key := sourceIndex + 1
	s.toolKeys[sourceIndex] = key
	return s.ensureBlock(key, "tool_use", id, name)
}

func (s *convertedStream) start() {
	if s.started {
		return
	}
	s.started = true
	s.event("message_start", map[string]any{
		"type": "message_start",
		"message": map[string]any{
			"id": s.message, "type": "message", "role": "assistant", "model": s.model,
			"content": []any{}, "stop_reason": nil, "stop_sequence": nil,
			"usage": map[string]int{"input_tokens": s.usage.Prompt, "output_tokens": 0},
		},
	})
}

func (s *convertedStream) ensureBlock(sourceIndex int, kind, id, name string) streamBlock {
	key := sourceIndex
	if kind == "text" {
		key = -1
	}
	if block, ok := s.blocks[key]; ok {
		return block
	}
	block := streamBlock{index: s.next}
	s.next++
	s.blocks[key] = block
	content := map[string]any{"type": kind}
	if kind == "text" {
		content["text"] = ""
	} else {
		content["id"] = id
		content["name"] = name
		content["input"] = map[string]any{}
	}
	s.event("content_block_start", map[string]any{
		"type": "content_block_start", "index": block.index, "content_block": content,
	})
	return block
}

func (s *convertedStream) finish() {
	if s.finished {
		return
	}
	s.start()
	for index := 0; index < s.next; index++ {
		s.event("content_block_stop", map[string]any{
			"type": "content_block_stop", "index": index,
		})
	}
	s.event("message_delta", map[string]any{
		"type":  "message_delta",
		"delta": map[string]any{"stop_reason": messagesStopReason(s.stop), "stop_sequence": nil},
		"usage": map[string]int{
			"input_tokens": s.usage.Prompt, "output_tokens": s.usage.Completion,
		},
	})
	s.event("message_stop", map[string]any{"type": "message_stop"})
	s.finished = true
}

func (s *convertedStream) event(name string, payload any) {
	encoded, _ := json.Marshal(payload)
	s.pending = append(s.pending, "event: "...)
	s.pending = append(s.pending, name...)
	s.pending = append(s.pending, "\ndata: "...)
	s.pending = append(s.pending, encoded...)
	s.pending = append(s.pending, '\n', '\n')
}
