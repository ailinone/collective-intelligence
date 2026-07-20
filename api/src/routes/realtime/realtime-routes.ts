// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Realtime API Routes
 * Multi-provider realtime streaming (OpenAI, Google Live API, etc.)
 *
 * Features:
 * - WebSocket-based bidirectional streaming
 * - Multi-provider support (OpenAI Realtime, Google Live API)
 * - Audio streaming, function calling, interruptions
 * - Dynamic provider selection based on model capabilities
 *
 * NO HARDCODED - Provider selection based on model capabilities
 * REAL IMPLEMENTATION - Uses actual provider APIs
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import { logger } from '@/utils/logger';
import { authenticate as authenticateRequest } from '@/middleware/auth-middleware';
import type { RequestUserContext } from '@/types';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';
import { OpenAIRealtimeClient } from '@/providers/openai/realtime-client';
import { GoogleLiveClient } from '@/providers/google/google-live-client';
import { AilinRealtimeClient } from '@/providers/ailin/ailin-realtime-client';
import { RealtimeTranslationAdapter } from '@/providers/ailin/realtime-translation-adapter';
import { getProviderRegistry } from '@/providers/provider-registry';
import { ModelRepository } from '@/services/model-repository';
import { GoogleAdapter } from '@/providers/google/google-adapter';
import { narrowAs } from '@/utils/type-guards';
import { nanoid } from 'nanoid';
import { createRealtimeSession } from '@/services/realtime-session-service';
import { getAuthService } from '@/services/auth-service';

const log = logger.child({ module: 'realtime-routes' });

/**
 * Helper to extract user context from authenticated request
 */
function getUserContext(request: FastifyRequest): RequestUserContext {
  const extendedRequest = request as ExtendedFastifyRequest;
  const user = extendedRequest.user as { userId?: string; organizationId?: string; email?: string; name?: string } | undefined;
  
  return {
    requestId: request.id,
    organizationId: extendedRequest.organizationId || user?.organizationId || '',
    userId: extendedRequest.userId || user?.userId || '',
  };
}

// ============================================
// Types
// ============================================

/**
 * Common interface for realtime clients
 * Both OpenAIRealtimeClient and GoogleLiveClient implement these methods
 */
interface RealtimeClient {
  sendText(text: string): void;
  sendAudio(buffer: Buffer, mimeType?: string): void;
  requestResponse(): void;
  cancelResponse(): void;
  disconnect(): void;
  // EventEmitter methods - using overloaded signatures for compatibility
  on(event: string | symbol, listener: (...args: unknown[]) => void): this;
}

interface SessionConfig {
  model?: string;
  modalities?: string[];
  instructions?: string;
  voice?: string;
  temperature?: number;
  tools?: Array<{
    type: string;
    function?: {
      name: string;
      description?: string;
      parameters?: Record<string, unknown>;
    };
  }>;
}

// ============================================
// Realtime Client Factory
// ============================================

class RealtimeClientFactory {
  private modelRepo: ModelRepository;

  constructor() {
    this.modelRepo = new ModelRepository();
  }

  /**
   * Create a realtime client for the specified model
   */
  async createClient(
    modelName: string,
    connection: WebSocket,
    requestId: string,
    userContext?: { organizationId: string; userId?: string; authToken?: string }
  ): Promise<{ client: RealtimeClient; provider: string } | null> {
    // Default: Ailin realtime (uses internal STT→Chat→TTS services)
    if (userContext) {
      const client = new AilinRealtimeClient({
        organizationId: userContext.organizationId,
        userId: userContext.userId || '',
        requestId,
        authToken: userContext.authToken,
      });
      return { client: client as RealtimeClient, provider: 'ailin' };
    }

    // Get model info
    let selectedModel = await this.modelRepo.getModelById(modelName);

    // If not found by ID, search by name using tags
    if (!selectedModel) {
      const models = await this.modelRepo.searchModels({
        tags: [modelName],
        status: 'active',
        limit: 1,
      });
      if (models.length > 0) {
        selectedModel = models[0];
      }
    }

    // If still not found, try providers with verified WebSocket support first
    if (!selectedModel) {
      for (const prov of ['openai', 'google']) {
        const models = await this.modelRepo.findModelsWithCapabilities(
          ['realtime'],
          { providers: [prov], limit: 1 }
        );
        if (models.length > 0) { selectedModel = models[0]; break; }
      }
    }
    // Last resort: any provider
    if (!selectedModel) {
      const models = await this.modelRepo.findModelsWithCapabilities(['realtime'], { limit: 1 });
      if (models.length > 0) { selectedModel = models[0]; }
    }

    if (!selectedModel) {
      log.warn({ requestId, modelName }, 'No realtime-capable model found');
      return null;
    }

    log.info(
      { requestId, model: selectedModel.name, provider: selectedModel.provider },
      'Selected realtime model'
    );

    const providerRegistry = getProviderRegistry();
    const adapter = providerRegistry.get(selectedModel.provider);

    if (!adapter) {
      log.error({ requestId, provider: selectedModel.provider }, 'Provider adapter not found');
      return null;
    }

    // Create client based on provider type
    const apiKey = adapter.getApiKey();
    if (!apiKey) {
      log.error({ requestId, provider: selectedModel.provider }, 'Provider API key not configured');
      return null;
    }

    // Google Live API has its own client
    if (adapter instanceof GoogleAdapter) {
      const googleClient = new GoogleLiveClient(apiKey);
      return { client: googleClient as RealtimeClient, provider: 'google' };
    }

    // All other providers use OpenAI-compatible realtime protocol
    // (OpenAI native, OpenRouter, orqai, etc.)
    const baseUrl = (narrowAs<{ config?: { baseUrl?: string } }>(adapter)).config?.baseUrl
      || (selectedModel.provider === 'openai' ? 'https://api.openai.com/v1' : undefined);

    if (!baseUrl) {
      log.warn(
        { requestId, provider: selectedModel.provider },
        'No baseUrl for provider — cannot establish realtime connection'
      );
      return null;
    }

    const client = new OpenAIRealtimeClient(apiKey, baseUrl);
    return { client: client as RealtimeClient, provider: selectedModel.provider };

    return null;
  }
}

// ============================================
// Route Registration
// ============================================

export async function registerRealtimeRoutes(server: FastifyInstance): Promise<void> {
  const clientFactory = new RealtimeClientFactory();

  // POST /v1/realtime/session — Create ephemeral session for secure WebSocket connection
  server.post(
    '/v1/realtime/session',
    {
      preHandler: authenticateRequest,
      schema: {
        tags: ['Realtime'],
        summary: 'Create realtime session',
        description: 'Creates an ephemeral session with a single-use, 5-minute session token (rst_) for the WebSocket connection. The caller\'s long-lived credential is never embedded in the wsUrl or echoed in the response.',
        body: {
          type: 'object',
          properties: {
            modalities: { type: 'array', items: { type: 'string' } },
            model: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const userContext = getUserContext(request);
      const extendedRequest = request as ExtendedFastifyRequest;
      const user = extendedRequest.user as
        | { email?: string; name?: string; roles?: string[] }
        | undefined;

      // Mint a truly ephemeral, single-use session token. The caller's
      // long-lived credential (JWT/API key) is NEVER embedded in the wsUrl
      // or echoed back — URLs leak into proxy/gateway logs and browser history.
      let session: { sessionId: string; sessionToken: string; expiresAt: number };
      try {
        session = await createRealtimeSession({
          userId: userContext.userId || '',
          organizationId: userContext.organizationId,
          email: user?.email || '',
          name: user?.name || '',
          roles: user?.roles || [],
          tier: extendedRequest.organizationTier || extendedRequest.tenantContext?.tier || 'free',
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ error: msg, userId: userContext.userId }, 'Failed to create realtime session');
        return reply.status(503).send({
          error: 'Service Unavailable',
          message: 'Realtime session service is temporarily unavailable',
        });
      }

      const baseUrl = process.env.API_BASE_URL || `https://api.ailin.one`;
      const wsUrl = `${baseUrl.replace('https://', 'wss://').replace('http://', 'ws://')}/v1/realtime?token=${encodeURIComponent(session.sessionToken)}&sessionId=${session.sessionId}`;

      log.info({ sessionId: session.sessionId, userId: userContext?.userId }, 'Realtime session created');
      return reply.status(201).send({
        sessionId: session.sessionId,
        wsUrl,
        expiresAt: session.expiresAt,
        // Ephemeral single-use session token (rst_) for clients that
        // construct their own URL. NOT the caller's credential.
        token: session.sessionToken,
      });
    }
  );

  // GET /v1/realtime (WebSocket upgrade)
  server.get(
    '/v1/realtime',
    {
      websocket: true,
      schema: {
        tags: ['Realtime'],
        summary: 'Realtime WebSocket API',
        description:
          'WebSocket endpoint for realtime bidirectional streaming. Supports OpenAI Realtime API and Google Live API. Provides bidirectional audio streaming, function calling, and interruptions. Automatically selects the best provider based on model capabilities.',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            model: { type: 'string', description: 'Model ID or "auto" for dynamic selection' },
            token: {
              type: 'string',
              description:
                'Ephemeral session token (rst_) from POST /v1/realtime/session. Single-use, expires after 5 minutes. Long-lived credentials (JWT/API key) are NOT accepted here — use the Authorization header or the session bootstrap.',
            },
            sessionId: {
              type: 'string',
              description: 'Session id (rs_) issued together with the ephemeral token.',
            },
          },
        },
      },
      preHandler: authenticateRequest,
    },
    async (connection, request) => {
      const userContext = getUserContext(request);
      const requestId =
        typeof request.id === 'string' ? request.id : `realtime-${nanoid(16)}`;

      log.info(
        { requestId, userId: userContext?.userId },
        'Realtime WebSocket connection established'
      );

      let realtimeClient: RealtimeClient | null = null;
      let currentProvider: string | null = null;
      // Initialize model from query param (e.g. ?model=ailin-auto)
      let modelName: string | null =
        (request.query as Record<string, string>)?.model || null;

      // Handle incoming messages (text JSON or binary audio)
      connection.on('message', async (message: Buffer) => {
        // Try JSON parse first — if it fails AND we have a realtime client,
        // treat as binary audio. This is safer than byte-sniffing because
        // some WebSocket clients send JSON as binary frames.
        let data: {
          type: string;
          session?: SessionConfig;
          audio?: string;
          item?: {
            type?: string;
            content?: Array<{ type?: string; text?: string }>;
          };
        };

        try {
          // The frame is opaque from the type-system's perspective; we
          // route on `data.type` (a string) below and the narrowAs cast
          // is the auditable site for that contract.
          data = narrowAs<typeof data>(JSON.parse(message.toString()));
          log.info({ requestId, messageType: data.type }, 'Received WebSocket message');

          // Handle session.update - configure the session
          if (data.type === 'session.update') {
            const sessionConfig = data.session ?? {};
            const hasTranslation = !!(sessionConfig as Record<string, unknown>).translation;
            log.info({ requestId, model: sessionConfig.model, hasTranslation, modalities: sessionConfig.modalities }, 'session.update received');

            // Select model - require explicit model or find one dynamically
            if (sessionConfig.model) {
              modelName = sessionConfig.model;
            } else if (!modelName) {
              // No model specified — auto-select by capability.
              if (userContext) {
                // getUserContext() always returns an object (never undefined),
                // so `userContext` is truthy for every request through this
                // authenticated route — meaning clientFactory.createClient()
                // below ALWAYS takes its `if (userContext)` branch and returns
                // an AilinRealtimeClient, which never reads the `modelName`
                // parameter at all. A DB-backed capability search here would
                // add 1-2 round-trips just to compute a value nothing reads.
                modelName = 'ailin-auto';
              } else {
                // Prioritize providers with verified WebSocket realtime support.
                const modelRepo = new ModelRepository();
                const providerPriority = ['openai', 'google'];
                let found = false;

                for (const prov of providerPriority) {
                  const models = await modelRepo.findModelsWithCapabilities(
                    ['realtime'],
                    { providers: [prov], limit: 1 }
                  );
                  if (models.length > 0) {
                    modelName = models[0].name;
                    log.info({ requestId, model: modelName, provider: prov }, 'Auto-selected realtime model (priority provider)');
                    found = true;
                    break;
                  }
                }

                // Fallback: any provider with realtime capability
                if (!found) {
                  const models = await modelRepo.findModelsWithCapabilities(
                    ['realtime'],
                    { limit: 1 }
                  );
                  if (models.length > 0) {
                    modelName = models[0].name;
                    log.info({ requestId, model: modelName }, 'Auto-selected realtime model (fallback)');
                    found = true;
                  }
                }

                if (!found) {
                  connection.send(
                    JSON.stringify({
                      type: 'error',
                      error: {
                        type: 'no_realtime_model',
                        message: 'No realtime-capable model available. Please specify a model in session.update.',
                      },
                    })
                  );
                  return;
                }
              }
            }

            // ── Translation mode: dedicated adapter ──────────────────
            // When translation is enabled, use RealtimeTranslationAdapter directly.
            // No model search needed — the adapter manages its own STT→NLLB→TTS pipeline.
            const translationConfig = (sessionConfig as Record<string, unknown>).translation as
              | { enabled: boolean; sourceLanguage: string; targetLanguage: string }
              | undefined;

            if (translationConfig?.enabled) {
              log.info({ requestId, sourceLanguage: translationConfig.sourceLanguage, targetLanguage: translationConfig.targetLanguage }, 'Translation mode: creating dedicated adapter');

              const translationAdapter = new RealtimeTranslationAdapter({
                organizationId: userContext?.organizationId || '',
                userId: userContext?.userId || '',
                requestId,
              });

              realtimeClient = narrowAs<RealtimeClient>(translationAdapter);
              currentProvider = 'ailin-translation';

              try {
                await translationAdapter.connect({
                  sourceLanguage: translationConfig.sourceLanguage,
                  targetLanguage: translationConfig.targetLanguage,
                  modalities: (sessionConfig.modalities ?? ['text', 'audio']) as ('text' | 'audio')[],
                  voice: sessionConfig.voice,
                });

                setupEventForwarding(realtimeClient, connection, currentProvider);

                connection.send(JSON.stringify({
                  type: 'session.updated',
                  session: {
                    model: 'realtime-translation',
                    provider: 'ailin-translation',
                    modalities: sessionConfig.modalities ?? ['text', 'audio'],
                    voice: sessionConfig.voice ?? 'alloy',
                  },
                }));

                log.info({ requestId }, 'Translation adapter connected and session.updated sent');
                return; // Done — skip model search and normal client creation
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                log.error({ requestId, error: msg }, 'Translation adapter failed');
                connection.send(JSON.stringify({
                  type: 'error',
                  error: { type: 'translation_error', message: msg },
                }));
                return;
              }
            }

            // ── Normal mode: model search + client creation ──────────
            // Try connecting with the selected model; retry with alternatives on failure
            const modelRepo = new ModelRepository();
            const candidates = modelName
              ? [modelName]
              : [];

            // Add fallback candidates from the database (different models, same
            // capability) — ONLY meaningful when userContext is absent (see the
            // comment on the `modelName` auto-select branch above: with
            // userContext present, createClient() always returns an
            // AilinRealtimeClient and never reads any of these candidate names).
            if (!sessionConfig.model && !userContext) {
              // User didn't specify a model — we can try alternatives
              for (const prov of ['openai', 'google']) {
                const models = await modelRepo.findModelsWithCapabilities(
                  ['realtime'], { providers: [prov], limit: 5 }
                );
                for (const m of models) {
                  if (!candidates.includes(m.name)) candidates.push(m.name);
                }
              }
            }

            // Auth token for internal HTTP loopback calls (AilinRealtimeClient
            // → /v1/chat/completions). Header-authenticated clients reuse their
            // own credential. Session-token (rst_) connections get a short-lived
            // internal access token minted server-side — the rst_ token itself
            // is only valid for this route and never works on the chat API.
            let loopbackToken = request.headers.authorization?.replace('Bearer ', '') || '';
            if (!loopbackToken && userContext?.userId) {
              try {
                const wsUser = (request as ExtendedFastifyRequest).user as
                  | { email?: string; roles?: string[] }
                  | undefined;
                loopbackToken = await getAuthService().generateEphemeralAccessToken({
                  userId: userContext.userId,
                  organizationId: userContext.organizationId,
                  email: wsUser?.email || '',
                  roles: wsUser?.roles || [],
                });
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                log.warn({ requestId, error: msg }, 'Failed to mint loopback token — internal calls will be unauthenticated');
              }
            }

            let connectError: string | null = null;
            for (const candidateModel of candidates) {
              const result = await clientFactory.createClient(candidateModel, connection, requestId, userContext ? { organizationId: userContext.organizationId, userId: userContext.userId, authToken: loopbackToken } : undefined);
              if (!result) continue;

              realtimeClient = result.client;
              currentProvider = result.provider;
              modelName = candidateModel;

              try {
                if (realtimeClient instanceof GoogleLiveClient) {
                  await (realtimeClient as GoogleLiveClient).connect({
                    model: candidateModel.replace('models/', ''),
                    modalities: (sessionConfig.modalities?.map((m) => m.toUpperCase()) ?? ['TEXT', 'AUDIO']) as ('TEXT' | 'AUDIO')[],
                    systemInstruction: sessionConfig.instructions,
                    speechConfig: sessionConfig.voice ? { voiceConfig: { prebuiltVoiceConfig: { voiceName: sessionConfig.voice } } } : undefined,
                    generationConfig: { temperature: sessionConfig.temperature },
                  });
                } else if (realtimeClient instanceof AilinRealtimeClient) {
                  await (realtimeClient as AilinRealtimeClient).connect({
                    modalities: (sessionConfig.modalities ?? ['text', 'audio']) as ('text' | 'audio')[],
                    instructions: sessionConfig.instructions,
                    voice: sessionConfig.voice ?? 'alloy',
                    temperature: sessionConfig.temperature ?? 0.8,
                    tools: sessionConfig.tools,
                    // Translation is now handled by RealtimeTranslationAdapter (separate path above)
                  });
                } else if (realtimeClient instanceof OpenAIRealtimeClient) {
                  await (realtimeClient as OpenAIRealtimeClient).connect({
                    model: candidateModel,
                    modalities: (sessionConfig.modalities ?? ['text', 'audio']) as ('text' | 'audio')[],
                    instructions: sessionConfig.instructions,
                    voice: (sessionConfig.voice ?? 'alloy') as string,
                    temperature: sessionConfig.temperature ?? 1,
                  });
                }

                // Connection succeeded — break out of retry loop
                connectError = null;
                log.info({ requestId, model: candidateModel, provider: currentProvider }, 'Realtime connection established');
                break;
              } catch (err) {
                connectError = err instanceof Error ? err.message : 'Connection failed';
                log.warn({ requestId, model: candidateModel, error: connectError }, 'Realtime model failed — trying next');
                realtimeClient.disconnect();
                realtimeClient = null;
                continue;
              }
            }

            if (!realtimeClient || connectError) {
              connection.send(JSON.stringify({
                type: 'error',
                error: { type: 'connection_failed', message: connectError || 'No realtime model available' },
              }));
              return;
            }

            // Forward events from client to WebSocket
            setupEventForwarding(realtimeClient, connection, currentProvider!);

              connection.send(
                JSON.stringify({
                  type: 'session.updated',
                  session: {
                    model: modelName,
                    provider: currentProvider,
                    modalities: sessionConfig.modalities ?? ['text', 'audio'],
                    instructions: sessionConfig.instructions,
                    voice: sessionConfig.voice ?? 'alloy',
                  },
                })
              );
          }
          // Handle input.audio_buffer.append
          else if (data.type === 'input_audio_buffer.append' && realtimeClient) {
            const audioBase64 = data.audio;
            if (audioBase64 && typeof audioBase64 === 'string') {
              const audioBuffer = Buffer.from(audioBase64, 'base64');
              realtimeClient.sendAudio(audioBuffer);
            }
          }
          // Handle input.audio_buffer.commit
          else if (data.type === 'input_audio_buffer.commit' && realtimeClient) {
            realtimeClient.requestResponse();
          }
          // Handle conversation.item.create
          else if (data.type === 'conversation.item.create' && realtimeClient) {
            const item = data.item;
            if (item?.type === 'message') {
              const content = item.content;
              if (
                content &&
                Array.isArray(content) &&
                content[0]?.type === 'input_text' &&
                content[0]?.text
              ) {
                realtimeClient.sendText(content[0].text);
                realtimeClient.requestResponse();
              }
            }
          }
          // Handle response.create
          else if (data.type === 'response.create' && realtimeClient) {
            realtimeClient.requestResponse();
          }
          // Handle response.cancel
          else if (data.type === 'response.cancel' && realtimeClient) {
            realtimeClient.cancelResponse();
          }
          // Unknown message type
          else if (!realtimeClient && data.type !== 'session.update') {
            connection.send(
              JSON.stringify({
                type: 'error',
                error: {
                  type: 'session_not_configured',
                  message: 'Send session.update first to configure the session',
                },
              })
            );
          } else {
            log.warn({ requestId, messageType: data.type }, 'Unknown message type');
          }
        } catch (parseOrHandleError) {
          // JSON parse failed → likely binary audio data
          if (parseOrHandleError instanceof SyntaxError && realtimeClient) {
            // Binary PCM audio — forward directly to streaming STT
            realtimeClient.sendAudio(message);
            return;
          }

          // Actual handler error
          const errorMessage =
            parseOrHandleError instanceof Error ? parseOrHandleError.message : 'Unknown error';
          log.error(
            { requestId, error: errorMessage },
            'Error handling WebSocket message'
          );
          try {
            if (connection.readyState === 1) {
              connection.send(
                JSON.stringify({
                  type: 'error',
                  error: {
                    type: 'internal_error',
                    message: errorMessage,
                  },
                })
              );
            }
          } catch { /* connection may have closed */ }
        }
      });

      // Handle connection close
      connection.on('close', () => {
        log.info({ requestId }, 'Realtime WebSocket connection closed');
        if (realtimeClient) {
          realtimeClient.disconnect();
        }
      });

      // Handle connection error
      connection.on('error', (error: Error) => {
        log.error({ requestId, error: error.message }, 'Realtime WebSocket error');
      });

      // Send initial connection confirmation
      connection.send(
        JSON.stringify({
          type: 'connection.opened',
          connection_id: requestId,
          supported_providers: ['openai', 'google'],
        })
      );
    }
  );

  log.info('Realtime API routes registered (Multi-provider: OpenAI, Google Live)');
}

// ============================================
// Event Forwarding
// ============================================

function setupEventForwarding(
  client: RealtimeClient,
  connection: WebSocket,
  provider: string
): void {
  // Common event forwarding (safe — checks connection state before sending)
  const forwardEvent = (eventType: string, data: unknown): void => {
    try {
      if (connection.readyState !== 1 /* WebSocket.OPEN */) return;
      const eventData = typeof data === 'object' && data !== null ? data : { data };
      connection.send(
        JSON.stringify({
          type: eventType,
          provider,
          ...eventData,
        })
      );
    } catch (err) {
      // Connection may have closed between readyState check and send
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('WebSocket is not open')) {
        log.warn({ eventType, error: msg }, 'Event forward failed');
      }
    }
  };

  // Forward all events using wildcard if supported
  if ('on' in client && typeof client.on === 'function') {
    // OpenAI Realtime Client events
    client.on('session.created', (data: unknown) => forwardEvent('session.created', data));
    client.on('response.text.delta', (data: unknown) => forwardEvent('response.text.delta', data));
    client.on('response.audio.delta', (data: unknown) => forwardEvent('response.audio.delta', data));
    client.on('response.function_call', (data: unknown) =>
      forwardEvent('response.function_call', data)
    );
    client.on('response.done', (data: unknown) => forwardEvent('response.done', data));
    client.on('response.interrupted', (data: unknown) =>
      forwardEvent('response.interrupted', data)
    );
    client.on('response.cancelled', (data: unknown) => forwardEvent('response.cancelled', data));
    client.on('error', (data: unknown) => forwardEvent('error', data));
    client.on('close', (data: unknown) => forwardEvent('connection.closed', data));
    client.on('response.audio.done', (data: unknown) => forwardEvent('response.audio.done', data));

    // Translation-specific events (AilinRealtimeClient translation mode)
    client.on('translation.text.original', (data: unknown) => forwardEvent('translation.text.original', data));
    client.on('translation.text.translated', (data: unknown) => forwardEvent('translation.text.translated', data));

    // VAD events (server-side voice activity detection)
    client.on('input_audio_buffer.speech_started', (data: unknown) => forwardEvent('input_audio_buffer.speech_started', data));
    client.on('input_audio_buffer.speech_stopped', (data: unknown) => forwardEvent('input_audio_buffer.speech_stopped', data));

    // STT transcription events (batch path — legacy)
    client.on('conversation.item.input_audio_transcription.completed', (data: unknown) =>
      forwardEvent('conversation.item.input_audio_transcription.completed', data));

    // STT transcription events (streaming path — Deepgram phrase-level)
    client.on('stt.transcription', (data: unknown) => forwardEvent('stt.transcription', data));

    // Adapter diagnostic event
    client.on('translation.adapter.status', (data: unknown) => forwardEvent('translation.adapter.status', data));
  }
}
