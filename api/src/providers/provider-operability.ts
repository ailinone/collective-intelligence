// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import type { Model, ModelCapability } from '@/types';
import { narrowAs } from '@/utils/type-guards';
import { ProviderAdapter } from './base/provider-adapter';

export interface ModelOperability {
  runnable: boolean;
  originProvider: string;
  executionProvider: string;
  resolvedProvider: string | null;
  fallbackChain: string[];
  /**
   * Strict set of reasons the model is NOT operational. INVARIANT:
   * `runnable === true ⇒ nonOperationalReasons.length === 0`.
   *
   * Phase 6 root-cause fix (2026-04-30): previously this array also collected
   * informational trace data ("origin_provider_unknown", "provider_not_registered:X"
   * for each failed step of the fallback walk) even when a later provider in
   * the chain ultimately resolved. That polluted `/v1/models` output with
   * paradoxical rows like `operability:"operational"` + non-empty reasons.
   * The trace is now in `warnings`; this field carries only blocking causes.
   */
  nonOperationalReasons: string[];
  /**
   * Informational diagnostic trace. Populated whether or not the model is
   * runnable: it captures things worth surfacing to operators (unknown origin
   * provider, fallback-chain attempts that didn't have a registered adapter)
   * but that did not — by themselves — prevent operability. Empty for the
   * happy path. Never used to gate execution.
   */
  warnings: string[];
}

type AdapterLookup = (providerName: string) => ProviderAdapter | undefined;

function getModelMetadata(model: Model): Record<string, unknown> {
  if (model.metadata && typeof model.metadata === 'object' && !Array.isArray(model.metadata)) {
    return model.metadata as Record<string, unknown>;
  }
  return {};
}

function normalizeProviderName(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase().replace(/[_\s]+/g, '-');
  if (!normalized) return undefined;

  const aliases: Record<string, string> = {
    'open-ai': 'openai',
    'openai-api': 'openai',
    'x-ai': 'xai',
    'google-ai': 'google',
    'google-ai-studio': 'google',
    gemini: 'google',
    vertex: 'vertex-ai',
    vertexai: 'vertex-ai',
    'gcp-vertex': 'vertex-ai',
    'open-router': 'openrouter',
    'open-router-ai': 'openrouter',
    // nvidia-hub is the legacy switch-case name; the catalog row migrated to
    // providerId='nvidia' (single catalog row, single adapter). Map all the
    // aliases AND the historical canonical 'nvidia-hub' itself to the live
    // adapter name 'nvidia'. DB rows with executionProvider='nvidia-hub'
    // (from older discovery runs) resolve transparently after this.
    'nvidia-hub': 'nvidia',
    nvidiahub: 'nvidia',
    'nvidia-hub-api': 'nvidia',
    'aihub-mix': 'aihubmix',
    'mini-max': 'minimax',
    'moonshot-ai': 'moonshot',
    'friendli-ai': 'friendli',
    aimlapi: 'aiml',
    'image-router': 'imagerouter',
    orq: 'orqai',
    'orq.ai': 'orqai',
    eden: 'edenai',
    'eden.ai': 'edenai',
    helicone: 'heliconeai',
    'helicone.ai': 'heliconeai',
    'helicone-ai': 'heliconeai',
    // Legacy orphan rows (2026-05-05): 125 DB rows landed with provider_id
    // 'bedrock' from a prior reversed-alias bug. central-model-discovery now
    // canonicalizes 'bedrock' → 'aws-bedrock' at write time (see comment in
    // central-model-discovery-service.ts ~L39-47). This entry is a defense
    // layer so EXISTING orphan rows still resolve at read/operability time
    // while the operator-bound DB migration
    //   UPDATE models SET provider_id='aws-bedrock' WHERE provider_id='bedrock'
    // is rolled out. Removing this is safe once the migration completes.
    bedrock: 'aws-bedrock',
    'aws-bedrock-runtime': 'aws-bedrock',
    bedrockruntime: 'aws-bedrock',
  };

  return aliases[normalized] ?? normalized;
}

function readMetadataProvider(metadata: Record<string, unknown>, key: string): string | undefined {
  return normalizeProviderName(typeof metadata[key] === 'string' ? (metadata[key] as string) : undefined);
}

function readMetadataProviderList(
  metadata: Record<string, unknown>,
  keys: readonly string[]
): string[] {
  const values: string[] = [];

  for (const key of keys) {
    const raw = metadata[key];
    if (typeof raw === 'string') {
      const normalized = normalizeProviderName(raw);
      if (normalized) values.push(normalized);
      continue;
    }

    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (typeof item !== 'string') continue;
        const normalized = normalizeProviderName(item);
        if (normalized) values.push(normalized);
      }
    }
  }

  return values;
}

function uniqueProviders(candidates: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];

  for (const value of candidates) {
    if (typeof value !== 'string') continue;
    const normalized = value.trim();
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    ordered.push(normalized);
  }

  return ordered;
}

export function resolveModelOperability(model: Model, lookupAdapter: AdapterLookup): ModelOperability {
  const metadata = getModelMetadata(model);
  const modelProvider = normalizeProviderName(model.provider) ?? 'unknown';
  const providerId = normalizeProviderName(model.providerId);
  const originProvider = readMetadataProvider(metadata, 'originalProvider') ?? modelProvider;
  const executionProvider =
    readMetadataProvider(metadata, 'executionProvider') ?? providerId ?? modelProvider;

  // Adapter-agnostic fallback chain — resolution order (2026-04-23 realignment):
  //   1. executionProvider — caller's explicit intent (from metadata or
  //      providerId fallback). If the caller says "run on X", honor that.
  //   2. explicit adapter candidates — caller-supplied alternatives,
  //      in declaration order (metadata.adapterCandidates / providerFallbacks).
  //   3. providerId — the DB row's canonical provider id (if distinct).
  //   4. modelProvider — the DB row's display provider (may be an alias).
  //   5. originProvider — the upstream model owner (e.g. openai for a
  //      model routed via a hub).
  //
  // Prior order put modelProvider first as a defense against metadata
  // pollution (hubs stamping executionProvider on models they re-expose).
  // That defense is now handled at write-time in discovery code, not at
  // resolution time. Trusting caller intent here is the policy.
  const explicitCandidates = readMetadataProviderList(metadata, [
    'executionProviders',
    'executionProviderCandidates',
    'adapterCandidates',
    'providerFallbacks',
  ]);

  const fallbackChain = uniqueProviders([
    executionProvider,
    ...explicitCandidates,
    providerId,
    modelProvider,
    originProvider,
  ]);

  // Two-bucket reason collection (Phase 6 invariant):
  //   - `warnings` holds informational trace that does NOT block operability.
  //   - `nonOperationalReasons` holds ONLY blocking reasons. Stays empty if
  //     a provider was eventually resolved.
  // Failed-attempt traces during the fallback walk are accumulated into a
  // local buffer and only promoted to one bucket or the other after we know
  // whether the walk succeeded.
  const warnings: string[] = [];
  const nonOperationalReasons: string[] = [];
  const failedAttemptTrace: string[] = [];

  if (originProvider === 'unknown') {
    // Informational: we don't know who originally produced the model, but the
    // execution path may still resolve via providerId / modelProvider. Don't
    // gate operability on this.
    warnings.push('origin_provider_unknown');
  }
  if (executionProvider === 'unknown') {
    // Informational: same logic. Promote to a blocker only if no chain entry
    // resolves below.
    warnings.push('execution_provider_unknown');
  }

  let resolvedProvider: string | null = null;
  for (const providerName of fallbackChain) {
    const adapter = lookupAdapter(providerName);
    if (adapter) {
      resolvedProvider = providerName;
      break;
    }
    failedAttemptTrace.push(`provider_not_registered:${providerName}`);
  }

  if (resolvedProvider === null) {
    // Not runnable — the trace IS the diagnostic. Promote it.
    nonOperationalReasons.push(...failedAttemptTrace);
    if (fallbackChain.length === 0) {
      nonOperationalReasons.push('execution_provider_missing');
    }
    nonOperationalReasons.push('no_registered_execution_provider');
  } else if (failedAttemptTrace.length > 0) {
    // Runnable — preserve the trace as informational warnings so operators
    // can still see which providers in the chain weren't registered (useful
    // when debugging "why did we end up on the third-choice adapter").
    warnings.push(...failedAttemptTrace);
  }

  return {
    runnable: resolvedProvider !== null,
    originProvider,
    executionProvider,
    resolvedProvider,
    fallbackChain,
    nonOperationalReasons: Array.from(new Set(nonOperationalReasons)),
    warnings: Array.from(new Set(warnings)),
  };
}

type AdapterMethodName =
  | 'textToSpeech'
  | 'speechToText'
  | 'imageGenerate'
  | 'imageEdit'
  | 'imageVariation'
  | 'videoGenerate'
  | 'generateEmbeddings'
  | 'vision'
  | 'webSearch';

// Methods that are implemented in ProviderAdapter base class with functional fallback behavior.
const BASE_FALLBACK_METHODS: ReadonlySet<AdapterMethodName> = new Set(['vision']);

export function isAdapterMethodOverridden(
  adapter: ProviderAdapter,
  methodName: AdapterMethodName
): boolean {
  const method = (narrowAs<Record<string, unknown>>(adapter))[methodName];
  const baseMethod = (narrowAs<Record<string, unknown>>(ProviderAdapter.prototype))[methodName];
  return typeof method === 'function' && method !== baseMethod;
}

export function isAdapterMethodImplemented(
  adapter: ProviderAdapter,
  methodName: AdapterMethodName
): boolean {
  if (isAdapterMethodOverridden(adapter, methodName)) {
    return true;
  }

  // Some capabilities are provided via safe base fallback implementation.
  return BASE_FALLBACK_METHODS.has(methodName);
}

function capabilityRequiredMethod(capability: ModelCapability): AdapterMethodName | null {
  switch (capability) {
    case 'text_to_speech':
    case 'tts':
    case 'audio_generation':
      return 'textToSpeech';
    case 'speech_to_text':
    case 'transcription':
    case 'audio_input':
    case 'listen':
    case 'diarization':
      return 'speechToText';
    case 'image_generation':
      return 'imageGenerate';
    case 'image_editing':
      return 'imageEdit';
    case 'video_generation':
    case 'video_editing':
    case 'video_to_video':
    case 'image_to_video':
      return 'videoGenerate';
    case 'embeddings':
    case 'embedding':
      return 'generateEmbeddings';
    case 'vision':
    case 'multimodal':
    case 'image_captioning':
    case 'visual_question_answering':
      return 'vision';
    case 'web_search':
    case 'file_search':
    case 'deep_search':
    case 'deep_research':
      return 'webSearch';
    default:
      return null;
  }
}

/**
 * Optional per-call cache of `resolveModelOperability` results, keyed by
 * model id. Pass the SAME Map across repeated calls for the same model
 * (e.g. checking several required capabilities against one model in a loop)
 * to skip the recompute — `resolveModelOperability` does string
 * normalization + Set/array allocation and doesn't vary by capability.
 * Scope the Map to a single request/call-site; it is not a global cache and
 * carries no TTL (there's no "stale" concern within one computation).
 */
export function isCapabilityOperationalForModel(
  model: Model,
  capability: ModelCapability,
  lookupAdapter: AdapterLookup,
  operabilityCache?: Map<string, ModelOperability>
): { operational: boolean; operability: ModelOperability } {
  let operability = operabilityCache?.get(model.id);
  if (!operability) {
    operability = resolveModelOperability(model, lookupAdapter);
    operabilityCache?.set(model.id, operability);
  }
  if (!operability.runnable || !operability.resolvedProvider) {
    return { operational: false, operability };
  }

  const adapter = lookupAdapter(operability.resolvedProvider);
  if (!adapter) {
    return {
      operational: false,
      operability: {
        ...operability,
        runnable: false,
        nonOperationalReasons: Array.from(
          new Set([...operability.nonOperationalReasons, 'adapter_resolution_failed'])
        ),
      },
    };
  }

  const requiredMethod = capabilityRequiredMethod(capability);
  if (requiredMethod && !isAdapterMethodImplemented(adapter, requiredMethod)) {
    return {
      operational: false,
      operability: {
        ...operability,
        runnable: false,
        nonOperationalReasons: Array.from(
          new Set([
            ...operability.nonOperationalReasons,
            `capability_method_not_implemented:${requiredMethod}`,
          ])
        ),
      },
    };
  }

  return { operational: true, operability };
}
