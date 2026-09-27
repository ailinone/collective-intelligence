<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# MediaPlanner Completion — Final Handoff

**Status as of 2026-09-25:** all six sub-projects (A–F) implemented, tested, committed, pushed, and opened as PRs. Nothing left uncommitted or unpushed in any local worktree. This document is written so a fresh session (with no memory of this conversation) can pick up exactly where this one left off.

---

## 0. How we got here (context for continuity)

1. **Audit** of the "ailin.one/ci — Composing media as a collective" architecture proposal against the running codebase. Found the `MediaPlannerStrategy` backbone (loop, gating, `unmetConstraints[]`, audit persistence) real and tested, but six areas partial or missing.
2. **Design spec** written and reviewed twice by an independent reviewer (all findings fixed): `docs/superpowers/specs/2026-09-23-media-planner-completion-design.md`.
3. **Six implementation plans**, one per gap, each self-verified against the actual codebase before execution: `docs/superpowers/plans/2026-09-23-media-planner-*.md`.
4. **Implementation**: six isolated git worktrees (one per section, to avoid file conflicts on shared files like `media-planner-types.ts`/`media-planner-strategy.ts`/`capabilities-routes.ts`), each executed via subagent-driven-development (or, for Section C after repeated tooling stalls, driven directly by the orchestrating session using the plan's own verbatim code).
5. **Six PRs opened**, each stacked on the foundational spec+plans PR.

---

## 1. PRs — this is the actual source of truth, not local state

| # | Section | Branch | Base | Status |
|---|---|---|---|---|
| [#642](https://github.com/ailinone/ci/pull/642) | Foundation (spec + 6 plans, docs-only) | `feat/media-planner-completion` | `main` | Open — **merge this first**, everything else stacks on it |
| [#643](https://github.com/ailinone/ci/pull/643) | A — Real judge/critics | `feat/media-planner-a-judge-critics` | `feat/media-planner-completion` | Open, complete (10/11 tasks — 1 real-cost task deferred) |
| [#668](https://github.com/ailinone/ci/pull/668) | B — Attribute-aware catalog | `feat/media-planner-b-catalog` | `feat/media-planner-completion` | Open, complete (11/12 tasks — 1 real-cost task deferred) |
| [#669](https://github.com/ailinone/ci/pull/669) | C — Document/PDF generalization | `feat/media-planner-c-documents` | `feat/media-planner-completion` | Open, complete (9/9 tasks — 1 separate real-cost validation section deferred) |
| [#644](https://github.com/ailinone/ci/pull/644) | D — Image editing with verify | `feat/media-planner-d-image-edit` | `feat/media-planner-completion` | Open, complete (6/7 tasks — 1 real-cost task deferred) |
| [#645](https://github.com/ailinone/ci/pull/645) | E — Chat/triage integration + canary | `feat/media-planner-e-chat-integration` | `feat/media-planner-completion` | Open, complete (8/8 tasks — no real-cost task in this section) |
| [#646](https://github.com/ailinone/ci/pull/646) | F — Fix stale `music_generation` narrative | `feat/media-planner-f-music-fix` | `feat/media-planner-completion` | Open, complete (1/1 task) |

All branches are pushed to `origin` (`ailinone/ci`) and every worktree's local `HEAD` matches its upstream exactly — verified immediately before writing this document. No uncommitted changes anywhere.

**Merge order:** #642 first (it's the base every other PR is stacked on). After that merges, A/B/C/D/E/F can merge in any order, but each will need a rebase onto `main` first since GitHub doesn't auto-retarget stacked PRs. None of this was done automatically — it's the first thing the next session (or you) should do.

---

## 2. Local worktrees (informational — the PRs are authoritative, not these)

All under `/Users/alissonidalo/Documents/GitHub/ailin.one/ci/.worktrees/`:

```
feat-media-planner-completion/   branch feat/media-planner-completion    (spec + 6 plans)
feat-media-planner-a/            branch feat/media-planner-a-judge-critics
feat-media-planner-b/            branch feat/media-planner-b-catalog
feat-media-planner-c/            branch feat/media-planner-c-documents
feat-media-planner-d/            branch feat/media-planner-d-image-edit
feat-media-planner-e/            branch feat/media-planner-e-chat-integration
feat-media-planner-f/            branch feat/media-planner-f-music-fix
```

These are safe to delete once the corresponding PR merges — nothing in them exists only locally. If continuing work in a fresh session, `git worktree add` a new one from the relevant branch rather than reusing these blindly (they may have stale `node_modules`/env quirks — see §4).

---

## 3. What each section actually delivered (and what's still open)

### A — Real judge/critics (PR #643)
- `requireVision` hard filter in `model-role-resolver.ts`'s judge-role resolution.
- Three real `MediaCriticRole` critics wired into both production call sites (`capabilities-routes.ts`, `chat-request-processor.ts`'s `generate_media`).
- New `MEDIA_PLANNER_JUDGE_ENABLED` flag (default off) — found mid-implementation that `generate_media` wasn't gated by `MEDIA_PLANNER_ENABLED` at all, so wiring real critics there unconditionally would have been a silent cost change.
- Non-silent degradation: no vision-capable judge model → visible note in the persisted audit trail, not silent `unavailable`.
- **Open:** Task 11 — one real validation run against a real provider + real vision-capable judge model. Needs: a cost estimate, your go-ahead, then someone to actually run it and report back.

### B — Attribute-aware catalog (PR #668)
- Generic `capabilityAttributes` type (video/image/document), replacing the video-only `videoCapabilityAttributes`.
- 3-tier discovery: Tier 1 (RunwayML schema parsing, free, automatic), Tier 2 (empirical probing, real cost, manual-trigger only), Tier 3 (LLM drafts, zero trust until promoted by a human or by Tier 2 agreement).
- New Prisma overlay table (`ProviderCapabilityAttributeRecord`) as the actual runtime persistence layer — discovered `ProviderCatalogEntry` is a static compiled TS array, nothing writes to it at runtime.
- `Model.metadata.capabilityAttributes` projection.
- **Open:** Task 12 — one real Tier 2 probing batch per provider not already covered by hand-verified video data. Needs a per-provider cost estimate and your go-ahead.
- **⚠️ Cross-front reconciliation needed at merge time:** Section B's `Model.metadata.capabilityAttributes` projection writes a **per-capability-keyed** shape (`{video_generation: {maxDurationSeconds, ...}}`). `media-planner-gate.ts`'s `findNativeCollapseModel` (owned by Section A/E's shared file) reads a **flat** shape (`maxDurationSec`, no capability key). Both independently confirmed real by two separate reviewers during implementation. **Whoever merges these branches together needs to either update the gate's reader or add a translation layer** — this was correctly left as a flagged gap rather than silently "fixed" by guessing which shape is right.

### C — Document/PDF generalization (PR #669)
- Corrected a real factual error found in the original spec during planning: no `location` field exists on the judge schema to "reuse" — added a genuinely new, additive `DocumentCriticIssue`/`EvaluationResult.issues?` field.
- `DocumentJudgeEvaluator` (mirrors `LLMJudgeEvaluator`, not `MediaJudgeEvaluator` — text-only, no vision dispatch needed).
- `ProviderDocumentJudgeClient`, `DocumentReviewStrategy` (3-critic fan-out + one real synthesis call + deterministic fallback), `pdf-service.ts` page-marker regression lock, planner dispatch interception for `pdf_understanding`, a real-PDF/real-extraction integration test, and safe-by-default production wiring (`critics: []`).
- **Open:** one real critic-model + real document validation run — explicitly depends on Section A's real judge wiring being live first (per the plan's own dependency note). Needs a cost estimate and your go-ahead.
- This section took by far the longest (~15+ hours of wall-clock time across a working day) due to repeated infrastructure failures in the nested subagent-controller pattern — see §5 for what went wrong and what to do differently next time.

### D — Image editing with verify (PR #644)
- New `edit` planner action kind (additive).
- `image-deterministic-gate.ts` using `image-size@1.2.1` — found `sharp` isn't actually a usable dependency in this repo (only a transitive CVE-override pin).
- Before/after vision-judge comparison, bounded retry (2 attempts) mirroring the planner's own turn-loop shape — found `MediaConsensusStrategy` doesn't have a retry-on-gate-fail loop as the original spec assumed.
- **Open:** one real edit request through a real provider + real judge comparison. Needs a cost estimate and your go-ahead.

### E — Chat/triage integration + canary (PR #645)
- `getMediaPlannerConfigForOrg()` — sibling canary resolver on a new `settings.mediaPlannerConfig` key, deliberately **not** merged into the unrelated `CoordinationConfig`/`collectiveConfig`.
- `maybeRouteToMediaPlannerSafetyNet()` wired into `orchestration-engine.ts`, called only after triage resolves and only for media-shaped/fallback cases — verified via spy assertions that a plain non-media chat request never touches the gate at all.
- Found and fixed a real uncaught-exception gap in the planner's `generate` branch before wiring it into the live chat path.
- `MEDIA_PLANNER_ENABLED` stays off globally by default — this PR ships canary infrastructure, not a flip.
- **Open (not a task, a decision):** you need to name specific orgs to enable via `mediaPlannerConfig`, then someone monitors `WorkflowExecution` audit records for those orgs, then — separately, explicitly — decide whether to flip `MEDIA_PLANNER_ENABLED` globally. None of this happens automatically.

### F — Fix stale `music_generation` narrative (PR #646)
- Investigated first: the stale "no `music_generation` capability" narrative only ever lived in one test fixture, not in any doc/ADR. Fixed the test, didn't invent unnecessary doc edits.

---

## 4. Environment quirks discovered (save the next session hours of rediscovery)

- **`pnpm`'s corepack shim was broken** system-wide at the start of this work (`ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`). Fixed once, globally, via `npm install -g pnpm@9 --force` (overwrote the broken shim with a real binary). Should still be fixed on this machine, but if `pnpm --version` errors again, that's the fix.
- **Even after that fix, `pnpm` can still fail inside `api/`** specifically, because `api/pnpm-workspace.yaml` is a build-script-policy file some pnpm versions reject (`packages field missing or empty`). Workaround used throughout: `npx -y pnpm@10.14.0 install` (matches CI's pinned version) instead of the global `pnpm`.
- **Node version matters a lot.** The default active node (via nvm, v20.18.1) causes vitest to silently report "No test files found" — the real failure is `TypeError: webidl.util.markAsUncloneable is not a function` from an `undici`/testcontainers incompatibility, easy to misread as "no tests exist." **Always run tests with Node ≥24** — this worktree set has `v24.5.0` installed at `/Users/alissonidalo/.nvm/versions/node/v24.5.0/bin/`; prepend that to `PATH` (`export PATH="/Users/alissonidalo/.nvm/versions/node/v24.5.0/bin:$PATH"`) before running any `npx vitest`/`npx tsc` command.
- **The default `vitest.config.ts` excludes `src/core/orchestration/strategies/__tests__/**` entirely.** Tests living in that directory (including `media-planner-strategy.test.ts` and the new document-review integration test) must run with `npx vitest run --config vitest.orchestration.config.ts` instead of the default config. Tests living directly in `strategies/` (not under `__tests__/`, e.g. `document-review-strategy.test.ts`) use the default config fine.
- **Baseline test failures pre-exist this work** and are environment-related, not regressions: real-Postgres/Redis/testcontainers tests, tests needing real cloud credentials (Google/XAI/DeepSeek), and one Docker-image-dependent test (`agentic-sandbox-dispatch.test.ts` needing a local `alpine:3.20` image). Every section's controller/implementer independently confirmed these predate their changes.

---

## 5. What went wrong in Section C (read this before repeating the pattern)

Section C's nested-controller pattern (front-controller dispatching implementer + spec-reviewer + code-quality-reviewer subagents, itself dispatched by the orchestrating session) suffered repeated ~5+ hour stalls. Root cause, confirmed directly: **a nested subagent's background-task completion notification was delivered to the top-level orchestrating session, not to the intermediate controller that actually dispatched it.** The controller would correctly wait for "its" dispatch's result and never receive it, while the orchestrating session sat on the answer without realizing the controller needed it relayed. This happened at least three times before being diagnosed.

**What fixed it each time:** the orchestrating session manually copy-pasted the nested agent's full output back to the stalled controller as a message, telling it to treat that as the authoritative, received result.

**What ultimately resolved Section C for good:** after the pattern recurred a fourth time with 15+ hours elapsed and no commits landing, the orchestrating session abandoned the nested-controller pattern entirely and implemented Tasks 3–9 directly (reading the plan's own complete verbatim code and applying it with Write/Edit/Bash, no further subagent dispatch). This took under an hour for 7 tasks, versus 15+ hours for the first 2 tasks via the nested pattern.

**Recommendation for any future multi-agent work in this environment:** avoid a three-level dispatch chain (orchestrator → front-controller → implementer/reviewer) for anything where the plan already contains complete, ready-to-apply code. A flatter approach — the orchestrating session either implements directly from a sufficiently detailed plan, or dispatches implementer/reviewer subagents itself (two levels, not three) — sidesteps this notification-routing failure mode entirely.

---

## 6. Immediate next steps, in order

1. **Review and merge PR #642** (foundation — spec + 6 plans, docs-only, lowest risk).
2. **Rebase and review PRs #643, #668, #669, #644, #645, #646** onto `main` post-merge, in any order.
3. **Resolve the B/gate shape mismatch** (§3, Section B) during integration — decide whether `media-planner-gate.ts` reads the per-capability-keyed shape or `Model.metadata` gets a flat projection instead, and apply it as part of whichever PR merges second between B and A/E.
4. **Decide on the 4 deferred real-cost validation batches** (A/B/C/D each have one) — each needs an explicit cost estimate reviewed and a go-ahead before anyone runs it. None are blocking for merging the code itself; they validate real-provider behavior on top of code that's already fully tested against mocks.
5. **Section E's canary rollout** — name specific orgs, monitor `WorkflowExecution` audit records, then decide on the global `MEDIA_PLANNER_ENABLED` flip as a separate, explicit step.
6. Once all 6 PRs are merged and the deferred validations are either run or explicitly deprioritized, the MediaPlanner architecture is complete relative to the original proposal's six identified gaps.
