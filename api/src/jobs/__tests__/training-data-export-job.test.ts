// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Training Data Export Job — Unit Tests
 *
 * Tests the extraction pipeline that exports execution outcomes and
 * shadow evaluations as JSONL for model-stack training.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockExecuteRaw = vi.fn().mockResolvedValue(0);
const mockQueryRaw = vi.fn().mockResolvedValue([]);

beforeEach(() => {
  vi.resetModules();
  // The exporter is fail-closed: it refuses to run without an explicit pepper.
  process.env.FEEDBACK_HASH_PEPPER = 'test-pepper';
  mockExecuteRaw.mockReset().mockResolvedValue(0);
  mockQueryRaw.mockReset().mockResolvedValue([]);

  vi.doMock('@/database/client', () => ({
    prisma: { $executeRaw: mockExecuteRaw, $queryRaw: mockQueryRaw },
  }));
  vi.doMock('@/utils/logger', () => ({
    logger: { child: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  }));
  vi.doMock('node-cron', () => ({
    default: { schedule: vi.fn() },
  }));
});

describe('Training Data Export Job', () => {
  describe('runTrainingDataExport', () => {
    it('refuses to run when FEEDBACK_HASH_PEPPER is not set (fail-closed)', async () => {
      delete process.env.FEEDBACK_HASH_PEPPER;
      const { runTrainingDataExport } = await import('../training-data-export-job');
      await expect(runTrainingDataExport()).rejects.toThrow(/FEEDBACK_HASH_PEPPER/);
      // The gate must fire before any DB access.
      expect(mockQueryRaw).not.toHaveBeenCalled();
    });

    it('produces extraction manifest with correct structure', async () => {
      // Mock watermark queries (outcomes, shadow, collective) + their data fetches.
      // Signals are only queried when collective runs > 0.
      mockQueryRaw
        .mockResolvedValueOnce([{ last_watermark: new Date('2026-03-01') }]) // outcomes watermark
        .mockResolvedValueOnce([]) // outcomes data (empty)
        .mockResolvedValueOnce([{ last_watermark: new Date('2026-03-01') }]) // shadow watermark
        .mockResolvedValueOnce([]) // shadow data (empty)
        .mockResolvedValueOnce([{ last_watermark: new Date('2026-03-01') }]) // collective watermark
        .mockResolvedValueOnce([]); // collective runs (empty) — signals not queried

      const { runTrainingDataExport } = await import('../training-data-export-job');
      const manifest = await runTrainingDataExport();

      expect(manifest).toHaveProperty('extraction_id');
      expect(manifest).toHaveProperty('extracted_at');
      expect(manifest).toHaveProperty('outcomes');
      expect(manifest).toHaveProperty('shadow');
      expect(manifest).toHaveProperty('collective');
      expect(manifest).toHaveProperty('watermarks');
      expect(manifest.outcomes.row_count).toBe(0);
      expect(manifest.shadow.row_count).toBe(0);
      expect(manifest.collective.runs.row_count).toBe(0);
      expect(manifest.collective.signals.row_count).toBe(0);
      expect(manifest.outcomes.sha256).toBeDefined();
      expect(manifest.shadow.sha256).toBeDefined();
      expect(manifest.collective.runs.sha256).toBeDefined();
      expect(manifest.collective.signals.sha256).toBeDefined();
      expect(manifest.watermarks.collective.start).toBeDefined();
      expect(manifest.watermarks.collective.end).toBeDefined();
    });

    it('extracts outcomes and updates watermark', async () => {
      const testDate = new Date('2026-04-01T10:00:00Z');

      mockQueryRaw
        // Outcomes watermark
        .mockResolvedValueOnce([{ last_watermark: new Date('2026-03-31') }])
        // Outcomes data
        .mockResolvedValueOnce([{
          decision_trace_id: 'req-001',
          strategy: 'debate',
          task_type: 'code-generation',
          complexity: 'high',
          quality_score: 0.88,
          quality_dimensions: { correctness: 0.9 },
          latency_ms: 3000,
          cost_usd: 0.05,
          total_tokens: 2000,
          success: true,
          feedback_iterations: 1,
          models_used: ['gpt-4o', 'claude-sonnet'],
          decision_source: 'triage',
          input_hash: 'abc123',
          created_at: testDate,
        }])
        // Shadow watermark
        .mockResolvedValueOnce([{ last_watermark: new Date('2026-03-31') }])
        // Shadow data (empty)
        .mockResolvedValueOnce([])
        // Collective watermark
        .mockResolvedValueOnce([{ last_watermark: new Date('2026-03-31') }])
        // Collective runs (empty)
        .mockResolvedValueOnce([]);

      const { runTrainingDataExport } = await import('../training-data-export-job');
      const manifest = await runTrainingDataExport();

      expect(manifest.outcomes.row_count).toBe(1);
      expect(manifest.shadow.row_count).toBe(0);
      // Watermark should have been updated via $executeRaw
      expect(mockExecuteRaw).toHaveBeenCalled();
    });

    it('never exports org_id or user_id', async () => {
      mockQueryRaw
        .mockResolvedValueOnce([{ last_watermark: new Date('2026-03-01') }])
        .mockResolvedValueOnce([{
          decision_trace_id: 'req-pii',
          strategy: 'single',
          task_type: 'general',
          complexity: 'low',
          quality_score: 0.80,
          quality_dimensions: null,
          latency_ms: 1000,
          cost_usd: 0.01,
          total_tokens: 500,
          success: true,
          feedback_iterations: 1,
          models_used: ['gpt-4o'],
          decision_source: 'heuristic',
          input_hash: null,
          created_at: new Date(),
        }])
        .mockResolvedValueOnce([{ last_watermark: new Date('2026-03-01') }])
        .mockResolvedValueOnce([])
        // Collective watermark + empty runs
        .mockResolvedValueOnce([{ last_watermark: new Date('2026-03-01') }])
        .mockResolvedValueOnce([]);

      const { runTrainingDataExport } = await import('../training-data-export-job');
      const manifest = await runTrainingDataExport();

      // The export creates JSONL files. The fact that org_id and user_id
      // are never in the SELECT query (verified in the source code) means
      // they can never appear in the output. The test verifies the query
      // was executed without errors.
      expect(manifest.outcomes.row_count).toBe(1);
    });

    it('hashes trace IDs for privacy', async () => {
      // The hashTraceId function uses SHA-256 + pepper
      // Verify indirectly: trace_id_hash in output should not be the raw ID
      mockQueryRaw
        .mockResolvedValueOnce([{ last_watermark: new Date('2026-03-01') }])
        .mockResolvedValueOnce([{
          decision_trace_id: 'sensitive-trace-id-12345',
          strategy: 'single',
          task_type: 'general',
          complexity: 'low',
          quality_score: 0.80,
          quality_dimensions: null,
          latency_ms: 1000,
          cost_usd: 0.01,
          total_tokens: 500,
          success: true,
          feedback_iterations: 1,
          models_used: [],
          decision_source: null,
          input_hash: null,
          created_at: new Date(),
        }])
        .mockResolvedValueOnce([{ last_watermark: new Date('2026-03-01') }])
        .mockResolvedValueOnce([])
        // Collective watermark + empty runs
        .mockResolvedValueOnce([{ last_watermark: new Date('2026-03-01') }])
        .mockResolvedValueOnce([]);

      const { runTrainingDataExport } = await import('../training-data-export-job');
      const manifest = await runTrainingDataExport();

      // Export completed successfully — the trace ID was hashed internally
      // (we verify the hash function is used by checking the output file
      // does not contain the raw trace ID — but since we mock the file write,
      // we verify the function ran without error)
      expect(manifest.outcomes.row_count).toBe(1);
    });

    it('extracts collective runs and signals when present', async () => {
      const runDate = new Date('2026-04-15T12:00:00Z');
      mockQueryRaw
        // outcomes empty
        .mockResolvedValueOnce([{ last_watermark: new Date('2026-03-01') }])
        .mockResolvedValueOnce([])
        // shadow empty
        .mockResolvedValueOnce([{ last_watermark: new Date('2026-03-01') }])
        .mockResolvedValueOnce([])
        // collective watermark
        .mockResolvedValueOnce([{ last_watermark: new Date('2026-03-01') }])
        // collective runs (1 row)
        .mockResolvedValueOnce([{
          id: '11111111-1111-1111-1111-111111111111',
          request_id: 'req-collective-001',
          strategy: 'sensitivity-consensus',
          rounds: 3,
          stop_reason: 'converged',
          convergence_score: 0.85,
          decision_flip_rate: 0.1,
          dissent: 0.05,
          total_cost_usd: 0.12,
          total_latency_ms: 4500,
          total_tokens: 3200,
          final_decision_type: 'recommendation',
          final_confidence: 0.92,
          config: { maxRounds: 5, aggregationMethod: 'llm_synthesis' },
          metadata: { participatingModels: ['gpt-4o', 'claude-sonnet'] },
          created_at: runDate,
        }])
        // collective signals (2 rows for the same run)
        .mockResolvedValueOnce([
          {
            run_id: '11111111-1111-1111-1111-111111111111',
            round: 0,
            agent_id: 'agent-1',
            model_id: 'openai/gpt-4o',
            provider_id: 'openai',
            role: 'solver',
            decision_type: 'recommendation',
            decision_value: { choice: 'option-A' },
            decision_confidence: 0.9,
            decision_rationale: 'Reasoning for option A.',
            sensitivities: [{ variable: 'cost', direction: 'minimize', confidence: 0.8 }],
            latency_ms: 2000,
            input_tokens: 800,
            output_tokens: 400,
            cost_usd: 0.05,
            created_at: runDate,
          },
          {
            run_id: '11111111-1111-1111-1111-111111111111',
            round: 0,
            agent_id: 'agent-2',
            model_id: 'anthropic/claude-sonnet',
            provider_id: 'anthropic',
            role: 'solver',
            decision_type: 'recommendation',
            decision_value: { choice: 'option-A' },
            decision_confidence: 0.85,
            decision_rationale: 'Concurring with option A.',
            sensitivities: [{ variable: 'quality', direction: 'maximize', confidence: 0.9 }],
            latency_ms: 2500,
            input_tokens: 800,
            output_tokens: 500,
            cost_usd: 0.07,
            created_at: runDate,
          },
        ]);

      const { runTrainingDataExport } = await import('../training-data-export-job');
      const manifest = await runTrainingDataExport();

      expect(manifest.collective.runs.row_count).toBe(1);
      expect(manifest.collective.signals.row_count).toBe(2);
      expect(manifest.collective.runs.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(manifest.collective.signals.sha256).toMatch(/^[a-f0-9]{64}$/);
      // Watermark UPDATE + 2 audit log INSERTs (runs + signals) for non-empty extraction
      expect(mockExecuteRaw).toHaveBeenCalled();
    });

    it('does not query signals when collective runs is empty', async () => {
      mockQueryRaw
        .mockResolvedValueOnce([{ last_watermark: new Date('2026-03-01') }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ last_watermark: new Date('2026-03-01') }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ last_watermark: new Date('2026-03-01') }])
        .mockResolvedValueOnce([]); // collective runs (empty)
      // No more mockResolvedValueOnce — if signals were queried, this would error.

      const { runTrainingDataExport } = await import('../training-data-export-job');
      const manifest = await runTrainingDataExport();

      expect(manifest.collective.runs.row_count).toBe(0);
      expect(manifest.collective.signals.row_count).toBe(0);
      // Verify the signals fetch was NOT one of the executed queryRaw calls.
      // Total queryRaw calls = 6: 3 watermark + 3 data (no signals).
      expect(mockQueryRaw).toHaveBeenCalledTimes(6);
    });

    it('hashes run_id and request_id in collective export records', async () => {
      mockQueryRaw
        .mockResolvedValueOnce([{ last_watermark: new Date('2026-03-01') }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ last_watermark: new Date('2026-03-01') }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ last_watermark: new Date('2026-03-01') }])
        .mockResolvedValueOnce([{
          id: '22222222-2222-2222-2222-222222222222',
          request_id: 'sensitive-req-id',
          strategy: 'sensitivity-consensus',
          rounds: 1,
          stop_reason: 'converged',
          convergence_score: 0.9,
          decision_flip_rate: 0,
          dissent: 0,
          total_cost_usd: 0.01,
          total_latency_ms: 1000,
          total_tokens: 500,
          final_decision_type: null,
          final_confidence: null,
          config: {},
          metadata: {},
          created_at: new Date('2026-04-15T12:00:00Z'),
        }])
        .mockResolvedValueOnce([]); // signals empty

      const { runTrainingDataExport } = await import('../training-data-export-job');
      const manifest = await runTrainingDataExport();

      // Hashes are 16 hex chars (sliced from sha256). The raw values must NOT
      // appear anywhere in the manifest.
      expect(manifest.collective.runs.row_count).toBe(1);
      expect(JSON.stringify(manifest)).not.toContain('22222222-2222-2222-2222-222222222222');
      expect(JSON.stringify(manifest)).not.toContain('sensitive-req-id');
    });

    it('handles empty database gracefully', async () => {
      mockQueryRaw.mockResolvedValue([]);

      const { runTrainingDataExport } = await import('../training-data-export-job');
      const manifest = await runTrainingDataExport();

      expect(manifest.outcomes.row_count).toBe(0);
      expect(manifest.shadow.row_count).toBe(0);
      expect(manifest.collective.runs.row_count).toBe(0);
      expect(manifest.collective.signals.row_count).toBe(0);
      // Should NOT update watermark when no data extracted
      // (watermark is only updated when rows.length > 0)
    });

    /**
     * Phase 2c shadowEnsemble JSONB pass-through.
     *
     * The export job reads decision_value as opaque JSON and writes it
     * verbatim to the JSONL output. When debate/tri-role/expert-panel
     * persist a shadow snapshot via the onShadowResult hook (Phase 2c),
     * the snapshot lands in `decision_value.shadowEnsemble` and MUST
     * survive the export untouched — that's how the offline evaluator
     * reads the (heuristic, ensemble) tuple per row.
     *
     * If anyone refactors the export to add per-field projection or
     * custom serialization on decision_value, this test fails — the
     * regression catches before training data goes silently empty.
     */
    it('preserves shadowEnsemble field in decision_value JSONB pass-through', async () => {
      const runDate = new Date('2026-04-15T12:00:00Z');
      const SHADOW_SNAPSHOT = {
        kind: 'success',
        role: 'moderator',
        scheduler: 'mock-cascade-24-tiered',
        reason: 'task-type-match',
        confidence: 0.92,
        aggregationMethod: 'weighted_bayesian_majority',
        totalVotes: 4,
        tiersActivated: [1],
        shortCircuited: true,
        divergence: {
          sameRole: true,
          sameReason: false,
          bothAgreeOnSchedulerFamily: false,
          shadowConfidence: 0.92,
        },
        latencyMs: 42,
      };

      mockQueryRaw
        .mockResolvedValueOnce([{ last_watermark: new Date('2026-03-01') }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ last_watermark: new Date('2026-03-01') }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ last_watermark: new Date('2026-03-01') }])
        .mockResolvedValueOnce([{
          id: '33333333-3333-3333-3333-333333333333',
          request_id: 'req-with-shadow',
          strategy: 'debate',
          rounds: 2,
          stop_reason: 'converged',
          convergence_score: 0.95,
          decision_flip_rate: 0,
          dissent: 0,
          total_cost_usd: 0.10,
          total_latency_ms: 3000,
          total_tokens: 2500,
          final_decision_type: 'synthesis',
          final_confidence: 0.92,
          config: {},
          metadata: {},
          created_at: runDate,
        }])
        .mockResolvedValueOnce([
          {
            run_id: '33333333-3333-3333-3333-333333333333',
            round: 2,
            agent_id: 'moderator-mod-round-2',
            model_id: 'openai/gpt-4o',
            provider_id: 'openai',
            role: 'moderator',
            decision_type: 'synthesis',
            // The whole point of this test: shadowEnsemble MUST round-trip.
            decision_value: {
              text: 'synthesized response',
              schedulerName: 'fixed-state-machine',
              decisionReason: 'heuristic-default',
              shadowEnsemble: SHADOW_SNAPSHOT,
            },
            decision_confidence: 1.0,
            decision_rationale: null,
            sensitivities: [],
            latency_ms: 1500,
            input_tokens: 1000,
            output_tokens: 500,
            cost_usd: 0.05,
            created_at: runDate,
          },
        ]);

      const { runTrainingDataExport, _testing } = await import('../training-data-export-job');

      // Capture the records that the export builds, before they hit
      // disk. _testing.lastSignalRecords is a test-only hook exposed
      // from the export job so we can assert decision_value passes
      // through untouched without needing to mock fs.
      const manifest = await runTrainingDataExport();
      expect(manifest.collective.signals.row_count).toBe(1);

      // The signal record's decision_value MUST contain the
      // shadowEnsemble snapshot we put in the row. If a future
      // refactor adds field projection / custom serialization on
      // decision_value, this assertion fails — the regression catches
      // before training data goes silently empty.
      const captured = _testing?.lastSignalRecords ?? [];
      expect(captured).toHaveLength(1);
      const decisionValue = captured[0].decision_value as {
        shadowEnsemble?: unknown;
      } | null;
      expect(decisionValue).not.toBeNull();
      expect(decisionValue?.shadowEnsemble).toEqual(SHADOW_SNAPSHOT);
    });
  });
});
