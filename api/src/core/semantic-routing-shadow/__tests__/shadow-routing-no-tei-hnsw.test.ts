// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * shadow-routing-no-tei-hnsw.test.ts — MVP 8C.0
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SOURCES: Record<string, string> = {
  'shadow-routing-types.ts': resolve(__dirname, '..', 'shadow-routing-types.ts'),
  'shadow-routing-config.ts': resolve(__dirname, '..', 'shadow-routing-config.ts'),
  'shadow-routing-sampling.ts': resolve(__dirname, '..', 'shadow-routing-sampling.ts'),
  'shadow-routing-redaction.ts': resolve(__dirname, '..', 'shadow-routing-redaction.ts'),
  'shadow-routing-logger.ts': resolve(__dirname, '..', 'shadow-routing-logger.ts'),
  'shadow-routing-metrics.ts': resolve(__dirname, '..', 'shadow-routing-metrics.ts'),
  'shadow-routing-service.ts': resolve(__dirname, '..', 'shadow-routing-service.ts'),
};

const content: Record<string, string> = {};
for (const [n, p] of Object.entries(SOURCES)) {
  try {
    content[n] = readFileSync(p, 'utf-8');
  } catch {
    content[n] = '__NOT_FOUND__';
  }
}

describe('shadow routing — no TEI imports', () => {
  const FORBIDDEN = [
    "from 'tei-client'",
    "from '@tei",
    'tei-client',
    'tei_client',
    'TEIClient',
    'createTEI',
    'EmbeddingCache',
    'embedding_cache',
    'embedding-cache',
  ];
  for (const [name, src] of Object.entries(content)) {
    for (const f of FORBIDDEN) {
      it(`${name} does NOT contain "${f}"`, () => {
        expect(src).not.toContain(f);
      });
    }
  }
});

describe('shadow routing — no HNSW / ANN imports', () => {
  const FORBIDDEN = [
    "from 'hnswlib-node'",
    "from 'hnswlib'",
    "from 'faiss",
    'HnswLib',
    'hnsw_index',
    'hnsw-index',
    'SemanticIndex',
    'semantic-index',
    'ANNIndex',
    'ann_index',
  ];
  for (const [name, src] of Object.entries(content)) {
    for (const f of FORBIDDEN) {
      it(`${name} does NOT contain "${f}"`, () => {
        expect(src).not.toContain(f);
      });
    }
  }
});

describe('shadow routing — no Ollama / LLM triage imports', () => {
  const FORBIDDEN = [
    "from 'ollama'",
    'createOllama',
    'OllamaClient',
    'ollama_triage',
    'llm_triage',
    'LLMTriage',
  ];
  for (const [name, src] of Object.entries(content)) {
    for (const f of FORBIDDEN) {
      it(`${name} does NOT contain "${f}"`, () => {
        expect(src).not.toContain(f);
      });
    }
  }
});
