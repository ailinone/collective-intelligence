#!/bin/bash
# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence


# Efficient Test Runner Script
# Runs tests in batches to avoid timeouts and provides progress updates

set -e

echo "🚀 Starting Efficient Test Suite Execution"
echo "=========================================="

export TEST_USE_REAL_API_KEYS=true

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Test categories to run
CATEGORIES=(
  "tests/services/auth-service.test.ts"
  "tests/services/model-cache-service.test.ts"
  "tests/services/sharding-service.test.ts"
  "tests/services/context-caching-service.test.ts"
  "tests/routes/user-management-routes.test.ts"
  "tests/routes/organization-routes.test.ts"
  "tests/routes/usage-routes.test.ts"
  "tests/core/learning/auto-learning-system.test.ts"
  "tests/services/code-analysis-service.test.ts"
)

echo -e "${BLUE}Running critical test files...${NC}"

PASSED=0
FAILED=0
SKIPPED=0

for test_file in "${CATEGORIES[@]}"; do
  echo -e "\n${BLUE}Running: ${test_file}${NC}"
  if pnpm test "$test_file" 2>&1 | tee -a test-results.log | tail -20; then
    echo -e "${GREEN}✅ PASSED: ${test_file}${NC}"
    ((PASSED++))
  else
    echo -e "${YELLOW}⚠️  FAILED or TIMEOUT: ${test_file}${NC}"
    ((FAILED++))
  fi
done

echo -e "\n${BLUE}=========================================="
echo -e "Test Summary:${NC}"
echo -e "${GREEN}Passed: ${PASSED}${NC}"
echo -e "${YELLOW}Failed: ${FAILED}${NC}"
echo -e "${BLUE}Skipped: ${SKIPPED}${NC}"
echo -e "=========================================="

if [ $FAILED -eq 0 ]; then
  exit 0
else
  exit 1
fi
