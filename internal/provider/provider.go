// Package provider knows the protocol-specific parts of upstream requests:
// where credentials go, how model lists are shaped, and when a model name is
// carried in the URL.
package provider

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/faketoken/faketoken/internal/model"
)

// AuthStyles lists the stored overrides accepted by the channel API.
func AuthStyles() []string {
	return []string{
		model.AuthStyleAuto,
		model.AuthStyleBearer,
		model.AuthStyleXAPIKey,
		model.AuthStyleXGoogAPIKey,
	}
}

// AuthStyleForRequestPath derives the credential header from the protocol the
// client actually called. Messages is a prefix match so count_tokens receives
// the same Anthropic authentication as message creation.
func AuthStyleForRequestPath(path string) string {
	path = strings.TrimSpace(path)
	if path == "/v1/messages" || strings.HasPrefix(path, "/v1/messages/") {
		return model.AuthStyleXAPIKey
	}
	if ModelInPath(path) {
		return model.AuthStyleXGoogAPIKey
	}
	return model.AuthStyleBearer
}

// EffectiveAuthStyle resolves auto (and the legacy empty value) for one
// request. Explicit overrides deliberately win over endpoint inference.
func EffectiveAuthStyle(authStyle, path string) string {
	authStyle = strings.ToLower(strings.TrimSpace(authStyle))
	if authStyle == "" || authStyle == model.AuthStyleAuto {
		return AuthStyleForRequestPath(path)
	}
	return authStyle
}

// ApplyAuth replaces any caller credential with the channel credential.
func ApplyAuth(req *http.Request, apiKey, authStyle string) {
	req.Header.Del("Authorization")
	req.Header.Del("X-Api-Key")
	req.Header.Del("X-Goog-Api-Key")

	switch EffectiveAuthStyle(authStyle, req.URL.Path) {
	case model.AuthStyleXAPIKey:
		req.Header.Set("X-Api-Key", apiKey)
		if req.Header.Get("Anthropic-Version") == "" {
			req.Header.Set("Anthropic-Version", "2023-06-01")
		}
	case model.AuthStyleXGoogAPIKey:
		req.Header.Set("X-Goog-Api-Key", apiKey)
		// Gemini SDKs often put their key in the query string. It must not
		// survive alongside the selected channel credential.
		if q := req.URL.Query(); q.Has("key") {
			q.Del("key")
			req.URL.RawQuery = q.Encode()
		}
	default:
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}
}

// ModelInPath reports Gemini-style endpoints where the model is part of the
// URL. Recognising all model actions also covers countTokens and embeddings,
// not only generateContent.
func ModelInPath(path string) bool {
	return strings.Contains(path, "/models/") && strings.Contains(path, ":")
}

// ParseModels accepts the catalogue shapes used by OpenAI-compatible,
// Anthropic, Gemini, and lightweight third-party gateways: {data:[]},
// {models:[]}, or a bare array containing strings or objects.
func ParseModels(body []byte) ([]string, error) {
	var source []json.RawMessage
	var object map[string]json.RawMessage
	if err := json.Unmarshal(body, &object); err == nil && object != nil {
		found := false
		for _, key := range []string{"data", "models"} {
			raw, ok := object[key]
			if !ok {
				continue
			}
			found = true
			if err := json.Unmarshal(raw, &source); err != nil {
				return nil, fmt.Errorf("decode model list field %q: %w", key, err)
			}
			break
		}
		if !found {
			return nil, fmt.Errorf("model list response has neither data nor models")
		}
	} else if err := json.Unmarshal(body, &source); err != nil {
		return nil, fmt.Errorf("decode model list: %w", err)
	}

	out := make([]string, 0, len(source))
	seen := make(map[string]struct{}, len(source))
	for _, item := range source {
		var id string
		if err := json.Unmarshal(item, &id); err != nil {
			var entry struct {
				ID    string `json:"id"`
				Name  string `json:"name"`
				Model string `json:"model"`
			}
			if err := json.Unmarshal(item, &entry); err != nil {
				continue
			}
			for _, value := range []string{entry.ID, entry.Name, entry.Model} {
				if strings.TrimSpace(value) != "" {
					id = value
					break
				}
			}
		}
		id = strings.TrimPrefix(strings.TrimSpace(id), "models/")
		if id == "" {
			continue
		}
		if _, duplicate := seen[id]; duplicate {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
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
