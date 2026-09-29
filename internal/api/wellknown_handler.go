package api

import "net/http"

// handleARAClaim serves the ARA ownership proof as a plain text file: the
// registry fetches /.well-known/ara-claim.txt over the domain and expects the
// configured line back. The route is explicit because the SPA fallback would
// otherwise answer this path with index.html, the file not existing on disk.
//
// The claim comes from configuration (ARA_CLAIM, defaulting to the value baked
// into the binary) rather than from WEB_DIR, because that directory is a build
// artefact — a deployment that has not run `make web`, or one pointed at a
// WEB_DIR someone else manages, would silently stop answering and lose the
// verification.
func (s *Server) handleARAClaim(w http.ResponseWriter, r *http.Request) {
	// Serving an empty body would look like a valid response carrying the
	// wrong claim; 404 says plainly that this deployment has none configured.
	if s.cfg.ARAClaim == "" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	// The claim can be rotated. A cached copy of the previous one would keep
	// failing verification long after the redeploy that replaced it.
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write([]byte(s.cfg.ARAClaim + "\n"))
}
