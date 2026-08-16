package relay

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode"
)

// blockedReplyText is what a blocked request is answered with instead of the
// content it asked for.
const blockedReplyText = `沁园春·雪

北国风光，千里冰封，万里雪飘。
望长城内外，惟余莽莽；大河上下，顿失滔滔。
山舞银蛇，原驰蜡象，欲与天公试比高。
须晴日，看红装素裹，分外妖娆。

江山如此多娇，引无数英雄竞折腰。
惜秦皇汉武，略输文采；唐宗宋祖，稍逊风骚。
一代天骄，成吉思汗，只识弯弓射大雕。
俱往矣，数风流人物，还看今朝。`

// cannedDialect is the response shape a canned reply has to imitate. A reply
// in the wrong shape is worse than an error: the client fails to parse it and
// reports something unrelated.
type cannedDialect int

const (
	// cannedNone means the endpoint has no sensible text reply — embeddings,
	// audio and image endpoints all expect their own structure, and a poem
	// where a vector belongs would only produce a confusing parse error.
	cannedNone cannedDialect = iota
	cannedOpenAIChat
	cannedAnthropic
	cannedGemini
)

func cannedDialectFor(path string) cannedDialect {
	switch {
	case strings.Contains(path, "/messages"):
		return cannedAnthropic
	case strings.Contains(path, ":generateContent"),
		strings.Contains(path, ":streamGenerateContent"):
		return cannedGemini
	case strings.HasSuffix(path, "/chat/completions"), strings.HasSuffix(path, "/completions"):
		return cannedOpenAIChat
	}
	return cannedNone
}

// cannedUsage is the token accounting a canned reply reports.
//
// A reply that claims zero tokens is the one thing that gives it away: every
// real answer carries a count, and a client that reads usage sees a request
// that apparently cost nothing. The numbers are estimated rather than counted,
// because no model was asked — they only have to be the right order of
// magnitude for the reply to read as ordinary.
type cannedUsage struct {
	Prompt     int
	Completion int
}

func (u cannedUsage) total() int { return u.Prompt + u.Completion }

// estimateTokens approximates what a tokenizer would return.
//
// Two classes, because one ratio does not fit both: CJK text runs at roughly a
// token per character, while Latin text is nearer four characters per token.
// Treating everything as Latin under-reports a Chinese prompt several-fold.
func estimateTokens(text string) int {
	cjk, other := 0, 0
	for _, r := range text {
		switch {
		case unicode.In(r, unicode.Han, unicode.Hiragana, unicode.Katakana, unicode.Hangul):
			cjk++
		case unicode.IsSpace(r):
			// Whitespace mostly rides along with an adjacent token.
		default:
			other++
		}
	}
	tokens := cjk + other/4
	if tokens == 0 && len(text) > 0 {
		return 1
	}
	return tokens
}

// writeCannedReply answers as though a model had produced text, in whichever
// dialect the caller used. It returns the bytes it wrote so the full log shows
// what the client actually received.
func writeCannedReply(w http.ResponseWriter, dialect cannedDialect,
	model string, stream bool, text string, usage cannedUsage) string {

	switch dialect {
	case cannedAnthropic:
		if stream {
			return writeAnthropicStream(w, model, text, usage)
		}
		return writeCannedJSON(w, anthropicMessage(model, text, usage))
	case cannedGemini:
		if stream {
			return writeGeminiStream(w, text, usage)
		}
		return writeCannedJSON(w, geminiMessage(text, usage))
	default:
		if stream {
			return writeOpenAIStream(w, model, text, usage)
		}
		return writeCannedJSON(w, openAIMessage(model, text, usage))
	}
}

// writeCannedJSON differs from writeJSON above in returning what it wrote, so
// the stored log holds the exact bytes the client received.
func writeCannedJSON(w http.ResponseWriter, payload any) string {
	body, err := json.Marshal(payload)
	if err != nil {
		return ""
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
	return string(body)
}

// beginStream sets the headers an SSE reader expects and returns the flusher,
// so each event reaches the client instead of sitting in a buffer.
func beginStream(w http.ResponseWriter) http.Flusher {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	if flusher != nil {
		flusher.Flush()
	}
	return flusher
}

func sendEvent(w http.ResponseWriter, flusher http.Flusher, sb *strings.Builder,
	name string, payload any) {

	var frame string
	if payload == nil {
		frame = "data: [DONE]\n\n"
	} else {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return
		}
		if name != "" {
			frame = fmt.Sprintf("event: %s\ndata: %s\n\n", name, encoded)
		} else {
			frame = fmt.Sprintf("data: %s\n\n", encoded)
		}
	}
	sb.WriteString(frame)
	_, _ = w.Write([]byte(frame))
	if flusher != nil {
		flusher.Flush()
	}
}

// ------------------------------------------------------------------- OpenAI

func openAIMessage(model, text string, usage cannedUsage) map[string]any {
	return map[string]any{
		"id":      "chatcmpl-blocked",
		"object":  "chat.completion",
		"created": time.Now().Unix(),
		"model":   model,
		"choices": []map[string]any{{
			"index":         0,
			"message":       map[string]string{"role": "assistant", "content": text},
			"finish_reason": "stop",
		}},
		"usage": map[string]int{
			"prompt_tokens":     usage.Prompt,
			"completion_tokens": usage.Completion,
			"total_tokens":      usage.total(),
		},
	}
}

func writeOpenAIStream(w http.ResponseWriter, model, text string, usage cannedUsage) string {
	flusher := beginStream(w)
	var sb strings.Builder

	chunk := func(delta map[string]any, finish any) map[string]any {
		return map[string]any{
			"id":      "chatcmpl-blocked",
			"object":  "chat.completion.chunk",
			"created": time.Now().Unix(),
			"model":   model,
			"choices": []map[string]any{{
				"index": 0, "delta": delta, "finish_reason": finish,
			}},
		}
	}

	sendEvent(w, flusher, &sb, "", chunk(map[string]any{"role": "assistant"}, nil))
	sendEvent(w, flusher, &sb, "", chunk(map[string]any{"content": text}, nil))
	// The final chunk carries usage, which is where a streaming client reads
	// it from; stream_options.include_usage asks for exactly this.
	final := chunk(map[string]any{}, "stop")
	final["usage"] = map[string]int{
		"prompt_tokens":     usage.Prompt,
		"completion_tokens": usage.Completion,
		"total_tokens":      usage.total(),
	}
	sendEvent(w, flusher, &sb, "", final)
	sendEvent(w, flusher, &sb, "", nil)
	return sb.String()
}

// ---------------------------------------------------------------- Anthropic

func anthropicMessage(model, text string, usage cannedUsage) map[string]any {
	return map[string]any{
		"id":            "msg_blocked",
		"type":          "message",
		"role":          "assistant",
		"model":         model,
		"content":       []map[string]any{{"type": "text", "text": text}},
		"stop_reason":   "end_turn",
		"stop_sequence": nil,
		"usage": map[string]int{
			"input_tokens":                usage.Prompt,
			"output_tokens":               usage.Completion,
			"cache_creation_input_tokens": 0,
			"cache_read_input_tokens":     0,
		},
	}
}

func writeAnthropicStream(w http.ResponseWriter, model, text string, usage cannedUsage) string {
	flusher := beginStream(w)
	var sb strings.Builder

	// A real stream reports the input count up front and the output count at
	// the end, because the second is not known until the text has been
	// produced. Reporting both twice would not match what clients accumulate.
	start := anthropicMessage(model, "", cannedUsage{Prompt: usage.Prompt})
	start["content"] = []map[string]any{}
	sendEvent(w, flusher, &sb, "message_start", map[string]any{
		"type": "message_start", "message": start,
	})
	sendEvent(w, flusher, &sb, "content_block_start", map[string]any{
		"type": "content_block_start", "index": 0,
		"content_block": map[string]any{"type": "text", "text": ""},
	})
	sendEvent(w, flusher, &sb, "content_block_delta", map[string]any{
		"type": "content_block_delta", "index": 0,
		"delta": map[string]any{"type": "text_delta", "text": text},
	})
	sendEvent(w, flusher, &sb, "content_block_stop", map[string]any{
		"type": "content_block_stop", "index": 0,
	})
	sendEvent(w, flusher, &sb, "message_delta", map[string]any{
		"type":  "message_delta",
		"delta": map[string]any{"stop_reason": "end_turn", "stop_sequence": nil},
		"usage": map[string]int{"output_tokens": usage.Completion},
	})
	sendEvent(w, flusher, &sb, "message_stop", map[string]any{"type": "message_stop"})
	return sb.String()
}

// ------------------------------------------------------------------- Gemini

func geminiMessage(text string, usage cannedUsage) map[string]any {
	return map[string]any{
		"candidates": []map[string]any{{
			"content":      map[string]any{"role": "model", "parts": []map[string]any{{"text": text}}},
			"finishReason": "STOP",
			"index":        0,
		}},
		"usageMetadata": map[string]int{
			"promptTokenCount":     usage.Prompt,
			"candidatesTokenCount": usage.Completion,
			"totalTokenCount":      usage.total(),
		},
	}
}

// writeGeminiStream emits SSE. Gemini streams as a JSON array unless the
// caller asks for alt=sse, but every client that sets stream also sets that,
// and an array would have to be buffered whole before it could be read.
func writeGeminiStream(w http.ResponseWriter, text string, usage cannedUsage) string {
	flusher := beginStream(w)
	var sb strings.Builder
	sendEvent(w, flusher, &sb, "", geminiMessage(text, usage))
	return sb.String()
}
