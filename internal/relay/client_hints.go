package relay

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
)

// Two labels a log reader keeps wanting: how hard the model was told to think,
// and which tool made the call. Both are read from the request the client
// already sent — nothing is added to the forwarded bytes.

// reasoningEffort reads the requested thinking budget from a JSON body.
//
// The three dialects spell it differently, and a client may send more than one
// spelling, so the order below is the order of authority: the explicit
// top-level field wins over a nested config.
func reasoningEffort(body []byte, isJSON bool) string {
	if !isJSON || len(body) == 0 {
		return ""
	}
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(body, &payload); err != nil {
		return ""
	}

	// OpenAI chat completions and the o-series: "reasoning_effort": "high".
	if effort := jsonString(payload["reasoning_effort"]); effort != "" {
		return effort
	}
	// OpenAI Responses API: "reasoning": {"effort": "high"}.
	if effort := nestedString(payload["reasoning"], "effort"); effort != "" {
		return effort
	}
	// Anthropic output config, same shape.
	if effort := nestedString(payload["output_config"], "effort"); effort != "" {
		return effort
	}
	// Anthropic extended thinking states a token budget instead of a level.
	// Reporting it as "N tokens" keeps the column meaningful without pretending
	// a budget maps onto low/medium/high.
	if budget := thinkingBudget(payload["thinking"]); budget != "" {
		return budget
	}
	// Gemini: "generationConfig": {"thinkingConfig": {"thinkingBudget": N}}.
	if raw, ok := payload["generationConfig"]; ok {
		var config map[string]json.RawMessage
		if json.Unmarshal(raw, &config) == nil {
			if budget := thinkingBudget(config["thinkingConfig"]); budget != "" {
				return budget
			}
		}
	}
	return ""
}

func jsonString(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var value string
	if json.Unmarshal(raw, &value) != nil {
		return ""
	}
	return strings.TrimSpace(value)
}

func nestedString(raw json.RawMessage, key string) string {
	if len(raw) == 0 {
		return ""
	}
	var object map[string]json.RawMessage
	if json.Unmarshal(raw, &object) != nil {
		return ""
	}
	return jsonString(object[key])
}

// thinkingBudget renders a token budget, and reports a disabled block as
// nothing rather than as a zero budget.
func thinkingBudget(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var block struct {
		Type           string `json:"type"`
		BudgetTokens   *int   `json:"budget_tokens"`
		ThinkingBudget *int   `json:"thinkingBudget"`
	}
	if json.Unmarshal(raw, &block) != nil {
		return ""
	}
	if strings.EqualFold(block.Type, "disabled") {
		return ""
	}

	budget := block.BudgetTokens
	if budget == nil {
		budget = block.ThinkingBudget
	}
	if budget == nil || *budget <= 0 {
		// An enabled block with no budget still says the caller asked to think.
		if strings.EqualFold(block.Type, "enabled") {
			return "enabled"
		}
		return ""
	}
	return formatTokenBudget(*budget)
}

func formatTokenBudget(tokens int) string {
	if tokens >= 1000 && tokens%1000 == 0 {
		return strconv.Itoa(tokens/1000) + "k tokens"
	}
	return strconv.Itoa(tokens) + " tokens"
}

// clientType labels the caller from the headers its SDK or CLI already sends.
//
// Every branch is a guess from a self-reported string, so this is only ever a
// convenience label — nothing is authorised on the strength of it.
func clientType(r *http.Request) string {
	// Separators are normalised because the same product spells itself
	// differently depending on where the string came from: "Codex Desktop",
	// "codex_cli_rs" and "codex-tui" are all one family.
	normalize := func(value string) string {
		lowered := strings.ToLower(value)
		return strings.NewReplacer("_", "-", " ", "-").Replace(lowered)
	}
	both := normalize(r.Header.Get("Originator")) + " " + normalize(r.Header.Get("User-Agent"))

	switch {
	case strings.Contains(both, "codex-desktop"):
		return "codex-desktop"
	case strings.Contains(both, "codex-tui"):
		return "codex-tui"
	case strings.Contains(both, "codex"):
		return "codex"
	// Claude Code identifies itself as claude-cli; the product name never
	// appears in the agent string, which is why it used to fall through.
	case strings.Contains(both, "claude-code"), strings.Contains(both, "claude-cli"):
		return "claude-code"
	case strings.Contains(both, "axonhub"):
		return "axonhub"
	case strings.Contains(both, "opencode"):
		return "opencode"
	case strings.Contains(both, "cherrystudio"), strings.Contains(both, "cherry studio"):
		return "cherry-studio"
	case strings.Contains(both, "chatbox"):
		return "chatbox"
	case strings.Contains(both, "lobehub"), strings.Contains(both, "lobe-chat"):
		return "lobe-chat"
	case strings.Contains(both, "cline"):
		return "cline"
	case strings.Contains(both, "roo"):
		return "roo-code"
	case strings.Contains(both, "openai-python"), strings.Contains(both, "openai-node"):
		return "openai-sdk"
	case strings.Contains(both, "anthropic-sdk"), strings.Contains(both, "anthropic-python"):
		return "anthropic-sdk"
	case strings.Contains(both, "langchain"):
		return "langchain"
	case strings.Contains(both, "curl"):
		return "curl"
	case strings.Contains(both, "python-requests"), strings.Contains(both, "httpx"):
		return "python"
	}

	// The console's own probes and playground reach the relay like any client.
	if strings.Contains(both, "mozilla") || strings.Contains(both, "chrome") ||
		strings.Contains(both, "safari") {
		return "browser"
	}
	// Deliberately no fallback on Anthropic-Version. That header is required by
	// the Anthropic protocol, so every client calling /v1/messages sends it —
	// curl included. Treating it as evidence of the SDK labelled every
	// unrecognised Anthropic caller "anthropic-sdk", which was simply wrong.
	// An honest "unknown" is more useful than a confident mislabel.
	return "unknown"
}
