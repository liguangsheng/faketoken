// Command server runs the LLM relay station: an OpenAI/Anthropic/Gemini
// compatible gateway with multi-user accounts, channel routing and billing.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/faketoken/faketoken/internal/api"
	"github.com/faketoken/faketoken/internal/auth"
	"github.com/faketoken/faketoken/internal/billing"
	"github.com/faketoken/faketoken/internal/config"
	"github.com/faketoken/faketoken/internal/db"
	"github.com/faketoken/faketoken/internal/keepalive"
	"github.com/faketoken/faketoken/internal/model"
	"github.com/faketoken/faketoken/internal/relay"
	"github.com/faketoken/faketoken/internal/store"
)

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	})))

	if err := run(); err != nil {
		slog.Error("fatal", "error", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := db.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()

	if err := db.Migrate(ctx, pool); err != nil {
		return err
	}

	cipher, err := auth.NewCipher(cfg.EncryptionKey)
	if err != nil {
		return err
	}
	st := store.New(pool, cipher)

	if err := bootstrapAdmin(ctx, st, cfg); err != nil {
		return err
	}

	settings := billing.Settings{
		UnpricedPolicy: billing.UnpricedPolicy(cfg.UnpricedPolicy),
		Fallback: billing.FallbackPrice{
			InputPrice:      cfg.FallbackInput,
			OutputPrice:     cfg.FallbackOutput,
			CachedPrice:     cfg.FallbackCached,
			PerRequestPrice: cfg.FallbackPerRequest,
		},
	}
	// Refuse to boot on a billing config that would quietly give tokens away.
	if err := settings.Validate(); err != nil {
		return fmt.Errorf("billing configuration: %w", err)
	}

	pricer := billing.NewPricer(st, settings)
	if err := pricer.Reload(ctx); err != nil {
		return err
	}
	pricer.StartRefresh(ctx, time.Minute)
	slog.Info("billing ready", "unpriced_policy", pricer.Settings().UnpricedPolicy)

	// An empty price table on a fresh install rejects every request until
	// somebody fills it. The catalogue is fetched in the background rather
	// than before Listen: a host without egress must still start, and the
	// console can always import on demand.
	importer := billing.NewImporter(st, cfg.ModelsDevURL)
	go seedPrices(ctx, importer, pricer)

	// Once a minute is enough for a schedule configured to the minute. The
	// zone is logged because it is the one thing that can quietly make every
	// keepalive window fire at the wrong hour: the container runs in UTC unless
	// TZ says otherwise.
	keepalive.New(st).Start(ctx, time.Minute)
	logKeepaliveSchedule(ctx, st)

	jwt := auth.NewJWTManager(cfg.JWTSecret, cfg.SessionTTL)
	rl := relay.New(st, pricer, cfg)
	server := api.NewServer(cfg, st, jwt, pricer, rl, importer)
	// The relay caches the session-log body cap in memory, so a restart has to
	// pick the stored value back up or it would silently revert to the default.
	server.LoadRuntimeOptions(ctx)

	httpServer := &http.Server{
		Addr:    cfg.Listen,
		Handler: server.Handler(),
		// No WriteTimeout: streamed completions legitimately run for minutes.
		ReadHeaderTimeout: 30 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	errc := make(chan error, 1)
	go func() {
		slog.Info("listening", "addr", cfg.Listen)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errc <- err
		}
	}()

	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
		slog.Info("shutting down")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		return httpServer.Shutdown(shutdownCtx)
	}
}

// seedPrices fills an empty price table from the catalogue. It runs in the
// background and never fails the boot: a host without egress still serves,
// and the console can run the same import by hand.
func seedPrices(ctx context.Context, im *billing.Importer, pricer *billing.Pricer) {
	if !im.Enabled() {
		slog.Info("price catalogue import is disabled", "env", "MODELS_DEV_URL")
		return
	}

	seeded, err := im.SeedIfEmpty(ctx)
	if err != nil {
		slog.Warn("could not seed the price table from the catalogue; "+
			"import it from the console once the host has egress",
			"url", im.URL(), "error", err)
		return
	}
	if !seeded {
		return
	}
	if err := pricer.Reload(ctx); err != nil {
		slog.Warn("price reload after seeding failed", "error", err)
	}
}

// logKeepaliveSchedule reports the zone the daily windows are read in, and when
// each configured channel opens next. A channel set to 03:00 by an operator in
// +08 opens at 11:00 their time if the process runs in UTC, and nothing else
// about the deployment would reveal that.
func logKeepaliveSchedule(ctx context.Context, st *store.Store) {
	zone, offset := time.Now().Zone()
	channels, err := st.ListKeepaliveChannels(ctx)
	if err != nil {
		slog.Warn("keepalive schedule unreadable", "error", err)
		return
	}
	slog.Info("keepalive ready", "zone", zone, "utc_offset_hours", offset/3600,
		"channels", len(channels))
	now := time.Now()
	for _, ch := range channels {
		next, ok := keepalive.NextRun(ch, now)
		if !ok {
			slog.Warn("keepalive channel is configured but can never open",
				"channel", ch.ID, "name", ch.Name, "at", ch.KeepaliveAt,
				"target", ch.KeepaliveTarget)
			continue
		}
		slog.Info("keepalive schedule", "channel", ch.ID, "name", ch.Name,
			"at", ch.KeepaliveAt, "target", ch.KeepaliveTarget,
			"next_run", next.Format(time.RFC3339))
	}
}

// bootstrapAdmin creates the first administrator on an empty database.
func bootstrapAdmin(ctx context.Context, st *store.Store, cfg *config.Config) error {
	count, err := st.CountUsers(ctx)
	if err != nil {
		return err
	}
	if count > 0 {
		return nil
	}

	hash, err := auth.HashPassword(cfg.InitAdminPass)
	if err != nil {
		return err
	}
	if _, err := st.CreateUser(ctx, &model.User{
		Username:     cfg.InitAdminUser,
		PasswordHash: hash,
		DisplayName:  "Administrator",
		Role:         model.RoleAdmin,
		Status:       model.StatusEnabled,
		Group:        "default",
		Quota:        billing.ParseUSD(1000),
	}); err != nil {
		return err
	}
	slog.Warn("created the initial administrator account — change the password immediately",
		"username", cfg.InitAdminUser)
	return nil
}
