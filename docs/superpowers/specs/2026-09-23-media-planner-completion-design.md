<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# MediaPlanner — Completing the Architecture (Design Spec)

**Status:** approved by user (2026-09-23), pending spec review loop
**Origin:** follow-up to a full audit of the "ailin.one/ci — Composing media as a collective" architecture proposal, which found the backbone (MediaPlannerStrategy loop, gating, `unmetConstraints[]`, audit persistence) real and tested, but six areas partial or missing. This spec closes those six areas.
**Branch / worktree:** `feat/media-planner-completion` at `.worktrees/feat-media-planner-completion/`

---

## 0. Why this spec is one document but six sub-projects

Each section below (A–F) is independently shippable and independently testable — it does not depend on the others being done first, except where noted. Per the writing-plans scope-check, **implementation will be split into six separate plan documents**, one per section, each executable and reviewable on its own. This spec stays a single document because the six pieces share one mental model (the MediaPlanner) and reviewing them in isolation would lose the cross-cutting decisions (judge model resolution, feature-flag shape, cost/testing policy) that apply to all six.

**Cross-cutting decisions that apply everywhere below:**
- **Testing policy:** every new code path gets mocked-provider unit/integration tests, always, no cost. Any test that calls a real paid provider or a real judge model is called out explicitly in that section's plan, batched, and run only after an explicit go-ahead with a cost estimate — no fixed budget ceiling, but no real-money batch runs silently.
- **Rollout policy:** production activation is a canary (explicit org allowlist), never a blanket flip, and the final global flip is a separate, explicitly confirmed step outside of any plan's automated execution.

---

## A. Real judge / critics in production

**Problem today:** `MediaJudgeEvaluator`/`ProviderMediaJudgeClient` are real and correctly built (real ffmpeg frame extraction, real separate-class judge, real Zod-enforced schema), but both production call sites (`api/src/routes/capabilities/capabilities-routes.ts:2262-2265`, `api/src/services/chat-request-processor.ts:2842-2845`) construct `MediaConsensusStrategy` with an empty `critics` array. `reconcileCriticResults` always hits its `scoringMode: 'unavailable'` branch, and `pickBestCandidate` just takes the first candidate that passes the deterministic gate — this is even documented in a comment at the `capabilities-routes.ts` call site. No real judgment happens.

A second, quieter problem: `ModelRoleResolver` (`api/src/core/orchestration/model-selection/model-role-resolver.ts`) resolves the `'judge'` role with a structured-output hard filter (`requireJsonOutput`, ~lines 660-720) but never checks vision/multimodal input support. If `MediaJudgeEvaluator` resolves a judge model dynamically (as it's designed to, mirroring the text judge's `judgeModelOverride` pattern), nothing guarantees that model can actually see the base64 frames it's handed — it would silently degrade to `unavailable` instead of erroring loudly. (Note: `role-specific-candidate-pool-builder.ts`'s judge-role pool logic, ~lines 213-224, is the earlier pool-construction step that feeds into `model-role-resolver.ts`'s filters — the vision check belongs in the resolver's filter stage, next to `requireJsonOutput`, not in the pool builder, since that's where hard capability requirements are already enforced.)

### Design

1. **Add a `requireVision` hard filter to `model-role-resolver.ts`'s judge-role resolution**, next to the existing `requireJsonOutput` filter (~lines 660-720). When set, it excludes any candidate model lacking vision/multimodal input support (use the same modality metadata `central-model-discovery-service.ts` already populates via `extractModelModalities`). `MediaJudgeEvaluator`'s role resolution call passes `requireVision: true`; the text judge's call passes `requireVision: false` (default, unchanged behavior).
2. **Wire real critics at both production call sites.** Three `MediaCriticRole` instances (`spec_compliance`, `artifact_quality`, `tone`), each a `MediaJudgeEvaluator` configured to resolve its judge model via `ModelRoleResolver` with `requireVision: true`. No new critic-role types — reuse the types already defined in `media-judge-evaluator.types.ts`.
3. **Verify judge cost flows into `PlannerBudget`.** Once critics are real, `totalJudgeCostUsd` (computed at `media-planner-strategy.ts:338-372`) will no longer always be 0. Confirm the cost computation reads real provider pricing (not a stub) and that `costCeilingMultiplier` actually stops the loop when exceeded — write a test that forces this.
4. **Fallback behavior when no vision-capable judge model is configured/available:** this must not silently degrade a request into "first candidate wins" without saying so. When `requireVision` filtering leaves an empty candidate pool, `MediaJudgeEvaluator` returns `scoringMode: 'unavailable'` (existing behavior) **and** the consensus step appends a note to the eventual `unmetConstraints[]`-adjacent turn log ("quality judging unavailable: no vision-capable judge model configured") so this is visible in the persisted audit trail, not silent.

### Testing
- Unit: pool builder respects `requireVision` (mocked model list with/without vision modality).
- Unit: `reconcileCriticResults` with 3 real (mocked) critic responses reconciles correctly (already covered for the empty-array case; add the 3-critic case using the existing test fixtures noted in the audit at `media-consensus-strategy.test.ts:143,203,240`).
- Integration (mocked provider clients, real orchestration logic): full consensus run with 3 wired critics, verify `pickBestCandidate` picks based on real scores, not "first that passes gate."
- **Real-money batch (flagged, needs go-ahead):** one end-to-end run against a real video/image provider + a real vision-capable judge model, to confirm the whole chain (generate → probe → judge → reconcile → select) works outside mocks. Estimate before running: N candidates × 1 provider call each + 3 critic calls × 1 judge-model call each.

---

## B. Attribute-aware catalog — generic type + 3-tier discovery

**Problem today:** `videoCapabilityAttributes` is video-only, hand-authored as 6 literal objects inside `providers.catalog.ts`, consumed by exactly one selector (`video-orchestration-service.ts`). No discovery job populates it. The original proposal's claim of "~7 selectors, populated during existing discovery jobs" doesn't hold.

**Re-evaluated design (this replaces the original proposal's "discovery job" claim with something that's actually safe to build):** automatic discovery is legitimate as long as it never lets an unverified guess drive a routing decision. Three tiers, ranked by trust:

### Tier 1 — Structured schema parsing (automatic, free, highest trust)

Where a provider publishes a real machine-readable schema for its generation endpoint (JSON Schema, OpenAPI, or a documented parameter list with enums/min/max), extend that provider's fetcher in `api/src/services/model-fetchers/*.ts` to parse the schema and populate the attribute fields directly from it. No inference, no LLM — the schema *is* the ground truth. Runs inside the existing discovery job (hourly/startup/manual triggers in `model-discovery-runner.ts`), no extra cost. Written with `source: 'schema'`, `attributesVerifiedAt: <fetch timestamp>`.

**First concrete target: RunwayML.** It already has a working adapter in this codebase (`api/src/providers/runwayml/runwayml-adapter.ts`) reading `options.duration`/`options.ratio`, and RunwayML publishes a documented, versioned request-parameter schema for its video-generation endpoint (enumerated `duration`/`ratio` values). Build and test the Tier 1 parser against RunwayML's fetcher first; treat fal.ai and Replicate (both known to expose per-model JSON schemas) as the next two candidates once the RunwayML parser is proven, before deciding whether the remaining video/image providers have anything parseable at all.

### Tier 2 — Empirical probing (automatic, real cost, high trust)

For providers without a public schema: a **separate, rate-limited, permanently-cached job** (not part of the hourly discovery cycle) that makes real boundary-testing calls — e.g. request a duration just above the currently-known/advertised ceiling, read the provider's *structured* validation error (error code/field, not free text) to confirm the real limit. Each model is probed once; the result is cached forever (re-probed only on manual trigger, e.g. after a provider changelog). Written with `source: 'probed'`, `attributesVerifiedAt`.

This tier costs real money per probe call and is explicitly the kind of batch this spec's testing policy flags before running — one estimate per provider before the first probe run.

### Tier 3 — LLM-assisted draft from vendor docs (automatic, zero trust until promoted)

An LLM reads vendor documentation text and proposes attribute values. Written with `source: 'llm_draft'` and **excluded from the constraint-matching predicate** — never used to accept or reject a model for a request. Drafts surface in a new admin-only read endpoint (`GET /v1/admin/catalog/attribute-drafts`) for manual review; approving one (`POST /v1/admin/catalog/attribute-drafts/:id/promote`) rewrites it with `source: 'human'`.

**Auto-promotion rule (runs as part of the Tier 2 probe job, right after a probe result is written):** after writing a `source: 'probed'` value for a model/attribute, the probe job checks whether an unpromoted `llm_draft` exists for the same model/attribute. If so, and the values agree — exact match for enum/boolean fields (e.g. `nativeAudioSupport`), or the probed value falls within ±10% of the drafted numeric value (e.g. `maxDurationSeconds`) — the draft's row is rewritten to `source: 'human'` (agreement-promoted) and the admin endpoint marks it as auto-resolved rather than pending. Disagreement leaves both rows in place (`probed` becomes the trusted one for routing regardless, per the predicate rule below; the stale draft stays visible in the admin list for review, not silently discarded).

### Generic type and predicate

- Generalize `ProviderCatalogEntry.videoCapabilityAttributes` into `capabilityAttributes: Partial<Record<Capability, CapabilityAttributes>>` where `CapabilityAttributes` is a discriminated union: reuse `VideoCapabilityAttributes` as-is for `video_generation`; add `ImageCapabilityAttributes` (dimensions, formats — needed by section D too) for `image_generation`/`image_editing`; add `DocumentCapabilityAttributes { maxPages }` for `pdf_understanding`. Every attribute object carries `source` and `attributesVerifiedAt`.
- One generic predicate, `canSatisfyCapabilityAttributes(capability, attrs, request)`, dispatching to per-capability matchers (`canSatisfyVideoAttributes` reused unchanged for video; new matchers for image/document following the identical fail-open-on-undeclared, fail-closed-on-conflict philosophy already documented in `video-capability-matcher.ts`). **The predicate only reads attributes with `source !== 'llm_draft'`.**
- Wire the predicate as a real pre-filter into: `video-orchestration-service.ts` (already done — no change), `images-orchestration-service.ts` (new), `pdf-service.ts` (new, for `maxPages`).
- **`media-planner-gate.ts`'s native-joint-collapse lookup** (`findNativeCollapseModel`) reads `Model.metadata.capabilityAttributes` — a runtime, per-model-instance field — while this section defines `capabilityAttributes` on `ProviderCatalogEntry`, a catalog-level (provider+capability) type. These are two different layers and nothing today projects one onto the other; the gate file's own comment already flags this exact seam as the one place to update. This section adds that missing projection: when the catalog (or a Tier 1/2/promoted-Tier-3 write) updates a `ProviderCatalogEntry.capabilityAttributes` entry, the same write path also updates `Model.metadata.capabilityAttributes` for every `Model` row backed by that provider+capability pair (a small denormalization step in the discovery/probe job's write path, not a separate sync job) — so `findNativeCollapseModel` keeps reading `Model.metadata` unchanged, it just stops reading an always-empty field.

### Testing
- Unit: each tier's writer, in isolation, with mocked schema/probe-response/LLM-output fixtures.
- Unit: predicate correctly ignores `llm_draft`-sourced attributes, correctly promotes on Tier 2/Tier 3 agreement.
- Integration: admin endpoints (list drafts, promote, verify promoted draft now affects routing).
- **Real-money batch (flagged):** Tier 2 probing run against each video/image provider not already covered by video's existing hand-verified data — one estimate per provider (typically 2-4 boundary calls per model) before running.

---

## C. Document/PDF generalization

**Problem today:** `pdf-service.ts` does extraction + one holistic analysis call. No role-differentiated critics, no fan-out, no page-anchored synthesis. `MediaGenerationCapability` in `media-consensus-strategy.ts` is typed `'video_generation' | 'image_generation'` only.

### Design

Reuse the fan-out + reconciliation machinery already built for media critics (`reconcileCriticResults` and the independent-critic-evaluation shape in `media-consensus-strategy.ts`) — this is real, tested infrastructure once section A wires it up — applied to extracted PDF text instead of video/image frames, not the single-generator/single-critic `CritiqueRepairStrategy` loop (wrong shape: that's sequential repair, not independent parallel critique).

1. Three critic roles specific to documents: `factual_accuracy`, `required_clause_presence`, `tone` — new role identifiers, same `MediaJudgeEvaluator`-shaped independent-evaluation contract, but text-only input (the PDF text with page markers already produced by `pdf-service.ts`'s extraction step), so no vision requirement here.
2. Each critic returns issues with the judge schema's existing `location` field populated as a page number.
3. A synthesis turn (one LLM call, not a critic) reconciles the three critics' issue lists into a single report grouped by page.
4. Dispatch point: when `MediaPlannerStrategy` sees a `capability_call` targeting `pdf_understanding` inside a planner run, it routes the result through this critic fan-out instead of returning the raw extraction — document review becomes a first-class planner path, not a separate strategy class.

### Testing
- Unit: each critic role in isolation (mocked judge responses).
- Unit: synthesis reconciliation with overlapping/conflicting page citations from different critics.
- Integration: full planner run against a multi-page PDF fixture (local file, no real cost) with mocked critic responses, verifying the final report cites real page numbers from the fixture.
- **Real-money batch (flagged):** one run with real critic-model calls against a real multi-page document, to sanity-check citation accuracy isn't a mocked artifact.

---

## D. Image editing with verify

**Problem today:** `PlannerActionSchema` has only `capability_call`, `generate`, `final`. `image_editing` is dispatched like any other `capability_call` — no dimension/format gate, no before/after vision-judge comparison, no bounded retry.

### Design

1. New planner action kind, `edit`, added to `PlannerActionSchema` alongside the existing three (additive, does not touch `capability_call`'s existing dispatch path — lower blast radius than generalizing `capability_call`, per the approach comparison in the approved design).
2. `ImageCapabilityAttributes` (dimensions, supported formats) — same type introduced in section B, reused here.
3. `image-deterministic-gate.ts`, mirroring `media-deterministic-gate.ts`'s shape but using a lightweight real image-probing library (not ffmpeg) to read the actual output image's dimensions/format and compare against the request.
4. Vision-judge comparison: reuse `buildMediaJudgeContent` (already builds real base64 image content for the judge) with a new prompt variant that presents both the pre-edit and post-edit image side by side, asking the judge to confirm the edit instruction was followed.
5. Bounded retry: on gate failure or judge rejection, retry the edit up to 2 times (mirrors the retry-on-gate-fail pattern already used in `MediaConsensusStrategy`), then falls through to `unmetConstraints[]` if still failing.

### Testing
- Unit: image-deterministic-gate against fixture images (correct/wrong dimensions, correct/wrong format).
- Unit: retry loop terminates at 2 attempts and populates `unmetConstraints[]` correctly on exhaustion.
- Integration: full `edit` action dispatch with mocked provider + mocked judge, verifying the retry path triggers on a simulated gate failure.
- **Real-money batch (flagged):** one real edit request through a real image-editing provider + real judge comparison.

---

## E. Chat/triage pipeline integration + canary rollout

**Problem today:** `MediaPlannerStrategy` is reachable only via the standalone `POST /v1/capabilities/media-plan/execute` route, gated by `MEDIA_PLANNER_ENABLED` (default `false`). `orchestration-engine.ts` has zero references to it. If the main chat/triage path fails open into generic chat (a scenario already fixed at the triage layer itself per the audit — `runHeuristics()` now preserves `requiredCapabilities`), nothing in the planner acts as an additional safety net for callers that never hit the dedicated route.

### Design

1. **Canary via a sibling resolver reusing the same pattern**, not a new percentage-rollout mechanism (none exists in this codebase, and building one is out of scope for this project) and not by extending `CoordinationConfig` itself. `CoordinationConfig`/`getCollectiveConfigForOrg` (`collective-feature-flags.ts`) is specifically the "collective coordination" multi-model consensus feature's config (rounds, convergence, dissent) — a `mediaPlannerEnabled` flag doesn't belong inside it semantically, even though the plumbing (TTL cache, DB-failure-safe fallback, `Organization.settings` JSON storage) is exactly what's needed. Concretely: add a second top-level key to `Organization.settings` (alongside the existing `collectiveConfig` key), e.g. `settings.mediaPlannerConfig: { enabled: boolean }`, and a new `getMediaPlannerConfigForOrg(orgId)` function in `collective-feature-flags.ts` (same file, same TTL-cache/fallback helpers factored out and reused, new function, new settings key — not a new type merged into `CoordinationConfig`). Effective gate = `MEDIA_PLANNER_ENABLED (global) OR getMediaPlannerConfigForOrg(orgId).enabled (canary allowlist)`.
2. **Integration point:** inside `orchestration-engine.ts`, after triage resolves (success or heuristic fallback) and the resulting plan is known, if the plan touches a media-generation capability (or the heuristic fallback path fired at all), call `evaluateMediaPlannerGate` before finalizing a chat-only decision. This is the exact spot the audit identified as the gap — it does not add gate evaluation to the common non-media chat path, since the gate call only happens after a media-shaped capability or a fallback has already been identified.
3. **Explicit failure path:** if triage fails and the heuristic fallback can't confidently determine required capabilities for a request that looks media-shaped, return a structured degraded-response error instead of silently answering as chat — closing the Section 08 risk from the original proposal.

### Testing
- Unit: canary flag resolution (global false + org true = enabled; global true + org unset = enabled; both false = disabled).
- Integration: simulate a triage heuristic-fallback scenario for a media-shaped request, verify the gate is consulted and the planner path is taken instead of silent chat.
- Integration: simulate the same for a non-media request, verify zero added latency/gate calls (assert the gate function isn't invoked at all).
- No real-money batch needed for this section on its own — canary validation in section "production rollout" below covers real end-to-end behavior.

### Production rollout (explicit, separate from any automated plan step)
1. Ship everything above behind the canary flag, default off everywhere.
2. You (the user) name specific org(s) to enable via the `collectiveConfig` override.
3. I monitor those orgs' `WorkflowExecution` audit records for the planner (turn counts, unmet constraints, judge costs, any thrashing/non-termination signs) and report back.
4. Only after you review that canary data do I flip `MEDIA_PLANNER_ENABLED` globally — this step is never taken automatically as part of executing a plan.

---

## F. Correct the stale `music_generation` narrative

**Problem today:** the original proposal's motivating example ("no soundtrack — no `music_generation` capability exists") and the corresponding test fixture (`media-planner-strategy.test.ts:130-135,174-175`) are factually wrong — `MusicOrchestrationService` has existed and been fully wired (ElevenLabs adapter, tests) since before this audit.

### Design
- Update the test fixture to use a capability that genuinely doesn't exist (or restructure it to inject a synthetic missing-capability scenario via a test double, rather than asserting against a real capability gap that may close again in the future — making the test robust to future capability additions).
- Grep `api/docs/adr/` (the real ADR path in this repo — not `docs/adr/`) and any other doc directories for the soundtrack/`music_generation`-gap narrative before assuming a specific file needs it; a spot-check during spec review found no existing ADR (including `ADR-024-agentic-capability-execution.md`, the most plausible candidate) actually contains this narrative, so this task may turn out to be "confirm nothing needs updating" rather than an actual edit. If the narrative does turn out to live in the original architecture-proposal document itself (outside this repo's `docs/`, e.g. wherever that proposal is published/stored), flag that separately rather than searching further inside the repo for it.

### Testing
- The updated test itself is the verification — no separate test needed.

---

## Dependencies between sections

- **B before D** (ImageCapabilityAttributes is defined in B, used by D's gate).
- **A before C's real-money batch** (C's fan-out reuses A's critic infrastructure; C can be built and unit-tested independently, but its real-provider validation needs A's wiring live).
- **A, B, C, D functionally independent otherwise** — can be implemented in parallel, each with its own plan.
- **E depends on nothing else being done** (it wires the *existing* planner into the chat pipeline; it becomes more valuable once A-D land, but doesn't require them).
- **F is fully independent, trivial, can happen anytime.**

## Out of scope (explicitly, to prevent scope creep)
- Percentage-based/random-bucket rollout infrastructure — canary is org-allowlist only, per approved design.
- A generic "verifiable capability_call" framework beyond images (section D's approach comparison already rejected generalizing `capability_call` itself — YAGNI now).
- Any change to the core `MediaPlannerStrategy` loop, gating heuristic, `unmetConstraints[]` schema, or audit persistence — the audit found these solid; this spec only closes the six gaps, not touches what already works.
