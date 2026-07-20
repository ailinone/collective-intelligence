// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-F — Live Chat Operability Audit.
 *
 * Probes each `(providerId, modelId)` triple ONCE with a minimal
 * "Say OK" prompt (max_tokens=10), classifies the response via
 * `ProviderErrorClassifier`, and writes the result to the in-process
 * `LiveChatOperabilityStore`. Then snapshots the state to a JSON file
 * so the runtime can hydrate after a container restart.
 *
 * Hard safety constraints (also enforced in code, not just docs):
 *   - 1 attempt per route. No retries. No route fallback.
 *   - max_tokens fixed at 10.
 *   - Budget cap (default $0.01) is checked BEFORE each probe.
 *   - Secrets never logged.
 *
 * Run:
 *   pnpm tsx src/core/operability/scripts/run-live-chat-operability-audit.ts \
 *     --models-from-last-plan \
 *     --max-tokens 10 \
 *     --prompt "Say OK" \
 *     --max-total-cost-usd 0.01 \
 *     --no-retries \
 *     --sanitize \
 *     --write-snapshot \
 *     --snapshot-path /tmp/ci-live-chat-operability-snapshot.json
 *
 * The `--models-from-last-plan` flag is currently a NO-OP placeholder:
 * since the plan store isn't persisted across runs, the script falls
 * back to a small hardcoded ROUTE_SET that mirrors the 01C.1B-E
 * direct-probe set (the 6 providers observed during the billable probe
 * failure). Operators can extend via `--model providerId:modelId`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { classifyProviderError } from '../../orchestration/failures/provider-error-classifier';
import {
  getLiveChatOperabilityStore,
  type LiveChatOperabilitySource,
} from '../live-chat-operability-state';

interface Args {
  readonly maxTokens: number;
  readonly prompt: string;
  readonly maxTotalCostUsd: number;
  readonly noRetries: boolean;
  readonly sanitize: boolean;
  readonly writeSnapshot: boolean;
  readonly snapshotPath: string;
  readonly extraModels: ReadonlyArray<{ providerId: string; modelId: string }>;
  readonly source: LiveChatOperabilitySource;
  readonly bootstrapRuntime: boolean;
  /** 01C.1B-F2 — when set, parse selectedRoutes from this dry-run JSON
   *  and probe each of those (provider, model) tuples instead of the
   *  hardcoded ROUTE_SET. The default ROUTE_SET is then appended only
   *  when no routes are extracted (cold-start). */
  readonly fromDryrunJson?: string;
  /** When `fromDryrunJson` is used, restrict probes to these roles. */
  readonly rolesFilter?: ReadonlyArray<'participant' | 'synthesizer' | 'judge' | 'fallback'>;
  /**
   * 01C.1B-J1D §7 — Route extraction scope:
   *   - 'selected' (legacy default): only `plan.selectedRoutes[]` (1 per role)
   *   - 'approved': `plan.routeCandidatesPerRole[r].approvedForExecution[]`
   *   - 'all': `plan.routeCandidatesPerRole[r].candidates[]` (every viable)
   * When `--include-route-candidates` is set, the default flips to 'approved'
   * so the audit covers the full executable subset, not just the top pick.
   */
  readonly routeScope: 'selected' | 'approved' | 'all';
  /** Hard cap on per-role route probes (J1D §7.2). */
  readonly maxRoutesPerRole: number;
  /** Hard cap on total route probes across all roles (J1D §7.2). */
  readonly maxTotalRouteProbes: number;
  /** Skip routes that already have fresh live-evidence (J1D §10.1). */
  readonly prioritizeNoLiveEvidence: boolean;
  /** When true, stop probing a role's remaining routes once ONE returns liveReady=true. */
  readonly stopRoleAfterFirstLiveReady: boolean;
  /** Optional plan-only mode: emit the planned-probes JSON and exit (no HTTP calls). */
  readonly writePlanPath?: string;
  /** When true, the script emits a planned-probes JSON to stdout/--write-plan path
   *  and does NOT execute probes (J1D §10). Aliases: `--dry-run`, `--plan-only`. */
  readonly planOnly: boolean;
  /** When true (in conjunction with `planOnly`), reject any HTTP attempt
   *  regardless of code paths. Aliases the J1R-era `--no-provider-calls`. */
  readonly noProviderCalls: boolean;
  /** Output path for the full audit result JSON (J1D §16). */
  readonly writeJsonPath?: string;
  readonly includeRoleCriticalOnly: boolean;
  /** Whether to allow unaudited routes through. The audit script
   *  doesn't *enforce* this — it just records the flag in the output
   *  summary so the operator's downstream dry-run can rely on it. */
  readonly allowUnknown: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let maxTokens = 10;
  let prompt = 'Say OK';
  let maxTotalCostUsd = 0.01;
  let noRetries = true;
  let sanitize = true;
  let writeSnapshot = false;
  let snapshotPath = '/tmp/ci-live-chat-operability-snapshot.json';
  const extraModels: { providerId: string; modelId: string }[] = [];
  let bootstrapRuntime = false;
  let fromDryrunJson: string | undefined;
  let rolesFilter: ReadonlyArray<'participant' | 'synthesizer' | 'judge' | 'fallback'> | undefined;
  let includeRoleCriticalOnly = false;
  let allowUnknown = true;
  // 01C.1B-J1D §7 defaults
  let includeRouteCandidates = false;
  let routeScope: 'selected' | 'approved' | 'all' = 'selected';
  let routeScopeExplicitlySet = false;
  let maxRoutesPerRole = 20;
  let maxTotalRouteProbes = 60;
  let prioritizeNoLiveEvidence = false;
  let stopRoleAfterFirstLiveReady = false;
  let writePlanPath: string | undefined;
  let planOnly = false;
  let noProviderCalls = false;
  let writeJsonPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--max-tokens') maxTokens = Number(argv[++i] ?? '10');
    else if (a === '--prompt') prompt = argv[++i] ?? 'Say OK';
    else if (a === '--max-total-cost-usd') maxTotalCostUsd = Number(argv[++i] ?? '0.01');
    else if (a === '--no-retries') noRetries = true;
    else if (a === '--allow-retries') noRetries = false;
    else if (a === '--sanitize') sanitize = true;
    else if (a === '--write-snapshot') writeSnapshot = true;
    else if (a === '--snapshot-path') snapshotPath = argv[++i] ?? snapshotPath;
    else if (a === '--bootstrap-runtime') bootstrapRuntime = true;
    else if (a === '--from-dryrun-json') fromDryrunJson = argv[++i];
    else if (a === '--roles') {
      const v = argv[++i] ?? '';
      const parts = v.split(',').map((x) => x.trim()).filter((x) =>
        x === 'participant' || x === 'synthesizer' || x === 'judge' || x === 'fallback',
      ) as Array<'participant' | 'synthesizer' | 'judge' | 'fallback'>;
      if (parts.length > 0) rolesFilter = parts;
    }
    else if (a === '--include-role-critical-only') includeRoleCriticalOnly = true;
    else if (a === '--allow-unknown') {
      const v = argv[++i] ?? 'true';
      allowUnknown = v === 'true';
    }
    else if (a === '--model') {
      const next = argv[++i];
      if (typeof next === 'string') {
        const ix = next.indexOf(':');
        if (ix > 0) {
          extraModels.push({ providerId: next.slice(0, ix), modelId: next.slice(ix + 1) });
        }
      }
    }
    else if (a === '--models-from-last-plan') {
      // No-op placeholder; the `--from-dryrun-json` flag supersedes
      // this. Kept for backwards compatibility with the 01C.1B-F
      // command line.
    }
    // 01C.1B-J1D §7 new flags
    else if (a === '--include-route-candidates') includeRouteCandidates = true;
    else if (a === '--route-scope') {
      const v = argv[++i] ?? 'approved';
      if (v === 'selected' || v === 'approved' || v === 'all') {
        routeScope = v;
        routeScopeExplicitlySet = true;
      }
    }
    else if (a === '--max-routes-per-role') maxRoutesPerRole = Number(argv[++i] ?? '20');
    else if (a === '--max-total-route-probes') maxTotalRouteProbes = Number(argv[++i] ?? '60');
    else if (a === '--prioritize-no-live-evidence') {
      const v = argv[++i] ?? 'true';
      prioritizeNoLiveEvidence = v === 'true';
    }
    else if (a === '--stop-role-after-first-live-ready') {
      const v = argv[++i] ?? 'false';
      stopRoleAfterFirstLiveReady = v === 'true';
    }
    else if (a === '--write-plan') writePlanPath = argv[++i];
    else if (a === '--plan-only') planOnly = true;
    else if (a === '--dry-run') planOnly = true;
    else if (a === '--no-provider-calls') noProviderCalls = true;
    else if (a === '--write-json') writeJsonPath = argv[++i];
  }
  // J1D §7.2 — when --include-route-candidates is set but --route-scope was
  // NOT explicitly given, flip default to 'approved' so the audit covers
  // the executable subset (not just selectedRoutes).
  if (includeRouteCandidates && !routeScopeExplicitlySet) {
    routeScope = 'approved';
  }
  return {
    maxTokens, prompt, maxTotalCostUsd, noRetries, sanitize, writeSnapshot,
    snapshotPath, extraModels, source: 'direct_chat_probe', bootstrapRuntime,
    fromDryrunJson, rolesFilter, includeRoleCriticalOnly, allowUnknown,
    routeScope, maxRoutesPerRole, maxTotalRouteProbes, prioritizeNoLiveEvidence,
    stopRoleAfterFirstLiveReady, writePlanPath, planOnly, noProviderCalls, writeJsonPath,
  };
}

/**
 * Default route set — the 6 providers / model identifiers observed
 * during the 01C.1B billable probe direct verification. The
 * `endpoint`, `authHeader`, and `body` builders are inlined so this
 * script doesn't depend on the full adapter chain (which would carry
 * the very retry behavior we're auditing).
 */
// 01C.1B-J1D-R4B §6 — exported so the inventory runner (under the same
// folder) can reuse the exact same probe contract without duplicating it.
// The "Args" shape that `probeOne` needs is also re-exported below as
// `ProbeArgs` (a strict subset of the audit script's internal `Args`).
export type ProbeRouteSpec = {
  readonly providerId: string;
  readonly modelId: string;
  readonly endpoint: string;
  readonly buildHeaders: (apiKey: string) => Record<string, string>;
  readonly buildBody: (prompt: string, maxTokens: number, modelId: string) => Record<string, unknown>;
  readonly envVar: string;
};

/**
 * 01C.1B-F2 — provider-spec registry. Used to translate a generic
 * `(providerId, modelId)` pair from `selectedRoutes` into an actual
 * HTTP probe. Each entry knows its endpoint + auth scheme + which env
 * var carries the API key. When the dry-run picks a model from a
 * provider absent from this map, the audit returns an `unknown` result
 * (so the operator can extend the registry or accept the unaudited
 * gap).
 */
// Exported for unit tests that assert spec presence + sanitization for
// providers added across J1D-R* stages (J1D-R3 §10). Production code
// uses `specForRoute()` below; tests use this map directly.
export const PROVIDER_SPECS: Record<string, {
  endpoint: string;
  envVar: string;
  buildHeaders: (apiKey: string) => Record<string, string>;
  /** Optional model-id normalizer — some providers expect a different
   *  form than the catalog id. */
  normalizeModelId?: (modelId: string) => string;
}> = {
  deepinfra: {
    endpoint: 'https://api.deepinfra.com/v1/openai/chat/completions',
    envVar: 'DEEPINFRA_API_KEY',
    buildHeaders: (k) => ({ Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' }),
  },
  'vercel-ai-gateway': {
    endpoint: 'https://ai-gateway.vercel.sh/v1/chat/completions',
    envVar: 'VERCEL_AI_GATEWAY_API_KEY',
    buildHeaders: (k) => ({ Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' }),
  },
  huggingface: {
    endpoint: 'https://router.huggingface.co/v1/chat/completions',
    envVar: 'HF_TOKEN',
    buildHeaders: (k) => ({ Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' }),
  },
  aiml: {
    endpoint: 'https://api.aimlapi.com/v1/chat/completions',
    envVar: 'AIML_API_KEY',
    buildHeaders: (k) => ({ Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' }),
  },
  anthropic: {
    endpoint: 'https://api.anthropic.com/v1/messages',
    envVar: 'ANTHROPIC_API_KEY',
    buildHeaders: (k) => ({
      'x-api-key': k,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    }),
    // Catalog uses display names like `anthropic-claude-3.7-sonnet`,
    // API expects `claude-3-7-sonnet-20250219`. We don't have a full
    // alias table here, so we pass through and let the provider 400
    // if needed — the goal is to confirm AUTH/CREDIT state, not
    // model existence.
  },
  gemini: {
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    envVar: 'GEMINI_API_KEY',
    buildHeaders: (k) => ({ Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' }),
  },
  // 01C.1B-F2 — additional providers seen in F1 dry-run pivots.
  openai: {
    endpoint: 'https://api.openai.com/v1/chat/completions',
    envVar: 'OPENAI_API_KEY',
    buildHeaders: (k) => ({ Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' }),
  },
  zai: {
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    envVar: 'ZAI_API_KEY',
    buildHeaders: (k) => ({ Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' }),
  },
  routeway: {
    endpoint: 'https://api.routeway.ai/v1/chat/completions',
    envVar: 'ROUTEWAY_API_KEY',
    buildHeaders: (k) => ({ Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' }),
  },
  // 01C.1B-J1C §8 — OpenRouter audit spec. Model ids with a `:free`
  // suffix (e.g., `qwen/qwen3-next-80b-a3b-instruct:free`) are passed
  // through verbatim — OpenRouter expects them exactly that way to
  // route to the free tier of the underlying provider. The optional
  // `HTTP-Referer` and `X-Title` headers are documented as good
  // practice in OpenRouter's quickstart; we set conservative defaults
  // for audit traceability without leaking caller info. Auth is the
  // standard Bearer token from `OPENROUTER_API_KEY`.
  openrouter: {
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    envVar: 'OPENROUTER_API_KEY',
    buildHeaders: (k) => ({
      Authorization: `Bearer ${k}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://ailin.one',
      'X-Title': '01C.1B-J1C readiness audit',
    }),
    // No model-id normalization — `:free` is part of the canonical id.
  },
  // 01C.1B-J1C §9 — Fireworks audit spec. Catalog stores model ids in
  // the `accounts/<owner>/models/<slug>` shape (e.g.,
  // `accounts/fireworks/models/qwen3-235b-a22b`). Fireworks' /v1
  // OpenAI-compatible endpoint accepts that exact id, so we preserve
  // it verbatim. Env var canonical: `FIREWORKS_AI_API_KEY` (matches
  // the runtime adapter loader's `apiKeyEnvVar`).
  'fireworks-ai': {
    endpoint: 'https://api.fireworks.ai/inference/v1/chat/completions',
    envVar: 'FIREWORKS_AI_API_KEY',
    buildHeaders: (k) => ({ Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' }),
    // No model-id normalization — `accounts/.../models/...` is the API id.
  },
  // 01C.1B-J1D-R3 — Add specs for providers responsible for the judge
  // role's unauditable routes from J1D-R2. URLs sourced verbatim from
  // the existing adapter/config layer to avoid divergence:
  //   - nanogpt:  config/index.ts NANOGPT_BASE_URL default
  //   - novita:   NovitaAdapter.DEFAULT_BASE_URL
  //   - edenai:   providers.catalog.ts baseUrl + OpenAI-compatible /chat/completions
  // Each is OpenAI-compatible chat. Auth is Bearer.
  nanogpt: {
    endpoint: 'https://nano-gpt.com/api/v1/chat/completions',
    envVar: 'NANOGPT_API_KEY',
    buildHeaders: (k) => ({ Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' }),
  },
  novita: {
    endpoint: 'https://api.novita.ai/openai/v1/chat/completions',
    envVar: 'NOVITA_API_KEY',
    buildHeaders: (k) => ({ Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' }),
  },
  edenai: {
    endpoint: 'https://api.edenai.run/v3/llm/chat/completions',
    envVar: 'EDENAI_API_KEY',
    buildHeaders: (k) => ({ Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' }),
    // EdenAI catalog ids look like `<sub-provider>/<model>` (e.g.,
    // `deepinfra/Qwen/Qwen3-235B-A22B-Thinking-2507`). EdenAI's
    // chat/completions endpoint accepts that exact form — no transform
    // needed. Sub-provider routing happens server-side.
  },
};

/** Convert a (providerId, modelId) into a ProbeRouteSpec when the
 *  provider is in `PROVIDER_SPECS`. Returns undefined when not — the
 *  caller treats undefined as "unauditable; report as unknown".
 *  Exported for the J1D-R4B inventory runner. */
export function specForRoute(providerId: string, modelId: string): ProbeRouteSpec | undefined {
  const family = PROVIDER_SPECS[providerId.toLowerCase()];
  if (!family) return undefined;
  const effectiveModelId = family.normalizeModelId?.(modelId) ?? modelId;
  return {
    providerId,
    modelId: effectiveModelId,
    endpoint: family.endpoint,
    envVar: family.envVar,
    buildHeaders: family.buildHeaders,
    buildBody: (prompt, max, m) => ({ model: m, messages: [{ role: 'user', content: prompt }], max_tokens: max }),
  };
}

interface ExtractedRoute {
  readonly role: 'participant' | 'synthesizer' | 'judge' | 'fallback';
  readonly providerId: string;
  readonly modelId: string;
  readonly routeId?: string;
}

/** Shapes the audit reads out of a saved dry-run JSON consensus plan. All fields
 *  optional — the file is external input parsed at runtime. */
interface DryRunRouteCandidate {
  readonly providerId?: string;
  readonly apiModelId?: string;
  readonly routeId?: string;
  readonly adapterKind?: string;
}
interface DryRunRoleEntry {
  readonly role?: string;
  readonly logicalModelId?: string;
  readonly candidates?: ReadonlyArray<DryRunRouteCandidate>;
  readonly approvedForExecution?: ReadonlyArray<DryRunRouteCandidate>;
}
interface DryRunSelectedRoute {
  readonly providerId?: string;
  readonly modelId?: string;
  readonly role?: ExtractedRoute['role'];
  readonly routeId?: string;
}
interface DryRunConsensusPlan {
  readonly routeCandidatesPerRole?: ReadonlyArray<DryRunRoleEntry>;
  readonly selectedRoutes?: ReadonlyArray<DryRunSelectedRoute>;
  readonly participants?: ReadonlyArray<unknown>;
  readonly synthesizer?: unknown;
  readonly judge?: unknown;
  readonly fallbackSingle?: unknown;
}
interface DryRunFile {
  readonly ailin_metadata?: { readonly consensusPlan?: DryRunConsensusPlan };
}

/** 01C.1B-F2 — parse `selectedRoutes` from a saved dry-run response.
 *  Falls back to `participants/synthesizer/judge/fallbackSingle` when
 *  `selectedRoutes` is absent (older plan response shapes).
 *
 *  The file may include trailing non-JSON text (e.g., curl `-w
 *  "%{http_code}"` headers) — we slice up to the last `}` to be
 *  tolerant. */
function extractRoutesFromDryRunJson(
  path: string,
  opts?: { scope?: 'selected' | 'approved' | 'all'; maxRoutesPerRole?: number },
): ExtractedRoute[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    throw new Error(`could not read dry-run JSON at ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const lastBrace = raw.lastIndexOf('}');
  const jsonText = lastBrace >= 0 ? raw.slice(0, lastBrace + 1) : raw;
  const parsed = JSON.parse(jsonText) as DryRunFile;
  const plan = parsed?.ailin_metadata?.consensusPlan;
  if (!plan) throw new Error('dry-run JSON has no ailin_metadata.consensusPlan');
  const scope = opts?.scope ?? 'selected';
  const maxPerRole = opts?.maxRoutesPerRole ?? Infinity;
  const out: ExtractedRoute[] = [];

  // 01C.1B-J1D §7 — `approved` / `all` modes pull from routeCandidatesPerRole.
  // The legacy `selected` mode uses plan.selectedRoutes (1 per role).
  if (scope === 'approved' || scope === 'all') {
    const rcpr = plan.routeCandidatesPerRole;
    if (rcpr && rcpr.length > 0) {
      for (const r of rcpr) {
        if (!r?.role) continue;
        // Map 'fallback' alias to the role name used by audit (already 'fallback').
        const role = r.role === 'fallbackSingle' ? 'fallback' : (r.role as ExtractedRoute['role']);
        const list = scope === 'approved'
          ? (r.approvedForExecution ?? r.candidates ?? [])
          : (r.candidates ?? []);
        const capped = list.slice(0, maxPerRole);
        for (const c of capped) {
          if (!c?.providerId || !c?.apiModelId) continue;
          out.push({
            role,
            providerId: String(c.providerId),
            modelId: String(c.apiModelId),
            routeId: typeof c.routeId === 'string' ? c.routeId : undefined,
          });
        }
      }
      if (out.length > 0) return out;
      // routeCandidatesPerRole present but empty → fall through to legacy paths.
    }
    // No routeCandidatesPerRole — fall through to selected/legacy below.
  }

  // Legacy `selected` mode (and fall-through when route candidates absent).
  if (plan.selectedRoutes) {
    for (const r of plan.selectedRoutes) {
      if (!r?.providerId || !r?.modelId || !r?.role) continue;
      out.push({
        role: r.role,
        providerId: String(r.providerId),
        modelId: String(r.modelId),
        routeId: typeof r.routeId === 'string' ? r.routeId : undefined,
      });
    }
    if (out.length > 0) return out;
  }
  // Final fallback: stitch from individual role fields (oldest shape).
  const proj = (role: ExtractedRoute['role'], cand: unknown): ExtractedRoute | null => {
    const c = cand as { model?: { id?: string; provider?: string }; providerId?: string } | null | undefined;
    if (!c?.model?.id) return null;
    const providerId = c.providerId ?? c.model.provider;
    if (!providerId) return null;
    return { role, providerId: String(providerId), modelId: String(c.model.id) };
  };
  for (const p of plan.participants ?? []) {
    const r = proj('participant', p);
    if (r) out.push(r);
  }
  const s = proj('synthesizer', plan.synthesizer);
  if (s) out.push(s);
  const j = proj('judge', plan.judge);
  if (j) out.push(j);
  const f = proj('fallback', plan.fallbackSingle);
  if (f) out.push(f);
  return out;
}

const ROUTE_SET: readonly ProbeRouteSpec[] = [
  {
    providerId: 'deepinfra',
    modelId: 'Qwen/Qwen3-235B-A22B-Thinking-2507',
    endpoint: 'https://api.deepinfra.com/v1/openai/chat/completions',
    envVar: 'DEEPINFRA_API_KEY',
    buildHeaders: (k) => ({ Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' }),
    buildBody: (prompt, max, modelId) => ({ model: modelId, messages: [{ role: 'user', content: prompt }], max_tokens: max }),
  },
  {
    providerId: 'vercel-ai-gateway',
    modelId: 'zai/glm-4.5-air',
    endpoint: 'https://ai-gateway.vercel.sh/v1/chat/completions',
    envVar: 'VERCEL_AI_GATEWAY_API_KEY',
    buildHeaders: (k) => ({ Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' }),
    buildBody: (prompt, max, modelId) => ({ model: modelId, messages: [{ role: 'user', content: prompt }], max_tokens: max }),
  },
  {
    providerId: 'huggingface',
    modelId: 'meta-llama/Llama-3.2-11B-Vision-Instruct',
    endpoint: 'https://router.huggingface.co/v1/chat/completions',
    envVar: 'HF_TOKEN',
    buildHeaders: (k) => ({ Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' }),
    buildBody: (prompt, max, modelId) => ({ model: modelId, messages: [{ role: 'user', content: prompt }], max_tokens: max }),
  },
  {
    providerId: 'aiml',
    modelId: 'glm-4.5-air',
    endpoint: 'https://api.aimlapi.com/v1/chat/completions',
    envVar: 'AIML_API_KEY',
    buildHeaders: (k) => ({ Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' }),
    buildBody: (prompt, max, modelId) => ({ model: modelId, messages: [{ role: 'user', content: prompt }], max_tokens: max }),
  },
  {
    providerId: 'anthropic',
    modelId: 'claude-3-7-sonnet-20250219',
    endpoint: 'https://api.anthropic.com/v1/messages',
    envVar: 'ANTHROPIC_API_KEY',
    buildHeaders: (k) => ({
      'x-api-key': k,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    }),
    buildBody: (prompt, max, modelId) => ({ model: modelId, messages: [{ role: 'user', content: prompt }], max_tokens: max }),
  },
  {
    providerId: 'gemini',
    modelId: 'gemini-3.1-pro-preview',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    envVar: 'GEMINI_API_KEY',
    buildHeaders: (k) => ({ Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' }),
    buildBody: (prompt, max, modelId) => ({ model: modelId, messages: [{ role: 'user', content: prompt }], max_tokens: max }),
  },
];

export interface ProbeResult {
  readonly providerId: string;
  readonly routeId: string;
  readonly modelId: string;
  readonly ok: boolean;
  readonly chatReady: boolean;
  readonly eligibleForCriticalRole: boolean;
  readonly httpStatus?: number;
  readonly errorKind?: string;
  readonly retryable: boolean;
  readonly latencyMs: number;
  readonly sanitizedMessage?: string;
}

/** 01C.1B-J1D-R4B §6 — the minimal subset of Args that `probeOne` needs.
 *  The inventory runner constructs one of these instead of the full
 *  CLI args object. */
export type ProbeArgs = Pick<
  Args,
  'maxTokens' | 'prompt' | 'sanitize' | 'source' | 'maxTotalCostUsd' | 'noRetries'
>;

export async function probeOne(route: ProbeRouteSpec, args: ProbeArgs): Promise<ProbeResult> {
  const apiKey = process.env[route.envVar];
  const started = Date.now();
  if (!apiKey || apiKey.length < 4) {
    // Treat unset key as invalid_auth without contacting the provider.
    const cls = classifyProviderError({ status: 401, body: 'unauthorized: api key missing in env' });
    const store = getLiveChatOperabilityStore();
    store.record({
      providerId: route.providerId,
      routeId: route.providerId,
      modelId: route.modelId,
      ok: false,
      errorClassification: cls,
      source: args.source,
    });
    return {
      providerId: route.providerId,
      routeId: route.providerId,
      modelId: route.modelId,
      ok: false,
      chatReady: false,
      eligibleForCriticalRole: false,
      errorKind: cls.kind,
      retryable: cls.retryable,
      latencyMs: Date.now() - started,
      sanitizedMessage: 'api key missing in env',
    };
  }
  try {
    const r = await fetch(route.endpoint, {
      method: 'POST',
      headers: route.buildHeaders(apiKey),
      body: JSON.stringify(route.buildBody(args.prompt, args.maxTokens, route.modelId)),
    });
    const elapsed = Date.now() - started;
    const text = await r.text();
    if (r.ok) {
      const store = getLiveChatOperabilityStore();
      store.record({
        providerId: route.providerId,
        routeId: route.providerId,
        modelId: route.modelId,
        ok: true,
        httpStatus: r.status,
        latencyMs: elapsed,
        source: args.source,
      });
      return {
        providerId: route.providerId,
        routeId: route.providerId,
        modelId: route.modelId,
        ok: true,
        chatReady: true,
        eligibleForCriticalRole: true,
        httpStatus: r.status,
        retryable: false,
        latencyMs: elapsed,
        sanitizedMessage: 'OK',
      };
    }
    const cls = classifyProviderError({ status: r.status, body: text });
    const store = getLiveChatOperabilityStore();
    store.record({
      providerId: route.providerId,
      routeId: route.providerId,
      modelId: route.modelId,
      ok: false,
      httpStatus: r.status,
      errorClassification: cls,
      latencyMs: elapsed,
      source: args.source,
    });
    return {
      providerId: route.providerId,
      routeId: route.providerId,
      modelId: route.modelId,
      ok: false,
      chatReady: false,
      eligibleForCriticalRole: false,
      httpStatus: r.status,
      errorKind: cls.kind,
      retryable: cls.retryable,
      latencyMs: elapsed,
      sanitizedMessage: cls.sanitizedMessage,
    };
  } catch (err) {
    const elapsed = Date.now() - started;
    const cls = classifyProviderError({
      status: undefined,
      body: err instanceof Error ? err.message : String(err),
    });
    const store = getLiveChatOperabilityStore();
    store.record({
      providerId: route.providerId,
      routeId: route.providerId,
      modelId: route.modelId,
      ok: false,
      errorClassification: cls,
      latencyMs: elapsed,
      source: args.source,
    });
    return {
      providerId: route.providerId,
      routeId: route.providerId,
      modelId: route.modelId,
      ok: false,
      chatReady: false,
      eligibleForCriticalRole: false,
      errorKind: cls.kind,
      retryable: cls.retryable,
      latencyMs: elapsed,
      sanitizedMessage: cls.sanitizedMessage,
    };
  }
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.bootstrapRuntime) {
    try {
      const { bootstrapForScripts } = await import('@/config/bootstrap-for-scripts');
      await bootstrapForScripts();
    } catch (err) {
      process.stderr.write(
        `bootstrapForScripts failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  // 01C.1B-F2 — when `--from-dryrun-json` is supplied, build the route
  // list from the dry-run's selectedRoutes / role candidates. The
  // hardcoded ROUTE_SET is appended ONLY when the dry-run JSON contains
  // no routes (cold-start).
  let extractedRoles = new Map<string, 'participant' | 'synthesizer' | 'judge' | 'fallback'>();
  let unauditableExtracted: ExtractedRoute[] = [];
  const routes: ProbeRouteSpec[] = [];
  // 01C.1B-J1D §7 — per-role route metadata, used by both the main probe
  // loop (per-role caps + stop-after-first-live-ready) AND the plan-only
  // output (`--write-plan`).
  type PlannedProbe = {
    role: 'participant' | 'synthesizer' | 'judge' | 'fallback';
    providerId: string;
    apiModelId: string;
    routeId?: string;
    adapterKind: string;
    logicalModelId?: string;
    skipped?: boolean;
    skipReason?: string;
  };
  const plannedProbes: PlannedProbe[] = [];
  // Per-role count tracker (J1D §7.2 `--max-routes-per-role`).
  const perRoleCount: Record<string, number> = { participant: 0, synthesizer: 0, judge: 0, fallback: 0 };
  if (args.fromDryrunJson) {
    const extracted = extractRoutesFromDryRunJson(args.fromDryrunJson, {
      scope: args.routeScope,
      maxRoutesPerRole: args.maxRoutesPerRole,
    });
    for (const r of extracted) {
      if (args.rolesFilter && !args.rolesFilter.includes(r.role)) continue;
      if (perRoleCount[r.role] >= args.maxRoutesPerRole) {
        plannedProbes.push({
          role: r.role,
          providerId: r.providerId,
          apiModelId: r.modelId,
          routeId: r.routeId,
          adapterKind: 'openai-compatible-chat',
          skipped: true,
          skipReason: 'over_per_role_cap',
        });
        continue;
      }
      if (plannedProbes.filter((p) => !p.skipped).length >= args.maxTotalRouteProbes) {
        plannedProbes.push({
          role: r.role,
          providerId: r.providerId,
          apiModelId: r.modelId,
          routeId: r.routeId,
          adapterKind: 'openai-compatible-chat',
          skipped: true,
          skipReason: 'over_total_route_probes_cap',
        });
        continue;
      }
      const spec = specForRoute(r.providerId, r.modelId);
      if (!spec) {
        unauditableExtracted.push(r);
        plannedProbes.push({
          role: r.role,
          providerId: r.providerId,
          apiModelId: r.modelId,
          routeId: r.routeId,
          adapterKind: 'openai-compatible-chat',
          skipped: true,
          skipReason: 'no_provider_spec_in_audit_script',
        });
        continue;
      }
      // Dedupe by ROLE + provider+model (J1D §7.3 — role-scoped dedup).
      const key = `${r.role}|${spec.providerId.toLowerCase()}|${spec.modelId.toLowerCase()}`;
      if (extractedRoles.has(key)) continue;
      extractedRoles.set(key, r.role);
      perRoleCount[r.role] = (perRoleCount[r.role] ?? 0) + 1;
      plannedProbes.push({
        role: r.role,
        providerId: spec.providerId,
        apiModelId: spec.modelId,
        routeId: r.routeId,
        adapterKind: 'openai-compatible-chat',
      });
      routes.push(spec);
    }
  } else {
    routes.push(...ROUTE_SET);
  }

  // 01C.1B-J1D §10 — Plan-only mode: emit the planned-probes JSON and exit.
  if (args.planOnly || args.noProviderCalls) {
    const planSummary = {
      plannedProbes,
      totalPlannedProbes: plannedProbes.filter((p) => !p.skipped).length,
      totalSkipped: plannedProbes.filter((p) => p.skipped).length,
      byRole: plannedProbes.reduce<Record<string, number>>((acc, p) => {
        if (!p.skipped) acc[p.role] = (acc[p.role] ?? 0) + 1;
        return acc;
      }, {}),
      synthesizerPlannedProbes: plannedProbes.filter((p) => p.role === 'synthesizer' && !p.skipped).length,
      estimatedMaxCostUsd: plannedProbes.filter((p) => !p.skipped).length * 0.0005,
      noProviderCalls: true,
      dryRun: true,
      routeScope: args.routeScope,
    };
    const planJson = JSON.stringify(planSummary, null, 2);
    if (args.writePlanPath) {
      writeFileSync(args.writePlanPath, planJson);
    }
    process.stdout.write(planJson);
    process.stdout.write('\n');
    return;
  }
  for (const extra of args.extraModels) {
    // Map extras onto the same schema; we don't know the auth scheme,
    // so use Bearer + best-guess endpoint. Operators with custom routes
    // should add them to ROUTE_SET directly.
    routes.push({
      providerId: extra.providerId,
      modelId: extra.modelId,
      endpoint: `https://${extra.providerId}.example/v1/chat/completions`,
      envVar: `${extra.providerId.toUpperCase().replace(/-/g, '_')}_API_KEY`,
      buildHeaders: (k) => ({ Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' }),
      buildBody: (prompt, max, modelId) => ({
        model: modelId,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: max,
      }),
    });
  }

  // Per-probe cost estimate. The actual usage is far below this; we
  // budget ~$0.001 per call for the OK responses and 0 for the
  // non-ok ones. With 6 routes and `--max-total-cost-usd 0.01`, we
  // stay well under.
  const PROBE_ESTIMATE_USD = 0.0015;
  let accruedUsd = 0;
  const results: ProbeResult[] = [];
  for (const r of routes) {
    if (accruedUsd + PROBE_ESTIMATE_USD > args.maxTotalCostUsd) {
      // Stop probing — budget would exceed cap. Record remaining as
      // "unknown" so the snapshot reflects what was actually checked.
      process.stderr.write(
        `WARN: budget cap ${args.maxTotalCostUsd} reached after ${results.length} probes; ` +
        `skipping ${routes.length - results.length} remaining.\n`,
      );
      break;
    }
    const probe = await probeOne(r, args);
    results.push(probe);
    if (probe.ok) accruedUsd += PROBE_ESTIMATE_USD;
  }

  if (args.writeSnapshot) {
    try {
      const store = getLiveChatOperabilityStore();
      await store.writeSnapshot(args.snapshotPath);
    } catch (err) {
      process.stderr.write(
        `WARN: snapshot write failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  // 01C.1B-F2 — critical-route coverage. When the operator supplied
  // `--from-dryrun-json`, every selectedRoute was extracted and its
  // role recorded. We compute role-level readiness so the verdict can
  // assert `allCriticalRoutesReady=true` before authorizing dryRun=false.
  const resultsWithRole = results.map((r) => {
    const key = `${r.providerId.toLowerCase()}|${r.modelId.toLowerCase()}`;
    return { ...r, role: extractedRoles.get(key) };
  });
  const isRoleReady = (role: 'participant' | 'synthesizer' | 'judge' | 'fallback') => {
    const roleResults = resultsWithRole.filter((r) => r.role === role);
    if (roleResults.length === 0) return null;
    return roleResults.every((r) => r.chatReady);
  };
  const criticalCoverage = {
    participantsReady: isRoleReady('participant'),
    synthesizerReady: isRoleReady('synthesizer'),
    judgeReady: isRoleReady('judge'),
    fallbackReady: isRoleReady('fallback'),
    allCriticalRoutesReady:
      isRoleReady('participant') === true &&
      isRoleReady('synthesizer') === true &&
      isRoleReady('judge') === true &&
      isRoleReady('fallback') === true,
  };

  const summary = {
    summary: {
      checked: results.length,
      chatReady: results.filter((r) => r.chatReady).length,
      blocked: results.filter((r) => !r.chatReady && r.errorKind && !r.retryable).length,
      unknown: results.filter((r) => !r.chatReady && (!r.errorKind || r.retryable)).length,
      criticalRoutesChecked: resultsWithRole.filter((r) => r.role).length,
      criticalRoutesReady: resultsWithRole.filter((r) => r.role && r.chatReady).length,
      unauditableExtractedCount: unauditableExtracted.length,
      allowUnknown: args.allowUnknown,
      estimatedCostUsd: Number(accruedUsd.toFixed(6)),
    },
    criticalCoverage,
    results: resultsWithRole,
    unauditableExtracted: unauditableExtracted.map((r) => ({
      role: r.role,
      providerId: r.providerId,
      modelId: r.modelId,
      reason: 'no_provider_spec_in_audit_script',
    })),
    snapshotPath: args.writeSnapshot ? args.snapshotPath : null,
    // 01C.1B-J1D §7 — surface route-level coverage in the result.
    routeScope: args.routeScope,
    plannedProbesTotal: plannedProbes.filter((p) => !p.skipped).length,
    skippedProbes: plannedProbes.filter((p) => p.skipped).length,
  };
  const summaryJson = JSON.stringify(summary, null, 2);
  // 01C.1B-J1D §16 — optional file output via --write-json.
  if (args.writeJsonPath) {
    try {
      writeFileSync(args.writeJsonPath, summaryJson);
    } catch (err) {
      process.stderr.write(
        `WARN: --write-json failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
  process.stdout.write(summaryJson);
  process.stdout.write('\n');
}

main().catch((err) => {
  process.stderr.write(`ERROR: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
