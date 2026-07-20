// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-G4 §Routing (v2) — Universal Multi-Route Provider Taxonomy.
 *
 * v1 distinguished `direct | router | hybrid`, treating openai/anthropic/
 * google as direct-only. v2 corrects that: **every native provider is
 * potentially reachable via multiple routers**, because routers
 * (OpenRouter, AIHubMix, Vercel AI Gateway, EdenAI, etc.) maintain
 * their OWN catalogs that include openai/gpt-4o, anthropic/claude-*,
 * google/gemini-*, etc.
 *
 * Two kinds of providers:
 *   - `native`: has its own first-party API endpoint AND may appear as
 *     a backend of routers. EVERY native provider therefore has zero
 *     or more `routesVia` entries (routers that include it in their
 *     catalog).
 *   - `router`: aggregates models from many native providers behind a
 *     single OAI-compatible endpoint + a single credit pool. Each
 *     router has zero or more `routesTo` entries (natives it can
 *     dispatch to).
 *
 * For a given LOGICAL model selected by role-resolution, the executor
 * computes the ordered ROUTE LIST:
 *   1. Native provider (primary — fastest, lowest middlemen markup)
 *   2. Each router whose `routesTo` includes the native (secondary)
 *
 * Routes are tried in order until one succeeds. Only when EVERY route
 * fails do we declare the model unreachable and propagate role failure.
 *
 * The taxonomy below is OPERATOR-MAINTAINED: it reflects publicly known
 * catalog coverage as of 2026-05-16. The set of natives a router
 * actually carries can change without notice — runtime discovery (via
 * each router's `/v1/models` endpoint or the canonical Hub API) must
 * REFINE this static map, not replace it.
 */

export type ProviderRoutingKind = 'native' | 'router';

export interface RouterPeering {
  /** Router provider id in our catalog (e.g., `huggingface`, `openrouter`). */
  readonly routerProviderId: string;
  /** Slug the router uses to address this backend (e.g., `together`,
   *  `fireworks-ai`, `hf-inference`). Some routers use the native's id
   *  verbatim; others rewrite. When equal to the native id, the field
   *  is still set for symmetry. */
  readonly upstreamSlug: string;
}

export interface ProviderRoutingClassification {
  readonly kind: ProviderRoutingKind;
  /** When `kind='native'`: routers that include this provider in their
   *  catalog (i.e., we can reach this provider's models via those routers).
   *  When `kind='router'`: always empty. */
  readonly routesVia: readonly RouterPeering[];
  /** When `kind='router'`: native providers this router can dispatch to.
   *  When `kind='native'`: always empty. */
  readonly routesTo: readonly string[];
}

// ──────────────────────────────────────────────────────────────────────
// ROUTERS (aggregators)
//
// For each router we list the native providers it INCLUDES in its
// catalog. Coverage updated 2026-05-16 from public documentation +
// operator disclosure. Lists are NOT exhaustive — runtime discovery via
// each router's `/v1/models` is authoritative.
// ──────────────────────────────────────────────────────────────────────

interface RouterDefinition {
  readonly id: string;
  /** Native providers this router aggregates. */
  readonly routesTo: readonly string[];
  /** Per-backend slug override; defaults to native id when absent. */
  readonly slugOverrides?: Readonly<Record<string, string>>;
}

const ROUTER_DEFINITIONS: readonly RouterDefinition[] = [
  // ── HuggingFace Inference Router ──
  // 20 hybrid backends from operator disclosure (2026-05-16) +
  // OpenAI/Anthropic/Google models hosted as HF-served checkpoints.
  {
    id: 'huggingface',
    routesTo: [
      'hf-inference',
      'replicate', 'scaleway',
      'groq', 'novita', 'cerebras', 'sambanova', 'nscale', 'fal',
      'hyperbolic', 'togetherai', 'fireworks-ai', 'featherless-ai',
      'zai', 'cohere', 'public-ai', 'ovhcloud', 'deepinfra', 'wavespeed',
      'nvidia',
    ],
    slugOverrides: {
      'togetherai': 'together',
      'fireworks-ai': 'fireworks-ai',
    },
  },

  // ── OpenRouter ──
  // OpenRouter aggregates virtually every commercial LLM. Coverage list
  // reflects models that operators reliably reach via the router.
  {
    id: 'openrouter',
    routesTo: [
      'openai', 'anthropic', 'google', 'mistral', 'deepseek', 'xai',
      'cohere', 'alibaba', 'minimax', 'moonshot', 'perplexity',
      'groq', 'cerebras', 'fireworks-ai', 'togetherai', 'novita',
      'hyperbolic', 'deepinfra', 'sambanova', 'featherless-ai',
      'nvidia', 'inflection', 'inworld',
    ],
    slugOverrides: {
      'togetherai': 'together',
    },
  },

  // ── AIHubMix ──
  // Broad coverage; operator's confirmed list.
  {
    id: 'aihubmix',
    routesTo: [
      'openai', 'anthropic', 'google', 'mistral', 'deepseek', 'xai',
      'cohere', 'alibaba', 'minimax', 'moonshot',
      'groq', 'cerebras', 'fireworks-ai', 'togetherai',
    ],
  },

  // ── Vercel AI Gateway ──
  // Vercel-hosted gateway that proxies many major LLMs.
  {
    id: 'vercel-ai-gateway',
    routesTo: [
      'openai', 'anthropic', 'google', 'mistral', 'xai', 'cohere',
      'deepseek', 'groq', 'fireworks-ai', 'togetherai',
    ],
  },

  // ── GitHub Models (Azure-backed) ──
  // GitHub's gateway to Azure-hosted models + some partners.
  {
    id: 'github-models',
    routesTo: [
      'openai', 'mistral', 'cohere', 'meta', 'azure-openai',
      'deepseek',
    ],
  },

  // ── EdenAI ──
  // Multi-AI gateway with broad coverage.
  {
    id: 'edenai',
    routesTo: [
      'openai', 'anthropic', 'google', 'mistral', 'cohere',
      'deepseek', 'xai', 'alibaba', 'minimax',
    ],
  },

  // ── CometAPI ──
  // Asian-region OpenAI-compatible router.
  {
    id: 'cometapi',
    routesTo: [
      'openai', 'anthropic', 'google', 'mistral', 'deepseek', 'xai',
      'alibaba', 'minimax', 'moonshot', 'cohere',
    ],
  },

  // ── Requesty ──
  {
    id: 'requesty',
    routesTo: [
      'openai', 'anthropic', 'google', 'mistral', 'deepseek',
      'groq', 'cerebras', 'fireworks-ai', 'togetherai',
    ],
  },

  // ── Nano-GPT ──
  {
    id: 'nanogpt',
    routesTo: [
      'openai', 'anthropic', 'google', 'mistral', 'deepseek', 'xai',
    ],
  },

  // ── AIML API ──
  {
    id: 'aiml',
    routesTo: [
      'openai', 'anthropic', 'google', 'mistral', 'deepseek', 'xai',
      'alibaba', 'groq', 'cerebras',
    ],
  },

  // ── 302.AI ──
  {
    id: 'ai302',
    routesTo: [
      'openai', 'anthropic', 'google', 'mistral', 'deepseek', 'xai',
      'alibaba', 'moonshot', 'minimax',
    ],
  },

  // ── Routeway ──
  {
    id: 'routeway',
    routesTo: [
      'openai', 'anthropic', 'google', 'mistral',
      'groq', 'cerebras', 'fireworks-ai', 'togetherai',
    ],
  },

  // ── ORQ.AI ──
  {
    id: 'orqai',
    routesTo: [
      'openai', 'anthropic', 'google', 'mistral', 'cohere',
    ],
  },

  // ── Helicone AI ──
  // Observability proxy that supports many providers.
  {
    id: 'heliconeai',
    routesTo: [
      'openai', 'anthropic', 'google', 'mistral', 'cohere',
      'deepseek', 'togetherai', 'groq',
    ],
  },

  // ── Poe (Quora) ──
  {
    id: 'poe',
    routesTo: [
      'openai', 'anthropic', 'google', 'mistral', 'meta',
    ],
  },

  // ── Venice ──
  {
    id: 'venice',
    routesTo: [
      'meta', 'mistral', 'deepseek', 'qwen',
    ],
  },

  // ── Gemini-OpenAI (Google's OpenAI-compatible gateway) ──
  {
    id: 'gemini-openai',
    routesTo: ['google'],
  },

  // ── ImageRouter (image-only aggregator) ──
  {
    id: 'imagerouter',
    routesTo: ['bfl', 'recraft', 'runwayml', 'topaz'],
  },

  // ── Bytez ──
  {
    id: 'bytez',
    routesTo: ['huggingface', 'replicate'],
  },

  // ── Cloudflare Workers AI ──
  {
    id: 'cloudflare-workers-ai',
    routesTo: ['meta', 'mistral', 'qwen', 'google'],
  },

  // ── Mancer (relay for specific upstreams) ──
  {
    id: 'mancer',
    routesTo: ['mistral', 'meta', 'qwen'],
  },

  // ── Synthetic.new ──
  {
    id: 'synthetic',
    routesTo: ['openai', 'anthropic', 'meta', 'mistral', 'deepseek'],
  },
];

// ──────────────────────────────────────────────────────────────────────
// NATIVES
//
// Every native provider known to our catalog. The taxonomy lists them
// here so `classifyProviderRouting(id)` returns a real entry for all of
// them (instead of falling through to the default).
// ──────────────────────────────────────────────────────────────────────

const NATIVE_PROVIDERS: readonly string[] = [
  // Tier-1 frontier
  'openai', 'anthropic', 'google', 'mistral', 'xai', 'cohere',
  'deepseek', 'perplexity',
  // Major hosts / hybrid backends from operator disclosure
  'groq', 'cerebras', 'fireworks-ai', 'togetherai', 'novita',
  'sambanova', 'nscale', 'fal', 'hyperbolic', 'featherless-ai',
  'zai', 'replicate', 'scaleway', 'public-ai', 'ovhcloud',
  'hf-inference', 'deepinfra', 'wavespeed', 'nvidia',
  // Chinese-region
  'alibaba', 'qwen', 'minimax', 'moonshot', 'zhipu', 'qianfan',
  'stepfun', 'siliconflow', 'volcano', 'doubao', 'ark',
  // Less common
  'inflection', 'inworld', 'writer', 'rekaai', 'upstage',
  'arcee', 'atlascloud', 'avian', 'gmi', 'infermatic',
  'phala', 'relace', 'morph', 'xiaomi-mimo', 'anyscale',
  'lambda-ai', 'nebius', 'wandb', 'jina', 'v0', 'chutes',
  'friendli',
  // Cloud-native
  'azure-openai', 'aws-bedrock', 'aws-sagemaker', 'vertex-ai',
  'databricks', 'sap-ai-core', 'snowflake', 'watsonx',
  // Misc upstream tags used in routers but also addressable as natives
  'meta', 'meta-llama',
  // Specialized non-chat (still natives)
  'deepgram', 'cartesia', 'elevenlabs',
  'voyage',
  'recraft', 'runwayml', 'topaz', 'bfl',
  // Local
  'ollama', 'local-llama', 'local-kobold', 'local-embeddings',
  'xinference', 'vllm', 'lm-studio', 'triton',
];

// ──────────────────────────────────────────────────────────────────────
// Build the bidirectional classification map at load.
// ──────────────────────────────────────────────────────────────────────

function buildClassification(): ReadonlyMap<string, ProviderRoutingClassification> {
  const m = new Map<string, ProviderRoutingClassification>();

  const routerIds = new Set(ROUTER_DEFINITIONS.map((r) => r.id));

  // Build native → routers-that-route-to-it map.
  const nativeToRouters = new Map<string, RouterPeering[]>();
  for (const r of ROUTER_DEFINITIONS) {
    for (const native of r.routesTo) {
      const slug = r.slugOverrides?.[native] ?? native;
      const list = nativeToRouters.get(native) ?? [];
      list.push({ routerProviderId: r.id, upstreamSlug: slug });
      nativeToRouters.set(native, list);
    }
  }

  // Routers: kind='router', routesTo is fixed, routesVia is empty.
  for (const r of ROUTER_DEFINITIONS) {
    m.set(r.id, {
      kind: 'router',
      routesVia: [],
      routesTo: r.routesTo.slice().sort(),
    });
  }

  // Natives: kind='native', routesVia is the routers that include them.
  // Iterate the union of NATIVE_PROVIDERS + any native referenced by a
  // router's routesTo (defensive — a router shouldn't reference a native
  // we haven't declared, but if it does, we still classify it).
  const allNatives = new Set([
    ...NATIVE_PROVIDERS,
    ...Array.from(nativeToRouters.keys()),
  ]);
  for (const id of allNatives) {
    if (routerIds.has(id)) continue;  // routers already added
    const peerings = (nativeToRouters.get(id) ?? []).slice().sort((a, b) =>
      a.routerProviderId.localeCompare(b.routerProviderId),
    );
    m.set(id, {
      kind: 'native',
      routesVia: peerings,
      routesTo: [],
    });
  }

  return m;
}

const CLASSIFICATION = buildClassification();

// ──────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────

export function classifyProviderRouting(providerId: string): ProviderRoutingClassification | undefined {
  return CLASSIFICATION.get(providerId.toLowerCase());
}

export interface ModelRouteCandidate {
  readonly providerId: string;
  readonly kind: ProviderRoutingKind;
  /** When `providerId` is a router AND it's serving a specific native:
   *  the slug the router uses to address that native. */
  readonly upstreamSlug?: string;
  /** When `providerId` is a router serving a native: the native's id.
   *  When `providerId` is the native itself: undefined. */
  readonly nativeProviderId?: string;
}

/**
 * Return ALL routes that can reach a given native provider's models.
 *
 * For native providers:
 *   1. The native itself (primary route — direct API)
 *   2. Each router whose `routesTo` includes the native (secondary)
 *
 * For routers:
 *   - Just the router itself (it handles upstream selection internally).
 *
 * For unknown providers:
 *   - Just the input as a native (conservative — no routers assumed).
 *
 * Order is stable: native first, then routers alphabetically. Caller can
 * resort by cost, latency, recent success, or operator-supplied preference.
 */
export function listModelRouteCandidates(nativeProviderId: string): readonly ModelRouteCandidate[] {
  const id = nativeProviderId.toLowerCase();
  const cls = CLASSIFICATION.get(id);
  if (!cls) {
    return [{ providerId: nativeProviderId, kind: 'native' }];
  }
  if (cls.kind === 'router') {
    return [{ providerId: nativeProviderId, kind: 'router' }];
  }
  // Native: self first, then each router.
  const out: ModelRouteCandidate[] = [
    { providerId: nativeProviderId, kind: 'native' },
  ];
  for (const p of cls.routesVia) {
    out.push({
      providerId: p.routerProviderId,
      kind: 'router',
      upstreamSlug: p.upstreamSlug,
      nativeProviderId,
    });
  }
  return out;
}

/**
 * Return all natives a router can dispatch to. Empty for non-routers.
 */
export function listRouterBackends(routerProviderId: string): readonly string[] {
  const cls = CLASSIFICATION.get(routerProviderId.toLowerCase());
  if (!cls || cls.kind !== 'router') return [];
  return cls.routesTo;
}

/**
 * Inverse query: which routers can reach a given native's models?
 * Returns the router ids sorted alphabetically. Empty for non-natives.
 */
export function listRoutersForNative(nativeProviderId: string): readonly string[] {
  const cls = CLASSIFICATION.get(nativeProviderId.toLowerCase());
  if (!cls || cls.kind !== 'native') return [];
  return cls.routesVia.map((p) => p.routerProviderId);
}

/**
 * Snapshot for tests/observability.
 */
export function getRoutingTaxonomySnapshot(): {
  readonly routers: readonly string[];
  readonly natives: readonly string[];
  readonly routeCounts: Readonly<Record<string, number>>;
} {
  const routers: string[] = [];
  const natives: string[] = [];
  const routeCounts: Record<string, number> = {};
  for (const [id, cls] of CLASSIFICATION) {
    if (cls.kind === 'router') routers.push(id);
    else {
      natives.push(id);
      routeCounts[id] = 1 + cls.routesVia.length;  // self + routers
    }
  }
  return {
    routers: routers.sort(),
    natives: natives.sort(),
    routeCounts,
  };
}
