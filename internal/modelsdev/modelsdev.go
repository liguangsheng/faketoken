// Package modelsdev reads the models.dev catalogue into price rows.
//
// models.dev publishes cost in USD per 1M tokens, which is exactly how
// model_prices stores it. Only first-party providers are kept: the gateway
// bills whatever model name the client sent, and those are the names clients
// actually send. Aggregators (OpenRouter and friends) republish the same
// models under namespaced ids and would triple the table for no gain —
// operators who need them can add the rows in the console.
package modelsdev

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"

	"github.com/faketoken/faketoken/internal/model"
)

// maxBody caps the download; the feed is about 5 MB today.
const maxBody = 32 << 20

// maxSaneRate caps one rate in USD per 1M tokens; nothing first-party costs
// more. Rows above it are skipped, so a feed whose units changed under us
// (per-1K, per-token) skips everything and dies in the "no priced models"
// refusal instead of billing 1000×.
const maxSaneRate = 1000

// providers is both the allow-list and the precedence order: the first
// provider to publish a model id wins, so `glm-4.7` is priced the way Z.AI
// sells it rather than the way a reseller does.
var providers = []string{
	"openai",
	"anthropic",
	"google",
	"xai",
	"deepseek",
	"moonshotai",
	"zai",
	"zhipuai",
	"alibaba",
	"minimax",
	"stepfun",
	"mistral",
	"cohere",
	"perplexity",
	"meta",
	"llama",
	"groq",
	"inception",
	"upstage",
}

// Catalogue is the feed reduced to what the price table can use.
type Catalogue struct {
	// Prices is sorted by model name.
	Prices []model.ModelPrice
	// FeedSHA256 identifies the exact bytes this catalogue was parsed from,
	// so an importer can verify that a plan it is about to apply still
	// describes the feed it was previewed against.
	FeedSHA256 string
	// Missing lists allow-listed providers absent from the feed: the sign
	// that models.dev renamed one and a vendor silently dropped out.
	Missing []string
	// duplicates counts models skipped because a higher-precedence provider
	// had already priced the same id. Only the parser and its tests read it.
	duplicates int
}

type provider struct {
	Models map[string]entry `json:"models"`
}

type entry struct {
	ID   string `json:"id"`
	Cost *cost  `json:"cost"`
}

type cost struct {
	Input     *float64 `json:"input"`
	Output    *float64 `json:"output"`
	CacheRead *float64 `json:"cache_read"`
}

// ErrUpstream marks failures that come from the catalogue endpoint —
// unreachable, non-200, malformed, empty — as opposed to local storage
// failures. The console answers 502 for it, so an operator can tell
// "models.dev is broken" from "this gateway is broken".
var ErrUpstream = errors.New("catalogue upstream")

// Fetch downloads the feed and reduces it.
func Fetch(ctx context.Context, client *http.Client, url string) (*Catalogue, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("%w: bad endpoint %q: %v", ErrUpstream, url, err)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: request %s: %v", ErrUpstream, url, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%w: %s returned HTTP %d", ErrUpstream, url, resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxBody))
	if err != nil {
		return nil, fmt.Errorf("%w: read %s: %v", ErrUpstream, url, err)
	}
	return Parse(raw)
}

// Parse reduces a raw feed. A feed with no priced model at all is refused:
// writing it would empty the price table.
func Parse(raw []byte) (*Catalogue, error) {
	var feed map[string]provider
	if err := json.Unmarshal(raw, &feed); err != nil {
		return nil, fmt.Errorf("%w: decode catalogue: %v", ErrUpstream, err)
	}

	sum := sha256.Sum256(raw)
	out := &Catalogue{FeedSHA256: hex.EncodeToString(sum[:])}
	seen := map[string]struct{}{}
	for _, id := range providers {
		found, ok := feed[id]
		if !ok {
			out.Missing = append(out.Missing, id)
			continue
		}
		for _, m := range found.Models {
			// A model with neither an input nor an output rate is not
			// something this gateway knows how to bill (images, audio-only,
			// embeddings priced per character…), so leave it for the operator.
			if m.ID == "" || m.Cost == nil || (m.Cost.Input == nil && m.Cost.Output == nil) {
				continue
			}
			price := model.ModelPrice{
				Model:       m.ID,
				InputPrice:  value(m.Cost.Input),
				OutputPrice: value(m.Cost.Output),
				CachedPrice: value(m.Cost.CacheRead),
			}
			if price.InputPrice < 0 || price.OutputPrice < 0 || price.CachedPrice < 0 {
				continue
			}
			if price.InputPrice > maxSaneRate || price.OutputPrice > maxSaneRate || price.CachedPrice > maxSaneRate {
				continue
			}
			// The pricer lower-cases its keys, so ids differing only in case
			// shadow each other at billing time; keep the higher-precedence
			// provider's spelling and count the rest as duplicates.
			key := strings.ToLower(m.ID)
			if _, taken := seen[key]; taken {
				out.duplicates++
				continue
			}
			seen[key] = struct{}{}
			out.Prices = append(out.Prices, price)
		}
	}

	if len(out.Prices) == 0 {
		return nil, fmt.Errorf("%w: catalogue holds no priced models", ErrUpstream)
	}
	sort.Slice(out.Prices, func(i, j int) bool { return out.Prices[i].Model < out.Prices[j].Model })
	return out, nil
}

func value(v *float64) float64 {
	if v == nil {
		return 0
	}
	return *v
}
