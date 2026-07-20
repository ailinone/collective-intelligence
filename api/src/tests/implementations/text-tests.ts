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
 * Teste de chat - prompt determinístico com resposta exata
 */
export const chatTest: CapabilityTester = async ({ model, client }) => {
  const prompt =
    "Responda exatamente com: 'Hello, World!' (sem aspas, sem ponto final, sem explicações).";
  const expected = 'Hello, World!';

  const result = await client.text({
    prompt,
    system: 'Você é um assistente de teste. Siga as instruções à risca.',
    temperature: 0,
  });

  const content = result.content.trim();
  const success = content === expected;

  return {
    success,
    score: success ? 1 : 0,
    metadata: { prompt, response: content, expected, raw: result.raw },
  };
};

/**
 * Teste de function calling
 */
export const functionCallingTest: CapabilityTester = async ({ model, client }) => {
  const tools = [
    {
      name: 'get_weather',
      description: 'Retorna a temperatura atual em Celsius para uma cidade.',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string' },
          unit: { type: 'string', enum: ['celsius', 'fahrenheit'] },
        },
        required: ['city', 'unit'],
      },
    },
  ];

  const prompt =
    'Qual é a temperatura em São Paulo em Celsius agora? Não responda você, chame apenas a função adequada.';

  const result = await client.toolChat({
    messages: [{ role: 'user', content: prompt }],
    tools,
    toolChoice: 'auto',
  });

  const success =
    result.toolCalls.length > 0 &&
    result.toolCalls[0].toolName === 'get_weather' &&
    (typeof result.toolCalls[0].arguments === 'object' && result.toolCalls[0].arguments !== null && 'city' in result.toolCalls[0].arguments && typeof result.toolCalls[0].arguments.city === 'string' && result.toolCalls[0].arguments.city.toLowerCase().includes('são paulo')) &&
    result.toolCalls[0].arguments.unit === 'celsius';

  return {
    success,
    score: success ? 0.85 : 0,
    metadata: {
      toolCalls: result.toolCalls,
      raw: result.raw,
    },
  };
};

/**
 * Teste de streaming
 */
export const streamingTest: CapabilityTester = async ({ model, client }) => {
  const prompt = 'Conte de 1 a 10, um número por linha.';

  const chunks: string[] = [];
  let fullText = '';

  for await (const chunk of client.streamText({
    prompt,
    temperature: 0,
  })) {
    chunks.push(chunk.content);
    fullText += chunk.content;
  }

  const chunksCount = chunks.length;
  const hasMultipleChunks = chunksCount > 1;
  const hasAllNumbers = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'].every((n) =>
    fullText.includes(n)
  );

  const success = hasMultipleChunks && hasAllNumbers;

  return {
    success,
    score: success ? 0.9 : 0,
    metadata: {
      chunksCount,
      fullText,
      chunks,
    },
  };
};

/**
 * Teste de reasoning (matemática)
 */
export const reasoningTest: CapabilityTester = async ({ model, client }) => {
  const prompt = `
João tem 5 maçãs. Ele compra mais 7 e dá 3 para Maria.
Depois, ele compra o dobro do que sobrou.
Quantas maçãs João tem no final?
Explique o raciocínio e dê a resposta final no formato "Resposta: X".
`;

  const result = await client.text({
    prompt,
    system: 'Resolva passo a passo, com cuidado.',
    temperature: 0,
  });

  const text = result.content;
  const hasCorrectAnswer = /Resposta:\s*16\b/.test(text);

  return {
    success: hasCorrectAnswer,
    score: hasCorrectAnswer ? 0.7 : 0,
    metadata: {
      response: text,
      raw: result.raw,
    },
  };
};

/**
 * Teste de JSON mode
 */
export const jsonModeTest: CapabilityTester = async ({ model, client }) => {
  const schema = {
    type: 'object',
    properties: {
      name: { type: 'string' },
      age: { type: 'number' },
    },
    required: ['name', 'age'],
    additionalProperties: false,
  };

  const prompt = 'Responda apenas com um JSON contendo {"name": "Alice", "age": 30}.';

  const result = await client.structuredJson({
    prompt,
    schema,
  });

  let jsonOk = false;
  let parsed: unknown = null;

  try {
    parsed = result.json;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      jsonOk =
        typeof obj.name === 'string' &&
        obj.name === 'Alice' &&
        typeof obj.age === 'number' &&
        obj.age === 30;
    }
  } catch {
    jsonOk = false;
  }

  return {
    success: jsonOk,
    score: jsonOk ? 0.95 : 0,
    metadata: {
      response: parsed,
      raw: result.raw,
    },
  };
};
