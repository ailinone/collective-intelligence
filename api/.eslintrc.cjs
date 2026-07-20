// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

module.exports = {
  root: true,
  env: {
    es2023: true,
    node: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: ['./tsconfig.json'],
    tsconfigRootDir: __dirname,
  },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  ignorePatterns: [
    'dist/',
    'coverage/',
    'node_modules/',
    'src/generated/**',
    'vitest.config.ts',
    'vitest.integration.config.ts',
    'vitest.unit.config.ts',
    'src/tests/*.test.ts',
    'src/tests/**/*.ts',
    '**/*.test.ts',
    '**/*.spec.ts',
    '**/__tests__/**',
  ],
  rules: {
    '@typescript-eslint/explicit-function-return-type': 'off',
    // Proibir 'any' em código de produção (permitir apenas em testes)
    '@typescript-eslint/no-explicit-any': 'error',
    // Proibir 'as unknown as' (type assertions perigosas)
    '@typescript-eslint/no-unsafe-assignment': 'error',
    '@typescript-eslint/no-unsafe-member-access': 'error',
    '@typescript-eslint/no-unsafe-call': 'error',
    '@typescript-eslint/no-unsafe-return': 'error',
    // ── PROIBIÇÃO EXPLÍCITA DE CASTS INSEGUROS ──
    // O cast `(x as unknown) as Y` (ou `x as unknown as Y`) é o padrão usado
    // para "esconder" violações de tipo. Estado-da-arte: zero tolerância.
    // Use type guards, branded types ou union types em vez disso.
    'no-restricted-syntax': [
      'error',
      {
        // AST: TSAsExpression cuja expressão interna é OUTRA TSAsExpression
        // para `unknown` — captura `x as unknown as Y` em qualquer formação.
        selector: "TSAsExpression[typeAnnotation.type!='TSUnknownKeyword'] > TSAsExpression[typeAnnotation.type='TSUnknownKeyword']",
        message: 'Cast duplo via `as unknown as` é proibido. Use type guards (`if (typeof x === ...)`), branded types, union types, ou o helper `narrowAs<T>` em `@/utils/type-guards`.',
      },
      {
        // Captura `x as never as Y` (laundering equivalente: `never` é o
        // bottom type, qualquer cast a partir de `never` "passa" por TS,
        // mas é semanticamente o mesmo padrão de fuga que `unknown`).
        selector: "TSAsExpression[typeAnnotation.type!='TSNeverKeyword'] > TSAsExpression[typeAnnotation.type='TSNeverKeyword']",
        message: 'Cast duplo via `as never as` é proibido. Padrão equivalente a `as unknown as` — use type guards ou `narrowAs<T>`.',
      },
      {
        // Captura `x as any` direto.
        selector: "TSAsExpression[typeAnnotation.type='TSAnyKeyword']",
        message: 'Cast para `any` é proibido. Use `unknown` + type guard, ou tipe explicitamente o valor.',
      },
    ],
    '@typescript-eslint/no-unused-vars': [
      'warn',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      },
    ],
    '@typescript-eslint/require-await': 'off',
    '@typescript-eslint/ban-ts-comment': 'off',
    'no-useless-escape': 'off',
    'prefer-const': 'off',
    'no-control-regex': 'off',
    // Formatação e espaçamento
    'no-multiple-empty-lines': ['error', { max: 2, maxEOF: 1, maxBOF: 0 }],
    'padded-blocks': ['error', 'never'],
    'lines-between-class-members': ['error', 'always', { exceptAfterSingleLine: true }],
    'object-curly-spacing': ['error', 'always'],
    'array-bracket-spacing': ['error', 'never'],
    'comma-spacing': ['error', { before: false, after: true }],
    'key-spacing': ['error', { beforeColon: false, afterColon: true }],
    'space-before-blocks': ['error', 'always'],
    'space-before-function-paren': ['error', { anonymous: 'always', named: 'never', asyncArrow: 'always' }],
    'space-in-parens': ['error', 'never'],
    'space-infix-ops': 'error',
    'space-unary-ops': ['error', { words: true, nonwords: false }],
  },
  overrides: [
    {
      files: ['tests/**/*.{ts,tsx}', '**/*.test.ts', '**/*.test.tsx', '**/__tests__/**/*.ts'],
      env: {
        node: true,
      },
      rules: {
        '@typescript-eslint/no-empty-function': 'off',
        // Permitir 'any' apenas em arquivos de teste (para facilitar mocks)
        '@typescript-eslint/no-explicit-any': 'warn',
        '@typescript-eslint/no-unsafe-assignment': 'off',
        '@typescript-eslint/no-unsafe-member-access': 'off',
        '@typescript-eslint/no-unsafe-call': 'off',
        '@typescript-eslint/no-unsafe-return': 'off',
      },
    },
  ],
};

