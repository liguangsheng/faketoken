package api

import (
	"fmt"
	"net/url"
	"strings"

	"github.com/faketoken/faketoken/internal/model"
	"github.com/faketoken/faketoken/internal/redact"
)

// A channel's headers carry whatever its upstream needed, credentials
// included, and its proxy URL may carry a password. The console has no use for
// either in the clear, so both leave the API masked like the API key, and a
// save that sends the masked form back keeps what is stored.

// secretMark stands in for the hidden part of a header value. No real header
// value contains it, so one that still does on save is a placeholder.
const secretMark = "••••"

// proxyMark is what url.URL.Redacted puts in place of a password.
const proxyMark = "xxxxx"

// maskSecret keeps the ends of a long value so two credentials can still be
// told apart; a short one is hidden whole.
func maskSecret(value string) string {
	runes := []rune(value)
	if len(runes) <= 16 {
		return secretMark
	}
	return string(runes[:4]) + secretMark + string(runes[len(runes)-4:])
}

// maskHeaders returns a copy with every credential header masked.
func maskHeaders(headers map[string]string) map[string]string {
	if len(headers) == 0 {
		return headers
	}
	out := make(map[string]string, len(headers))
	for name, value := range headers {
		if redact.SensitiveHeader(name) {
			value = maskSecret(value)
		}
		out[name] = value
	}
	return out
}

// maskProxy hides the password in a proxy URL. One that does not parse is
// returned as is: the relay cannot use it either, so it holds nothing usable.
func maskProxy(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.User == nil {
		return raw
	}
	if _, has := u.User.Password(); !has {
		return raw
	}
	return u.Redacted()
}

// keepMaskedSecrets puts the stored credentials back wherever the console sent
// their masked form. stored is nil for a new channel. A placeholder with
// nothing behind it — a renamed header, or one copied from another channel —
// is refused rather than saved as the credential.
func keepMaskedSecrets(ch, stored *model.Channel) (string, bool) {
	for name, value := range ch.Headers {
		if !redact.SensitiveHeader(name) || !strings.Contains(value, secretMark) {
			continue
		}
		original, found := "", false
		if stored != nil {
			original, found = headerValue(stored.Headers, name)
		}
		if !found || maskSecret(original) != value {
			return fmt.Sprintf("请求头 %s 的值是脱敏后的占位，请重新填写", name), false
		}
		ch.Headers[name] = original
	}

	if ch.ProxyURL == "" {
		return "", true
	}
	if stored != nil && ch.ProxyURL == maskProxy(stored.ProxyURL) {
		ch.ProxyURL = stored.ProxyURL
		return "", true
	}
	if u, err := url.Parse(ch.ProxyURL); err == nil && u.User != nil {
		if password, _ := u.User.Password(); password == proxyMark {
			return "代理地址里的密码是脱敏后的占位，请重新填写", false
		}
	}
	return "", true
}

// headerValue looks a header up the way HTTP compares names: ignoring case.
func headerValue(headers map[string]string, name string) (string, bool) {
	for key, value := range headers {
		if strings.EqualFold(key, name) {
			return value, true
		}
	}
	return "", false
}
