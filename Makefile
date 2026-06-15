# ByteTable — common developer commands.
# Renderer scripts run via pnpm at the repo root; the Rust core lives in
# src-tauri (driven with --manifest-path so you can run from anywhere).

PNPM        := pnpm
CARGO       := cargo
MANIFEST    := src-tauri/Cargo.toml

# Put a rustup-installed toolchain on PATH for every recipe, so a cargo that
# `ensure-cargo` just installed (into ~/.cargo/bin) is found without re-sourcing
# a shell. `export` makes this visible to all recipe sub-shells.
export PATH := $(HOME)/.cargo/bin:$(PATH)

.DEFAULT_GOAL := help
.PHONY: help install ensure-cargo dev dev-cert test lint fmt build build-debug run db-up db-down clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## Install renderer dependencies (pnpm)
	$(PNPM) install

ensure-cargo: ## Install the Rust toolchain (rustup) if cargo is missing
	@command -v cargo >/dev/null 2>&1 && exit 0; \
	echo "cargo not found — installing the Rust toolchain via rustup…"; \
	case "$$(uname -s)" in \
	  Linux|Darwin|*BSD|MINGW*|MSYS*|CYGWIN*) \
	    command -v curl >/dev/null 2>&1 || { echo "ERROR: curl is required to install Rust. Install curl or Rust manually: https://rustup.rs"; exit 1; }; \
	    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path; \
	    ;; \
	  *) echo "ERROR: unsupported OS for auto-install. Install Rust manually: https://rustup.rs"; exit 1;; \
	esac; \
	command -v cargo >/dev/null 2>&1 || { echo "ERROR: cargo still not on PATH after install — open a new shell or add ~/.cargo/bin to PATH."; exit 1; }

dev: install ensure-cargo ## Run the app in development (Tauri + Vite, hot reload)
	$(PNPM) tauri dev

test: install ensure-cargo ## Run the test suite (Rust unit/integration tests + TS typecheck)
	$(CARGO) test --manifest-path $(MANIFEST)
	$(PNPM) typecheck

lint: install ensure-cargo ## Lint everything (ESLint + clippy + rustfmt/prettier checks)
	$(PNPM) lint
	$(PNPM) format:check
	$(CARGO) fmt --manifest-path $(MANIFEST) -- --check
	$(CARGO) clippy --manifest-path $(MANIFEST) --all-targets --all-features -- -D warnings

fmt: install ensure-cargo ## Auto-format everything (prettier + rustfmt)
	$(PNPM) format
	$(CARGO) fmt --manifest-path $(MANIFEST)

build: install ensure-cargo ## Build a production desktop bundle (Tauri release)
	$(PNPM) tauri build

build-debug: install ensure-cargo ## Build the renderer + a debug binary (fast, no bundling)
	$(PNPM) build
	$(CARGO) build --manifest-path $(MANIFEST)
	@bash scripts/codesign-dev.sh sign 2>/dev/null || true

run: build-debug ## Build (debug) then launch the binary
	./src-tauri/target/debug/bytetable

dev-cert: ## macOS: create the stable self-signed identity used to sign dev builds (one-time)
	bash scripts/codesign-dev.sh setup

db-up: ## Start the test databases (Postgres/MySQL/Redis) + seed them
	cd test-fixtures && docker compose up -d && ./seed/seed-redis.sh

db-down: ## Stop and wipe the test databases
	cd test-fixtures && docker compose down -v

clean: ## Remove build artifacts (dist + Rust target)
	rm -rf dist
	$(CARGO) clean --manifest-path $(MANIFEST)
