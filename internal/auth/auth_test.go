package auth

import (
	"regexp"
	"strings"
	"testing"
)

// Generated keys promise a strictly alphanumeric body: they get pasted into
// curl commands, YAML and double-clicked selections, where '-' and '_' cause
// quoting and word-boundary surprises.
func TestGenerateAPIKeyCharset(t *testing.T) {
	pattern := regexp.MustCompile(`^sk-[0-9a-zA-Z]{32}$`)
	seen := map[rune]bool{}
	for range 2000 {
		key, hash, prefix, err := GenerateAPIKey()
		if err != nil {
			t.Fatalf("GenerateAPIKey: %v", err)
		}
		if !pattern.MatchString(key) {
			t.Fatalf("key %q does not match ^sk-[0-9a-zA-Z]{32}$", key)
		}
		if hash != HashAPIKey(key) {
			t.Fatalf("hash mismatch for %q", key)
		}
		if !strings.HasPrefix(key, prefix[:7]) {
			t.Fatalf("prefix %q does not describe key %q", prefix, key)
		}
		for _, r := range key[len(APIKeyPrefix):] {
			seen[r] = true
		}
	}
	// With 64k draws, missing any of the 62 characters means the sampling is
	// broken, not unlucky (P < 1e-400).
	if len(seen) != len(keyAlphabet) {
		t.Fatalf("only %d of %d alphabet characters ever appeared", len(seen), len(keyAlphabet))
	}
}
