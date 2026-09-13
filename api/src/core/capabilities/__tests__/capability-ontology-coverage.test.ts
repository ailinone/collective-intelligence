// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * capability-ontology-coverage.test.ts — LOTE AO (2026-09-05)
 *
 * The platform used to carry FOUR disagreeing capability vocabularies:
 *
 *   1. `MODEL_CAPABILITIES` / `ModelCapability`  (api/src/types/index.ts)
 *   2. `ONTOLOGY_SEED`                           (api/src/capability/ontology/seed.ts)
 *   3. `capabilityOntology`                      (this directory) — only 14 entries
 *   4. `ProviderCatalogEntry.supports`           (api/src/providers/catalog/…)
 *
 * (3) is documented as "single source of truth for capability identity" but
 * knew nothing about `video_generation`, `embeddings`, `reranking` or
 * `moderation`, and folded TTS and STT into one id. This suite is the guard
 * that keeps the four in agreement from here on: every capability the
 * catalog can emit must RESOLVE in the ontology, and the catalog-level
 * `supports` flags must map onto real ontology ids.
 */

import { describe, expect, it } from 'vitest';
import { MODEL_CAPABILITIES } from '@/types';
import { ONTOLOGY_SEED } from '@/capability/ontology/seed';
import { CAPABILITY_URI_PREFIX } from '@/capability/legacy-capability-uri';
import type { ProviderCatalogEntry } from '@/providers/catalog/provider-catalog.types';
import {
  CATALOG_SUPPORTS_TO_CAPABILITY,
  __CAPABILITIES_TABLE,
  __CAPABILITY_URI_PREFIX,
  capabilityOntology,
} from '../capability-ontology';

describe('capability ontology — coverage of the catalog vocabulary', () => {
  it('resolves EVERY MODEL_CAPABILITIES member', () => {
    const unresolved = MODEL_CAPABILITIES.filter((c) => !capabilityOntology.has(c));
    expect(unresolved).toEqual([]);
  });

  it('resolves EVERY ONTOLOGY_SEED slug', () => {
    const unresolved = ONTOLOGY_SEED.map((e) => e.slug).filter((s) => !capabilityOntology.has(s));
    expect(unresolved).toEqual([]);
  });

  it('resolves the capabilities the 14-entry table was missing', () => {
    // The concrete gap reported by the 2026-09-05 audit.
    for (const missing of [
      'video_generation',
      'embeddings',
      'reranking',
      'moderation',
      'speech_to_text',
      'realtime_audio',
      'audio_to_audio',
      'computer_use',
      'pdf_understanding',
      'video_understanding',
    ]) {
      expect(capabilityOntology.has(missing)).toBe(true);
    }
  });

  it('resolves every file-generation capability the triage prompt demands', () => {
    for (const cap of [
      'csv_generation',
      'json_generation',
      'markdown_generation',
      'docx_generation',
      'xlsx_generation',
      'pdf_generation',
      'pptx_generation',
      'zip_generation',
      'code_file_generation',
      'file_generation',
    ]) {
      expect(capabilityOntology.has(cap)).toBe(true);
      expect(MODEL_CAPABILITIES).toContain(cap);
    }
  });
});

describe('capability ontology — table integrity', () => {
  it('is alphabetical by canonical id', () => {
    const ids = __CAPABILITIES_TABLE.map((d) => d.id);
    expect(ids).toEqual([...ids].sort());
  });

  it('never maps one alias onto two canonical ids', () => {
    const owner = new Map<string, string>();
    const collisions: string[] = [];
    for (const def of __CAPABILITIES_TABLE) {
      for (const key of [def.id, ...def.aliases]) {
        const previous = owner.get(key);
        if (previous && previous !== def.id) collisions.push(`${key}: ${previous} vs ${def.id}`);
        owner.set(key, def.id);
      }
    }
    expect(collisions).toEqual([]);
  });

  it('keeps every alias lowercase', () => {
    for (const def of __CAPABILITIES_TABLE) {
      for (const alias of def.aliases) expect(alias).toBe(alias.toLowerCase());
    }
  });

  it('never stamps a canonicalUri that has no ONTOLOGY_SEED row behind it', () => {
    expect(__CAPABILITY_URI_PREFIX).toBe(CAPABILITY_URI_PREFIX);
    const seedSlugs = new Set(ONTOLOGY_SEED.map((e) => e.slug));
    for (const def of __CAPABILITIES_TABLE) {
      if (def.canonicalUri === undefined) continue;
      expect(def.canonicalUri.startsWith(CAPABILITY_URI_PREFIX)).toBe(true);
      const slug = def.canonicalUri.slice(CAPABILITY_URI_PREFIX.length);
      // A URI pointing at a slug the seed never creates would reference a
      // non-existent capability_ontology row and silently miss every match.
      expect(seedSlugs.has(slug), `${def.id} → ${def.canonicalUri}`).toBe(true);
    }
  });

  it('stamps a canonical URI on every id the seed knows about', () => {
    const seedSlugs = new Set(ONTOLOGY_SEED.map((e) => e.slug));
    const missing = __CAPABILITIES_TABLE.filter(
      (def) => seedSlugs.has(def.id) && def.canonicalUri === undefined
    ).map((def) => def.id);
    expect(missing).toEqual([]);
  });

  it('leaves the ontology-only routing concepts URI-less', () => {
    // `code`, `local`, `self_hosted`, `math`, `multilingual` are routing and
    // policy concepts, not catalog tags — they have no seed row by design.
    const seedSlugs = new Set(ONTOLOGY_SEED.map((e) => e.slug));
    for (const id of ['code', 'local', 'self_hosted', 'math', 'multilingual']) {
      expect(seedSlugs.has(id)).toBe(false);
      expect(capabilityOntology.get(id)?.canonicalUri).toBeUndefined();
    }
  });

  it('points `tools` at the `function_calling` seed row', () => {
    // This table calls it `tools`; the catalog enum, the seed and every
    // persisted capability_uris row call it `function_calling`.
    expect(capabilityOntology.get('tools')?.canonicalUri).toBe(
      `${CAPABILITY_URI_PREFIX}function_calling`
    );
    expect(capabilityOntology.normalize('function_calling')).toBe('tools');
  });
});

describe('provider-catalog `supports` ↔ ontology mapping', () => {
  /**
   * Compile-time exhaustiveness: adding a flag to
   * `ProviderCatalogEntry.supports` without mapping it to a capability is a
   * TYPE error here, not a silently-unmapped fourth vocabulary.
   */
  it('covers every `supports` flag the catalog schema declares', () => {
    type SupportsFlag = keyof ProviderCatalogEntry['supports'];
    const exhaustive: Readonly<Record<SupportsFlag, string>> = CATALOG_SUPPORTS_TO_CAPABILITY;
    expect(Object.keys(exhaustive).length).toBe(
      Object.keys(CATALOG_SUPPORTS_TO_CAPABILITY).length
    );
  });

  it('maps every catalog flag onto a real ontology capability', () => {
    for (const [flag, capability] of Object.entries(CATALOG_SUPPORTS_TO_CAPABILITY)) {
      expect(capabilityOntology.has(capability), `${flag} → ${capability}`).toBe(true);
      // The target must be the CANONICAL id, not one of its aliases.
      expect(capabilityOntology.normalize(capability)).toBe(capability);
    }
  });

  it('maps the two audio flags onto the two DIRECTIONS, not onto one id', () => {
    expect(CATALOG_SUPPORTS_TO_CAPABILITY.speechToText).toBe('speech_to_text');
    expect(CATALOG_SUPPORTS_TO_CAPABILITY.textToSpeech).toBe('audio_generation');
    expect(CATALOG_SUPPORTS_TO_CAPABILITY.speechToText).not.toBe(
      CATALOG_SUPPORTS_TO_CAPABILITY.textToSpeech
    );
  });
});
