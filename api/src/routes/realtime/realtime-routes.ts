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
import { rejectAnonymousGuestKeyPreHandler } from '@/services/anonymous-quota-gate';
import { rejectChatFreeTierKeyPreHandler } from '@/services/free-tier-quota-gate';
import type { Model, RequestUserContext } from '@/types';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';
import { OpenAIRealtimeClient } from '@/providers/openai/realtime-client';
import { GoogleLiveClient } from '@/providers/google/google-live-client';
import { AilinRealtimeClient } from '@/providers/ailin/ailin-realtime-client';
import { RealtimeTranslationAdapter } from '@/providers/ailin/realtime-translation-adapter';
import { getProviderRegistry } from '@/providers/provider-registry';
import { ModelRepository } from '@/services/model-repository';
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
  const user = extendedRequest.user as
    { userId?: string; organizationId?: string; email?: string; name?: string } | undefined;

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

/**
 * How a session should be served upstream.
 *
 *  - `provider`: bridge to the provider's OWN realtime WebSocket (OpenAI
 *    Realtime, Gemini Live). Fails the session if no such provider resolves.
 *  - `composite`: the gateway's internal STT -> chat -> TTS pipeline
 *    (`AilinRealtimeClient`), which works with any provider but is not a
 *    native speech-to-speech session.
 *  - `auto` (default): use a provider bridge when the caller named a model
 *    that resolves to one; otherwise the composite.
 */
export type RealtimeTransportPreference = 'auto' | 'provider' | 'composite';

export function parseTransportPreference(value: unknown): RealtimeTransportPreference {
  return value === 'provider' || value === 'composite' ? value : 'auto';
}

export interface RealtimeClientSelection {
  client: RealtimeClient;
  provider: string;
  /** Which upstream actually serves the session. */
  transport: 'provider' | 'composite';
  /** Set only for `transport: 'provider'` — the model the bridge will open. */
  model?: string;
  transportKind?: 'openai-realtime-ws' | 'google-live-ws';
}

/**
 * Alias prefix that names the gateway's own composite pipeline rather than an
 * upstream model. Such names must never be resolved against the model catalog.
 */
const COMPOSITE_MODEL_PREFIX = 'ailin-';

export class RealtimeClientFactory {
  private modelRepo: ModelRepository;

  constructor(modelRepo: ModelRepository = new ModelRepository()) {
    this.modelRepo = modelRepo;
  }

  /**
   * Resolve the client that will serve this session.
   *
   * --- What was broken here -------------------------------------------
   * The previous implementation opened with `if (userContext) { return
   * AilinRealtimeClient }`. `getUserContext()` always returns an object, so
   * that branch was taken on EVERY request through this authenticated route
   * and the ~110 lines below it — the whole provider-native bridge to the
   * OpenAI Realtime API and the Gemini Live API — were unreachable. Naming a
   * provider realtime model in `session.update` still got the composite
   * STT->chat->TTS pipeline, and `audio_to_audio` (true speech-to-speech,
   * which the composite cannot do because it round-trips through text) had
   * no path at all. The `return null` sitting after a `return` statement was
   * the visible symptom.
   *
   * --- The rule now ---------------------------------------------------
   * The upstream is chosen from what the caller asked for, and the provider
   * capability is DECLARED by the adapter (`getRealtimeTransport()`), not
   * inferred from a provider-name list. Default behaviour is unchanged for
   * callers that name no model, so this is additive rather than a routing
   * flip: a session reaches a provider bridge only when it named a model that
   * resolves to one, or explicitly asked for `transport: 'provider'`.
   */
  async createClient(
    modelName: string | null,
    requestId: string,
    userContext: { organizationId: string; userId?: string; authToken?: string } | undefined,
    preference: RealtimeTransportPreference = 'auto'
  ): Promise<RealtimeClientSelection | null> {
    const requested = typeof modelName === 'string' ? modelName.trim() : '';
    const namesComposite = requested.startsWith(COMPOSITE_MODEL_PREFIX);

    if (preference !== 'composite' && !(preference === 'auto' && namesComposite)) {
      const bridge = await this.createProviderBridge(requested, requestId, preference);
      if (bridge) return bridge;
      if (preference === 'provider') {
        // An explicit request for a native provider session that cannot be
        // honoured. Silently downgrading to the composite would answer a
        // speech-to-speech request with a text round-trip.
        log.warn(
          { requestId, requested },
          'transport=provider requested but no provider-native realtime bridge resolved'
        );
        return null;
      }
    }

    if (!userContext) {
      log.warn({ requestId, requested }, 'No user context — cannot serve composite realtime');
      return null;
    }

    const client = new AilinRealtimeClient({
      organizationId: userContext.organizationId,
      userId: userContext.userId || '',
      requestId,
      authToken: userContext.authToken,
    });
    return { client: client as RealtimeClient, provider: 'ailin', transport: 'composite' };
  }

  /**
   * Build a bridge to a provider's own realtime WebSocket, or return null when
   * none is available. Never throws — the caller decides whether the absence
   * is fatal.
   */
  private async createProviderBridge(
    requested: string,
    requestId: string,
    preference: RealtimeTransportPreference
  ): Promise<RealtimeClientSelection | null> {
    const candidates = await this.resolveRealtimeCandidates(requested, preference);
    if (candidates.length === 0) return null;

    const providerRegistry = getProviderRegistry();

    for (const candidate of candidates) {
      const adapter = providerRegistry.get(candidate.provider);
      if (!adapter) continue;

      const transport = adapter.getRealtimeTransport();
      if (!transport.kind) continue;

      const apiKey = adapter.getApiKey();
      if (!apiKey) {
        log.warn(
          { requestId, provider: candidate.provider },
          'Provider declares a realtime transport but has no credential configured'
        );
        continue;
      }

      if (transport.kind === 'google-live-ws') {
        log.info(
          { requestId, provider: candidate.provider, model: candidate.name },
          'Realtime session bound to provider-native Google Live bridge'
        );
        return {
          client: narrowAs<RealtimeClient>(new GoogleLiveClient(apiKey)),
          provider: candidate.provider,
          transport: 'provider',
          model: candidate.name,
          transportKind: transport.kind,
        };
      }

      // `openai-realtime-ws`. The base URL comes from the adapter's own config
      // so an OpenAI-compatible upstream is bridged at ITS host; the realtime
      // client falls back to the public OpenAI base only when the adapter
      // declares none.
      const baseUrl = narrowAs<{ config?: { baseUrl?: string } }>(adapter).config?.baseUrl;
      log.info(
        { requestId, provider: candidate.provider, model: candidate.name },
        'Realtime session bound to provider-native OpenAI-protocol bridge'
      );
      return {
        client: narrowAs<RealtimeClient>(new OpenAIRealtimeClient(apiKey, baseUrl)),
        provider: candidate.provider,
        transport: 'provider',
        model: candidate.name,
        transportKind: transport.kind,
      };
    }

    return null;
  }

  /**
   * Candidate models for a provider-native session, most specific first.
   *
   * When the caller named a model we resolve exactly that — an explicit name
   * is a constraint, not a hint, so a different model is never silently
   * substituted. Only when nothing was named (and the caller explicitly asked
   * for `transport: 'provider'`) do we fall back to a capability search.
   */
  private async resolveRealtimeCandidates(
    requested: string,
    preference: RealtimeTransportPreference
  ): Promise<Model[]> {
    if (requested.length > 0) {
      return this.modelRepo.findModelsByIdOrName(requested);
    }

    if (preference !== 'provider') return [];

    // No model named but a provider-native session was demanded: search the
    // catalog by capability. `realtime_audio` first (the ontology id meaning a
    // live AUDIO session), then the broader `realtime`.
    const [audioFirst, anyRealtime] = await Promise.all([
      this.modelRepo.findModelsWithCapabilities(['realtime_audio'], { limit: 10 }),
      this.modelRepo.findModelsWithCapabilities(['realtime'], { limit: 10 }),
    ]);

    const seen = new Set<string>();
    const merged: Model[] = [];
    for (const model of [...audioFirst, ...anyRealtime]) {
      const key = `${model.provider}:${model.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(model);
    }
    return merged;
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
      preHandler: [
        authenticateRequest,
        rejectAnonymousGuestKeyPreHandler,
        rejectChatFreeTierKeyPreHandler,
      ],
      schema: {
        tags: ['Realtime'],
        summary: 'Create realtime session',
        description:
          "Creates an ephemeral session with a single-use, 5-minute session token (rst_) for the WebSocket connection. The caller's long-lived credential is never embedded in the wsUrl or echoed in the response.",
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
        { email?: string; name?: string; roles?: string[] } | undefined;

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

      log.info(
        { sessionId: session.sessionId, userId: userContext?.userId },
        'Realtime session created'
      );
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
            transport: {
              type: 'string',
              enum: ['auto', 'provider', 'composite'],
              description:
                'Upstream to serve the session with. "provider" bridges to the provider\'s own realtime WebSocket (OpenAI Realtime / Gemini Live) and is the only mode that yields true speech-to-speech; it fails the session rather than downgrading. "composite" pins the gateway STT-to-chat-to-TTS pipeline. "auto" (default) uses a provider bridge when the named model resolves to one, otherwise the composite. May also be set on the session.update payload.',
            },
          },
        },
      },
      preHandler: [
        authenticateRequest,
        rejectAnonymousGuestKeyPreHandler,
        rejectChatFreeTierKeyPreHandler,
      ],
    },
    async (connection, request) => {
      const userContext = getUserContext(request);
      const requestId = typeof request.id === 'string' ? request.id : `realtime-${nanoid(16)}`;

      log.info(
        { requestId, userId: userContext?.userId },
        'Realtime WebSocket connection established'
      );

      let realtimeClient: RealtimeClient | null = null;
      let currentProvider: string | null = null;
      // Initialize model from query param (e.g. ?model=ailin-auto)
      let modelName: string | null = (request.query as Record<string, string>)?.model || null;
      const queryTransport = (request.query as Record<string, string>)?.transport;

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
            log.info(
              {
                requestId,
                model: sessionConfig.model,
                hasTranslation,
                modalities: sessionConfig.modalities,
              },
              'session.update received'
            );

            // An explicit model on session.update overrides the query param.
            // Everything else about upstream selection now lives in
            // RealtimeClientFactory — including the case where no model was
            // named at all. The block that used to sit here pre-computed a
            // model the factory then ignored (see the factory's doc comment).
            if (sessionConfig.model) {
              modelName = sessionConfig.model;
            }

            // `transport` lets a caller demand a provider-NATIVE session
            // (`provider`, the only way to get true speech-to-speech) or pin
            // the gateway's composite pipeline (`composite`). Default `auto`
            // preserves the historical behaviour.
            const transportPreference = parseTransportPreference(
              (sessionConfig as Record<string, unknown>).transport ?? queryTransport
            );

            // ── Translation mode: dedicated adapter ──────────────────
            // When translation is enabled, use RealtimeTranslationAdapter directly.
            // No model search needed — the adapter manages its own STT→NLLB→TTS pipeline.
            const translationConfig = (sessionConfig as Record<string, unknown>).translation as
              { enabled: boolean; sourceLanguage: string; targetLanguage: string } | undefined;

            if (translationConfig?.enabled) {
              log.info(
                {
                  requestId,
                  sourceLanguage: translationConfig.sourceLanguage,
                  targetLanguage: translationConfig.targetLanguage,
                },
                'Translation mode: creating dedicated adapter'
              );

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
                  modalities: (sessionConfig.modalities ?? ['text', 'audio']) as (
                    'text' | 'audio'
                  )[],
                  voice: sessionConfig.voice,
                });

                setupEventForwarding(realtimeClient, connection, currentProvider);

                connection.send(
                  JSON.stringify({
                    type: 'session.updated',
                    session: {
                      model: 'realtime-translation',
                      provider: 'ailin-translation',
                      modalities: sessionConfig.modalities ?? ['text', 'audio'],
                      voice: sessionConfig.voice ?? 'alloy',
                    },
                  })
                );

                log.info({ requestId }, 'Translation adapter connected and session.updated sent');
                return; // Done — skip model search and normal client creation
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                log.error({ requestId, error: msg }, 'Translation adapter failed');
                connection.send(
                  JSON.stringify({
                    type: 'error',
                    error: { type: 'translation_error', message: msg },
                  })
                );
                return;
              }
            }

            // ── Normal mode: upstream selection + connect ────────────
            // Auth token for internal HTTP loopback calls (AilinRealtimeClient
            // → /v1/chat/completions). Header-authenticated clients reuse their
            // own credential. Session-token (rst_) connections get a short-lived
            // internal access token minted server-side — the rst_ token itself
            // is only valid for this route and never works on the chat API.
            let loopbackToken = request.headers.authorization?.replace('Bearer ', '') || '';
            if (!loopbackToken && userContext?.userId) {
              try {
                const wsUser = (request as ExtendedFastifyRequest).user as
                  { email?: string; roles?: string[] } | undefined;
                loopbackToken = await getAuthService().generateEphemeralAccessToken({
                  userId: userContext.userId,
                  organizationId: userContext.organizationId,
                  email: wsUser?.email || '',
                  roles: wsUser?.roles || [],
                });
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                log.warn(
                  { requestId, error: msg },
                  'Failed to mint loopback token — internal calls will be unauthenticated'
                );
              }
            }

            const selection = await clientFactory.createClient(
              modelName,
              requestId,
              {
                organizationId: userContext.organizationId,
                userId: userContext.userId,
                authToken: loopbackToken,
              },
              transportPreference
            );

            if (!selection) {
              connection.send(
                JSON.stringify({
                  type: 'error',
                  error: {
                    type: 'no_realtime_transport',
                    message:
                      transportPreference === 'provider'
                        ? 'No configured provider exposes a native realtime WebSocket for the requested model. Name a model from a provider whose adapter declares a realtime transport, or drop transport="provider" to use the gateway composite session.'
                        : 'No realtime session could be established for this request.',
                    requested_model: modelName,
                    transport: transportPreference,
                  },
                })
              );
              return;
            }

            realtimeClient = selection.client;
            currentProvider = selection.provider;
            // For a provider bridge the factory resolved the concrete upstream
            // model; for the composite there is none, and reporting the
            // caller's alias back is the honest answer.
            modelName = selection.model ?? modelName;

            let connectError: string | null = null;
            try {
              if (realtimeClient instanceof GoogleLiveClient) {
                await realtimeClient.connect({
                  model: (selection.model ?? '').replace('models/', ''),
                  modalities: (sessionConfig.modalities?.map((m) => m.toUpperCase()) ?? [
                    'TEXT',
                    'AUDIO',
                  ]) as ('TEXT' | 'AUDIO')[],
                  systemInstruction: sessionConfig.instructions,
                  speechConfig: sessionConfig.voice
                    ? { voiceConfig: { prebuiltVoiceConfig: { voiceName: sessionConfig.voice } } }
                    : undefined,
                  generationConfig: { temperature: sessionConfig.temperature },
                });
              } else if (realtimeClient instanceof AilinRealtimeClient) {
                await realtimeClient.connect({
                  modalities: (sessionConfig.modalities ?? ['text', 'audio']) as (
                    'text' | 'audio'
                  )[],
                  instructions: sessionConfig.instructions,
                  voice: sessionConfig.voice ?? 'alloy',
                  temperature: sessionConfig.temperature ?? 0.8,
                  tools: sessionConfig.tools,
                  // Translation is handled by RealtimeTranslationAdapter (separate path above)
                });
              } else if (realtimeClient instanceof OpenAIRealtimeClient) {
                await realtimeClient.connect({
                  model: selection.model ?? '',
                  modalities: (sessionConfig.modalities ?? ['text', 'audio']) as (
                    'text' | 'audio'
                  )[],
                  instructions: sessionConfig.instructions,
                  voice: (sessionConfig.voice ?? 'alloy') as string,
                  temperature: sessionConfig.temperature ?? 1,
                });
              }
              log.info(
                {
                  requestId,
                  model: modelName,
                  provider: currentProvider,
                  transport: selection.transport,
                  transportKind: selection.transportKind,
                },
                'Realtime connection established'
              );
            } catch (err) {
              connectError = err instanceof Error ? err.message : 'Connection failed';
              log.warn(
                { requestId, model: modelName, provider: currentProvider, error: connectError },
                'Realtime upstream connect failed'
              );
              realtimeClient.disconnect();
              realtimeClient = null;
            }

            if (!realtimeClient || connectError) {
              connection.send(
                JSON.stringify({
                  type: 'error',
                  error: {
                    type: 'connection_failed',
                    message: connectError || 'No realtime model available',
                  },
                })
              );
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
                  // `provider` = a native upstream realtime session;
                  // `composite` = the gateway's STT->chat->TTS pipeline. The
                  // client needs this to know whether it is getting true
                  // speech-to-speech or a text round-trip.
                  transport: selection.transport,
                  transport_kind: selection.transportKind,
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
          log.error({ requestId, error: errorMessage }, 'Error handling WebSocket message');
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
          } catch {
            /* connection may have closed */
          }
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
    client.on('response.audio.delta', (data: unknown) =>
      forwardEvent('response.audio.delta', data)
    );
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
    client.on('translation.text.original', (data: unknown) =>
      forwardEvent('translation.text.original', data)
    );
    client.on('translation.text.translated', (data: unknown) =>
      forwardEvent('translation.text.translated', data)
    );

    // VAD events (server-side voice activity detection)
    client.on('input_audio_buffer.speech_started', (data: unknown) =>
      forwardEvent('input_audio_buffer.speech_started', data)
    );
    client.on('input_audio_buffer.speech_stopped', (data: unknown) =>
      forwardEvent('input_audio_buffer.speech_stopped', data)
    );

    // STT transcription events (batch path — legacy)
    client.on('conversation.item.input_audio_transcription.completed', (data: unknown) =>
      forwardEvent('conversation.item.input_audio_transcription.completed', data)
    );

    // STT transcription events (streaming path — Deepgram phrase-level)
    client.on('stt.transcription', (data: unknown) => forwardEvent('stt.transcription', data));

    // Adapter diagnostic event
    client.on('translation.adapter.status', (data: unknown) =>
      forwardEvent('translation.adapter.status', data)
    );
  }
}
