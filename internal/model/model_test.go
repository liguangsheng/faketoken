package model

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestEffortMappingForResolvesBySpecificity(t *testing.T) {
	ch := &Channel{ReasoningEffortMapping: EffortMapping{
		"*":         {"max": "xhigh"},
		"gpt-5*":    {"max": "high"},
		"gpt-5.1*":  {"max": "medium"},
		"gpt-5.1-c": {"max": "low"},
	}}

	for _, tc := range []struct {
		model string
		want  string
	}{
		{"claude-4", "xhigh"},   // only the wildcard matches
		{"gpt-5-mini", "high"},  // one prefix
		{"gpt-5.1-x", "medium"}, // two prefixes, the longer wins
		{"gpt-5.1-c", "low"},    // the exact name outranks every prefix
	} {
		if got := ch.EffortMappingFor(tc.model)["max"]; got != tc.want {
			t.Fatalf("%s resolved max to %q, want %q", tc.model, got, tc.want)
		}
	}
}

// Selectors merge rather than replace: the narrower one overrides the levels it
// names and inherits the rest, so "*" can carry the channel's vocabulary while
// one model differs on a single level.
func TestEffortMappingForMergesRatherThanReplaces(t *testing.T) {
	ch := &Channel{ReasoningEffortMapping: EffortMapping{
		"*":       {"max": "xhigh", "minimal": "low"},
		"gpt-5.1": {"max": "high"},
	}}

	got := ch.EffortMappingFor("gpt-5.1")
	want := map[string]string{"max": "high", "minimal": "low"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("merged mapping = %v, want %v", got, want)
	}

	// Merging must not write through to the stored tables; the next request
	// would otherwise resolve against a table this one edited.
	if got := ch.ReasoningEffortMapping["*"]["max"]; got != "xhigh" {
		t.Fatalf(`the "*" table was mutated: max = %q`, got)
	}
}

func TestEffortMappingForWithoutAMatch(t *testing.T) {
	ch := &Channel{ReasoningEffortMapping: EffortMapping{"gpt-5": {"max": "high"}}}
	if got := ch.EffortMappingFor("claude-4"); got != nil {
		t.Fatalf("an unrelated model resolved to %v, want nil", got)
	}
	empty := &Channel{}
	if got := empty.EffortMappingFor("gpt-5"); got != nil {
		t.Fatalf("a channel with no rules resolved to %v, want nil", got)
	}
}

// A single matching selector is the ordinary case and the relay resolves this
// per request, so it must hand back the stored table instead of copying it.
func TestEffortMappingForDoesNotCopyASingleMatch(t *testing.T) {
	rules := map[string]string{"max": "xhigh"}
	ch := &Channel{ReasoningEffortMapping: EffortMapping{"*": rules}}

	got := ch.EffortMappingFor("anything")
	if reflect.ValueOf(got).Pointer() != reflect.ValueOf(rules).Pointer() {
		t.Fatal("a single match was copied instead of returned as-is")
	}
}

// A "*" in the middle matches nothing; it must not be read as a prefix that
// happens to end there.
func TestEffortMappingForIgnoresAnInteriorStar(t *testing.T) {
	ch := &Channel{ReasoningEffortMapping: EffortMapping{"gpt*turbo": {"max": "high"}}}
	if got := ch.EffortMappingFor("gpt-5-turbo"); got != nil {
		t.Fatalf("an interior star matched: %v", got)
	}
}

func TestEffortMappingUnmarshalsBothShapes(t *testing.T) {
	var nested EffortMapping
	if err := json.Unmarshal([]byte(`{"gpt-5":{"max":"high"}}`), &nested); err != nil {
		t.Fatal(err)
	}
	if got := nested["gpt-5"]["max"]; got != "high" {
		t.Fatalf("nested shape decoded to %v", nested)
	}

	// The shape written before there was a selector means what it always meant:
	// every model the channel serves.
	var flat EffortMapping
	if err := json.Unmarshal([]byte(`{"max":"xhigh"}`), &flat); err != nil {
		t.Fatal(err)
	}
	if got := flat["*"]["max"]; got != "xhigh" {
		t.Fatalf(`the flat shape did not land under "*": %v`, flat)
	}

	var empty EffortMapping
	if err := json.Unmarshal([]byte(`{}`), &empty); err != nil {
		t.Fatal(err)
	}
	if len(empty) != 0 {
		t.Fatalf("an empty object decoded to %v", empty)
	}

	var broken EffortMapping
	if err := json.Unmarshal([]byte(`{"max":123}`), &broken); err == nil {
		t.Fatal("a value that is neither a table nor a level name was accepted")
	}
}

func TestNormaliseEffortMappingFoldsLevelsAndDropsBlanks(t *testing.T) {
	got := NormaliseEffortMapping(EffortMapping{
		"*":        {"MAX": "xhigh", "  ": "orphan", "medium": "   "},
		"gpt-5":    {},
		"   ":      {"max": "high"},
		"  gpt-6 ": {"Max": " High "},
	})
	want := EffortMapping{
		"*":     {"max": "xhigh"},
		"gpt-6": {"max": "High"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("normalised to %v, want %v", got, want)
	}
}

// Only errors are rewritten, and a rule onto the same code counts as no rule:
// MappedStatus answering 0 is what tells the relay to leave the row alone.
func TestMappedStatus(t *testing.T) {
	ch := &Channel{StatusCodeMapping: map[int]int{429: 503, 500: 500, 200: 503}}

	for _, tc := range []struct{ upstream, want int }{
		{429, 503}, // a rule
		{500, 0},   // onto itself
		{502, 0},   // no rule
		{200, 0},   // a success is never rewritten, whatever is stored
	} {
		if got := ch.MappedStatus(tc.upstream); got != tc.want {
			t.Errorf("MappedStatus(%d) = %d, want %d", tc.upstream, got, tc.want)
		}
	}

	if got := (&Channel{}).MappedStatus(429); got != 0 {
		t.Errorf("a channel without rules rewrote 429 to %d", got)
	}
}

// The console and the JSONB column both carry the codes as object keys, which
// JSON only allows as strings.
func TestStatusCodeMappingReadsStringKeys(t *testing.T) {
	var ch Channel
	if err := json.Unmarshal([]byte(`{"status_code_mapping":{"429":503}}`), &ch); err != nil {
		t.Fatal(err)
	}
	if ch.StatusCodeMapping[429] != 503 {
		t.Fatalf("decoded %v, want 429=503", ch.StatusCodeMapping)
	}
}
