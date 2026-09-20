// Package probe is the operator's side of an upstream: pulling its model
// catalogue, sending a test request, reading the credit behind a channel. None
// of it is on the relayed-request path; all of it is what the console does
// when somebody presses a button.
package probe

import (
	"net/http"

	"github.com/faketoken/faketoken/internal/upstream"
)

// Prober issues the console's calls to an upstream.
type Prober struct {
	clients *upstream.Pool
	// limit reads the current capture cap, so a probe's stored exchange is
	// bounded the same way a relayed one is. A function rather than a value:
	// the operator changes it at runtime, and the relay owns the setting.
	limit func() int
}

// New shares the relay's connection pool, so a probe reuses the connections
// and the no-redirect policy the relayed traffic already has.
func New(clients *upstream.Pool, captureLimit func() int) *Prober {
	return &Prober{clients: clients, limit: captureLimit}
}

// Client hands out the pooled client for one proxy setting ("" for a direct
// connection), for callers that build the upstream request themselves.
func (p *Prober) Client(proxyURL string) (*http.Client, error) {
	return p.clients.Get(proxyURL)
}
