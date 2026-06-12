# Thin task runner over npm/wrangler. Every recipe echoes its real command,
# so this file doubles as documentation. See docs/SELF_HOSTING.md for the
# full setup walkthrough.

.PHONY: help install dev dev-web build test typecheck \
        migrate-local migrate-remote setup seed-local seed-remote \
        deploy deploy-email deploy-api deploy-web

MAILBOX ?= josh

help: ## List available targets
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-16s %s\n", $$1, $$2}'

install: ## Install all workspace dependencies
	npm install

dev: ## Run the API worker locally (Miniflare D1/R2 bindings)
	npm run dev -w packages/api

dev-web: ## Run the web SPA dev server (Vite, port 5173)
	npm run dev -w packages/web

build: ## Build the web SPA
	npm run build -w packages/web

test: ## Run Vitest across all workspaces
	npm test

typecheck: ## Type-check all workspaces
	npm run typecheck

migrate-local: ## Apply D1 migrations to the local dev database
	npx wrangler d1 migrations apply mailbase --local

migrate-remote: ## Apply D1 migrations to your remote D1 database
	npx wrangler d1 migrations apply mailbase --remote -c packages/api/wrangler.jsonc

seed-local: ## Seed a domain/mailbox/addresses into local D1 (DOMAIN=example.com [MAILBOX=josh])
	@test -n "$(DOMAIN)" || { echo "usage: make seed-local DOMAIN=example.com [MAILBOX=josh]"; exit 1; }
	mkdir -p .wrangler && sed -e 's/__DOMAIN__/$(DOMAIN)/g' -e 's/__MAILBOX__/$(MAILBOX)/g' scripts/seed.sql > .wrangler/seed.generated.sql
	npx wrangler d1 execute mailbase --local --file .wrangler/seed.generated.sql

seed-remote: ## Seed a domain/mailbox/addresses into remote D1 (DOMAIN=example.com [MAILBOX=josh])
	@test -n "$(DOMAIN)" || { echo "usage: make seed-remote DOMAIN=example.com [MAILBOX=josh]"; exit 1; }
	mkdir -p .wrangler && sed -e 's/__DOMAIN__/$(DOMAIN)/g' -e 's/__MAILBOX__/$(MAILBOX)/g' scripts/seed.sql > .wrangler/seed.generated.sql
	npx wrangler d1 execute mailbase --remote -c packages/api/wrangler.jsonc --file .wrangler/seed.generated.sql

setup: ## One-time: create the D1 database and R2 bucket (enable R2 in the dashboard first)
	npx wrangler d1 create mailbase
	npx wrangler r2 bucket create mailbase-mail
	@echo ""
	@echo ">> Now paste the database_id printed above into wrangler.jsonc,"
	@echo ">> packages/api/wrangler.jsonc and packages/email-worker/wrangler.jsonc,"
	@echo ">> then run: make migrate-remote && make deploy"

deploy: deploy-email deploy-api deploy-web ## Deploy all three workers

deploy-email: ## Deploy the inbound email worker
	npx wrangler deploy -c packages/email-worker/wrangler.jsonc

deploy-api: ## Deploy the API worker
	npx wrangler deploy -c packages/api/wrangler.jsonc

deploy-web: build ## Build and deploy the web SPA
	npx wrangler deploy -c packages/web/wrangler.jsonc
