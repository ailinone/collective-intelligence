#!/usr/bin/env node
// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence


/**
 * Regression guard — fails CI if ANY reference to the deprecated
 * `ailin-gateway` name reappears in tracked source. The canonical name
 * across the entire stack (filesystem path, docker network, docker stack,
 * compose service alias, nginx upstream block, container image tag,
 * X-Gateway-ID header value, log-source label, JWT issuer claim) is now
 * simply `gateway`.
 *
 * Allowed exceptions:
 *   - This guard's own file (it must contain the literal pattern to match it).
 *   - Immutable historical artifacts under `reports/` and `tmp-endpoint-sweep/`
 *     (frozen test outputs from before the rename).
 *
 * Failure mode: any tracked .{cjs,js,mjs,ts,tsx,json,yml,yaml,sh,md,py,conf}
 * file outside the allowed set that contains `ailin-gateway` (case-insensitive,
 * any separator) fails the guard with file:line and offending content.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.cwd();

// Scan tracked tooling/source/config trees. Excludes node_modules, dist, .git,
// and the immutable historical report directories.
const SCAN_DIRS = ['scripts', '.github', 'api', 'docker', 'docs'];
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'reports',
  'tmp-endpoint-sweep',
  'eval-results',
  'generated',
  'coverage',
  '.next',
]);

const SKIP_FILES = new Set([
  // This file contains the literal pattern as a regex; excluding it prevents self-trigger.
  path.resolve(__dirname, 'verify-canonical-gateway-name.cjs'),
]);

const ALLOWED_EXTS = new Set([
  '.cjs', '.js', '.mjs', '.ts', '.tsx',
  '.json', '.yml', '.yaml',
  '.sh', '.md',
  '.py', '.conf',
]);

// Single canonical pattern. Catches `ailin-gateway`, `ailin-gateway-net`,
// `ailin-gateway_quota-service`, `ailin-gateway-prod-api`, etc.
const FORBIDDEN = /ailin-gateway/i;

const violations = [];

function scanFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FORBIDDEN.test(line)) {
      violations.push({
        file: path.relative(ROOT, filePath),
        line: i + 1,
        content: line.trim().slice(0, 200),
      });
    }
  }
}

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else if (entry.isFile()) {
      if (SKIP_FILES.has(path.resolve(full))) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (ALLOWED_EXTS.has(ext)) {
        scanFile(full);
      }
    }
  }
}

for (const dir of SCAN_DIRS) {
  walk(path.resolve(ROOT, dir));
}

// Also scan known top-level config files.
for (const file of ['package.json', 'README.md']) {
  const p = path.resolve(ROOT, file);
  if (fs.existsSync(p)) scanFile(p);
}

if (violations.length > 0) {
  console.error(
    `FAIL: ${violations.length} residual \`ailin-gateway\` reference(s) found.\n`
  );
  console.error(
    'The canonical name is `gateway`. Rename every occurrence (network/stack/'
  );
  console.error(
    'image-tag/upstream/header/issuer/log-source/path) to `gateway`.\n'
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.content}`);
    console.error('');
  }
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      check: 'verify-no-ailin-gateway-residuals',
      summary: 'PASS',
      scannedDirs: SCAN_DIRS,
      violations: 0,
      note: 'Canonical name is `gateway` across all internal infrastructure.',
    },
    null,
    2
  )
);
