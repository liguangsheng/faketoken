// Package chunk splits a byte stream into content-defined chunks, so that two
// bodies sharing most of their bytes share most of their chunks.
//
// A coding agent resends the whole conversation on every turn, so consecutive
// request bodies differ only at the tail. Cutting at fixed offsets would shift
// every boundary after the first changed byte; cutting where the content says
// keeps the boundaries in place, and an edit costs only the chunks it touches.
// Measured on stored bodies: 2.5 GB of them reduced to 54 MB.
package chunk

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"errors"
	"io"
)

// Sizes, in bytes. A cut is never made inside the first minSize bytes of a
// chunk, and is always made at maxSize; in between it lands, on average,
// every avgSize bytes of input.
const (
	minSize = 2 << 10
	avgSize = 8 << 10
	maxSize = 64 << 10
)

// cutShift turns the 64-bit gear hash into a 1-in-avgSize event: a cut is made
// when the top 13 bits are all zero.
const cutShift = 64 - 13

// gear holds one pseudo-random value per byte, from splitmix64 with a fixed
// seed. Fixed, and generated here rather than by a library, so the same body
// cuts the same way on every run and every Go release: otherwise nothing
// stored before an upgrade would dedup against anything stored after it. A
// changed table would cost dedup, never correctness — a body is rebuilt from
// its own list of hashes, however it was cut.
var gear = func() (t [256]uint64) {
	x := uint64(0x66616b65746f6b65) // "faketoke"
	for i := range t {
		x += 0x9e3779b97f4a7c15
		z := x
		z = (z ^ z>>30) * 0xbf58476d1ce4e5b9
		z = (z ^ z>>27) * 0x94d049bb133111eb
		t[i] = z ^ z>>31
	}
	return t
}()

// Hash names a chunk by its content.
type Hash = [sha256.Size]byte

// Split cuts b into chunks. The chunks alias b. Concatenated in order they are
// b again; an empty b yields no chunks.
func Split(b []byte) [][]byte {
	var out [][]byte
	for len(b) > 0 {
		n := cut(b)
		out = append(out, b[:n])
		b = b[n:]
	}
	return out
}

// cut returns the length of the next chunk. The gear hash of a position
// depends only on the 64 bytes before it, so a cut point moves with the
// content rather than with its offset.
func cut(b []byte) int {
	n := len(b)
	if n <= minSize {
		return n
	}
	n = min(n, maxSize)
	var h uint64
	for i := minSize; i < n; i++ {
		h = (h << 1) + gear[b[i]]
		if h>>cutShift == 0 {
			return i + 1
		}
	}
	return n
}

// Sum hashes a chunk.
func Sum(c []byte) Hash { return sha256.Sum256(c) }

// Pack compresses a chunk for storage.
func Pack(c []byte) ([]byte, error) {
	var buf bytes.Buffer
	w := gzip.NewWriter(&buf)
	if _, err := w.Write(c); err != nil {
		return nil, err
	}
	if err := w.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// ErrCorrupt reports a stored chunk that does not unpack to a chunk.
var ErrCorrupt = errors.New("chunk: corrupt")

// Unpack reverses Pack. Nothing Pack wrote exceeds maxSize, so anything that
// does is damage, not data.
func Unpack(packed []byte) ([]byte, error) {
	r, err := gzip.NewReader(bytes.NewReader(packed))
	if err != nil {
		return nil, errors.Join(ErrCorrupt, err)
	}
	defer r.Close()
	out, err := io.ReadAll(io.LimitReader(r, maxSize+1))
	if err != nil {
		return nil, errors.Join(ErrCorrupt, err)
	}
	if len(out) > maxSize {
		return nil, ErrCorrupt
	}
	return out, nil
}
