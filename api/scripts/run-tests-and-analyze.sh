#!/bin/bash
# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

# Script to run tests and analyze results

set -e

echo "=========================================="
echo "Running TypeScript Type Check"
echo "=========================================="
npx tsc --noEmit || {
  echo "❌ TypeScript errors found"
  exit 1
}
echo "✅ TypeScript type check passed"

echo ""
echo "=========================================="
echo "Running Tests"
echo "=========================================="

# Run tests and capture output
pnpm test 2>&1 | tee test-results.log

# Check exit code
TEST_EXIT_CODE=${PIPESTATUS[0]}

echo ""
echo "=========================================="
echo "Test Analysis"
echo "=========================================="

if [ $TEST_EXIT_CODE -eq 0 ]; then
  echo "✅ All tests passed"
  exit 0
else
  echo "❌ Some tests failed"
  echo ""
  echo "Analyzing failures..."
  
  # Count failures
  FAILURES=$(grep -c "FAIL\|✖\|×" test-results.log || echo "0")
  ERRORS=$(grep -c "ERROR\|Error:" test-results.log || echo "0")
  
  echo "Failures: $FAILURES"
  echo "Errors: $ERRORS"
  
  # Show first 20 failure lines
  echo ""
  echo "First 20 failure lines:"
  grep -A 2 "FAIL\|✖\|×\|Error:" test-results.log | head -20
  
  exit $TEST_EXIT_CODE
fi
