.PHONY: help dev build web run test test-db test-db-down test-integration lint fmt db-up db-down up deploy down logs backup backups clean

BIN := bin/server
# Shown in the console sidebar. -dirty marks uncommitted changes, which `make up`
# deploys along with everything else.
VERSION := $(shell git describe --always --dirty --abbrev=7 2>/dev/null || echo dev)
LDFLAGS := -X github.com/faketoken/faketoken/internal/api.version=$(VERSION)

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

build: ## Compile the server binary
	go build -trimpath -ldflags "$(LDFLAGS)" -o $(BIN) ./cmd/server

web: ## Build the React console into web/dist
	cd web && npm install && npm run build

run: build ## Run the server locally (reads .env)
	set -a; [ -f .env ] && . ./.env; set +a; ./$(BIN)

dev: ## Run the Vite dev server against a local backend
	cd web && npm install && npm run dev

test: ## Run the Go test suite
	go test ./... -count=1

lint: ## Vet, format-check, confirm go.mod is tidy, and lint the console
	go vet ./...
	go mod tidy -diff
	@[ -z "$$(gofmt -l ./cmd ./internal)" ] || (gofmt -l ./cmd ./internal; exit 1)
	cd web && npm run --silent lint

fmt: ## Format Go sources
	gofmt -w ./cmd ./internal

test-db: ## Start the throwaway Postgres instance and leave it up (for a tight test loop)
	docker compose --profile test up -d --wait postgres-test

test-db-down: ## Stop the throwaway instance and discard its data
	docker compose --profile test rm -sf postgres-test

# The instance is started and removed by the script, so a run leaves no second
# Postgres behind on the host. KEEP_TEST_DB=1, or a prior `make test-db`, keeps
# it up for the next run.
test-integration: ## Run the integration suite on a throwaway instance, then remove it
	./scripts/integration-test.sh

db-up: ## Start only Postgres
	docker compose up -d postgres

db-down: ## Stop Postgres
	docker compose stop postgres

up: ## Build and start the whole stack
	VERSION=$(VERSION) docker compose up -d --build

deploy: ## Ship a change: rebuild the server alone, verify, roll back on failure
	./scripts/deploy.sh

down: ## Stop the stack
	docker compose down

logs: ## Follow the server logs
	docker compose logs -f server

# --no-deps: run would otherwise bring Postgres up to date with the compose
# file, which restarts the database whenever its configuration changed.
backup: ## Take an on-demand dump now (the service also dumps nightly)
	docker compose run --rm --no-deps backup once

backups: ## List the dumps currently retained
	@ls -lh $${BACKUP_DIR:-./.backup}/*.dump 2>/dev/null || echo "no dumps yet"

clean: ## Remove build artefacts and web/node_modules
	rm -rf bin web/dist web/node_modules
