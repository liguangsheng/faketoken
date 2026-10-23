package store

import (
	"context"
	"fmt"
	"maps"
	"strings"

	"github.com/faketoken/faketoken/internal/redact"
)

// A channel's credential headers and its proxy URL are encrypted at rest like
// its API key, so neither a database read nor a dump yields them. Ordinary
// headers stay readable, which keeps a stored channel debuggable from SQL;
// "credential" is decided by the same rule that masks them in the console and
// redacts them from the logs.

// sealedPrefix marks a value this store encrypted. Base64 never contains a
// colon, so the prefix cannot be mistaken for part of a ciphertext.
const sealedPrefix = "enc:v1:"

func (s *Store) seal(plain string) (string, error) {
	if plain == "" || strings.HasPrefix(plain, sealedPrefix) {
		return plain, nil
	}
	enc, err := s.cipher.Encrypt(plain)
	if err != nil {
		return "", err
	}
	return sealedPrefix + enc, nil
}

// open reverses seal and passes anything unsealed through. A value that no
// longer decrypts — ENCRYPTION_KEY changed — reads as empty, as an API key
// does, so the channel still lists and the operator can re-enter it.
func (s *Store) open(stored string) string {
	sealed, ok := strings.CutPrefix(stored, sealedPrefix)
	if !ok {
		return stored
	}
	plain, err := s.cipher.Decrypt(sealed)
	if err != nil {
		return ""
	}
	return plain
}

// sealHeaders returns a copy with every credential header encrypted.
func (s *Store) sealHeaders(headers map[string]string) (map[string]string, error) {
	out := make(map[string]string, len(headers))
	for name, value := range headers {
		if redact.SensitiveHeader(name) {
			sealed, err := s.seal(value)
			if err != nil {
				return nil, err
			}
			value = sealed
		}
		out[name] = value
	}
	return out, nil
}

// openHeaders decrypts in place: the map was just scanned and is not shared.
func (s *Store) openHeaders(headers map[string]string) {
	for name, value := range headers {
		headers[name] = s.open(value)
	}
}

// sealedSecrets encrypts what a channel row stores of its headers and proxy.
func (s *Store) sealedSecrets(headers map[string]string, proxy string) (map[string]string, string, error) {
	sealedHeaders, err := s.sealHeaders(headers)
	if err != nil {
		return nil, "", err
	}
	sealedProxy, err := s.seal(proxy)
	if err != nil {
		return nil, "", err
	}
	return sealedHeaders, sealedProxy, nil
}

// SealChannelSecrets encrypts credentials stored before the store did so
// itself. Run at boot; rows already sealed are left alone, so running it
// again changes nothing. Returns how many channels it rewrote.
func (s *Store) SealChannelSecrets(ctx context.Context) (int, error) {
	rows, err := s.pool.Query(ctx, `SELECT id, headers, proxy_url FROM channels`)
	if err != nil {
		return 0, err
	}
	type row struct {
		id            int64
		headers       map[string]string
		proxy         string
		sealedHeaders map[string]string
		sealedProxy   string
	}
	var todo []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.id, &r.headers, &r.proxy); err != nil {
			rows.Close()
			return 0, err
		}
		if r.sealedHeaders, r.sealedProxy, err = s.sealedSecrets(r.headers, r.proxy); err != nil {
			rows.Close()
			return 0, err
		}
		if r.sealedProxy != r.proxy || !maps.Equal(r.sealedHeaders, r.headers) {
			todo = append(todo, r)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}

	// Only if the row still holds what was read, so a save that landed in
	// between is never overwritten. updated_at is left alone: the operator
	// changed nothing.
	for _, r := range todo {
		if _, err := s.pool.Exec(ctx, `UPDATE channels SET headers = $2, proxy_url = $3
			WHERE id = $1 AND headers = $4 AND proxy_url = $5`,
			r.id, r.sealedHeaders, r.sealedProxy, r.headers, r.proxy); err != nil {
			return 0, fmt.Errorf("seal channel %d: %w", r.id, err)
		}
	}
	return len(todo), nil
}
