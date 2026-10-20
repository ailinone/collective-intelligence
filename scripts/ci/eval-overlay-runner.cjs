// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

'use strict';
// Runs INSIDE the throwaway ci-api container started by run-eval-in-overlay.sh
// (`node -e "$(cat this-file)"`, stdin = "<token>\n<base64 gzip of the eval script>\n").
//
// It drops the eval script under $EVAL_WORKDIR/api/tests/evals/ (so the script's own
// ROOT = ../.. resolves to a writable <workdir>/api), puts the token into process.env
// only here (never in argv or in the container env), imports the script and, when the
// process exits for any reason, prints every file the script wrote to eval-results/ as
// one "@@EVAL_RESULTS@@<name>@@<base64>" line, which the caller turns back into files.
// The container is read-only apart from a small /tmp tmpfs, so nothing else persists.
//
// Environment (not secret): EVAL_SCRIPT_NAME (<name>.mjs), EVAL_ARGS (space-separated
// flags), EVAL_API_BASE_URL (read by the eval script), EVAL_SOFT_TIMEOUT_S (see below),
// EVAL_WORKDIR (tests only).
//
// Soft deadline: the caller's hard timeout kills the container from outside, and a kill
// loses everything the benchmark had gathered. EVAL_SOFT_TIMEOUT_S makes this process end
// itself (exit 124) a little before that, so the exit hook still returns whatever
// eval-results/ holds.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { pathToFileURL } = require('node:url');

const WORK = process.env.EVAL_WORKDIR || '/tmp/evals';
const MARK = '@@EVAL_RESULTS@@';
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const SAFE_FILE = /^[A-Za-z0-9._-]+$/;

function writeAll(fd, text) {
  const buf = Buffer.from(text, 'utf8');
  let off = 0;
  while (off < buf.length) {
    try {
      off += fs.writeSync(fd, buf, off, buf.length - off);
    } catch (err) {
      // A pipe that is momentarily full: retry (the payload is small).
      if (err.code !== 'EAGAIN') throw err;
    }
  }
}

function emitResults(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names.sort()) {
    if (!SAFE_FILE.test(name)) continue;
    const file = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (st.size > MAX_FILE_BYTES) {
      writeAll(2, `eval-overlay-runner: ${name} is ${st.size} bytes, over the ${MAX_FILE_BYTES} byte limit; not returned\n`);
      continue;
    }
    // Leading newline: the marker must start a line even if the script's last
    // console output did not end with one.
    writeAll(1, `\n${MARK}${name}@@${fs.readFileSync(file).toString('base64')}\n`);
  }
}

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const raw = Buffer.concat(chunks).toString('utf8');
  const nl = raw.indexOf('\n');
  const token = (nl < 0 ? raw : raw.slice(0, nl)).replace(/\r/g, '');
  const payload = nl < 0 ? '' : raw.slice(nl + 1).trim();
  const name = process.env.EVAL_SCRIPT_NAME || '';
  if (!token || !payload || !/^[A-Za-z0-9._-]+\.mjs$/.test(name)) {
    console.error('eval-overlay-runner: expected "<token>\\n<base64 gzip script>" on stdin and EVAL_SCRIPT_NAME=<name>.mjs');
    process.exit(2);
  }

  const root = path.join(WORK, 'api');
  const dir = path.join(root, 'tests', 'evals');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, zlib.gunzipSync(Buffer.from(payload, 'base64')));

  process.env.EVAL_BEARER_TOKEN = token;
  const args = (process.env.EVAL_ARGS || '').split(' ').filter(Boolean);
  delete process.env.EVAL_ARGS;
  delete process.env.EVAL_SCRIPT_NAME;
  process.argv = [process.argv[0], file, ...args];

  process.on('exit', () => emitResults(path.join(root, 'eval-results')));
  const soft = Number(process.env.EVAL_SOFT_TIMEOUT_S || 0);
  if (soft > 0) {
    // unref: the timer must not keep the process alive once the benchmark has finished.
    setTimeout(() => {
      console.error(`eval-overlay-runner: soft deadline of ${soft}s reached, stopping ${name}`);
      process.exit(124);
    }, soft * 1000).unref();
  }
  delete process.env.EVAL_SOFT_TIMEOUT_S;
  import(pathToFileURL(file).href).catch((err) => {
    console.error(`eval-overlay-runner: ${name} failed: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
});
