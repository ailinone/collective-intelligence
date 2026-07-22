// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Script para criar organizaÃ§Ãµes enterprise via API REST usando um arquivo JSON.
 *
 * CaracterÃ­sticas:
 * - Usa a API REST (mesmo fluxo dos clientes oficiais)
 * - Passa por autenticaÃ§Ã£o, validaÃ§Ãµes e auditoria existentes
 * - NÃ£o depende de variÃ¡veis de ambiente para dados sensÃ­veis
 *
 * Uso:
 *   pnpm tsx scripts/setup-org-via-api.ts ./scripts/setup-organizations.json
 *
 * O arquivo JSON deve seguir o formato:
 * {
 *   "apiUrl": "https://api.ailin.one",
 *   "organizations": [
 *     {
 *       "name": "Ailin One, Inc.",
 *       "ownerEmail": "admin@ailin.one",
 *       "ownerName": "Ailin Admin",
 *       "ownerPassword": "SenhaForteAqui",
 *       "tier": "enterprise",
 *       "trialDays": 30,
 *       "apiKeyName": "Ailin Admin Key"
 *     }
 *   ]
 * }
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

type TierLevel = 'enterprise';

interface OrganizationConfig {
  name: string;
  ownerEmail: string;
  ownerName: string;
  ownerPassword: string;
  tier: TierLevel;
  trialDays?: number;
  apiKeyName?: string;
}

interface SetupFile {
  apiUrl?: string;
  organizations: OrganizationConfig[];
}

interface AuthContext {
  accessToken: string;
  refreshToken?: string;
  user: {
    id: string;
    email: string;
    organizationId: string;
    roles?: string[];
  };
  loginMode: string;
}

interface SetupOutcome {
  organizationId: string;
  userId: string;
  accessToken: string;
  refreshToken?: string;
  loginMode: string;
  apiKey?: string;
}

let apiBaseUrl = (process.env.API_URL || 'https://api.ailin.one').replace(/\/$/, '');

function withBase(path: string): string {
  return `${apiBaseUrl}${path}`;
}

async function registerOrLogin(config: OrganizationConfig): Promise<AuthContext> {
  console.log(`[1/5] Registrando usuÃ¡rio: ${config.ownerEmail}`);

  try {
    const response = await fetch(withBase('/v1/auth/register'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: config.ownerEmail,
        password: config.ownerPassword,
        name: config.ownerName,
        organizationName: config.name,
      }),
    });

    if (response.ok) {
      console.log('[OK] UsuÃ¡rio registrado. Realizando login para obter tokens completos...');
      // Mesmo com registro bem-sucedido, efetua login para obter refresh token
      return await loginUser(config.ownerEmail, config.ownerPassword);
    }

    const error = await safeJson(response);
    const message = error?.message || error?.error || response.statusText;
    console.warn(`[AVISO] Registro nÃ£o concluÃ­do (${message}). Tentando login...`);
  } catch (error) {
    console.warn('[AVISO] Falha ao registrar usuÃ¡rio. Tentando login direto.', error);
  }

  // Login obrigatÃ³rio se o registro nÃ£o retornar com sucesso
  return await loginUser(config.ownerEmail, config.ownerPassword);
}

async function loginUser(email: string, password: string): Promise<AuthContext> {
  const response = await fetch(withBase('/v1/auth/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) {
    const error = await safeJson(response);
    const message = error?.message || error?.error || response.statusText;
    throw new Error(`Login falhou para ${email}: ${message}`);
  }

  const data = await response.json();
  if (!data?.tokens?.accessToken || !data?.user?.organizationId) {
    throw new Error(`Resposta de login invÃ¡lida para ${email}`);
  }

  return {
    accessToken: data.tokens.accessToken,
    refreshToken: data.tokens.refreshToken,
    user: {
      id: data.user.id,
      email: data.user.email,
      organizationId: data.user.organizationId,
      roles: data.user.roles,
    },
    loginMode: data.loginMode ?? 'password',
  };
}

async function updateOrganizationTier(
  organizationId: string,
  tier: TierLevel,
  token: string
): Promise<void> {
  console.log(`[2/5] Ajustando tier da organizaÃ§Ã£o para: ${tier}`);

  const response = await fetch(withBase(`/v1/organizations/${organizationId}`), {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ tier }),
  });

  if (!response.ok) {
    const error = await safeJson(response);
    const message = error?.message || response.statusText;
    throw new Error(`Falha ao atualizar tier da organizaÃ§Ã£o ${organizationId}: ${message}`);
  }
}

async function ensureEnterpriseSubscription(
  token: string,
  trialDays?: number
): Promise<void> {
  console.log('[3/5] Verificando assinaturas enterprise existentes...');

  const listResponse = await fetch(withBase('/v1/enterprise/billing/subscriptions'), {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  if (!listResponse.ok) {
    const error = await safeJson(listResponse);
    const message = error?.message || listResponse.statusText;
    throw new Error(`Falha ao listar assinaturas: ${message}`);
  }

  const listData = await listResponse.json();
  const subscriptions: Array<{ plan?: string; status?: string }> = listData?.subscriptions ?? [];
  const hasActiveEnterprise = subscriptions.some((item) => item.plan === 'enterprise' && item.status === 'active');

  if (hasActiveEnterprise) {
    console.log('[OK] OrganizaÃ§Ã£o jÃ¡ possui assinatura enterprise ativa.');
    return;
  }

  console.log(`[INFO] Nenhuma assinatura enterprise ativa encontrada. Criando nova (trial ${trialDays ?? 0} dias)...`);

  const createResponse = await fetch(withBase('/v1/enterprise/billing/subscriptions'), {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      plan: 'enterprise',
      billingCycle: 'monthly',
      amount: 0,
      currency: 'USD',
      trialDays,
      metadata: {
        source: 'admin_setup',
        setupDate: new Date().toISOString(),
      },
    }),
  });

  if (!createResponse.ok) {
    const error = await safeJson(createResponse);
    const message = error?.message || createResponse.statusText;
    console.warn(`[AVISO] Falha ao criar assinatura enterprise: ${message}`);
    return;
  }

  console.log('[OK] Assinatura enterprise criada.');
}

async function generateApiKey(
  token: string,
  name: string
): Promise<string> {
  console.log('[4/5] Gerando API key primÃ¡ria...');

  const response = await fetch(withBase('/v1/auth/api-keys'), {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name }),
  });

  if (!response.ok) {
    const error = await safeJson(response);
    const message = error?.message || response.statusText;
    throw new Error(`Falha ao gerar API key "${name}": ${message}`);
  }

  const data = await response.json();
  if (!data?.apiKey) {
    throw new Error('Resposta inesperada ao gerar API key (campo apiKey ausente).');
  }

  console.log('[OK] API key criada. Salve este valor com seguranÃ§a.');
  return data.apiKey;
}

async function safeJson(response: globalThis.Response): Promise<any | undefined> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

async function setupOrganizationViaAPI(config: OrganizationConfig): Promise<SetupOutcome> {
  console.log('\n========================================');
  console.log(`Setup de OrganizaÃ§Ã£o Enterprise: ${config.name}`);
  console.log('========================================');

  const auth = await registerOrLogin(config);
  const organizationId = auth.user.organizationId;

  await updateOrganizationTier(organizationId, config.tier, auth.accessToken);
  await ensureEnterpriseSubscription(auth.accessToken, config.trialDays);

  const apiKeyName = config.apiKeyName ?? `${config.name} Root Key`;
  let apiKey: string | undefined;
  try {
    apiKey = await generateApiKey(auth.accessToken, apiKeyName);
  } catch (error) {
    console.warn('[AVISO] NÃ£o foi possÃ­vel gerar API key automaticamente.', error);
  }

  console.log('========================================');
  console.log('âœ“ Setup concluÃ­do');
  console.log(`Organization ID: ${organizationId}`);
  console.log(`User ID: ${auth.user.id}`);
  console.log(`Login Mode: ${auth.loginMode}`);
  console.log('========================================\n');

  return {
    organizationId,
    userId: auth.user.id,
    accessToken: auth.accessToken,
    refreshToken: auth.refreshToken,
    loginMode: auth.loginMode,
    apiKey,
  };
}

async function loadConfigFile(configPath: string): Promise<SetupFile> {
  const resolvedPath = resolve(process.cwd(), configPath);
  const rawContent = await readFile(resolvedPath, 'utf-8');
  const parsed = JSON.parse(rawContent) as SetupFile;

  if (!parsed?.organizations || !Array.isArray(parsed.organizations) || parsed.organizations.length === 0) {
    throw new Error('Arquivo de configuraÃ§Ã£o invÃ¡lido: "organizations" deve ser um array com pelo menos um item.');
  }

  return parsed;
}

function maskCredential(value: string): string {
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function maskOutcome(outcome: SetupOutcome): Record<string, string | undefined> {
  return {
    organizationId: outcome.organizationId,
    userId: outcome.userId,
    accessToken: maskCredential(outcome.accessToken),
    refreshToken: outcome.refreshToken ? maskCredential(outcome.refreshToken) : undefined,
    loginMode: outcome.loginMode,
    apiKey: outcome.apiKey ? maskCredential(outcome.apiKey) : undefined,
  };
}

if (require.main === module) {
  const configPathArg = process.argv[2] ?? process.env.SETUP_CONFIG_PATH;

  if (!configPathArg) {
    console.error('Ã‰ necessÃ¡rio informar o caminho do arquivo JSON de configuraÃ§Ã£o.');
    console.error('Exemplo: pnpm tsx scripts/setup-org-via-api.ts ./scripts/setup-organizations.json');
    process.exit(1);
  }

  loadConfigFile(configPathArg)
    .then(async (fileConfig) => {
      apiBaseUrl = (fileConfig.apiUrl || apiBaseUrl).replace(/\/$/, '');
      console.log(`[INFO] Usando API base: ${apiBaseUrl}`);

      const results: Record<string, SetupOutcome> = {};

      for (const orgConfig of fileConfig.organizations) {
        try {
          const outcome = await setupOrganizationViaAPI(orgConfig);
          results[orgConfig.ownerEmail] = outcome;
        } catch (error) {
          console.error(`âœ— Falha ao configurar ${orgConfig.name}:`, error);
          throw error;
        }
      }

      const outputPath = resolve(
        process.cwd(),
        process.env.SETUP_RESULTS_OUTPUT_PATH || `setup-org-results-${Date.now()}.json`
      );
      await writeFile(outputPath, JSON.stringify(results, null, 2), { mode: 0o600 });

      const maskedResults: Record<string, Record<string, string | undefined>> = {};
      for (const [email, outcome] of Object.entries(results)) {
        maskedResults[email] = maskOutcome(outcome);
      }

      console.log('\n========================================');
      console.log('Resumo dos acessos gerados (credenciais mascaradas abaixo):');
      console.log('========================================');
      console.log(JSON.stringify(maskedResults, null, 2));
      console.log('========================================');
      console.log(`[INFO] Credenciais completas salvas em: ${outputPath} (permissoes 600)`);
      console.log('[AVISO] Mova este arquivo para um local seguro e apague-o do disco apos o uso.\n');
      console.log('âœ“ Todas as organizaÃ§Ãµes foram configuradas com sucesso!');
    })
    .catch((error) => {
      console.error('\nâœ— Falha durante o processo de setup:', error);
      process.exit(1);
    });
}

export { setupOrganizationViaAPI };


