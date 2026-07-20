// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.cwd();
const TARGET_DIR = path.resolve(ROOT, 'api', 'src');
const REPORTS_DIR = path.resolve(ROOT, 'reports');
const EXCLUDE_SEGMENTS = ['/tests/', '/__tests__/', '/generated/', '/migrations/'];
const EXCLUDE_FILE_PATTERNS = [/\.test\.[cm]?[jt]sx?$/i, /\.spec\.[cm]?[jt]sx?$/i];
const PATTERNS = [
  // Functional anti-mock markers only.
  { key: 'fake_runtime_marker', regex: /\bfake_[a-z0-9_]+\b/gi },
  { key: 'probe_not_implemented', regex: /\b[a-z0-9_]+_test_not_implemented\b/gi },
];

function walk(dir, files = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, files);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!fullPath.endsWith('.ts') && !fullPath.endsWith('.tsx') && !fullPath.endsWith('.js')) continue;
    files.push(fullPath);
  }
  return files;
}

function shouldSkip(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  if (EXCLUDE_SEGMENTS.some((segment) => normalized.includes(segment))) return true;
  return EXCLUDE_FILE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function lineNumberForOffset(content, offset) {
  if (offset <= 0) return 1;
  return content.slice(0, offset).split('\n').length;
}

function main() {
  if (!fs.existsSync(TARGET_DIR)) {
    console.log(JSON.stringify({ skipped: true, reason: `Missing directory: ${TARGET_DIR}` }, null, 2));
    return;
  }

  const violations = [];
  const files = walk(TARGET_DIR);
  for (const file of files) {
    if (shouldSkip(file)) continue;
    const content = fs.readFileSync(file, 'utf8');
    for (const pattern of PATTERNS) {
      pattern.regex.lastIndex = 0;
      let match = pattern.regex.exec(content);
      while (match) {
        violations.push({
          file: path.relative(ROOT, file),
          line: lineNumberForOffset(content, match.index),
          pattern: pattern.key,
          match: match[0],
        });
        match = pattern.regex.exec(content);
      }
    }
  }

  fs.mkdirSync(REPORTS_DIR, { recursive: true });

  if (violations.length > 0) {
    const payload = {
      ok: false,
      message: 'Anti-mock gate failed',
      violations,
    };
    fs.writeFileSync(path.join(REPORTS_DIR, 'anti-mock-latest.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    console.error(JSON.stringify(payload, null, 2));
    process.exitCode = 1;
    return;
  }

  const payload = {
    ok: true,
    checkedFiles: files.length,
    message: 'Anti-mock gate passed',
  };
  fs.writeFileSync(path.join(REPORTS_DIR, 'anti-mock-latest.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(payload, null, 2));
}

main();
