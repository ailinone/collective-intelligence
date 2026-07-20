// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import type { CapabilityTester } from './types';

import { normalizeText } from './helpers/similarity';

// ========= MATHEMATICAL PROBLEM SOLVING =========

export const mathProblemSolvingTest: CapabilityTester = async ({ client }) => {
  const prompt = `

João tem 5 maçãs. Ele compra mais 7 e dá 3 para Maria.

Depois, ele compra o dobro do que SOBROU com ele.

Quantas maçãs João tem no final?

Responda apenas no formato: "Resposta: X".

`;

  const res = await client.text({
    prompt,

    temperature: 0,

    maxTokens: 64,
  });

  const match = res.content.match(/Resposta:\s*(\d+)/i);

  const expected = 16;

  const value = match ? Number(match[1]) : NaN;

  const ok = value === expected;

  return {
    success: ok,

    score: ok ? 1 : 0,

    metadata: { response: res.content, value, expected },
  };
};

// ========= LOGIC & INFERENCE =========

export const logicInferenceTest: CapabilityTester = async ({ client }) => {
  const prompt = `

Se chover, a rua fica molhada.

Hoje a rua não está molhada.

O que podemos inferir sobre ter chovido hoje?

Responda em UMA frase curta.

`;

  const res = await client.text({
    prompt,

    temperature: 0,

    maxTokens: 64,
  });

  const norm = normalizeText(res.content);

  const ok = norm.includes('nao choveu') || norm.includes('provavelmente nao choveu');

  return {
    success: ok,

    score: ok ? 1 : 0.5,

    metadata: { response: res.content },
  };
};

// ========= TEMPORAL REASONING =========

export const temporalReasoningTest: CapabilityTester = async ({ client }) => {
  const prompt = `

Ana fez uma reunião na segunda-feira.

Na terça-feira ela viajou.

Na quarta-feira ela descansou.

Qual dessas atividades aconteceu primeiro no tempo?

Responda apenas com "reunião", "viagem" ou "descanso".

`;

  const res = await client.text({
    prompt,

    temperature: 0,

    maxTokens: 8,
  });

  const norm = normalizeText(res.content);

  const ok = norm.includes('reuniao');

  return {
    success: ok,

    score: ok ? 1 : 0,

    metadata: { response: res.content },
  };
};

// ========= CAUSAL INFERENCE =========

export const causalInferenceTest: CapabilityTester = async ({ client }) => {
  const prompt = `

Uma loja aumentou o preço de um produto e, após isso, as vendas caíram significativamente.

O que é uma possível relação causal entre esses fatos?

Responda em uma frase curta.

`;

  const res = await client.text({
    prompt,

    temperature: 0,

    maxTokens: 64,
  });

  const norm = normalizeText(res.content);

  const ok =
    norm.includes('aumento de preco') &&
    (norm.includes('causou') || norm.includes('levou a')) &&
    norm.includes('queda nas vendas');

  return {
    success: ok,

    score: ok ? 0.9 : 0.4,

    metadata: { response: res.content },
  };
};

// ========= COUNTERFACTUAL REASONING =========

export const counterfactualReasoningTest: CapabilityTester = async ({ client }) => {
  const prompt = `

João saiu de casa 10 minutos atrasado para o trabalho e perdeu o ônibus.

Se ele tivesse saído no horário, o que provavelmente teria acontecido?

Responda em uma frase curta, enfatizando o "se... então...".

`;

  const res = await client.text({
    prompt,

    temperature: 0,

    maxTokens: 64,
  });

  const norm = normalizeText(res.content);

  const ok =
    norm.includes('se ele tivesse saido no horario') &&
    (norm.includes('nao teria perdido o onibus') || norm.includes('teria pegado o onibus'));

  return {
    success: ok,

    score: ok ? 0.9 : 0.4,

    metadata: { response: res.content },
  };
};

// ========= HYPOTHESIS GENERATION =========

export const hypothesisGenerationTest: CapabilityTester = async ({ client }) => {
  const prompt = `

Um aplicativo móvel vem perdendo usuários ativos diariamente.

Gere 3 hipóteses plausíveis, em bullet points, para explicar essa queda.

`;

  const res = await client.text({
    prompt,

    temperature: 0.3,

    maxTokens: 128,
  });

  const norm = normalizeText(res.content);

  const bullets = (res.content.match(/^[-*]/gm) || []).length;

  const mentions = [
    norm.includes('experiencia ruim'),

    norm.includes('bug') || norm.includes('erro'),

    norm.includes('concorrencia') || norm.includes('competidor'),
  ];

  const hits = mentions.filter(Boolean).length;

  const score = (hits / 3 + Math.min(bullets, 3) / 3) / 2;

  return {
    success: score >= 0.6,

    score,

    metadata: { response: res.content, bullets, hits },
  };
};

// ========= ZERO-SHOT & FEW-SHOT =========

export const zeroShotLearningTest: CapabilityTester = async ({ client }) => {
  const samples = [
    { text: 'O filme foi incrível, adorei cada minuto.', label: 'positivo' },

    { text: 'O atendimento foi péssimo, nunca mais volto.', label: 'negativo' },
  ];

  let hits = 0;

  for (const s of samples) {
    const res = await client.text({
      prompt: `

Classifique o sentimento (positivo ou negativo) da frase:

"${s.text}"

Responda apenas com "positivo" ou "negativo".

`,

      temperature: 0,

      maxTokens: 4,
    });

    const pred = normalizeText(res.content);

    if (pred.includes(s.label)) hits++;
  }

  const acc = hits / samples.length;

  return {
    success: acc >= 0.5,

    score: acc,

    metadata: { hits, total: samples.length },
  };
};

export const fewShotLearningTest: CapabilityTester = async ({ client }) => {
  const prompt = `

Exemplos:

Frase: "A comida estava ótima, vou voltar sempre." -> positivo

Frase: "O hotel era confortável e a equipe muito simpática." -> positivo

Frase: "O produto quebrou em dois dias, péssima qualidade." -> negativo

Agora, classifique as frases abaixo como "positivo" ou "negativo":

1) "O filme foi incrível, adorei cada minuto."

2) "O atendimento foi péssimo, nunca mais volto."

Responda no formato:

1) ...

2) ...

`;

  const res = await client.text({
    prompt,

    temperature: 0,

    maxTokens: 128,
  });

  const norm = normalizeText(res.content);

  const oneOk = /1\)\s*positivo/.test(norm);

  const twoOk = /2\)\s*negativo/.test(norm);

  const hits = [oneOk, twoOk].filter(Boolean).length;

  const acc = hits / 2;

  return {
    success: acc >= 0.5,

    score: acc,

    metadata: { response: res.content, hits },
  };
};

// ========= REASONING / THINKING_MODE =========

export const reasoningCompositeTest: CapabilityTester = async (ctx) => {
  // Pode simplesmente delegar para math + logic e tirar média

  const math = await mathProblemSolvingTest(ctx);

  const logic = await logicInferenceTest(ctx);

  const score = (math.score + logic.score) / 2;

  const success = score >= 0.6;

  return {
    success,

    score,

    metadata: {
      math,

      logic,
    },
  };
};
