package api

import (
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strings"

	"github.com/faketoken/faketoken/internal/model"
	"github.com/faketoken/faketoken/internal/store"
)

// Quick import turns whatever an operator pasted — a vendor email, a wiki
// snippet, a chat message — into a channel draft. It only ever guesses: every
// field is handed back for review, and nothing is written until the operator
// saves the form.

var (
	// Stops at whitespace, quotes, brackets and CJK punctuation, all of which
	// end a URL in prose far more often than they appear inside one.
	urlPattern = regexp.MustCompile(`https?://[^\s"'<>()\[\]{}，、；。！？]+`)

	// OpenAI-style keys, which most aggregators and Anthropic also copy.
	prefixedKeyPattern = regexp.MustCompile(`sk-[A-Za-z0-9_\-]{16,}`)
	// Google AI Studio keys.
	googleKeyPattern = regexp.MustCompile(`AIza[A-Za-z0-9_\-]{20,}`)
	// An explicit label wins over any shape-based guess, which is how keys that
	// follow no convention at all still get picked up.
	labelledKeyPattern = regexp.MustCompile(
		`(?i)(?:api[\s_\-]?key|apikey|secret|token|密钥|令牌)\s*[:：=]\s*["']?([^\s"'，、；]+)`)
)

// importGuess is the draft extracted from free text.
type importGuess struct {
	BaseURL string
	APIKey  string
	Type    string
	Name    string
}

// parseImportText extracts a base URL and credential from arbitrary prose.
func parseImportText(text string) importGuess {
	guess := importGuess{
		BaseURL: pickBaseURL(text),
		APIKey:  pickAPIKey(text),
	}
	guess.Type = guessChannelType(guess.BaseURL, guess.APIKey)
	guess.Name = suggestChannelName(guess.BaseURL)
	return guess
}

// pickAPIKey prefers an explicitly labelled value, then a recognisable key
// shape. Among equal candidates the longest wins: a truncated copy/paste is
// more common than an over-long key.
func pickAPIKey(text string) string {
	for _, match := range labelledKeyPattern.FindAllStringSubmatch(text, -1) {
		candidate := strings.Trim(match[1], `"'`)
		// "api key: https://..." labels the endpoint, not the credential.
		if candidate != "" && !strings.HasPrefix(strings.ToLower(candidate), "http") {
			return candidate
		}
	}

	longest := ""
	for _, pattern := range []*regexp.Regexp{prefixedKeyPattern, googleKeyPattern} {
		for _, candidate := range pattern.FindAllString(text, -1) {
			if len(candidate) > len(longest) {
				longest = candidate
			}
		}
	}
	return longest
}

// pickBaseURL scores every URL in the text and normalises the winner.
func pickBaseURL(text string) string {
	best, bestScore := "", -1
	for _, raw := range urlPattern.FindAllString(text, -1) {
		candidate := normaliseBaseURL(raw)
		if candidate == "" {
			continue
		}
		if score := scoreBaseURL(candidate); score > bestScore {
			best, bestScore = candidate, score
		}
	}
	return best
}

func scoreBaseURL(candidate string) int {
	lower := strings.ToLower(candidate)
	score := 0
	if strings.Contains(lower, "/v1") || strings.Contains(lower, "/v1beta") {
		score += 2
	}
	if strings.Contains(lower, "api") {
		score++
	}
	if strings.HasPrefix(lower, "https://") {
		score++
	}
	return score
}

// endpointSuffixes are request paths, not base URLs. Someone pasting a full
// curl example should still end up with a usable channel.
var endpointSuffixes = []string{
	"/chat/completions", "/completions", "/messages", "/embeddings",
	"/responses", "/models", "/images/generations", "/audio/transcriptions",
}

// normaliseBaseURL strips prose punctuation and the endpoint path, while
// keeping any path prefix the upstream is actually hosted under: aggregators
// commonly live at https://host/openai/v1, and discarding that path (as taking
// the bare origin would) points the channel at nothing.
func normaliseBaseURL(raw string) string {
	raw = strings.TrimRight(raw, `.,;:!?)]}"'，。；、）】`)
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" {
		return ""
	}

	path := strings.TrimRight(parsed.Path, "/")
	// Gemini carries the model in the path: /v1beta/models/x:generateContent.
	if idx := strings.Index(path, "/models/"); idx >= 0 {
		path = path[:idx]
	}
	for changed := true; changed; {
		changed = false
		for _, suffix := range endpointSuffixes {
			if strings.HasSuffix(path, suffix) {
				path = strings.TrimSuffix(path, suffix)
				changed = true
			}
		}
	}

	return (&url.URL{Scheme: parsed.Scheme, Host: parsed.Host, Path: path}).String()
}

// guessChannelType reads the dialect off the credential first, since a key
// shape is unambiguous, then off the host.
func guessChannelType(baseURL, apiKey string) string {
	switch {
	case strings.HasPrefix(strings.ToLower(apiKey), "sk-ant-"):
		return model.ChannelAnthropic
	case strings.HasPrefix(apiKey, "AIza"):
		return model.ChannelGemini
	}

	parsed, err := url.Parse(baseURL)
	if err != nil {
		return model.ChannelOpenAI
	}
	host := strings.ToLower(parsed.Host)
	switch {
	case strings.Contains(host, "anthropic"):
		return model.ChannelAnthropic
	case strings.Contains(host, "generativelanguage"), strings.Contains(host, "googleapis"):
		return model.ChannelGemini
	case strings.Contains(strings.ToLower(parsed.Path), "/v1beta"):
		return model.ChannelGemini
	}
	return model.ChannelOpenAI
}

// suggestChannelName turns the host into something readable, dropping the
// prefixes that carry no information.
func suggestChannelName(baseURL string) string {
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Hostname() == "" {
		return ""
	}
	name := parsed.Hostname()
	for _, prefix := range []string{"api.", "www."} {
		name = strings.TrimPrefix(name, prefix)
	}
	return name
}

// ------------------------------------------------------------------ handler

type channelImportInput struct {
	Text    string `json:"text"`
	BaseURL string `json:"base_url"`
	APIKey  string `json:"api_key"`
	Type    string `json:"type"`
	// ChannelID lets the edit form probe an already saved channel without
	// re-typing its credential: the console shows an empty key field to mean
	// "keep the stored one", so there is nothing to send.
	ChannelID int64 `json:"channel_id"`
	// SkipModels lets the console re-parse without paying for an upstream probe.
	SkipModels bool `json:"skip_models"`
}

type existingChannelRef struct {
	ID     int64  `json:"id"`
	Name   string `json:"name"`
	Status int16  `json:"status"`
}

type channelImportPreview struct {
	BaseURL       string              `json:"base_url"`
	APIKey        string              `json:"api_key"`
	Type          string              `json:"type"`
	SuggestedName string              `json:"suggested_name"`
	Models        []string            `json:"models"`
	ModelError    string              `json:"model_error,omitempty"`
	Existing      *existingChannelRef `json:"existing_channel,omitempty"`
}

// handleImportChannel previews a channel built from pasted text. It never
// writes: the operator reviews the draft in the normal form and saves from
// there, so an import can be abandoned without leaving anything behind.
func (s *Server) handleImportChannel(w http.ResponseWriter, r *http.Request) {
	var in channelImportInput
	if !decode(w, r, &in) {
		return
	}

	guess := parseImportText(in.Text)
	// Explicit fields win: the console shows them as editable inputs so the
	// operator can correct a bad guess without rewriting the pasted text.
	if v := strings.TrimSpace(in.BaseURL); v != "" {
		guess.BaseURL = normaliseBaseURL(v)
		guess.Type = guessChannelType(guess.BaseURL, guess.APIKey)
		guess.Name = suggestChannelName(guess.BaseURL)
	}
	if v := strings.TrimSpace(in.APIKey); v != "" {
		guess.APIKey = v
		if strings.TrimSpace(in.Type) == "" {
			guess.Type = guessChannelType(guess.BaseURL, guess.APIKey)
		}
	}
	if v := strings.TrimSpace(in.Type); v != "" {
		if !validChannelType(v) {
			fail(w, http.StatusBadRequest, "unsupported channel type: "+v)
			return
		}
		guess.Type = v
	}

	if guess.BaseURL == "" {
		fail(w, http.StatusBadRequest,
			"could not find an upstream address in the pasted text; enter it manually")
		return
	}

	// Fall back to the saved credential when the caller has one but did not
	// send it. probeKey stays local: echoing a stored secret back to the
	// browser would undo the masking every other channel response applies.
	probeKey := guess.APIKey
	if probeKey == "" && in.ChannelID > 0 {
		saved, err := s.store.GetChannel(r.Context(), in.ChannelID)
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			failErr(w, err)
			return
		}
		if err == nil {
			probeKey = saved.APIKey
		}
	}

	preview := channelImportPreview{
		BaseURL:       guess.BaseURL,
		APIKey:        guess.APIKey,
		Type:          guess.Type,
		SuggestedName: guess.Name,
		Models:        []string{},
	}

	if guess.Name != "" {
		existing, err := s.store.GetChannelByName(r.Context(), guess.Name)
		switch {
		case err == nil:
			preview.Existing = &existingChannelRef{
				ID: existing.ID, Name: existing.Name, Status: existing.Status,
			}
		case !errors.Is(err, store.ErrNotFound):
			failErr(w, err)
			return
		}
	}

	// A failed probe is reported, not fatal: the address and credential are
	// still worth keeping, and the model list can be filled in by hand.
	if !in.SkipModels {
		models, err := s.relay.FetchModels(r.Context(), &model.Channel{
			Type: guess.Type, BaseURL: guess.BaseURL, APIKey: probeKey,
		})
		if err != nil {
			preview.ModelError = err.Error()
		} else {
			preview.Models = models
		}
	}
	ok(w, preview)
}
