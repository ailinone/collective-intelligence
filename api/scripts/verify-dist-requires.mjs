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
 * Dist require() resolution guard.
 *
 * Context (see PR #539, "fix(build): pin tsc-alias to 1.9.2 — fixes production
 * boot crash-loop"): `tsc-alias` 1.9.2 -> 1.9.4 changed how it rewrites `@/...`
 * path aliases it cannot resolve against the project's own tsconfig
 * `include`/`paths`. `api/src/generated/prisma` (and a few other directories,
 * e.g. `api/src/client`) are excluded from tsconfig `include` — they are
 * populated into `dist/` by a copy step, not compiled from `src` — so every
 * `@/generated/prisma/index.js`-style import used to survive the build
 * untouched (left as a literal `@/...` string) and get resolved correctly at
 * runtime by the `module-alias` registration in `app.cjs`/`worker.cjs`.
 *
 * With 1.9.4, tsc-alias "resolved" that alias anyway — incorrectly. In
 * `database/client.ts` it rewrote the import to `require("../index.js")`,
 * which is the app's OWN entrypoint file (still mid-evaluation), not the
 * Prisma client. That produced a synchronous `TypeError: ... is not a
 * constructor` at module-load time, before `bootstrap()`'s try/catch was ever
 * reached — invisible to the vitest suite (which resolves aliases itself, via
 * tsx/vitest-tsconfig-paths, and never touches the compiled `dist/` output).
 *
 * This script is a static, generic guard against that entire CLASS of bug —
 * any future build-tool bump, tsconfig change, or tsc-alias regression that
 * mis-rewrites a compiled `require()` call. It does not special-case Prisma:
 * it walks every compiled `.js`/`.cjs` file under `dist/` (skipping the
 * vendored `dist/generated/**` tree, which tsc-alias never touches) and for
 * every `require(...)` call asserts one of:
 *
 *   (a) the target is a bare `@/...` alias, left untouched — fine, because
 *       `module-alias` registers a catch-all `'@' -> dist/` alias in
 *       app.cjs/worker.cjs at runtime (verified below by actually parsing
 *       that registration, so this check can't silently rot if the runtime
 *       aliasing ever changes); or
 *   (b) the target is a relative path that tsc-alias rewrote, and it
 *       resolves ON DISK to a real file that is NOT the application
 *       entrypoint (dist/app.cjs, dist/worker.cjs, dist/index.js) — landing
 *       on the entrypoint is exactly the PR #539 signature, since it means
 *       some other module's alias got rewritten relative-to-itself instead
 *       of relative-to-its-true-target.
 *
 * Bare npm specifiers (package names, including scoped packages like
 * `@fastify/cors`) and Node builtins are ignored — pnpm/npm install already
 * covers those, and they never go through the `@/...` alias machinery (our
 * aliases always have the literal form `@/something`, i.e. an `@` directly
 * followed by a slash; a scoped npm package's `@` is always followed by the
 * scope name, never a slash).
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const DIST_DIR = path.resolve(process.argv[2] || path.join(API_ROOT, 'dist'));

if (!existsSync(DIST_DIR)) {
  console.error(`[verify-dist-requires] dist directory not found: ${DIST_DIR}`);
  console.error('Run `pnpm run build` (and copy app.cjs/worker.cjs into dist/) first.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. Discover the runtime alias whitelist by actually parsing app.cjs's own
//    `addAliases({...})` call, instead of hardcoding a duplicate list here
//    that could silently drift out of sync with the real runtime config.
// ---------------------------------------------------------------------------
const APP_CJS = path.join(DIST_DIR, 'app.cjs');
const WORKER_CJS = path.join(DIST_DIR, 'worker.cjs');
const ENTRYPOINT_CANDIDATES = [APP_CJS, WORKER_CJS, path.join(DIST_DIR, 'index.js')]
  .filter(existsSync)
  .map((p) => path.normalize(p));

function extractRegisteredAliasPrefixes(cjsPath) {
  if (!existsSync(cjsPath)) return null;
  const src = readFileSync(cjsPath, 'utf8');
  const callMatch = src.match(/addAliases\(\{([\s\S]*?)\}\)/);
  if (!callMatch) return null;
  const body = callMatch[1];
  const prefixes = new Set();
  const keyRe = /['"](@\/?[^'"]*)['"]\s*:/g;
  let m;
  while ((m = keyRe.exec(body))) {
    prefixes.add(m[1]);
  }
  return prefixes;
}

const registeredPrefixes = extractRegisteredAliasPrefixes(APP_CJS) || extractRegisteredAliasPrefixes(WORKER_CJS);

if (!registeredPrefixes || !registeredPrefixes.has('@')) {
  console.error(
    '[verify-dist-requires] Could not find a bare "@" -> dist/ registration in ' +
      'app.cjs/worker.cjs\'s addAliases({...}) call. Every compiled `@/...` require ' +
      'depends on that catch-all alias to resolve at runtime — refusing to bless any ' +
      '`@/...` require as safe without it.'
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. Walk dist/, skipping the vendored (copied, not tsc-alias-compiled) trees.
// ---------------------------------------------------------------------------
const SKIP_DIR_NAMES = new Set(['generated']); // dist/generated/prisma/** is copied verbatim, not compiled

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name) && path.dirname(dir) === DIST_DIR) {
        // only skip the top-level dist/generated, not an unrelated nested dir
        // that happens to be named "generated" deeper in the tree
        continue;
      }
      if (entry.name === 'generated' && dir === DIST_DIR) continue;
      walk(path.join(dir, entry.name), out);
    } else if (/\.(js|cjs)$/.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const files = walk(DIST_DIR);

// ---------------------------------------------------------------------------
// 3. Scan every require(...) call.
// ---------------------------------------------------------------------------
const REQUIRE_RE = /require\(\s*(['"])((?:(?!\1).)*)\1\s*\)/g;

const failures = [];
let relativeChecked = 0;
let aliasLeftLiteral = 0;
let bareSkipped = 0;

function resolveCandidate(basePath) {
  const candidates = [
    basePath,
    `${basePath}.js`,
    `${basePath}.cjs`,
    `${basePath}.json`,
    path.join(basePath, 'index.js'),
    path.join(basePath, 'index.cjs'),
  ];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // keep trying
    }
  }
  return null;
}

for (const file of files) {
  const content = readFileSync(file, 'utf8');
  const isEntrypointBootstrap = file === APP_CJS || file === WORKER_CJS;
  let match;
  while ((match = REQUIRE_RE.exec(content))) {
    const target = match[2];

    if (target.startsWith('@/')) {
      // Our own path-alias namespace ("@" immediately followed by "/" — a
      // scoped npm package like "@fastify/cors" never has a slash right
      // after the "@"). Left untouched by tsc-alias; module-alias's
      // catch-all '@' -> dist/ registration (verified above) resolves it at
      // runtime, exactly like the known-good pre-1.9.4 compiled output did.
      aliasLeftLiteral++;
      continue;
    }

    if (target.startsWith('./') || target.startsWith('../')) {
      relativeChecked++;
      const resolved = resolveCandidate(path.resolve(path.dirname(file), target));
      if (!resolved) {
        failures.push({
          file,
          target,
          reason: 'unresolved: no file on disk matches this relative require target',
        });
        continue;
      }
      const normalizedResolved = path.normalize(resolved);
      const isEntrypointHit = ENTRYPOINT_CANDIDATES.includes(normalizedResolved);
      if (isEntrypointHit && !isEntrypointBootstrap) {
        failures.push({
          file,
          target,
          reason:
            `resolves to the application entrypoint (${path.relative(DIST_DIR, normalizedResolved)}) — ` +
            'this is the exact PR #539 signature: an alias import rewritten relative-to-the-wrong-file ' +
            'instead of relative-to-its-real-target. A module should never require the app entrypoint ' +
            'it is itself (transitively) loaded from.',
        });
      }
      continue;
    }

    // Bare specifier (npm package, possibly scoped, or a Node builtin) or an
    // absolute path — outside this guard's scope.
    bareSkipped++;
  }
}

console.log(
  `[verify-dist-requires] scanned ${files.length} compiled file(s) under ${path.relative(API_ROOT, DIST_DIR)}: ` +
    `${aliasLeftLiteral} alias require(s) left as literal "@/..." (module-alias resolves these at runtime), ` +
    `${relativeChecked} relative require(s) verified against disk, ${bareSkipped} bare specifier(s) skipped.`
);

if (failures.length > 0) {
  console.error(
    `\n[verify-dist-requires] FAILED — ${failures.length} compiled require() call(s) look broken:\n`
  );
  for (const f of failures) {
    console.error(`  ${path.relative(API_ROOT, f.file)}:`);
    console.error(`    require("${f.target}")`);
    console.error(`    -> ${f.reason}\n`);
  }
  console.error(
    'This is the module-resolution failure class that caused the production boot crash-loop ' +
      'fixed in PR #539 (tsc-alias 1.9.4 mis-rewriting an @/generated/prisma import into ' +
      'require("../index.js")). Fix the build (tsconfig include/exclude, tsc-alias version, or ' +
      'the source import) so every compiled require() either stays a literal "@/..." alias or ' +
      'resolves to its real relative target.'
  );
  process.exit(1);
}

console.log('[verify-dist-requires] PASSED — no broken compiled require() targets found.');
