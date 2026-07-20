// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * HCRA Coverage Closer — one-shot.
 *
 * Applies Blocks 1, 3, and 4 of the coverage closure work against existing
 * model rows (no provider API calls — pure in-DB re-inference):
 *
 *   1. **Structural derivation** (Block 1/4): reads each model's materialised
 *      capability_uris, applies rules from structural-derivation.ts, writes
 *      `modality-derived` assertions.
 *   2. **Regex rescore** (Block 3): re-runs the name-regex inference over the
 *      model's display_name + metadata text. Writes `name-regex` assertions
 *      for the 6 newly-covered slugs (qa, translation, documentation,
 *      refactoring, testing, diarization) plus any other new patterns.
 *
 * Idempotent: both passes use supersede-by-origin, so re-running produces the
 * same row count — no growth on repeat runs.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/hcra-close-coverage.ts [--dry-run]
 */
import { Pool } from 'pg';
import { prisma } from '../src/database/client';
import { writeAssertions, type ModelAssertionBatch } from '../src/capability/assertions/writer';
import { deriveStructuralSignals, structuralTargets } from '../src/capability/assertions/structural-derivation';
import { inferModelCapabilities } from '../src/services/model-capability-inference';
import type { CapabilitySignal } from '../src/services/model-capability-merger';
import type { ModelCapability } from '../src/types';
import { LEGACY_CAPABILITY_TO_URI } from '../src/capability/ontology/seed';

const DRY_RUN = process.argv.includes('--dry-run');

/**
 * Capabilities that the NEW regex patterns (added in this sprint) produce but
 * the PREVIOUS regex pass did not. We cross-check each model's inferred caps
 * against what's already asserted via name-regex, and only write the delta —
 * this avoids churning the whole regex assertion set on every re-run.
 */
const NEW_REGEX_TARGETS: ReadonlySet<ModelCapability> = new Set<ModelCapability>([
  'qa',
  'translation',
  'documentation',
  'refactoring',
  'testing',
  'diarization',
]);

/**
 * Tool-surface provider-declared rules — emulates the new fetcher logic
 * against existing model rows so the next materialise picks up file_search/
 * mcp without needing a full discovery cycle. Next real discovery run will
 * supersede these via the same origin tag.
 */
interface ToolSurfaceRule {
  /** Match predicate against lowercase model id (`name` column). */
  match: (id: string) => boolean;
  capability: ModelCapability;
  confidence: number;
  source_field: string;
}

const TOOL_SURFACE_RULES: readonly ToolSurfaceRule[] = (() => {
  const rules: ToolSurfaceRule[] = [];

  // OpenAI Responses-API family (gpt-4o, gpt-4.1, o1, o3, o4, gpt-5) —
  // file_search, mcp, code_interpreter. Exclude specialized slots.
  const responsesApiFamily = (id: string): boolean => {
    if (!/^(openai\/)?(gpt-4o|gpt-4\.1|o1|o3|o4|gpt-5)(-|$)/.test(id)) return false;
    return !id.includes('embedding') && !id.includes('audio') && !id.includes('realtime') &&
           !id.includes('tts') && !id.includes('whisper') && !id.includes('image') &&
           !id.includes('transcribe') && !id.includes('moderation');
  };
  for (const cap of ['file_search', 'mcp', 'code_interpreter'] as const) {
    rules.push({ match: responsesApiFamily, capability: cap, confidence: 0.85, source_field: 'openai-responses-api-tool' });
  }

  // Anthropic: MCP on Claude 3.5 Sonnet+, 3.7, 4.x
  const anthropicMcpFamily = (id: string): boolean => {
    return /claude-3-5-sonnet/.test(id) ||
           /claude-3-7-sonnet/.test(id) ||
           /claude-(sonnet|opus|haiku)-4/.test(id) ||
           /(sonnet|opus|haiku)-4\./.test(id);
  };
  rules.push({ match: anthropicMcpFamily, capability: 'mcp', confidence: 0.9, source_field: 'anthropic-mcp-supported' });

  // Anthropic: computer_use on Sonnet 3.5 v20241022+, 3.7, 4.x
  const anthropicCuFamily = (id: string): boolean => {
    return /claude-3-5-sonnet-2024(10|11|12)/.test(id) ||
           /claude-3-7-sonnet/.test(id) ||
           /claude-(sonnet|opus|haiku)-4/.test(id) ||
           /(sonnet|opus|haiku)-4\./.test(id);
  };
  rules.push({ match: anthropicCuFamily, capability: 'computer_use', confidence: 0.9, source_field: 'anthropic-computer-use-supported' });

  return rules;
})();

interface ModelRow {
  uid: string;
  name: string;
  display_name: string | null;
  capability_uris: string[];
  capability_confidence: Record<string, number> | null;
  metadata: Record<string, unknown> | null;
}

async function loadModels(pool: Pool): Promise<ModelRow[]> {
  const { rows } = await pool.query<ModelRow>(`
    SELECT uid, name, display_name, capability_uris,
           capability_confidence, metadata
    FROM models
    WHERE status = 'active';
  `);
  return rows;
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    console.log(`[hcra-close-coverage] dry_run=${DRY_RUN} loading models...`);
    const models = await loadModels(pool);
    console.log(`[hcra-close-coverage] loaded ${models.length} active models`);

    // ─── Pass 1: structural derivation ───
    const structuralBatch: ModelAssertionBatch[] = [];
    let structuralSignalCount = 0;
    const targetHits = new Map<ModelCapability, number>();
    for (const t of structuralTargets()) targetHits.set(t, 0);

    for (const row of models) {
      const signals = deriveStructuralSignals({
        capabilityUris: row.capability_uris,
        capabilityConfidence: row.capability_confidence ?? undefined,
      });
      if (signals.length === 0) continue;
      structuralBatch.push({ modelUid: row.uid, signals });
      structuralSignalCount += signals.length;
      for (const s of signals) {
        targetHits.set(s.capability, (targetHits.get(s.capability) ?? 0) + 1);
      }
    }

    console.log(`[structural] models_matched=${structuralBatch.length} signals=${structuralSignalCount}`);
    for (const [cap, hits] of targetHits) {
      console.log(`[structural]   ${cap.padEnd(30)} ${hits} models`);
    }

    // ─── Pass 2: regex rescore (only NEW-target caps) ───
    const regexBatch: ModelAssertionBatch[] = [];
    let regexSignalCount = 0;
    const regexTargetHits = new Map<ModelCapability, number>();
    for (const t of NEW_REGEX_TARGETS) regexTargetHits.set(t, 0);

    for (const row of models) {
      const inferred = inferModelCapabilities({
        modelId: row.name,
        metadata: {
          name: row.display_name ?? row.name,
          ...(row.metadata ?? {}),
        },
      });
      const existingUris = new Set(row.capability_uris);

      const signals: CapabilitySignal[] = [];
      for (const cap of inferred) {
        if (!NEW_REGEX_TARGETS.has(cap)) continue;
        const uri = LEGACY_CAPABILITY_TO_URI[cap];
        if (!uri) continue;
        // Only write if the model doesn't already have it — avoid duplicating
        // signals that the hierarchy propagator or structural pass already added.
        if (existingUris.has(uri)) continue;
        signals.push({
          capability: cap,
          source: 'name-regex',
          confidence: 0.4,
          detail: { source_field: 'rescore', origin: 'rescore-sprint3@v1' },
        });
        regexTargetHits.set(cap, (regexTargetHits.get(cap) ?? 0) + 1);
      }
      if (signals.length > 0) {
        regexBatch.push({ modelUid: row.uid, signals });
        regexSignalCount += signals.length;
      }
    }

    console.log(`[rescore]    models_matched=${regexBatch.length} signals=${regexSignalCount}`);
    for (const [cap, hits] of regexTargetHits) {
      console.log(`[rescore]      ${cap.padEnd(30)} ${hits} models`);
    }

    // ─── Pass 3: tool-surface product-family rules (emulates new fetcher logic) ───
    const toolBatch: ModelAssertionBatch[] = [];
    let toolSignalCount = 0;
    const toolHits = new Map<ModelCapability, number>();

    for (const row of models) {
      const id = row.name.toLowerCase();
      const existingUris = new Set(row.capability_uris);
      const signals: CapabilitySignal[] = [];
      const emitted = new Set<ModelCapability>();

      for (const rule of TOOL_SURFACE_RULES) {
        if (emitted.has(rule.capability)) continue;
        if (!rule.match(id)) continue;
        const uri = LEGACY_CAPABILITY_TO_URI[rule.capability];
        if (!uri) continue;
        // Skip if existing evidence is already at least this strong
        const existingConf = row.capability_confidence?.[uri] ?? 0;
        if (existingUris.has(uri) && existingConf >= rule.confidence) continue;

        emitted.add(rule.capability);
        signals.push({
          capability: rule.capability,
          source: 'provider-declared',
          confidence: rule.confidence,
          detail: {
            source_field: rule.source_field,
            origin: 'tool-surface-family@v1',
            modelId: row.name,
          },
        });
        toolHits.set(rule.capability, (toolHits.get(rule.capability) ?? 0) + 1);
      }
      if (signals.length > 0) {
        toolBatch.push({ modelUid: row.uid, signals });
        toolSignalCount += signals.length;
      }
    }

    console.log(`[tool-surface] models_matched=${toolBatch.length} signals=${toolSignalCount}`);
    for (const [cap, hits] of toolHits) {
      console.log(`[tool-surface]  ${cap.padEnd(30)} ${hits} models`);
    }

    if (DRY_RUN) {
      console.log('[hcra-close-coverage] dry-run — no writes performed');
      return;
    }

    // ─── Write assertions (chunked to avoid pg pool connection timeouts) ───
    const CHUNK = 250;
    async function writeChunked(
      label: string,
      batch: ModelAssertionBatch[],
      origin: string,
      ttlDays: number,
    ): Promise<void> {
      if (batch.length === 0) return;
      let inserted = 0;
      let superseded = 0;
      for (let i = 0; i < batch.length; i += CHUNK) {
        const slice = batch.slice(i, i + CHUNK);
        const stats = await writeAssertions(slice, { origin, ttlDays }, prisma);
        inserted += stats.rowsInserted;
        superseded += stats.rowsSuperseded;
        console.log(`[${label}] chunk ${i / CHUNK + 1}/${Math.ceil(batch.length / CHUNK)}: +${stats.rowsInserted} rows (${stats.rowsSuperseded} superseded)`);
      }
      console.log(`[${label}] TOTAL wrote ${inserted} rows, superseded ${superseded}`);
    }

    await writeChunked('structural', structuralBatch, 'structural-derivation@v1', 60);
    await writeChunked('rescore', regexBatch, 'rescore-sprint3@v1', 90);
    await writeChunked('tool-surface', toolBatch, 'tool-surface-family@v1', 30);

    console.log('[hcra-close-coverage] done — run hcra-materialise next to refresh the projection');
  } finally {
    await pool.end();
    await prisma.$disconnect().catch(() => undefined);
  }
}

main().catch(async (err) => {
  console.error('[hcra-close-coverage] FAILED:', err);
  process.exit(1);
});
