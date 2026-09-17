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
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"

	"github.com/faketoken/faketoken/internal/model"
)

// maxBody caps the download; the feed is about 5 MB today.
const maxBody = 32 << 20

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
	// Missing lists allow-listed providers absent from the feed: the sign
	// that models.dev renamed one and a vendor silently dropped out.
	Missing []string
	// Duplicates counts models skipped because a higher-precedence provider
	// had already priced the same id.
	Duplicates int
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

// Fetch downloads the feed and reduces it.
func Fetch(ctx context.Context, client *http.Client, url string) (*Catalogue, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s returned HTTP %d", url, resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxBody))
	if err != nil {
		return nil, err
	}
	return Parse(raw)
}

// Parse reduces a raw feed. A feed with no priced model at all is refused:
// writing it would empty the price table.
func Parse(raw []byte) (*Catalogue, error) {
	var feed map[string]provider
	if err := json.Unmarshal(raw, &feed); err != nil {
		return nil, fmt.Errorf("decode catalogue: %w", err)
	}

	out := &Catalogue{}
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
			if _, taken := seen[m.ID]; taken {
				out.Duplicates++
				continue
			}
			seen[m.ID] = struct{}{}
			out.Prices = append(out.Prices, price)
		}
	}

	if len(out.Prices) == 0 {
		return nil, errors.New("catalogue holds no priced models")
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
