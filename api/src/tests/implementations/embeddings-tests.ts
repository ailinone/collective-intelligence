// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import type { CapabilityTester } from '../capabilities';

/**
 * Teste de embeddings - similaridade semântica
 */
export const embeddingsTest: CapabilityTester = async ({ model, client }) => {
  const textA = 'O gato está dormindo no sofá.';
  const textB = 'Um felino descansa tranquilamente no sofá da sala.';
  const textC = 'Hoje é um bom dia para investir em ações de tecnologia.';

  const result = await client.embeddings({ inputs: [textA, textB, textC] });

  if (result.vectors.length !== 3) {
    return { success: false, score: 0, metadata: { reason: 'wrong_vector_count' } };
  }

  const [embA, embB, embC] = result.vectors;

  const simAB = cosineSimilarity(embA, embB);
  const simAC = cosineSimilarity(embA, embC);

  const success = simAB > simAC + 0.1; // A e B mais próximos do que A e C

  return {
    success,
    score: success ? simAB : 0,
    metadata: {
      simAB,
      simAC,
    },
  };
};

function cosineSimilarity(a: number[], b: number[]): number {
  const dot = a.reduce((sum, v, i) => sum + v * b[i], 0);
  const magA = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0));
  const magB = Math.sqrt(b.reduce((sum, v) => sum + v * v, 0));
  return dot / (magA * magB);
}
