# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

# Makefile for Ailin Dev API

.PHONY: help install dev build start test lint format clean docker-up docker-down docker-logs docker-clean db-migrate db-migrate-prod db-seed db-reset db-studio db-create-test db-migrate-test setup setup-check

# Default target
.DEFAULT_GOAL := help

# Colors for output
BLUE := \033[0;34m
GREEN := \033[0;32m
YELLOW := \033[0;33m
NC := \033[0m # No Color

## help: Show this help message
help:
	@echo "$(BLUE)Ailin Dev API - Available Commands$(NC)"
	@echo ""
	@sed -n 's/^##//p' ${MAKEFILE_LIST} | column -t -s ':' | sed -e 's/^/  /'

## install: Install dependencies
install:
	@echo "$(GREEN)Installing dependencies...$(NC)"
	pnpm install

## dev: Start development server
dev:
	@echo "$(GREEN)Starting development server...$(NC)"
	pnpm run dev

## build: Build for production
build:
	@echo "$(GREEN)Building application...$(NC)"
	pnpm run build

## start: Start production server
start: build
	@echo "$(GREEN)Starting production server...$(NC)"
	pnpm run start:prod

## test: Run tests
test:
	@echo "$(GREEN)Running tests...$(NC)"
	pnpm run test

## test-coverage: Run tests with coverage
test-coverage:
	@echo "$(GREEN)Running tests with coverage...$(NC)"
	pnpm run test:coverage

## test-integration: Run integration tests
test-integration:
	@echo "$(GREEN)Running integration tests...$(NC)"
	pnpm run test:integration

## lint: Run linter
lint:
	@echo "$(GREEN)Running linter...$(NC)"
	pnpm run lint

## lint-fix: Run linter with auto-fix
lint-fix:
	@echo "$(GREEN)Running linter with auto-fix...$(NC)"
	pnpm run lint:fix

## format: Format code
format:
	@echo "$(GREEN)Formatting code...$(NC)"
	pnpm run format

## typecheck: Run TypeScript type checking
typecheck:
	@echo "$(GREEN)Running type check...$(NC)"
	pnpm run typecheck

## clean: Clean build artifacts
clean:
	@echo "$(YELLOW)Cleaning build artifacts...$(NC)"
	rm -rf dist
	rm -rf coverage
	rm -rf .turbo
	rm -rf node_modules/.cache

## docker-up: Start Docker services
docker-up:
	@echo "$(GREEN)Starting Docker services...$(NC)"
	docker-compose up -d
	@echo "$(GREEN)Waiting for services to be ready...$(NC)"
	@sleep 5
	@echo "$(GREEN)Services started!$(NC)"
	@echo "$(BLUE)PostgreSQL:$(NC) localhost:5432"
	@echo "$(BLUE)Redis:$(NC) localhost:6379"
	@echo "$(BLUE)Jaeger UI:$(NC) http://localhost:16686"
	@echo "$(BLUE)Prometheus:$(NC) http://localhost:9090"
	@echo "$(BLUE)Grafana:$(NC) http://localhost:3001 (admin/ailin_dev)"

## docker-down: Stop Docker services
docker-down:
	@echo "$(YELLOW)Stopping Docker services...$(NC)"
	docker-compose down

## docker-logs: Show Docker logs
docker-logs:
	docker-compose logs -f

## docker-clean: Stop and remove Docker volumes
docker-clean:
	@echo "$(YELLOW)Stopping and cleaning Docker services...$(NC)"
	docker-compose down -v

## db-create-test: Ensure the test database exists inside the PostgreSQL container
db-create-test:
	@echo "$(GREEN)Ensuring test database (ailin_dev_test) exists...$(NC)"
	@if ! docker-compose ps postgres >/dev/null 2>&1; then \
		echo "$(YELLOW)Postgres container is not running. Use 'make docker-up' first.$(NC)"; \
		exit 1; \
	fi
	@docker-compose exec -T postgres psql -U ailin_dev -d postgres -tc "SELECT 1 FROM pg_database WHERE datname = 'ailin_dev_test';" | grep -q 1 \
		&& echo "$(BLUE)Test database already present.$(NC)" \
		|| (echo "$(GREEN)Creating test database ailin_dev_test...$(NC)" && docker-compose exec -T postgres psql -U ailin_dev -d postgres -c "CREATE DATABASE ailin_dev_test WITH OWNER = ailin_dev ENCODING 'UTF8';")

## db-migrate-test: Run Prisma migrations against the test database
db-migrate-test: db-create-test
	@echo "$(GREEN)Applying migrations to test database...$(NC)"
	@DATABASE_URL="postgresql://ailin_dev:ailin_dev_password@host.docker.internal:55432/ailin_dev_test" pnpm prisma migrate deploy

## db-migrate: Run database migrations
db-migrate:
	@echo "$(GREEN)Running database migrations...$(NC)"
	pnpm prisma migrate dev

## db-migrate-prod: Run database migrations (production)
db-migrate-prod:
	@echo "$(GREEN)Running database migrations (production)...$(NC)"
	pnpm prisma migrate deploy

## db-seed: Seed database
db-seed:
	@echo "$(GREEN)Seeding database...$(NC)"
	pnpm run db:seed

## db-reset: Reset database
db-reset:
	@echo "$(YELLOW)Resetting database...$(NC)"
	pnpm run db:reset

## db-studio: Open Prisma Studio
db-studio:
	@echo "$(GREEN)Opening Prisma Studio...$(NC)"
	pnpm prisma studio

## setup: Complete setup (install + docker + migrate + seed)
setup: install docker-up
	@sleep 10
	@echo "$(GREEN)Running database migrations...$(NC)"
	@pnpm prisma migrate dev --name init
	@echo "$(GREEN)Setup complete!$(NC)"
	@echo "$(BLUE)Run 'make dev' to start the development server$(NC)"

## setup-check: Check if setup is complete
setup-check:
	@echo "$(BLUE)Checking setup...$(NC)"
	@command -v node >/dev/null 2>&1 || { echo "$(YELLOW)Node.js is not installed$(NC)"; exit 1; }
	@echo "$(GREEN)✓$(NC) Node.js installed"
	@command -v pnpm >/dev/null 2>&1 || { echo "$(YELLOW)pnpm is not installed$(NC)"; exit 1; }
	@echo "$(GREEN)✓$(NC) pnpm installed"
	@command -v docker >/dev/null 2>&1 || { echo "$(YELLOW)Docker is not installed$(NC)"; exit 1; }
	@echo "$(GREEN)✓$(NC) Docker installed"
	@test -f .env || { echo "$(YELLOW).env file not found$(NC)"; exit 1; }
	@echo "$(GREEN)✓$(NC) .env file exists"
	@echo "$(GREEN)Setup check passed!$(NC)"

