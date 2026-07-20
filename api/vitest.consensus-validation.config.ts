// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Isolated vitest config for Strategy-by-Strategy Validation 01 (Consensus).
 *
 * Purpose: run ONLY the 8 consensus-strategy validation tests, with no
 * DB / global setup / network mocks. The global setup file mocks the
 * response aggregator and ensemble-shadow modules so the strategy code
 * exercises its real pipeline (scoring, outlier filter, fallback) but
 * never reaches an external system.
 *
 * Run from `api/`:
 *   pnpm exec vitest run --config vitest.consensus-validation.config.ts
 */
import { defineConfig } from 'vitest/config';
import path from 'path';
import { loadTestEnvDefaults } from './tests/test-env';

loadTestEnvDefaults();

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    include: [
      'src/core/orchestration/strategies/__tests__/consensus-strategy.*.test.ts',
      'src/core/orchestration/strategies/__tests__/consensus-execution-planner.test.ts',
      'src/core/orchestration/strategies/__tests__/consensus-plan-dry-run.test.ts',
      'src/core/orchestration/strategies/__tests__/consensus-plan-to-execution-parity.test.ts',
      'src/core/orchestration/strategies/__tests__/consensus-plan-parity-hybrid.test.ts',
      'src/core/orchestration/strategies/__tests__/consensus-synthesizer-enforcement.test.ts',
      'src/core/orchestration/strategies/__tests__/consensus-pool-summary.test.ts',
      'src/core/operability/__tests__/provider-credit-audit-non-billable.test.ts',
      'src/core/operability/__tests__/provider-probe-adapters.test.ts',
      'src/core/operability/__tests__/reconciled-operability-snapshot.test.ts',
      'src/core/orchestration/strategies/evaluation/*.test.ts',
      'src/core/orchestration/model-selection/__tests__/*.test.ts',
      'src/core/operability/__tests__/provider-credit-audit-service.test.ts',
      // 01C.1B-R — fail-closed gate for eval.dryRun=true.
      'src/services/__tests__/chat-request-processor-dryrun-fail-closed.test.ts',
      // 01C.1B-R — provider-call tripwire pinned to dry-run service.
      'src/core/orchestration/strategies/__tests__/consensus-plan-dryrun-no-provider-call.test.ts',
      // 01C.1B-J — judge eligibility under role-specific retrieval.
      'src/core/orchestration/model-selection/__tests__/judge-full-registry-eligibility.test.ts',
      // 01C.1B-P — plan fingerprint + execution parity.
      'src/core/orchestration/strategies/__tests__/consensus-plan-fingerprint.test.ts',
      'src/core/orchestration/model-selection/__tests__/role-specific-candidate-pool-builder.test.ts',
      'src/services/__tests__/chat-request-processor-plan-parity.test.ts',
      // 01C.1B-P2 — real-branch fingerprint gate.
      'src/services/__tests__/chat-request-processor-real-branch-plan-gate.test.ts',
      // 01C.1B-E — provider error classifier + retry/cascade policy.
      'src/core/orchestration/failures/__tests__/provider-error-classifier.test.ts',
      'src/core/orchestration/strategies/__tests__/consensus-cross-provider-retry-policy.test.ts',
      'src/core/orchestration/strategies/__tests__/consensus-route-cascade-policy.test.ts',
      // 01C.1B-F — live chat operability state + planner filter.
      'src/core/operability/__tests__/live-chat-operability-state.test.ts',
      'src/core/operability/__tests__/live-chat-operability-planner-filter.test.ts',
      // 01C.1B-F2 — deadline policy in fingerprint.
      'src/core/orchestration/strategies/__tests__/consensus-deadline-policy-fingerprint.test.ts',
      // 01C.1B-G2 — provider readiness classifier + alias map + capability kind + canonical resolver.
      'src/core/operability/__tests__/provider-readiness-classifier.test.ts',
      // 01C.1B-G2 — static G→G2 reclassification migrator.
      'src/core/operability/__tests__/apply-g2-reclassification.test.ts',
      // 01C.1B-G4 — prompt runtime trace + fingerprint plan inclusion.
      'src/core/orchestration/__tests__/prompt-runtime-trace.test.ts',
      'src/core/orchestration/__tests__/prompt-fingerprint-plan-inclusion.test.ts',
      // 01C.1B-G4 — cross-provider catalog leakage detector.
      'src/core/operability/__tests__/detect-cross-provider-catalog-leakage.test.ts',
      // 01C.1B-G4 §HF — HuggingFace canonical hub discovery.
      'src/providers/huggingface/__tests__/huggingface-inference-adapter.test.ts',
      // 01C.1B-G4 §Routing — provider routing taxonomy (direct/router/hybrid).
      'src/core/operability/__tests__/provider-routing-taxonomy.test.ts',
      // 01C.1B-H — multi-route foundation: builder + cascade executor + fingerprint inclusion.
      'src/core/orchestration/__tests__/build-route-candidates.test.ts',
      'src/core/orchestration/__tests__/route-cascade-executor.test.ts',
      'src/core/orchestration/__tests__/route-candidates-plan-fingerprint.test.ts',
      // 01C.1B-I3A — runtime wiring of promptTrace + routeCandidates into consensus dry-run.
      'src/core/orchestration/__tests__/consensus-prompt-trace-runtime-wiring.test.ts',
      'src/core/orchestration/__tests__/consensus-route-candidates-dry-run-runtime.test.ts',
      'src/core/orchestration/__tests__/consensus-fingerprint-runtime-wiring.test.ts',
      // 01C.1B-I3B — RouteCascadeExecutor runtime adapter (helper module).
      'src/core/orchestration/__tests__/route-cascade-runtime-adapter.test.ts',
      // 01C.1B-J1R §11 — preprobe policy honors allowUnknownLiveOperability.
      'src/core/orchestration/__tests__/consensus-route-candidates-preprobe-policy.test.ts',
      // 01C.1B-J1R2 — model-centric multi-provider route fanout.
      'src/core/orchestration/__tests__/build-route-candidates-model-centric-fanout.test.ts',
      'src/core/orchestration/__tests__/consensus-model-centric-route-fanout-dryrun.test.ts',
      'src/core/orchestration/__tests__/consensus-route-candidates-discovery-vs-runtime-cap.test.ts',
      'src/core/orchestration/__tests__/consensus-route-fanout-fingerprint-parity.test.ts',
      // 01C.1B-J1C — catalog cache + concurrency + audit coverage + reclassification.
      'src/core/orchestration/__tests__/model-catalog-serving-providers-cache.test.ts',
      'src/core/operability/__tests__/live-chat-audit-openrouter-free-spec.test.ts',
      'src/core/operability/__tests__/live-chat-audit-fireworks-accounts-spec.test.ts',
      'src/core/operability/__tests__/provider-auth-baseurl-spec-review.test.ts',
      'src/core/operability/__tests__/provider-unknown-reclassification.test.ts',
      'src/core/orchestration/__tests__/consensus-role-readiness-fallback-selection.test.ts',
      'src/core/orchestration/__tests__/consensus-strict-dryrun-readiness-explainability.test.ts',
      // 01C.1B-J1D — route-level live audit coverage.
      'src/core/operability/__tests__/live-chat-audit-route-scope-approved.test.ts',
      'src/core/operability/__tests__/live-chat-audit-logical-model-route-evidence.test.ts',
      'src/core/orchestration/__tests__/consensus-strict-route-level-readiness.test.ts',
      'src/core/orchestration/__tests__/consensus-route-level-readiness-explainability.test.ts',
      // 01C.1B-J1E — provider API model id resolver + alias wiring.
      'src/core/orchestration/__tests__/provider-api-model-id-resolver.test.ts',
      'src/core/orchestration/__tests__/route-candidates-api-model-alias-wiring.test.ts',
      'src/core/orchestration/__tests__/consensus-api-model-alias-fingerprint.test.ts',
      'src/core/operability/__tests__/live-chat-audit-api-model-alias-plan.test.ts',
      // 01C.1B-J1F — discovery-driven alias learning.
      'src/core/orchestration/__tests__/provider-discovery-alias-learner.test.ts',
      'src/core/orchestration/__tests__/provider-api-model-id-resolver-discovery-snapshot.test.ts',
      // 01C.1B-J1G — synthesizer hybrid role policy.
      'src/core/orchestration/__tests__/synthesizer-role-policy-scoring.test.ts',
      'src/core/orchestration/__tests__/collective-cost-benefit-estimate.test.ts',
      // 01C.1B-J1G-R0 — runtime wiring proof.
      'src/core/orchestration/__tests__/synthesizer-role-policy-runtime-wiring.test.ts',
      // 01C.1B-J1G-R0 §10.2 — no duplicate-scorer invariant + summary attach proof.
      'src/core/orchestration/__tests__/synthesizer-role-policy-no-duplicate-scorer.test.ts',
      // 01C.1B-J1G-R0 §10.3 — role selection runtime trace inclusion.
      'src/core/orchestration/__tests__/consensus-role-selection-runtime-trace.test.ts',
      // 01C.1B-J1G-R0 §10.4 — role selection parity (plan fingerprint).
      'src/core/orchestration/__tests__/consensus-role-selection-parity.test.ts',
      // 01C.1B-J2 §8 — quality calibration snapshot contract.
      'src/core/orchestration/__tests__/model-quality-calibration.test.ts',
      // 01C.1B-J2 §11 — local quality evaluator.
      'src/core/orchestration/__tests__/model-quality-evaluator.test.ts',
      // 01C.1B-J2 §17.1 — quality snapshot integration in synthesizer scoring.
      'src/core/orchestration/__tests__/synthesizer-role-policy-quality-snapshot.test.ts',
      // 01C.1B-J2 §17.2 — quality snapshot fingerprint inclusion + parity.
      'src/core/orchestration/__tests__/consensus-quality-snapshot-fingerprint.test.ts',
      // 01C.1B-J2-C-R2 §7 — runner safety guards.
      'src/core/orchestration/__tests__/model-quality-benchmark-runner-safety.test.ts',
      // 01C.1B-J2-C-R3 §9 — BenchLM external snapshot adapter.
      'src/core/orchestration/__tests__/benchlm-snapshot-adapter.test.ts',
      // 01C.1B-J2-C-R4 §9 — LMArena multi-category snapshot adapter.
      'src/core/orchestration/__tests__/lmarena-snapshot-adapter.test.ts',
      // 01C.1B-J2-C-R4 §11 — Multi-source snapshot merger.
      'src/core/orchestration/__tests__/merge-quality-snapshots.test.ts',
      // 01C.1B-J2-C-R4 §12 — Task-aware quality resolver.
      'src/core/orchestration/__tests__/task-aware-quality-resolver.test.ts',
      // 01C.1B-J2-C-R4 §13 — Task-aware quality integration in R2 synthesizer scorer.
      'src/core/orchestration/__tests__/synthesizer-role-policy-task-aware-quality.test.ts',
      // 01C.1B-J2-C-R4 §17 — Manual / catalog fallback guard.
      'src/core/orchestration/__tests__/quality-snapshot-manual-fallback-guard.test.ts',
      // 01C.1B-J1D-R4A §8 — Live-ready candidate injection helper (pure).
      'src/core/orchestration/model-selection/__tests__/live-ready-candidate-injection.test.ts',
      // 01C.1B-J1D-R4A §12 — Pool builder × live-ready injection integration.
      'src/core/orchestration/model-selection/__tests__/role-specific-candidate-pool-builder-live-ready-injection.test.ts',
      // 01C.1B-J1D-R4A §11 — planFingerprint sensitivity to live-ready injection.
      'src/core/orchestration/__tests__/live-ready-injection-plan-fingerprint.test.ts',
      // 01C.1B-J1D-R4B §7 — Canonical model identity.
      'src/core/orchestration/model-selection/__tests__/canonical-model-identity.test.ts',
      // 01C.1B-J1D-R4B §8/§10 — Inventory planner.
      'src/core/operability/__tests__/live-chat-operability-inventory-plan.test.ts',
      // 01C.1B-J1D-R4C §11 — contextPolicy × planFingerprint sensitivity.
      'src/core/orchestration/__tests__/context-policy-plan-fingerprint.test.ts',
      // 01C.1B-J1D-R4D §11 — judgeEligibilityPolicy × planFingerprint sensitivity.
      'src/core/orchestration/__tests__/judge-eligibility-policy-plan-fingerprint.test.ts',
      // 01C.1B-J2-C-R5 §11 — qualityPolicy × planFingerprint sensitivity.
      'src/core/orchestration/__tests__/quality-policy-plan-fingerprint.test.ts',
      // 01C.1B-J2-C-R6-HARDEN §10 — c3EligibilityPolicy × planFingerprint sensitivity.
      'src/core/orchestration/__tests__/quality-policy-r6-harden-plan-fingerprint.test.ts',
      // 01C.1B-J2-C-R6 §7-§8 — Artificial Analysis client + normalizer + matcher.
      'src/core/orchestration/model-selection/external-benchmarks/__tests__/*.test.ts',
      // 01C.1B-C3-SCOPE-DESIGN — strategy scope, model eligibility, provider routes, task/rubric, budget/provenance.
      'src/core/orchestration/__tests__/c3-scope-design-strategy-scope.test.ts',
      'src/core/orchestration/__tests__/c3-scope-design-model-eligibility.test.ts',
      'src/core/orchestration/__tests__/c3-scope-design-provider-routes.test.ts',
      'src/core/orchestration/__tests__/c3-scope-design-task-rubric.test.ts',
      'src/core/orchestration/__tests__/c3-scope-design-budget-provenance.test.ts',
      // 01C.1B-J0 §15: rejection gate is already covered by the pre-existing
      // chat-request-processor-real-branch-plan-gate.test.ts (which is in
      // the include list above). Per spec "extend existing, don't duplicate"
      // we DO NOT add a parallel test file (a previous attempt caused
      // vi.doMock cross-contamination in singleFork mode).
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
    setupFiles: [
      './src/core/orchestration/strategies/__tests__/consensus-validation.setup.ts',
    ],
    globals: false,
    isolate: true,
    clearMocks: true,
    mockReset: false,
    restoreMocks: false,
    testTimeout: 10_000,
    hookTimeout: 10_000,
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
