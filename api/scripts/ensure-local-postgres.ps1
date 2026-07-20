# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

# Ensure PostgreSQL (and Redis) are running via docker-compose so tests can use
# DATABASE_URL + TEST_USE_LOCAL_SERVICES=true and avoid Testcontainers timeouts.
#
# Usage (from api/):
#   .\scripts\ensure-local-postgres.ps1
# Or from repo root:
#   cd api ; .\scripts\ensure-local-postgres.ps1

$ErrorActionPreference = "Stop"

$apiRoot = $PSScriptRoot
if (-not (Test-Path (Join-Path $apiRoot "docker-compose.yml"))) {
    $apiRoot = Split-Path -Parent $apiRoot
}
if (-not (Test-Path (Join-Path $apiRoot "docker-compose.yml"))) {
    Write-Error "api root not found (docker-compose.yml not found). Run from api/ or repo root."
}

$postgresPort = 5433
$redisPort = 6379
$containerPostgres = "ailin-dev-postgres"
$containerRedis = "ailin-dev-redis"

function Test-PortOpen {
    param([string]$Host = "localhost", [int]$Port, [int]$TimeoutMs = 2000)
    $tcp = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $tcp.BeginConnect($Host, $Port, $null, $null)
        $wait = $async.AsyncWaitHandle.WaitOne($TimeoutMs, $false)
        if ($wait -and $tcp.Connected) {
            $tcp.Close()
            return $true
        }
    } catch {
        # ignore
    } finally {
        $tcp.Close()
    }
    return $false
}

function Test-PostgresReady {
    $running = docker inspect -f "{{.State.Running}}" $containerPostgres 2>$null
    if ($running -ne "true") { return $false }
    $code = 0
    docker exec $containerPostgres pg_isready -U ailin_dev 2>$null
    $code = $LASTEXITCODE
    return ($code -eq 0)
}

# Check if Postgres is already reachable
if (Test-PortOpen -Port $postgresPort) {
    if (Test-PostgresReady) {
        Write-Host "PostgreSQL is already running (localhost:$postgresPort)."
        Write-Host "Redis: $(if (Test-PortOpen -Port $redisPort) { 'running' } else { 'not checked' })"
        Write-Host ""
        Write-Host "Use in .env.test:"
        Write-Host "  DATABASE_URL=postgresql://ailin_dev:ailin_dev_password@localhost:$postgresPort/ailin_dev"
        Write-Host "  TEST_USE_LOCAL_SERVICES=true"
        Write-Host "  REDIS_HOST=localhost"
        Write-Host "  REDIS_PORT=$redisPort"
        exit 0
    }
}

# Start postgres and redis via docker compose
Write-Host "Starting PostgreSQL and Redis via docker compose..."
Push-Location $apiRoot
try {
    # Ensure network exists (compose may use external: true)
    $netExists = docker network inspect ailin-network 2>$null
    if (-not $netExists) {
        Write-Host "Creating network ailin-network..."
        docker network create ailin-network 2>$null
    }

    docker compose up -d postgres redis
    if ($LASTEXITCODE -ne 0) {
        Write-Error "docker compose up failed. Check Docker and docker-compose.yml."
    }

    Write-Host "Waiting for PostgreSQL to be ready (up to 60s)..."
    $maxWait = 60
    $elapsed = 0
    while ($elapsed -lt $maxWait) {
        Start-Sleep -Seconds 2
        $elapsed += 2
        if (Test-PostgresReady) {
            Write-Host "PostgreSQL is ready."
            break
        }
        Write-Host "  ... ${elapsed}s"
    }
    if (-not (Test-PostgresReady)) {
        Write-Error "PostgreSQL did not become ready within ${maxWait}s. Check: docker logs $containerPostgres"
    }

    Write-Host ""
    Write-Host "Use in .env.test:"
    Write-Host "  DATABASE_URL=postgresql://ailin_dev:ailin_dev_password@localhost:$postgresPort/ailin_dev"
    Write-Host "  TEST_USE_LOCAL_SERVICES=true"
    Write-Host "  REDIS_HOST=localhost"
    Write-Host "  REDIS_PORT=$redisPort"
    Write-Host ""
    Write-Host "Then run: pnpm run test:all-operations  or  pnpm run test:save-output"
} finally {
    Pop-Location
}
