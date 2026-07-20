// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const JSON_PATH = path.resolve('openapi-spec.json');
const YAML_PATH = path.resolve('openapi-spec.yaml');

// Paths that ci-api serves but that MUST NOT appear in the public contract.
// The contract enforcer strips these from the extracted spec.
//
// Note (2026-04-27): `/console/api/v1/jwks` was historically classified as
// internal here, but it is in fact an *operational* JWKS endpoint that mirrors
// `/.well-known/jwks.json` (see `OPERATIONAL_ROUTES` in
// `api/src/config/operational-routes.ts:42` and `index.ts:781`). Stripping it
// here caused the gateway's allowlist generator to skip it, which translated to
// a 4xx at the public edge for every probe that didn't carry the right
// upstream-internal hint. Removed from this set; re-added under
// REQUIRED_PATHS below so the contract is explicit.
const INTERNAL_OR_SENSITIVE_PATHS = new Set([
  '/health',
  '/internal/jwks/status',
  '/health/startup',
  '/health/live',
  '/health/ready',
  '/metrics',
  '/v1/auth/test-db',
  '/v1/billing/webhooks/stripe',
]);

const REQUIRED_PATHS = {
  '/.well-known/jwks.json': {
    get: {
      tags: ['Authentication'],
      summary: 'Retrieve JWKS public keys',
      description:
        'Returns public JSON Web Keys used to validate signed JWTs. This endpoint is public and cache-friendly.',
      operationId: 'getWellKnownJwks',
      security: [],
      responses: {
        200: {
          description: 'JWKS retrieved successfully.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['keys'],
                properties: {
                  keys: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        kty: { type: 'string' },
                        use: { type: 'string' },
                        kid: { type: 'string' },
                        alg: { type: 'string' },
                        n: { type: 'string' },
                        e: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
          headers: {
            'Cache-Control': {
              description: 'Caching policy for JWKS key material.',
              schema: { type: 'string' },
            },
            'X-Request-Id': {
              description: 'Unique request identifier for end-to-end tracing.',
              schema: { type: 'string' },
            },
            'X-Correlation-Id': {
              description: 'Correlation identifier propagated across internal services.',
              schema: { type: 'string' },
            },
          },
        },
        503: {
          description: 'JWKS service unavailable.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  error: { type: 'string' },
                  message: { type: 'string' },
                },
              },
            },
          },
        },
      },
      'x-collective-intelligence': {
        contributionType: 'signal-consumer',
        artifactsProduced: ['traces'],
        artifactsConsumed: ['request_context'],
        aggregationOrSynthesis:
          'Publishes verifiable key material for identity and signature validation workflows.',
        feedbackLoops:
          'Key access telemetry supports audit, key-rotation monitoring, and reliability analytics.',
        provenanceAndAttribution:
          'Associates key retrieval events with request/correlation identifiers for traceability.',
        governanceAndPrivacyBoundaries:
          'Only public key material is exposed; private keys remain internal.',
        failureModesAndCiImpact:
          'JWKS unavailability impacts token verification and trust-chain continuity.',
      },
    },
  },
  '/v1/provider-capabilities': {
    get: {
      tags: ['Models', 'Capabilities'],
      summary: 'Retrieve provider capabilities',
      description:
        'Returns providers, model inventories, availability snapshots, and capability aggregates for routing and governance.',
      operationId: 'getProviderCapabilities',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      responses: {
        200: {
          description: 'Provider capabilities retrieved successfully.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  providers: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        name: { type: 'string' },
                        displayName: { type: 'string' },
                        status: { type: 'string' },
                        modelCount: { type: 'number' },
                        availability: {
                          type: 'object',
                          properties: {
                            status: { type: 'string' },
                            reason: { type: 'string' },
                            missingEnv: { type: 'array', items: { type: 'string' } },
                            lastUpdated: { type: 'string' },
                          },
                        },
                        models: {
                          type: 'array',
                          items: {
                            type: 'object',
                            properties: {
                              id: { type: 'string' },
                              name: { type: 'string' },
                              capabilities: { type: 'array', items: { type: 'string' } },
                              contextWindow: { type: 'number' },
                              inputCostPer1k: { type: 'number' },
                              outputCostPer1k: { type: 'number' },
                            },
                          },
                        },
                      },
                    },
                  },
                  summary: {
                    type: 'object',
                    properties: {
                      totalProviders: { type: 'number' },
                      totalModels: { type: 'number' },
                      capabilityCounts: {
                        type: 'object',
                        additionalProperties: { type: 'number' },
                      },
                      availability: {
                        type: 'object',
                        additionalProperties: true,
                      },
                    },
                  },
                },
              },
            },
          },
          headers: {
            'X-Request-Id': {
              description: 'Unique request identifier for end-to-end tracing.',
              schema: { type: 'string' },
            },
            'X-Correlation-Id': {
              description: 'Correlation identifier propagated across internal services.',
              schema: { type: 'string' },
            },
          },
        },
      },
      'x-collective-intelligence': {
        contributionType: 'signal-consumer',
        artifactsProduced: ['traces'],
        artifactsConsumed: ['policies', 'org_settings', 'quotas', 'request_context'],
        aggregationOrSynthesis:
          'Combines provider inventory with capability and operability signals to produce deterministic routing insights.',
        feedbackLoops:
          'Feeds provider availability and quality metrics into selection and policy refinement loops.',
        provenanceAndAttribution:
          'Associates tenant, provider, and request provenance with requestId/correlationId.',
        governanceAndPrivacyBoundaries:
          'Applies tenant isolation and policy enforcement to provider visibility and exposure.',
        failureModesAndCiImpact:
          'Missing or stale provider capability data can reduce routing quality and resiliency.',
      },
    },
  },
  '/v1/analyze-requirements': {
    post: {
      tags: ['Chat', 'Advanced'],
      summary: 'Analyze routing requirements',
      description:
        'Analyzes message intent and returns capability requirements, triage hints, and model-selection metadata.',
      operationId: 'createAnalyzeRequirements',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['messages'],
              properties: {
                model: { type: 'string' },
                messages: {
                  type: 'array',
                  items: { type: 'object', additionalProperties: true },
                },
                tools: {
                  type: 'array',
                  items: { type: 'object', additionalProperties: true },
                },
              },
            },
          },
        },
      },
      responses: {
        200: {
          description: 'Requirements analysis completed successfully.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['capability', 'operational', 'inventory'],
                properties: {
                  capability: { type: 'string' },
                  aliasResolvedFrom: { type: 'string' },
                  operational: { type: 'boolean' },
                  maturity: { type: 'string' },
                  executionPath: { type: 'array', items: { type: 'string' } },
                  requiredCapabilities: { type: 'array', items: { type: 'string' } },
                  support: {
                    type: 'object',
                    properties: {
                      execute: { type: 'boolean' },
                      stream: { type: 'boolean' },
                    },
                  },
                  inventory: {
                    type: 'object',
                    properties: {
                      discovered: { type: 'integer' },
                      runnable: { type: 'integer' },
                      nonOperational: { type: 'integer' },
                      modelCapabilities: { type: 'array', items: { type: 'string' } },
                    },
                  },
                  topNonOperationalReasons: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        reason: { type: 'string' },
                        count: { type: 'integer' },
                      },
                    },
                  },
                  dependencies: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        dependency: { type: 'string' },
                        affectedModels: { type: 'integer' },
                      },
                    },
                  },
                },
              },
            },
          },
          headers: {
            'X-Request-Id': {
              description: 'Unique request identifier for end-to-end tracing.',
              schema: { type: 'string' },
            },
            'X-Correlation-Id': {
              description: 'Correlation identifier propagated across internal services.',
              schema: { type: 'string' },
            },
          },
        },
      },
      'x-collective-intelligence': {
        contributionType: 'signal-producer',
        artifactsProduced: ['traces'],
        artifactsConsumed: ['policies', 'org_settings', 'quotas'],
        aggregationOrSynthesis:
          'Synthesizes request intent and routing constraints into deterministic capability requirements.',
        feedbackLoops:
          'Feeds analysis quality outcomes into model selection and policy refinement loops.',
        provenanceAndAttribution:
          'Associates analysis decisions with requestId/correlationId for attribution.',
        governanceAndPrivacyBoundaries:
          'Applies tenant boundaries and policy controls prior to route recommendation.',
        failureModesAndCiImpact:
          'Low-confidence analysis can degrade model selection quality and orchestration efficiency.',
      },
    },
  },
  '/v1/chat/completions/intelligent': {
    post: {
      tags: ['Chat', 'Advanced'],
      summary: 'Create intelligent chat completion',
      description:
        'Runs chat completion with adaptive model selection, fallback orchestration, and execution metadata.',
      operationId: 'createChatCompletionsIntelligent',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['messages'],
              properties: {
                model: { type: 'string' },
                messages: {
                  type: 'array',
                  items: { type: 'object', additionalProperties: true },
                },
                stream: { type: 'boolean', default: false },
                temperature: { type: 'number', minimum: 0, maximum: 2 },
                max_tokens: { type: 'integer', minimum: 1 },
              },
            },
          },
        },
      },
      responses: {
        200: {
          description: 'Intelligent completion created successfully.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: true,
              },
            },
          },
          headers: {
            'X-Request-Id': {
              description: 'Unique request identifier for end-to-end tracing.',
              schema: { type: 'string' },
            },
            'X-Correlation-Id': {
              description: 'Correlation identifier propagated across internal services.',
              schema: { type: 'string' },
            },
          },
        },
      },
      'x-collective-intelligence': {
        contributionType: 'coordinator',
        artifactsProduced: ['traces'],
        artifactsConsumed: ['policies', 'org_settings', 'quotas'],
        aggregationOrSynthesis:
          'Coordinates multi-provider fallback and ranking to maximize response quality under constraints.',
        feedbackLoops:
          'Feeds attempt outcomes and quality scores into adaptive strategy selection.',
        provenanceAndAttribution:
          'Captures provider/model attribution with requestId/correlationId for each execution.',
        governanceAndPrivacyBoundaries:
          'Enforces tenant scope, policy gates, and quota constraints across orchestration attempts.',
        failureModesAndCiImpact:
          'Provider degradation or policy mismatch may reduce success rate and increase latency.',
      },
    },
  },
  '/v1/realtime': {
    get: {
      tags: ['Realtime'],
      summary: 'Open realtime websocket session',
      description:
        'Upgrades the request to a realtime websocket session for bidirectional text/audio streaming with interruption support.',
      operationId: 'getRealtime',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      parameters: [
        {
          name: 'model',
          in: 'query',
          required: false,
          schema: { type: 'string' },
          description: 'Model ID or "auto" for dynamic provider/model selection.',
        },
      ],
      responses: {
        101: {
          description: 'WebSocket upgrade accepted.',
          headers: {
            'X-Request-Id': {
              description: 'Unique request identifier for end-to-end tracing.',
              schema: { type: 'string' },
            },
            'X-Correlation-Id': {
              description: 'Correlation identifier propagated across internal services.',
              schema: { type: 'string' },
            },
          },
        },
        200: {
          description: 'Realtime endpoint metadata payload.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: true,
              },
            },
          },
          headers: {
            'X-Request-Id': {
              description: 'Unique request identifier for end-to-end tracing.',
              schema: { type: 'string' },
            },
            'X-Correlation-Id': {
              description: 'Correlation identifier propagated across internal services.',
              schema: { type: 'string' },
            },
          },
        },
      },
      'x-websocket': true,
      'x-collective-intelligence': {
        contributionType: 'coordinator',
        artifactsProduced: ['traces'],
        artifactsConsumed: ['policies', 'org_settings', 'quotas'],
        aggregationOrSynthesis:
          'Coordinates realtime multi-provider sessions under policy and quota constraints.',
        feedbackLoops:
          'Streams runtime health and quality signals into adaptive routing and operability feedback loops.',
        provenanceAndAttribution:
          'Maintains per-session attribution with request/correlation identifiers.',
        governanceAndPrivacyBoundaries:
          'Enforces tenant isolation, policy gates, and scoped observability for realtime traffic.',
        failureModesAndCiImpact:
          'Provider or session instability can degrade multimodal continuity and response quality.',
      },
    },
  },
  '/v1/capabilities': {
    get: {
      tags: ['Capabilities'],
      summary: 'List canonical capabilities',
      description:
        'Returns the canonical capability registry exposed by universal capability routes and the execute/stream maturity state.',
      operationId: 'getCapabilities',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      responses: {
        200: {
          description: 'Capabilities listed successfully.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  object: { type: 'string', enum: ['list'] },
                  data: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                          id: { type: 'string' },
                          aliases: { type: 'array', items: { type: 'string' } },
                          supportsExecute: { type: 'boolean' },
                          supportsStream: { type: 'boolean' },
                          maturity: { type: 'string' },
                          executionPath: { type: 'array', items: { type: 'string' } },
                          requiredCapabilities: { type: 'array', items: { type: 'string' } },
                          dependencies: { type: 'array', items: { type: 'string' } },
                        },
                      },
                    },
                  },
              },
            },
          },
          headers: {
            'X-Request-Id': {
              description: 'Unique request identifier for end-to-end tracing.',
              schema: { type: 'string' },
            },
            'X-Correlation-Id': {
              description: 'Correlation identifier propagated across internal services.',
              schema: { type: 'string' },
            },
          },
        },
      },
      'x-collective-intelligence': {
        contributionType: 'signal-consumer',
        artifactsProduced: ['traces'],
        artifactsConsumed: ['policies', 'org_settings', 'request_context'],
        aggregationOrSynthesis:
          'Normalizes capability vocabulary to support deterministic orchestration and governance.',
        feedbackLoops:
          'Capability usage and operability signals refine route-level orchestration behavior.',
        provenanceAndAttribution:
          'Associates capability discovery requests with tenant-scoped provenance metadata.',
        governanceAndPrivacyBoundaries:
          'Exposes capabilities with tenant-safe controls and policy-constrained visibility.',
        failureModesAndCiImpact:
          'Inaccurate capability metadata can reduce endpoint compatibility and model routing quality.',
      },
    },
  },
  // Operational endpoints that MUST be in the public contract so the gateway
  // allowlist generator includes them. Mirrors the api-side `OPERATIONAL_ROUTES`
  // (api/src/config/operational-routes.ts). Adding an operational route on the
  // api side without updating either this file or the spec extractor leaves the
  // gateway's public-paths gate closed for it (HTTP 4xx at the edge), even
  // though the api itself is configured to bypass auth/rate-limit/quota.
  // The api-side boot guard `assertOperationalRouteInvariant` cannot reach
  // across the process+repo boundary; this entry IS that contract.
  '/v1/hcra/health': {
    get: {
      tags: ['Status'],
      summary: 'HCRA search-stack liveness probe',
      description:
        'Operational endpoint. Returns 200 when the HCRA search stack is reachable. Public, unauthenticated, rate-limit-bypassed, quota-bypassed (ADR-022).',
      operationId: 'getHcraHealth',
      security: [],
      responses: {
        200: {
          description: 'HCRA search stack is reachable.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', enum: ['ok'] },
                  component: { type: 'string', example: 'hcra-search' },
                  uptimeSeconds: { type: 'number' },
                },
              },
            },
          },
          headers: {
            'X-Request-Id': {
              description: 'Unique request identifier for end-to-end tracing.',
              schema: { type: 'string' },
            },
            'X-Correlation-Id': {
              description: 'Correlation identifier propagated across internal services.',
              schema: { type: 'string' },
            },
          },
        },
        503: {
          description: 'HCRA search stack is unavailable.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  error: { type: 'string' },
                  message: { type: 'string' },
                },
              },
            },
          },
        },
      },
      'x-collective-intelligence': {
        contributionType: 'evaluation',
        artifactsProduced: ['traces'],
        artifactsConsumed: ['request_context'],
        aggregationOrSynthesis:
          'Publishes search-stack liveness signal for orchestration and observability layers.',
        feedbackLoops:
          'Probe failures feed circuit-breaker and self-healing routines.',
        provenanceAndAttribution:
          'Liveness checks carry request/correlation identifiers for end-to-end audit.',
        governanceAndPrivacyBoundaries:
          'Exposes only liveness state; never tenant or capability metadata.',
        failureModesAndCiImpact:
          'Stale or missing liveness signal hides search-stack degradations from probes and dashboards.',
      },
    },
  },
  '/console/api/v1/jwks': {
    get: {
      tags: ['Authentication'],
      summary: 'Retrieve console JWKS public keys',
      description:
        'Operational endpoint. Mirrors `/.well-known/jwks.json` for accounts/console-tenant signature verification. Public, unauthenticated.',
      operationId: 'getConsoleApiV1Jwks',
      security: [],
      responses: {
        200: {
          description: 'JWKS retrieved successfully.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['keys'],
                properties: {
                  keys: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        kty: { type: 'string' },
                        use: { type: 'string' },
                        kid: { type: 'string' },
                        alg: { type: 'string' },
                        n: { type: 'string' },
                        e: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
          headers: {
            'Cache-Control': {
              description: 'Caching policy for JWKS key material.',
              schema: { type: 'string' },
            },
            'X-Request-Id': {
              description: 'Unique request identifier for end-to-end tracing.',
              schema: { type: 'string' },
            },
            'X-Correlation-Id': {
              description: 'Correlation identifier propagated across internal services.',
              schema: { type: 'string' },
            },
          },
        },
        503: {
          description: 'JWKS service unavailable.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  error: { type: 'string' },
                  message: { type: 'string' },
                },
              },
            },
          },
        },
      },
      'x-collective-intelligence': {
        contributionType: 'signal-consumer',
        artifactsProduced: ['traces'],
        artifactsConsumed: ['request_context'],
        aggregationOrSynthesis:
          'Mirrors well-known JWKS material for the accounts/console signature-verification path.',
        feedbackLoops:
          'Key access telemetry supports audit, key-rotation monitoring, and reliability analytics.',
        provenanceAndAttribution:
          'Associates key retrieval events with request/correlation identifiers for traceability.',
        governanceAndPrivacyBoundaries:
          'Only public key material is exposed; private keys remain internal.',
        failureModesAndCiImpact:
          'JWKS unavailability impacts token verification and trust-chain continuity.',
      },
    },
  },
};

const REQUIRED_CAPABILITY_PATHS = {
  '/v1/capabilities/{capability}/execute': {
    post: {
      tags: ['Capabilities'],
      summary: 'Execute capability',
      description:
        'Executes a capability through the universal capability dispatcher and returns normalized capability output.',
      operationId: 'postCapabilitiesByCapabilityExecute',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      parameters: [
        {
          name: 'capability',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
      ],
       requestBody: {
         required: false,
         content: {
           'application/json': {
             schema: {
                type: 'object',
                properties: {
                  input: {
                    oneOf: [{ type: 'object', additionalProperties: true }, { type: 'string' }],
                  },
                  messages: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: true,
                    },
                  },
                  options: {
                    type: 'object',
                    additionalProperties: true,
                  },
                  execution: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      sandboxPreference: {
                        oneOf: [
                          { type: 'string' },
                          { type: 'array', items: { type: 'string' } },
                        ],
                      },
                      maxCost: { type: 'number', minimum: 0 },
                      qualityTarget: { type: 'number', minimum: 0, maximum: 1 },
                      timeoutMs: { type: 'integer', minimum: 1 },
                      allowFallback: { type: 'boolean' },
                    },
                  },
                },
                additionalProperties: true,
              },
            },
          },
        },
      responses: {
        200: {
          description: 'Capability executed successfully.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['object', 'capability', 'data', '_ailin'],
                properties: {
                  object: { type: 'string', enum: ['capability.result'] },
                  capability: { type: 'string' },
                  data: {
                    oneOf: [{ type: 'object', additionalProperties: true }, { type: 'array' }, { type: 'string' }],
                  },
                  _ailin: {
                    type: 'object',
                    required: ['resolved_capability', 'execution_path', 'fallback_used', 'duration_ms', 'request_id'],
                    properties: {
                      resolved_capability: { type: 'string' },
                      resolved_provider: { type: 'string', nullable: true },
                      resolved_model: { type: 'string', nullable: true },
                      execution_path: { type: 'string' },
                      fallback_used: { type: 'boolean' },
                      duration_ms: { type: 'number' },
                      request_id: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
          headers: {
            'X-Request-Id': {
              description: 'Unique request identifier for end-to-end tracing.',
              schema: { type: 'string' },
            },
            'X-Correlation-Id': {
              description: 'Correlation identifier propagated across internal services.',
              schema: { type: 'string' },
            },
          },
        },
      },
      'x-collective-intelligence': {
        contributionType: 'coordinator',
        artifactsProduced: ['traces'],
        artifactsConsumed: ['policies', 'org_settings', 'quotas', 'request_context'],
        aggregationOrSynthesis:
          'Dispatches capability intent into provider/model execution while preserving deterministic API semantics.',
        feedbackLoops:
          'Feeds capability execution quality and operability outcomes into adaptive orchestration decisions.',
        provenanceAndAttribution:
          'Captures endpoint and model provenance with requestId/correlationId for full traceability.',
        governanceAndPrivacyBoundaries:
          'Applies policy gates and tenant boundaries before execution fan-out.',
        failureModesAndCiImpact:
          'Unsupported or degraded capability paths can reduce reliability and orchestration quality.',
      },
    },
  },
  '/v1/capabilities/{capability}/stream': {
    post: {
      tags: ['Capabilities'],
      summary: 'Stream capability',
      description:
        'Attempts streaming execution for a capability and returns explicit non-operational signaling when stream mode is unavailable.',
      operationId: 'postCapabilitiesByCapabilityStream',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      parameters: [
        {
          name: 'capability',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
      ],
       requestBody: {
         required: false,
         content: {
           'application/json': {
             schema: {
                type: 'object',
                properties: {
                  messages: {
                    type: 'array',
                    items: { type: 'object', additionalProperties: true },
                  },
                  input: {
                    oneOf: [{ type: 'string' }, { type: 'object', additionalProperties: true }],
                  },
                },
                additionalProperties: true,
              },
            },
          },
        },
      responses: {
        200: {
          description: 'Streaming response started successfully.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  object: { type: 'string' },
                  id: { type: 'string' },
                  choices: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: true,
                    },
                  },
                },
                additionalProperties: true,
              },
            },
          },
        },
      },
      'x-collective-intelligence': {
        contributionType: 'coordinator',
        artifactsProduced: ['traces'],
        artifactsConsumed: ['policies', 'org_settings', 'quotas'],
        aggregationOrSynthesis:
          'Coordinates stream-capable routes for compatible capabilities with explicit fallback semantics.',
        feedbackLoops:
          'Stream quality signals feed capability operability and route adaptation loops.',
        provenanceAndAttribution:
          'Maintains stream attribution across capability and provider layers.',
        governanceAndPrivacyBoundaries:
          'Enforces auth, tenant scope, and policy checks before stream activation.',
        failureModesAndCiImpact:
          'Unavailable stream support can increase latency and reduce conversational continuity.',
      },
    },
  },
  '/v1/capabilities/{capability}/health': {
    get: {
      tags: ['Capabilities'],
      summary: 'Check capability health',
      description:
        'Returns capability operability, discovered/runnable inventory, and non-operational reason analytics.',
      operationId: 'getCapabilitiesByCapabilityHealth',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      parameters: [
        {
          name: 'capability',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
      ],
      responses: {
        200: {
          description: 'Capability health report generated successfully.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: true,
              },
            },
          },
          headers: {
            'X-Request-Id': {
              description: 'Unique request identifier for end-to-end tracing.',
              schema: { type: 'string' },
            },
            'X-Correlation-Id': {
              description: 'Correlation identifier propagated across internal services.',
              schema: { type: 'string' },
            },
          },
        },
      },
      'x-collective-intelligence': {
        contributionType: 'evaluation',
        artifactsProduced: ['traces'],
        artifactsConsumed: ['policies', 'org_settings', 'quotas', 'request_context'],
        aggregationOrSynthesis:
          'Aggregates capability operability signals across discovered providers and models.',
        feedbackLoops:
          'Health results drive fallback and capability readiness improvements.',
        provenanceAndAttribution:
          'Publishes capability health with tenant-aware provenance metadata.',
        governanceAndPrivacyBoundaries:
          'Restricts capability health visibility by auth scope and tenant context.',
        failureModesAndCiImpact:
          'Stale health insight can cause invalid routing and elevated runtime failures.',
      },
    },
  },
};

const ERROR_REFS = {
  400: '#/components/responses/BadRequest',
  401: '#/components/responses/Unauthorized',
  403: '#/components/responses/Forbidden',
  404: '#/components/responses/NotFound',
  409: '#/components/responses/Conflict',
  422: '#/components/responses/UnprocessableEntity',
  429: '#/components/responses/TooManyRequests',
  500: '#/components/responses/InternalServerError',
};
const OPERATION_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];

const OBSERVABILITY_HEADERS = {
  'X-Request-Id': {
    description: 'Unique request identifier for end-to-end tracing.',
    schema: { type: 'string' },
  },
  'X-Correlation-Id': {
    description: 'Correlation identifier propagated across internal services.',
    schema: { type: 'string' },
  },
};

function loadSpec() {
  return JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
}

function normalizeSecurityRequirementArray(security) {
  if (!Array.isArray(security)) return security;

  return security.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;

    const normalized = {};
    for (const [scheme, scopes] of Object.entries(entry)) {
      const nextScheme = scheme === 'apiKey' ? 'apiKeyAuth' : scheme;
      if (!Object.prototype.hasOwnProperty.call(normalized, nextScheme)) {
        normalized[nextScheme] = Array.isArray(scopes) ? scopes : [];
      }
    }
    return normalized;
  });
}

function normalizeSecurityAliases(spec) {
  if (!spec || typeof spec !== 'object') return;

  spec.security = normalizeSecurityRequirementArray(spec.security);

  for (const pathItem of Object.values(spec.paths || {})) {
    if (!pathItem || typeof pathItem !== 'object') continue;

    if (Array.isArray(pathItem.security)) {
      pathItem.security = normalizeSecurityRequirementArray(pathItem.security);
    }

    for (const method of OPERATION_METHODS) {
      const operation = pathItem[method];
      if (!operation || typeof operation !== 'object') continue;
      if (!Array.isArray(operation.security)) continue;
      operation.security = normalizeSecurityRequirementArray(operation.security);
    }
  }
}

function ensureContractComponents(spec) {
  spec.components = spec.components || {};
  spec.components.securitySchemes = spec.components.securitySchemes || {};
  spec.components.responses = spec.components.responses || {};
  spec.components.schemas = spec.components.schemas || {};

  spec.components.securitySchemes.bearerAuth = {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
  };
  spec.components.securitySchemes.apiKeyAuth = {
    type: 'apiKey',
    in: 'header',
    name: 'X-API-Key',
  };
  // Canonicalize API key scheme name and remove legacy duplicate key.
  delete spec.components.securitySchemes.apiKey;

  const makeResponse = (description, code) => ({
    description,
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/ErrorResponse' },
      },
    },
    headers: {
      ...OBSERVABILITY_HEADERS,
    },
    'x-error-code': code,
  });

  spec.components.responses.BadRequest = makeResponse('Bad request', 'bad_request');
  spec.components.responses.Unauthorized = makeResponse('Unauthorized', 'unauthorized');
  spec.components.responses.Forbidden = makeResponse('Forbidden', 'forbidden');
  spec.components.responses.NotFound = makeResponse('Resource not found', 'not_found');
  spec.components.responses.Conflict = makeResponse('Conflict', 'conflict');
  spec.components.responses.UnprocessableEntity = makeResponse(
    'Unprocessable entity',
    'unprocessable_entity'
  );
  spec.components.responses.TooManyRequests = makeResponse(
    'Too many requests',
    'rate_limit_exceeded'
  );
  spec.components.responses.InternalServerError = makeResponse(
    'Internal server error',
    'internal_error'
  );

  spec.components.schemas.ErrorResponse = {
    type: 'object',
    required: ['error', 'requestId', 'correlationId', 'timestamp'],
    properties: {
      error: {
        type: 'object',
        required: ['code', 'message'],
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
          type: { type: 'string' },
          param: { type: 'string' },
        },
      },
      requestId: { type: 'string' },
      correlationId: { type: 'string' },
      timestamp: { type: 'string', format: 'date-time' },
    },
  };

  spec.security = [{ bearerAuth: [] }, { apiKeyAuth: [] }];
}

function capitalize(value) {
  return value.length > 0 ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function makeOperationId(method, routePath, usedIds) {
  const baseTokens = routePath
    .replace(/^\/v1\//, '')
    .replace(/^\//, '')
    .split('/')
    .filter(Boolean)
    .flatMap((segment) => {
      if (segment.startsWith('{') && segment.endsWith('}')) {
        return [`By${capitalize(segment.slice(1, -1).replace(/[^a-zA-Z0-9]/g, ''))}`];
      }
      const cleaned = segment.replace(/[^a-zA-Z0-9]/g, '');
      return cleaned ? [capitalize(cleaned)] : [];
    });
  const base = `${method}${baseTokens.join('') || 'Root'}`;
  if (!usedIds.has(base)) {
    usedIds.add(base);
    return base;
  }
  let i = 2;
  while (usedIds.has(`${base}${i}`)) i += 1;
  const candidate = `${base}${i}`;
  usedIds.add(candidate);
  return candidate;
}

function ensureOperationIds(spec) {
  const usedIds = new Set();
  for (const pathItem of Object.values(spec.paths || {})) {
    for (const method of OPERATION_METHODS) {
      const operation = pathItem?.[method];
      if (!operation || typeof operation !== 'object') continue;
      if (typeof operation.operationId === 'string' && operation.operationId.trim().length > 0) {
        usedIds.add(operation.operationId);
      }
    }
  }

  for (const [routePath, pathItem] of Object.entries(spec.paths || {})) {
    for (const method of OPERATION_METHODS) {
      const operation = pathItem?.[method];
      if (!operation || typeof operation !== 'object') continue;
      if (typeof operation.operationId === 'string' && operation.operationId.trim().length > 0) {
        continue;
      }
      operation.operationId = makeOperationId(method, routePath, usedIds);
    }
  }
}

function ensureInfoMetadata(spec) {
  spec.openapi = '3.0.3';
  spec.info = spec.info || {};
  spec.info.title = spec.info.title || 'Ailin Collective Intelligence API';
  spec.info.version = spec.info.version || '1.0.0';
  spec.info.description =
    'Ailin CI API. OpenAI-compatible execution with multi-provider orchestration, governance, traceability, and enterprise controls.';
  spec.info.contact = spec.info.contact || {
    name: 'Ailin Team',
    email: 'support@ailin.one',
    url: 'https://ailin.one',
  };
  spec.info.license = {
    name: 'Proprietary',
    url: 'https://ailin.one',
  };
}

function ensureServerPolicy(spec) {
  spec.servers = [
    {
      url: 'https://api.ailin.one',
      description: 'Production server',
    },
  ];
}

function removeNonVersionedAliases(spec) {
  if (!spec.paths || typeof spec.paths !== 'object') return 0;

  let removed = 0;
  for (const routePath of Object.keys(spec.paths)) {
    if (routePath === '/.well-known/jwks.json') continue;
    if (routePath.startsWith('/v1/')) continue;

    const versionedPath = routePath === '/' ? '/v1' : `/v1${routePath}`;
    if (spec.paths[versionedPath]) {
      delete spec.paths[routePath];
      removed += 1;
    }
  }

  return removed;
}

function ensurePathMove(spec, fromPath, toPath) {
  if (spec.paths?.[fromPath] && !spec.paths?.[toPath]) {
    spec.paths[toPath] = spec.paths[fromPath];
    delete spec.paths[fromPath];
  }
}

function ensureErrorResponses(operation) {
  operation.responses = operation.responses || {};
  for (const [status, ref] of Object.entries(ERROR_REFS)) {
    if (!operation.responses[status]) {
      operation.responses[status] = { $ref: ref };
    }
  }
}

function ensureResponseContentAndHeaders(response) {
  if (!response || typeof response !== 'object') return;
  if (!response.content) {
    response.content = {
      'application/json': {
        schema: {
          type: 'object',
          additionalProperties: true,
        },
      },
    };
  }
  response.headers = response.headers || {};
  if (!response.headers['X-Request-Id']) {
    response.headers['X-Request-Id'] = OBSERVABILITY_HEADERS['X-Request-Id'];
  }
  if (!response.headers['X-Correlation-Id']) {
    response.headers['X-Correlation-Id'] = OBSERVABILITY_HEADERS['X-Correlation-Id'];
  }
}

function ensureRetryAfterHeader(response) {
  if (!response || typeof response !== 'object') return;
  response.headers = response.headers || {};
  if (!response.headers['Retry-After']) {
    response.headers['Retry-After'] = {
      description: 'Retry delay in seconds or HTTP-date before sending a new request.',
      schema: { type: 'string', example: '60' },
    };
  }
}

function ensureRequiredPaths(spec) {
  spec.paths = spec.paths || {};
  for (const [routePath, pathItem] of Object.entries(REQUIRED_PATHS)) {
    if (!spec.paths[routePath]) spec.paths[routePath] = {};
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!spec.paths[routePath][method]) spec.paths[routePath][method] = operation;
      ensureErrorResponses(spec.paths[routePath][method]);
    }
  }
  for (const [routePath, pathItem] of Object.entries(REQUIRED_CAPABILITY_PATHS)) {
    if (!spec.paths[routePath]) spec.paths[routePath] = {};
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!spec.paths[routePath][method]) spec.paths[routePath][method] = operation;
      ensureErrorResponses(spec.paths[routePath][method]);
    }
  }
}

function ensureTagNormalization(spec) {
  const canonical = new Map();
  for (const tag of spec.tags || []) {
    if (!tag?.name) continue;
    const lower = String(tag.name).toLowerCase();
    if (!canonical.has(lower) || String(tag.name) === String(tag.name).toUpperCase()) {
      canonical.set(lower, tag.name);
    } else if (String(tag.name)[0] === String(tag.name)[0].toUpperCase()) {
      canonical.set(lower, tag.name);
    }
  }
  for (const pathItem of Object.values(spec.paths || {})) {
    for (const operation of Object.values(pathItem || {})) {
      if (!Array.isArray(operation?.tags)) continue;
      for (const tagName of operation.tags) {
        if (!tagName) continue;
        const lower = String(tagName).toLowerCase();
        if (!canonical.has(lower)) canonical.set(lower, String(tagName));
      }
    }
  }
  const defaults = [
    'Capabilities',
    'Models',
    'Realtime',
    'Responses',
    'Chat',
    'Authentication',
    'Status',
  ];
  for (const value of defaults) {
    if (!canonical.has(value.toLowerCase())) canonical.set(value.toLowerCase(), value);
  }

  for (const pathItem of Object.values(spec.paths || {})) {
    for (const [method, operation] of Object.entries(pathItem || {})) {
      if (!OPERATION_METHODS.includes(method)) continue;
      if (!Array.isArray(operation.tags) || operation.tags.length === 0) continue;
      operation.tags = operation.tags.map((tag) => canonical.get(String(tag).toLowerCase()) || tag);
    }
  }

  const sortedTags = Array.from(canonical.values()).sort((a, b) => a.localeCompare(b));
  spec.tags = sortedTags.map((name) => ({ name, description: `${name} operations.` }));
}

function ensureSpectralContractExpectations(spec) {
  if (
    spec.components &&
    spec.components.responses &&
    spec.components.responses.TooManyRequests &&
    typeof spec.components.responses.TooManyRequests === 'object'
  ) {
    ensureRetryAfterHeader(spec.components.responses.TooManyRequests);
  }

  for (const pathItem of Object.values(spec.paths || {})) {
    for (const [method, operation] of Object.entries(pathItem || {})) {
      if (!OPERATION_METHODS.includes(method)) continue;
      if (!operation || typeof operation !== 'object') continue;

      operation.responses = operation.responses || {};
      for (const [statusCode, response] of Object.entries(operation.responses)) {
        if (response && typeof response === 'object' && response.$ref) {
          operation.responses[statusCode] = { $ref: response.$ref };
        }
      }
      for (const statusCode of ['200', '201', '202']) {
        if (operation.responses[statusCode]) {
          ensureResponseContentAndHeaders(operation.responses[statusCode]);
        }
      }
      if (operation.responses['503']) {
        if (!operation.responses['503'].$ref) {
          ensureRetryAfterHeader(operation.responses['503']);
        }
      }
    }
  }
}

// Defense-in-depth: the generator (openapi-sync-public-routes.cjs) is
// responsible for never emitting privileged routes into the spec in the
// first place, but this enforcement pass is the last gate before the
// contract is bundled and handed to the gateway allowlist sync — so it
// independently sweeps the same prefixes rather than trusting upstream
// exclusively.
const PRIVILEGED_PREFIX_RE = /^\/v1\/(internal|admin)(\/|$)/;

function stripInternalPaths(spec) {
  for (const routePath of INTERNAL_OR_SENSITIVE_PATHS) {
    delete spec.paths?.[routePath];
  }
  for (const routePath of Object.keys(spec.paths ?? {})) {
    if (PRIVILEGED_PREFIX_RE.test(routePath)) {
      delete spec.paths[routePath];
    }
  }
}

function ensureSummariesAndDescriptions(spec) {
  const makeSummary = (method, routePath) => {
    const actionMap = {
      get: 'Retrieve',
      post: 'Execute',
      put: 'Update',
      patch: 'Update',
      delete: 'Delete',
      head: 'Retrieve',
      options: 'Retrieve',
    };
    const action = actionMap[method] || 'Execute';
    const tokens = routePath
      .replace(/^\/v1\//, '')
      .replace(/^\//, '')
      .split('/')
      .map((seg) => seg.replace(/[{}]/g, '').replace(/[_-]/g, ' '))
      .filter(Boolean);
    const noun = tokens.join(' ').trim() || 'resource';
    return `${action} ${noun}`;
  };

  for (const [routePath, pathItem] of Object.entries(spec.paths || {})) {
    for (const [method, operation] of Object.entries(pathItem || {})) {
      if (!OPERATION_METHODS.includes(method)) continue;
      const summary = typeof operation.summary === 'string' ? operation.summary.trim() : '';
      const generic =
        !summary ||
        /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\/.*/.test(summary) ||
        /^auto[- ]/i.test(summary);
      if (generic) {
        operation.summary = makeSummary(method, routePath);
      }
      const description = typeof operation.description === 'string' ? operation.description.trim() : '';
      if (!description || /^Auto-(documented|normalized)/i.test(description)) {
        operation.description = `${operation.summary}. Enterprise contract: tenant-scoped auth, policy enforcement, quota limits, and request/correlation observability headers.`;
      }
      ensureErrorResponses(operation);
    }
  }
}

function ensureResponsesMetadataFields(spec) {
  const responseOp = spec.paths?.['/v1/responses']?.post;
  if (!responseOp) return;
  responseOp.responses = responseOp.responses || {};
  responseOp.responses['200'] = responseOp.responses['200'] || {};
  responseOp.responses['200'].content = responseOp.responses['200'].content || {};
  responseOp.responses['200'].content['application/json'] =
    responseOp.responses['200'].content['application/json'] || {};

  const schema =
    responseOp.responses['200'].content['application/json'].schema ||
    {
      type: 'object',
      properties: {},
    };
  responseOp.responses['200'].content['application/json'].schema = schema;
  schema.type = schema.type || 'object';
  schema.properties = schema.properties || {};

  const metadata =
    schema.properties.ailin_metadata ||
    {
      type: 'object',
      properties: {},
      additionalProperties: true,
    };
  schema.properties.ailin_metadata = metadata;
  metadata.type = metadata.type || 'object';
  metadata.properties = metadata.properties || {};

  metadata.properties.final_decider_model_id = metadata.properties.final_decider_model_id || {
    type: 'string',
    description: 'Model ID that produced the final decision output.',
  };
  metadata.properties.final_decider_model_name = metadata.properties.final_decider_model_name || {
    type: 'string',
    description: 'Model display name that produced the final decision output.',
  };
  metadata.properties.final_decider_role = metadata.properties.final_decider_role || {
    type: 'string',
    description: 'Role of the final decision model (e.g., coordinator, judge, synthesizer).',
  };
}

function ensureModelsByIdEncodingContract(spec) {
  const operation = spec.paths?.['/v1/models/{id}']?.get;
  if (!operation || typeof operation !== 'object') return;

  operation.parameters = Array.isArray(operation.parameters) ? operation.parameters : [];
  let idParameter = operation.parameters.find(
    (parameter) =>
      parameter &&
      typeof parameter === 'object' &&
      parameter.in === 'path' &&
      parameter.name === 'id'
  );

  if (!idParameter) {
    idParameter = {
      name: 'id',
      in: 'path',
      required: true,
      schema: { type: 'string' },
    };
    operation.parameters.unshift(idParameter);
  }

  idParameter.required = true;
  idParameter.schema =
    idParameter.schema && typeof idParameter.schema === 'object'
      ? idParameter.schema
      : { type: 'string' };
  idParameter.schema.type = 'string';
  idParameter.description =
    'Model ID. Supports "provider/model" and encoded "provider%2Fmodel". Only one provider/model separator is supported.';
  idParameter.example = 'ai21%2Fjamba-large-1.7';

  const note =
    'Provider/model IDs are accepted with raw "/" or encoded "%2F". Prefer encoded "%2F" for maximum gateway/client compatibility.';
  const legacyNote =
    'For model IDs in provider/model format, URL-encode "/" as "%2F" before calling this endpoint.';
  const currentDescription = typeof operation.description === 'string' ? operation.description : '';
  const withoutLegacy = currentDescription
    .replace(legacyNote, '')
    .replace(note, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  operation.description = withoutLegacy ? `${withoutLegacy}\n\n${note}` : note;
}

function collectReferencedComponents(spec) {
  const referenced = new Set();
  const visitedNodes = new Set();
  const stack = [spec.paths || {}, spec.webhooks || {}];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') continue;
    if (visitedNodes.has(current)) continue;
    visitedNodes.add(current);

    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }

    const refValue = typeof current.$ref === 'string' ? current.$ref : null;
    if (refValue) {
      const match = refValue.match(/^#\/components\/([^/]+)\/([^/]+)$/);
      if (match) {
        const key = `${match[1]}/${match[2]}`;
        if (!referenced.has(key)) {
          referenced.add(key);
          const component = spec.components?.[match[1]]?.[match[2]];
          if (component && typeof component === 'object') {
            stack.push(component);
          }
        }
      }
    }

    for (const value of Object.values(current)) {
      stack.push(value);
    }
  }

  return referenced;
}

function pruneUnusedComponents(spec) {
  const categories = ['schemas', 'responses', 'headers'];
  const removedByCategory = {
    schemas: 0,
    responses: 0,
    headers: 0,
  };

  if (!spec.components || typeof spec.components !== 'object') {
    return removedByCategory;
  }

  let removedInPass = true;
  while (removedInPass) {
    removedInPass = false;
    const referenced = collectReferencedComponents(spec);

    for (const category of categories) {
      const entries = spec.components?.[category];
      if (!entries || typeof entries !== 'object') continue;

      for (const name of Object.keys(entries)) {
        const key = `${category}/${name}`;
        if (referenced.has(key)) continue;
        delete entries[name];
        removedByCategory[category] += 1;
        removedInPass = true;
      }
    }
  }

  return removedByCategory;
}

function saveSpec(spec) {
  fs.writeFileSync(JSON_PATH, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
  fs.writeFileSync(YAML_PATH, YAML.stringify(spec), 'utf8');
}

function main() {
  const spec = loadSpec();
  const beforePathCount = Object.keys(spec.paths || {}).length;
  let removedAliases = 0;
  let removedComponents = {
    schemas: 0,
    responses: 0,
    headers: 0,
  };

  ensureInfoMetadata(spec);
  ensureServerPolicy(spec);
  ensureContractComponents(spec);
  const pathMoves = [
    ['/v1/.well-known/jwks.json', '/.well-known/jwks.json'],
    ['/analyze-requirements', '/v1/analyze-requirements'],
    ['/provider-capabilities', '/v1/provider-capabilities'],
    ['/realtime', '/v1/realtime'],
    ['/chat/completions/intelligent', '/v1/chat/completions/intelligent'],
    ['/capabilities', '/v1/capabilities'],
    ['/capabilities/{capability}/execute', '/v1/capabilities/{capability}/execute'],
    ['/capabilities/{capability}/stream', '/v1/capabilities/{capability}/stream'],
    ['/capabilities/{capability}/health', '/v1/capabilities/{capability}/health'],
  ];
  for (const [fromPath, toPath] of pathMoves) {
    ensurePathMove(spec, fromPath, toPath);
  }
  removedAliases = removeNonVersionedAliases(spec);
  stripInternalPaths(spec);
  ensureRequiredPaths(spec);
  normalizeSecurityAliases(spec);
  ensureResponsesMetadataFields(spec);
  ensureModelsByIdEncodingContract(spec);
  ensureTagNormalization(spec);
  ensureSpectralContractExpectations(spec);
  ensureSummariesAndDescriptions(spec);
  ensureOperationIds(spec);
  removedComponents = pruneUnusedComponents(spec);
  saveSpec(spec);

  const afterPathCount = Object.keys(spec.paths || {}).length;
  console.log(
    JSON.stringify(
      {
        enforced: true,
        beforePathCount,
        afterPathCount,
        removedAliases,
        removedComponents,
      },
      null,
      2
    )
  );
}

main();
