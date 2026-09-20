package relay

import (
	"net/http"

	"github.com/faketoken/faketoken/internal/billing"
)

// The OpenAI dashboard billing pair, as reimplemented by new-api and one-api.
// Exposing it lets another gateway add this one as a channel and read the
// credit behind a key — the same two calls this relay makes when it probes an
// upstream (see probe.FetchNewAPIBalance).
//
// Authenticated by API key rather than by a console session: the caller is a
// gateway holding a key, not a person holding a login.

// keyCredit is what a key can still spend, and what it has spent.
//
// Two gates decide whether a request is allowed — the key's own allowance and
// the owner's balance — so the usable figure is the smaller of the two.
// Reporting the key's allowance alone would promise credit the account cannot
// cover.
type keyCredit struct {
	remaining int64 // micro-USD
	used      int64
}

func (rl *Relay) creditFor(p *principal) keyCredit {
	if p.token.UnlimitedQuota {
		// The key imposes no limit of its own, so what is left is simply the
		// account balance, and the spend that matters is the account's.
		return keyCredit{remaining: p.user.Quota, used: p.user.UsedQuota}
	}
	remaining := min(p.token.Quota, p.user.Quota)
	return keyCredit{remaining: max(remaining, 0), used: p.token.UsedQuota}
}

// handleBillingSubscription reports the grant behind the key.
//
// Both spellings are filled in: hard_limit_usd is what OpenAI's own dashboard
// returns and what new-api looks for, while total_available is what several
// aggregators read instead. Sending one and not the other means half the
// callers see nothing.
func (rl *Relay) handleBillingSubscription(w http.ResponseWriter, r *http.Request) {
	p, status, err := rl.authenticate(r.Context(), r)
	if err != nil {
		writeError(w, status, "authentication_error", "", err.Error())
		return
	}

	credit := rl.creditFor(p)
	limit := billing.FormatUSD(credit.remaining + credit.used)

	writeJSON(w, http.StatusOK, map[string]any{
		"object":                "billing_subscription",
		"has_payment_method":    true,
		"soft_limit_usd":        limit,
		"hard_limit_usd":        limit,
		"system_hard_limit_usd": limit,
		"total_available":       billing.FormatUSD(credit.remaining),
		"access_until":          0,
	})
}

// handleBillingUsage reports what the key has spent.
//
// The amount is in cents, which is the one detail that silently breaks a
// caller if it is wrong: OpenAI's endpoint reports cents while the
// subscription call reports dollars, and every aggregator divides this by 100.
//
// The start_date and end_date parameters are accepted and ignored. The figure
// is a running total kept on the key, so it is lifetime spend rather than a
// windowed sum; callers send a range spanning decades precisely because they
// want everything.
func (rl *Relay) handleBillingUsage(w http.ResponseWriter, r *http.Request) {
	p, status, err := rl.authenticate(r.Context(), r)
	if err != nil {
		writeError(w, status, "authentication_error", "", err.Error())
		return
	}

	credit := rl.creditFor(p)
	writeJSON(w, http.StatusOK, map[string]any{
		"object":      "list",
		"total_usage": billing.FormatUSD(credit.used) * 100,
	})
}
