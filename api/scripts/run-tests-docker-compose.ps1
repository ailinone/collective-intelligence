# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

# Run API tests with Docker Compose using real API keys from GCP Secret Manager.
# Project: set via $env:GCP_SECRETS_PROJECT_ID (required).
#
# Prerequisites:
#   - Docker Desktop running
#   - gcloud auth application-default login (so GCP_CREDENTIALS_PATH points to valid JSON)
#
# Usage (from api/):
#   .\scripts\run-tests-docker-compose.ps1
# Or from repo root:
#   cd api ; .\scripts\run-tests-docker-compose.ps1

$ErrorActionPreference = "Stop"

$apiRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path (Join-Path $apiRoot "docker-compose.test.yml"))) {
    $apiRoot = $PSScriptRoot
    while ($apiRoot -and -not (Test-Path (Join-Path $apiRoot "docker-compose.test.yml"))) {
        $apiRoot = Split-Path -Parent $apiRoot
    }
}
if (-not $apiRoot -or -not (Test-Path (Join-Path $apiRoot "docker-compose.test.yml"))) {
    Write-Error "api root not found (docker-compose.test.yml not found). Run from api/ or repo root."
}

$credPath = $env:GCP_CREDENTIALS_PATH
if (-not $credPath) {
    $credPath = Join-Path $env:USERPROFILE ".config\gcloud\application_default_credentials.json"
    $env:GCP_CREDENTIALS_PATH = $credPath
}
if (-not (Test-Path $credPath)) {
    Write-Error "GCP credentials file not found. Tried: $credPath`nRun: gcloud auth application-default login and set GCP_CREDENTIALS_PATH."
}

if (-not $env:GCP_SECRETS_PROJECT_ID) {
    Write-Error "GCP_SECRETS_PROJECT_ID is not set. Set `$env:GCP_SECRETS_PROJECT_ID to your GCP project id."
}
if (-not $env:GCP_PROJECT_ID) {
    $env:GCP_PROJECT_ID = $env:GCP_SECRETS_PROJECT_ID
}

Push-Location $apiRoot
try {
    Write-Host "Running tests with Docker Compose (GCP project: $env:GCP_SECRETS_PROJECT_ID, credentials: $credPath)"
    docker compose -f docker-compose.test.yml --profile test up --build test --abort-on-container-exit
    $exitCode = $LASTEXITCODE
} finally {
    Pop-Location
}
exit $exitCode
