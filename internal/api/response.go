package api

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/faketoken/faketoken/internal/store"
)

type page[T any] struct {
	Data  []T   `json:"data"`
	Total int64 `json:"total"`
}

func respond(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if payload == nil {
		return
	}
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		slog.Error("write response", "error", err)
	}
}

func ok(w http.ResponseWriter, payload any) { respond(w, http.StatusOK, payload) }

func fail(w http.ResponseWriter, status int, message string) {
	respond(w, status, map[string]string{"message": message})
}

// failErr maps store errors onto the right status code.
func failErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		fail(w, http.StatusNotFound, "not found")
	case errors.Is(err, store.ErrDuplicate):
		fail(w, http.StatusConflict, err.Error())
	case errors.Is(err, store.ErrInvalidInput):
		fail(w, http.StatusBadRequest, err.Error())
	default:
		fail(w, http.StatusInternalServerError, internalError(err))
	}
}

// internalError logs err under a short reference and returns the text the
// caller sees instead: the reference ties a report to the log line, while
// what failed inside — a driver message, a table name — stays in the log.
func internalError(err error) string {
	raw := make([]byte, 4)
	_, _ = rand.Read(raw)
	ref := hex.EncodeToString(raw)
	slog.Error("request failed", "ref", ref, "error", err)
	return "服务端内部错误（编号 " + ref + "），详情见服务端日志"
}

func decode(w http.ResponseWriter, r *http.Request, dst any) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		fail(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return false
	}
	return true
}

// ------------------------------------------------------------------ queries

func pathID(r *http.Request, name string) (int64, error) {
	return strconv.ParseInt(r.PathValue(name), 10, 64)
}

// idParam reads the {id} path segment and answers 400 when it is not a
// number. subject names the resource in the message ("channel", "user").
func idParam(w http.ResponseWriter, r *http.Request, subject string) (int64, bool) {
	id, err := pathID(r, "id")
	if err != nil {
		fail(w, http.StatusBadRequest, "invalid "+subject+" id")
		return 0, false
	}
	return id, true
}

func queryInt(r *http.Request, key string, def int) int {
	if v := r.URL.Query().Get(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func queryInt64(r *http.Request, key string) int64 {
	if v := r.URL.Query().Get(key); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			return n
		}
	}
	return 0
}

func queryBool(r *http.Request, key string) bool {
	v := strings.ToLower(r.URL.Query().Get(key))
	return v == "1" || v == "true" || v == "yes"
}

// queryBoolPtr is the three-state form: nil when the parameter is absent, so a
// filter can tell "false" apart from "not asked for". Anything unparseable is
// treated as absent rather than as false — a typo must not silently narrow a
// listing to one side of the flag.
func queryBoolPtr(r *http.Request, key string) *bool {
	v := strings.ToLower(r.URL.Query().Get(key))
	switch v {
	case "1", "true", "yes":
		t := true
		return &t
	case "0", "false", "no":
		f := false
		return &f
	default:
		return nil
	}
}

func queryTime(r *http.Request, key string) *time.Time {
	v := r.URL.Query().Get(key)
	if v == "" {
		return nil
	}
	for _, layout := range []string{time.RFC3339, "2006-01-02 15:04:05", "2006-01-02"} {
		if t, err := time.Parse(layout, v); err == nil {
			return &t
		}
	}
	return nil
}

// pagination clamps user-supplied paging to sane bounds.
func pagination(r *http.Request) (offset, limit int) {
	pageNum := max(queryInt(r, "page", 1), 1)
	limit = queryInt(r, "page_size", 20)
	if limit < 1 {
		limit = 20
	}
	if limit > 200 {
		limit = 200
	}
	return (pageNum - 1) * limit, limit
}
