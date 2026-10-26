// Package store contains the Postgres-backed repositories.
package store

import (
	"errors"
	"fmt"
	"sync/atomic"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/faketoken/faketoken/internal/auth"
)

var (
	ErrNotFound     = errors.New("not found")
	ErrDuplicate    = errors.New("already exists")
	ErrInvalidInput = errors.New("invalid input")
)

type Store struct {
	pool   *pgxpool.Pool
	cipher *auth.Cipher
	// detailKeep is how many calls retain their full bodies, updated from the
	// console without a restart and read on every logged request.
	detailKeep atomic.Int64
	// failedDetailDays is how long a failed call keeps its bodies past that
	// window, set the same way.
	failedDetailDays atomic.Int64
}

func New(pool *pgxpool.Pool, c *auth.Cipher) *Store {
	s := &Store{pool: pool, cipher: c}
	s.detailKeep.Store(DefaultLogDetailKeep)
	s.failedDetailDays.Store(DefaultFailedDetailDays)
	return s
}

func (s *Store) Pool() *pgxpool.Pool { return s.pool }

func mapErr(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	// A unique index is the only thing that can catch a duplicate created by
	// two concurrent requests, so translate it rather than leaking raw SQL.
	// The original is kept in the chain: callers that need to know *which*
	// constraint fired still can, while errors.Is(err, ErrDuplicate) works.
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return fmt.Errorf("%w: %w", ErrDuplicate, err)
	}
	return err
}
