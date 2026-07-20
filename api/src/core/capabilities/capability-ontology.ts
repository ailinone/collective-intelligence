// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * capability-ontology.ts — single source of truth for capability identity.
 *
 * MVP 5A invariants:
 *   - Pure data + a tiny interface. No I/O, no provider call.
 *   - DOES NOT name any model family. The ontology is about CAPABILITIES
 *     (`chat`, `tools`, `vision`, …), not about MODELS (`gpt`, `claude`, …).
 *     The `model-capability-document-no-name-hardcode` lint asserts this.
 *   - Aliases here are CAPABILITY aliases (`function_calling` ≡ `tools`),
 *     never model aliases.
 *
 * Each capability has:
 *   - `id`: canonical key used everywhere downstream.
 *   - `aliases`: alternate forms tolerated on input (lowercased).
 *   - `routeFlag`: when present, names the boolean field on
 *     `ProviderModelRoute` that records support for this capability.
 *   - `canonicalUri`: optional HCRA ontology URI for future migration.
 */

import type { ProviderModelRoute } from '../registry/model-route';

// ─── Types ──────────────────────────────────────────────────────────────

export interface CapabilityDefinition {
  readonly id: string;
  readonly aliases: readonly string[];
  readonly routeFlag?: keyof ProviderModelRoute;
  readonly canonicalUri?: string;
}

export interface CapabilityOntology {
  /** Normalises any input form to its canonical id (or returns lowercase input). */
  normalize(input: string): string;
  /** Returns the definition for the canonical id (or any of its aliases). */
  get(id: string): CapabilityDefinition | undefined;
  /** Returns true if the id (canonical or alias) is part of the ontology. */
  has(id: string): boolean;
  /** Returns the full list of canonical definitions. */
  all(): readonly CapabilityDefinition[];
}

// ─── Capability table ───────────────────────────────────────────────────

/**
 * The canonical ontology table. Order is alphabetical for stability;
 * tests assert this order is preserved.
 *
 * Each `aliases` array MUST be lowercase. Add new capabilities only
 * after they're agreed in the HCRA ontology to avoid drift.
 */
const CAPABILITIES: readonly CapabilityDefinition[] = Object.freeze([
  {
    id: 'audio_generation',
    aliases: ['audio-generation', 'tts', 'text_to_speech', 'text-to-speech', 'speech_to_text', 'speech-to-text', 'audio'],
    routeFlag: 'supportsAudio',
  },
  {
    id: 'chat',
    aliases: ['chat-completion', 'text_generation', 'text-generation', 'completion'],
  },
  {
    id: 'code',
    aliases: ['code-generation', 'programming'],
  },
  {
    id: 'image_generation',
    aliases: ['image-generation', 'image_edit', 'image-edit', 'image-gen'],
    routeFlag: 'supportsImages',
  },
  {
    id: 'json_mode',
    aliases: ['json', 'json-mode', 'json_output', 'json-output', 'structured_output', 'structured-output'],
    routeFlag: 'supportsJson',
  },
  {
    id: 'local',
    aliases: ['on-device'],
  },
  {
    id: 'long_context',
    aliases: ['long-context', 'large-context'],
  },
  {
    id: 'math',
    aliases: ['mathematics', 'numerical'],
  },
  {
    id: 'multilingual',
    aliases: ['multi-lingual', 'multilang'],
  },
  {
    id: 'reasoning',
    aliases: ['reasoner', 'chain_of_thought', 'chain-of-thought', 'thinking'],
  },
  {
    id: 'self_hosted',
    aliases: ['self-hosted', 'on-prem'],
  },
  {
    id: 'streaming',
    aliases: ['stream'],
  },
  {
    id: 'tools',
    aliases: ['function_calling', 'function-calling', 'tool_use', 'tool-use'],
    routeFlag: 'supportsTools',
  },
  {
    id: 'vision',
    aliases: ['image_understanding', 'image-understanding', 'visual', 'multimodal_vision'],
    routeFlag: 'supportsVision',
  },
] as const);

// ─── Implementation ─────────────────────────────────────────────────────

class CapabilityOntologyImpl implements CapabilityOntology {
  private readonly aliasIndex: ReadonlyMap<string, string>;
  private readonly defIndex: ReadonlyMap<string, CapabilityDefinition>;
  private readonly defs: readonly CapabilityDefinition[];

  constructor(definitions: readonly CapabilityDefinition[]) {
    this.defs = definitions;
    const aliasIndex = new Map<string, string>();
    const defIndex = new Map<string, CapabilityDefinition>();
    for (const def of definitions) {
      defIndex.set(def.id, def);
      aliasIndex.set(def.id.toLowerCase(), def.id);
      for (const a of def.aliases) {
        aliasIndex.set(a.toLowerCase(), def.id);
      }
    }
    this.aliasIndex = aliasIndex;
    this.defIndex = defIndex;
  }

  normalize(input: string): string {
    if (typeof input !== 'string') return '';
    const lc = input.toLowerCase();
    return this.aliasIndex.get(lc) ?? lc;
  }

  get(id: string): CapabilityDefinition | undefined {
    return this.defIndex.get(this.normalize(id));
  }

  has(id: string): boolean {
    return this.defIndex.has(this.normalize(id));
  }

  all(): readonly CapabilityDefinition[] {
    return this.defs;
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────

export const capabilityOntology: CapabilityOntology = new CapabilityOntologyImpl(CAPABILITIES);

/** Test seam — build a custom ontology in tests without touching the singleton. */
export function buildCapabilityOntology(
  definitions: readonly CapabilityDefinition[],
): CapabilityOntology {
  return new CapabilityOntologyImpl(definitions);
}

/** Raw table — for tests that iterate the canonical set. */
export const __CAPABILITIES_TABLE: readonly CapabilityDefinition[] = CAPABILITIES;
