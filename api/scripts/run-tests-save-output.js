// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Run integration tests and write all output to test-output.txt.
 * Usage: node scripts/run-tests-save-output.js
 * Or: pnpm run test:save-output
 *
 * Output is appended to api/test-output.txt (timestamped run header).
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const outputPath = path.join(__dirname, '..', 'test-output.txt');
const timestamp = new Date().toISOString();
const header = `\n${'='.repeat(80)}\nRun at ${timestamp}\n${'='.repeat(80)}\n\n`;

const vitest = spawn(
  'pnpm',
  [
    'exec',
    'vitest',
    'run',
    'tests/integration/all-140-operations.test.ts',
    '--testTimeout=300000',
    '--hookTimeout=180000',
  ],
  {
    cwd: path.join(__dirname, '..'),
    shell: true,
    stdio: ['inherit', 'pipe', 'pipe'],
  }
);

const writeStream = fs.createWriteStream(outputPath, { flags: 'a' });
writeStream.write(header);

vitest.stdout.pipe(process.stdout);
vitest.stdout.pipe(writeStream);
vitest.stderr.pipe(process.stderr);
vitest.stderr.pipe(writeStream);

vitest.on('close', (code) => {
  writeStream.write(`\n[Exit code: ${code}]\n`);
  writeStream.end();
  process.exit(code ?? 0);
});
vitest.on('error', (err) => {
  writeStream.write(`\n[Spawn error: ${err.message}]\n`);
  writeStream.end();
  process.exit(1);
});
