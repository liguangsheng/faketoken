package api

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// playgroundRelayTimeout bounds one forwarded call. It is generous because a
// reasoning model can think for minutes before the first byte; the browser
// going away already cancels through the request context, so this only stops a
// call nobody is waiting for from holding a connection open forever.
const playgroundRelayTimeout = 10 * time.Minute

// forwardedHeaderDenied lists what the console may not set on the forwarded
// request. These describe the connection this server opens rather than the one
// the browser opened, and passing them through would corrupt the framing.
var forwardedHeaderDenied = map[string]bool{
	"connection":        true,
	"content-length":    true,
	"host":              true,
	"keep-alive":        true,
	"proxy-connection":  true,
	"te":                true,
	"trailer":           true,
	"transfer-encoding": true,
	"upgrade":           true,
}

// handlePlaygroundRelay makes one request on the test page's behalf and streams
// the reply straight back.
//
// The page can reach another gateway by itself — it is only JavaScript — but a
// cross-origin call is preceded by a CORS preflight, and a gateway that leaves
// OPTIONS unhandled on its relay routes rejects that preflight before the real
// request is ever sent. Routing through this server makes the browser talk to
// its own origin, where no preflight applies.
//
// Administrator-only, because it aims this server at whatever URL it is handed:
// everything the machine can reach, the caller can reach.
func (s *Server) handlePlaygroundRelay(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Method  string            `json:"method"`
		URL     string            `json:"url"`
		Headers map[string]string `json:"headers"`
		Body    string            `json:"body"`
	}
	if !decode(w, r, &in) {
		return
	}

	method := strings.ToUpper(strings.TrimSpace(in.Method))
	if method == "" {
		method = http.MethodPost
	}
	// The page only ever sends a prompt or reads a model list; anything else
	// would be this endpoint being used as a general-purpose proxy.
	if method != http.MethodGet && method != http.MethodPost {
		fail(w, http.StatusBadRequest, "method must be GET or POST")
		return
	}

	target, err := url.Parse(strings.TrimSpace(in.URL))
	if err != nil || target.Host == "" || (target.Scheme != "http" && target.Scheme != "https") {
		fail(w, http.StatusBadRequest, "url must be an absolute http(s) address")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), playgroundRelayTimeout)
	defer cancel()

	var body io.Reader
	if in.Body != "" {
		body = strings.NewReader(in.Body)
	}
	req, err := http.NewRequestWithContext(ctx, method, target.String(), body)
	if err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	for name, value := range in.Headers {
		if forwardedHeaderDenied[strings.ToLower(strings.TrimSpace(name))] {
			continue
		}
		req.Header.Set(name, value)
	}
	if in.Body != "" && req.Header.Get("Content-Type") == "" {
		req.Header.Set("Content-Type", "application/json")
	}

	client, err := s.prober.Client("")
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	resp, err := client.Do(req)
	if err != nil {
		// 502 rather than 500: the failure belongs to the far end, and the page
		// shows this text where "check the address" advice belongs.
		fail(w, http.StatusBadGateway, "cannot reach "+target.Scheme+"://"+target.Host+": "+err.Error())
		return
	}
	defer resp.Body.Close()

	// The status and body go back verbatim: the page parses upstream errors
	// itself, and a rewritten status would hide which end refused.
	if ct := resp.Header.Get("Content-Type"); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	w.Header().Set("Cache-Control", "no-cache")
	// A buffering reverse proxy in front of this server would otherwise hold a
	// streamed reply back until it completed.
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(resp.StatusCode)

	flusher, _ := w.(http.Flusher)
	buf := make([]byte, 32*1024)
	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			if _, writeErr := w.Write(buf[:n]); writeErr != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if readErr != nil {
			return
		}
	}
}
