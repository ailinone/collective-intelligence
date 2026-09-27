// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * media-planner-gate — the cheap, no-LLM-call heuristic that decides
 * whether a request routes through `MediaPlannerStrategy` at all, plus the
 * attribute-aware "native collapse" check (§3.3 of the architecture).
 *
 * Both are pure functions over already-available data (`ChatRequest` text +
 * `OrchestrationContext.models`) so the gate can run on the request's hot
 * path with zero added latency — no extra LLM call, no network I/O.
 */
import type { ChatMessage, ChatRequest, Model, OrchestrationContext } from '@/types';
import { isObject } from '@/utils/type-guards';
import { config } from '@/config';
import { getMediaPlannerConfigForOrg } from '@/core/coordination/collective-feature-flags';
import type { CapabilityAttributes } from '@/providers/catalog/provider-catalog.types';
import {
  canSatisfyCapabilityAttributes,
  type CapabilityAttributeRequest,
} from '@/providers/catalog/capability-attribute-matcher';
import type { VideoAttributeRequest } from '@/providers/catalog/video-capability-matcher';
import type { ImageAttributeRequest } from '@/providers/catalog/image-capability-matcher';
import {
  MEDIA_GENERATION_CAPABILITIES,
  type MediaConstraintSet,
  type MediaGenerationCapability,
  hasAnyConstraint,
} from './media-planner-types';

// ─── Gating heuristic (§8: "Gating heuristic for routing into the planner") ─

/**
 * Keyword families used ONLY to decide whether a request touches more than
 * one distinct capability, or names an attribute the directly-matched
 * single capability isn't known to satisfy. This is a heuristic keyword
 * table (not a model/provider list — the "never hardcode" rule targets
 * models/providers, which this never references), and it is intentionally
 * conservative: false negatives just mean the request takes the existing
 * direct route unchanged, which is the safe default.
 */
const CAPABILITY_KEYWORDS: ReadonlyArray<{ capability: string; pattern: RegExp }> = [
  { capability: 'video_generation', pattern: /\b(video|clip|movie|animation)\b/i },
  { capability: 'image_generation', pattern: /\b(image|picture|photo|illustration|graphic|poster)\b/i },
  {
    capability: 'audio_generation',
    pattern: /\b(soundtrack|music|background music|audio track|voiceover|narration)\b/i,
  },
  { capability: 'text_to_speech', pattern: /\b(text[- ]to[- ]speech|read aloud|spoken)\b/i },
  { capability: 'pdf_understanding', pattern: /\b(pdf|document understanding)\b/i },
  { capability: 'web_search', pattern: /\b(search the web|look up online|latest news)\b/i },
];

const DURATION_PATTERN = /\b(\d+(?:\.\d+)?)\s*(seconds?|secs?|s\b|minutes?|mins?|m\b)\b/i;
const RESOLUTION_PATTERN = /\b(4k|8k|2160p|1440p|1080p|720p|\d{3,4}\s*[x×]\s*\d{3,4})\b/i;
const ASPECT_RATIO_PATTERN = /\b(1:1|4:3|3:4|16:9|9:16|21:9)\b/i;
const AUDIO_REQUEST_PATTERN =
  /\b(with (?:audio|sound|music|a soundtrack)|add (?:audio|music|a soundtrack)|soundtrack|background music)\b/i;

export interface MediaPlannerGateResult {
  readonly route: boolean;
  readonly reason: string;
  readonly detectedCapabilities: readonly string[];
  readonly detectedConstraints: MediaConstraintSet;
}

function extractLastUserText(messages: ChatMessage[] | undefined): string {
  if (!messages) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'user') continue;
    const content = message.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => (part.type === 'text' ? part.text : ''))
        .filter(Boolean)
        .join(' ');
    }
  }
  return '';
}

function parseDurationSeconds(text: string): number | undefined {
  const match = text.match(DURATION_PATTERN);
  if (!match) return undefined;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value)) return undefined;
  const unit = match[2].toLowerCase();
  return unit.startsWith('m') ? value * 60 : value;
}

function parseResolution(text: string): { width?: number; height?: number } | undefined {
  const match = text.match(RESOLUTION_PATTERN);
  if (!match) return undefined;
  const token = match[1].toLowerCase();
  if (token === '4k' || token === '2160p') return { width: 3840, height: 2160 };
  if (token === '8k') return { width: 7680, height: 4320 };
  if (token === '1440p') return { width: 2560, height: 1440 };
  if (token === '1080p') return { width: 1920, height: 1080 };
  if (token === '720p') return { width: 1280, height: 720 };
  const explicit = token.match(/(\d{3,4})\s*[x×]\s*(\d{3,4})/);
  if (explicit) return { width: Number(explicit[1]), height: Number(explicit[2]) };
  return undefined;
}

/**
 * Detect constraints the heuristic can extract WITHOUT an LLM call. This is
 * intentionally a coarse first pass — the planner's own model turns can
 * refine/override these once inside the loop. Absence here never blocks
 * routing on its own; it only feeds `evaluateMediaPlannerGate`'s decision.
 */
export function detectConstraintsFromText(text: string): MediaConstraintSet {
  const constraints: { durationSec?: { minSec?: number }; resolution?: { width?: number; height?: number }; requireAudioTrack?: boolean } =
    {};
  const durationSec = parseDurationSeconds(text);
  if (durationSec !== undefined) constraints.durationSec = { minSec: durationSec };
  const resolution = parseResolution(text);
  if (resolution) constraints.resolution = resolution;
  if (AUDIO_REQUEST_PATTERN.test(text)) constraints.requireAudioTrack = true;
  return constraints;
}

/**
 * Cheap, synchronous gate: does this request warrant the planner's bounded
 * turn loop, or should it take the existing direct single-capability route
 * unchanged? No LLM call — only regex/string scanning over the last user
 * message plus a look at `context.requiredCapabilities`.
 */
export function evaluateMediaPlannerGate(
  request: ChatRequest,
  context: OrchestrationContext
): MediaPlannerGateResult {
  const text = extractLastUserText(request.messages);
  const detectedCapabilities = new Set<string>(
    CAPABILITY_KEYWORDS.filter(({ pattern }) => pattern.test(text)).map((k) => k.capability)
  );
  for (const cap of context.requiredCapabilities ?? []) {
    if (MEDIA_GENERATION_CAPABILITIES.has(cap)) detectedCapabilities.add(cap);
  }

  const constraints = detectConstraintsFromText(text);
  const hasAttributeConstraint = hasAnyConstraint(constraints) || ASPECT_RATIO_PATTERN.test(text);

  // Only relevant when the request is media-generation-shaped at all — a
  // plain multi-capability text/search/pdf request has no business routing
  // through a MEDIA planner. Require at least one media-generation
  // capability among what was detected/declared.
  const mediaGenerationInvolved =
    detectedCapabilities.has('video_generation') || detectedCapabilities.has('image_generation');

  if (!mediaGenerationInvolved) {
    return {
      route: false,
      reason: 'no media-generation capability detected',
      detectedCapabilities: [...detectedCapabilities],
      detectedConstraints: constraints,
    };
  }

  if (detectedCapabilities.size > 1) {
    return {
      route: true,
      reason: `multiple capabilities detected: ${[...detectedCapabilities].join(', ')}`,
      detectedCapabilities: [...detectedCapabilities],
      detectedConstraints: constraints,
    };
  }

  if (hasAttributeConstraint) {
    return {
      route: true,
      reason: 'explicit numeric/attribute constraint detected alongside a media-generation request',
      detectedCapabilities: [...detectedCapabilities],
      detectedConstraints: constraints,
    };
  }

  return {
    route: false,
    reason: 'single media-generation capability with no explicit attribute constraint',
    detectedCapabilities: [...detectedCapabilities],
    detectedConstraints: constraints,
  };
}

/**
 * Single choke point for routing into `MediaPlannerStrategy` (item 4 of the
 * LOTE AT Part 2 task): checks `MEDIA_PLANNER_ENABLED` FIRST, before doing
 * any of the (cheap but non-zero) text scanning in `evaluateMediaPlannerGate`.
 * With `enabled: false`, this returns a fixed, deterministic "disabled"
 * result without touching `request`/`context` at all — the code path that
 * would invoke `MediaPlannerStrategy` is structurally unreachable, and every
 * caller (the new route in `capabilities-routes.ts`, and any future one)
 * MUST go through this function rather than calling
 * `evaluateMediaPlannerGate` directly, so the flag can never be
 * accidentally bypassed at a second call site.
 */
export function resolveMediaPlanRouting(
  request: ChatRequest,
  context: OrchestrationContext,
  enabled: boolean
): MediaPlannerGateResult {
  if (!enabled) {
    return {
      route: false,
      reason: 'MEDIA_PLANNER_ENABLED is false',
      detectedCapabilities: [],
      detectedConstraints: {},
    };
  }
  return evaluateMediaPlannerGate(request, context);
}

/**
 * Effective MediaPlanner gate: the global `MEDIA_PLANNER_ENABLED` env flag
 * OR a per-org canary allowlist entry (`getMediaPlannerConfigForOrg`,
 * `Organization.settings.mediaPlannerConfig.enabled` — a SIBLING key to
 * `collectiveConfig`, never merged into `CoordinationConfig`). The global
 * flag is checked FIRST and short-circuits before touching the DB/cache at
 * all, so an org with the global flag already on never pays for an
 * org-settings lookup.
 *
 * Every caller that used to pass `config.mediaPlanner.enabled` straight
 * into `resolveMediaPlanRouting` should resolve this first instead, so a
 * named canary org gets the same effective behavior as a global flip
 * without one being required.
 */
export async function resolveEffectiveMediaPlannerEnabled(
  organizationId: string | undefined
): Promise<boolean> {
  if (config.mediaPlanner.enabled) return true;
  if (!organizationId) return false;
  const orgConfig = await getMediaPlannerConfigForOrg(organizationId);
  return orgConfig.enabled === true;
}

// ─── Native joint-collapse check (§3.3) ────────────────────────────────────

/**
 * `capabilityAttributes` reconciliation (2026-09-25): Section B
 * (`capability-attribute-projection.ts`) writes `Model.metadata.
 * capabilityAttributes` as a map keyed by capability (`{ video_generation:
 * { maxDurationSeconds, maxResolution: '4K', ... } }`), using the real
 * `VideoCapabilityAttributes`/`ImageCapabilityAttributes` shapes from
 * `provider-catalog.types.ts` — not the flat, differently-named provisional
 * shape (`maxDurationSec`, `maxResolution: {width,height}`) this file
 * originally guessed at before that field existed anywhere. Both sides
 * flagged the mismatch explicitly rather than papering over it (see
 * capability-attribute-projection.ts's own "KNOWN SHAPE MISMATCH" note);
 * this reads the real shape and reuses the real per-capability matchers
 * (`canSatisfyCapabilityAttributes`) instead of re-implementing resolution/
 * duration comparison ad hoc.
 */
function readCapabilityAttributesFor(
  model: Model,
  capability: MediaGenerationCapability
): CapabilityAttributes | undefined {
  const raw = model.metadata?.['capabilityAttributes'];
  if (!isObject(raw)) return undefined;
  const byCapability = raw as Partial<Record<MediaGenerationCapability, unknown>>;
  const attrs = byCapability[capability];
  return isObject(attrs) ? (attrs as CapabilityAttributes) : undefined;
}

export interface NativeCollapseMatch {
  readonly model: Model;
  readonly attributes: CapabilityAttributes;
}

function toCapabilityAttributeRequest(
  capability: MediaGenerationCapability,
  constraints: MediaConstraintSet | undefined
): CapabilityAttributeRequest {
  if (capability === 'image_generation') {
    return {
      width: constraints?.resolution?.width,
      height: constraints?.resolution?.height,
    } satisfies ImageAttributeRequest;
  }
  // video_generation — the only other member of MediaGenerationCapability.
  const { width, height } = constraints?.resolution ?? {};
  return {
    durationSeconds: constraints?.durationSec?.minSec,
    resolution: width !== undefined && height !== undefined ? `${width}x${height}` : undefined,
    audioRequested: constraints?.requireAudioTrack,
  } satisfies VideoAttributeRequest;
}

/**
 * Before decomposing a multi-constraint generation request into a
 * generate→gate→(mux) chain, check whether a single model already
 * satisfies every stated constraint natively. Returns `undefined`
 * (decompose as normal) whenever there is nothing to collapse (no
 * constraints) or no model declares `capabilityAttributes` for this
 * specific capability — deliberately conservative (unlike
 * `canSatisfyCapabilityAttributes`'s own fail-open default): collapsing two
 * calls into one is an optimization that should only fire on positive
 * evidence a model can do it natively, not merely "we don't know it can't".
 */
export function findNativeCollapseModel(
  models: readonly Model[],
  capability: MediaGenerationCapability,
  constraints: MediaConstraintSet | undefined
): NativeCollapseMatch | undefined {
  if (!hasAnyConstraint(constraints)) return undefined;

  const request = toCapabilityAttributeRequest(capability, constraints);

  for (const model of models) {
    if (!model.capabilities.includes(capability)) continue;
    const attributes = readCapabilityAttributesFor(model, capability);
    if (!attributes) continue;
    if (!canSatisfyCapabilityAttributes(capability, attributes, request)) continue;

    return { model, attributes };
  }
  return undefined;
}
