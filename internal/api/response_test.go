package api

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A driver message names hosts, roles and tables. The caller gets a reference
// to the log line instead.
func TestInternalErrorsDoNotReachTheCaller(t *testing.T) {
	rec := httptest.NewRecorder()
	failErr(rec, errors.New(`failed to connect to host=postgres user=faketoken_app: relation "users" does not exist`))

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("HTTP %d, want 500", rec.Code)
	}
	body := rec.Body.String()
	for _, leak := range []string{"postgres", "faketoken_app", "users"} {
		if strings.Contains(body, leak) {
			t.Fatalf("the response carries %q: %s", leak, body)
		}
	}
	if !strings.Contains(body, "编号") {
		t.Fatalf("the response has no reference to look up: %s", body)
	}
}
