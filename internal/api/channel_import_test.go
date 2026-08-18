package api

import "testing"

func TestParseImportText(t *testing.T) {
	tests := []struct {
		name        string
		text        string
		wantBaseURL string
		wantKey     string
		wantName    string
	}{
		{
			name:        "vendor email",
			text:        "接口地址：https://api.example.com/v1\nAPI Key: sk-abcdefghijklmnop1234\n祝使用愉快",
			wantBaseURL: "https://api.example.com/v1",
			wantKey:     "sk-abcdefghijklmnop1234",
			wantName:    "example.com",
		},
		{
			name: "curl example keeps the hosting path but drops the endpoint",
			text: `curl https://gateway.test/openai/v1/chat/completions \
				-H "Authorization: Bearer sk-0123456789abcdefghij"`,
			wantBaseURL: "https://gateway.test/openai/v1",
			wantKey:     "sk-0123456789abcdefghij",
			wantName:    "gateway.test",
		},
		{
			name:        "anthropic detected from the key prefix",
			text:        "https://relay.example.org sk-ant-api03-abcdefghijklmnopqrst",
			wantBaseURL: "https://relay.example.org",
			wantKey:     "sk-ant-api03-abcdefghijklmnopqrst",
			wantName:    "relay.example.org",
		},
		{
			name:        "gemini detected from the key prefix and path trimmed",
			text:        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent key=AIzaSyA1234567890abcdefghij",
			wantBaseURL: "https://generativelanguage.googleapis.com/v1beta",
			wantKey:     "AIzaSyA1234567890abcdefghij",
			wantName:    "generativelanguage.googleapis.com",
		},
		{
			name:        "an unconventional key still wins when it is labelled",
			text:        "地址 https://api.vendor.cn/v1 密钥：ak_live_7f3d9c2b1e",
			wantBaseURL: "https://api.vendor.cn/v1",
			wantKey:     "ak_live_7f3d9c2b1e",
			wantName:    "vendor.cn",
		},
		{
			name:        "chinese punctuation does not leak into the url",
			text:        "请使用 https://api.example.com/v1，密钥是 sk-punctuation1234567890。",
			wantBaseURL: "https://api.example.com/v1",
			wantKey:     "sk-punctuation1234567890",
			wantName:    "example.com",
		},
		{
			name:        "the api endpoint outranks a docs link",
			text:        "文档见 http://docs.example.com/guide ，接口 https://api.example.com/v1",
			wantBaseURL: "https://api.example.com/v1",
			wantKey:     "",
			wantName:    "example.com",
		},
		{
			name:        "a truncated key never beats the full one",
			text:        "old sk-shortkey123456789 new sk-thefullkey0123456789abcdef https://api.example.com",
			wantBaseURL: "https://api.example.com",
			wantKey:     "sk-thefullkey0123456789abcdef",
			wantName:    "example.com",
		},
		{
			name:        "a labelled url is not mistaken for a credential",
			text:        "api key: https://api.example.com/v1",
			wantBaseURL: "https://api.example.com/v1",
			wantKey:     "",
			wantName:    "example.com",
		},
		{
			name:        "nothing usable",
			text:        "请联系管理员开通",
			wantBaseURL: "",
			wantKey:     "",
			wantName:    "",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := parseImportText(tc.text)
			if got.BaseURL != tc.wantBaseURL {
				t.Errorf("base url = %q, want %q", got.BaseURL, tc.wantBaseURL)
			}
			if got.APIKey != tc.wantKey {
				t.Errorf("api key = %q, want %q", got.APIKey, tc.wantKey)
			}
			if got.Name != tc.wantName {
				t.Errorf("name = %q, want %q", got.Name, tc.wantName)
			}
		})
	}
}

func TestNormaliseBaseURLKeepsHostingPath(t *testing.T) {
	tests := map[string]string{
		// The bare origin would point at nothing for a gateway hosted on a path.
		"https://host.test/openai/v1/chat/completions": "https://host.test/openai/v1",
		"https://host.test/v1/messages":                "https://host.test/v1",
		"https://host.test/v1/models":                  "https://host.test/v1",
		"https://host.test/":                           "https://host.test",
		"https://host.test/v1/":                        "https://host.test/v1",
		"http://127.0.0.1:3000/v1":                     "http://127.0.0.1:3000/v1",
		"not a url":                                    "",
	}
	for input, want := range tests {
		if got := normaliseBaseURL(input); got != want {
			t.Errorf("normaliseBaseURL(%q) = %q, want %q", input, got, want)
		}
	}
}
