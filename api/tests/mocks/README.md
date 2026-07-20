<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Mocks para Testes

## ⚠️ POLÍTICA IMPORTANTE: Nenhum Mock para Modelos/Providers

**REGRA FUNDAMENTAL**: Nenhum modelo de nenhum provedor deve estar cadastrado de forma hardcoded. Os modelos devem funcionar por meio de busca dinâmica e semântica. Isso é regra no projeto. Mesmo nos testes, tudo deve ser dinâmico e executado de forma real, sem uso de mock para garantir o funcionamento pleno.

**NÃO USE MOCKS PARA**:
- ❌ Provider Adapters (OpenAI, Anthropic, Google, etc.)
- ❌ Model Discovery Services
- ❌ Model Fetchers
- ❌ Model Repositories (quando relacionados a descoberta)

**USE DESCOBERTA DINÂMICA REAL**:
- ✅ Use `dynamic-model-discovery.ts` para obter modelos reais
- ✅ Use `getProviderRegistry()` para obter adapters reais
- ✅ Faça chamadas reais às APIs dos provedores

Veja: `api/tests/NO_MOCKS_POLICY.md` para mais detalhes.

## Princípio Fundamental

**Código de produção NUNCA deve conter lógica de teste.** 

- ❌ Verificações de `NODE_ENV === 'test'`
- ❌ Verificações de `process.env.TEST_*`
- ❌ Guards que pulam funcionalidades em ambiente de teste
- ❌ Imports de arquivos `test-environment.ts`

## Abordagem Correta (Para Outros Componentes)

Use **mocks do Vitest** APENAS para componentes que NÃO são relacionados a modelos/providers:

### 1. ❌ NÃO Mock Provider Adapters

**NÃO FAÇA ISSO** - Use adapters reais:

```typescript
// ❌ ERRADO - NÃO use mocks para providers
vi.mock('@/providers/openai/openai-adapter', () => ({ ... }));

// ✅ CORRETO - Use adapters reais
import { getProviderRegistry } from '@/providers/provider-registry';
import { discoverModelsDynamically } from '../utils/dynamic-model-discovery';

const registry = getProviderRegistry();
const adapter = registry.get('openai'); // Adapter REAL
const models = await discoverModelsDynamically(); // Modelos REAIS
```

### 2. ❌ NÃO Mock Model Discovery Service

**NÃO FAÇA ISSO** - Use descoberta dinâmica real:

```typescript
// ❌ ERRADO - NÃO use mocks para discovery
vi.mock('@/services/central-model-discovery-service', () => ({ ... }));

// ✅ CORRETO - Use descoberta dinâmica real
import { discoverModelsDynamically } from '../utils/dynamic-model-discovery';

const models = await discoverModelsDynamically(); // Descoberta REAL
```

### 3. Mock de Chamadas HTTP (fetch/axios)

```typescript
// tests/integration/api-calls.test.ts
import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest';

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

beforeAll(() => {
  mockFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ data: 'mocked' }),
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});
```

### 4. Mock de Módulos Específicos

```typescript
// tests/unit/discovery.test.ts
import { vi, describe, it, expect } from 'vitest';

// Mock de model fetchers específicos
vi.mock('@/services/model-fetchers/openai-model-fetcher', () => ({
  OpenAIModelFetcher: vi.fn().mockImplementation(() => ({
    getModels: vi.fn().mockResolvedValue([
      { id: 'gpt-4', name: 'GPT-4' },
      { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo' },
    ]),
  })),
}));
```

## Estrutura de Arquivos de Mock

```
tests/
├── mocks/
│   ├── README.md           # Este arquivo
│   ├── providers/
│   │   ├── openai.ts       # Mock do OpenAI Adapter
│   │   ├── anthropic.ts    # Mock do Anthropic Adapter
│   │   └── google.ts       # Mock do Google Adapter
│   ├── services/
│   │   └── model-discovery.ts  # Mock do Discovery Service
│   └── database/
│       └── prisma.ts       # Mock do Prisma Client
├── fixtures/
│   ├── models.json         # Dados de modelos para testes
│   ├── responses.json      # Respostas mock de APIs
│   └── users.json          # Dados de usuários para testes
└── utils/
    └── test-helpers.ts     # Funções auxiliares para testes
```

## Testes de Integração com APIs Reais

Para testes de integração que **precisam** de APIs reais:

1. Use variáveis de ambiente específicas
2. Marque como testes lentos/opcionais
3. Execute apenas em CI com secrets configurados

```typescript
// tests/integration/real-api.test.ts
import { describe, it, expect } from 'vitest';

describe.skipIf(!process.env.OPENAI_API_KEY)('Real OpenAI Integration', () => {
  it('should call real OpenAI API', async () => {
    // Este teste só roda se OPENAI_API_KEY estiver configurada
  });
});
```

## Configuração no vitest.config.ts

```typescript
export default defineConfig({
  test: {
    // Configurar paths de mocks
    alias: {
      '@mocks': path.resolve(__dirname, './tests/mocks'),
    },
    // Setup files para mocks globais
    setupFiles: ['./tests/setup.ts'],
  },
});
```

## Benefícios

1. **Código de produção limpo** - sem lógica de teste
2. **Testes isolados** - não dependem de APIs externas
3. **Testes rápidos** - sem latência de rede
4. **Testes determinísticos** - resultados consistentes
5. **Fácil manutenção** - mocks centralizados

