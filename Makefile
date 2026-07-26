.PHONY: dev build clean test lint help

# ========================
# Default target
# ========================
help: ## Show this help message
	@echo "ai_blender — Human-in-the-Loop 3D AI Co-pilot"
	@echo ""
	@echo "Usage: make <target>"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

# ========================
# Development
# ========================
dev: ## Start all services via Docker Compose (dev mode)
	docker-compose up --build

dev-web: ## Start only the Next.js frontend (local, no Docker)
	cd apps/web && npm run dev

dev-orchestrator: ## Start only the Go orchestrator (local, no Docker)
	cd apps/orchestrator && go run ./cmd/server

# ========================
# Build
# ========================
build: ## Build all Docker images
	docker-compose build

build-web: ## Build the Next.js frontend
	cd apps/web && npm run build

build-orchestrator: ## Build the Go orchestrator binary
	cd apps/orchestrator && go build -o bin/server ./cmd/server

# ========================
# Testing
# ========================
test: ## Run tests across all services
	cd apps/orchestrator && go test ./...
	cd apps/web && npm test -- --passWithNoTests

# ========================
# Linting
# ========================
lint: ## Lint all services
	cd apps/web && npm run lint
	cd apps/orchestrator && golangci-lint run ./...

# ========================
# Cleanup
# ========================
clean: ## Remove build artifacts and stop containers
	docker-compose down -v --remove-orphans
	cd apps/orchestrator && rm -rf bin/ tmp/
	cd apps/web && rm -rf .next/ out/ node_modules/
