package chunk

import (
	"bytes"
	"math/rand/v2"
	"testing"
)

// body is a stand-in for a request body: random bytes, which cut the way real
// text does, seeded so a failure reproduces.
func body(n int, seed uint64) []byte {
	r := rand.New(rand.NewPCG(seed, seed))
	b := make([]byte, n)
	for i := range b {
		b[i] = byte(r.Uint32())
	}
	return b
}

func TestSplitRebuildsTheInput(t *testing.T) {
	for _, n := range []int{0, 1, minSize - 1, minSize, minSize + 1, maxSize, maxSize + 1, 1 << 20} {
		in := body(n, uint64(n))
		parts := Split(in)

		if got := bytes.Join(parts, nil); !bytes.Equal(got, in) {
			t.Fatalf("%d bytes: rebuilt input differs", n)
		}
		if n == 0 && len(parts) != 0 {
			t.Fatalf("empty input gave %d chunks", len(parts))
		}
		for i, p := range parts {
			last := i == len(parts)-1
			if len(p) > maxSize || len(p) == 0 || (!last && len(p) < minSize) {
				t.Fatalf("%d bytes: chunk %d is %d bytes", n, i, len(p))
			}
		}
	}
}

// Boundaries come from content, so they must not depend on the run.
func TestSplitIsDeterministic(t *testing.T) {
	in := body(1<<20, 7)
	a, b := Split(in), Split(bytes.Clone(in))
	if len(a) != len(b) {
		t.Fatalf("%d chunks, then %d", len(a), len(b))
	}
	for i := range a {
		if !bytes.Equal(a[i], b[i]) {
			t.Fatalf("chunk %d differs between runs", i)
		}
	}
}

// The property the package exists for: a conversation that grows by one turn,
// or has one byte changed in the middle, shares nearly every chunk with the
// one before it.
func TestSplitSurvivesLocalEdits(t *testing.T) {
	base := body(1<<20, 11)

	inserted := append(append(bytes.Clone(base[:len(base)/2]), "one new turn"...), base[len(base)/2:]...)
	appended := append(bytes.Clone(base), body(4<<10, 12)...)
	edited := bytes.Clone(base)
	edited[len(edited)/3] ^= 0xff

	known := map[Hash]bool{}
	for _, c := range Split(base) {
		known[Sum(c)] = true
	}

	for name, in := range map[string][]byte{"insert": inserted, "append": appended, "edit": edited} {
		fresh := 0
		for _, c := range Split(in) {
			if !known[Sum(c)] {
				fresh++
			}
		}
		// The changed chunk, plus at most one more where the cut moved.
		if fresh > 3 {
			t.Errorf("%s: %d new chunks, want at most 3", name, fresh)
		}
	}
}

// The average is what the stored size was measured at; drifting far from it
// would quietly change the dedup ratio.
func TestSplitAveragesNearTarget(t *testing.T) {
	in := body(8<<20, 3)
	avg := len(in) / len(Split(in))
	if avg < avgSize || avg > 2*avgSize {
		t.Fatalf("average chunk %d bytes, want about %d to %d", avg, avgSize, 2*avgSize)
	}
}

func TestPackRoundTrip(t *testing.T) {
	for _, n := range []int{0, 1, maxSize} {
		in := body(n, 5)
		packed, err := Pack(in)
		if err != nil {
			t.Fatal(err)
		}
		out, err := Unpack(packed)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(out, in) {
			t.Fatalf("%d bytes: round trip differs", n)
		}
	}
}

func TestUnpackRefusesDamage(t *testing.T) {
	if _, err := Unpack([]byte("not gzip")); err == nil {
		t.Fatal("garbage unpacked without an error")
	}

	// A valid stream that inflates past any chunk Pack could have written.
	oversized, err := Pack(make([]byte, maxSize+1))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Unpack(oversized); err == nil {
		t.Fatal("an oversized chunk unpacked without an error")
	}
}
