// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Robust non-generative model exclusion for chat/reasoning pools.
 *
 * Why this exists: the catalog `capabilities` data is unreliable. Retrieval
 * models (embeddings, rerankers) and even HuggingFace decoding-method demo repos
 * (`transformers-community/contrastive-search`, `group-beam-search`) are
 * frequently mis-tagged with `chat`/`text_generation`. A modality filter that
 * trusts those tags lets them into collective voting pools, where they cast
 * garbage "votes" on text/reasoning tasks. This was observed live: a `consensus`
 * call on a plain math task selected embeddings (`text-embedding-3-small`),
 * rerankers (`jina-reranker-*`, `voyage-*`), audio models (`voxtral`), search
 * models (`gpt-4o-search-preview`) and decoding-method strings as voters.
 *
 * This predicate excludes models that are fundamentally NON-GENERATIVE for text,
 * using BOTH a capability signal AND an id/family signal — so corrupt tags
 * cannot smuggle a retrieval/decoding/audio model into a chat pool.
 *
 * It is a CLASS filter (exclude non-chat-generative model *types*), NOT a model
 * pin: it never selects or forces any specific model id, so selection stays
 * fully dynamic. Vision/multimodal chat models (e.g. frontier multimodal models)
 * are deliberately NOT excluded — they can answer text; weak ones are handled by
 * quality ranking, not by this filter.
 */
/** Capabilities that mark a model as retrieval/non-generative even if it ALSO (falsely) claims chat. */
const DISQUALIFYING_CAPABILITIES = new Set<string>([
  'embedding', 'embeddings', 'reranking', 'rerank', 'reranker',
]);

/**
 * Id/family patterns for model classes whose capability tags are unreliable and
 * which cannot perform general text reasoning: embeddings, rerankers, HF
 * decoding-method demo repos, pure speech/audio models, and forced-retrieval
 * search endpoints.
 */
const NON_GENERATIVE_ID_PATTERN =
  /(?:^|[/_-])(?:text-)?embeddings?(?:[/_-]|$)|rerank(?:er)?|colbert|voyage-|contrastive-search|group-beam-search|diverse-beam|(?:^|[/_-])beam-search|greedy-search|transformers-community\/|\bvoxtral\b|\bwhisper\b|text-to-speech|speech-to-text|search-(?:api|preview)|(?:^|[/_-])(?:multilingual-)?e5(?:[/_-]|$)|(?:^|[/_-])(?:bge|gte|labse|minilm|sentence-transformers?)(?:[/_-]|$)/i;

/**
 * Returns true when `model` is fundamentally non-generative for text reasoning
 * (embedding / reranker / decoding-method repo / pure audio / forced-search) and
 * therefore must not be selected as a chat or collective-voting participant.
 */
export function isNonGenerativeModel(model: {
  id?: string | null;
  capabilities?: readonly string[] | null;
}): boolean {
  const caps = (model.capabilities ?? []) as readonly string[];
  for (const c of caps) {
    if (typeof c === 'string' && DISQUALIFYING_CAPABILITIES.has(c.toLowerCase())) return true;
  }
  const id = (model.id ?? '').toLowerCase();
  return NON_GENERATIVE_ID_PATTERN.test(id);
}
