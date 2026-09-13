// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

// Node ESM "resolve" customization hook (see `module.register()`, Node 20.6+)
// that teaches Node's module resolver about this project's `@/` -> `src/`
// path alias, AND about extension-less relative imports (`./schema`,
// `../types`) — DEV/TEST ONLY. See `dev-alias-resolver-preload.mjs` (the
// file actually passed to `--import`, which registers THIS file as its hook
// target) and `manager.ts`'s `resolveWorkerExecArgv()` for why this exists
// and why it is deliberately excluded from the production build.
//
// ── Why this exists at all (a real bug this PR's own testing caught) ──────
// `tsx` resolves both this project's `tsconfig.json` `paths` mapping AND
// plain extension-less relative imports for its OWN entry file (confirmed
// empirically: `tsx src/index.ts` resolves both fine) — but NEITHER
// resolution propagates into a `worker_threads` Worker spawned from that
// process, even when the worker's own `execArgv` re-imports `tsx` itself
// (confirmed empirically for the `@/` case: both a bare `new Worker(path)`
// AND `new Worker(path, { execArgv: ['--import', 'tsx'] })` fail with
// `ERR_MODULE_NOT_FOUND` — see this PR's description for the full
// investigation). Once the `@/` case was fixed with an earlier version of
// this hook, the SAME worker then failed on its own plain
// `import { computeLayout } from './schema'` line for the identical
// underlying reason: real Node ESM resolution (unlike CommonJS, and unlike
// tsx's own resolution) requires an explicit file extension and does not
// guess `.ts` for you. Every module `worker.ts` imports — its own sibling
// files (`./schema`, `./encode`, `./reader`, `./types`) AND anything
// `@/`-aliased that itself uses `@/` or extension-less relative imports
// internally (most of this codebase) — would otherwise fail to load in ANY
// execution mode that isn't the fully compiled production build
// (`tsc-alias` rewrites every import to an explicit, extensioned relative
// path at build time, so `dist/**/worker.js` never hits this code path —
// see `manager.ts`).
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

const srcRoot = pathToFileURL(path.join(import.meta.dirname, '..', '..', '..') + path.sep).href;

function isRealFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function resolveExtensionCandidate(absPath) {
  // A bare `existsSync` check is not enough: `@/config` resolves to the real
  // DIRECTORY `src/config/`, which "exists" but is not a loadable ES module
  // on its own (real Node ESM, unlike CommonJS/tsx, does not auto-resolve a
  // directory import to its `index.ts`) — must check it is a FILE before
  // accepting it as-is.
  if (isRealFile(absPath)) return absPath;
  for (const ext of ['.ts', '.tsx', '.js']) {
    if (isRealFile(absPath + ext)) return absPath + ext;
  }
  const indexCandidate = path.join(absPath, 'index.ts');
  if (isRealFile(indexCandidate)) return indexCandidate;
  const indexJsCandidate = path.join(absPath, 'index.js');
  if (isRealFile(indexJsCandidate)) return indexJsCandidate;
  return null;
}

/** Rewrites a resolved (absolute-URL) target to an extensioned candidate
 *  when it doesn't already have one — shared by both the `@/`-alias branch
 *  and the plain-relative-import branch below, since both need identical
 *  "guess the real file" behavior once the specifier is turned into an
 *  absolute URL. */
function withExtensionCandidate(url) {
  const hasExt = path.extname(url.pathname) !== '';
  if (hasExt) return url;
  const candidate = resolveExtensionCandidate(fileURLToPath(url));
  return candidate ? pathToFileURL(candidate) : url;
}

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    const rewritten = withExtensionCandidate(new URL(specifier.slice(2), srcRoot));
    return nextResolve(rewritten.href, context);
  }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL) {
    const rewritten = withExtensionCandidate(new URL(specifier, context.parentURL));
    return nextResolve(rewritten.href, context);
  }
  return nextResolve(specifier, context);
}
