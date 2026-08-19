package provider

import (
	"encoding/json"

	"github.com/faketoken/faketoken/internal/model"
)

// rawUsage covers the OpenAI, Anthropic and Gemini token-accounting shapes in
// one struct so a single pass can score any upstream payload.
type rawUsage struct {
	Usage *struct {
		// OpenAI
		PromptTokens        int `json:"prompt_tokens"`
		CompletionTokens    int `json:"completion_tokens"`
		TotalTokens         int `json:"total_tokens"`
		PromptTokensDetails *struct {
			CachedTokens int `json:"cached_tokens"`
		} `json:"prompt_tokens_details"`
		// Anthropic
		InputTokens              int `json:"input_tokens"`
		OutputTokens             int `json:"output_tokens"`
		CacheReadInputTokens     int `json:"cache_read_input_tokens"`
		CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
	} `json:"usage"`

	// Gemini
	UsageMetadata *struct {
		PromptTokenCount        int `json:"promptTokenCount"`
		CandidatesTokenCount    int `json:"candidatesTokenCount"`
		ThoughtsTokenCount      int `json:"thoughtsTokenCount"`
		TotalTokenCount         int `json:"totalTokenCount"`
		CachedContentTokenCount int `json:"cachedContentTokenCount"`
	} `json:"usageMetadata"`

	// Anthropic Messages API wraps usage inside message_start events.
	Message *struct {
		Usage *struct {
			InputTokens              int `json:"input_tokens"`
			OutputTokens             int `json:"output_tokens"`
			CacheReadInputTokens     int `json:"cache_read_input_tokens"`
			CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
		} `json:"usage"`
	} `json:"message"`

	// Anthropic Responses API wraps usage inside response.completed events.
	Response *struct {
		Usage *struct {
			InputTokens        int `json:"input_tokens"`
			OutputTokens       int `json:"output_tokens"`
			TotalTokens        int `json:"total_tokens"`
			InputTokensDetails *struct {
				CacheWriteTokens int `json:"cache_write_tokens"`
				CachedTokens     int `json:"cached_tokens"`
			} `json:"input_tokens_details"`
		} `json:"usage"`
	} `json:"response"`
}

// ExtractUsage returns the token counts carried by a single JSON payload,
// which may be a full response body or one streamed event.
func ExtractUsage(payload []byte) (model.Usage, bool) {
	var raw rawUsage
	if err := json.Unmarshal(payload, &raw); err != nil {
		return model.Usage{}, false
	}

	var u model.Usage
	found := false

	if r := raw.Usage; r != nil {
		found = true
		u.PromptTokens = max(r.PromptTokens, r.InputTokens+r.CacheReadInputTokens+r.CacheCreationInputTokens)
		u.CompletionTokens = max(r.CompletionTokens, r.OutputTokens)
		u.TotalTokens = r.TotalTokens
		if r.PromptTokensDetails != nil {
			u.CachedTokens = r.PromptTokensDetails.CachedTokens
		}
		if r.CacheReadInputTokens > 0 {
			u.CachedTokens = max(u.CachedTokens, r.CacheReadInputTokens)
		}
		u.CacheCreationTokens = max(u.CacheCreationTokens, r.CacheCreationInputTokens)
	}

	if m := raw.Message; m != nil && m.Usage != nil {
		found = true
		r := m.Usage
		u.PromptTokens = max(u.PromptTokens,
			r.InputTokens+r.CacheReadInputTokens+r.CacheCreationInputTokens)
		u.CompletionTokens = max(u.CompletionTokens, r.OutputTokens)
		u.CachedTokens = max(u.CachedTokens, r.CacheReadInputTokens)
		u.CacheCreationTokens = max(u.CacheCreationTokens, r.CacheCreationInputTokens)
	}

	if resp := raw.Response; resp != nil && resp.Usage != nil {
		found = true
		r := resp.Usage
		// In the Responses API input_tokens already includes cache write and
		// cached tokens, so no arithmetic is needed on the prompt side.
		u.PromptTokens = max(u.PromptTokens, r.InputTokens)
		u.CompletionTokens = max(u.CompletionTokens, r.OutputTokens)
		u.TotalTokens = max(u.TotalTokens, r.TotalTokens)
		if r.InputTokensDetails != nil {
			u.CachedTokens = max(u.CachedTokens, r.InputTokensDetails.CachedTokens)
			u.CacheCreationTokens = max(u.CacheCreationTokens, r.InputTokensDetails.CacheWriteTokens)
		}
	}

	if g := raw.UsageMetadata; g != nil {
		found = true
		u.PromptTokens = max(u.PromptTokens, g.PromptTokenCount)
		u.CompletionTokens = max(u.CompletionTokens, g.CandidatesTokenCount+g.ThoughtsTokenCount)
		u.TotalTokens = max(u.TotalTokens, g.TotalTokenCount)
		u.CachedTokens = max(u.CachedTokens, g.CachedContentTokenCount)
	}

	if !found {
		return model.Usage{}, false
	}
	if u.TotalTokens == 0 {
		u.TotalTokens = u.PromptTokens + u.CompletionTokens
	}
	return u, true
}

// UsageAccumulator folds the usage reported across a streamed response.
// Every dialect reports cumulative counters, so a field-wise maximum yields
// the correct final totals no matter which events carry them.
type UsageAccumulator struct {
	usage model.Usage
	seen  bool
}

func (a *UsageAccumulator) Add(u model.Usage) {
	a.seen = true
	a.usage.PromptTokens = max(a.usage.PromptTokens, u.PromptTokens)
	a.usage.CompletionTokens = max(a.usage.CompletionTokens, u.CompletionTokens)
	a.usage.CachedTokens = max(a.usage.CachedTokens, u.CachedTokens)
	a.usage.CacheCreationTokens = max(a.usage.CacheCreationTokens, u.CacheCreationTokens)
	a.usage.TotalTokens = max(a.usage.TotalTokens, u.TotalTokens)
}

func (a *UsageAccumulator) Feed(payload []byte) bool {
	u, ok := ExtractUsage(payload)
	if !ok {
		return false
	}
	a.Add(u)
	return true
}

func (a *UsageAccumulator) Result() (model.Usage, bool) {
	u := a.usage
	if u.TotalTokens < u.PromptTokens+u.CompletionTokens {
		u.TotalTokens = u.PromptTokens + u.CompletionTokens
	}
	return u, a.seen
}
