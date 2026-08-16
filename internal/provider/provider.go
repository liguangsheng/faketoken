// Package provider knows the dialect-specific bits of each upstream: where the
// credentials go, where the model list lives, and how a model name is carried.
package provider

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/faketoken/faketoken/internal/model"
)

// Adaptor abstracts one upstream dialect. Everything else about a request is
// forwarded verbatim, so adaptors stay deliberately small.
type Adaptor interface {
	Name() string
	// ApplyAuth swaps the caller's credentials for the channel's own.
	ApplyAuth(req *http.Request, apiKey string)
	// ModelsRequest builds the upstream model-catalogue call.
	ModelsRequest(baseURL, apiKey string) (*http.Request, error)
	// ParseModels extracts model ids from the catalogue response.
	ParseModels(body []byte) ([]string, error)
	// ModelInPath reports whether the model name travels in the URL (Gemini).
	ModelInPath() bool
	// DefaultBaseURL is used when a channel leaves base_url empty.
	DefaultBaseURL() string
	// HealthCheck returns a minimal request that proves the credentials work.
	HealthCheckPath() string
}

func For(channelType string) Adaptor {
	switch strings.ToLower(strings.TrimSpace(channelType)) {
	case model.ChannelAnthropic:
		return anthropic{}
	case model.ChannelGemini:
		return gemini{}
	default:
		return openai{}
	}
}

// Types lists the dialects the admin UI may pick from.
func Types() []string {
	return []string{model.ChannelOpenAI, model.ChannelAnthropic, model.ChannelGemini}
}

// ---------------------------------------------------------------- OpenAI

type openai struct{}

func (openai) Name() string           { return model.ChannelOpenAI }
func (openai) ModelInPath() bool      { return false }
func (openai) DefaultBaseURL() string { return "https://api.openai.com" }
func (openai) HealthCheckPath() string {
	return "/v1/models"
}

func (openai) ApplyAuth(req *http.Request, apiKey string) {
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Del("X-Api-Key")
	req.Header.Del("X-Goog-Api-Key")
}

func (o openai) ModelsRequest(baseURL, apiKey string) (*http.Request, error) {
	req, err := http.NewRequest(http.MethodGet, JoinURL(baseURL, "/v1/models"), nil)
	if err != nil {
		return nil, err
	}
	o.ApplyAuth(req, apiKey)
	return req, nil
}

func (openai) ParseModels(body []byte) ([]string, error) {
	var payload struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, fmt.Errorf("decode model list: %w", err)
	}
	out := make([]string, 0, len(payload.Data))
	for _, m := range payload.Data {
		if m.ID != "" {
			out = append(out, m.ID)
		}
	}
	return out, nil
}

// -------------------------------------------------------------- Anthropic

type anthropic struct{}

func (anthropic) Name() string            { return model.ChannelAnthropic }
func (anthropic) ModelInPath() bool       { return false }
func (anthropic) DefaultBaseURL() string  { return "https://api.anthropic.com" }
func (anthropic) HealthCheckPath() string { return "/v1/models" }

func (anthropic) ApplyAuth(req *http.Request, apiKey string) {
	req.Header.Set("X-Api-Key", apiKey)
	req.Header.Del("Authorization")
	if req.Header.Get("Anthropic-Version") == "" {
		req.Header.Set("Anthropic-Version", "2023-06-01")
	}
}

func (a anthropic) ModelsRequest(baseURL, apiKey string) (*http.Request, error) {
	req, err := http.NewRequest(http.MethodGet, JoinURL(baseURL, "/v1/models")+"?limit=1000", nil)
	if err != nil {
		return nil, err
	}
	a.ApplyAuth(req, apiKey)
	return req, nil
}

func (anthropic) ParseModels(body []byte) ([]string, error) {
	var payload struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, fmt.Errorf("decode model list: %w", err)
	}
	out := make([]string, 0, len(payload.Data))
	for _, m := range payload.Data {
		if m.ID != "" {
			out = append(out, m.ID)
		}
	}
	return out, nil
}

// ----------------------------------------------------------------- Gemini

type gemini struct{}

func (gemini) Name() string            { return model.ChannelGemini }
func (gemini) ModelInPath() bool       { return true }
func (gemini) DefaultBaseURL() string  { return "https://generativelanguage.googleapis.com" }
func (gemini) HealthCheckPath() string { return "/v1beta/models" }

func (gemini) ApplyAuth(req *http.Request, apiKey string) {
	req.Header.Set("X-Goog-Api-Key", apiKey)
	req.Header.Del("Authorization")
	req.Header.Del("X-Api-Key")
	// Callers often put the key in the query string; drop it so the channel
	// credential is the only one that reaches Google.
	if q := req.URL.Query(); q.Has("key") {
		q.Del("key")
		req.URL.RawQuery = q.Encode()
	}
}

func (g gemini) ModelsRequest(baseURL, apiKey string) (*http.Request, error) {
	req, err := http.NewRequest(http.MethodGet, JoinURL(baseURL, "/v1beta/models")+"?pageSize=1000", nil)
	if err != nil {
		return nil, err
	}
	g.ApplyAuth(req, apiKey)
	return req, nil
}

func (gemini) ParseModels(body []byte) ([]string, error) {
	var payload struct {
		Models []struct {
			Name string `json:"name"`
		} `json:"models"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, fmt.Errorf("decode model list: %w", err)
	}
	out := make([]string, 0, len(payload.Models))
	for _, m := range payload.Models {
		if m.Name != "" {
			out = append(out, strings.TrimPrefix(m.Name, "models/"))
		}
	}
	return out, nil
}

// ------------------------------------------------------------------ helpers

// JoinURL concatenates a base URL with a request path while tolerating bases
// that already carry the version prefix (a very common copy/paste mistake:
// "https://host/v1" + "/v1/chat/completions" must not become "/v1/v1/...").
func JoinURL(base, path string) string {
	base = strings.TrimRight(strings.TrimSpace(base), "/")
	if base == "" {
		return path
	}
	u, err := url.Parse(base)
	if err != nil {
		return base + path
	}
	basePath := strings.TrimRight(u.Path, "/")

	for _, prefix := range []string{"/v1beta", "/v1alpha", "/v1", "/openai/v1", "/api/v3", "/compatible-mode/v1"} {
		if strings.HasSuffix(basePath, prefix) && strings.HasPrefix(path, prefix+"/") {
			basePath = strings.TrimSuffix(basePath, prefix)
			break
		}
	}
	u.Path = basePath + path
	return u.String()
}

// GeminiModelFromPath extracts "gemini-2.0-flash" from
// "/v1beta/models/gemini-2.0-flash:generateContent".
func GeminiModelFromPath(path string) string {
	idx := strings.Index(path, "/models/")
	if idx < 0 {
		return ""
	}
	rest := path[idx+len("/models/"):]
	if colon := strings.Index(rest, ":"); colon >= 0 {
		rest = rest[:colon]
	}
	if slash := strings.Index(rest, "/"); slash >= 0 {
		rest = rest[:slash]
	}
	return rest
}

// ReplaceGeminiModelInPath rewrites the model segment for model mapping.
func ReplaceGeminiModelInPath(path, from, to string) string {
	if from == to || from == "" {
		return path
	}
	return strings.Replace(path, "/models/"+from, "/models/"+to, 1)
}
