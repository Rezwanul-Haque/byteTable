# ByteTable — common developer commands.
# Renderer scripts run via pnpm at the repo root; the Rust core lives in
# src-tauri (driven with --manifest-path so you can run from anywhere).

PNPM        := pnpm
CARGO       := cargo
MANIFEST    := src-tauri/Cargo.toml

.DEFAULT_GOAL := help
.PHONY: help install dev test lint fmt build build-debug run db-up db-down clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## Install renderer dependencies (pnpm)
	$(PNPM) install

dev: install ## Run the app in development (Tauri + Vite, hot reload)
	$(PNPM) tauri dev

test: install ## Run the test suite (Rust unit/integration tests + TS typecheck)
	$(CARGO) test --manifest-path $(MANIFEST)
	$(PNPM) typecheck

lint: install ## Lint everything (ESLint + clippy + rustfmt/prettier checks)
	$(PNPM) lint
	$(PNPM) format:check
	$(CARGO) fmt --manifest-path $(MANIFEST) -- --check
	$(CARGO) clippy --manifest-path $(MANIFEST) --all-targets --all-features -- -D warnings

fmt: install ## Auto-format everything (prettier + rustfmt)
	$(PNPM) format
	$(CARGO) fmt --manifest-path $(MANIFEST)

build: install ## Build a production desktop bundle (Tauri release)
	$(PNPM) tauri build

build-debug: install ## Build the renderer + a debug binary (fast, no bundling)
	$(PNPM) build
	$(CARGO) build --manifest-path $(MANIFEST)

run: build-debug ## Build (debug) then launch the binary
	./src-tauri/target/debug/bytetable

db-up: ## Start the test databases (Postgres/MySQL/Redis) + seed them
	cd test-fixtures && docker compose up -d && ./seed/seed-redis.sh

db-down: ## Stop and wipe the test databases
	cd test-fixtures && docker compose down -v

clean: ## Remove build artifacts (dist + Rust target)
	rm -rf dist
	$(CARGO) clean --manifest-path $(MANIFEST)
