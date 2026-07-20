// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Extract OpenAPI spec from Fastify Swagger.
 *
 * This script creates a docs-only Fastify instance, registers the public route
 * groups, and exports a public OpenAPI contract to:
 * - ci/openapi-spec.json
 * - ci/openapi-spec.yaml
 */

import 'reflect-metadata';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CI_ROOT = path.resolve(__dirname, '..', '..');
const OPENAPI_JSON_PATH = path.join(CI_ROOT, 'openapi-spec.json');
const OPENAPI_YAML_PATH = path.join(CI_ROOT, 'openapi-spec.yaml');

type SwaggerLike = Record<string, unknown> & {
  openapi?: string;
  swagger?: string;
  info?: Record<string, unknown>;
  paths?: Record<string, unknown>;
  components?: Record<string, unknown>;
  servers?: Array<Record<string, unknown>>;
};

type RouteRegistration = {
  name: string;
  critical: boolean;
  register: () => Promise<void>;
};

function publicInfoDescription(): string {
  return [
    'Ailin Collective Intelligence API.',
    '',
    'Public contract for OpenAI-compatible, capability-based orchestration with governance, traceability, and tenant isolation.',
    '',
    'Core compatibility:',
    '- `/v1/chat/completions`, `/v1/models`, `/v1/embeddings`, `/v1/responses`',
    '- Bearer and API key authentication',
    '- Request/correlation ID propagation',
    '',
    'Platform extensions:',
    '- Capability-oriented routing (`/v1/capabilities/*`)',
    '- Provider capability discovery (`/v1/provider-capabilities`)',
    '- Realtime sessions (`/v1/realtime`)',
  ].join('\n');
}

function sanitizePublicMetadata(spec: SwaggerLike): void {
  spec.openapi = spec.openapi ?? '3.0.3';
  spec.info = spec.info ?? {};
  spec.info.title = (spec.info.title as string) || 'Ailin Collective Intelligence API';
  spec.info.version = (spec.info.version as string) || '1.0.0';
  spec.info.description = publicInfoDescription();
  spec.info.contact = {
    name: 'Ailin Team',
    email: 'support@ailin.one',
    url: 'https://ailin.one',
  };
  spec.info.license = {
    name: 'Proprietary',
    url: 'https://ailin.one',
  };

  // Public contract must not expose localhost targets.
  spec.servers = [
    {
      url: 'https://api.ailin.one',
      description: 'Production server',
    },
  ];
}

function removeNonVersionedAliases(spec: SwaggerLike): number {
  const paths = spec.paths ?? {};
  let removed = 0;

  for (const routePath of Object.keys(paths)) {
    if (routePath === '/.well-known/jwks.json') continue;
    if (routePath.startsWith('/v1/')) continue;

    const versionedPath = routePath === '/' ? '/v1' : `/v1${routePath}`;
    if (paths[versionedPath]) {
      delete paths[routePath];
      removed += 1;
    }
  }

  return removed;
}

function hideExplicitlyHiddenOperations(spec: SwaggerLike): string[] {
  const hidden: string[] = [];
  const paths = spec.paths ?? {};

  for (const [routePath, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;

    for (const [method, operation] of Object.entries(pathItem as Record<string, unknown>)) {
      if (!operation || typeof operation !== 'object') continue;
      const op = operation as Record<string, unknown>;
      const shouldHide = op.hide === true || op['x-hide'] === true;
      if (!shouldHide) continue;

      hidden.push(`${method.toUpperCase()} ${routePath}`);
      delete paths[routePath];
      break;
    }
  }

  return hidden;
}

async function registerAllRoutesForDocs(server: FastifyInstance): Promise<void> {
  const registrationResults = {
    registered: 0,
    skipped: 0,
    criticalFailures: [] as string[],
    skippedRoutes: [] as string[],
  };

  const registerRoute = async (item: RouteRegistration): Promise<void> => {
    try {
      await item.register();
      registrationResults.registered += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const line = `${item.name}: ${message}`;
      registrationResults.skipped += 1;
      registrationResults.skippedRoutes.push(line);
      if (item.critical) {
        registrationResults.criticalFailures.push(line);
      }
      console.log(`   [warn] skipped ${item.name}: ${message}`);
    }
  };

  console.log('   Registering routes for docs extraction...');

  // Minimal dependencies for route groups that require orchestration/provider context.
  let providerRegistry: unknown = null;
  let orchestrationEngine: unknown = null;

  try {
    const providerRegistryModule = await import('../src/providers/provider-registry.js');
    const { initializeProviderRegistry, setProviderRegistry } = providerRegistryModule as {
      initializeProviderRegistry: (providers: unknown[]) => Promise<unknown>;
      setProviderRegistry: (registry: unknown) => void;
    };
    providerRegistry = await initializeProviderRegistry([]);
    setProviderRegistry(providerRegistry);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`   [warn] provider registry initialization skipped: ${message}`);
  }

  try {
    const { OrchestrationEngine } = await import('../src/core/orchestration/orchestration-engine.js');
    orchestrationEngine = new OrchestrationEngine({
      providerRegistry: (providerRegistry ?? {}) as Record<string, unknown>,
      defaultStrategy: 'auto',
      enableAutoSelection: true,
      enableTriaging: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`   [warn] orchestration engine initialization skipped: ${message}`);
  }

  const routeGroups: RouteRegistration[] = [
    {
      name: 'auth routes',
      critical: true,
      register: async () => {
        const { authRoutesClean } = await import('../src/routes/auth/auth-routes-clean.js');
        await server.register(authRoutesClean);
      },
    },
    {
      name: 'user routes',
      critical: false,
      register: async () => {
        const { userRoutes } = await import('../src/routes/user/user-routes-clean.js');
        await userRoutes(server);
      },
    },
    {
      name: 'organization routes',
      critical: false,
      register: async () => {
        const { organizationRoutesClean } = await import(
          '../src/routes/organization/organization-routes-clean.js'
        );
        await server.register(organizationRoutesClean);
      },
    },
    {
      name: 'api keys routes',
      critical: false,
      register: async () => {
        const { apiKeysRoutesClean } = await import('../src/routes/api-keys/api-keys-routes-clean.js');
        await server.register(apiKeysRoutesClean);
      },
    },
    {
      name: 'models routes',
      critical: true,
      register: async () => {
        const { registerModelRoutes } = await import('../src/routes/models/models-routes.js');
        await registerModelRoutes(server, providerRegistry as never);
      },
    },
    {
      name: 'chat routes',
      critical: true,
      register: async () => {
        const { registerChatRoutes } = await import('../src/routes/chat/chat-routes.js');
        await registerChatRoutes(server, orchestrationEngine as never);
      },
    },
    {
      name: 'chat capability routes',
      critical: true,
      register: async () => {
        const { registerCapabilityRoutes } = await import('../src/routes/chat/chat-routes.js');
        await registerCapabilityRoutes(server, orchestrationEngine as never);
      },
    },
    {
      name: 'universal capabilities routes',
      critical: true,
      register: async () => {
        const { registerCapabilitiesRoutes } = await import(
          '../src/routes/capabilities/capabilities-routes.js'
        );
        await registerCapabilitiesRoutes(server);
      },
    },
    {
      name: 'embeddings routes',
      critical: true,
      register: async () => {
        const { registerEmbeddingsRoutes } = await import('../src/routes/embeddings/embeddings-routes.js');
        await registerEmbeddingsRoutes(server, providerRegistry as never);
      },
    },
    {
      name: 'responses routes',
      critical: true,
      register: async () => {
        const { registerResponsesRoutes } = await import('../src/routes/responses/responses-routes.js');
        await registerResponsesRoutes(server);
      },
    },
    {
      name: 'realtime routes',
      critical: true,
      register: async () => {
        const { registerRealtimeRoutes } = await import('../src/routes/realtime/realtime-routes.js');
        await registerRealtimeRoutes(server);
      },
    },
    {
      name: 'jwks routes',
      critical: true,
      register: async () => {
        const { registerJWKSRoutes } = await import('../src/routes/jwks-routes.js');
        await registerJWKSRoutes(server);
      },
    },
    {
      name: 'status routes',
      critical: false,
      register: async () => {
        const { registerStatusRoutes } = await import('../src/routes/status/status-routes.js');
        await server.register(registerStatusRoutes);
      },
    },
    {
      name: 'usage routes',
      critical: false,
      register: async () => {
        const { registerUsageRoutes } = await import('../src/routes/usage/usage-routes.js');
        await registerUsageRoutes(server);
      },
    },
    {
      name: 'files routes',
      critical: false,
      register: async () => {
        const { registerFilesRoutes } = await import('../src/routes/files/files-routes.js');
        await registerFilesRoutes(server);
      },
    },
    {
      name: 'tools routes',
      critical: false,
      register: async () => {
        const { registerToolsRoutes } = await import('../src/routes/tools/tools-routes.js');
        await registerToolsRoutes(server);
      },
    },
    {
      name: 'threads routes',
      critical: false,
      register: async () => {
        const { registerThreadsRoutes } = await import('../src/routes/threads/threads-routes.js');
        await registerThreadsRoutes(server);
      },
    },
    {
      name: 'vector stores routes',
      critical: false,
      register: async () => {
        const { registerVectorStoresRoutes } = await import(
          '../src/routes/vector-stores/vector-stores-routes.js'
        );
        await registerVectorStoresRoutes(server);
      },
    },
    {
      name: 'audio routes',
      critical: false,
      register: async () => {
        const { registerAudioRoutes } = await import('../src/routes/audio/audio-routes.js');
        await registerAudioRoutes(server);
      },
    },
    {
      name: 'images routes',
      critical: false,
      register: async () => {
        const { registerImagesRoutes } = await import('../src/routes/images/images-routes.js');
        await registerImagesRoutes(server);
      },
    },
    {
      name: 'videos routes',
      critical: false,
      register: async () => {
        const { registerVideosRoutes } = await import('../src/routes/videos/videos-routes.js');
        await registerVideosRoutes(server);
      },
    },
  ];

  for (const item of routeGroups) {
    await registerRoute(item);
  }

  console.log(
    `   Route groups: registered=${registrationResults.registered}, skipped=${registrationResults.skipped}`
  );

  if (registrationResults.criticalFailures.length > 0) {
    throw new Error(
      `Critical route registration failed:\n${registrationResults.criticalFailures
        .map((line) => `- ${line}`)
        .join('\n')}`
    );
  }
}

async function extractOpenAPIFromServer(): Promise<void> {
  console.log('Extracting OpenAPI spec from Fastify server...');

  let server: FastifyInstance | null = null;
  try {
    process.env.NODE_ENV = 'development';
    process.env.ENABLE_SWAGGER = 'true';
    process.env.PROMETHEUS_ENABLED = 'false';
    process.env.MODEL_CATALOG_AUTO_SYNC = 'false';
    process.env.SECRETS_PROVIDER_PRIMARY = 'env';
    process.env.CACHE_ENABLED = 'false';
    process.env.QUEUE_ENABLED = 'false';
    process.env.PORT = '0';
    process.env.JWT_SECRET = 'openapi-extraction-secret';
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';

    const { createServer } = await import('../src/server.js');
    server = await createServer();
    await registerAllRoutesForDocs(server);

    await server.ready();
    const serverWithSwagger = server as FastifyInstance & { swagger?: () => SwaggerLike };
    if (typeof serverWithSwagger.swagger !== 'function') {
      throw new Error('Fastify swagger method not found. Ensure @fastify/swagger is registered.');
    }

    const openapi = serverWithSwagger.swagger();
    if (!openapi || typeof openapi !== 'object') {
      throw new Error('Invalid OpenAPI object extracted from Fastify swagger.');
    }

    sanitizePublicMetadata(openapi);
    const hiddenEndpoints = hideExplicitlyHiddenOperations(openapi);
    const removedAliases = removeNonVersionedAliases(openapi);

    fs.writeFileSync(OPENAPI_JSON_PATH, `${JSON.stringify(openapi, null, 2)}\n`, 'utf8');
    const yamlModule = await import('yaml');
    fs.writeFileSync(OPENAPI_YAML_PATH, yamlModule.stringify(openapi), 'utf8');

    const pathCount = Object.keys(openapi.paths ?? {}).length;
    const schemaCount = Object.keys((openapi.components?.schemas as Record<string, unknown>) ?? {}).length;
    console.log(`OpenAPI extracted: paths=${pathCount}, schemas=${schemaCount}`);
    if (hiddenEndpoints.length > 0) {
      console.log(`Hidden operations removed from public contract (${hiddenEndpoints.length}).`);
    }
    if (removedAliases > 0) {
      console.log(`Removed non-versioned aliases from public contract (${removedAliases}).`);
    }
    console.log(`Wrote ${OPENAPI_JSON_PATH}`);
    console.log(`Wrote ${OPENAPI_YAML_PATH}`);
  } finally {
    if (server) {
      await server.close();
    }
  }
}

extractOpenAPIFromServer()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(`OpenAPI extraction failed: ${message}`);
    process.exit(1);
  });
