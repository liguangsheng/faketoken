package relay

import (
	"encoding/json"
	"strings"
)

// A channel's thinking-level vocabulary. Upstreams disagree about what the
// levels are called — one accepts "xhigh", the next has never heard of it and
// rejects the whole request — so a channel may rename the level a caller asked
// for on its way out ("max" -> "xhigh").
//
// Reading the level for the log lives in client_hints.go. This is the only
// place that changes it, and it changes nothing else: the rename is spliced
// into the bytes the client sent, so field order, whitespace and numeric
// formatting survive exactly as they do for a model rewrite.

// effortFields are the dialect spellings that carry a *named* level. An empty
// outer key means the field sits at the top level.
//
// The numeric budgets — Anthropic's thinking.budget_tokens and Gemini's
// thinkingBudget — are deliberately absent. A rule renames one level to
// another; inventing a token count for "max" would be a different feature, and
// a wrong guess there costs real money.
var effortFields = []struct{ outer, inner string }{
	{inner: "reasoning_effort"},               // OpenAI chat completions
	{outer: "reasoning", inner: "effort"},     // OpenAI Responses
	{outer: "output_config", inner: "effort"}, // Anthropic output config
}

// rewriteReasoningEffort applies the channel's rules to an outgoing body and
// reports the rename it made, so the caller can log what the upstream actually
// received.
//
// Every spelling present is rewritten, not just the first one found: a client
// that sent two of them would otherwise have one field renamed and the other
// left saying the level this upstream refuses, which is the failure the mapping
// exists to prevent. A level with no rule is forwarded untouched.
func rewriteReasoningEffort(body []byte, mapping map[string]string) ([]byte, string, string) {
	if len(mapping) == 0 || len(body) == 0 {
		return body, "", ""
	}
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(body, &payload); err != nil {
		return body, "", ""
	}

	out := body
	appliedFrom, appliedTo := "", ""
	for _, field := range effortFields {
		from := jsonString(payload[field.inner])
		if field.outer != "" {
			from = nestedString(payload[field.outer], field.inner)
		}
		if from == "" {
			continue
		}
		to, ruled := mapping[strings.ToLower(from)]
		if !ruled || to == from {
			continue
		}

		spliced, ok := spliceTopLevelString(out, field.inner, to)
		if field.outer != "" {
			spliced, ok = spliceNestedString(out, field.outer, field.inner, to)
		}
		if !ok {
			continue
		}
		out, appliedFrom, appliedTo = spliced, from, to
	}
	return out, appliedFrom, appliedTo
}
