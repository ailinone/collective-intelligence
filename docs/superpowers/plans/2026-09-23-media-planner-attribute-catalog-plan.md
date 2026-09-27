<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Attribute-Aware Catalog — Generic Type + 3-Tier Discovery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the video-only, hand-authored `videoCapabilityAttributes` field with a generic `capabilityAttributes` map that covers video/image/document capabilities, backed by a 3-tier trust hierarchy (schema-parsed, empirically-probed, LLM-drafted), and wire it as a real routing pre-filter for images and PDF understanding, plus project it onto `Model.metadata` so `media-planner-gate.ts`'s native-collapse check starts reading real data.

**Architecture:** Generalize the existing `ProviderCatalogEntry`/Zod type pair (types + schema stay in lockstep), keep the 6 already-hand-verified video literals as static, compile-time `source: 'human'` data. Everything discovered at runtime (schema-parsed, probed, LLM-drafted) is **not** something a static TS array can hold — it is persisted in a new Prisma-backed overlay table and merged with the static catalog at read time. A generic predicate dispatches to per-capability matchers (video reused unchanged, image/document new) and excludes `llm_draft` rows. Tier 1 (RunwayML) rides the existing hourly/startup/manual discovery cycle; Tier 2 (empirical probing) is a separate, manually-triggered script that never runs on a schedule; Tier 3 (LLM drafts) surfaces through new admin endpoints with an auto-promotion rule evaluated inside Tier 2's write path.

**Tech Stack:** TypeScript, Zod, Prisma/PostgreSQL, Fastify, Vitest.

---

## Read this before starting — corrections to the spec found during verification

The spec (`docs/superpowers/specs/2026-09-23-media-planner-completion-design.md`, Section B) was checked line-by-line against the actual code in this worktree. Four things do not match the spec's wording and this plan implements the corrected version:

1. **There is no `runwayml-model-fetcher.ts`, and no per-provider fetcher file exists for RunwayML at all.** RunwayML's catalog row (`providers.catalog.ts:1173-1235`) declares `integrationMode: 'execution-only'` with a `pinnedFallback` model list. Per `catalog-provider-plugin.ts:150-196` and `central-model-discovery-service.ts:2092-2121`, `execution-only` providers are **explicitly exempted from fetcher construction** — no `/models` HTTP probe ever happens for them. RunwayML's model list is instead synthesized on every discovery cycle by a generic closure inside `central-model-discovery-service.ts#addCatalogProviderSources()` (the `isExecutionOnly && pinnedModels` branch, `central-model-discovery-service.ts:2166-2189`). Task 6 below hooks Tier 1 into *that* closure, not into a fetcher file, since no fetcher file exists to extend.
2. **RunwayML has no live-fetchable JSON-Schema/OpenAPI HTTP endpoint in this codebase.** The adapter (`runwayml-adapter.ts`) hard-codes `STATIC_MODELS` and a `DEFAULT_API_VERSION = '2024-11-06'` sent via the `X-Runway-Version` header; there is no code path that fetches a schema document at runtime. "Tier 1 schema parsing" for RunwayML is implemented as a small, versioned, hand-transcribed parameter table (duration bounds + ratio enum, keyed by API version) — this **is** RunwayML's real documented, versioned parameter contract (the spec's own definition of Tier 1 — "a documented parameter list with enums/min/max"), just not something fetched over HTTP. It is treated as ground truth (`source: 'schema'`) and reviewed only when `X-Runway-Version` changes, never inferred.
3. **`ProviderCatalogEntry` is a static, compiled TypeScript array (`PROVIDER_CATALOG` in `providers.catalog.ts`) — nothing can write to it at runtime.** The spec talks about Tier 1/2/3 "writing a `ProviderCatalogEntry.capabilityAttributes` entry," which is impossible for anything other than the 6 hand-authored literals compiled into the file. This plan introduces a new Prisma table (`ProviderCapabilityAttributeRecord`) as the actual persistence layer for schema/probed/draft/promoted attribute records, with a merge-read function that checks the static catalog first (the 6 hand-authored rows) and falls back to the DB overlay for everything else. This is additive infrastructure the spec doesn't mention but is required to make Tier 1/2/3 real.
4. **`ProviderCatalogEntrySchema` in `provider-catalog.schema.ts` uses `.strict()`** (`provider-catalog.schema.ts:215-277`), and it currently declares `videoCapabilityAttributes` explicitly (line 277). The spec never mentions this file. Any rename/generalization of the type without a matching Zod schema change fails `provider-catalog.schema.test.ts`'s "the real `PROVIDER_CATALOG` passes validation" test at import time. Task 2 updates this file.
5. **`pdf-service.ts` does not do its own capability-based candidate selection** the way `video-orchestration-service.ts`/`images-orchestration-service.ts` do — it hands a `ChatRequest` with `model: 'auto'` straight to the generic `orchestration-engine.ts`. Task 11 adds a minimal, explicit-model pre-filter step ahead of that call rather than rewriting the engine's generic selection.
6. The spec's type is called `Capability`; the codebase's real type is `ModelCapability` (`api/src/types/index.ts:82-160`, includes `pdf_understanding`, `image_generation`, `image_editing`, `video_generation`). This plan uses `ModelCapability` throughout.

None of this changes the shape of what section B ships — attribute-aware routing for video/image/document, a 3-tier trust hierarchy, admin promotion endpoints — it changes *where* the code plugs in.

---

## File map

| File | Change |
|---|---|
| `api/src/providers/catalog/provider-catalog.types.ts` | Add `source` to `VideoCapabilityAttributes`; add `ImageCapabilityAttributes`, `DocumentCapabilityAttributes`, `CapabilityAttributes`; generalize `ProviderCatalogEntry.capabilityAttributes` |
| `api/src/providers/catalog/provider-catalog.schema.ts` | Mirror the above in Zod |
| `api/src/providers/catalog/providers.catalog.ts` | Migrate 6 `videoCapabilityAttributes` literals to `capabilityAttributes: { video_generation: {...} }` |
| `api/src/services/video-orchestration-service.ts` | 3 accessor updates (lines 422, 671-672, 721) |
| `api/src/providers/catalog/image-capability-matcher.ts` | New — image matcher |
| `api/src/providers/catalog/document-capability-matcher.ts` | New — document matcher |
| `api/src/providers/catalog/capability-attribute-matcher.ts` | New — generic dispatcher + `llm_draft` filter |
| `api/prisma/schema.prisma` | New model `ProviderCapabilityAttributeRecord` |
| `api/prisma/migrations/20260923000000_provider_capability_attribute_records/migration.sql` | New migration |
| `api/src/services/catalog/capability-attribute-store.ts` | New — DB read/write + merge-with-static-catalog |
| `api/src/providers/runwayml/runwayml-schema-attributes.ts` | New — Tier 1 versioned parameter table |
| `api/src/services/central-model-discovery-service.ts` | Hook Tier 1 into the execution-only pinned-fallback closure (~line 2166) |
| `api/src/services/catalog/capability-probe-job.ts` | New — Tier 2 probing job (manual trigger only) |
| `api/scripts/probe-capability-attributes.ts` | New — manual CLI entrypoint for Tier 2 |
| `api/src/services/catalog/capability-attribute-draft-service.ts` | New — Tier 3 LLM-draft generation + auto-promotion logic |
| `api/src/routes/admin/catalog-attribute-drafts-admin-routes.ts` | New — admin list/promote endpoints |
| `api/src/index.ts` | Register the new admin route file |
| `api/src/services/catalog/capability-attribute-projection.ts` | New — `Model.metadata.capabilityAttributes` projection |
| `api/src/services/images-orchestration-service.ts` | Pre-filter wiring for `generateImages`/`editImage` |
| `api/src/services/pdf-service.ts` | Pre-filter wiring for `maxPages` |

---

## Task 1: Types — `source`, `ImageCapabilityAttributes`, `DocumentCapabilityAttributes`, generic `capabilityAttributes`

**Files:**
- Modify: `api/src/providers/catalog/provider-catalog.types.ts`
- Test: `api/src/providers/catalog/__tests__/provider-catalog.schema.test.ts` (existing file, run only — no edits in this task)

- [ ] **Step 1: Add `source` to `VideoCapabilityAttributes` and define the new attribute types**

In `provider-catalog.types.ts`, replace the `VideoCapabilityAttributes` interface (currently lines 247-290) with the same interface plus a `source` field, and add the two new attribute interfaces plus the union, directly below it:

```typescript
export interface VideoCapabilityAttributes {
  readonly maxDurationSeconds?: number;
  readonly minDurationSeconds?: number;
  readonly allowedDurationsSeconds?: readonly number[];
  readonly maxResolution?: string;
  readonly supportedAspectRatios?: readonly string[];
  readonly nativeAudioSupport?: boolean;
  readonly attributesVerifiedAt?: string;
  /**
   * Trust tier (LOTE AZ, 2026-09-23 — 3-tier discovery). `'human'` covers the
   * 6 pre-existing hand-authored rows (byteplus, zai, venice, runwayml,
   * siliconflow, aivideoapi) migrated in this same change — they were
   * live-verified against vendor docs, which IS the human tier's bar.
   * `'schema'`/`'probed'` are populated by the Tier 1/Tier 2 discovery jobs.
   * `'llm_draft'` is excluded from `canSatisfyCapabilityAttributes` entirely
   * — see `capability-attribute-matcher.ts`.
   */
  readonly source?: 'schema' | 'probed' | 'llm_draft' | 'human';
}

/**
 * Image generation/editing limits — needed by section D's `edit` action gate
 * as well as this section's image pre-filter. Same "absence = undocumented,
 * never unsupported" contract as `VideoCapabilityAttributes`.
 */
export interface ImageCapabilityAttributes {
  /** Documented output dimension ceiling, e.g. `'2048x2048'`. */
  readonly maxDimensions?: string;
  /** Documented output dimension floor, e.g. `'256x256'`. */
  readonly minDimensions?: string;
  /** Vendor's own enumerated supported output formats (e.g. `['png','jpeg','webp']`). */
  readonly supportedFormats?: readonly string[];
  readonly attributesVerifiedAt?: string;
  readonly source?: 'schema' | 'probed' | 'llm_draft' | 'human';
}

/** Document/PDF understanding limits — used by `pdf-service.ts`'s pre-filter. */
export interface DocumentCapabilityAttributes {
  /** Documented maximum page count the model's context window can absorb. */
  readonly maxPages?: number;
  readonly attributesVerifiedAt?: string;
  readonly source?: 'schema' | 'probed' | 'llm_draft' | 'human';
}

/**
 * Discriminated by the `ModelCapability` key it's stored under in
 * `ProviderCatalogEntry.capabilityAttributes` — there is no explicit
 * `kind` tag because the map key already disambiguates which shape applies.
 */
export type CapabilityAttributes =
  | VideoCapabilityAttributes
  | ImageCapabilityAttributes
  | DocumentCapabilityAttributes;
```

- [ ] **Step 2: Generalize the `ProviderCatalogEntry` field**

Replace the `videoCapabilityAttributes` field (currently lines 409-415) with:

```typescript
  /** Real per-capability, per-provider media limits (duration/resolution/
   *  aspect-ratio/native-audio for video; dimensions/formats for image;
   *  maxPages for document understanding). Every entry carries `source` and
   *  `attributesVerifiedAt`. See `CapabilityAttributes` for the per-capability
   *  shapes and `capability-attribute-matcher.ts#canSatisfyCapabilityAttributes`
   *  for the "absence ≠ unsupported" consuming contract. This field only
   *  holds hand-authored (`source: 'human'`) rows — everything discovered by
   *  the Tier 1/2/3 jobs lives in the `ProviderCapabilityAttributeRecord` DB
   *  table and is merged in by `capability-attribute-store.ts#resolveCapabilityAttributes`,
   *  since this array is a static, compiled TS literal that no runtime job
   *  can write to. */
  readonly capabilityAttributes?: Partial<Record<ModelCapability, CapabilityAttributes>>;
```

Note: `ModelCapability` is not currently imported in this file. Add the import at the top:

```typescript
import type { ModelCapability } from '@/types';
```

- [ ] **Step 3: Type-check**

Run: `cd api && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i "provider-catalog.types\|providers.catalog\|video-orchestration-service"`
Expected: errors listed for `providers.catalog.ts` (still using the old field name — fixed in Task 3) and `video-orchestration-service.ts` (fixed in Task 3). No errors from `provider-catalog.types.ts` itself.

- [ ] **Step 4: Commit**

```bash
git add api/src/providers/catalog/provider-catalog.types.ts
git commit -m "feat(catalog): generalize capability attributes type (video/image/document)"
```

---

## Task 2: Zod schema mirror

**Files:**
- Modify: `api/src/providers/catalog/provider-catalog.schema.ts`
- Test: `api/src/providers/catalog/__tests__/provider-catalog.schema.test.ts`

- [ ] **Step 1: Write the failing test — schema accepts the new field, rejects unknown keys under it**

Add to `api/src/providers/catalog/__tests__/provider-catalog.schema.test.ts` (append near the existing video-attribute tests; check the file for where `VideoCapabilityAttributesSchema`/`videoCapabilityAttributes` is already exercised and place these alongside):

```typescript
import { CapabilityAttributesEntrySchema } from '../provider-catalog.schema';

describe('CapabilityAttributesEntrySchema (generic map)', () => {
  it('accepts a video_generation entry with source and attributesVerifiedAt', () => {
    const result = CapabilityAttributesEntrySchema.safeParse({
      video_generation: {
        maxDurationSeconds: 10,
        source: 'human',
        attributesVerifiedAt: '2026-08-01',
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts an image_generation entry with dimensions/formats/source', () => {
    const result = CapabilityAttributesEntrySchema.safeParse({
      image_generation: {
        maxDimensions: '2048x2048',
        supportedFormats: ['png', 'jpeg'],
        source: 'schema',
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a pdf_understanding entry with maxPages/source', () => {
    const result = CapabilityAttributesEntrySchema.safeParse({
      pdf_understanding: { maxPages: 200, source: 'probed' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown key inside a per-capability attribute object', () => {
    const result = CapabilityAttributesEntrySchema.safeParse({
      video_generation: { maxDurationSeconds: 10, bogusField: 'x' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects source values outside the closed 4-value union', () => {
    const result = CapabilityAttributesEntrySchema.safeParse({
      video_generation: { maxDurationSeconds: 10, source: 'guessed' },
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx vitest run src/providers/catalog/__tests__/provider-catalog.schema.test.ts -t "CapabilityAttributesEntrySchema"`
Expected: FAIL — `CapabilityAttributesEntrySchema` is not exported.

- [ ] **Step 3: Implement the schema**

In `provider-catalog.schema.ts`, add a shared `source` schema, the two new attribute schemas, and the generic map schema, right after the existing `VideoCapabilityAttributesSchema` (currently lines 163-182). Also add `source` to `VideoCapabilityAttributesSchema` itself:

```typescript
// ─── Capability attribute source tier (LOTE AZ, 2026-09-23) ─────────────────

const CapabilityAttributeSourceSchema = z.enum(['schema', 'probed', 'llm_draft', 'human']);

export const VideoCapabilityAttributesSchema = z
  .object({
    maxDurationSeconds: z.number().positive().max(3600).optional(),
    minDurationSeconds: z.number().nonnegative().max(3600).optional(),
    allowedDurationsSeconds: z.array(z.number().positive().max(3600)).min(1).max(20).optional(),
    maxResolution: z.string().min(1).max(24).optional(),
    supportedAspectRatios: z.array(z.string().min(1).max(24)).min(1).max(24).optional(),
    nativeAudioSupport: z.boolean().optional(),
    attributesVerifiedAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'attributesVerifiedAt must be ISO date (YYYY-MM-DD)')
      .optional(),
    source: CapabilityAttributeSourceSchema.optional(),
  })
  .strict();

/** Mirrors `ImageCapabilityAttributes` in provider-catalog.types.ts. */
export const ImageCapabilityAttributesSchema = z
  .object({
    maxDimensions: z.string().min(1).max(24).optional(),
    minDimensions: z.string().min(1).max(24).optional(),
    supportedFormats: z.array(z.string().min(1).max(16)).min(1).max(16).optional(),
    attributesVerifiedAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'attributesVerifiedAt must be ISO date (YYYY-MM-DD)')
      .optional(),
    source: CapabilityAttributeSourceSchema.optional(),
  })
  .strict();

/** Mirrors `DocumentCapabilityAttributes` in provider-catalog.types.ts. */
export const DocumentCapabilityAttributesSchema = z
  .object({
    maxPages: z.number().int().positive().max(100_000).optional(),
    attributesVerifiedAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'attributesVerifiedAt must be ISO date (YYYY-MM-DD)')
      .optional(),
    source: CapabilityAttributeSourceSchema.optional(),
  })
  .strict();

/**
 * Generic per-entry map, keyed by `ModelCapability` string. Not modeled as a
 * true discriminated union keyed off a `kind` tag — the map KEY is the
 * discriminant (`video_generation` -> video shape, etc.) — so this uses a
 * permissive per-key union and relies on callers keying correctly, mirroring
 * `ProviderCatalogEntry.capabilityAttributes`'s TS shape (`Partial<Record<...>>`).
 * Zod has no native "validate value shape based on sibling key name" — this
 * is intentionally checked defensively per known key instead.
 */
export const CapabilityAttributesEntrySchema = z
  .object({
    video_generation: VideoCapabilityAttributesSchema.optional(),
    image_generation: ImageCapabilityAttributesSchema.optional(),
    image_editing: ImageCapabilityAttributesSchema.optional(),
    pdf_understanding: DocumentCapabilityAttributesSchema.optional(),
  })
  .strict();
```

Then replace the `videoCapabilityAttributes: VideoCapabilityAttributesSchema.optional(),` line (currently line 277) with:

```typescript
    capabilityAttributes: CapabilityAttributesEntrySchema.optional(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && npx vitest run src/providers/catalog/__tests__/provider-catalog.schema.test.ts`
Expected: PASS, including the pre-existing "the real `PROVIDER_CATALOG` passes validation" test — this will still fail until Task 3 migrates the 6 literals off `videoCapabilityAttributes`. If it fails only on that pre-existing test at this point, that is expected; re-run after Task 3.

- [ ] **Step 5: Commit**

```bash
git add api/src/providers/catalog/provider-catalog.schema.ts api/src/providers/catalog/__tests__/provider-catalog.schema.test.ts
git commit -m "feat(catalog): mirror generic capabilityAttributes in Zod schema"
```

---

## Task 3: Migrate the 6 hand-authored literals + fix video-orchestration-service.ts accessors

**Files:**
- Modify: `api/src/providers/catalog/providers.catalog.ts` (6 sites: lines 676, 1219, 1293, 3424, 3496, 4307 — providers `zai`, `runwayml`, `aivideoapi`, `siliconflow`, `venice`, `byteplus`, respectively, confirmed against the current file)
- Modify: `api/src/services/video-orchestration-service.ts` (lines 422, 671-672, 721)
- Test: `api/src/providers/catalog/__tests__/provider-catalog.schema.test.ts`, `api/src/providers/catalog/__tests__/video-capability-matcher.test.ts`, `api/src/services/__tests__/video-orchestration-service.test.ts`

- [ ] **Step 1: Migrate each of the 6 literals**

For each of the 6 sites, change the shape from:

```typescript
    videoCapabilityAttributes: {
      maxDurationSeconds: 10,
      minDurationSeconds: 2,
      maxResolution: '1584x672',
      supportedAspectRatios: ['1280:720', '720:1280', '1104:832', '960:960', '832:1104', '1584:672'],
      nativeAudioSupport: false,
    },
```

(RunwayML's literal shown as the concrete example — the other 5 keep their existing field values unchanged) to:

```typescript
    capabilityAttributes: {
      video_generation: {
        maxDurationSeconds: 10,
        minDurationSeconds: 2,
        maxResolution: '1584x672',
        supportedAspectRatios: ['1280:720', '720:1280', '1104:832', '960:960', '832:1104', '1584:672'],
        nativeAudioSupport: false,
        source: 'human',
      },
    },
```

Apply the same `videoCapabilityAttributes: { ... }` → `capabilityAttributes: { video_generation: { ..., source: 'human' } }` transform to the other 5 sites (`zai` at line 676, `aivideoapi` at line 1293, `siliconflow` at line 3424, `venice` at line 3496, `byteplus` at line 4307), preserving every existing field value verbatim — only the wrapper and the added `source: 'human'` line change.

- [ ] **Step 2: Fix the 3 read-sites in `video-orchestration-service.ts`**

Line 422 — inside `selectVideoCandidateModels`'s pre-filter (currently):

```typescript
        canSatisfyVideoAttributes(
          this.getCatalogEntry(model.provider)?.videoCapabilityAttributes,
          requestAttrs
        )
```

becomes:

```typescript
        canSatisfyVideoAttributes(
          this.getCatalogEntry(model.provider)?.capabilityAttributes?.video_generation,
          requestAttrs
        )
```

Lines 671-672 (currently):

```typescript
      const selectedAttrs = this.getCatalogEntry(result.selectedModel.provider)
        ?.videoCapabilityAttributes;
```

becomes:

```typescript
      const selectedAttrs = this.getCatalogEntry(result.selectedModel.provider)
        ?.capabilityAttributes?.video_generation;
```

Line 721 (currently):

```typescript
      const attrs = this.getCatalogEntry(result.selectedModel.provider)?.videoCapabilityAttributes;
```

becomes:

```typescript
      const attrs = this.getCatalogEntry(result.selectedModel.provider)?.capabilityAttributes?.video_generation;
```

- [ ] **Step 3: Run the full verification suite for this task**

Run: `cd api && npx vitest run src/providers/catalog/__tests__/provider-catalog.schema.test.ts src/providers/catalog/__tests__/video-capability-matcher.test.ts src/services/__tests__/video-orchestration-service.test.ts`
Expected: PASS — all 3 suites, including the schema test's "the real `PROVIDER_CATALOG` passes validation" assertion (now that no entry references the removed field name).

- [ ] **Step 4: Confirm no remaining references to the old field name**

Run: `cd api && grep -rn "videoCapabilityAttributes" src --include="*.ts"`
Expected: no output (the only prior non-comment reference in `media-generation-spec.ts` is a doc comment — confirm it still reads sensibly, no edit required there since it doesn't reference actual code).

- [ ] **Step 5: Commit**

```bash
git add api/src/providers/catalog/providers.catalog.ts api/src/services/video-orchestration-service.ts
git commit -m "refactor(catalog): migrate 6 hand-authored video literals to generic capabilityAttributes"
```

---

## Task 4: Generic predicate + image/document matchers

**Files:**
- Create: `api/src/providers/catalog/image-capability-matcher.ts`
- Create: `api/src/providers/catalog/document-capability-matcher.ts`
- Create: `api/src/providers/catalog/capability-attribute-matcher.ts`
- Test: `api/src/providers/catalog/__tests__/image-capability-matcher.test.ts`
- Test: `api/src/providers/catalog/__tests__/document-capability-matcher.test.ts`
- Test: `api/src/providers/catalog/__tests__/capability-attribute-matcher.test.ts`

- [ ] **Step 1: Write the failing tests for the image matcher**

Create `api/src/providers/catalog/__tests__/image-capability-matcher.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { canSatisfyImageAttributes, parseDimensions } from '../image-capability-matcher';

describe('parseDimensions', () => {
  it('parses "2048x2048" into width/height', () => {
    expect(parseDimensions('2048x2048')).toEqual({ width: 2048, height: 2048 });
  });
  it('returns null for an unparseable string', () => {
    expect(parseDimensions('huge')).toBeNull();
  });
});

describe('canSatisfyImageAttributes', () => {
  it('fails open when attrs is undefined', () => {
    expect(canSatisfyImageAttributes(undefined, { width: 4096, height: 4096 })).toBe(true);
  });

  it('fails open when the declared maxDimensions is unparseable', () => {
    expect(
      canSatisfyImageAttributes({ maxDimensions: 'huge' }, { width: 4096, height: 4096 })
    ).toBe(true);
  });

  it('rejects a request exceeding the declared maxDimensions', () => {
    expect(
      canSatisfyImageAttributes({ maxDimensions: '1024x1024' }, { width: 2048, height: 2048 })
    ).toBe(false);
  });

  it('accepts a request within the declared maxDimensions', () => {
    expect(
      canSatisfyImageAttributes({ maxDimensions: '2048x2048' }, { width: 1024, height: 1024 })
    ).toBe(true);
  });

  it('rejects a requested format absent from a declared, non-empty supportedFormats list', () => {
    expect(
      canSatisfyImageAttributes({ supportedFormats: ['png', 'jpeg'] }, { format: 'webp' })
    ).toBe(false);
  });

  it('accepts when no format was requested even if supportedFormats is declared', () => {
    expect(canSatisfyImageAttributes({ supportedFormats: ['png'] }, {})).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx vitest run src/providers/catalog/__tests__/image-capability-matcher.test.ts`
Expected: FAIL — module `../image-capability-matcher` does not exist.

- [ ] **Step 3: Implement the image matcher**

Create `api/src/providers/catalog/image-capability-matcher.ts`:

```typescript
/**
 * Image capability attribute matcher — LOTE AZ (2026-09-23).
 *
 * Same fail-open/fail-closed contract as `video-capability-matcher.ts`: a
 * field the catalog doesn't declare is UNKNOWN, never "unsupported". Only a
 * PRESENT, documented limit the request clearly exceeds excludes a candidate.
 */
import type { ImageCapabilityAttributes } from './provider-catalog.types';

export interface ImageAttributeRequest {
  readonly width?: number;
  readonly height?: number;
  readonly format?: string;
}

/** Parses a `'WIDTHxHEIGHT'` string. Returns `null` when unparseable. */
export function parseDimensions(value: string): { width: number; height: number } | null {
  const match = value.trim().toLowerCase().match(/^(\d+)\s*x\s*(\d+)$/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
}

export function canSatisfyImageAttributes(
  attrs: ImageCapabilityAttributes | undefined,
  request: ImageAttributeRequest
): boolean {
  if (!attrs) return true;

  if (
    (request.width !== undefined || request.height !== undefined) &&
    attrs.maxDimensions !== undefined
  ) {
    const max = parseDimensions(attrs.maxDimensions);
    // An unparseable catalog value never causes a rejection by itself.
    if (max) {
      if (request.width !== undefined && request.width > max.width) return false;
      if (request.height !== undefined && request.height > max.height) return false;
    }
  }

  if (
    (request.width !== undefined || request.height !== undefined) &&
    attrs.minDimensions !== undefined
  ) {
    const min = parseDimensions(attrs.minDimensions);
    if (min) {
      if (request.width !== undefined && request.width < min.width) return false;
      if (request.height !== undefined && request.height < min.height) return false;
    }
  }

  if (
    request.format !== undefined &&
    attrs.supportedFormats &&
    attrs.supportedFormats.length > 0
  ) {
    const requested = request.format.trim().toLowerCase();
    const satisfied = attrs.supportedFormats.some((f) => f.trim().toLowerCase() === requested);
    if (!satisfied) return false;
  }

  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && npx vitest run src/providers/catalog/__tests__/image-capability-matcher.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing tests for the document matcher**

Create `api/src/providers/catalog/__tests__/document-capability-matcher.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { canSatisfyDocumentAttributes } from '../document-capability-matcher';

describe('canSatisfyDocumentAttributes', () => {
  it('fails open when attrs is undefined', () => {
    expect(canSatisfyDocumentAttributes(undefined, { pageCount: 500 })).toBe(true);
  });

  it('fails open when maxPages is undeclared', () => {
    expect(canSatisfyDocumentAttributes({ source: 'human' }, { pageCount: 500 })).toBe(true);
  });

  it('rejects a request exceeding the declared maxPages', () => {
    expect(canSatisfyDocumentAttributes({ maxPages: 100 }, { pageCount: 200 })).toBe(false);
  });

  it('accepts a request within the declared maxPages', () => {
    expect(canSatisfyDocumentAttributes({ maxPages: 200 }, { pageCount: 100 })).toBe(true);
  });
});
```

- [ ] **Step 6: Run test to verify it fails, then implement**

Run: `cd api && npx vitest run src/providers/catalog/__tests__/document-capability-matcher.test.ts`
Expected: FAIL — module does not exist.

Create `api/src/providers/catalog/document-capability-matcher.ts`:

```typescript
/**
 * Document/PDF capability attribute matcher — LOTE AZ (2026-09-23).
 * Same fail-open/fail-closed contract as the video/image matchers.
 */
import type { DocumentCapabilityAttributes } from './provider-catalog.types';

export interface DocumentAttributeRequest {
  readonly pageCount?: number;
}

export function canSatisfyDocumentAttributes(
  attrs: DocumentCapabilityAttributes | undefined,
  request: DocumentAttributeRequest
): boolean {
  if (!attrs) return true;
  if (request.pageCount !== undefined && attrs.maxPages !== undefined) {
    if (request.pageCount > attrs.maxPages) return false;
  }
  return true;
}
```

Run: `cd api && npx vitest run src/providers/catalog/__tests__/document-capability-matcher.test.ts`
Expected: PASS.

- [ ] **Step 7: Write the failing tests for the generic dispatcher**

Create `api/src/providers/catalog/__tests__/capability-attribute-matcher.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { canSatisfyCapabilityAttributes } from '../capability-attribute-matcher';

describe('canSatisfyCapabilityAttributes', () => {
  it('dispatches video_generation to the video matcher (rejects over-duration)', () => {
    const result = canSatisfyCapabilityAttributes(
      'video_generation',
      { maxDurationSeconds: 5, source: 'human' },
      { durationSeconds: 10 }
    );
    expect(result).toBe(false);
  });

  it('dispatches image_generation to the image matcher (rejects over-dimension)', () => {
    const result = canSatisfyCapabilityAttributes(
      'image_generation',
      { maxDimensions: '512x512', source: 'human' },
      { width: 1024, height: 1024 }
    );
    expect(result).toBe(false);
  });

  it('dispatches pdf_understanding to the document matcher (rejects over-pages)', () => {
    const result = canSatisfyCapabilityAttributes(
      'pdf_understanding',
      { maxPages: 50, source: 'human' },
      { pageCount: 100 }
    );
    expect(result).toBe(false);
  });

  it('excludes llm_draft-sourced attributes from matching — treated as absent (fail-open)', () => {
    const result = canSatisfyCapabilityAttributes(
      'video_generation',
      { maxDurationSeconds: 5, source: 'llm_draft' },
      { durationSeconds: 999 }
    );
    expect(result).toBe(true);
  });

  it('fails open for a capability with no matcher registered', () => {
    const result = canSatisfyCapabilityAttributes(
      'chat' as never,
      { source: 'human' } as never,
      {}
    );
    expect(result).toBe(true);
  });
});
```

- [ ] **Step 8: Run test to verify it fails, then implement**

Run: `cd api && npx vitest run src/providers/catalog/__tests__/capability-attribute-matcher.test.ts`
Expected: FAIL — module does not exist.

Create `api/src/providers/catalog/capability-attribute-matcher.ts`:

```typescript
/**
 * Generic capability-attribute predicate — LOTE AZ (2026-09-23).
 *
 * Dispatches to the per-capability matcher based on the `capability` key
 * (the map key IS the discriminant — see `CapabilityAttributes`'s doc
 * comment in provider-catalog.types.ts). Enforces one cross-cutting rule
 * ahead of dispatch: an `llm_draft`-sourced attribute object is NEVER used
 * to accept or reject a candidate — it is treated as if it were absent
 * (fail-open), exactly like an undeclared field. Drafts only ever reach a
 * human via the admin endpoints in `catalog-attribute-drafts-admin-routes.ts`.
 */
import type { ModelCapability } from '@/types';
import type { CapabilityAttributes } from './provider-catalog.types';
import {
  canSatisfyVideoAttributes,
  type VideoAttributeRequest,
} from './video-capability-matcher';
import {
  canSatisfyImageAttributes,
  type ImageAttributeRequest,
} from './image-capability-matcher';
import {
  canSatisfyDocumentAttributes,
  type DocumentAttributeRequest,
} from './document-capability-matcher';

export type CapabilityAttributeRequest =
  | VideoAttributeRequest
  | ImageAttributeRequest
  | DocumentAttributeRequest;

export function canSatisfyCapabilityAttributes(
  capability: ModelCapability,
  attrs: CapabilityAttributes | undefined,
  request: CapabilityAttributeRequest
): boolean {
  const effectiveAttrs = attrs && attrs.source === 'llm_draft' ? undefined : attrs;

  switch (capability) {
    case 'video_generation':
      return canSatisfyVideoAttributes(effectiveAttrs, request as VideoAttributeRequest);
    case 'image_generation':
    case 'image_editing':
      return canSatisfyImageAttributes(effectiveAttrs, request as ImageAttributeRequest);
    case 'pdf_understanding':
      return canSatisfyDocumentAttributes(effectiveAttrs, request as DocumentAttributeRequest);
    default:
      // No matcher registered for this capability yet — fail open, same
      // convention as an undeclared field within a known matcher.
      return true;
  }
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `cd api && npx vitest run src/providers/catalog/__tests__/capability-attribute-matcher.test.ts src/providers/catalog/__tests__/image-capability-matcher.test.ts src/providers/catalog/__tests__/document-capability-matcher.test.ts`
Expected: PASS — all 3 suites.

- [ ] **Step 10: Commit**

```bash
git add api/src/providers/catalog/image-capability-matcher.ts \
        api/src/providers/catalog/document-capability-matcher.ts \
        api/src/providers/catalog/capability-attribute-matcher.ts \
        api/src/providers/catalog/__tests__/image-capability-matcher.test.ts \
        api/src/providers/catalog/__tests__/document-capability-matcher.test.ts \
        api/src/providers/catalog/__tests__/capability-attribute-matcher.test.ts
git commit -m "feat(catalog): generic capability-attribute predicate + image/document matchers"
```

---

## Task 5: Persistence overlay — Prisma model + `capability-attribute-store.ts`

This is the infrastructure the spec assumes exists but doesn't (see correction #3 above): a place for Tier 1/2/3 to actually write, since `PROVIDER_CATALOG` is a compiled TS literal.

**Files:**
- Modify: `api/prisma/schema.prisma`
- Create: `api/prisma/migrations/20260923000000_provider_capability_attribute_records/migration.sql`
- Create: `api/src/services/catalog/capability-attribute-store.ts`
- Test: `api/src/services/catalog/__tests__/capability-attribute-store.test.ts`

- [ ] **Step 1: Add the Prisma model**

In `api/prisma/schema.prisma`, add near `DiscoveryLog` (currently lines 1180-1193):

```prisma
// ============================================
// Provider capability attributes — 3-tier discovery (LOTE AZ, 2026-09-23)
// ============================================

// Overlay for `ProviderCatalogEntry.capabilityAttributes` entries that were
// NOT hand-authored into the static `providers.catalog.ts` literal — i.e.
// everything Tier 1 (schema-parsed), Tier 2 (empirically-probed), or Tier 3
// (LLM-drafted / human-promoted) writes. Read via
// `capability-attribute-store.ts#resolveCapabilityAttributes`, which checks
// the static catalog first and falls back to this table. Multiple rows can
// exist for the same (provider_id, capability) with DIFFERENT sources at
// once — e.g. a trusted `probed` row and a stale, disagreeing `llm_draft`
// row both stay visible (see the design's Tier 3 promotion-disagreement
// rule) — so there is deliberately no unique constraint narrower than `id`.
model ProviderCapabilityAttributeRecord {
  id                 String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  providerId         String    @map("provider_id") @db.VarChar(64)
  capability         String    @db.VarChar(64) // ModelCapability value, e.g. 'video_generation'
  source             String    @db.VarChar(16) // 'schema' | 'probed' | 'llm_draft' | 'human'
  attributes         Json // the CapabilityAttributes object (minus source/attributesVerifiedAt, which are columns)
  attributesVerifiedAt DateTime? @map("attributes_verified_at")
  /** Set only for a promoted (`source` rewritten to 'human') Tier 3 draft — records the promotion reason. */
  promotionNote      String?   @map("promotion_note")
  createdAt          DateTime  @default(now()) @map("created_at")
  updatedAt          DateTime  @updatedAt @map("updated_at")

  @@index([providerId, capability])
  @@index([source])
  @@map("provider_capability_attribute_records")
}
```

- [ ] **Step 2: Write the migration SQL by hand**

Create `api/prisma/migrations/20260923000000_provider_capability_attribute_records/migration.sql`:

```sql
-- Provider capability attributes 3-tier discovery overlay (LOTE AZ, 2026-09-23).
-- See ProviderCapabilityAttributeRecord's doc comment in schema.prisma for why
-- this table exists (the static providers.catalog.ts array cannot be written
-- to at runtime) and why there is no unique constraint narrower than id (a
-- 'probed' row and a disagreeing 'llm_draft' row for the same
-- provider_id+capability must be able to coexist).

CREATE TABLE "provider_capability_attribute_records" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "provider_id" VARCHAR(64) NOT NULL,
  "capability" VARCHAR(64) NOT NULL,
  "source" VARCHAR(16) NOT NULL,
  "attributes" JSONB NOT NULL,
  "attributes_verified_at" TIMESTAMP(3),
  "promotion_note" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "provider_capability_attribute_records_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "provider_capability_attribute_records_provider_id_capability_idx"
  ON "provider_capability_attribute_records" ("provider_id", "capability");

CREATE INDEX "provider_capability_attribute_records_source_idx"
  ON "provider_capability_attribute_records" ("source");
```

- [ ] **Step 3: Regenerate the Prisma client**

Run: `cd api && npx prisma generate`
Expected: succeeds, `ProviderCapabilityAttributeRecord` now available on `prisma.providerCapabilityAttributeRecord` in `@/generated/prisma`.

- [ ] **Step 4: Write the failing tests for the store**

Create `api/src/services/catalog/__tests__/capability-attribute-store.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach } from 'vitest';

const findManyMock = vi.fn();
const createMock = vi.fn();
const updateMock = vi.fn();

vi.mock('@/database/client', () => ({
  prisma: {
    providerCapabilityAttributeRecord: {
      findMany: findManyMock,
      create: createMock,
      update: updateMock,
    },
  },
}));

vi.mock('@/providers/catalog/providers.catalog', () => ({
  PROVIDER_CATALOG: [
    {
      providerId: 'runwayml',
      capabilityAttributes: {
        video_generation: { maxDurationSeconds: 10, source: 'human' },
      },
    },
    { providerId: 'some-other-provider' },
  ],
}));

import {
  resolveCapabilityAttributes,
  writeCapabilityAttributeRecord,
} from '../capability-attribute-store';

beforeEach(() => {
  findManyMock.mockReset();
  createMock.mockReset();
  updateMock.mockReset();
});

describe('resolveCapabilityAttributes', () => {
  it('returns the static catalog entry when one exists, without querying the DB', async () => {
    const result = await resolveCapabilityAttributes('runwayml', 'video_generation');
    expect(result).toEqual({ maxDurationSeconds: 10, source: 'human' });
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it('falls back to the highest-trust non-draft DB row when no static entry exists', async () => {
    findManyMock.mockResolvedValue([
      {
        source: 'llm_draft',
        attributes: { maxDurationSeconds: 8 },
        attributesVerifiedAt: null,
      },
      {
        source: 'probed',
        attributes: { maxDurationSeconds: 9 },
        attributesVerifiedAt: new Date('2026-09-01'),
      },
    ]);
    const result = await resolveCapabilityAttributes('some-other-provider', 'video_generation');
    expect(result).toEqual({
      maxDurationSeconds: 9,
      source: 'probed',
      attributesVerifiedAt: '2026-09-01',
    });
  });

  it('returns undefined when no static entry and no DB rows exist', async () => {
    findManyMock.mockResolvedValue([]);
    const result = await resolveCapabilityAttributes('unknown-provider', 'video_generation');
    expect(result).toBeUndefined();
  });
});

describe('writeCapabilityAttributeRecord', () => {
  it('creates a new row for a given provider+capability+source', async () => {
    createMock.mockResolvedValue({ id: 'new-id' });
    await writeCapabilityAttributeRecord({
      providerId: 'fal-ai',
      capability: 'video_generation',
      source: 'schema',
      attributes: { maxDurationSeconds: 12 },
      attributesVerifiedAt: '2026-09-23',
    });
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          providerId: 'fal-ai',
          capability: 'video_generation',
          source: 'schema',
        }),
      })
    );
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `cd api && npx vitest run src/services/catalog/__tests__/capability-attribute-store.test.ts`
Expected: FAIL — module `../capability-attribute-store` does not exist.

- [ ] **Step 6: Implement the store**

Create `api/src/services/catalog/capability-attribute-store.ts`:

```typescript
/**
 * Capability-attribute persistence overlay — LOTE AZ (2026-09-23).
 *
 * `ProviderCatalogEntry.capabilityAttributes` (provider-catalog.types.ts) is
 * a static, compiled TS literal — nothing at runtime can write to it. This
 * module is the actual write target for the Tier 1 (schema), Tier 2
 * (probed), and Tier 3 (llm_draft / human-promoted) discovery jobs, and the
 * single merge-read function every consumer (matchers, the projection job,
 * the admin endpoints) should call instead of reading the catalog directly
 * for anything other than the 6 hand-authored rows.
 *
 * Trust order on read (highest first): the static catalog's own `source:
 * 'human'` literal (if the provider has one) wins outright — those rows were
 * hand-verified against vendor docs and are never overridden by a
 * lower-trust runtime discovery result. Otherwise, among DB rows for the
 * same (providerId, capability), pick the highest-trust non-draft row:
 * human > probed > schema. `llm_draft` rows are NEVER returned by this
 * function — they only surface via the admin draft-review endpoints.
 */
import { prisma } from '@/database/client';
import { PROVIDER_CATALOG } from '@/providers/catalog/providers.catalog';
import type { CapabilityAttributes } from '@/providers/catalog/provider-catalog.types';
import type { ModelCapability } from '@/types';

const TRUST_RANK: Record<string, number> = { human: 3, probed: 2, schema: 1 };

function toIsoDate(value: Date | null | undefined): string | undefined {
  if (!value) return undefined;
  return value.toISOString().slice(0, 10);
}

export async function resolveCapabilityAttributes(
  providerId: string,
  capability: ModelCapability
): Promise<CapabilityAttributes | undefined> {
  const staticEntry = PROVIDER_CATALOG.find((e) => e.providerId === providerId);
  const staticAttrs = staticEntry?.capabilityAttributes?.[capability];
  if (staticAttrs) return staticAttrs;

  const rows = await prisma.providerCapabilityAttributeRecord.findMany({
    where: { providerId, capability },
  });

  const nonDraft = rows.filter((r) => r.source !== 'llm_draft');
  if (nonDraft.length === 0) return undefined;

  const best = nonDraft.reduce((a, b) =>
    (TRUST_RANK[b.source] ?? 0) > (TRUST_RANK[a.source] ?? 0) ? b : a
  );

  return {
    ...(best.attributes as Record<string, unknown>),
    source: best.source as CapabilityAttributes['source'],
    attributesVerifiedAt: toIsoDate(best.attributesVerifiedAt),
  } as CapabilityAttributes;
}

export interface WriteCapabilityAttributeRecordInput {
  readonly providerId: string;
  readonly capability: ModelCapability;
  readonly source: 'schema' | 'probed' | 'llm_draft' | 'human';
  readonly attributes: Record<string, unknown>;
  readonly attributesVerifiedAt?: string;
}

export async function writeCapabilityAttributeRecord(
  input: WriteCapabilityAttributeRecordInput
): Promise<{ id: string }> {
  const created = await prisma.providerCapabilityAttributeRecord.create({
    data: {
      providerId: input.providerId,
      capability: input.capability,
      source: input.source,
      attributes: input.attributes,
      attributesVerifiedAt: input.attributesVerifiedAt
        ? new Date(input.attributesVerifiedAt)
        : undefined,
    },
  });
  return { id: created.id };
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `cd api && npx vitest run src/services/catalog/__tests__/capability-attribute-store.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add api/prisma/schema.prisma \
        api/prisma/migrations/20260923000000_provider_capability_attribute_records \
        api/src/services/catalog/capability-attribute-store.ts \
        api/src/services/catalog/__tests__/capability-attribute-store.test.ts
git commit -m "feat(catalog): add provider_capability_attribute_records overlay table + store"
```

---

## Task 6: Tier 1 — RunwayML versioned schema parser, wired into the existing discovery cycle

**Files:**
- Create: `api/src/providers/runwayml/runwayml-schema-attributes.ts`
- Modify: `api/src/services/central-model-discovery-service.ts` (inside `addCatalogProviderSources()`'s `isExecutionOnly` fetcher closure, currently lines 2166-2189)
- Test: `api/src/providers/runwayml/__tests__/runwayml-schema-attributes.test.ts`
- Test: `api/src/services/__tests__/central-model-discovery-service-runwayml-tier1.test.ts`

- [ ] **Step 1: Write the failing test for the schema table**

Create `api/src/providers/runwayml/__tests__/runwayml-schema-attributes.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { getRunwaymlSchemaCapabilityAttributes } from '../runwayml-schema-attributes';

describe('getRunwaymlSchemaCapabilityAttributes', () => {
  it('returns the documented 2024-11-06 parameter contract with source: schema', () => {
    const attrs = getRunwaymlSchemaCapabilityAttributes('2024-11-06');
    expect(attrs).toMatchObject({
      maxDurationSeconds: 10,
      minDurationSeconds: 2,
      nativeAudioSupport: false,
      source: 'schema',
    });
    expect(attrs?.supportedAspectRatios).toContain('1280:720');
  });

  it('returns undefined for an unrecognized API version rather than guessing', () => {
    expect(getRunwaymlSchemaCapabilityAttributes('1999-01-01')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx vitest run src/providers/runwayml/__tests__/runwayml-schema-attributes.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the schema table**

Create `api/src/providers/runwayml/runwayml-schema-attributes.ts`:

```typescript
/**
 * RunwayML Tier 1 attribute source — LOTE AZ (2026-09-23).
 *
 * RunwayML has no live-fetchable JSON-Schema/OpenAPI HTTP endpoint in this
 * codebase (confirmed against `runwayml-adapter.ts`, which hard-codes
 * `STATIC_MODELS` and posts directly to `/v1/image_to_video` with no schema
 * probe). What it DOES publish is a real, documented, VERSIONED
 * request-parameter contract — the `duration`/`ratio` enums this table
 * encodes — gated by the `X-Runway-Version` header the adapter already
 * sends (`DEFAULT_API_VERSION = '2024-11-06'`). That versioned contract is
 * exactly what the design's Tier 1 definition means by "a documented
 * parameter list with enums/min/max": ground truth, no inference. This
 * table is reviewed and extended only when RunwayML ships a new
 * `X-Runway-Version` — never runtime-fetched, since there is nothing to fetch.
 *
 * Values as of 2024-11-06 match the pre-existing hand-verified
 * `providers.catalog.ts` runwayml literal (live-verified 2026-08-01, LOTE AS)
 * — this table doesn't change what RunwayML can do, it changes how that
 * fact enters the system: `source: 'schema'` instead of a one-off hand edit.
 */
import type { VideoCapabilityAttributes } from '../catalog/provider-catalog.types';

const RUNWAY_SCHEMA_BY_API_VERSION: Record<string, Omit<VideoCapabilityAttributes, 'source'>> = {
  '2024-11-06': {
    maxDurationSeconds: 10,
    minDurationSeconds: 2,
    maxResolution: '1584x672',
    supportedAspectRatios: ['1280:720', '720:1280', '1104:832', '960:960', '832:1104', '1584:672'],
    nativeAudioSupport: false,
  },
};

export function getRunwaymlSchemaCapabilityAttributes(
  apiVersion: string
): VideoCapabilityAttributes | undefined {
  const base = RUNWAY_SCHEMA_BY_API_VERSION[apiVersion];
  if (!base) return undefined;
  return { ...base, source: 'schema', attributesVerifiedAt: new Date().toISOString().slice(0, 10) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && npx vitest run src/providers/runwayml/__tests__/runwayml-schema-attributes.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test for the discovery-cycle hook**

Create `api/src/services/__tests__/central-model-discovery-service-runwayml-tier1.test.ts`. This test exercises the exact closure at `central-model-discovery-service.ts:2142-2189` by calling the public `discoverAllModels()` surface is too heavy for a unit test (it touches the whole service); instead, test the extracted pure helper directly (introduced in Step 6 below) rather than the closure itself:

```typescript
import { describe, expect, it } from 'vitest';
import { attachRunwaymlTier1Metadata } from '../central-model-discovery-service-runwayml-helper';

describe('attachRunwaymlTier1Metadata', () => {
  it('attaches capabilityAttributes.video_generation with source: schema for runwayml', () => {
    const model = {
      id: 'gen3a_turbo',
      name: 'gen3a_turbo',
      displayName: 'gen3a_turbo',
      contextWindow: 0,
      maxOutputTokens: 0,
      capabilities: ['video_generation'],
      metadata: { originalProvider: 'runwayml' },
    };
    const result = attachRunwaymlTier1Metadata('runwayml', model);
    expect(result.metadata).toMatchObject({
      originalProvider: 'runwayml',
      capabilityAttributes: {
        video_generation: { maxDurationSeconds: 10, source: 'schema' },
      },
    });
  });

  it('is a no-op for any provider other than runwayml', () => {
    const model = { id: 'x', metadata: { foo: 'bar' } };
    const result = attachRunwaymlTier1Metadata('some-other-provider', model);
    expect(result).toBe(model);
  });
});
```

- [ ] **Step 6: Run test to verify it fails, then implement the helper and wire it in**

Run: `cd api && npx vitest run src/services/__tests__/central-model-discovery-service-runwayml-tier1.test.ts`
Expected: FAIL — module does not exist.

Create `api/src/services/central-model-discovery-service-runwayml-helper.ts` (a small, separately-testable pure function, kept out of the 4000+ line service file on purpose):

```typescript
/**
 * Pure helper extracted so Tier 1's RunwayML hook (LOTE AZ, 2026-09-23) is
 * unit-testable without exercising the whole `discoverAllModels()` pipeline.
 * Called from `central-model-discovery-service.ts#addCatalogProviderSources()`'s
 * execution-only pinned-fallback closure, once per emitted RunwayML model,
 * every discovery cycle (hourly/startup/manual — see model-discovery-runner.ts).
 * RunwayML is the ONLY provider wired here deliberately (see the design's
 * "first concrete target" — fal.ai/Replicate are future candidates once this
 * is proven, not part of this change).
 */
import { getRunwaymlSchemaCapabilityAttributes } from '@/providers/runwayml/runwayml-schema-attributes';
import { DEFAULT_RUNWAYML_API_VERSION } from '@/providers/runwayml/runwayml-adapter';

export function attachRunwaymlTier1Metadata<
  T extends { metadata?: Record<string, unknown> },
>(providerId: string, model: T): T {
  if (providerId !== 'runwayml') return model;
  const attrs = getRunwaymlSchemaCapabilityAttributes(DEFAULT_RUNWAYML_API_VERSION);
  if (!attrs) return model;
  return {
    ...model,
    metadata: {
      ...(model.metadata ?? {}),
      capabilityAttributes: { video_generation: attrs },
    },
  };
}
```

Export the adapter's existing `DEFAULT_API_VERSION` constant so the helper doesn't hard-code a second copy of it. In `api/src/providers/runwayml/runwayml-adapter.ts`, change:

```typescript
const DEFAULT_API_VERSION = '2024-11-06';
```

to:

```typescript
export const DEFAULT_RUNWAYML_API_VERSION = '2024-11-06';
```

and update its one usage inside the file (`this.apiVersion = config.apiVersion || DEFAULT_API_VERSION;`) to reference `DEFAULT_RUNWAYML_API_VERSION`.

Then, in `central-model-discovery-service.ts`, inside the `isExecutionOnly && pinnedModels` branch (currently lines 2166-2189), wrap the returned object with the helper. Change:

```typescript
            if (isExecutionOnly && pinnedModels) {
              return pinnedModels.map(({ id: modelId, capabilities: declared }) => {
                const capabilities =
                  declared.length > 0 ? [...declared] : (inferModelCapabilities({ modelId }) ?? []);
                return {
                  id: modelId,
                  name: modelId,
                  displayName: modelId,
                  contextWindow: 0,
                  maxOutputTokens: 0,
                  capabilities,
                  pricing: undefined,
                  metadata: {
                    originalProvider: providerId,
                    executionProvider: providerId,
                    source: sourceName,
                    fromStatic: true,
                    capabilitySource: declared.length > 0 ? 'operator-declared' : 'name-regex',
                  },
                };
              });
            }
```

to:

```typescript
            if (isExecutionOnly && pinnedModels) {
              return pinnedModels.map(({ id: modelId, capabilities: declared }) => {
                const capabilities =
                  declared.length > 0 ? [...declared] : (inferModelCapabilities({ modelId }) ?? []);
                const discovered = {
                  id: modelId,
                  name: modelId,
                  displayName: modelId,
                  contextWindow: 0,
                  maxOutputTokens: 0,
                  capabilities,
                  pricing: undefined,
                  metadata: {
                    originalProvider: providerId,
                    executionProvider: providerId,
                    source: sourceName,
                    fromStatic: true,
                    capabilitySource: declared.length > 0 ? 'operator-declared' : 'name-regex',
                  },
                };
                // LOTE AZ Tier 1 (2026-09-23): RunwayML-only hook — see
                // attachRunwaymlTier1Metadata's doc comment. This makes
                // `metadata.capabilityAttributes` non-empty on EVERY
                // discovery cycle, which the existing bulk-upsert path
                // (bulkUpsertModels, `metadata = EXCLUDED.metadata`) already
                // writes straight onto `Model.metadata` — no separate
                // projection step needed for this tier.
                return attachRunwaymlTier1Metadata(providerId, discovered);
              });
            }
```

Add the import near the top of `central-model-discovery-service.ts`:

```typescript
import { attachRunwaymlTier1Metadata } from './central-model-discovery-service-runwayml-helper';
```

- [ ] **Step 7: Run test to verify it passes**

Run: `cd api && npx vitest run src/services/__tests__/central-model-discovery-service-runwayml-tier1.test.ts`
Expected: PASS.

- [ ] **Step 8: Run the existing discovery-service and runwayml-adapter suites to confirm nothing else broke**

Run: `cd api && npx vitest run src/providers/runwayml/__tests__/runwayml-adapter.test.ts`
Expected: PASS (only the renamed exported constant changed; behavior unchanged).

- [ ] **Step 9: Commit**

```bash
git add api/src/providers/runwayml/runwayml-schema-attributes.ts \
        api/src/providers/runwayml/runwayml-adapter.ts \
        api/src/services/central-model-discovery-service-runwayml-helper.ts \
        api/src/services/central-model-discovery-service.ts \
        api/src/providers/runwayml/__tests__/runwayml-schema-attributes.test.ts \
        api/src/services/__tests__/central-model-discovery-service-runwayml-tier1.test.ts
git commit -m "feat(catalog): Tier 1 schema-derived attributes for RunwayML in the existing discovery cycle"
```

---

## Task 7: Tier 2 — empirical probing job (manual trigger only, never scheduled)

**Files:**
- Create: `api/src/services/catalog/capability-probe-job.ts`
- Create: `api/scripts/probe-capability-attributes.ts`
- Test: `api/src/services/catalog/__tests__/capability-probe-job.test.ts`

- [ ] **Step 1: Write the failing tests with mocked provider validation-error boundaries**

Create `api/src/services/catalog/__tests__/capability-probe-job.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach } from 'vitest';

const writeCapabilityAttributeRecordMock = vi.fn();
vi.mock('../capability-attribute-store', () => ({
  writeCapabilityAttributeRecord: writeCapabilityAttributeRecordMock,
}));

const findDraftMock = vi.fn();
const autoPromoteIfAgreesMock = vi.fn();
vi.mock('../capability-attribute-draft-service', () => ({
  findUnpromotedDraft: findDraftMock,
  autoPromoteIfAgrees: autoPromoteIfAgreesMock,
}));

import { probeVideoDurationCeiling } from '../capability-probe-job';

beforeEach(() => {
  writeCapabilityAttributeRecordMock.mockReset();
  findDraftMock.mockReset();
  autoPromoteIfAgreesMock.mockReset();
});

describe('probeVideoDurationCeiling', () => {
  it('reads a structured validation-error boundary and writes source: probed', async () => {
    // Simulates a provider rejecting a request above the real ceiling with a
    // structured field-level error (not free text) — exactly the "read the
    // provider's structured validation error" contract from the design.
    const fakeAdapterCall = vi
      .fn()
      .mockRejectedValueOnce({
        code: 'invalid_parameter',
        field: 'duration',
        message: 'duration must be <= 16',
      })
      .mockResolvedValueOnce({ ok: true });

    findDraftMock.mockResolvedValue(undefined);

    const result = await probeVideoDurationCeiling({
      providerId: 'fal-ai',
      modelId: 'some-model',
      candidateCeilings: [16, 8],
      callProvider: fakeAdapterCall,
    });

    expect(result.maxDurationSeconds).toBe(8);
    expect(writeCapabilityAttributeRecordMock).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'fal-ai',
        capability: 'video_generation',
        source: 'probed',
        attributes: expect.objectContaining({ maxDurationSeconds: 8 }),
      })
    );
  });

  it('checks for an agreeing llm_draft and auto-promotes it after a successful probe', async () => {
    const fakeAdapterCall = vi.fn().mockResolvedValueOnce({ ok: true });
    findDraftMock.mockResolvedValue({ id: 'draft-1', attributes: { maxDurationSeconds: 8 } });

    await probeVideoDurationCeiling({
      providerId: 'fal-ai',
      modelId: 'some-model',
      candidateCeilings: [8],
      callProvider: fakeAdapterCall,
    });

    expect(autoPromoteIfAgreesMock).toHaveBeenCalledWith(
      expect.objectContaining({ draftId: 'draft-1', probedValue: 8 })
    );
  });

  it('throws when every candidate ceiling fails for a reason other than the expected validation error', async () => {
    const fakeAdapterCall = vi.fn().mockRejectedValue(new Error('network timeout'));
    await expect(
      probeVideoDurationCeiling({
        providerId: 'fal-ai',
        modelId: 'some-model',
        candidateCeilings: [16],
        callProvider: fakeAdapterCall,
      })
    ).rejects.toThrow(/network timeout/);
    expect(writeCapabilityAttributeRecordMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx vitest run src/services/catalog/__tests__/capability-probe-job.test.ts`
Expected: FAIL — module `../capability-probe-job` does not exist.

- [ ] **Step 3: Implement the probe job**

Create `api/src/services/catalog/capability-probe-job.ts`:

```typescript
/**
 * Tier 2 — empirical capability-attribute probing (LOTE AZ, 2026-09-23).
 *
 * DELIBERATELY NOT part of the hourly/startup discovery cycle
 * (model-discovery-runner.ts) and NOT registered in
 * jobs/register-scheduled-jobs.ts. Every call here can make a REAL, PAID
 * request against a real provider. The only entrypoint is the manual CLI
 * script `api/scripts/probe-capability-attributes.ts` — see that file's
 * usage comment. Each (provider, model) pair is probed AT MOST ONCE ever;
 * the result is cached forever in `provider_capability_attribute_records`
 * (re-probing requires a manual re-run, e.g. after a provider changelog).
 *
 * Probing strategy: request a value just above each candidate ceiling (from
 * highest to lowest, most conservative first) and read the provider's
 * STRUCTURED validation error (an error code/field, never free text
 * pattern-matching) to confirm the real limit. `callProvider` is injected so
 * this module never imports a live provider adapter directly — the caller
 * (the CLI script) wires the real adapter; tests wire a mock.
 */
import { writeCapabilityAttributeRecord } from './capability-attribute-store';
import { findUnpromotedDraft, autoPromoteIfAgrees } from './capability-attribute-draft-service';

export interface ProviderValidationError {
  readonly code: string;
  readonly field: string;
  readonly message: string;
}

function isProviderValidationError(error: unknown): error is ProviderValidationError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    'field' in error &&
    (error as { field: unknown }).field === 'duration'
  );
}

export interface ProbeVideoDurationCeilingInput {
  readonly providerId: string;
  readonly modelId: string;
  /** Candidate ceilings to test, ordered HIGHEST first — the first one the
   *  provider ACCEPTS (or the highest that produces the expected structured
   *  validation error, whichever confirms a real boundary first) wins. */
  readonly candidateCeilings: readonly number[];
  /** Injected so this module never talks to a real adapter directly. */
  readonly callProvider: (durationSeconds: number) => Promise<unknown>;
}

export async function probeVideoDurationCeiling(
  input: ProbeVideoDurationCeilingInput
): Promise<{ maxDurationSeconds: number }> {
  const { providerId, modelId, candidateCeilings, callProvider } = input;

  let confirmedCeiling: number | undefined;
  for (const candidate of candidateCeilings) {
    try {
      await callProvider(candidate);
      confirmedCeiling = candidate;
      break;
    } catch (error) {
      if (isProviderValidationError(error)) {
        // The provider rejected this candidate with a structured
        // duration-field error — try the next, lower candidate.
        continue;
      }
      // Anything else (network error, auth error, ...) is NOT a confirmed
      // boundary — surface it rather than silently writing a wrong number.
      throw error;
    }
  }

  if (confirmedCeiling === undefined) {
    throw new Error(
      `probeVideoDurationCeiling(${providerId}/${modelId}): no candidate ceiling was accepted`
    );
  }

  await writeCapabilityAttributeRecord({
    providerId,
    capability: 'video_generation',
    source: 'probed',
    attributes: { maxDurationSeconds: confirmedCeiling },
    attributesVerifiedAt: new Date().toISOString().slice(0, 10),
  });

  const draft = await findUnpromotedDraft(providerId, 'video_generation');
  if (draft) {
    await autoPromoteIfAgrees({
      draftId: draft.id,
      draftAttributes: draft.attributes,
      probedValue: confirmedCeiling,
      probedField: 'maxDurationSeconds',
    });
  }

  return { maxDurationSeconds: confirmedCeiling };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && npx vitest run src/services/catalog/__tests__/capability-probe-job.test.ts`
Expected: FAIL at this point on the two tests that touch `capability-attribute-draft-service` (not implemented until Task 8) — this is expected; re-run after Task 8. Confirm the third test ("throws when every candidate ceiling fails...") passes now:

Run: `cd api && npx vitest run src/services/catalog/__tests__/capability-probe-job.test.ts -t "throws when every candidate"`
Expected: PASS.

- [ ] **Step 5: Create the manual CLI entrypoint**

Create `api/scripts/probe-capability-attributes.ts`:

```typescript
/**
 * Manual Tier 2 probing trigger (LOTE AZ, 2026-09-23).
 *
 * NEVER run on a schedule. This makes real, paid calls against a real
 * provider. Requires an explicit go-ahead per the spec's testing policy —
 * see the plan's final "Real Tier 2 probing batch" section for the
 * cost-estimate template to fill in before running this for real.
 *
 * Usage:
 *   pnpm tsx scripts/probe-capability-attributes.ts --provider fal-ai --model <id> --candidates 16,12,8
 */
import { probeVideoDurationCeiling } from '../src/services/catalog/capability-probe-job';

function parseArgs(argv: string[]): { provider: string; model: string; candidates: number[] } {
  const get = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };
  const provider = get('--provider');
  const model = get('--model');
  const candidatesRaw = get('--candidates');
  if (!provider || !model || !candidatesRaw) {
    throw new Error(
      'Usage: probe-capability-attributes.ts --provider <id> --model <id> --candidates <c1,c2,...>'
    );
  }
  return {
    provider,
    model,
    candidates: candidatesRaw.split(',').map((c) => Number(c.trim())),
  };
}

async function main(): Promise<void> {
  const { provider, model, candidates } = parseArgs(process.argv.slice(2));

  // eslint-disable-next-line no-console
  console.log(
    `[probe] about to make REAL, PAID requests against ${provider}/${model} for candidates: ${candidates.join(', ')}`
  );

  // TODO (fill in per-provider at run time): wire the real adapter call
  // here. Left unimplemented deliberately — this script is a scaffold; the
  // real adapter wiring is provider-specific and must be reviewed alongside
  // the cost estimate before the first real run, per the plan's final
  // "requires user go-ahead" section.
  throw new Error(
    'probe-capability-attributes.ts: real adapter wiring not implemented — see the plan\'s ' +
      'final "Real Tier 2 probing batch" section before wiring a live provider call here.'
  );
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
```

Note: the script is intentionally left throwing on the real-call wiring — that wiring is provider-specific, costs real money the moment it's filled in, and per the spec's testing policy must not be something an automated plan step completes silently. This satisfies "clearly mark the runs-real-paid-API-calls nature with a dedicated non-automatic trigger."

- [ ] **Step 6: Commit**

```bash
git add api/src/services/catalog/capability-probe-job.ts \
        api/scripts/probe-capability-attributes.ts \
        api/src/services/catalog/__tests__/capability-probe-job.test.ts
git commit -m "feat(catalog): Tier 2 empirical probing job (manual trigger only)"
```

---

## Task 8: Tier 3 — LLM-draft service, auto-promotion, admin endpoints

**Files:**
- Create: `api/src/services/catalog/capability-attribute-draft-service.ts`
- Create: `api/src/routes/admin/catalog-attribute-drafts-admin-routes.ts`
- Modify: `api/src/index.ts` (register the new route file, near the existing admin registrations at lines 1165-1185)
- Test: `api/src/services/catalog/__tests__/capability-attribute-draft-service.test.ts`
- Test: `api/src/routes/admin/__tests__/catalog-attribute-drafts-admin-routes.test.ts`

- [ ] **Step 1: Write the failing tests for the draft service's core logic**

Create `api/src/services/catalog/__tests__/capability-attribute-draft-service.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach } from 'vitest';

const findManyMock = vi.fn();
const updateMock = vi.fn();
vi.mock('@/database/client', () => ({
  prisma: {
    providerCapabilityAttributeRecord: {
      findMany: findManyMock,
      update: updateMock,
    },
  },
}));

import {
  findUnpromotedDraft,
  autoPromoteIfAgrees,
  promoteDraft,
} from '../capability-attribute-draft-service';

beforeEach(() => {
  findManyMock.mockReset();
  updateMock.mockReset();
});

describe('findUnpromotedDraft', () => {
  it('returns the most recent llm_draft row for a provider+capability', async () => {
    findManyMock.mockResolvedValue([
      { id: 'draft-1', source: 'llm_draft', attributes: { maxDurationSeconds: 8 } },
    ]);
    const result = await findUnpromotedDraft('fal-ai', 'video_generation');
    expect(result).toEqual({ id: 'draft-1', attributes: { maxDurationSeconds: 8 } });
  });

  it('returns undefined when there is no draft', async () => {
    findManyMock.mockResolvedValue([]);
    const result = await findUnpromotedDraft('fal-ai', 'video_generation');
    expect(result).toBeUndefined();
  });
});

describe('autoPromoteIfAgrees', () => {
  it('promotes (rewrites source to human) when the probed numeric value is within +/-10% of the draft', async () => {
    await autoPromoteIfAgrees({
      draftId: 'draft-1',
      draftAttributes: { maxDurationSeconds: 8.5 },
      probedValue: 8,
      probedField: 'maxDurationSeconds',
    });
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'draft-1' },
        data: expect.objectContaining({
          source: 'human',
          promotionNote: expect.stringContaining('agreement-promoted'),
        }),
      })
    );
  });

  it('does NOT promote when the probed value is outside +/-10% of the draft', async () => {
    await autoPromoteIfAgrees({
      draftId: 'draft-1',
      draftAttributes: { maxDurationSeconds: 20 },
      probedValue: 8,
      probedField: 'maxDurationSeconds',
    });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('promotes on an exact match for an enum/boolean field', async () => {
    await autoPromoteIfAgrees({
      draftId: 'draft-2',
      draftAttributes: { nativeAudioSupport: false },
      probedValue: false,
      probedField: 'nativeAudioSupport',
    });
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'draft-2' } })
    );
  });

  it('does NOT promote a boolean/enum field on a mismatch', async () => {
    await autoPromoteIfAgrees({
      draftId: 'draft-2',
      draftAttributes: { nativeAudioSupport: true },
      probedValue: false,
      probedField: 'nativeAudioSupport',
    });
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe('promoteDraft (manual admin promotion)', () => {
  it('rewrites source to human with a manual-promotion note', async () => {
    await promoteDraft('draft-3');
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'draft-3' },
        data: expect.objectContaining({ source: 'human', promotionNote: 'manually promoted via admin endpoint' }),
      })
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx vitest run src/services/catalog/__tests__/capability-attribute-draft-service.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the draft service**

Create `api/src/services/catalog/capability-attribute-draft-service.ts`:

```typescript
/**
 * Tier 3 — LLM-drafted attributes + auto-promotion (LOTE AZ, 2026-09-23).
 *
 * `llm_draft`-sourced rows are written by a (separate, not-yet-wired-here)
 * doc-reading LLM pass and are NEVER used by `canSatisfyCapabilityAttributes`
 * (enforced in `capability-attribute-matcher.ts`). They exist purely to be
 * reviewed: either auto-promoted here (called from the Tier 2 probe job's
 * write path, right after a probe succeeds) when a probed result agrees, or
 * manually promoted via the admin endpoints below.
 *
 * Auto-promotion rule (from the design):
 *   - enum/boolean fields (e.g. nativeAudioSupport): EXACT match required.
 *   - numeric fields (e.g. maxDurationSeconds): probed value within +/-10%
 *     of the drafted value.
 * Disagreement leaves BOTH rows in place — the probed row is already the
 * one `resolveCapabilityAttributes` trusts (probed outranks llm_draft
 * unconditionally, and llm_draft is excluded from matching entirely), the
 * draft just stays visible in the admin list, not silently discarded.
 */
import { prisma } from '@/database/client';
import type { ModelCapability } from '@/types';

export interface UnpromotedDraft {
  readonly id: string;
  readonly attributes: Record<string, unknown>;
}

export async function findUnpromotedDraft(
  providerId: string,
  capability: ModelCapability
): Promise<UnpromotedDraft | undefined> {
  const rows = await prisma.providerCapabilityAttributeRecord.findMany({
    where: { providerId, capability, source: 'llm_draft' },
    orderBy: { createdAt: 'desc' },
    take: 1,
  });
  const row = rows[0];
  if (!row) return undefined;
  return { id: row.id, attributes: row.attributes as Record<string, unknown> };
}

const NUMERIC_AGREEMENT_TOLERANCE = 0.1;

function valuesAgree(draftValue: unknown, probedValue: unknown): boolean {
  if (typeof draftValue === 'number' && typeof probedValue === 'number') {
    if (draftValue === 0) return probedValue === 0;
    return Math.abs(probedValue - draftValue) / Math.abs(draftValue) <= NUMERIC_AGREEMENT_TOLERANCE;
  }
  // Enum/boolean/string fields: exact match only.
  return draftValue === probedValue;
}

export interface AutoPromoteIfAgreesInput {
  readonly draftId: string;
  readonly draftAttributes: Record<string, unknown>;
  readonly probedValue: unknown;
  readonly probedField: string;
}

export async function autoPromoteIfAgrees(input: AutoPromoteIfAgreesInput): Promise<boolean> {
  const draftValue = input.draftAttributes[input.probedField];
  if (draftValue === undefined) return false;
  if (!valuesAgree(draftValue, input.probedValue)) return false;

  await prisma.providerCapabilityAttributeRecord.update({
    where: { id: input.draftId },
    data: {
      source: 'human',
      promotionNote: `agreement-promoted: probed ${input.probedField}=${String(input.probedValue)} agreed with draft ${String(draftValue)}`,
    },
  });
  return true;
}

export async function promoteDraft(draftId: string): Promise<void> {
  await prisma.providerCapabilityAttributeRecord.update({
    where: { id: draftId },
    data: { source: 'human', promotionNote: 'manually promoted via admin endpoint' },
  });
}

export interface AttributeDraftListItem {
  readonly id: string;
  readonly providerId: string;
  readonly capability: string;
  readonly attributes: Record<string, unknown>;
  readonly createdAt: Date;
  /** True when a later Tier 2 probe already agreement-promoted a DIFFERENT
   *  row for the same provider+capability — surfaces so the admin UI can
   *  show this draft as "auto-resolved" rather than pending, per the design. */
  readonly autoResolved: boolean;
}

export async function listAttributeDrafts(): Promise<AttributeDraftListItem[]> {
  const drafts = await prisma.providerCapabilityAttributeRecord.findMany({
    where: { source: 'llm_draft' },
    orderBy: { createdAt: 'desc' },
  });
  if (drafts.length === 0) return [];

  const humanRows = await prisma.providerCapabilityAttributeRecord.findMany({
    where: {
      source: 'human',
      OR: drafts.map((d) => ({ providerId: d.providerId, capability: d.capability })),
    },
  });
  const hasHumanRow = new Set(humanRows.map((r) => `${r.providerId}:${r.capability}`));

  return drafts.map((d) => ({
    id: d.id,
    providerId: d.providerId,
    capability: d.capability,
    attributes: d.attributes as Record<string, unknown>,
    createdAt: d.createdAt,
    autoResolved: hasHumanRow.has(`${d.providerId}:${d.capability}`),
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && npx vitest run src/services/catalog/__tests__/capability-attribute-draft-service.test.ts`
Expected: PASS.

- [ ] **Step 5: Re-run Task 7's probe-job test now that the draft service exists**

Run: `cd api && npx vitest run src/services/catalog/__tests__/capability-probe-job.test.ts`
Expected: PASS — all 3 tests (the mocked `autoPromoteIfAgrees`/`findUnpromotedDraft` imports now resolve to a real module, and the test file already mocks them at the module boundary via `vi.mock`).

- [ ] **Step 6: Write the failing test for the admin routes**

Create `api/src/routes/admin/__tests__/catalog-attribute-drafts-admin-routes.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

const listAttributeDraftsMock = vi.fn();
const promoteDraftMock = vi.fn();
vi.mock('@/services/catalog/capability-attribute-draft-service', () => ({
  listAttributeDrafts: listAttributeDraftsMock,
  promoteDraft: promoteDraftMock,
}));

vi.mock('@/middleware/auth-middleware', () => ({
  authenticate: async () => {},
  requirePlatformAdmin: () => async () => {},
}));
vi.mock('@/services/anonymous-quota-gate', () => ({
  rejectAnonymousGuestKeyPreHandler: async () => {},
}));
vi.mock('@/services/free-tier-quota-gate', () => ({
  rejectChatFreeTierKeyPreHandler: async () => {},
}));

import { registerCatalogAttributeDraftsAdminRoutes } from '../catalog-attribute-drafts-admin-routes';

beforeEach(() => {
  listAttributeDraftsMock.mockReset();
  promoteDraftMock.mockReset();
});

describe('GET /v1/admin/catalog/attribute-drafts', () => {
  it('returns the draft list', async () => {
    listAttributeDraftsMock.mockResolvedValue([
      { id: 'd1', providerId: 'fal-ai', capability: 'video_generation', attributes: {}, autoResolved: false },
    ]);
    const server = Fastify();
    await registerCatalogAttributeDraftsAdminRoutes(server);
    const response = await server.inject({ method: 'GET', url: '/v1/admin/catalog/attribute-drafts' });
    expect(response.statusCode).toBe(200);
    expect(response.json().drafts).toHaveLength(1);
  });
});

describe('POST /v1/admin/catalog/attribute-drafts/:id/promote', () => {
  it('promotes the given draft id', async () => {
    const server = Fastify();
    await registerCatalogAttributeDraftsAdminRoutes(server);
    const response = await server.inject({
      method: 'POST',
      url: '/v1/admin/catalog/attribute-drafts/d1/promote',
    });
    expect(response.statusCode).toBe(200);
    expect(promoteDraftMock).toHaveBeenCalledWith('d1');
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `cd api && npx vitest run src/routes/admin/__tests__/catalog-attribute-drafts-admin-routes.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 8: Implement the admin routes**

Create `api/src/routes/admin/catalog-attribute-drafts-admin-routes.ts`, following the live-registration pattern of `operability-admin-routes.ts` (platform-wide admin gate, since catalog attribute drafts are a shared, cross-tenant resource, not per-org data):

```typescript
/**
 * Catalog attribute-drafts admin routes — Tier 3 review surface (LOTE AZ, 2026-09-23).
 *
 * GET  /v1/admin/catalog/attribute-drafts           — list llm_draft rows for review
 * POST /v1/admin/catalog/attribute-drafts/:id/promote — manually promote one to source: 'human'
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authenticate, requirePlatformAdmin } from '@/middleware/auth-middleware';
import { rejectAnonymousGuestKeyPreHandler } from '@/services/anonymous-quota-gate';
import { rejectChatFreeTierKeyPreHandler } from '@/services/free-tier-quota-gate';
import { listAttributeDrafts, promoteDraft } from '@/services/catalog/capability-attribute-draft-service';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'catalog-attribute-drafts-admin-routes' });

export async function registerCatalogAttributeDraftsAdminRoutes(
  server: FastifyInstance
): Promise<void> {
  const adminPreHandler = [
    authenticate,
    rejectAnonymousGuestKeyPreHandler,
    rejectChatFreeTierKeyPreHandler,
    requirePlatformAdmin(),
  ];

  server.get(
    '/v1/admin/catalog/attribute-drafts',
    { preHandler: adminPreHandler },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const drafts = await listAttributeDrafts();
      return reply.send({ drafts });
    }
  );

  server.post(
    '/v1/admin/catalog/attribute-drafts/:id/promote',
    { preHandler: adminPreHandler },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      try {
        await promoteDraft(id);
        return reply.send({ success: true, id });
      } catch (error: unknown) {
        log.error({ id, error: String(error) }, 'Failed to promote catalog attribute draft');
        return reply.code(500).send({ error: 'Internal Server Error', message: 'Promotion failed' });
      }
    }
  );

  log.info('Catalog attribute-drafts admin routes registered');
}
```

- [ ] **Step 9: Register the routes in `api/src/index.ts`**

Near the existing admin-route registrations (currently lines 1165-1185), add:

```typescript
    const { registerCatalogAttributeDraftsAdminRoutes } =
      await import('./routes/admin/catalog-attribute-drafts-admin-routes.js');
    await registerCatalogAttributeDraftsAdminRoutes(server);
```

- [ ] **Step 10: Run test to verify it passes**

Run: `cd api && npx vitest run src/routes/admin/__tests__/catalog-attribute-drafts-admin-routes.test.ts`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add api/src/services/catalog/capability-attribute-draft-service.ts \
        api/src/routes/admin/catalog-attribute-drafts-admin-routes.ts \
        api/src/index.ts \
        api/src/services/catalog/__tests__/capability-attribute-draft-service.test.ts \
        api/src/routes/admin/__tests__/catalog-attribute-drafts-admin-routes.test.ts
git commit -m "feat(catalog): Tier 3 LLM-draft service, auto-promotion, and admin review endpoints"
```

---

## Task 9: `Model.metadata.capabilityAttributes` projection for Tier 2/3 writes

Tier 1 (RunwayML) already projects onto `Model.metadata` for free, via the existing discovery-cycle bulk-upsert (`central-model-discovery-service.ts`'s `metadata = EXCLUDED.metadata` on every cycle — see Task 6, Step 6's comment). Tier 2/3 run OUTSIDE that cycle (on-demand probe / admin promotion), so they need an explicit write path.

**Files:**
- Create: `api/src/services/catalog/capability-attribute-projection.ts`
- Modify: `api/src/services/catalog/capability-probe-job.ts` (call the projection after `writeCapabilityAttributeRecord`)
- Modify: `api/src/services/catalog/capability-attribute-draft-service.ts` (call the projection after `promoteDraft`/`autoPromoteIfAgrees`)
- Test: `api/src/services/catalog/__tests__/capability-attribute-projection.test.ts`

- [ ] **Step 1: Write the failing test**

Create `api/src/services/catalog/__tests__/capability-attribute-projection.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach } from 'vitest';

const findManyMock = vi.fn();
const updateMock = vi.fn();
vi.mock('@/database/client', () => ({
  prisma: {
    model: {
      findMany: findManyMock,
      update: updateMock,
    },
  },
}));

import { projectCapabilityAttributesToModels } from '../capability-attribute-projection';

beforeEach(() => {
  findManyMock.mockReset();
  updateMock.mockReset();
});

describe('projectCapabilityAttributesToModels', () => {
  it('updates metadata.capabilityAttributes for every Model row of that provider+capability, preserving other metadata', async () => {
    findManyMock.mockResolvedValue([
      {
        uid: 'uid-1',
        capabilities: ['video_generation'],
        metadata: { originalProvider: 'fal-ai', someOtherField: 42 },
      },
      {
        uid: 'uid-2',
        capabilities: ['chat'],
        metadata: {},
      },
    ]);

    await projectCapabilityAttributesToModels('fal-ai', 'video_generation', {
      maxDurationSeconds: 8,
      source: 'probed',
    });

    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { providerId: 'fal-ai' } })
    );
    // Only the model that actually declares video_generation gets updated.
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith({
      where: { uid: 'uid-1' },
      data: {
        metadata: {
          originalProvider: 'fal-ai',
          someOtherField: 42,
          capabilityAttributes: { video_generation: { maxDurationSeconds: 8, source: 'probed' } },
        },
      },
    });
  });

  it('is a no-op when no Model row declares the capability', async () => {
    findManyMock.mockResolvedValue([{ uid: 'uid-1', capabilities: ['chat'], metadata: {} }]);
    await projectCapabilityAttributesToModels('fal-ai', 'video_generation', { source: 'probed' });
    expect(updateMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx vitest run src/services/catalog/__tests__/capability-attribute-projection.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the projection**

Create `api/src/services/catalog/capability-attribute-projection.ts`:

```typescript
/**
 * `Model.metadata.capabilityAttributes` projection — LOTE AZ (2026-09-23).
 *
 * `media-planner-gate.ts#findNativeCollapseModel` reads
 * `model.metadata['capabilityAttributes']` (a runtime, per-model field) —
 * see that file's own doc comment flagging this exact seam as unpopulated.
 * This function is the "missing projection" it names: after a Tier 2 probe
 * or a Tier 3 promotion writes a `ProviderCapabilityAttributeRecord`, call
 * this to denormalize the same value onto every `Model` row for that
 * provider+capability, so the gate starts reading real data.
 *
 * Deliberately matches models the same way `findNativeCollapseModel` and
 * `hasVideoCapability` already do — `model.capabilities.includes(capability)`
 * — the simple, legacy JSON array field, NOT the HCRA `capabilityUris`
 * ontology layer, so this write path stays consistent with what the READ
 * path (media-planner-gate.ts:253) actually checks.
 *
 * Tier 1 (RunwayML) does NOT need this function — its schema-derived
 * metadata already flows onto `Model.metadata` for free via the existing
 * discovery-cycle bulk upsert (`metadata = EXCLUDED.metadata` on every
 * cycle). This function exists for Tier 2/3, which write outside that cycle.
 */
import { prisma } from '@/database/client';
import type { ModelCapability } from '@/types';
import type { CapabilityAttributes } from '@/providers/catalog/provider-catalog.types';

export async function projectCapabilityAttributesToModels(
  providerId: string,
  capability: ModelCapability,
  attributes: CapabilityAttributes
): Promise<void> {
  const rows = await prisma.model.findMany({ where: { providerId } });

  const matching = rows.filter((row) => {
    const capabilities = Array.isArray(row.capabilities) ? (row.capabilities as string[]) : [];
    return capabilities.includes(capability);
  });

  await Promise.all(
    matching.map((row) => {
      const existingMetadata = (row.metadata as Record<string, unknown>) ?? {};
      const existingAttrs =
        (existingMetadata.capabilityAttributes as Record<string, unknown>) ?? {};
      return prisma.model.update({
        where: { uid: row.uid },
        data: {
          metadata: {
            ...existingMetadata,
            capabilityAttributes: { ...existingAttrs, [capability]: attributes },
          },
        },
      });
    })
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && npx vitest run src/services/catalog/__tests__/capability-attribute-projection.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the projection into the Tier 2 probe job**

In `api/src/services/catalog/capability-probe-job.ts`, add the import:

```typescript
import { projectCapabilityAttributesToModels } from './capability-attribute-projection';
```

and, right after the existing `await writeCapabilityAttributeRecord({...})` call inside `probeVideoDurationCeiling`, add:

```typescript
  await projectCapabilityAttributesToModels(providerId, 'video_generation', {
    maxDurationSeconds: confirmedCeiling,
    source: 'probed',
  });
```

- [ ] **Step 6: Wire the projection into Tier 3 promotion**

In `api/src/services/catalog/capability-attribute-draft-service.ts`, add the import:

```typescript
import { projectCapabilityAttributesToModels } from './capability-attribute-projection';
```

Update `autoPromoteIfAgrees` and `promoteDraft` to project after the DB row is rewritten. Both functions currently only have the row's `id`, not its `providerId`/`capability`/`attributes` — extend both to fetch (or accept) that context. Change `promoteDraft`'s signature and body to:

```typescript
export async function promoteDraft(draftId: string): Promise<void> {
  const updated = await prisma.providerCapabilityAttributeRecord.update({
    where: { id: draftId },
    data: { source: 'human', promotionNote: 'manually promoted via admin endpoint' },
  });
  await projectCapabilityAttributesToModels(
    updated.providerId,
    updated.capability as ModelCapability,
    { ...(updated.attributes as Record<string, unknown>), source: 'human' } as never
  );
}
```

And `autoPromoteIfAgrees` to accept `providerId`/`capability` in its input (extend `AutoPromoteIfAgreesInput`) and call the same projection after its `update` call:

```typescript
export interface AutoPromoteIfAgreesInput {
  readonly draftId: string;
  readonly providerId: string;
  readonly capability: ModelCapability;
  readonly draftAttributes: Record<string, unknown>;
  readonly probedValue: unknown;
  readonly probedField: string;
}
```

```typescript
  await prisma.providerCapabilityAttributeRecord.update({
    where: { id: input.draftId },
    data: {
      source: 'human',
      promotionNote: `agreement-promoted: probed ${input.probedField}=${String(input.probedValue)} agreed with draft ${String(draftValue)}`,
    },
  });
  await projectCapabilityAttributesToModels(input.providerId, input.capability, {
    ...input.draftAttributes,
    source: 'human',
  } as never);
  return true;
```

Update the one caller in `capability-probe-job.ts` (`autoPromoteIfAgrees({...})`) to also pass `providerId` and `capability: 'video_generation'`.

- [ ] **Step 7: Update the affected tests' mocks and re-run**

Add a `vi.mock('../capability-attribute-projection', () => ({ projectCapabilityAttributesToModels: vi.fn() }))` to `capability-attribute-draft-service.test.ts` and `capability-probe-job.test.ts`, and add the new required fields (`providerId`, `capability`) to the `autoPromoteIfAgrees` calls/expectations in both test files.

Run: `cd api && npx vitest run src/services/catalog/__tests__/capability-attribute-draft-service.test.ts src/services/catalog/__tests__/capability-probe-job.test.ts src/services/catalog/__tests__/capability-attribute-projection.test.ts`
Expected: PASS — all 3 suites.

- [ ] **Step 8: Commit**

```bash
git add api/src/services/catalog/capability-attribute-projection.ts \
        api/src/services/catalog/capability-probe-job.ts \
        api/src/services/catalog/capability-attribute-draft-service.ts \
        api/src/services/catalog/__tests__/capability-attribute-projection.test.ts \
        api/src/services/catalog/__tests__/capability-attribute-draft-service.test.ts \
        api/src/services/catalog/__tests__/capability-probe-job.test.ts
git commit -m "feat(catalog): project Tier 2/3 capability attributes onto Model.metadata"
```

---

## Task 10: Wire the predicate into `images-orchestration-service.ts`

**Files:**
- Modify: `api/src/services/images-orchestration-service.ts`
- Test: `api/src/services/__tests__/images-orchestration-service.test.ts` (existing file — add cases; check the file for its current mocking pattern before adding, so new tests match the existing `ModelRepository`/`ProviderRegistry` mock style)

- [ ] **Step 1: Write the failing test**

Add to `api/src/services/__tests__/images-orchestration-service.test.ts` (adjust the exact mock setup to match whatever pattern the file already uses for `ModelRepository.searchModelsComplete`/`findModelsByIdOrName` and `PROVIDER_CATALOG`):

```typescript
it('excludes a candidate whose catalog capabilityAttributes.image_generation.maxDimensions is below the requested size', async () => {
  // Arrange: two candidate models from different providers; provider A's
  // catalog entry declares maxDimensions '512x512', provider B declares none.
  // Request size '1792x1024' should exclude A, keep B.
  // (Exact mock wiring depends on the file's existing helper functions for
  // building fake Model[]/PROVIDER_CATALOG rows — reuse those helpers.)
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx vitest run src/services/__tests__/images-orchestration-service.test.ts -t "excludes a candidate whose catalog capabilityAttributes"`
Expected: FAIL (no pre-filter exists yet — the candidate is not excluded).

- [ ] **Step 3: Implement the pre-filter**

In `api/src/services/images-orchestration-service.ts`, add the imports:

```typescript
import { PROVIDER_CATALOG } from '@/providers/catalog/providers.catalog';
import type { ProviderCatalogEntry } from '@/providers/catalog/provider-catalog.types';
import { canSatisfyCapabilityAttributes } from '@/providers/catalog/capability-attribute-matcher';
import { parseDimensions } from '@/providers/catalog/image-capability-matcher';
```

Add a catalog lookup helper (mirroring `video-orchestration-service.ts:280-299`) and a size-parsing helper, near the top of the `ImagesOrchestrationService` class:

```typescript
  private catalogByProviderId: Map<string, ProviderCatalogEntry> | null = null;

  private getCatalogEntry(providerId: string | undefined): ProviderCatalogEntry | undefined {
    if (!providerId) return undefined;
    if (!this.catalogByProviderId) {
      this.catalogByProviderId = new Map(PROVIDER_CATALOG.map((e) => [e.providerId, e]));
    }
    return this.catalogByProviderId.get(providerId);
  }
```

Change `resolveImageCatalog` to accept an optional attribute-request and filter with it:

```typescript
  private async resolveImageCatalog(
    capabilities: ModelCapability[],
    explicit: string | undefined,
    attributeRequest?: { width?: number; height?: number; format?: string }
  ): Promise<Model[]> {
    const filterByAttributes = (models: Model[]): Model[] => {
      if (!attributeRequest) return models;
      // LOTE AZ (2026-09-23): additive attribute-aware pre-filter, mirroring
      // video-orchestration-service.ts's canSatisfyVideoAttributes wiring. A
      // candidate whose DECLARED image attributes conflict with the request
      // is excluded; a candidate with no declared attributes is NOT excluded
      // (fail-open — see canSatisfyImageAttributes's contract).
      return models.filter((model) =>
        capabilities.some((capability) =>
          canSatisfyCapabilityAttributes(
            capability,
            this.getCatalogEntry(model.provider)?.capabilityAttributes?.[capability],
            attributeRequest
          )
        )
      );
    };

    if (explicit && explicit !== 'auto') {
      const rows = await this.modelRepo.findModelsByIdOrName(explicit);
      const capable = rows.filter((m) => capabilities.some((c) => (m.capabilities ?? []).includes(c)));
      // Explicit model references bypass the attribute pre-filter, same as
      // video's explicit path — an operator naming a model directly is
      // trusted to know what it can do.
      return capable;
    }

    const pools = await Promise.all(
      capabilities.map((c) => this.modelRepo.searchModelsComplete({ capabilities: [c], status: 'active' }))
    );
    const deduped = Array.from(new Map(pools.flat().map((m) => [`${m.provider}:${m.id}`, m])).values());
    return filterByAttributes(deduped);
  }
```

Update `generateImages` to pass a parsed size:

```typescript
    const requestedDimensions = parseDimensions(size);
    const catalogRows = await this.resolveImageCatalog(
      ['image_generation' as ModelCapability],
      model,
      requestedDimensions ? { width: requestedDimensions.width, height: requestedDimensions.height } : undefined
    );
```

Update `editImage` the same way:

```typescript
    const requestedDimensions = parseDimensions(size);
    const merged = await this.resolveImageCatalog(
      ['image_editing' as ModelCapability, 'image_generation' as ModelCapability],
      model,
      requestedDimensions ? { width: requestedDimensions.width, height: requestedDimensions.height } : undefined
    );
```

`enhanceImage`/`createVariations` are left unchanged — `ImageCapabilityAttributes` is scoped to `image_generation`/`image_editing` (per the design's "needed by section D too" framing), not `image_upscale`/`image_denoise`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && npx vitest run src/services/__tests__/images-orchestration-service.test.ts`
Expected: PASS — the new test and every pre-existing test in the file (fail-open means untouched catalog rows with no `capabilityAttributes` are never excluded).

- [ ] **Step 5: Commit**

```bash
git add api/src/services/images-orchestration-service.ts api/src/services/__tests__/images-orchestration-service.test.ts
git commit -m "feat(images): wire attribute-aware pre-filter into image generation/edit candidate selection"
```

---

## Task 11: Wire the predicate into `pdf-service.ts`

`pdf-service.ts` has no capability-based candidate-selection step of its own (unlike video/images) — it hands `model: 'auto'` straight to `orchestration-engine.ts#execute()`. This task adds a minimal pre-filter: when auto-selecting, resolve `pdf_understanding`-capable models, exclude any whose declared `maxPages` the document's page count exceeds, and — only when that filtering actually narrows the pool — pin the request to the best surviving candidate's id rather than rewriting the engine's own generic selection logic.

**Files:**
- Modify: `api/src/services/pdf-service.ts`
- Test: `api/src/services/__tests__/pdf-service.test.ts` (existing file — check its current mocking pattern for `getOrchestrationEngine`/`ModelRepository` before adding)

- [ ] **Step 1: Write the failing test**

Add to `api/src/services/__tests__/pdf-service.test.ts`:

```typescript
it('pins the analysis model to a surviving pdf_understanding candidate when auto-select and the document exceeds another candidate\'s declared maxPages', async () => {
  // Arrange: ModelRepository.searchModelsComplete returns two
  // pdf_understanding models from different providers; PROVIDER_CATALOG
  // mock declares provider A's capabilityAttributes.pdf_understanding.maxPages
  // = 50, provider B has none declared. Feed a document metadata.pageCount
  // of 100. Assert the ChatRequest passed to engine.execute has `model` set
  // to provider B's model id, not 'auto'.
});

it('leaves model as auto when every candidate is excluded (fail-open, never blocks the request)', async () => {
  // Arrange: both candidates declare maxPages below the document's page
  // count. Assert the ChatRequest still uses model: 'auto' — filtering
  // never narrows the pool to zero and blocks the call.
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx vitest run src/services/__tests__/pdf-service.test.ts -t "pins the analysis model"`
Expected: FAIL — no such filtering exists yet.

- [ ] **Step 3: Implement the pre-filter**

In `api/src/services/pdf-service.ts`, add the imports:

```typescript
import { ModelRepository } from '@/services/model-repository';
import { PROVIDER_CATALOG } from '@/providers/catalog/providers.catalog';
import { canSatisfyDocumentAttributes } from '@/providers/catalog/document-capability-matcher';
```

Add a private helper method and a `modelRepo` field to `PDFService`:

```typescript
export class PDFService {
  private readonly getVisionService: () => VisionOrchestrationService;
  private readonly modelRepo: ModelRepository;

  constructor(
    getVisionService: () => VisionOrchestrationService = getVisionOrchestrationService,
    modelRepo: ModelRepository = new ModelRepository()
  ) {
    this.getVisionService = getVisionService;
    this.modelRepo = modelRepo;
  }

  /**
   * LOTE AZ (2026-09-23): pdf-service.ts has no capability-based candidate
   * selection of its own (unlike video/images orchestration) — it hands
   * `model: 'auto'` straight to the generic orchestration engine. This
   * resolves `pdf_understanding` candidates and pins the request to the
   * best SURVIVING one only when the maxPages pre-filter actually excludes
   * something; otherwise (including when filtering would exclude every
   * candidate) it leaves `'auto'` untouched — fail-open, never blocks a
   * request just because this optional pre-filter had nothing useful to add.
   */
  private async selectPdfAnalysisModel(
    explicitModel: string | undefined,
    pageCount: number
  ): Promise<string | undefined> {
    if (explicitModel && explicitModel !== 'auto') return explicitModel;

    const candidates = await this.modelRepo.searchModelsComplete({
      capabilities: ['pdf_understanding'],
      status: 'active',
    });
    if (candidates.length === 0) return explicitModel;

    const catalogByProviderId = new Map(PROVIDER_CATALOG.map((e) => [e.providerId, e]));
    const surviving = candidates.filter((model) => {
      const attrs = catalogByProviderId.get(model.provider)?.capabilityAttributes?.pdf_understanding;
      return canSatisfyDocumentAttributes(attrs, { pageCount });
    });

    if (surviving.length === 0 || surviving.length === candidates.length) {
      // Nothing to add: either every candidate would be excluded (fail-open
      // — don't block the request) or nothing was excluded at all (no need
      // to override the engine's own, richer selection).
      return explicitModel;
    }

    return surviving[0].id;
  }
```

Update `analyzePDF` to call it right before building `analyzeText`'s params — find the existing call site:

```typescript
    const analysis = await this.analyzeText({
      text,
      filename,
      prompt,
      model,
      metadata,
      userContext,
      requestId,
    });
```

and change it to:

```typescript
    const resolvedModel = await this.selectPdfAnalysisModel(model, metadata.pageCount);
    const analysis = await this.analyzeText({
      text,
      filename,
      prompt,
      model: resolvedModel,
      metadata,
      userContext,
      requestId,
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && npx vitest run src/services/__tests__/pdf-service.test.ts`
Expected: PASS — both new tests and every pre-existing test in the file.

- [ ] **Step 5: Commit**

```bash
git add api/src/services/pdf-service.ts api/src/services/__tests__/pdf-service.test.ts
git commit -m "feat(pdf): wire attribute-aware maxPages pre-filter into PDF analysis model selection"
```

---

## Task 12: Full-suite verification for Section B

**Files:** none (verification only)

- [ ] **Step 1: Run every test file touched or created by this plan**

Run:
```bash
cd api && npx vitest run \
  src/providers/catalog/__tests__/provider-catalog.schema.test.ts \
  src/providers/catalog/__tests__/video-capability-matcher.test.ts \
  src/providers/catalog/__tests__/image-capability-matcher.test.ts \
  src/providers/catalog/__tests__/document-capability-matcher.test.ts \
  src/providers/catalog/__tests__/capability-attribute-matcher.test.ts \
  src/services/__tests__/video-orchestration-service.test.ts \
  src/services/__tests__/images-orchestration-service.test.ts \
  src/services/__tests__/pdf-service.test.ts \
  src/services/catalog/__tests__/capability-attribute-store.test.ts \
  src/services/catalog/__tests__/capability-probe-job.test.ts \
  src/services/catalog/__tests__/capability-attribute-draft-service.test.ts \
  src/services/catalog/__tests__/capability-attribute-projection.test.ts \
  src/routes/admin/__tests__/catalog-attribute-drafts-admin-routes.test.ts \
  src/providers/runwayml/__tests__/runwayml-schema-attributes.test.ts \
  src/providers/runwayml/__tests__/runwayml-adapter.test.ts \
  src/services/__tests__/central-model-discovery-service-runwayml-tier1.test.ts
```
Expected: PASS — every suite.

- [ ] **Step 2: Type-check the whole api package**

Run: `cd api && npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 3: Confirm no leftover references to the removed field**

Run: `cd api && grep -rn "videoCapabilityAttributes" src --include="*.ts"`
Expected: no output.

---

## Real Tier 2 probing batch (NOT part of the task list above — requires explicit user go-ahead, real cost)

This section is deliberately separate from every checkbox task above. Nothing in it should be executed automatically as part of implementing this plan.

Once Tasks 1-12 are merged and the mocked test suite is green, the FIRST real probing run (via `pnpm tsx scripts/probe-capability-attributes.ts`, after actually wiring a live adapter call into that script — currently a deliberate `throw` placeholder, see Task 7 Step 5) makes real, paid calls against real providers. Before running it for real:

1. **Pick the provider(s).** Candidates are video/image providers NOT already covered by the 6 hand-verified rows (byteplus, zai, venice, runwayml, siliconflow, aivideoapi) — e.g. providers the catalog lists with `videoGeneration: true`/`imageGeneration: true` but no `capabilityAttributes` entry. Confirm the current list with: `grep -B5 "capabilityAttributes:" api/src/providers/catalog/providers.catalog.ts` cross-referenced against every row with `supports.videoGeneration` or `supports.imageGeneration` set.
2. **Cost estimate template (fill in per provider before running):**

   | Provider | Model(s) | Candidate ceilings tested | Calls per model | Est. cost per call | Est. total |
   |---|---|---|---|---|---|
   | `<provider-id>` | `<model-id>` | e.g. `[16, 12, 8]` | up to `len(candidates)` (stops at first success) | `$<x>` | `$<calls * x>` |

3. **Run exactly the models named in step 1** — never "probe everything," per the design's "one probe per model, cached forever" contract; a wrong first guess is a wasted paid call that then requires a manual re-probe to fix.
4. **Report back** (per this session's convention) with what was probed, the confirmed ceilings written, and any llm_draft auto-promotions that fired, before considering this tier "done" for that provider.

I (the assistant) will not run this script or fill in real cost numbers without you naming the specific provider(s) and confirming the estimate first.
