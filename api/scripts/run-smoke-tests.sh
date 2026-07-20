#!/bin/bash
# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

# Smoke Tests Runner
# Quick validation script for critical paths
# Usage: ./scripts/run-smoke-tests.sh

set -e

echo "🧪 Running Smoke Tests..."
echo "=========================="
echo ""

# Check if we're in the api directory
if [ ! -f "package.json" ]; then
  echo "❌ Error: Please run this script from the api directory"
  exit 1
fi

# Set test environment variables
export TEST_USE_LOCAL_SERVICES=${TEST_USE_LOCAL_SERVICES:-"true"}
export AUTH_DEFAULT_MODE=${AUTH_DEFAULT_MODE:-"password"}
export AUTH_ALLOW_PASSWORD_FALLBACK=${AUTH_ALLOW_PASSWORD_FALLBACK:-"true"}

# Check if DATABASE_URL is set
if [ -z "$DATABASE_URL" ]; then
  echo "⚠️  WARNING: DATABASE_URL not set. Tests may fail."
  echo "   Set DATABASE_URL to your test database connection string"
  echo ""
fi

# Run smoke tests
echo "📋 Test Suite: Smoke Tests (Critical Paths)"
echo "--------------------------------------------"
pnpm test --run tests/smoke

echo ""
echo "✅ Smoke tests completed!"
echo ""
echo "💡 Tip: For full test suite, run 'pnpm test'"
echo "💡 Tip: For coverage report, run 'pnpm test:coverage'"

