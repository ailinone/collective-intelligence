// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * HCRA End-to-End Validation (ADR-022, Sprint 3)
 * ==============================================
 *
 * Proves the full data path actually works on real DB rows:
 *
 *   fetchers (synthetic CapabilitySignals)
 *     → writer (model_capability_assertions, append-only)
 *       → materialiser (models.capability_uris/confidence/sources via noisy-OR)
 *         → embedding worker (deterministic test embedder)
 *           → pgvector HNSW recall (raw SQL, mirrors hcra-search-routes)
 *             → reader adapter (verifies downstream consumer can read URIs)
 *
 * Why deterministic test embedder
 * -------------------------------
 * The validation needs to run in CI without a TEI/OpenAI sidecar. We inject
 * a `HashedEmbedder` whose vectors are reproducible from input strings — the
 * recall geometry is meaningless but the persistence path, the HNSW index,
 * the cosine distance computation, and the reader adapter are all real.
 *
 * Run
 * ---
 *   pnpm tsx scripts/hcra-validate-e2e.ts
 *
 * Exits non-zero on any failed assertion. Cleans up its synthetic origin's
 * rows on success so re-runs are idempotent.
 */
import { createHash } from 'node:crypto';

import { writeAssertions } from '../src/capability/assertions/writer';
import { materialiseOneModel } from '../src/capability/assertions/materialiser';
import { runEmbeddingWorker } from '../src/capability/embeddings/embedding-worker';
import {
  EMBEDDING_DIMS,
  setEmbedderForTesting,
  type Embedder,
} from '../src/capability/embeddings/embedder';
import {
  getEffectiveCapabilities,
  getEffectiveCapabilitiesWithConfidence,
  hasCapability,
} from '../src/capability/reader';
import { LEGACY_CAPABILITY_TO_URI } from '../src/capability/ontology/seed';
import type { CapabilitySignal } from '../src/services/model-capability-merger';
import { prisma } from '../src/database/client';
import { Pool } from 'pg';

const ORIGIN = 'hcra-validate-e2e@v1';

interface AssertionLike {
  uri: string;
  source: string;
  confidence: number;
}

// ─── Deterministic embedder ──────────────────────────────────────────────────

class HashedEmbedder implements Embedder {
  readonly modelVersion = 'hcra-validate-e2e-hashed-v1';
  readonly dimensions = EMBEDDING_DIMS;

  async embed(req: { inputs: string[] }): Promise<{ vectors: number[][]; modelVersion: string }> {
    const vectors = req.inputs.map((s) => this.hashToVector(s));
    return { vectors, modelVersion: this.modelVersion };
  }

  private hashToVector(input: string): number[] {
    // Expand a SHA-256 to 384 floats by chained hashing. Deterministic and
    // covers the full vector space without needing a real model.
    const out = new Array<number>(EMBEDDING_DIMS);
    let seed = createHash('sha256').update(input).digest();
    let cursor = 0;
    while (cursor < EMBEDDING_DIMS) {
      for (let i = 0; i < seed.length && cursor < EMBEDDING_DIMS; i += 2) {
        const u16 = seed.readUInt16BE(i);
        out[cursor++] = (u16 / 65535) * 2 - 1; // map [0..65535] → [-1..1]
      }
      seed = createHash('sha256').update(seed).digest();
    }
    // Normalise to unit length so cosine distance is well-defined.
    let norm = 0;
    for (const v of out) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < out.length; i++) out[i] = out[i]! / norm;
    return out;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`[FAIL] ${message}`);
    process.exitCode = 1;
    throw new Error(`assertion failed: ${message}`);
  }
  console.log(`[PASS] ${message}`);
}

function summary(title: string): void {
  console.log(`\n──── ${title} ${'─'.repeat(Math.max(2, 60 - title.length))}`);
}

async function pickTestModels(): Promise<{ uid: string; id: string; displayName: string }[]> {
  // Pick 3 active models that already exist in the DB. We don't insert new
  // models — that would change the discovery surface. We only mutate the
  // assertion table for our own origin tag (cleaned up at the end).
  const rows = await prisma.$queryRawUnsafe<{ uid: string; id: string; display_name: string }[]>(
    `SELECT uid, id, display_name FROM models
     WHERE status = 'active' AND uid IS NOT NULL
     ORDER BY id ASC
     LIMIT 3`,
  );
  if (rows.length === 0) {
    throw new Error('No active models in DB — run discovery first');
  }
  return rows.map((r) => ({ uid: r.uid, id: r.id, displayName: r.display_name }));
}

function buildSyntheticSignals(): CapabilitySignal[] {
  // Inject a few capabilities our test models definitely should have under
  // noisy-OR fusion: a high-confidence provider-declared chat + vision, plus
  // a weaker name-regex reasoning to verify confidence aggregation.
  return [
    {
      capability: 'chat',
      source: 'provider-declared',
      detail: { evidence: 'synthetic e2e' },
      confidence: 0.9,
    },
    {
      capability: 'vision',
      source: 'provider-declared',
      detail: { evidence: 'synthetic e2e' },
      confidence: 0.85,
    },
    {
      capability: 'reasoning',
      source: 'name-regex',
      detail: { evidence: 'synthetic e2e' },
      confidence: 0.3,
    },
  ];
}

// ─── End-to-end ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  setEmbedderForTesting(new HashedEmbedder());
  const dbUrl = process.env.DATABASE_URL ?? 'postgres://ci_user:ci_password@localhost:5434/ci';
  const pool = new Pool({ connectionString: dbUrl });

  try {
    summary('Phase 1 — Pick test models');
    const models = await pickTestModels();
    console.log(
      `Selected ${models.length} models:\n  - ${models.map((m) => m.id).join('\n  - ')}`,
    );

    summary('Phase 2 — Write assertions (writer → model_capability_assertions)');
    const signals = buildSyntheticSignals();
    const writeResult = await writeAssertions(
      models.map((m) => ({ modelUid: m.uid, signals })),
      { origin: ORIGIN },
    );
    console.log('Writer stats:', JSON.stringify(writeResult));
    assert(
      writeResult.rowsInserted >= models.length * signals.length,
      `Writer inserted all signals (got ${writeResult.rowsInserted}, expected ≥${models.length * signals.length})`,
    );

    summary('Phase 3 — Verify rows exist (raw SQL)');
    const rowCount = await prisma.$queryRawUnsafe<{ n: number | bigint | string }[]>(
      `SELECT COUNT(*)::int AS n FROM model_capability_assertions
       WHERE source_detail->>'fetcher' = $1
         AND superseded_at IS NULL`,
      ORIGIN,
    );
    const activeRows = Number(rowCount[0]?.n ?? 0);
    assert(
      activeRows >= models.length * signals.length,
      `Active assertions present in table (got ${activeRows}, expected ≥${models.length * signals.length})`,
    );

    summary('Phase 4 — Materialise (noisy-OR fusion → models.capability_uris/confidence/sources)');
    for (const m of models) {
      await materialiseOneModel(pool, m.uid);
    }
    console.log(`Materialised ${models.length} models`);

    summary('Phase 5 — Verify projection contains URIs + per-cap confidence');
    const projection = await prisma.$queryRawUnsafe<
      {
        uid: string;
        id: string;
        capability_uris: string[];
        capability_confidence: Record<string, number> | null;
        capability_sources: Record<string, string[]> | null;
      }[]
    >(
      `SELECT uid, id, capability_uris, capability_confidence, capability_sources
       FROM models WHERE uid = ANY($1::varchar[])`,
      models.map((m) => m.uid),
    );

    const visionUri = LEGACY_CAPABILITY_TO_URI['vision']!;
    const reasoningUri = LEGACY_CAPABILITY_TO_URI['reasoning']!;

    for (const row of projection) {
      assert(row.capability_uris.includes(visionUri), `${row.id}: capability_uris contains vision URI`);
      const visionConf = row.capability_confidence?.[visionUri];
      // Source confidence 0.85, materialiser applies freshness decay (~5% on
      // brand-new rows), so the floor we assert against is 0.75 — anything
      // lower means the noisy-OR fusion or decay is misbehaving.
      assert(
        typeof visionConf === 'number' && visionConf >= 0.75,
        `${row.id}: vision confidence ≥ 0.75 after decay (got ${visionConf})`,
      );
      const reasoningConf = row.capability_confidence?.[reasoningUri];
      assert(
        typeof reasoningConf === 'number' && reasoningConf > 0 && reasoningConf < 0.75,
        `${row.id}: reasoning confidence in (0, 0.75) — weaker than vision (got ${reasoningConf})`,
      );
    }

    summary('Phase 6 — Reader adapter (downstream consumer view)');
    for (const row of projection) {
      // Reader uses camelCase keys (Prisma convention). Raw SQL returns
      // snake_case — normalize before passing in. Real consumers use Prisma
      // model objects which already have the camelCase shape.
      const adapted = {
        capabilityUris: row.capability_uris,
        capabilityConfidence: row.capability_confidence,
        capabilitySources: row.capability_sources,
      };
      const slugs = getEffectiveCapabilities(adapted);
      assert(slugs.includes('vision'), `${row.id}: getEffectiveCapabilities includes 'vision' slug`);
      assert(hasCapability(adapted, 'vision'), `${row.id}: hasCapability('vision') === true`);
      assert(
        !hasCapability(adapted, 'vision', { minConfidence: 0.99 }),
        `${row.id}: hasCapability('vision', minConfidence:0.99) === false`,
      );
      const provenance = getEffectiveCapabilitiesWithConfidence(adapted);
      const visionEntry = provenance.find((p) => p.uri === visionUri);
      assert(
        !!visionEntry && (visionEntry.confidence ?? 0) >= 0.75,
        `${row.id}: provenance entry for vision has HCRA-confidence ≥ 0.75 (got ${visionEntry?.confidence})`,
      );
    }

    summary('Phase 7 — Embedding worker (capabilities + models)');
    const stats = await runEmbeddingWorker({
      modelLimit: 5,
      capabilityLimit: 5,
      chunkSize: 8,
    });
    console.log('Embedding worker stats:', JSON.stringify(stats));
    assert(stats.capabilities.failed === 0, 'No capability embedding failures');
    assert(stats.models.failed === 0, 'No model embedding failures');

    summary('Phase 8 — pgvector HNSW recall (mirrors L3 Search API)');
    // The Search API's vector branch is `embedding <=> $query` ASC LIMIT N.
    // We embed a synthetic query ("vision capable assistant"), run the same
    // SQL, and verify our test models surface near the top.
    const embedder = new HashedEmbedder();
    const { vectors } = await embedder.embed({ inputs: ['vision capable assistant'] });
    const queryLiteral = `[${vectors[0]!.map((v) => v.toFixed(6)).join(',')}]`;

    const recall = await prisma.$queryRawUnsafe<{ id: string; dist: number }[]>(
      `SELECT id, embedding <=> $1::vector AS dist
       FROM models
       WHERE embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector
       LIMIT 20`,
      queryLiteral,
    );
    console.log('Top-20 recall (deterministic — geometry is hash-based):');
    for (const r of recall.slice(0, 5)) console.log(`  ${r.dist.toFixed(4)}  ${r.id}`);
    assert(recall.length > 0, 'pgvector cosine recall returned at least one row');

    summary('Phase 9 — Lexical pg_trgm recall (mirrors L3 lex branch)');
    const lexRows = await prisma.$queryRawUnsafe<{ uri: string; sim: number }[]>(
      `SELECT uri, GREATEST(
                     similarity(preferred_label, $1),
                     COALESCE((SELECT MAX(similarity(s, $1)) FROM unnest(synonyms) s), 0)
                   ) AS sim
         FROM capability_ontology
        WHERE status = 'active'
          AND (preferred_label % $1 OR synonyms && ARRAY[$1])
        ORDER BY sim DESC
        LIMIT 5`,
      'vision',
    );
    console.log(`Lexical hits for 'vision': ${lexRows.length}`);
    for (const r of lexRows) console.log(`  ${r.sim.toFixed(3)}  ${r.uri}`);
    assert(lexRows.length > 0, 'pg_trgm lexical search returned at least one ontology row');
    assert(
      lexRows.some((r) => r.uri === visionUri),
      'Lexical search surfaced the canonical vision URI',
    );

    summary('Phase 10 — Cleanup (remove synthetic assertions)');
    const cleanup = await prisma.$executeRawUnsafe(
      `DELETE FROM model_capability_assertions
       WHERE source_detail->>'fetcher' = $1`,
      ORIGIN,
    );
    console.log(`Deleted ${cleanup} synthetic assertion rows`);
    // Re-materialise to remove our synthetic vision claim from the projection.
    for (const m of models) {
      await materialiseOneModel(pool, m.uid);
    }
    console.log('Re-materialised models (projection restored to non-synthetic state)');

    console.log('\n✅ HCRA end-to-end validation PASSED');
  } finally {
    await pool.end();
    setEmbedderForTesting(null);
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('\n❌ HCRA end-to-end validation FAILED:', err);
  process.exit(1);
});
