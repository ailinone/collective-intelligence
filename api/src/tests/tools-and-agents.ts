// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import type { CapabilityTester } from './types';

// ========= STREAMING =========

export const streamingTest: CapabilityTester = async ({ client }) => {
  const req = {
    prompt: 'Conte de 1 a 10, um número por linha.',

    temperature: 0,

    maxTokens: 64,
  };

  const chunks: string[] = [];

  for await (const chunk of client.streamText(req)) {
    chunks.push(chunk.content);
  }

  const full = chunks.join('');

  const hasAll = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'].every((n) => full.includes(n));

  const multiChunks = chunks.length > 1;

  const ok = hasAll && multiChunks;

  return {
    success: ok,

    score: ok ? 0.9 : 0.3,

    metadata: { chunksCount: chunks.length, full },
  };
};

// ========= JSON MODE =========

export const jsonModeTest: CapabilityTester = async ({ client }) => {
  const res = await client.structuredJson<{ name: string; age: number }>({
    prompt: 'Responda apenas com o JSON {"name":"Alice","age":30}.',

    temperature: 0,

    maxTokens: 32,
  });

  const { json } = res;

  const ok = json && json.name === 'Alice' && typeof json.age === 'number' && json.age === 30;

  return {
    success: ok,

    score: ok ? 0.95 : 0,

    metadata: { json, raw: res.raw },
  };
};

// ========= EMBEDDINGS =========

export const embeddingsTest: CapabilityTester = async ({ client }) => {
  const a = 'O gato está dormindo no sofá.';

  const b = 'Um felino descansa tranquilamente no sofá da sala.';

  const c = 'Hoje é um excelente dia para investir em ações de tecnologia.';

  const res = await client.embeddings({ inputs: [a, b, c] });

  if (res.vectors.length !== 3) {
    return { success: false, score: 0, metadata: { reason: 'wrong_vector_count' } };
  }

  // Simulação de similaridade (em produção calcularia cosine similarity)

  const ok = res.vectors.every((v) => Array.isArray(v) && v.length > 0);

  return {
    success: ok,

    score: ok ? 0.8 : 0,

    metadata: { vectorCount: res.vectors.length },
  };
};

// ========= FUNCTION CALLING / TOOL_USE =========

export const functionCallingTest: CapabilityTester = async ({ client }) => {
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

  const res = await client.toolChat({
    messages: [
      {
        role: 'user',

        content: 'Qual é a temperatura agora em São Paulo em Celsius?',
      },
    ],

    tools,

    toolChoice: 'auto',
  });

  const call = res.toolCalls[0];

  if (!call) {
    return {
      success: false,

      score: 0,

      metadata: { raw: res.raw, error: 'no_tool_call' },
    };
  }

  const city = (call.arguments.city || '').toString().toLowerCase();

  const unit = call.arguments.unit;

  const ok = call.toolName === 'get_weather' && city.includes('sao paulo') && unit === 'celsius';

  return {
    success: ok,

    score: ok ? 0.9 : 0.2,

    metadata: { call },
  };
};

export const toolUseTest: CapabilityTester = functionCallingTest;

// ========= PLACEHOLDERS =========

export const webSearchTest: CapabilityTester = async ({ client }) => {
  const tools = [
    {
      name: 'web_search',

      description: 'Busca resultados na web.',

      parameters: {
        type: 'object',

        properties: {
          query: { type: 'string' },
        },

        required: ['query'],
      },
    },
  ];

  const res = await client.toolChat({
    messages: [
      {
        role: 'user',

        content: 'Busque na web informações sobre "Minha IA plataforma brasileira de IA".',
      },
    ],

    tools,

    toolChoice: 'auto',
  });

  const call = res.toolCalls[0];

  const ok = !!call && call.toolName === 'web_search';

  return {
    success: ok,

    score: ok ? 0.8 : 0.3,

    metadata: { call },
  };
};

export const fileSearchTest: CapabilityTester = async ({ client }) => {
  const tools = [
    {
      name: 'file_search',

      description: 'Busca em arquivos internos da organização.',

      parameters: {
        type: 'object',

        properties: {
          query: { type: 'string' },
        },

        required: ['query'],
      },
    },
  ];

  const res = await client.toolChat({
    messages: [
      {
        role: 'user',

        content: 'Procure documentos sobre "plano de validação de modelos" nos arquivos internos.',
      },
    ],

    tools,

    toolChoice: 'auto',
  });

  const call = res.toolCalls[0];

  const ok = !!call && call.toolName === 'file_search';

  return {
    success: ok,

    score: ok ? 0.8 : 0.3,

    metadata: { call },
  };
};

export const agentsTest: CapabilityTester = async ({ client }) => {
  const res = await client.text({
    prompt:
      'Crie um plano com 3 passos para investigar um incidente de API e finalize com "DONE".',
    system: 'Responda com plano objetivo e finalização explícita.',
    temperature: 0,
    maxTokens: 192,
  });

  const text = res.content.trim().toLowerCase();
  const ok = text.includes('done') && (text.includes('1') || text.includes('passo'));

  return {
    success: ok,
    score: ok ? 0.8 : 0.3,
    metadata: { content: res.content },
  };
};

export const deepResearchTest: CapabilityTester = webSearchTest;
export const actionPlanningTest: CapabilityTester = agentsTest;

export const selfCorrectionTest: CapabilityTester = async ({ client }) => {
  const res = await client.text({
    prompt:
      'Corrija esta afirmação inválida de forma objetiva: "2+2=5". Responda apenas com a forma corrigida.',
    system: 'Corrija apenas o fato matemático solicitado.',
    temperature: 0,
    maxTokens: 32,
  });

  const text = res.content.trim();
  const ok = text.includes('2+2=4') || text === '4';

  return {
    success: ok,
    score: ok ? 0.9 : 0.2,
    metadata: { content: text },
  };
};

export const computerUseTest: CapabilityTester = async ({ client }) => {
  const tools = [
    {
      name: 'open_url',
      description: 'Abre uma URL no navegador remoto.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
        },
        required: ['url'],
      },
    },
  ];

  const res = await client.toolChat({
    messages: [{ role: 'user', content: 'Abra https://example.com e confirme a ação.' }],
    tools,
    toolChoice: 'auto',
  });

  const call = res.toolCalls[0];
  const ok = !!call && call.toolName === 'open_url';

  return {
    success: ok,
    score: ok ? 0.75 : 0.25,
    metadata: { call },
  };
};

export const mcpTest: CapabilityTester = async ({ client }) => {
  const tools = [
    {
      name: 'mcp_call',
      description: 'Executa chamada para servidor MCP.',
      parameters: {
        type: 'object',
        properties: {
          tool: { type: 'string' },
        },
        required: ['tool'],
      },
    },
  ];

  const res = await client.toolChat({
    messages: [{ role: 'user', content: 'Use MCP para chamar a ferramenta "health_check".' }],
    tools,
    toolChoice: 'auto',
  });

  const call = res.toolCalls[0];
  const ok = !!call && call.toolName === 'mcp_call';

  return {
    success: ok,
    score: ok ? 0.75 : 0.25,
    metadata: { call },
  };
};
