package config

import "testing"

// The registry issued this exact line for the deployment domain; it is a value
// handed to us, not a preference. Pinning it means a change has to be
// deliberate enough to come here too, instead of quietly breaking verification.
func TestARAClaimDefaultsToTheIssuedValue(t *testing.T) {
	const issued = "ara-site-verification=khmVMA2Dg0VlH-w9x5cgltAJFkkZpGkQ"
	if defaultARAClaim != issued {
		t.Fatalf("default claim is %q, want %q", defaultARAClaim, issued)
	}
}

// Rotating the claim has to be possible without a rebuild, which is the whole
// reason it reads the environment.
func TestARAClaimIsOverriddenByTheEnvironment(t *testing.T) {
	const rotated = "ara-site-verification=rotated-value"
	withRequiredSecrets(t)
	t.Setenv("ARA_CLAIM", rotated)

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ARAClaim != rotated {
		t.Fatalf("claim is %q, want the environment value %q", cfg.ARAClaim, rotated)
	}
}

// An unset or blank ARA_CLAIM must fall back to the built-in value rather than
// leave the deployment serving nothing: docker-compose passes the variable
// through unconditionally, so it arrives empty whenever .env omits it.
func TestABlankARAClaimFallsBackToTheDefault(t *testing.T) {
	withRequiredSecrets(t)
	t.Setenv("ARA_CLAIM", "   ")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ARAClaim != defaultARAClaim {
		t.Fatalf("claim is %q, want the default %q", cfg.ARAClaim, defaultARAClaim)
	}
}

// withRequiredSecrets satisfies the two variables Load refuses to start
// without, so a test can exercise everything else.
func withRequiredSecrets(t *testing.T) {
	t.Helper()
	t.Setenv("JWT_SECRET", "test-secret")
	t.Setenv("ENCRYPTION_KEY", "test-encryption-key")
}
