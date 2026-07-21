# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

# Multi-stage Dockerfile for Ailin Dev API
# Build context is parent directory (..), so paths must be prefixed with api/

# Stage 1: Build (with development dependencies)
FROM node:20-alpine AS builder

ARG APP_VERSION=0.1.0
ARG GIT_COMMIT_SHA=local-dev
ARG BUILD_TIMESTAMP=unknown
ENV APP_VERSION=$APP_VERSION \
    GIT_COMMIT_SHA=$GIT_COMMIT_SHA \
    BUILD_TIMESTAMP=$BUILD_TIMESTAMP

RUN apk add --no-cache python3 py3-pip py3-setuptools make g++ build-base pkgconf openssl git \
    && ln -sf python3 /usr/bin/python \
    && npm install -g pnpm@9

ENV CXXFLAGS="-fexceptions $CXXFLAGS"

WORKDIR /app

# Copy package files (from api/ directory in build context)
COPY api/package.json api/pnpm-lock.yaml ./

# Copy source code (from api/ directory in build context)
COPY api/src ./src
COPY api/prisma ./prisma
COPY api/tsconfig.json ./

# Install dependencies and build (fail on TypeScript errors)
RUN set -e && \
    echo "=== Installing dependencies ===" && \
    pnpm install --no-frozen-lockfile && \
    echo "=== Verifying @prisma/client is installed ===" && \
    if [ ! -d "node_modules/@prisma/client" ]; then \
      echo "ERROR: @prisma/client not found after pnpm install!" && \
      exit 1; \
    fi && \
    echo "=== Generating Prisma Client ===" && \
    pnpm exec prisma generate && \
    echo "=== Running TypeScript compiler ===" && \
    npx tsc 2>&1 | tee /tmp/tsc-output.log || (echo "=== TypeScript compilation failed! ===" && cat /tmp/tsc-output.log && exit 1) && \
    echo "=== Verifying dist directory was created ===" && \
    if [ ! -d dist ]; then \
        echo "ERROR: dist directory was not created after TypeScript compilation!" && \
        echo "TypeScript output:" && \
        cat /tmp/tsc-output.log && \
        echo "Current directory contents:" && \
        ls -la && \
        exit 1; \
    fi && \
    echo "=== Running tsc-alias ===" && \
    npx tsc-alias || (echo "tsc-alias failed!" && exit 1) && \
    echo "=== Copying app.cjs ===" && \
    cp src/app.cjs dist/ && \
    echo "=== Copying non-TS assets (vendored benchmark datasets) ===" && \
    mkdir -p dist/core/experiment/fixtures && \
    cp -r src/core/experiment/fixtures/datasets dist/core/experiment/fixtures/ && \
    echo "=== Setting up Prisma generated files ===" && \
    mkdir -p dist/generated/prisma && \
    (find src/generated/prisma -name "*.js" -exec cp {} dist/generated/prisma/ \; 2>/dev/null || true) && \
    (find src/generated/prisma -name "*.d.ts" -exec cp {} dist/generated/prisma/ \; 2>/dev/null || true) && \
    (cp -r src/generated/prisma/runtime dist/generated/prisma/ 2>/dev/null || true) && \
    (cp -r src/generated/prisma/internal dist/generated/prisma/ 2>/dev/null || true) && \
    (find src/generated/prisma -name "models.*" -exec cp {} dist/generated/prisma/ \; 2>/dev/null || true) && \
    echo "=== Reinstalling production dependencies only ===" && \
    echo "Using pnpm install --prod instead of prune to ensure all transitive deps are included" && \
    rm -rf node_modules && \
    pnpm install --prod --no-frozen-lockfile && \
    echo "=== Verifying @prisma/client-runtime-utils is present ===" && \
    if ! node -e "require.resolve('@prisma/client-runtime-utils')" 2>/dev/null; then \
      echo "ERROR: @prisma/client-runtime-utils cannot be resolved!" && \
      echo "This is now a direct dependency and must be present" && \
      exit 1; \
    fi && \
    echo "✅ @prisma/client-runtime-utils verified" && \
    echo "=== Build completed successfully ===" && \
    echo "Dist directory contents (first 20 items):" && \
    ls -la dist/ | head -20 && \
    echo "Dist directory size:" && \
    du -sh dist/

# Stage 2: Production (minimal runtime)
FROM node:20-alpine AS production

ARG APP_VERSION=0.1.0
ARG GIT_COMMIT_SHA=local-dev
ARG BUILD_TIMESTAMP=unknown
ENV APP_VERSION=$APP_VERSION \
    GIT_COMMIT_SHA=$GIT_COMMIT_SHA \
    BUILD_TIMESTAMP=$BUILD_TIMESTAMP
LABEL org.opencontainers.image.version=$APP_VERSION \
      org.opencontainers.image.revision=$GIT_COMMIT_SHA \
      org.opencontainers.image.created=$BUILD_TIMESTAMP

RUN apk add --no-cache python3 py3-pip py3-setuptools openssl \
    && ln -sf python3 /usr/bin/python \
    && npm install -g pnpm@9

WORKDIR /app

# Copy built application and dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-lock.yaml ./
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/tsconfig.json ./
# Reinstall production dependencies in production stage to ensure pnpm symlinks are correct
# pnpm requires proper symlink structure which may not be preserved when copying node_modules
RUN pnpm install --prod --frozen-lockfile
# Prisma Client files are already copied to dist/generated/prisma in the builder stage
# No need to regenerate as the compiled code in dist/ already references the correct location

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S ailin -u 1001

# Change ownership of app directory to non-root user
RUN chown -R ailin:nodejs /app

USER ailin

EXPOSE 3000

# Use app.cjs that configures module-alias
CMD ["node", "dist/app.cjs"]
