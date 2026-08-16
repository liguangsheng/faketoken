// Command genprices turns the models.dev catalogue into the built-in price
// table compiled into the server.
//
//	go run ./cmd/genprices                 # pull the live catalogue
//	go run ./cmd/genprices -file api.json  # regenerate from a local snapshot
//
// Only first-party providers are kept, in the order listed in `providers`: the
// gateway bills whatever model name the client sent, and those are the names
// clients actually send. Aggregators (OpenRouter and friends) republish the
// same models under namespaced ids and would triple the table for no gain —
// operators who need them can add the rows in the console.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"time"
)

const defaultURL = "https://models.dev/api.json"

// providers is both the allow-list and the precedence order: the first
// provider to publish a model id wins, so `glm-4.7` is priced the way Z.AI
// sells it rather than the way a reseller does.
var providers = []struct {
	ID    string
	Label string
}{
	{"openai", "OpenAI"},
	{"anthropic", "Anthropic"},
	{"google", "Google"},
	{"xai", "xAI"},
	{"deepseek", "DeepSeek"},
	{"moonshotai", "Moonshot"},
	{"zai", "Z.AI"},
	{"zhipuai", "Zhipu AI"},
	{"alibaba", "Alibaba (Qwen)"},
	{"minimax", "MiniMax"},
	{"stepfun", "StepFun"},
	{"mistral", "Mistral"},
	{"cohere", "Cohere"},
	{"perplexity", "Perplexity"},
	{"meta", "Meta"},
	{"llama", "Llama API"},
	{"groq", "Groq"},
	{"inception", "Inception"},
	{"upstage", "Upstage"},
}

type provider struct {
	Name   string           `json:"name"`
	Models map[string]entry `json:"models"`
}

type entry struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Cost *cost  `json:"cost"`
}

// cost is USD per 1M tokens, which is exactly how model_prices stores it.
type cost struct {
	Input     *float64 `json:"input"`
	Output    *float64 `json:"output"`
	CacheRead *float64 `json:"cache_read"`
}

type row struct {
	Model    string
	Input    float64
	Output   float64
	Cached   float64
	Provider string
}

func main() {
	var (
		url  = flag.String("url", defaultURL, "models.dev catalogue endpoint")
		file = flag.String("file", "", "read the catalogue from a local file instead of the network")
		out  = flag.String("out", "internal/billing/catalog_gen.go", "generated file to write")
	)
	flag.Parse()

	raw, source, err := fetch(*url, *file)
	if err != nil {
		log.Fatalf("read catalogue: %v", err)
	}

	var catalogue map[string]provider
	if err := json.Unmarshal(raw, &catalogue); err != nil {
		log.Fatalf("decode catalogue: %v", err)
	}

	groups, total := collect(catalogue)
	if total == 0 {
		log.Fatal("no priced models found; refusing to write an empty catalogue")
	}

	if err := os.WriteFile(*out, render(groups, total, source), 0o644); err != nil {
		log.Fatalf("write %s: %v", *out, err)
	}
	if err := exec.Command("gofmt", "-w", *out).Run(); err != nil {
		log.Printf("gofmt %s: %v", *out, err)
	}
	fmt.Printf("wrote %s: %d models from %d providers\n", *out, total, len(groups))
}

func fetch(url, file string) ([]byte, string, error) {
	if file != "" {
		raw, err := os.ReadFile(file)
		return raw, file, err
	}

	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("%s returned HTTP %d", url, resp.StatusCode)
	}
	raw, err := io.ReadAll(resp.Body)
	return raw, url, err
}

type group struct {
	Label string
	Rows  []row
}

func collect(catalogue map[string]provider) ([]group, int) {
	seen := map[string]string{}
	groups := make([]group, 0, len(providers))
	total := 0

	for _, p := range providers {
		found, ok := catalogue[p.ID]
		if !ok {
			log.Printf("warning: provider %q is missing from the catalogue", p.ID)
			continue
		}

		rows := make([]row, 0, len(found.Models))
		for _, m := range found.Models {
			// A model with neither an input nor an output rate is not something
			// this gateway knows how to bill (images, audio-only, embeddings
			// priced per character…), so leave it for the operator.
			if m.Cost == nil || (m.Cost.Input == nil && m.Cost.Output == nil) {
				continue
			}
			if owner, taken := seen[m.ID]; taken {
				if owner != p.ID {
					log.Printf("skipping duplicate %s (already priced by %s)", m.ID, owner)
				}
				continue
			}
			seen[m.ID] = p.ID
			rows = append(rows, row{
				Model:    m.ID,
				Input:    value(m.Cost.Input),
				Output:   value(m.Cost.Output),
				Cached:   value(m.Cost.CacheRead),
				Provider: p.ID,
			})
		}
		if len(rows) == 0 {
			continue
		}

		sort.Slice(rows, func(i, j int) bool { return rows[i].Model < rows[j].Model })
		groups = append(groups, group{Label: p.Label, Rows: rows})
		total += len(rows)
	}
	return groups, total
}

func value(v *float64) float64 {
	if v == nil {
		return 0
	}
	return *v
}

func render(groups []group, total int, source string) []byte {
	var b strings.Builder

	b.WriteString("// Code generated by cmd/genprices from models.dev; DO NOT EDIT.\n")
	fmt.Fprintf(&b, "// Snapshot taken from %s\n\n", source)
	b.WriteString("package billing\n\n")
	b.WriteString(`import "github.com/faketoken/faketoken/internal/model"` + "\n\n")

	b.WriteString("// CatalogSource names where the built-in prices came from.\n")
	b.WriteString("const CatalogSource = \"models.dev\"\n\n")
	b.WriteString("// CatalogGeneratedAt is the day the snapshot was pulled (UTC).\n")
	fmt.Fprintf(&b, "const CatalogGeneratedAt = %q\n\n", time.Now().UTC().Format("2006-01-02"))

	fmt.Fprintf(&b, "// catalog holds %d models priced in USD per 1M tokens. A zero\n", total)
	b.WriteString("// CachedPrice means models.dev published no cache-read rate, which the\n")
	b.WriteString("// pricer bills at the input rate — the conservative reading.\n")
	b.WriteString("var catalog = []model.ModelPrice{\n")
	for _, g := range groups {
		fmt.Fprintf(&b, "\t// %s\n", g.Label)
		for _, r := range g.Rows {
			fmt.Fprintf(&b, "\t{Model: %q", r.Model)
			// Zero-valued fields are the struct default; leaving them out keeps
			// the table scannable by eye.
			if r.Input != 0 {
				fmt.Fprintf(&b, ", InputPrice: %s", num(r.Input))
			}
			if r.Output != 0 {
				fmt.Fprintf(&b, ", OutputPrice: %s", num(r.Output))
			}
			if r.Cached != 0 {
				fmt.Fprintf(&b, ", CachedPrice: %s", num(r.Cached))
			}
			b.WriteString("},\n")
		}
		b.WriteString("\n")
	}
	b.WriteString("}\n")
	return []byte(b.String())
}

// num keeps the generated literals readable: 2.5 rather than 2.500000.
func num(v float64) string {
	return strconv.FormatFloat(v, 'f', -1, 64)
}
