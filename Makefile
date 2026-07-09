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
.PHONY: help install hooks ensure-cargo dev dev-cert test lint clippy fmt build build-debug run tag db-up db-down tunnel-up tunnel-down clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## Install renderer dependencies (pnpm)
	$(PNPM) install

hooks: install ## Install the git pre-commit hook (husky + lint-staged)
	$(PNPM) exec husky

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

# CI (.github/workflows/ci.yml) runs clippy on the LATEST stable toolchain
# (dtolnay/rust-toolchain@stable, components: clippy) from the src-tauri working
# directory: `cargo clippy --all-targets --all-features -- -D warnings`. Mirror
# that byte-for-byte. Pin to stable (overriding any RUSTUP_TOOLCHAIN the caller's
# shell has set) so a locally-pinned older toolchain can't miss a newer lint that
# CI will fail on.
clippy: ensure-cargo ## Run clippy exactly as CI does (latest stable, all targets/features, deny warnings)
	rustup toolchain install stable --profile minimal --component clippy 2>/dev/null || true
	cd src-tauri && RUSTUP_TOOLCHAIN=stable $(CARGO) clippy --all-targets --all-features -- -D warnings

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

tag: ## Bump the version on dev, merge dev → main, then tag + push the release (usage: make tag VERSION=0.0.2)
	@test -n "$(VERSION)" || { echo "usage: make tag VERSION=0.0.2"; exit 1; }
	@# git-flow variant A: the version bump originates on dev and flows to
	@# main via merge, so dev is never left behind main. Run this on dev.
	@test "$$(git rev-parse --abbrev-ref HEAD)" = "dev" || \
		{ echo "run 'make tag' on dev — the release flows dev → main"; exit 1; }
	@test -z "$$(git status --porcelain)" || \
		{ echo "working tree not clean — commit or stash first"; exit 1; }
	@git fetch origin -q
	@git merge-base --is-ancestor origin/dev HEAD || \
		{ echo "local dev is behind origin/dev — pull first"; exit 1; }
	@git merge-base --is-ancestor origin/main origin/dev || \
		{ echo "origin/main has commits not on dev — merge main → dev first"; exit 1; }
	@v=$$(echo "$(VERSION)" | sed 's/^v//'); \
	bash scripts/bump-version.sh "$$v" && \
	git add src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock package.json index.html \
	        src/features/updater/api.ts src/features/workspaces/components/Rail.tsx && \
	git commit -m "Release v$$v" && \
	git push origin dev && \
	git checkout main && \
	git merge --ff-only origin/main && \
	git merge --ff-only dev && \
	git tag -a "v$$v" -m "ByteTable v$$v" && \
	git push origin main && \
	git push origin "v$$v" && \
	git checkout dev && \
	echo "Released v$$v: dev → main merged, tagged + pushed — the release workflow will build + publish it."

db-up: ## Start the test databases (Postgres/MySQL/SQL Server/Redis/DynamoDB/MongoDB/Cassandra) + seed them
	cd test-fixtures && docker compose up -d && ./seed/seed-redis.sh && ./seed/seed-dynamo.sh && ./seed/seed-cassandra.sh && ./seed/seed-mssql.sh

db-down: ## Stop and wipe the test databases
	cd test-fixtures && docker compose down -v

tunnel-up: ## Start the SSH-bastion tunnel rig (MySQL/Postgres/Redis behind a bastion) + seed
	cd test-fixtures && \
	  docker compose -p bytetable-tunnel -f docker-compose.tunnel.yml up -d && \
	  until docker exec bt-redis-tunnel redis-cli -a bytetable ping >/dev/null 2>&1; do sleep 1; done && \
	  BT_REDIS_CONTAINER=bt-redis-tunnel ./seed/seed-redis.sh

tunnel-down: ## Stop and wipe the SSH-bastion tunnel rig
	cd test-fixtures && docker compose -p bytetable-tunnel -f docker-compose.tunnel.yml down -v

clean: ## Remove build artifacts (dist + Rust target)
	rm -rf dist
	$(CARGO) clean --manifest-path $(MANIFEST)
