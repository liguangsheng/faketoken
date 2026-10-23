// Package config loads runtime configuration from environment variables.
package config

import (
	"crypto/sha256"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	// Server
	Listen  string
	BaseURL string

	// Database
	DatabaseURL string

	// Security
	JWTSecret     []byte
	EncryptionKey [32]byte
	SessionTTL    time.Duration

	// Bootstrap admin
	InitAdminUser string
	InitAdminPass string

	// Relay behaviour
	RelayTimeout      time.Duration
	StreamIdleTimeout time.Duration
	MaxRetries        int
	RetryBackoff      time.Duration

	// Registration
	AllowRegister bool
	InitQuota     int64 // micro-USD granted to new users

	// Billing. These are boot defaults; administrators can override them at
	// runtime from the console (they are stored in the options table).
	UnpricedPolicy     string  // reject | fallback | free
	FallbackInput      float64 // USD per 1M input tokens
	FallbackOutput     float64 // USD per 1M output tokens
	FallbackCached     float64 // USD per 1M cached input tokens
	FallbackPerRequest float64 // USD per request, flat

	// ModelsDevURL is the price catalogue the console pulls from. Empty
	// disables the import, which is what a deployment with no egress wants.
	ModelsDevURL string

	// Frontend
	WebDir string

	// ARAClaim is the line served at /.well-known/ara-claim.txt to prove
	// domain ownership to the ARA registry. Empty means the route reports
	// 404 rather than serving a blank file that would read as a valid but
	// wrong claim.
	ARAClaim string
}

// defaultARAClaim is the claim issued for the current deployment. It stays in
// the binary so a deployment that never sets ARA_CLAIM keeps verifying, and
// config_test.go pins the value so it cannot drift unnoticed.
const defaultARAClaim = "ara-site-verification=khmVMA2Dg0VlH-w9x5cgltAJFkkZpGkQ"

// defaultModelsDevURL is the public price catalogue. The endpoint belongs to
// the application layer, not to the driver that reads it, so a mirror is a
// matter of pointing this variable elsewhere.
const defaultModelsDevURL = "https://models.dev/api.json"

func Load() (*Config, error) {
	c := &Config{
		Listen:            env("LISTEN", ":3200"),
		BaseURL:           env("BASE_URL", ""),
		DatabaseURL:       env("DATABASE_URL", "postgres://faketoken:faketoken@localhost:5432/faketoken?sslmode=disable"),
		SessionTTL:        envDuration("SESSION_TTL", 7*24*time.Hour),
		InitAdminUser:     env("INIT_ADMIN_USER", "admin"),
		InitAdminPass:     env("INIT_ADMIN_PASS", ""),
		RelayTimeout:      envDuration("RELAY_TIMEOUT", 10*time.Minute),
		StreamIdleTimeout: envDuration("STREAM_IDLE_TIMEOUT", 120*time.Second),
		MaxRetries:        envInt("MAX_RETRIES", 3),
		RetryBackoff:      envDuration("RETRY_BACKOFF", 200*time.Millisecond),
		AllowRegister:     envBool("ALLOW_REGISTER", false),
		InitQuota:         int64(envInt("INIT_QUOTA_MICRO_USD", 1_000_000)), // $1.00
		WebDir:            env("WEB_DIR", "web/dist"),
		ARAClaim:          env("ARA_CLAIM", defaultARAClaim),

		// Fail closed: an unpriced model is a misconfiguration, and relaying it
		// anyway hands out upstream tokens the operator still has to pay for.
		UnpricedPolicy:     env("BILLING_UNPRICED_POLICY", "reject"),
		FallbackInput:      envFloat("BILLING_FALLBACK_INPUT_PRICE", 0),
		FallbackOutput:     envFloat("BILLING_FALLBACK_OUTPUT_PRICE", 0),
		FallbackCached:     envFloat("BILLING_FALLBACK_CACHED_PRICE", 0),
		FallbackPerRequest: envFloat("BILLING_FALLBACK_PER_REQUEST_PRICE", 0),
		ModelsDevURL:       env("MODELS_DEV_URL", defaultModelsDevURL),
	}

	secret := env("JWT_SECRET", "")
	if secret == "" {
		return nil, fmt.Errorf("JWT_SECRET is required (generate one with: openssl rand -hex 32)")
	}
	c.JWTSecret = []byte(secret)

	encKey := env("ENCRYPTION_KEY", "")
	if encKey == "" {
		return nil, fmt.Errorf("ENCRYPTION_KEY is required (generate one with: openssl rand -hex 32)")
	}
	// Derive a fixed 32-byte AES key from whatever the operator supplied.
	c.EncryptionKey = sha256.Sum256([]byte(encKey))

	if c.MaxRetries < 1 {
		c.MaxRetries = 1
	}
	return c, nil
}

func env(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v := env(key, ""); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func envFloat(key string, def float64) float64 {
	if v := env(key, ""); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return f
		}
	}
	return def
}

func envBool(key string, def bool) bool {
	if v := env(key, ""); v != "" {
		if b, err := strconv.ParseBool(v); err == nil {
			return b
		}
	}
	return def
}

func envDuration(key string, def time.Duration) time.Duration {
	if v := env(key, ""); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return def
}
