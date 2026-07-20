# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

# Run Authentication Security Matrix tests against a running API server
#
# When the API is reachable (e.g. Docker Compose with port 3000:3000):
#   - T7, T11, T12 run against the live server (no login needed)
# When TEST_USER_EMAIL and TEST_USER_PASSWORD are set (user must exist in running DB):
#   - T3 (revoked JWT), T9 (valid API key), T10 (revoked API key) run full flow
#
# Example with server on localhost:3000 and test user:
#   $env:TEST_API_URL = "http://localhost:3000"
#   $env:TEST_USER_EMAIL = "test@example.com"
#   $env:TEST_USER_PASSWORD = "your-test-password"
#   .\scripts\run-security-tests-against-server.ps1

param(
    [string]$BaseUrl = $env:TEST_API_URL,
    [string]$UserEmail = $env:TEST_USER_EMAIL,
    [string]$UserPassword = $env:TEST_USER_PASSWORD
)

if (-not $BaseUrl) {
    $BaseUrl = "http://localhost:3000"
}

$env:TEST_API_URL = $BaseUrl
$env:TEST_USER_EMAIL = $UserEmail
$env:TEST_USER_PASSWORD = $UserPassword

Write-Host "TEST_API_URL=$BaseUrl"
if ($UserEmail) {
    Write-Host "TEST_USER_EMAIL is set (integration login tests will run)"
} else {
    Write-Host "TEST_USER_EMAIL not set (T3, T9, T10 will skip - set env for full integration)"
}

Write-Host ""
Write-Host "Running security tests (unit + integration when server reachable)..."
pnpm exec vitest run src/tests/security/auth-security-matrix.test.ts --reporter=verbose 2>&1
