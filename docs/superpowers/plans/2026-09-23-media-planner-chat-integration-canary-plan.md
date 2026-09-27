<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# MediaPlanner — Chat/Triage Pipeline Integration + Canary Rollout (Section E) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `MediaPlannerStrategy` a canary-gated safety net inside the normal chat/triage pipeline (`orchestration-engine.ts`), so a request that never hits the dedicated `/v1/capabilities/media-plan/execute` route can still be routed into the planner instead of silently degrading to prose chat — without ever adding gate-evaluation cost to the common non-media chat path, and without any percentage-rollout mechanism (org-allowlist canary only, per the design's explicit rejection of blanket/percentage flips).

**Architecture:** A new sibling `Organization.settings.mediaPlannerConfig` JSON key (parallel to the existing `settings.collectiveConfig`, never merged into `CoordinationConfig`) resolved by a new `getMediaPlannerConfigForOrg()` in `collective-feature-flags.ts`, combined with the existing `MEDIA_PLANNER_ENABLED` env flag via a new `resolveEffectiveMediaPlannerEnabled()` in `media-planner-gate.ts`. `orchestration-engine.ts` calls this effective gate at exactly one point — after triage has fully resolved (LLM success or heuristic fallback) — and only when the resolved plan already touches a media-generation capability or triage fell back to heuristics. When the gate routes, a lazily-constructed `MediaPlannerStrategy` (wired with only the video/image `MediaConsensusStrategy` — the only generation surface the gate can ever trigger on) executes and its result is returned directly. When triage fell back to heuristics on a request that independently still looks media-shaped (by the gate's own, separate keyword scan) but no media capability could be confidently resolved, a structured `[DEGRADED]` response is returned instead of silently finishing as chat.

**Tech Stack:** TypeScript, Vitest, Prisma (`Organization.settings` JSON column, no migration).

---

## Investigation findings (done as part of writing this plan, not deferred to execution)

Every file:line citation below was re-verified against the current worktree. Two corrections to the spec, both reflected in the tasks below:

1. **`triage-service.ts`'s real path** is `api/src/core/orchestration/triage-service.ts`, not `api/src/services/triage-service.ts` (the path named in this plan's brief). Confirmed: `runHeuristics()` is a private method at line 1717, and it already sets `source: 'heuristic'` explicitly on the returned `TriageDecision` (line 1894) — this field (`TriageDecision.source?: 'llm' | 'heuristic'`, defined in `api/src/types/index.ts:1610`, doc comment: *"'heuristic' when this decision came from the non-LLM heuristic fallback... Additive field; absence means the decision predates this field, not that it's LLM"*) is the exact, already-existing signal this plan uses to detect "the heuristic fallback path fired at all" — no new detection logic needs to be invented. `runHeuristics()` also already preserves `requiredCapabilities` from `context.capabilityInference` (lines 1807-1809) and builds a dedicated media-generation stage when a media capability is detected (lines 1835-1848) — confirming the audit's claim that this part is already fixed.

2. **The design spec's own "Production rollout" step 2** reads "You (the user) name specific org(s) to enable via the `collectiveConfig` override" — this is a leftover reference to the *pre-fix* design (before the canary was moved to its own sibling `mediaPlannerConfig` key, per section E's design paragraph 1, which is explicit that this must NOT be merged into `CoordinationConfig`/`collectiveConfig`). This plan follows the corrected, sibling-key mechanism throughout; the rollout **process** (ship → name orgs → monitor `WorkflowExecution` → manual global flip) is otherwise followed exactly as written, only substituting "the `mediaPlannerConfig` override" for the stale "`collectiveConfig` override" wording. See the final note at the bottom of this document.

Other citations confirmed exact, no correction needed:
- `api/src/core/coordination/collective-feature-flags.ts`: `getCollectiveConfigForOrg` (line 265), TTL-cache section (lines 52-86: `CacheEntry`, `CACHE_TTL_MS`/`CACHE_MAX_ENTRIES`, `cache` map, `evictIfNeeded` at 69-78, `clearCollectiveConfigCache` at 84), `readOrgCollectiveSettings` (line 225).
- `api/prisma/schema.prisma:31`: `Organization.settings Json @default("{}")`.
- `api/src/services/org-governance-service.ts`: dedicated-namespace-key precedent (`GOVERNANCE_SETTINGS_KEY = 'governance'`, line 30; `mergeGovernance()` merges only its own sub-key without clobbering siblings, lines 183-211) — this plan's `getMediaPlannerConfigForOrg` follows the read-side half of this precedent (write-side admin route is out of scope for this plan; the canary is set by direct DB/ops action per the "Production rollout" note, matching how `collectiveConfig` overrides are set today).
- `api/src/core/orchestration/orchestration-engine.ts`: zero references to `MediaPlannerStrategy`/`resolveMediaPlanRouting`/`evaluateMediaPlannerGate` today (confirmed via repo-wide grep — the only non-test call site anywhere is `capabilities-routes.ts:2220`). The triage-resolution block runs from line ~1518 (`buildContext`) through line 1700 (closing the `shouldRunTriage` if/else); the existing "Multi-stage execution" block starts immediately after, at line 1702 (`try {`) — this is the exact seam this plan inserts into.
- `api/src/core/orchestration/strategies/media-planner-gate.ts`: `evaluateMediaPlannerGate` (line 118), `resolveMediaPlanRouting` (line 187, synchronous, takes a plain `enabled: boolean`), `MEDIA_PLANNER_ENABLED` global check inside `resolveMediaPlanRouting` (checked first, short-circuits before any text scanning per its own doc comment, lines 175-201).
- `api/src/config/index.ts:1110-1114`: `mediaPlanner: { enabled: getEnvBoolean('MEDIA_PLANNER_ENABLED', false), maxTurns, costCeilingMultiplier }`.
- `api/src/routes/capabilities/capabilities-routes.ts:2220`: the only existing call site, `resolveMediaPlanRouting(chatRequest, orchestrationContext, config.mediaPlanner.enabled)` — passes the global flag directly, with no canary awareness today. This plan updates it to resolve the effective (global-or-canary) flag first.

**Additional architectural finding not called out in the spec, resolved by design choice below:** `MediaPlannerStrategy`'s `capabilityDispatcher` dependency (used for non-generation `capability_call` actions) is documented in `media-planner-strategy.ts:78-83` as deliberately bound to a live `FastifyRequest` by the HTTP route layer via closure ("this strategy never sees any of those"). `OrchestrationEngine.execute(request: ChatRequest, organizationId: string, userId?: string)` (line 1269) has no `FastifyRequest` at all, and threading one in would be a much larger, riskier change to the engine's public signature — explicitly the kind of scope creep the spec's "Out of scope" section warns against. Resolution: this plan wires `MediaPlannerStrategy` with **only** `mediaConsensusExecutor` (a `MediaConsensusStrategy` built from `VideoOrchestrationService`/`ImagesOrchestrationService` — both plain no-arg-constructible services, confirmed via their constructors, with no `FastifyRequest` coupling), leaving `capabilityDispatcher` unset. This is safe and complete for this integration's actual scope: `evaluateMediaPlannerGate` only ever returns `route: true` when a `video_generation`/`image_generation` capability is involved (`media-planner-gate.ts:137-138`), i.e. the only action kind this safety-net path can ever need is `generate`, not `capability_call`. A `capability_call` action the planner emits anyway degrades to a documented, tested "capability dispatcher not wired" unmet-constraint entry (`media-planner-strategy.ts:381-395`) rather than throwing — identical fallback behavior to what the dedicated route itself would hit for the same missing dependency, so this introduces no new gap.

---

### Task 1: Factor out a generic TTL-cache eviction helper in `collective-feature-flags.ts`

**Files:**
- Modify: `api/src/core/coordination/collective-feature-flags.ts:69-78`
- Test: `api/src/core/coordination/__tests__/collective-feature-flags.test.ts`

**Reasoning (requested by the brief):** Task 2 needs a second, independent TTL cache (a different value type — `boolean`, not `CoordinationConfig`). Duplicating the whole `CacheEntry`/`cache`/`evictIfNeeded()` trio would be true copy-paste; the actual eviction *loop* (`Map` insertion-order approximate-LRU) has zero dependency on the cached value's type, so making it generic is a small, behavior-preserving refactor (the existing `evictIfNeeded()` keeps its exact signature and behavior, just delegates). This is the "factor out the shared helper" option — not a bigger unification of the two caches' schemas/TTLs, which would be over-engineering for two call sites with genuinely different settings shapes (`CoordinationConfig` overrides vs. a single `boolean`).

- [ ] **Step 1: Write the failing test for the generic helper**

Add to `api/src/core/coordination/__tests__/collective-feature-flags.test.ts` (new `describe` block; the file already imports `describe, it, expect` from `vitest` at the top):

```typescript
import { evictOldestIfOverCap } from '../collective-feature-flags';

describe('evictOldestIfOverCap', () => {
  it('does nothing when the map is at or under the cap', () => {
    const map = new Map([['a', 1], ['b', 2]]);
    evictOldestIfOverCap(map, 2);
    expect(map.size).toBe(2);
  });

  it('evicts the oldest (insertion-order-first) entries down to the cap', () => {
    const map = new Map([['a', 1], ['b', 2], ['c', 3], ['d', 4]]);
    evictOldestIfOverCap(map, 2);
    expect(map.size).toBe(2);
    expect(map.has('a')).toBe(false);
    expect(map.has('b')).toBe(false);
    expect(map.has('c')).toBe(true);
    expect(map.has('d')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && npx vitest run src/core/coordination/__tests__/collective-feature-flags.test.ts -t evictOldestIfOverCap`
Expected: FAIL — `evictOldestIfOverCap` is not exported (does not exist yet).

- [ ] **Step 3: Implement — extract and export the generic helper**

In `api/src/core/coordination/collective-feature-flags.ts`, replace lines 69-78:

```typescript
function evictIfNeeded(): void {
  if (cache.size <= CACHE_MAX_ENTRIES) return;
  const overflow = cache.size - CACHE_MAX_ENTRIES;
  let evicted = 0;
  for (const key of cache.keys()) {
    cache.delete(key);
    evicted++;
    if (evicted >= overflow) break;
  }
}
```

with:

```typescript
/**
 * Evict the oldest entries from ANY Map-shaped TTL cache once it exceeds
 * `maxEntries`. Map's insertion-order iteration gives a cheap
 * approximate-LRU without a dedicated LRU dependency. Generic so the
 * MediaPlanner canary cache (Section E) can reuse this loop instead of
 * duplicating it for a differently-shaped cache value.
 */
export function evictOldestIfOverCap<T>(map: Map<string, T>, maxEntries: number): void {
  if (map.size <= maxEntries) return;
  const overflow = map.size - maxEntries;
  let evicted = 0;
  for (const key of map.keys()) {
    map.delete(key);
    evicted++;
    if (evicted >= overflow) break;
  }
}

function evictIfNeeded(): void {
  evictOldestIfOverCap(cache, CACHE_MAX_ENTRIES);
}
```

- [ ] **Step 4: Run the test to verify it passes, and the existing suite still passes**

Run: `cd api && npx vitest run src/core/coordination/__tests__/collective-feature-flags.test.ts`
Expected: PASS (all tests, including the pre-existing `parseOrganizationCollectiveSettings`/`mergeOrgSettingsIntoConfig` suites — this refactor changes no observable behavior of `evictIfNeeded`).

- [ ] **Step 5: Commit**

```bash
git add api/src/core/coordination/collective-feature-flags.ts api/src/core/coordination/__tests__/collective-feature-flags.test.ts
git commit -m "refactor(collective-feature-flags): extract generic TTL-cache eviction helper"
```

---

### Task 2: Add `getMediaPlannerConfigForOrg()` — the sibling canary resolver

**Files:**
- Modify: `api/src/core/coordination/collective-feature-flags.ts` (append at end of file, after line 287)
- Test: `api/src/core/coordination/__tests__/collective-feature-flags.test.ts`

**Design note:** Per the design spec's explicit instruction, this lives in the *same file* as `getCollectiveConfigForOrg` (not a new sibling file) — the two share the exact TTL/DB-failure-safe-fallback posture and file size (288 lines today) doesn't yet justify a split. It reads a **sibling** top-level key, `Organization.settings.mediaPlannerConfig`, never merged into `CoordinationConfig`. Only `parseOrgMediaPlannerSettings` (pure) gets a direct unit test here, matching this file's own existing convention: `getCollectiveConfigForOrg` itself has no DB-mocked unit test in this file today (its doc comment says DB-touching behavior "belongs in integration tests" and none exist) — `getMediaPlannerConfigForOrg`'s DB-read path is exercised indirectly in Task 3's tests, where it is mocked at the module boundary rather than by mocking Prisma directly.

- [ ] **Step 1: Write the failing test for the pure parser**

Add to `api/src/core/coordination/__tests__/collective-feature-flags.test.ts`:

```typescript
import { parseOrgMediaPlannerSettings } from '../collective-feature-flags';

describe('parseOrgMediaPlannerSettings', () => {
  it('returns empty for non-object inputs', () => {
    expect(parseOrgMediaPlannerSettings(null)).toEqual({});
    expect(parseOrgMediaPlannerSettings(undefined)).toEqual({});
    expect(parseOrgMediaPlannerSettings('nope')).toEqual({});
    expect(parseOrgMediaPlannerSettings([])).toEqual({});
  });

  it('extracts enabled when it is a real boolean', () => {
    expect(parseOrgMediaPlannerSettings({ enabled: true })).toEqual({ enabled: true });
    expect(parseOrgMediaPlannerSettings({ enabled: false })).toEqual({ enabled: false });
  });

  it('drops enabled when it is not a boolean', () => {
    expect(parseOrgMediaPlannerSettings({ enabled: 'yes' })).toEqual({});
    expect(parseOrgMediaPlannerSettings({ enabled: 1 })).toEqual({});
  });

  it('ignores unrelated keys', () => {
    expect(parseOrgMediaPlannerSettings({ enabled: true, extra: 'ignored' })).toEqual({
      enabled: true,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && npx vitest run src/core/coordination/__tests__/collective-feature-flags.test.ts -t parseOrgMediaPlannerSettings`
Expected: FAIL — `parseOrgMediaPlannerSettings` is not exported yet.

- [ ] **Step 3: Implement — append the canary resolver to `collective-feature-flags.ts`**

Append to the end of `api/src/core/coordination/collective-feature-flags.ts` (after the closing `}` of `getCollectiveConfigForOrg`, line 287):

```typescript

// ─── MediaPlanner canary (Section E: chat/triage pipeline integration) ────

/**
 * Per-tenant MediaPlanner canary allowlist. Lives in a SIBLING top-level
 * key of `Organization.settings` — `settings.mediaPlannerConfig` — and is
 * deliberately NOT merged into `CoordinationConfig`/`settings.collectiveConfig`
 * above: `CoordinationConfig` is specifically the collective-coordination
 * (multi-model consensus) feature's config; MediaPlanner is an unrelated
 * feature that only wants the same tenant-override plumbing (TTL cache,
 * DB-failure-safe fallback, `Organization.settings` JSON storage). See the
 * 2026-09-23 MediaPlanner completion design spec, section E, for the full
 * rationale, and `resolveEffectiveMediaPlannerEnabled` in
 * `media-planner-gate.ts` for where this is combined with the global
 * `MEDIA_PLANNER_ENABLED` env flag.
 *
 * Example settings.mediaPlannerConfig payload: `{ "enabled": true }`
 */
export interface OrgMediaPlannerSettings {
  enabled?: boolean;
}

interface MediaPlannerCacheEntry {
  value: boolean;
  expiresAt: number;
}

const MEDIA_PLANNER_CACHE_MAX_ENTRIES = 1024;
const mediaPlannerCache = new Map<string, MediaPlannerCacheEntry>();

/** Force-clear the MediaPlanner canary cache. Exported for admin tooling and tests. */
export function clearMediaPlannerConfigCache(): void {
  mediaPlannerCache.clear();
}

/**
 * Extract `{ enabled }` from an arbitrary JSON value. Anything else is
 * dropped silently — same tolerant-parsing posture as
 * `parseOrganizationCollectiveSettings` — so a corrupt settings blob can
 * never crash the orchestration hot path.
 */
export function parseOrgMediaPlannerSettings(raw: unknown): OrgMediaPlannerSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;
  const out: OrgMediaPlannerSettings = {};
  if (typeof obj.enabled === 'boolean') out.enabled = obj.enabled;
  return out;
}

/**
 * Read `Organization.settings.mediaPlannerConfig` and parse it. Returns
 * `{}` when the org has no override, doesn't exist, or the DB read fails —
 * NEVER throws (mirrors `readOrgCollectiveSettings`'s fail-safe posture).
 */
async function readOrgMediaPlannerSettings(
  organizationId: string
): Promise<OrgMediaPlannerSettings> {
  try {
    const org: Pick<Organization, 'settings'> | null = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { settings: true },
    });
    if (!org) return {};

    const settings = org.settings;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return {};

    const raw = (settings as Record<string, unknown>).mediaPlannerConfig;
    return parseOrgMediaPlannerSettings(raw);
  } catch (err) {
    log.warn(
      {
        organizationId,
        error: err instanceof Error ? err.message : String(err),
      },
      'readOrgMediaPlannerSettings failed — falling back to disabled'
    );
    return {};
  }
}

/**
 * Resolve the MediaPlanner canary allowlist entry for one organization.
 * `enabled` defaults to `false` when unset, unparseable, or on DB failure —
 * the safe default for a feature that stays off everywhere until an org is
 * explicitly named (see the design spec's "Production rollout" steps).
 * Cached for 60s using the same TTL as `getCollectiveConfigForOrg`.
 *
 * NEVER throws; falls back to `{ enabled: false }` on any DB error.
 */
export async function getMediaPlannerConfigForOrg(
  organizationId: string
): Promise<{ enabled: boolean }> {
  if (!organizationId) return { enabled: false };

  const cached = mediaPlannerCache.get(organizationId);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return { enabled: cached.value };
  }

  const overrides = await readOrgMediaPlannerSettings(organizationId);
  const enabled = overrides.enabled === true;

  mediaPlannerCache.set(organizationId, { value: enabled, expiresAt: now + CACHE_TTL_MS });
  evictOldestIfOverCap(mediaPlannerCache, MEDIA_PLANNER_CACHE_MAX_ENTRIES);

  return { enabled };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd api && npx vitest run src/core/coordination/__tests__/collective-feature-flags.test.ts`
Expected: PASS (full file, including Task 1's tests).

- [ ] **Step 5: Commit**

```bash
git add api/src/core/coordination/collective-feature-flags.ts api/src/core/coordination/__tests__/collective-feature-flags.test.ts
git commit -m "feat(media-planner): add getMediaPlannerConfigForOrg sibling canary resolver"
```

---

### Task 3: Add `resolveEffectiveMediaPlannerEnabled()` — the combined global-or-canary gate

**Files:**
- Modify: `api/src/core/orchestration/strategies/media-planner-gate.ts`
- Test (new file): `api/src/core/orchestration/strategies/__tests__/media-planner-effective-gate.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `api/src/core/orchestration/strategies/__tests__/media-planner-effective-gate.test.ts`:

```typescript
/**
 * resolveEffectiveMediaPlannerEnabled — combines the global MEDIA_PLANNER_ENABLED
 * env flag with the per-org canary allowlist (Section E of the 2026-09-23
 * MediaPlanner completion design).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let mockGlobalEnabled = false;

vi.mock('@/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config')>();
  return {
    ...actual,
    config: {
      ...actual.config,
      mediaPlanner: {
        ...actual.config.mediaPlanner,
        get enabled() {
          return mockGlobalEnabled;
        },
      },
    },
  };
});

const getMediaPlannerConfigForOrgMock = vi.fn();
vi.mock('@/core/coordination/collective-feature-flags', () => ({
  getMediaPlannerConfigForOrg: getMediaPlannerConfigForOrgMock,
}));

import { resolveEffectiveMediaPlannerEnabled } from '../media-planner-gate';

describe('resolveEffectiveMediaPlannerEnabled', () => {
  beforeEach(() => {
    mockGlobalEnabled = false;
    getMediaPlannerConfigForOrgMock.mockReset();
  });

  it('is enabled when the global flag is on, regardless of org config', async () => {
    mockGlobalEnabled = true;
    const result = await resolveEffectiveMediaPlannerEnabled('org-1');
    expect(result).toBe(true);
    expect(getMediaPlannerConfigForOrgMock).not.toHaveBeenCalled();
  });

  it('is enabled when the global flag is off but the org canary is on', async () => {
    mockGlobalEnabled = false;
    getMediaPlannerConfigForOrgMock.mockResolvedValue({ enabled: true });
    const result = await resolveEffectiveMediaPlannerEnabled('org-1');
    expect(result).toBe(true);
    expect(getMediaPlannerConfigForOrgMock).toHaveBeenCalledWith('org-1');
  });

  it('is disabled when both the global flag and the org canary are off', async () => {
    mockGlobalEnabled = false;
    getMediaPlannerConfigForOrgMock.mockResolvedValue({ enabled: false });
    const result = await resolveEffectiveMediaPlannerEnabled('org-1');
    expect(result).toBe(false);
  });

  it('is disabled when no organizationId is available and the global flag is off', async () => {
    mockGlobalEnabled = false;
    const result = await resolveEffectiveMediaPlannerEnabled(undefined);
    expect(result).toBe(false);
    expect(getMediaPlannerConfigForOrgMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd api && npx vitest run src/core/orchestration/strategies/__tests__/media-planner-effective-gate.test.ts`
Expected: FAIL — `resolveEffectiveMediaPlannerEnabled` is not exported yet.

- [ ] **Step 3: Implement — add the resolver to `media-planner-gate.ts`**

In `api/src/core/orchestration/strategies/media-planner-gate.ts`, add to the top-of-file imports (after the existing `import { isObject } ...` line):

```typescript
import { config } from '@/config';
import { getMediaPlannerConfigForOrg } from '@/core/coordination/collective-feature-flags';
```

Then add, immediately after `resolveMediaPlanRouting` (after its closing `}`, currently line 201, before the `// ─── Native joint-collapse check (§3.3) ───` section header):

```typescript

/**
 * Effective MediaPlanner gate: the global `MEDIA_PLANNER_ENABLED` env flag
 * OR a per-org canary allowlist entry (`getMediaPlannerConfigForOrg`,
 * `Organization.settings.mediaPlannerConfig.enabled` — a SIBLING key to
 * `collectiveConfig`, never merged into `CoordinationConfig`). The global
 * flag is checked FIRST and short-circuits before touching the DB/cache at
 * all, so an org with the global flag already on never pays for an
 * org-settings lookup.
 *
 * Every caller that used to pass `config.mediaPlanner.enabled` straight
 * into `resolveMediaPlanRouting` should resolve this first instead, so a
 * named canary org gets the same effective behavior as a global flip
 * without one being required.
 */
export async function resolveEffectiveMediaPlannerEnabled(
  organizationId: string | undefined
): Promise<boolean> {
  if (config.mediaPlanner.enabled) return true;
  if (!organizationId) return false;
  const orgConfig = await getMediaPlannerConfigForOrg(organizationId);
  return orgConfig.enabled === true;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd api && npx vitest run src/core/orchestration/strategies/__tests__/media-planner-effective-gate.test.ts`
Expected: PASS (all 4 tests).

Also run the existing gate suite to confirm the new imports didn't break anything:
Run: `cd api && npx vitest run src/core/orchestration/strategies/__tests__/media-planner-gate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/src/core/orchestration/strategies/media-planner-gate.ts api/src/core/orchestration/strategies/__tests__/media-planner-effective-gate.test.ts
git commit -m "feat(media-planner): add resolveEffectiveMediaPlannerEnabled (global-or-canary gate)"
```

---

### Task 4: Point the existing dedicated route at the effective gate

**Files:**
- Modify: `api/src/routes/capabilities/capabilities-routes.ts:13,2220-2232`

The existing `/v1/capabilities/media-plan/execute` route currently only checks the global flag (`config.mediaPlanner.enabled`), with no canary awareness — a canary-named org could reach the dedicated route without benefiting from its own override. This is a 2-line consistency fix; there is no dedicated test harness for this route in the codebase today (no fastify-injection test exists for it — confirmed via search), so verification here relies on Task 3's already-passing unit tests for `resolveEffectiveMediaPlannerEnabled` plus a full-suite/typecheck pass, rather than inventing a new route-level test harness that doesn't match this codebase's existing patterns for this file.

- [ ] **Step 1: Update the import**

In `api/src/routes/capabilities/capabilities-routes.ts`, change line 13:

```typescript
import { resolveMediaPlanRouting } from '@/core/orchestration/strategies/media-planner-gate';
```

to:

```typescript
import {
  resolveMediaPlanRouting,
  resolveEffectiveMediaPlannerEnabled,
} from '@/core/orchestration/strategies/media-planner-gate';
```

- [ ] **Step 2: Update the call site**

Replace lines 2220-2232:

```typescript
      const gate = resolveMediaPlanRouting(chatRequest, orchestrationContext, config.mediaPlanner.enabled);
      if (!gate.route) {
        return reply.code(422).send({
          error: {
            code: 'media_planner_not_applicable',
            type: 'capability_error',
            message: config.mediaPlanner.enabled
              ? `Request does not meet the media-planner routing heuristic: ${gate.reason}`
              : 'MEDIA_PLANNER_ENABLED is false',
            details: { reason: gate.reason, detectedCapabilities: gate.detectedCapabilities },
          },
        });
      }
```

with:

```typescript
      const mediaPlannerEnabled = await resolveEffectiveMediaPlannerEnabled(
        orchestrationContext.organizationId
      );
      const gate = resolveMediaPlanRouting(chatRequest, orchestrationContext, mediaPlannerEnabled);
      if (!gate.route) {
        return reply.code(422).send({
          error: {
            code: 'media_planner_not_applicable',
            type: 'capability_error',
            message: mediaPlannerEnabled
              ? `Request does not meet the media-planner routing heuristic: ${gate.reason}`
              : 'MEDIA_PLANNER_ENABLED is false and no canary override is set for this organization',
            details: { reason: gate.reason, detectedCapabilities: gate.detectedCapabilities },
          },
        });
      }
```

- [ ] **Step 3: Typecheck and run the existing capabilities-routes test suite**

Run: `cd api && npx tsc --noEmit -p tsconfig.json`
Expected: no new type errors.

Run: `cd api && npx vitest run src/routes/capabilities/__tests__/`
Expected: PASS (existing suites unaffected — none of them exercise the media-plan route).

- [ ] **Step 4: Commit**

```bash
git add api/src/routes/capabilities/capabilities-routes.ts
git commit -m "fix(media-planner): dedicated route now honors the per-org canary override"
```

---

### Task 5: Lazily construct a `MediaPlannerStrategy` on `OrchestrationEngine`

**Files:**
- Modify: `api/src/core/orchestration/orchestration-engine.ts` (imports near line 1-120; new field near line 821; new method after line 1037)
- Test (new file): `api/src/core/orchestration/__tests__/media-planner-safety-net.test.ts`

- [ ] **Step 1: Write the failing test**

Create `api/src/core/orchestration/__tests__/media-planner-safety-net.test.ts`:

```typescript
/**
 * Section E (2026-09-23 MediaPlanner completion design) — the chat/triage
 * pipeline safety net into MediaPlannerStrategy.
 */
import { describe, it, expect } from 'vitest';
import { OrchestrationEngine } from '@/core/orchestration/orchestration-engine';
import { MediaPlannerStrategy } from '@/core/orchestration/strategies/media-planner-strategy';
import type { ProviderRegistry } from '@/providers/provider-registry';

function makeEngine(): OrchestrationEngine {
  return new OrchestrationEngine({
    providerRegistry: {
      getAllModels: async () => [],
      findModel: async () => null,
      findModelByName: async () => null,
      getProviderNames: () => [],
    } as unknown as ProviderRegistry,
    enableTriaging: false,
  });
}

function getStrategy(engine: OrchestrationEngine): MediaPlannerStrategy {
  return (
    engine as unknown as { getMediaPlannerStrategy: () => MediaPlannerStrategy }
  ).getMediaPlannerStrategy();
}

describe('OrchestrationEngine.getMediaPlannerStrategy', () => {
  it('lazily constructs a MediaPlannerStrategy instance', () => {
    const engine = makeEngine();
    const strategy = getStrategy(engine);
    expect(strategy).toBeInstanceOf(MediaPlannerStrategy);
  });

  it('memoizes the instance across calls', () => {
    const engine = makeEngine();
    const first = getStrategy(engine);
    const second = getStrategy(engine);
    expect(first).toBe(second);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && npx vitest run src/core/orchestration/__tests__/media-planner-safety-net.test.ts`
Expected: FAIL — `getMediaPlannerStrategy` does not exist on `OrchestrationEngine`.

- [ ] **Step 3: Implement**

Add these imports to `api/src/core/orchestration/orchestration-engine.ts`, grouped with the other `./strategies/*` imports (e.g. right after the `TriRoleCollectiveStrategy` import, line 39):

```typescript
import { MediaPlannerStrategy } from './strategies/media-planner-strategy';
import { MediaConsensusStrategy } from './strategies/media-consensus-strategy';
import {
  evaluateMediaPlannerGate,
  resolveEffectiveMediaPlannerEnabled,
} from './strategies/media-planner-gate';
import { MEDIA_GENERATION_CAPABILITIES } from './strategies/media-planner-types';
```

And these two (services, not strategies), grouped near other `@/services/*` imports — orchestration-engine.ts does not currently import any `@/services/*` module directly, so add them right after the `@/providers/provider-registry` import (line 50):

```typescript
import { VideoOrchestrationService } from '@/services/video-orchestration-service';
import { ImagesOrchestrationService } from '@/services/images-orchestration-service';
```

Add a new private field right after `private triageService?: TriagingService;` (line 821):

```typescript
  private mediaPlannerStrategy?: MediaPlannerStrategy;
```

Add a new private method right after `initializeTriageService()` closes (after line 1037, before the doc comment for `initializeTriageAsync` on line 1039):

```typescript

  /**
   * Lazily construct the MediaPlanner "safety net" strategy used by
   * `maybeRouteToMediaPlannerSafetyNet()` (Section E, 2026-09-23 MediaPlanner
   * completion design). Built once per engine instance and reused.
   * `VideoOrchestrationService`/`ImagesOrchestrationService` are stateless,
   * no-arg-constructible services — the same ones `capabilities-routes.ts`
   * constructs once at route-registration time for the dedicated route.
   *
   * Deliberately wires ONLY `mediaConsensusExecutor` (video/image
   * generation) and leaves `capabilityDispatcher` unset:
   * `evaluateMediaPlannerGate` only ever routes when a
   * `video_generation`/`image_generation` capability is involved, so a
   * `generate` action is the only action kind this safety-net path can
   * ever need. `capabilityDispatcher` requires a live `FastifyRequest`
   * bound by the HTTP route layer (see `media-planner-strategy.ts`'s doc
   * comment on `CapabilityDispatcher`), which this engine's `execute()`
   * does not have and should not be given just for this. A `capability_call`
   * action the planner emits anyway degrades to a documented "capability
   * dispatcher not wired" unmet-constraint entry rather than throwing —
   * the same fallback the dedicated route would hit for the same missing
   * dependency, so this is not a new gap.
   */
  private getMediaPlannerStrategy(): MediaPlannerStrategy {
    if (!this.mediaPlannerStrategy) {
      const videoService = new VideoOrchestrationService();
      const imagesService = new ImagesOrchestrationService();
      this.mediaPlannerStrategy = new MediaPlannerStrategy({
        mediaConsensusExecutor: new MediaConsensusStrategy({ videoService, imagesService }),
      });
    }
    return this.mediaPlannerStrategy;
  }
```

(The `evaluateMediaPlannerGate`, `resolveEffectiveMediaPlannerEnabled`, and `MEDIA_GENERATION_CAPABILITIES` imports are unused until Task 6 — this is expected; the project's linter is configured per-file and Task 6 lands in the same PR/commit series, but if a standalone lint gate runs between tasks, `// eslint-disable-next-line` is not needed since Task 6 follows immediately.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd api && npx vitest run src/core/orchestration/__tests__/media-planner-safety-net.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add api/src/core/orchestration/orchestration-engine.ts api/src/core/orchestration/__tests__/media-planner-safety-net.test.ts
git commit -m "feat(media-planner): lazily construct MediaPlannerStrategy on OrchestrationEngine"
```

---

### Task 6: Add `maybeRouteToMediaPlannerSafetyNet()` — the gate-and-dispatch decision

**Files:**
- Modify: `api/src/core/orchestration/orchestration-engine.ts` (new method after `getMediaPlannerStrategy()`)
- Test: `api/src/core/orchestration/__tests__/media-planner-safety-net.test.ts`

This is the core of deliverables 2 and 3 from the brief: the effective-gate check, and the "zero added cost on the common path" guarantee, verified by asserting the gate function itself is never called for a plain non-media, successfully-triaged request.

- [ ] **Step 1: Write the failing tests**

Add to `api/src/core/orchestration/__tests__/media-planner-safety-net.test.ts` (extend the mocking + imports at the top of the file):

```typescript
import { vi, beforeEach } from 'vitest';
import type { ChatRequest, OrchestrationContext, OrchestrationResult, TriageDecision } from '@/types';

vi.mock('@/core/orchestration/strategies/media-planner-gate', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@/core/orchestration/strategies/media-planner-gate')
  >();
  return {
    ...actual,
    evaluateMediaPlannerGate: vi.fn(actual.evaluateMediaPlannerGate),
    resolveEffectiveMediaPlannerEnabled: vi.fn(),
  };
});

import {
  evaluateMediaPlannerGate,
  resolveEffectiveMediaPlannerEnabled,
} from '@/core/orchestration/strategies/media-planner-gate';

type MaybeRoute = (
  request: ChatRequest,
  context: OrchestrationContext,
  requestId: string
) => Promise<OrchestrationResult | undefined>;

function callMaybeRoute(
  engine: OrchestrationEngine,
  request: ChatRequest,
  context: OrchestrationContext
): Promise<OrchestrationResult | undefined> {
  return (
    engine as unknown as { maybeRouteToMediaPlannerSafetyNet: MaybeRoute }
  ).maybeRouteToMediaPlannerSafetyNet(request, context, 'req-test');
}

function baseContext(overrides: Partial<OrchestrationContext> = {}): OrchestrationContext {
  return {
    organizationId: 'org-1',
    userId: 'user-1',
    requestId: 'req-test',
    models: [],
    requiredCapabilities: [],
    ...overrides,
  } as OrchestrationContext;
}

describe('OrchestrationEngine.maybeRouteToMediaPlannerSafetyNet', () => {
  const gateSpy = vi.mocked(evaluateMediaPlannerGate);
  const enabledSpy = vi.mocked(resolveEffectiveMediaPlannerEnabled);

  beforeEach(() => {
    gateSpy.mockClear();
    enabledSpy.mockReset();
  });

  it('returns undefined WITHOUT calling the gate or the effective-flag resolver for a plain, successfully-triaged non-media request', async () => {
    const engine = makeEngine();
    const context = baseContext({
      requiredCapabilities: ['reasoning'],
      triage: { intent: 'general', complexity: 'low', source: 'llm' } as TriageDecision,
    });
    const request: ChatRequest = {
      messages: [{ role: 'user', content: 'What is the capital of France?' }],
    };

    const result = await callMaybeRoute(engine, request, context);

    expect(result).toBeUndefined();
    expect(enabledSpy).not.toHaveBeenCalled();
    expect(gateSpy).not.toHaveBeenCalled();
  });

  it('returns undefined when media-shaped but the effective flag (global+canary) is off', async () => {
    const engine = makeEngine();
    enabledSpy.mockResolvedValue(false);
    const context = baseContext({ requiredCapabilities: ['image_generation'] });
    const request: ChatRequest = {
      messages: [{ role: 'user', content: 'generate an image of a cat' }],
    };

    const result = await callMaybeRoute(engine, request, context);

    expect(result).toBeUndefined();
    expect(enabledSpy).toHaveBeenCalledWith('org-1');
    expect(gateSpy).not.toHaveBeenCalled();
  });

  it('routes into MediaPlannerStrategy when media-shaped, the effective flag is on, and the gate says route', async () => {
    const engine = makeEngine();
    enabledSpy.mockResolvedValue(true);
    const context = baseContext({ requiredCapabilities: ['image_generation', 'video_generation'] });
    const request: ChatRequest = {
      messages: [{ role: 'user', content: 'generate a 30s 4k video AND a matching poster image' }],
    };

    const strategy = getStrategy(engine);
    const mockResult: OrchestrationResult = {
      strategyUsed: 'single',
      modelsUsed: [],
      finalResponse: {
        id: 'x',
        object: 'chat.completion',
        created: 0,
        model: 'auto',
        choices: [],
      },
      totalCost: 0,
      totalDuration: 0,
      metadata: {},
    };
    const executeSpy = vi.spyOn(strategy, 'execute').mockResolvedValue(mockResult);

    const result = await callMaybeRoute(engine, request, context);

    expect(executeSpy).toHaveBeenCalledWith(request, context);
    expect(result).toBe(mockResult);
  });

  it('does NOT route into MediaPlannerStrategy when the gate declines even though the flag is on', async () => {
    const engine = makeEngine();
    enabledSpy.mockResolvedValue(true);
    const context = baseContext({ requiredCapabilities: ['image_generation'] });
    const request: ChatRequest = {
      messages: [{ role: 'user', content: 'generate an image of a cat' }],
    };
    const strategy = getStrategy(engine);
    const executeSpy = vi.spyOn(strategy, 'execute');

    const result = await callMaybeRoute(engine, request, context);

    // Single media capability with no multi-capability/attribute constraint
    // is the gate's own documented "stay on the direct route" case.
    expect(executeSpy).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it('is also evaluated when triage fell back to heuristics, even with no media capability pre-detected', async () => {
    const engine = makeEngine();
    enabledSpy.mockResolvedValue(true);
    const context = baseContext({
      requiredCapabilities: [],
      triage: { intent: 'general', complexity: 'low', source: 'heuristic' } as TriageDecision,
    });
    const request: ChatRequest = {
      messages: [{ role: 'user', content: 'just chatting, nothing media-related here' }],
    };

    const result = await callMaybeRoute(engine, request, context);

    expect(enabledSpy).toHaveBeenCalledWith('org-1');
    expect(gateSpy).toHaveBeenCalledWith(request, context);
    expect(result).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd api && npx vitest run src/core/orchestration/__tests__/media-planner-safety-net.test.ts`
Expected: FAIL — `maybeRouteToMediaPlannerSafetyNet` does not exist yet.

- [ ] **Step 3: Implement**

Add this private method to `api/src/core/orchestration/orchestration-engine.ts`, immediately after `getMediaPlannerStrategy()` (added in Task 5):

```typescript

  /**
   * Section E safety net: after triage has fully resolved (successfully or
   * via the non-LLM heuristic fallback) and `context.requiredCapabilities` /
   * `context.triage` reflect the final decision, decide whether this
   * request should be handed to `MediaPlannerStrategy` instead of finishing
   * as an ordinary chat completion.
   *
   * Only ever does ANY work — including the cheap `evaluateMediaPlannerGate`
   * text scan and the `resolveEffectiveMediaPlannerEnabled` cache/DB lookup
   * — when the resolved plan already touches a media-generation capability,
   * or triage fell back to the heuristic (non-LLM) path
   * (`TriageDecision.source === 'heuristic'`). A normally-triaged, non-media
   * chat request returns `undefined` immediately without any of that —
   * zero added cost on the common path.
   *
   * Returns `undefined` when the caller should continue with the existing
   * chat pipeline unchanged; returns a terminal `OrchestrationResult` when
   * this safety net already produced (or degraded-failed) the response.
   */
  private async maybeRouteToMediaPlannerSafetyNet(
    request: ChatRequest,
    context: OrchestrationContext,
    requestId: string
  ): Promise<OrchestrationResult | undefined> {
    const planTouchesMediaGeneration = (context.requiredCapabilities ?? []).some((cap) =>
      MEDIA_GENERATION_CAPABILITIES.has(cap)
    );
    const triageFellBackToHeuristics = context.triage?.source === 'heuristic';

    if (!planTouchesMediaGeneration && !triageFellBackToHeuristics) {
      return undefined;
    }

    const mediaPlannerEnabled = await resolveEffectiveMediaPlannerEnabled(context.organizationId);
    if (!mediaPlannerEnabled) {
      return undefined;
    }

    const gate = evaluateMediaPlannerGate(request, context);
    if (gate.route) {
      this.log.info(
        { requestId, reason: gate.reason, detectedCapabilities: gate.detectedCapabilities },
        'Routing request into MediaPlannerStrategy safety net'
      );
      return await this.getMediaPlannerStrategy().execute(request, context);
    }

    return undefined;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd api && npx vitest run src/core/orchestration/__tests__/media-planner-safety-net.test.ts`
Expected: PASS for all 5 tests, including the last (heuristic-fallback) one — it only asserts the gate/flag were consulted and the result is `undefined`, which the implementation above already satisfies (no routing/degraded-response behavior is required from it yet; the degraded-response behavior itself lands in Task 7).

- [ ] **Step 5: Commit**

```bash
git add api/src/core/orchestration/orchestration-engine.ts api/src/core/orchestration/__tests__/media-planner-safety-net.test.ts
git commit -m "feat(media-planner): add maybeRouteToMediaPlannerSafetyNet gate-and-dispatch"
```

---

### Task 7: Add the explicit degraded-response failure path

**Files:**
- Modify: `api/src/core/orchestration/orchestration-engine.ts` (new method; extend `maybeRouteToMediaPlannerSafetyNet`)
- Test: `api/src/core/orchestration/__tests__/media-planner-safety-net.test.ts`

Deliverable 4 from the brief: when triage fell back to heuristics AND could not confidently resolve a media capability, but `evaluateMediaPlannerGate`'s own **independent** keyword scan of the same message text still flags it as media-shaped, the two heuristics disagree — return a structured `[DEGRADED]` response (mirroring the existing `applyDegradedFallback()` shape at `orchestration-engine.ts:6877-6920`) instead of silently letting the request finish as prose chat.

- [ ] **Step 1: Write the failing test**

Add to `api/src/core/orchestration/__tests__/media-planner-safety-net.test.ts`:

```typescript
describe('OrchestrationEngine.maybeRouteToMediaPlannerSafetyNet — explicit failure path', () => {
  const gateSpy = vi.mocked(evaluateMediaPlannerGate);
  const enabledSpy = vi.mocked(resolveEffectiveMediaPlannerEnabled);

  beforeEach(() => {
    gateSpy.mockClear();
    enabledSpy.mockReset();
  });

  it('returns a structured [DEGRADED] response when heuristic triage found no media capability but the gate independently detects one', async () => {
    const engine = makeEngine();
    enabledSpy.mockResolvedValue(true);
    gateSpy.mockReturnValue({
      route: false,
      reason: 'single media-generation capability with no explicit attribute constraint',
      detectedCapabilities: ['video_generation'],
      detectedConstraints: {},
    });
    const context = baseContext({
      requiredCapabilities: [],
      triage: { intent: 'general', complexity: 'low', source: 'heuristic' } as TriageDecision,
    });
    const request: ChatRequest = {
      messages: [{ role: 'user', content: 'make me a short clip, you know the vibe' }],
    };

    const result = await callMaybeRoute(engine, request, context);

    expect(result).toBeDefined();
    expect(result?.metadata.degraded).toBe(true);
    expect(result?.metadata.degraded_reason).toBe(
      'media_shaped_request_capabilities_unresolved'
    );
    expect(result?.finalResponse.choices[0].message.content).toContain('[DEGRADED]');
  });

  it('does NOT degrade when triage already resolved a media capability (planTouchesMediaGeneration true)', async () => {
    const engine = makeEngine();
    enabledSpy.mockResolvedValue(true);
    gateSpy.mockReturnValue({
      route: false,
      reason: 'single media-generation capability with no explicit attribute constraint',
      detectedCapabilities: ['video_generation'],
      detectedConstraints: {},
    });
    const context = baseContext({
      requiredCapabilities: ['video_generation'],
      triage: { intent: 'general', complexity: 'low', source: 'heuristic' } as TriageDecision,
    });
    const request: ChatRequest = {
      messages: [{ role: 'user', content: 'generate a video of a sunset' }],
    };

    const result = await callMaybeRoute(engine, request, context);

    expect(result).toBeUndefined();
  });

  it('does NOT degrade when the gate detects no media keywords at all', async () => {
    const engine = makeEngine();
    enabledSpy.mockResolvedValue(true);
    gateSpy.mockReturnValue({
      route: false,
      reason: 'no media-generation capability detected',
      detectedCapabilities: [],
      detectedConstraints: {},
    });
    const context = baseContext({
      requiredCapabilities: [],
      triage: { intent: 'general', complexity: 'low', source: 'heuristic' } as TriageDecision,
    });
    const request: ChatRequest = {
      messages: [{ role: 'user', content: 'just chatting, nothing media-related here' }],
    };

    const result = await callMaybeRoute(engine, request, context);

    expect(result).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd api && npx vitest run src/core/orchestration/__tests__/media-planner-safety-net.test.ts`
Expected: FAIL on the first new test — `result` is `undefined`, not a degraded response.

- [ ] **Step 3: Implement**

Add this private method to `api/src/core/orchestration/orchestration-engine.ts`, immediately after `maybeRouteToMediaPlannerSafetyNet()`:

```typescript

  /**
   * Structured degraded-response for the Section E explicit-failure path:
   * triage fell back to heuristics AND could not confidently resolve
   * required capabilities for a request whose text independently matches
   * `evaluateMediaPlannerGate`'s own media-generation keyword scan. Mirrors
   * `applyDegradedFallback()`'s shape (explicit `[DEGRADED]` content +
   * `metadata.degraded=true`, see line ~6877) rather than silently letting
   * the request fall through to a chat model that would just describe the
   * requested media in prose instead of generating it.
   */
  private buildMediaPlannerDegradedResponse(
    requestId: string,
    reason: string
  ): OrchestrationResult {
    const degradedResponse: ChatResponse = {
      id: `degraded-media-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'auto',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content:
              '[DEGRADED] This request appears to ask for media generation, but the required capabilities could not be confidently determined.',
          },
          finish_reason: 'stop',
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
    this.log.warn({ requestId, reason }, 'MediaPlanner safety net returning degraded response');
    return {
      strategyUsed: 'single',
      modelsUsed: [],
      finalResponse: degradedResponse,
      totalCost: 0,
      totalDuration: 0,
      qualityScore: 0,
      metadata: {
        degraded: true,
        degraded_reason: 'media_shaped_request_capabilities_unresolved',
        media_planner_gate_reason: reason,
      },
    };
  }
```

Then extend `maybeRouteToMediaPlannerSafetyNet()` (Task 6) — replace its final `return undefined;` (the one right after the `if (gate.route) { ... }` block) with:

```typescript
    const gateDetectedMediaGeneration = gate.detectedCapabilities.some((cap) =>
      MEDIA_GENERATION_CAPABILITIES.has(cap as ModelCapability)
    );
    if (triageFellBackToHeuristics && !planTouchesMediaGeneration && gateDetectedMediaGeneration) {
      return this.buildMediaPlannerDegradedResponse(requestId, gate.reason);
    }

    return undefined;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd api && npx vitest run src/core/orchestration/__tests__/media-planner-safety-net.test.ts`
Expected: PASS (all tests across Tasks 5-7).

- [ ] **Step 5: Commit**

```bash
git add api/src/core/orchestration/orchestration-engine.ts api/src/core/orchestration/__tests__/media-planner-safety-net.test.ts
git commit -m "feat(media-planner): add explicit degraded-response failure path"
```

---

### Task 8: Wire the safety net into `execute()`'s main flow

**Files:**
- Modify: `api/src/core/orchestration/orchestration-engine.ts:1700-1702`
- Test: `api/src/core/orchestration/__tests__/media-planner-safety-net.test.ts` (regression check only — the wiring itself is a single call already covered by Tasks 6-7's direct-invocation tests)

This is the one-line integration point identified by re-reading `execute()`: triage resolution (LLM success, confidence-gate rejection, calibration, `applyTriageRoute`, or the `shouldRunTriage`-false/ablated branch) all converge by line 1700, and the existing "Multi-stage execution" block (which decides the actual chat/strategy dispatch) begins at line 1702. This is the exact seam the design's Problem Statement identifies as the gap: everything before this line only ever produces `context.triage`/`context.requiredCapabilities`; nothing between here and the strategy dispatch below ever considers `MediaPlannerStrategy`.

- [ ] **Step 1: Insert the call**

In `api/src/core/orchestration/orchestration-engine.ts`, locate the existing code (lines 1690-1702):

```typescript
        } else if (this.triageService && autoStrategyRequested) {
          this.log.debug(
            {
              requestId,
              taskType: context.taskType,
              contextSize: context.contextSize,
              preferSpeed: context.preferSpeed,
            },
            'Skipping triage for latency-optimized auto request'
          );
        }

        try {
          // ── Multi-stage execution: if triage produced a multi-stage plan, execute stages sequentially ──
```

Replace it with:

```typescript
        } else if (this.triageService && autoStrategyRequested) {
          this.log.debug(
            {
              requestId,
              taskType: context.taskType,
              contextSize: context.contextSize,
              preferSpeed: context.preferSpeed,
            },
            'Skipping triage for latency-optimized auto request'
          );
        }

        // ── Section E (2026-09-23 MediaPlanner completion design): chat/
        // triage pipeline safety net into MediaPlannerStrategy, for callers
        // that never hit the dedicated `/v1/capabilities/media-plan/execute`
        // route. Runs AFTER triage has fully resolved above (context.triage /
        // context.requiredCapabilities reflect the final decision, including
        // the heuristic-fallback case) and BEFORE the existing chat-only
        // multi-stage/single-stage execution below. Returns undefined
        // (no-op) for the common non-media, successfully-triaged path —
        // see maybeRouteToMediaPlannerSafetyNet's own doc comment for the
        // zero-added-cost guarantee.
        const mediaPlannerSafetyNetResult = await this.maybeRouteToMediaPlannerSafetyNet(
          request,
          context,
          requestId
        );
        if (mediaPlannerSafetyNetResult) {
          return mediaPlannerSafetyNetResult;
        }

        try {
          // ── Multi-stage execution: if triage produced a multi-stage plan, execute stages sequentially ──
```

- [ ] **Step 2: Typecheck and run the full media-planner-safety-net + orchestration-engine test files**

Run: `cd api && npx tsc --noEmit -p tsconfig.json`
Expected: no new type errors.

Run: `cd api && npx vitest run src/core/orchestration/__tests__/media-planner-safety-net.test.ts src/core/orchestration/__tests__/media-stage-duplicate-and-placeholder.test.ts src/core/orchestration/__tests__/composite-media-plan.test.ts src/core/orchestration/__tests__/orchestration-engine.overall-deadline.test.ts`
Expected: PASS — the new call site doesn't change behavior for any of these existing media/non-media test scenarios (all use `enableTriaging: false` or otherwise never set `context.triage.source = 'heuristic'` with a media-shaped, canary-enabled context, so `maybeRouteToMediaPlannerSafetyNet` returns `undefined` immediately for every one of them).

- [ ] **Step 3: Run the broader orchestration test directory as a regression check**

Run: `cd api && npx vitest run src/core/orchestration/__tests__/`
Expected: PASS. (If any pre-existing test happens to construct a context with `triage.source === 'heuristic'` and a canary-enabled organizationId, investigate per the systematic-debugging skill before proceeding — this would indicate an unexpected interaction, not an expected regression, since the canary defaults off everywhere and `resolveEffectiveMediaPlannerEnabled` short-circuits to `false` for any org with no `mediaPlannerConfig` override and `MEDIA_PLANNER_ENABLED` unset.)

- [ ] **Step 4: Commit**

```bash
git add api/src/core/orchestration/orchestration-engine.ts
git commit -m "feat(media-planner): wire safety net into the chat/triage execution flow"
```

---

## Next steps (explicit, NOT an automated plan task)

Per the design spec's "Production rollout" subsection (corrected per the Investigation Findings above — the canary lives in `settings.mediaPlannerConfig`, not `settings.collectiveConfig`):

1. Everything in Tasks 1-8 ships behind the canary, default off everywhere (`MEDIA_PLANNER_ENABLED=false` globally, no org has `settings.mediaPlannerConfig.enabled=true`).
2. The user names specific org(s) to enable by setting `Organization.settings.mediaPlannerConfig = { "enabled": true }` for those orgs (direct DB/ops action — this plan does not add an admin API route for it, matching how `settings.collectiveConfig` overrides are set today).
3. The assistant monitors those orgs' `WorkflowExecution` audit records (written by `persistMediaPlanRun()` in `media-planner-repository.ts:67`, confirmed to write to the real `WorkflowExecution` Prisma model at `schema.prisma:1925`) for the planner — turn counts, unmet constraints, judge costs, any thrashing/non-termination signs — and reports back.
4. Only after the user reviews that canary data does `MEDIA_PLANNER_ENABLED` get flipped globally — this step is never taken automatically as part of executing this plan, and is not one of the 8 tasks above.
