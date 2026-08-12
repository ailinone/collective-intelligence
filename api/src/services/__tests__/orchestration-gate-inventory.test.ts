// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Pin tests for orchestration admission-gate COVERAGE.
 *
 * These are source-text assertions, not behavioural ones, and that is the
 * point. The bug this whole workstream exists to fix was not a broken gate — it
 * was a gate that simply was not called from several routes, silently, for an
 * unknown period, while those routes executed real provider-billed inference. A
 * behavioural test cannot catch a new route being added next quarter with the
 * call omitted. A pin over the source can.
 *
 * WHAT AN EARLIER VERSION OF THIS FILE GOT WRONG — read before editing.
 * It matched execution by `source.includes(primitive)` against case-sensitive
 * substrings anchored on the CALL EXPRESSION, i.e. on the author's choice of
 * variable name. `engine.execute` does not match `orchestrationEngine.execute(`;
 * `pdf-service.ts` calls the engine on every request and scored zero. A
 * brand-new ungated route doing
 * `const orchestrator = getOrchestrationEngine(); await orchestrator.execute(…)`
 * passed the whole file. That is a guard that produces confidence without
 * providing safety, which is worse than no guard.
 *
 * Three things fix it, and each is asserted below:
 *
 *   1. Anchor on the IMPORT token (`getOrchestrationEngine`,
 *      `getCapabilityExecutionService`, …) rather than the call. Every consumer
 *      must contain the import regardless of what it names the local. Plus
 *      case-tolerant regexes for the call forms.
 *   2. Scan beyond `routes/`. The INDIRECT class — a route whose provider call
 *      happens one import away, in a service — was invisible by construction
 *      when only `routes/` was read. Reachability is now computed over the
 *      import graph, so `pdf-routes.ts -> pdf-service.ts -> engine.execute` is
 *      seen.
 *   3. Assert the known-gap lists are EXHAUSTIVE (scan result must EQUAL the
 *      pin), not merely that their members are ungated. The old file asserted
 *      only the latter, so a new gap could never make the list grow.
 *
 * `orchestration-gate-inventory-selftest` at the bottom mutation-tests the
 * matcher itself against synthetic sources, so the scanner cannot silently rot
 * back into a no-op.
 *
 * REMAINING BLIND SPOT, STATED PLAINLY: reachability follows STATIC IMPORTS. A
 * route that hands work to a queue and has the provider call happen in a worker
 * process is not connected by an import edge and will not be found. Those are
 * enumerated by hand in KNOWN_UNGATED_VIA_QUEUE. The worker modules themselves
 * ARE pinned by the non-route scan, so a NEW worker that executes inference
 * still fails this file — it is the route-to-worker association that is manual.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const SRC_DIR = path.resolve(__dirname, '../..');
const ROUTES_DIR = path.join(SRC_DIR, 'routes');

/**
 * Trees outside `routes/` that are scanned for execution primitives.
 *
 * `core/orchestration/**` is deliberately NOT scanned: everything under it (the
 * engine, `base-strategy`, all ~25 strategies, the aggregator, the critique and
 * quality helpers) is reached ONLY through `OrchestrationEngine.execute`, which
 * is itself downstream of every entrypoint this gate protects. A new strategy is
 * not a new door, and pinning 30-odd strategy files would produce constant churn
 * for zero admission-control signal.
 *
 * `core/agentic` IS scanned precisely because it is the exception: the agentic
 * workflow engine calls `adapter.chatCompletion` directly and never goes through
 * `OrchestrationEngine`, so it escapes even the engine-internal accounting.
 */
const SCANNED_NON_ROUTE_DIRS: ReadonlyArray<string> = [
  'services',
  'workers',
  'client',
  'core/agentic',
];

/**
 * Every orchestration entrypoint wired to the shared gate, and the file it
 * lives in. Adding a route here without wiring it fails; wiring a route without
 * listing it fails the exhaustiveness check below.
 *
 * "WIRED" IS NOT "ALWAYS EFFECTIVE". The gate returns allow immediately when
 * `organizationId` is empty, and `/v1/responses` authenticates WITHOUT requiring
 * tenant context (preHandler `authenticateRequest`, no `requireTenantContext`).
 * For an org-less principal on that route the gate is a documented no-op, which
 * also means its shadow-denial rate reads clean regardless of what would have
 * happened. That is a real limit on what this pin proves, and it is stated here
 * rather than left for the next reader to discover.
 *
 * The same limit applies to METERING on that route, for a harder reason: it is a
 * storage constraint rather than a policy choice.
 * `usage_events.organization_id` is `@db.Uuid` with a FK to `organizations`
 * (`schema.prisma:930`, `:938`), so an org-less principal cannot be recorded at
 * all. Making that route fully accountable means giving its principals an
 * organization — an auth change, not a billing one.
 *
 * SCOPE (2026-08-03). This list held five endpoints until #271 deleted
 * `/v1/chat/completions/intelligent` and `/v1/analyze-requirements` (and the
 * `intelligent-model-selection-service` they shared). The three below are the
 * entire surviving set of orchestration entrypoints this gate covers.
 */
const GATED_ENDPOINTS: ReadonlyArray<{ endpoint: string; file: string }> = [
  { endpoint: '/v1/responses', file: 'responses/responses-routes.ts' },
  {
    endpoint: '/v1/chat/completions/extended-thinking',
    file: 'extended-thinking/extended-thinking-routes.ts',
  },
  {
    endpoint: '/v1/chat/completions/ultra-thinking',
    file: 'extended-thinking/extended-thinking-routes.ts',
  },
];

/**
 * EVERY route file that can reach a provider execution primitive — directly, or
 * through a module it imports. This is the real inventory of doors, and it is
 * asserted EXACTLY (scan result must equal this list), so a new one cannot
 * appear without editing this file.
 *
 * `gated` is asserted against the source too, so a route cannot be listed as
 * gated without actually calling the helper, and a currently-ungated route that
 * gains a gate forces its entry to be updated.
 *
 * The `ungated` entries are the honest scope statement for this change: it gates
 * 3 endpoints across 2 files, and the door count is larger than that. They are
 * NOT fixed here — see the PR body for why each is deferred rather than rushed.
 */
const ROUTE_FILES_REACHING_PROVIDERS: ReadonlyArray<{
  file: string;
  gated: boolean;
  note: string;
}> = [
  {
    file: 'chat/chat-routes.ts',
    gated: false,
    note: 'NOT wired to the shared helper, and deliberately so. /v1/chat/completions keeps its own inline quota+governance block (:797-858) and is already enforcing; it is the reference implementation this helper was extracted FROM, not a consumer of it. Its two sibling handlers that did use the helper (/intelligent, /analyze-requirements) were deleted by #271, so this file no longer references the gate at all.',
  },
  {
    file: 'extended-thinking/extended-thinking-routes.ts',
    gated: true,
    note: 'extended-thinking + ultra-thinking. Already metered before this change; gate is purely additive.',
  },
  {
    file: 'responses/responses-routes.ts',
    gated: true,
    note: 'POST /v1/responses. GET/DELETE in the same file are read-only.',
  },
  {
    file: 'audio/audio-routes.ts',
    gated: false,
    note: 'UNGATED. /v1/audio/speech|transcriptions|translations -> audio-orchestration-service -> adapter.textToSpeech/speechToText. Plain authenticate, no metering.',
  },
  {
    file: 'capabilities/capabilities-routes.ts',
    gated: false,
    note: 'UNGATED. Reaches capability-execution-service and all five modality orchestration services.',
  },
  {
    file: 'collective-intelligence/ci-routes.ts',
    gated: false,
    note: 'UNGATED, HIGHEST AMPLIFICATION. /v1/workflows/create|execute -> agentic-workflow-engine calls adapter.chatCompletion once per workflow step, N under caller control, bypassing OrchestrationEngine entirely (so also outside the engine-internal recordQuotaUsage). Computes totalCost, returns it, never bills it.',
  },
  {
    file: 'images/images-routes.ts',
    gated: false,
    note: 'UNGATED. /v1/images/generations|edits|variations -> images-orchestration-service -> adapter.imageGenerate/imageEdit/imageVariation.',
  },
  {
    file: 'moderations/moderations-routes.ts',
    gated: false,
    note: 'UNGATED. /v1/moderations -> moderations-orchestration-service issues ONE provider call PER INPUT via Promise.all, with no cap on input array length.',
  },
  {
    file: 'orchestration/orchestration-routes.ts',
    gated: false,
    note: 'BENIGN. Imports getOrchestrationEngine but only calls engine.getAvailableStrategies() — introspection, no execution. Pinned so the import alone does not read as an unexplained gap.',
  },
  {
    file: 'pdf/pdf-routes.ts',
    gated: false,
    note: 'UNGATED. POST /v1/pdf/analyze -> pdf-service -> engine.execute at max_tokens 4000 inside a candidate retry loop of up to PDF_MAX_CANDIDATES (default 3). Same engine and same alias resolution as the routes this change does gate.',
  },
  {
    file: 'search/search-routes.ts',
    gated: false,
    note: 'UNGATED. /v1/search and /v1/grounding/extract -> search-orchestration-service -> adapter.webSearch AND adapter.chatCompletion — real LLM inference behind an endpoint named "search".',
  },
  {
    file: 'tools/tools-routes.ts',
    gated: false,
    note: 'UNGATED but MITIGATED: the whole plugin scope carries authenticate + requireRole(admin,owner) + a 120-capacity/2-per-second route rate limit. Reaches the same capability-execution-service that capabilities-routes does.',
  },
  {
    file: 'videos/videos-routes.ts',
    gated: false,
    note: 'UNGATED. /v1/videos/generations -> video-orchestration-service -> adapter.videoGenerate. Per-second video billing is the most expensive unit in the catalogue.',
  },
];

/**
 * Modules OUTSIDE `routes/` that invoke an execution primitive. Asserted
 * exactly. This is what makes the indirect class visible at all: a new
 * `xyz-orchestration-service` or a new queue worker that runs inference fails
 * this test until it is listed, whether or not any route imports it yet.
 */
const PINNED_NON_ROUTE_EXECUTION_MODULES: ReadonlyArray<string> = [
  'client/provider-registry.ts',
  'core/agentic/agentic-workflow-engine.ts',
  'services/advanced-tool-execution-service.ts',
  'services/audio-orchestration-service.ts',
  'services/capability-execution-service.ts',
  'services/chat-request-processor.ts',
  'services/images-orchestration-service.ts',
  // Found only once the raw-adapter patterns stopped depending on the receiver
  // being named `adapter`: it issues real `providerAdapter.chatCompletion(…)`
  // and `.chatCompletionStream(…)` probes. No route imports it (only
  // `core/selection/dynamic-model-selector.ts` does), so it adds no route to
  // the inventory above — but it is a genuine provider-billed call site and it
  // was invisible to this file until now.
  'services/model-capability-validator.ts',
  'services/moderations-orchestration-service.ts',
  'services/pdf-service.ts',
  'services/provider-failover-service.ts',
  'services/search-orchestration-service.ts',
  'services/tool-execution-service.ts',
  'services/video-orchestration-service.ts',
  'workers/batch-worker.ts',
  'workers/chat-request-worker.ts',
  'workers/thread-run-worker.ts',
];

/**
 * Routes whose provider call happens across a QUEUE hop, so no import edge
 * connects them and the reachability scan cannot see them. Enumerated by hand;
 * asserted to exist, to still be ungated, and to still be invisible to the scan
 * (if one ever becomes visible, it belongs in the list above instead).
 */
const KNOWN_UNGATED_VIA_QUEUE: ReadonlyArray<{ file: string; note: string }> = [
  {
    file: 'batches/batches-routes.ts',
    note: 'Ungated but METERED: enqueues to batch-worker/chat-request-worker, which run processChatRequest, and that meters at chat-request-processor.ts. The accounting hole does not apply here.',
  },
  {
    file: 'threads/threads-routes.ts',
    note: 'UNGATED AND UNMETERED. POST /v1/threads/:id/runs and /submit_tool_outputs enqueue to thread-run-worker, which calls orchestrationEngine.execute with client-supplied tools attached. Zero hits for trackChatUsage/checkQuota/recordQuotaUsage in that worker.',
  },
  {
    file: 'fine-tuning/fine-tuning-routes.ts',
    note: 'Ungated. Reaches provider fine-tuning APIs through fine-tuning-service, not the orchestration engine; billed by the provider on the job, not per inference.',
  },
];

/**
 * Execution primitives, as REGEXES.
 *
 * Import-token anchors come first — those are the ones a consumer cannot avoid
 * containing. The call-expression forms are deliberately tolerant of the local
 * variable name and of case (`engine.execute`, `orchestrationEngine.execute`,
 * `orchestrator.execute` are all the same call).
 *
 * THE RAW-ADAPTER PATTERNS ARE RECEIVER-NAME TOLERANT TOO, and that was a real
 * hole rather than a hypothetical one. An earlier version required the receiver
 * to be spelled exactly `adapter` (or `…adapter)`), so
 * `const client = getProviderAdapter(…); await client.chatCompletion(…)` walked
 * straight through — the same class of bug as the `engine.execute` vs
 * `orchestrationEngine.execute` miss described above, one layer down. It was
 * also already costing us a live miss: `services/model-capability-validator.ts`
 * issues three real `providerAdapter.chatCompletion(…)` calls plus a
 * `providerAdapter.chatCompletionStream(…)` and scored zero, because
 * `\badapter` does not match the capital `A` in `providerAdapter`.
 *
 * So there are now two raw-adapter forms:
 *   - the CALL form, receiver-name tolerant (`<anything>.chatCompletion(`);
 *   - the original `adapter`-anchored form, which is kept because it also
 *     matches NON-call references — `narrowAs<X>(adapter).moderate` hands the
 *     method around as a value, and the moderations service really does that.
 *
 * The call form excludes `this.` and `super.` receivers deliberately. Those are
 * an adapter implementation delegating to itself (`provider-adapter.ts:423`,
 * `google-adapter.ts:1704`); counting them would match 17 files under
 * `providers/**` that are the adapters, not doors to them, and would drag
 * `embeddings-routes.ts` and `realtime-routes.ts` into the route inventory for
 * merely importing an adapter type.
 *
 * Requiring the `(` on the call form is a separate exclusion, and it is what
 * keeps a plain property read out: `webSearch: request.webSearch`
 * (`semantic-cache.ts:413`) is a capability flag being copied into a cache key,
 * and without the `(` it would have dragged in `ci-dashboard-routes.ts` too.
 *
 * Net effect of both, measured rather than assumed: the route inventory is
 * unchanged at 13 files, and the non-route list grows by exactly one —
 * `model-capability-validator.ts`, which is a real call site.
 *
 * WHAT STILL EVADES IT, stated rather than left to be discovered:
 *   - a NON-call reference whose receiver is not named `adapter`
 *     (`const fn = narrowAs<X>(client).moderate`), and computed access
 *     (`client['chatCompletion'](…)`);
 *   - a class under a scanned dir that EXTENDS a provider adapter and calls
 *     `this.chatCompletion(…)`. That would be an adapter living outside
 *     `providers/**`, which is its own problem.
 * Closing those properly means resolving the receiver's TYPE, which needs a
 * real TS AST pass rather than a regex. The selftest at the bottom pins every
 * shape above — both the ones that must match and the ones that must not — so
 * this cannot quietly regress to the name-dependent version again.
 */
const EXECUTION_PRIMITIVES: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  // ── Import-token anchors (name-independent) ──
  { name: 'getOrchestrationEngine', pattern: /\bgetOrchestrationEngine\b/ },
  { name: 'getCapabilityExecutionService', pattern: /\bgetCapabilityExecutionService\b/ },
  // ── Call expressions, variable-name and case tolerant ──
  { name: '<anything>Engine.execute(', pattern: /[\w$]*[Ee]ngine\s*\.\s*execute\s*\(/ },
  { name: 'orchestrator.execute(', pattern: /\borchestrator\s*\.\s*execute\s*\(/ },
  { name: 'executeStream(', pattern: /\bexecuteStream\s*\(/ },
  { name: 'executeWithIntelligentFallback', pattern: /\bexecuteWithIntelligentFallback\b/ },
  { name: 'executeStreamingWithFallback', pattern: /\bexecuteStreamingWithFallback\b/ },
  { name: 'executeExtendedThinking', pattern: /\bexecuteExtendedThinking\b/ },
  { name: 'executeUltraThinking', pattern: /\bexecuteUltraThinking\b/ },
  { name: 'createStreamingResponse', pattern: /\bcreateStreamingResponse\b/ },
  { name: 'processChatRequest', pattern: /\bprocessChatRequest\b/ },
  { name: 'executeWithCapabilities', pattern: /\bexecuteWithCapabilities\b/ },
  { name: 'executeVisionRequest', pattern: /\bexecuteVisionRequest\b/ },
  { name: 'executeWebSearchRequest', pattern: /\bexecuteWebSearchRequest\b/ },
  // ── Raw provider-adapter calls (the agentic + modality classes) ──
  // Call form: ANY receiver except `this`/`super`. This is the one that catches
  // a renamed local (`client.chatCompletion(…)`). The trailing `(` is required
  // so a property read (`webSearch: request.webSearch`) is not a call site.
  {
    name: '<anything>.<modality>(',
    pattern:
      /[\w$\])](?<!\bthis)(?<!\bsuper)\s*\.\s*(?:chatCompletion|chatCompletionStream|imageGenerate|imageEdit|imageVariation|textToSpeech|speechToText|videoGenerate|webSearch|moderate)\s*\(/,
  },
  // Reference form: `adapter`-anchored, no `(` required, so passing the method
  // around as a value (`narrowAs<X>(adapter).moderate`) still counts.
  {
    name: 'adapter.<modality>',
    pattern:
      /\badapter\)?\s*\.\s*(?:chatCompletion|chatCompletionStream|imageGenerate|imageEdit|imageVariation|textToSpeech|speechToText|videoGenerate|webSearch|moderate)\b/,
  },
];

/**
 * Strip comments before matching. Without this, a doc-comment that merely
 * MENTIONS `engine.execute` (several do — including `orchestration-context.ts`
 * and `ci-metrics.ts`) registers as an execution site, and the pin fills up with
 * files that never call anything. Only block comments and whole-line `//` / `*`
 * lines are removed, so a `//` inside a string literal (a URL) is left alone.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !(trimmed.startsWith('//') || trimmed.startsWith('*'));
    })
    .join('\n');
}

export function matchedExecutionPrimitives(source: string): string[] {
  const code = stripComments(source);
  return EXECUTION_PRIMITIVES.filter(({ pattern }) => pattern.test(code)).map(({ name }) => name);
}

function listSourceFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      out.push(...listSourceFiles(full, rel));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(rel);
    }
  }
  return out;
}

/** Every `.ts` under `api/src`, relative to it, with comments stripped. */
function loadSourceTree(): Map<string, string> {
  const tree = new Map<string, string>();
  for (const rel of listSourceFiles(SRC_DIR)) {
    tree.set(rel, stripComments(readFileSync(path.join(SRC_DIR, rel), 'utf8')));
  }
  return tree;
}

const SOURCES = loadSourceTree();

function readRoute(relPath: string): string {
  return SOURCES.get(`routes/${relPath}`) ?? '';
}

function executes(rel: string): boolean {
  const code = SOURCES.get(rel);
  if (code === undefined) return false;
  return EXECUTION_PRIMITIVES.some(({ pattern }) => pattern.test(code));
}

/** Resolve a `@/…` import specifier to a file in the tree. */
function resolveAlias(specifier: string): string | null {
  if (!specifier.startsWith('@/')) return null;
  const base = specifier.slice(2);
  for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
    if (SOURCES.has(candidate)) return candidate;
  }
  return null;
}

function aliasImportsOf(rel: string): string[] {
  const code = SOURCES.get(rel) ?? '';
  const out = new Set<string>();
  for (const match of code.matchAll(/from\s+'(@\/[^']+)'/g)) {
    const resolved = resolveAlias(match[1]!);
    if (resolved) out.add(resolved);
  }
  return [...out];
}

/** Route files that execute directly, or import a module that does. */
function routeFilesReachingProviders(): string[] {
  return [...SOURCES.keys()]
    .filter((rel) => rel.startsWith('routes/'))
    .filter((rel) => executes(rel) || aliasImportsOf(rel).some((dep) => executes(dep)))
    .map((rel) => rel.slice('routes/'.length))
    .sort();
}

describe('orchestration gate coverage (pin)', () => {
  it.each(GATED_ENDPOINTS)('wires $endpoint to the shared gate in $file', ({ endpoint, file }) => {
    const source = readRoute(file);

    expect(source).toContain('evaluateOrchestrationGate');
    // The endpoint string must be passed as the gate's `endpoint` field —
    // that is the key the per-route enforcement allowlist matches on, so a
    // typo here would silently make the route un-flippable.
    expect(source).toMatch(new RegExp(`endpoint:\\s*'${endpoint.replace(/[/\-]/g, '\\$&')}'`));
  });

  it.each([...new Set(GATED_ENDPOINTS.map((e) => e.file))])(
    'consumes the gate result as a rejection in %s',
    (file) => {
      const source = readRoute(file);
      // The helper never touches `reply` — the route must actually honour a
      // denial, otherwise the enforcement flip would be a no-op. Two accepted
      // shapes: send it on the reply, or hand `{ httpStatus, body }` back to
      // `withIdempotency` (which finalises it and, being non-2xx, does not
      // cache it).
      const sendsOnReply =
        /if\s*\(!\w*[gG]ate\.allowed\)\s*\{\s*\n\s*return reply\s*\n?\s*\.?status\(\w*[gG]ate\.status\)/.test(
          source
        );
      const returnsIdempotentResult =
        /if\s*\(!\w*[gG]ate\.allowed\)\s*\{\s*\n\s*return \{\s*httpStatus:\s*\w*[gG]ate\.status,\s*body:\s*\w*[gG]ate\.body/.test(
          source
        );
      expect(
        sendsOnReply || returnsIdempotentResult,
        `${file} calls the gate but never honours a denial`
      ).toBe(true);
    }
  );

  it('gates every endpoint it claims to gate, and claims every endpoint it gates', () => {
    const declared = new Set(GATED_ENDPOINTS.map((e) => e.endpoint));

    const wired = new Set<string>();
    for (const file of new Set(GATED_ENDPOINTS.map((e) => e.file))) {
      const source = readRoute(file);
      for (const match of source.matchAll(
        /evaluateOrchestrationGate\(\{[\s\S]{0,400}?endpoint:\s*'([^']+)'/g
      )) {
        wired.add(match[1]!);
      }
    }

    expect([...wired].sort()).toEqual([...declared].sort());
  });

  it('pins EVERY route file that can reach a provider, directly or one import away', () => {
    const found = routeFilesReachingProviders();
    const pinned = ROUTE_FILES_REACHING_PROVIDERS.map((e) => e.file).sort();

    // A new route that runs inference — or that imports a service which does —
    // must be either gated (and added to GATED_ENDPOINTS) or consciously listed
    // above with a reason. Silence is not an option: silence is exactly how the
    // original hole opened, and how it stayed open.
    expect(found).toEqual(pinned);
  });

  it('pins the gated/ungated status of each of those route files', () => {
    for (const entry of ROUTE_FILES_REACHING_PROVIDERS) {
      const source = readRoute(entry.file);
      expect(source.length, `${entry.file} not found under routes/`).toBeGreaterThan(0);
      expect(
        source.includes('evaluateOrchestrationGate'),
        entry.gated
          ? `${entry.file} is pinned as gated but does not call evaluateOrchestrationGate`
          : `${entry.file} is now gated — flip its \`gated\` flag and add its endpoints to GATED_ENDPOINTS`
      ).toBe(entry.gated);
    }
  });

  it('pins EVERY execution module outside routes/ (the indirect class)', () => {
    const found: string[] = [];
    for (const dir of SCANNED_NON_ROUTE_DIRS) {
      const abs = path.join(SRC_DIR, dir);
      if (!existsSync(abs)) continue;
      for (const rel of listSourceFiles(abs)) {
        const key = `${dir}/${rel}`;
        if (executes(key)) found.push(key);
      }
    }

    // Asserted EXACTLY, not just "these are ungated". The previous version only
    // checked that the listed files lacked a gate, which meant a NEW indirect
    // entrypoint could never make the list grow — the comment claiming the gap
    // "cannot grow silently" was not true of the code beneath it.
    expect(found.sort()).toEqual([...PINNED_NON_ROUTE_EXECUTION_MODULES].sort());
  });

  it('pins the queue-hop routes the import scan cannot see', () => {
    const visible = new Set(routeFilesReachingProviders());
    for (const entry of KNOWN_UNGATED_VIA_QUEUE) {
      const source = readRoute(entry.file);
      expect(source.length, `${entry.file} not found under routes/`).toBeGreaterThan(0);
      expect(
        source.includes('evaluateOrchestrationGate'),
        `${entry.file} is now gated — move it into ROUTE_FILES_REACHING_PROVIDERS/GATED_ENDPOINTS`
      ).toBe(false);
      expect(
        visible.has(entry.file),
        `${entry.file} is now reachable by import — move it into ROUTE_FILES_REACHING_PROVIDERS`
      ).toBe(false);
    }
  });
});

/**
 * The scanner scanning itself. Every case here is a real shape that the previous
 * substring-based matcher missed; if any of these stops matching, the pin above
 * has silently become decorative again.
 */
describe('orchestration-gate-inventory-selftest', () => {
  it('detects a new ungated route that renames the engine local', () => {
    const synthetic = `
      import { getOrchestrationEngine } from '@/core/orchestration/orchestration-engine';
      server.post('/v1/zztemp/run', async (request, reply) => {
        const orchestrator = getOrchestrationEngine();
        const result = await orchestrator.execute(chatRequest, orgId, userId);
        return reply.send(result);
      });
    `;
    expect(matchedExecutionPrimitives(synthetic)).toContain('getOrchestrationEngine');
  });

  it('detects the capitalised call form the old substring list missed', () => {
    // `pdf-service.ts` literally contains this and scored zero against
    // `engine.execute`, because of the capital E in `…Engine.execute`.
    expect(matchedExecutionPrimitives('await orchestrationEngine.execute(req, org, user);')).toEqual(
      expect.arrayContaining(['<anything>Engine.execute('])
    );
  });

  it('detects raw provider-adapter calls that bypass the engine entirely', () => {
    expect(
      matchedExecutionPrimitives('const r = await result.adapter.chatCompletion({ model });')
    ).toEqual(expect.arrayContaining(['adapter.<modality>']));
    expect(matchedExecutionPrimitives('await adapter.videoGenerate(model, req);')).toEqual(
      expect.arrayContaining(['adapter.<modality>'])
    );
    // `narrowAs<…>(adapter).moderate` — the moderations service's shape. No
    // call parens, so only the reference form can catch it.
    expect(matchedExecutionPrimitives('const moderate = narrowAs<X>(adapter).moderate;')).toEqual(
      expect.arrayContaining(['adapter.<modality>'])
    );
  });

  it('detects a raw provider call whose local is NOT named `adapter`', () => {
    // The evasion the `adapter`-anchored pattern used to wave through. Nothing
    // else in this source is a primitive token, so the call form is the only
    // thing that can catch it.
    const synthetic = `
      import { getProviderAdapter } from '@/providers/provider-registry';
      server.post('/v1/zzprobe/run', async (request, reply) => {
        const client = getProviderAdapter(request.body.provider);
        const result = await client.chatCompletion(request.body);
        return reply.send(result);
      });
    `;
    expect(matchedExecutionPrimitives(synthetic)).toEqual(['<anything>.<modality>(']);

    // The live regression this fix surfaced: `providerAdapter` — capital `A`,
    // so `\badapter` never matched it.
    expect(
      matchedExecutionPrimitives('const response = await providerAdapter.chatCompletion(req);')
    ).toEqual(expect.arrayContaining(['<anything>.<modality>(']));
    expect(executes('services/model-capability-validator.ts')).toBe(true);
  });

  it('does NOT count adapter self-delegation or a plain property read', () => {
    // An adapter implementation calling itself is the adapter, not a door to
    // one. Counting these pins every file under `providers/**`.
    expect(matchedExecutionPrimitives('const r = await this.chatCompletion({ model });')).toEqual(
      []
    );
    expect(matchedExecutionPrimitives('return super.chatCompletion(request);')).toEqual([]);
    // `semantic-cache.ts:413` — a capability flag being copied, not a call.
    expect(matchedExecutionPrimitives('const key = { webSearch: request.webSearch };')).toEqual([]);
    expect(matchedExecutionPrimitives('const cfg = { moderate: true, webSearch: false };')).toEqual(
      []
    );
  });

  it('does NOT count a primitive that only appears in a comment', () => {
    const commentOnly = `
      /**
       * Downstream this becomes engine.execute(chatRequest, orgId, userId).
       */
      // getOrchestrationEngine is not called here.
      export const NOTES = 1;
    `;
    expect(matchedExecutionPrimitives(commentOnly)).toEqual([]);
  });

  it('finds the real files the old matcher missed', () => {
    // Regression anchors on live source, not synthetic strings.
    expect(executes('services/pdf-service.ts')).toBe(true);
    expect(executes('workers/thread-run-worker.ts')).toBe(true);
    expect(executes('core/agentic/agentic-workflow-engine.ts')).toBe(true);
    expect(executes('services/moderations-orchestration-service.ts')).toBe(true);
  });
});
