// Package auth provides password hashing, session tokens, API key handling
// and at-rest encryption for upstream channel credentials.
package auth

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
)

const (
	// APIKeyPrefix is prepended to every relay key we hand out.
	APIKeyPrefix = "sk-"
	keyBytes     = 24
)

var ErrInvalidToken = errors.New("invalid or expired session")

// ---------------------------------------------------------------- passwords

func HashPassword(plain string) (string, error) {
	h, err := bcrypt.GenerateFromPassword([]byte(plain), bcrypt.DefaultCost)
	return string(h), err
}

func CheckPassword(hash, plain string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(plain)) == nil
}

// ------------------------------------------------------------------ api keys

// GenerateAPIKey returns the raw key (shown to the user exactly once), its
// sha256 hash used for lookups, and a masked prefix kept for display.
func GenerateAPIKey() (raw, hash, prefix string, err error) {
	buf := make([]byte, keyBytes)
	if _, err = rand.Read(buf); err != nil {
		return "", "", "", err
	}
	raw = APIKeyPrefix + base64.RawURLEncoding.EncodeToString(buf)
	hash = HashAPIKey(raw)
	prefix = MaskAPIKey(raw)
	return raw, hash, prefix, nil
}

// HashAPIKey is a plain sha256: keys are high-entropy random values, so a slow
// KDF would only add latency to every relayed request without adding security.
func HashAPIKey(raw string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(raw)))
	return hex.EncodeToString(sum[:])
}

// MaskAPIKey renders a key for display. The result is stored as key_prefix and
// shown in listings, so it must never be enough to authenticate with — which
// matters now that keys can be chosen by hand and may be short.
func MaskAPIKey(raw string) string {
	if len(raw) > 12 {
		return raw[:7] + "..." + raw[len(raw)-4:]
	}

	// Keep just enough to tell two keys apart. Runes, not bytes, so a
	// multi-byte character is never sliced in half.
	runes := []rune(raw)
	keep := min(len(runes)/3, 3)
	return string(runes[:keep]) + strings.Repeat("*", max(len(runes)-keep, 3))
}

// ErrWeakKey marks a custom key the caller has not acknowledged as short.
var ErrWeakKey = errors.New("the key is shorter than the recommended minimum")

// MinRecommendedKeyLength is the point below which a key stops being something
// an attacker has to steal and becomes something they can guess.
const MinRecommendedKeyLength = 16

// maxKeyLength bounds what is accepted; anything longer is a mistake or an
// attempt to bloat the tokens table.
const maxKeyLength = 200

// NormalizeCustomKey validates a hand-written key and returns it with its hash
// and display mask.
//
// confirmed is the caller's explicit acknowledgement that a short key is
// intended. It is checked here rather than in the console because a browser
// dialog stops nobody from calling the API directly.
func NormalizeCustomKey(raw string, confirmed bool) (key, hash, prefix string, err error) {
	key = strings.TrimSpace(raw)
	switch {
	case key == "":
		return "", "", "", fmt.Errorf("%w: the key is empty", ErrInvalidKey)
	case len(key) > maxKeyLength:
		return "", "", "", fmt.Errorf("%w: the key may not exceed %d characters",
			ErrInvalidKey, maxKeyLength)
	case strings.ContainsFunc(key, unicode.IsSpace):
		// A key travels in an HTTP header; whitespace would either be mangled
		// or split the header outright.
		return "", "", "", fmt.Errorf("%w: the key may not contain whitespace", ErrInvalidKey)
	case strings.ContainsFunc(key, func(r rune) bool { return r < 0x20 || r == 0x7f }):
		return "", "", "", fmt.Errorf("%w: the key may not contain control characters", ErrInvalidKey)
	}

	if len([]rune(key)) < MinRecommendedKeyLength && !confirmed {
		return "", "", "", ErrWeakKey
	}
	return key, HashAPIKey(key), MaskAPIKey(key), nil
}

// ErrInvalidKey marks a custom key that is malformed regardless of length.
var ErrInvalidKey = errors.New("invalid key")

// ------------------------------------------------- codes handed to people

// handoutAlphabet drops the characters that get misread when a code is copied
// off a screen or read aloud: 0/O, 1/I/l.
const handoutAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

// generateHandoutCode returns a random code in 4 groups of 5, e.g.
// "A3F7K-2M9PQ-XR4TW-8HJ6N". That is ~100 bits of entropy, so guessing one is
// not a viable way to obtain whatever it buys.
func generateHandoutCode() (string, error) {
	const groups, size = 4, 5

	out := make([]byte, 0, groups*size+groups-1)
	for g := 0; g < groups; g++ {
		if g > 0 {
			out = append(out, '-')
		}
		for i := 0; i < size; i++ {
			index, err := rand.Int(rand.Reader, big.NewInt(int64(len(handoutAlphabet))))
			if err != nil {
				return "", err
			}
			out = append(out, handoutAlphabet[index.Int64()])
		}
	}
	return string(out), nil
}

// GenerateRedemptionCode mints a code that carries prepaid credit.
func GenerateRedemptionCode() (string, error) { return generateHandoutCode() }

// GenerateInviteCode mints a code that buys one account. Same shape and
// entropy as a redemption code: both are read off a screen and typed back in.
func GenerateInviteCode() (string, error) { return generateHandoutCode() }

// NormalizeRedemptionCode makes lookups forgiving about how a code was typed:
// case and surrounding whitespace carry no meaning.
func NormalizeRedemptionCode(raw string) string {
	return strings.ToUpper(strings.TrimSpace(raw))
}

// NormalizeInviteCode applies the same forgiveness to invitations.
func NormalizeInviteCode(raw string) string {
	return strings.ToUpper(strings.TrimSpace(raw))
}

// ------------------------------------------------------------------ sessions

type Claims struct {
	UserID int64  `json:"uid"`
	Role   int16  `json:"role"`
	Name   string `json:"name"`
	jwt.RegisteredClaims
}

type JWTManager struct {
	secret []byte
	ttl    time.Duration
}

func NewJWTManager(secret []byte, ttl time.Duration) *JWTManager {
	return &JWTManager{secret: secret, ttl: ttl}
}

func (m *JWTManager) Issue(userID int64, role int16, name string) (string, time.Time, error) {
	expires := time.Now().Add(m.ttl)
	claims := &Claims{
		UserID: userID,
		Role:   role,
		Name:   name,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   strconv.FormatInt(userID, 10),
			ExpiresAt: jwt.NewNumericDate(expires),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	}
	signed, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(m.secret)
	return signed, expires, err
}

func (m *JWTManager) Parse(tokenString string) (*Claims, error) {
	claims := &Claims{}
	_, err := jwt.ParseWithClaims(tokenString, claims, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method %v", t.Header["alg"])
		}
		return m.secret, nil
	}, jwt.WithValidMethods([]string{"HS256"}))
	if err != nil {
		return nil, ErrInvalidToken
	}
	return claims, nil
}

// ---------------------------------------------------------------- encryption

// Cipher encrypts upstream channel credentials at rest with AES-256-GCM.
type Cipher struct {
	aead cipher.AEAD
}

func NewCipher(key [32]byte) (*Cipher, error) {
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Cipher{aead: aead}, nil
}

func (c *Cipher) Encrypt(plain string) (string, error) {
	if plain == "" {
		return "", nil
	}
	nonce := make([]byte, c.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	sealed := c.aead.Seal(nonce, nonce, []byte(plain), nil)
	return base64.StdEncoding.EncodeToString(sealed), nil
}

func (c *Cipher) Decrypt(encoded string) (string, error) {
	if encoded == "" {
		return "", nil
	}
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", err
	}
	if len(raw) < c.aead.NonceSize() {
		return "", errors.New("ciphertext too short")
	}
	nonce, body := raw[:c.aead.NonceSize()], raw[c.aead.NonceSize():]
	plain, err := c.aead.Open(nil, nonce, body, nil)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}
