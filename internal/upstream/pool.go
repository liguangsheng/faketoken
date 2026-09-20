// Package upstream owns the HTTP side of talking to a provider: the pooled
// clients every outbound call goes through, and the reading of what a provider
// says when it refuses one.
package upstream

import (
	"net"
	"net/http"
	"net/url"
	"sync"
	"time"
)

// Pool hands out one http.Client per proxy configuration so that connection
// pools are reused across requests instead of rebuilt.
type Pool struct {
	mu      sync.RWMutex
	clients map[string]*http.Client
}

func NewPool() *Pool {
	return &Pool{clients: map[string]*http.Client{}}
}

// Get returns the client for one proxy setting ("" for a direct connection).
// Every caller shares its connections and its no-redirect policy.
func (p *Pool) Get(proxyURL string) (*http.Client, error) {
	p.mu.RLock()
	c, ok := p.clients[proxyURL]
	p.mu.RUnlock()
	if ok {
		return c, nil
	}

	transport := &http.Transport{
		DialContext: (&net.Dialer{
			Timeout:   15 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          512,
		MaxIdleConnsPerHost:   64,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   15 * time.Second,
		ExpectContinueTimeout: time.Second,
		// No ResponseHeaderTimeout: reasoning models can think for minutes
		// before the first byte. Deadlines come from the request context.
	}
	if proxyURL != "" {
		u, err := url.Parse(proxyURL)
		if err != nil {
			return nil, err
		}
		transport.Proxy = http.ProxyURL(u)
	}

	client := &http.Client{
		Transport: transport,
		// Redirects are not followed: an upstream that redirects would strip
		// our credentials or silently change the destination.
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}

	p.mu.Lock()
	defer p.mu.Unlock()
	if existing, ok := p.clients[proxyURL]; ok {
		return existing, nil
	}
	p.clients[proxyURL] = client
	return client, nil
}
