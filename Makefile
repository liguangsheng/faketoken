.PHONY: help dev build web run test lint fmt prices db-up db-down up down logs clean

BIN := bin/server

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

build: ## Compile the server binary
	go build -trimpath -o $(BIN) ./cmd/server

web: ## Build the React console into web/dist
	cd web && npm install && npm run build

run: build ## Run the server locally (reads .env)
	set -a; [ -f .env ] && . ./.env; set +a; ./$(BIN)

dev: ## Run the Vite dev server against a local backend
	cd web && npm install && npm run dev

test: ## Run the Go test suite
	go test ./... -count=1

lint: ## Vet and format-check
	go vet ./...
	@test -z "$$(gofmt -l ./cmd ./internal)" || (gofmt -l ./cmd ./internal; exit 1)

fmt: ## Format Go sources
	gofmt -w ./cmd ./internal

prices: ## Refresh the built-in price table from models.dev
	go run ./cmd/genprices
	go test ./internal/billing -count=1

db-up: ## Start only Postgres
	docker compose up -d postgres

db-down: ## Stop Postgres
	docker compose stop postgres

up: ## Build and start the whole stack
	docker compose up -d --build

down: ## Stop the stack
	docker compose down

logs: ## Follow the server logs
	docker compose logs -f server

clean: ## Remove build artefacts
	rm -rf bin web/dist
