// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

export type CodeLanguage =
  | 'javascript'
  | 'typescript'
  | 'python'
  | 'java'
  | 'csharp'
  | 'go'
  | 'rust'
  | 'ruby'
  | 'php'
  | 'kotlin'
  | 'swift'
  | 'scala'
  | 'other';

export type CodeRole = 'general' | 'backend' | 'frontend' | 'data_science' | 'systems';

export interface CodeLanguageProfile {
  primary: CodeLanguage; // linguagem principal

  secondary?: CodeLanguage[]; // linguagens secundárias

  // frameworks/bibliotecas que o modelo é "ótimo" em usar

  frameworks?: string[]; // ex: ["react", "django", "spring"]

  // nível declarado (do discovery/curadoria)

  level?: 'basic' | 'good' | 'expert';
}

export interface CodeCapabilityProfile {
  // linguagens que este modelo deve ser testado em:

  languages: CodeLanguageProfile;

  // se vale a pena testar multi-linguagem (true = roda testes em todas do profile)

  multiLanguage?: boolean;

  // peso relativo desse modelo para cenários de código dentro da tua plataforma

  role?: CodeRole;
}
