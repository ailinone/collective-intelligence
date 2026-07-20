// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

// ============================================================================
// Google Auth safety net — MUST be installed before any import/require of app
// code that might load @google-cloud/* SDKs. Otherwise, background gRPC stub
// promises from google-gax leak as unhandledRejection OR as uncaughtException
// (when Node 20 with --unhandled-rejections=strict converts them), killing
// the process before our bootstrap() code runs.
//
// Selectivity: ONLY Google Auth errors are suppressed. Every other rejection
// or exception still crashes — this is NOT a blanket catch-all.
// ============================================================================
const __googleAuthErrorSignatures = [
  'Could not load the default credentials',
  'Could not refresh access token',
  'Could not automatically determine credentials',
  'Application Default Credentials',
  'NO_ADC_FOUND',
  'invalid_rapt',
  'invalid_grant',
];
const __isGoogleAuthError = (err) => {
  const msg =
    err && err.message
      ? String(err.message)
      : typeof err === 'string'
        ? err
        : '';
  return __googleAuthErrorSignatures.some((sig) => msg.indexOf(sig) !== -1);
};
const __logDegradedIntercept = (kind, err) => {
  const msg = err && err.message ? err.message : String(err);
  // Use console.warn: pino logger may not be initialized at this stage
  console.warn(
    '[google-auth-safety-net] Intercepted ' + kind + ' from Google Auth: ' +
      msg.split('\n')[0] +
      ' — server continues in degraded mode. ' +
      'Fix: gcloud auth application-default login (local) or WIF (prod).'
  );
};
process.on('unhandledRejection', (reason) => {
  if (__isGoogleAuthError(reason)) {
    __logDegradedIntercept('unhandledRejection', reason);
    return;
  }
  console.error('[unhandledRejection]', reason);
  throw reason;
});
process.on('uncaughtException', (err) => {
  if (__isGoogleAuthError(err)) {
    __logDegradedIntercept('uncaughtException', err);
    return;
  }
  console.error('[uncaughtException]', err);
  throw err;
});

// Configure module-alias BEFORE any requires
require('module-alias/register');
const path = require('path');
const { addAliases } = require('module-alias');

// Get the directory where this file is located (dist/)
const distDir = __dirname;

// Configure path aliases - all paths are relative to dist/
addAliases({
  '@': distDir,
  '@/cache': path.join(distDir, 'cache'),
  '@/config': path.join(distDir, 'config'),
  '@/core': path.join(distDir, 'core'),
  '@/database': path.join(distDir, 'database'),
  '@/providers': path.join(distDir, 'providers'),
  '@/services': path.join(distDir, 'services'),
  '@/types': path.join(distDir, 'types'),
  '@/utils': path.join(distDir, 'utils'),
  '@/queue': path.join(distDir, 'queue'),
  '@/routes': path.join(distDir, 'routes'),
  '@/api': path.join(distDir, 'api'),
  '@/observability': path.join(distDir, 'observability'),
  '@/client': path.join(distDir, 'client'),
  '@/di': path.join(distDir, 'di'),
  '@/infrastructure': path.join(distDir, 'infrastructure'),
  '@/jobs': path.join(distDir, 'jobs'),
  '@/workers': path.join(distDir, 'workers')
});

// Now require the main application
require('./index.js');
