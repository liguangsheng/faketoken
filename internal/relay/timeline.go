package relay

import (
	"math"
	"time"
)

// timelinePairs bounds what one response's timeline keeps: about 8 KB.
const timelinePairs = 1024

// timeline records when a response's bytes arrived, for the detail view: pairs
// of [milliseconds since the call began, bytes relayed by then]. Measured from
// the call's start, so the wait for headers — and for any attempt that failed
// before this one — shows as the gap before the first byte.
//
// When it fills, the spacing between samples doubles and the kept ones are
// thinned to match: a ten-minute stream costs what a ten-second one does. A
// sample that ends a run before a stall is never thinned away, so a stall
// keeps its true start at any resolution.
type timeline struct {
	start   time.Time
	spacing int32 // ms
	samples []int32
}

func newTimeline(start time.Time) *timeline {
	return &timeline{start: start, spacing: 20, samples: make([]int32, 0, 64)}
}

// add records that bytes had been relayed by at. A read within spacing of the
// sample before last moves the last one forward instead of adding another.
func (t *timeline) add(at time.Time, bytes int64) {
	if t == nil {
		return
	}
	ms := int32(min(at.Sub(t.start).Milliseconds(), math.MaxInt32))
	b := int32(min(bytes, math.MaxInt32))
	if n := len(t.samples); n >= 4 && ms-t.samples[n-4] < t.spacing {
		t.samples[n-2], t.samples[n-1] = ms, b
		return
	}
	t.samples = append(t.samples, ms, b)
	for len(t.samples) > 2*timelinePairs {
		t.spacing *= 2
		t.thin()
	}
}

// thin drops samples closer than spacing to the one kept before them, except
// the first, the last, and any that a stall follows.
func (t *timeline) thin() {
	s := t.samples
	kept := s[:2]
	for i := 2; i < len(s); i += 2 {
		last := i == len(s)-2
		beforeStall := !last && s[i+2]-s[i] >= t.spacing
		if last || beforeStall || s[i]-kept[len(kept)-2] >= t.spacing {
			kept = append(kept, s[i], s[i+1])
		}
	}
	t.samples = kept
}

// pairs returns the samples, or nil for a timeline that never ran.
func (t *timeline) pairs() []int32 {
	if t == nil || len(t.samples) == 0 {
		return nil
	}
	return t.samples
}
