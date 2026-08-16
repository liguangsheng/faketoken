package relay

import (
	"strings"
	"testing"
)

// A blank line is a substring of every request. Keeping one would turn the
// feature into a total outage, so this is the case that matters most.
func TestParseKeywordsDropsBlanksAndDuplicates(t *testing.T) {
	got := ParseKeywords("  \n\nSecret\n\t\n secret \nOther\n   \n")

	want := []string{"secret", "other"}
	if len(got) != len(want) {
		t.Fatalf("parsed %#v, want %#v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("parsed %#v, want %#v", got, want)
		}
	}
}

func TestParseKeywordsIsBounded(t *testing.T) {
	lines := make([]string, 0, maxBlockedKeywords+50)
	for i := range maxBlockedKeywords + 50 {
		lines = append(lines, "word"+string(rune('a'+i%26))+strings.Repeat("x", i%5))
	}
	if got := ParseKeywords(strings.Join(lines, "\n")); len(got) > maxBlockedKeywords {
		t.Fatalf("kept %d keywords, want at most %d", len(got), maxBlockedKeywords)
	}

	long := strings.Repeat("z", maxKeywordLength+1)
	if got := ParseKeywords(long); len(got) != 0 {
		t.Fatalf("an oversized keyword was kept: %#v", got)
	}
}

func TestMatchBlockedIsCaseInsensitive(t *testing.T) {
	rl := &Relay{}
	rl.SetBlockPolicy(ParseKeywords("Forbidden\ntoken"), DefaultBlockedStatus, "")

	for _, body := range []string{
		`{"messages":[{"content":"this is FORBIDDEN"}]}`,
		`{"messages":[{"content":"ForBidden"}]}`,
	} {
		if word := rl.matchBlocked([]byte(body)); word != "forbidden" {
			t.Fatalf("matched %q for %s", word, body)
		}
	}

	if word := rl.matchBlocked([]byte(`{"messages":[{"content":"nothing here"}]}`)); word != "" {
		t.Fatalf("clean body matched %q", word)
	}
}

// With no list configured the check has to be inert, including for bodies that
// would otherwise be expensive to scan.
func TestMatchBlockedIgnoresAnEmptyList(t *testing.T) {
	rl := &Relay{}
	if word := rl.matchBlocked([]byte("anything at all")); word != "" {
		t.Fatalf("an unconfigured relay blocked on %q", word)
	}

	rl.SetBlockPolicy(ParseKeywords("   \n\n\t\n"), DefaultBlockedStatus, "")
	if word := rl.matchBlocked([]byte("anything at all")); word != "" {
		t.Fatalf("a list of blank lines blocked on %q", word)
	}
}
