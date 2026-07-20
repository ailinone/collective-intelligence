// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import type { CapabilityTester, CapabilityTestContext } from './types';
import { getErrorMessage } from '@/utils/type-guards';

import type { SupportedLanguage } from '@/runtime/code-sandbox';

import { getCodeSandbox } from '@/runtime';

import type { CodeLanguage } from '@/types/code-profile';

function getModelLanguage(ctx: CapabilityTestContext): SupportedLanguage {
  // Type-safe access to nested config properties
  const extra = ctx.model.config?.extra;
  if (extra && typeof extra === 'object') {
    const languageProfile = extra.languageProfile;
    if (languageProfile && typeof languageProfile === 'object') {
      const languages = (languageProfile as Record<string, unknown>).languages;
      if (languages && typeof languages === 'object') {
        const primary = (languages as Record<string, unknown>).primary;
        if (typeof primary === 'string') {
          const validLanguages: SupportedLanguage[] = ['javascript', 'typescript', 'python', 'go', 'java', 'csharp'];
          if (validLanguages.includes(primary as SupportedLanguage)) {
            return primary as SupportedLanguage;
          }
        }
      }
    }
  }

  // fallback padrão
  return 'javascript';
}

function buildIsPrimePrompt(lang: SupportedLanguage): string {
  const langName =
    lang === 'javascript'
      ? 'JavaScript'
      : lang === 'typescript'
        ? 'TypeScript'
        : lang === 'python'
          ? 'Python'
          : lang === 'go'
            ? 'Go'
            : lang === 'java'
              ? 'Java'
              : lang === 'csharp'
                ? 'C#'
                : 'linguagem';

  const codeFence =
    lang === 'python'
      ? 'python'
      : lang === 'go'
        ? 'go'
        : lang === 'java'
          ? 'java'
          : lang === 'csharp'
            ? 'csharp'
            : 'js';

  return `

Implemente em ${langName} uma função chamada "isPrime" que recebe um número inteiro "n"

e retorna true se "n" for primo e false caso contrário.

Responda APENAS com o código da função (e o que for necessário para ela compilar),

em um único bloco \`\`\`${codeFence}.

`;
}

export const codeGenerationTest: CapabilityTester = async (ctx) => {
  const { client, model } = ctx;

  const lang = getModelLanguage(ctx);

  const sandbox = getCodeSandbox();

  const prompt = buildIsPrimePrompt(lang);

  const res = await client.text({
    prompt,

    temperature: 0,

    maxTokens: 512,
  });

  const codeBlockMatch = res.content.match(/```[a-zA-Z]*\s*([\s\S]*?)```/);

  if (!codeBlockMatch) {
    return {
      success: false,

      score: 0,

      metadata: {
        error: 'no_code_block',

        raw: res.content,

        lang,
      },
    };
  }

  const userCode = codeBlockMatch[1];

  const tests = [
    { args: [2], expected: true },

    { args: [3], expected: true },

    { args: [4], expected: false },

    { args: [17], expected: true },

    { args: [18], expected: false },
  ];

  try {
    const result = await sandbox.testFunction(lang, userCode, 'isPrime', tests, {
      timeoutMs: 10_000,
    });

    return {
      success: result.passed,

      score: result.passed ? 1 : result.details.passedCases / result.details.totalCases,

      metadata: {
        language: lang,

        sandbox: result.details,
      },
    };
  } catch (err) {
    return {
      success: false,

      score: 0,

      metadata: {
        language: lang,

        error: getErrorMessage(err),
      },
    };
  }
};

// ========= CODE REVIEW =========

export const codeReviewTest: CapabilityTester = async ({ client }) => {
  const buggyCode = `

function add(a, b) {

  return a - b; // BUG: deveria somar

}

`;

  const res = await client.text({
    prompt: `

Analise o código abaixo e descreva em no máximo 3 frases os problemas encontrados.

${buggyCode}

`,

    temperature: 0,

    maxTokens: 256,
  });

  const norm = res.content.toLowerCase();

  const ok =
    norm.includes('bug') ||
    norm.includes('erro') ||
    norm.includes('deveria somar') ||
    norm.includes('a + b');

  return {
    success: ok,

    score: ok ? 0.9 : 0.3,

    metadata: { response: res.content },
  };
};

// ========= DEBUGGING =========

export const debuggingTest: CapabilityTester = async (ctx) => {
  const { client } = ctx;

  const lang = getModelLanguage(ctx);

  const sandbox = getCodeSandbox();

  const buggy = buildBuggyAddSnippet(lang);

  const prompt = buildDebugPrompt(lang, buggy);

  const res = await client.text({
    prompt,

    temperature: 0,

    maxTokens: 512,
  });

  const match = res.content.match(/```[a-zA-Z]*\s*([\s\S]*?)```/);

  if (!match) {
    return {
      success: false,

      score: 0,

      metadata: {
        error: 'no_code_block',

        raw: res.content,

        lang,
      },
    };
  }

  const userCode = match[1];

  const tests = [
    { args: [2, 3], expected: 5 },

    { args: [5, 7], expected: 12 },

    { args: [-1, 1], expected: 0 },
  ];

  try {
    const result = await sandbox.testFunction(lang, userCode, 'add', tests, { timeoutMs: 10_000 });

    return {
      success: result.passed,

      score: result.passed ? 1 : result.details.passedCases / result.details.totalCases,

      metadata: {
        language: lang,

        sandbox: result.details,
      },
    };
  } catch (err) {
    return {
      success: false,

      score: 0,

      metadata: {
        language: lang,

        error: getErrorMessage(err),
      },
    };
  }
};

// ========= REFACTORING =========

export const refactoringTest: CapabilityTester = async (ctx) => {
  const { client, model } = ctx;

  const lang = getModelLanguage(ctx);

  const sandbox = getCodeSandbox();

  const baseCode = buildRefactorBaseSnippet(lang);

  const prompt = buildRefactorPrompt(lang, baseCode);

  const res = await client.text({
    prompt,

    temperature: 0.1,

    maxTokens: 800,
  });

  const match = res.content.match(/```[a-zA-Z]*\s*([\s\S]*?)```/);

  if (!match) {
    return {
      success: false,

      score: 0,

      metadata: {
        error: 'no_code_block',

        raw: res.content,

        language: lang,

        modelId: model.id,
      },
    };
  }

  const userCode = match[1];

  const tests = [
    {
      args: [
        [
          { price: 10, quantity: 2 },

          { price: 5, quantity: 1 },
        ],
        0,
      ],

      expected: 25,
    },

    {
      args: [
        [
          { price: 100, quantity: 1 },

          { price: 50, quantity: 2 },
        ],
        10,
      ],

      expected: 180, // (100 + 100) * 0.9
    },
  ];

  try {
    const result = await sandbox.testFunction(
      lang,

      userCode,

      'calculateTotalPrice',

      tests,

      { timeoutMs: 10_000 }
    );

    // score = % de casos que passaram; se todos, 1.0

    const baseScore =
      result.details.totalCases === 0 ? 0 : result.details.passedCases / result.details.totalCases;

    // opcional: heurística simples de "refatoração"

    const originalLength = baseCode.split('\n').length;

    const newLength = userCode.split('\n').length;

    const shorter = newLength <= originalLength;

    const score = shorter ? Math.min(1, baseScore + 0.1) : baseScore;

    return {
      success: baseScore === 1,

      score,

      metadata: {
        language: lang,

        sandbox: result.details,

        originalLength,

        newLength,
      },
    };
  } catch (err) {
    return {
      success: false,

      score: 0,

      metadata: {
        language: lang,

        error: getErrorMessage(err),
      },
    };
  }
};

// ========= CODE INTERPRETER =========

export const codeInterpreterTest: CapabilityTester = async (ctx) => {
  const { client, model } = ctx;

  const lang = getModelLanguage(ctx);

  const sandbox = getCodeSandbox();

  const prompt = buildAnalyzeDataPrompt(lang);

  const res = await client.text({
    prompt,

    temperature: 0.1,

    maxTokens: 800,
  });

  const match = res.content.match(/```[a-zA-Z]*\s*([\s\S]*?)```/);

  if (!match) {
    return {
      success: false,

      score: 0,

      metadata: {
        error: 'no_code_block',

        raw: res.content,

        language: lang,

        modelId: model.id,
      },
    };
  }

  const userCode = match[1];

  const csv1 = `day,value

1,10

2,20

3,30

4,40

`;

  const csv2 = `day,value

1,5

2,15

3,25

`;

  const tests = [
    { args: [csv1], expected: 25 }, // média de 10,20,30,40

    { args: [csv2], expected: 15 }, // média de 5,15,25
  ];

  try {
    const result = await sandbox.testFunction(
      lang,

      userCode,

      'analyzeData',

      tests,

      { timeoutMs: 10_000 }
    );

    // tolerância para floating point:

    const failuresWithTol = result.details.failures
      .map((f) => {
        const exp = f.expected;

        const rec = f.received;

        if (typeof exp === 'number' && typeof rec === 'number') {
          const diff = Math.abs(exp - rec);

          if (diff <= 0.01) {
            return null; // consideramos como ok
          }
        }

        return f;
      })
      .filter(Boolean) as typeof result.details.failures;

    const effectivePassed = tests.length - failuresWithTol.length;

    const score = tests.length === 0 ? 0 : effectivePassed / tests.length;

    return {
      success: score === 1,

      score,

      metadata: {
        language: lang,

        sandbox: result.details,

        adjustedFailures: failuresWithTol,
      },
    };
  } catch (err) {
    return {
      success: false,

      score: 0,

      metadata: {
        language: lang,

        error: getErrorMessage(err),
      },
    };
  }
};

// Helpers para prompts

function buildBuggyAddSnippet(lang: SupportedLanguage): string {
  switch (lang) {
    case 'python':
      return `

def add(a, b):

    return a - b  # BUG: deveria somar

`;

    case 'javascript':
    // falls through
    case 'typescript':
      return `

function add(a, b) {

  return a - b; // BUG: deveria somar

}

`;

    case 'go':
      return `

package main

func add(a int, b int) int {

    return a - b // BUG: deveria somar

}

`;

    default:
      // fallback para JS se a linguagem ainda não estiver 100% suportada no sandbox

      return `

function add(a, b) {

  return a - b;

}

`;
  }
}

function buildDebugPrompt(lang: SupportedLanguage, buggyCode: string): string {
  const langName =
    lang === 'python'
      ? 'Python'
      : lang === 'go'
        ? 'Go'
        : lang === 'java'
          ? 'Java'
          : lang === 'csharp'
            ? 'C#'
            : lang === 'typescript'
              ? 'TypeScript'
              : 'JavaScript';

  const codeFence =
    lang === 'python'
      ? 'python'
      : lang === 'go'
        ? 'go'
        : lang === 'java'
          ? 'java'
          : lang === 'csharp'
            ? 'csharp'
            : lang === 'typescript'
              ? 'ts'
              : 'js';

  return `

O código abaixo está em ${langName} e contém um bug na função "add".

Corrija a função para que ela some corretamente os dois números.

Responda apenas com o código corrigido, em um único bloco \`\`\`${codeFence}.

${buggyCode}

`;
}

function buildRefactorBaseSnippet(lang: SupportedLanguage): string {
  switch (lang) {
    case 'python':
      return `

def calculateTotalPrice(items, discount):

    t = 0

    i = 0

    while i < len(items):

        t = t + items[i]["price"] * items[i]["quantity"]

        i = i + 1

    d = 0

    if discount is not None and discount > 0:

        d = t * (discount / 100.0)

    r = t - d

    return r

`;

    case 'javascript':
    // falls through
    case 'typescript':
      return `

function calculateTotalPrice(items, discount) {

  let t = 0;

  for (let i = 0; i < items.length; i++) {

    t = t + items[i].price * items[i].quantity;

  }

  let d = 0;

  if (discount && discount > 0) {

    d = t * (discount / 100);

  }

  let r = t - d;

  return r;

}

`;

    case 'go':
      // exemplo simplificado

      return `

package main

import "fmt"

func calculateTotalPrice(items []map[string]interface{}, discount float64) float64 {

  t := 0.0

  for _, it := range items {

    t += it["price"].(float64) * it["quantity"].(float64)

  }

  d := 0.0

  if discount > 0 {

    d = t * (discount / 100.0)

  }

  r := t - d

  return r

}

`;

    default:
      return `

function calculateTotalPrice(items, discount) {

  let t = 0;

  for (let i = 0; i < items.length; i++) {

    t = t + items[i].price * items[i].quantity;

  }

  let d = 0;

  if (discount && discount > 0) {

    d = t * (discount / 100);

  }

  let r = t - d;

  return r;

}

`;
  }
}

function buildRefactorPrompt(lang: SupportedLanguage, buggyCode: string): string {
  const langName =
    lang === 'python'
      ? 'Python'
      : lang === 'go'
        ? 'Go'
        : lang === 'java'
          ? 'Java'
          : lang === 'csharp'
            ? 'C#'
            : lang === 'typescript'
              ? 'TypeScript'
              : 'JavaScript';

  const codeFence =
    lang === 'python'
      ? 'python'
      : lang === 'go'
        ? 'go'
        : lang === 'java'
          ? 'java'
          : lang === 'csharp'
            ? 'csharp'
            : lang === 'typescript'
              ? 'ts'
              : 'js';

  return `

O código abaixo está em ${langName} e funciona, mas está mal escrito.

TAREFA:

- Refatore o código para ficar mais legível, mantendo EXATAMENTE o mesmo comportamento.

- Mantenha o mesmo nome de função "calculateTotalPrice" e a mesma assinatura de parâmetros.

- Você pode extrair funções auxiliares, renomear variáveis, etc., mas a função principal deve continuar se chamando "calculateTotalPrice".

Responda apenas com o código refatorado, em um único bloco \`\`\`${codeFence}.

${buggyCode}

`;
}

function buildAnalyzeDataPrompt(lang: SupportedLanguage): string {
  const langName =
    lang === 'python'
      ? 'Python'
      : lang === 'go'
        ? 'Go'
        : lang === 'java'
          ? 'Java'
          : lang === 'csharp'
            ? 'C#'
            : lang === 'typescript'
              ? 'TypeScript'
              : 'JavaScript';

  const codeFence =
    lang === 'python'
      ? 'python'
      : lang === 'go'
        ? 'go'
        : lang === 'java'
          ? 'java'
          : lang === 'csharp'
            ? 'csharp'
            : lang === 'typescript'
              ? 'ts'
              : 'js';

  return `

Você receberá uma string CSV representando uma tabela com duas colunas: "day" e "value".

Exemplo de CSV:

day,value

1,10

2,20

3,30

TAREFA:

Implemente em ${langName} uma função chamada "analyzeData" que recebe uma string "csv" e

RETORNA APENAS a média (mean) da coluna "value" como um número.

Regras:

- Ignore a primeira linha (cabeçalho).

- Considere apenas linhas válidas (com dia e valor numérico).

- Retorne um número (float ou equivalente) com a média.

- Não imprima nada no console, apenas retorne o valor.

Responda apenas com o código da função (e o que for necessário para compilar),

em um único bloco \`\`\`${codeFence}.

`;
}
