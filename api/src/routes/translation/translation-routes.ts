// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Translation API Routes
 *
 * Real-time speech-to-speech translation via Palabra.ai + LiveKit WebRTC.
 * The ci-api creates sessions and returns LiveKit credentials.
 * Audio flows directly between the client and Palabra (not through ci-api).
 *
 * POST /v1/translation/session — Create translation session
 * DELETE /v1/translation/session/:id — Delete translation session
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { logger } from '@/utils/logger';
import { authenticate } from '@/middleware/auth-middleware';
import { getProviderRegistry } from '@/providers/provider-registry';
import { PalabraAIAdapter, type PalabraSessionRequest } from '@/providers/palabraai/palabraai-adapter';
import { getTranslationService } from '@/services/translation-service';

const log = logger.child({ module: 'translation-routes' });

export async function registerTranslationRoutes(server: FastifyInstance): Promise<void> {
  /**
   * POST /v1/translation/session
   *
   * Creates a real-time translation session.
   * Returns LiveKit room credentials for the client to connect directly.
   */
  server.post(
    '/v1/translation/session',
    {
      preHandler: authenticate,
      schema: {
        tags: ['Translation'],
        summary: 'Create real-time translation session',
        description: 'Creates a Palabra.ai translation session with LiveKit WebRTC room credentials. The client connects directly to the LiveKit room for low-latency bidirectional audio translation.',
        body: {
          type: 'object',
          required: ['sourceLanguage', 'targetLanguages'],
          properties: {
            sourceLanguage: { type: 'string', description: 'Source language code (e.g., "pt", "en", "es")' },
            targetLanguages: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
              description: 'Target language codes (e.g., ["en", "es", "fr"])',
            },
            voiceId: { type: 'string', description: 'Voice ID for TTS output (default: "default_low")' },
            sentenceSplitterEnabled: { type: 'boolean', description: 'Enable sentence splitting (default: true)' },
            translatePartialTranscriptions: { type: 'boolean', description: 'Translate partial transcriptions (default: false)' },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = typeof request.id === 'string' ? request.id : `tr-${Date.now()}`;
      const body = request.body as PalabraSessionRequest;

      log.info({
        requestId,
        source: body.sourceLanguage,
        targets: body.targetLanguages,
      }, 'Translation session requested');

      try {
        const registry = getProviderRegistry();
        const palabraAdapter = registry.get('palabraai');

        if (!palabraAdapter || !(palabraAdapter instanceof PalabraAIAdapter)) {
          return reply.status(503).send({
            error: {
              code: 'translation_provider_unavailable',
              message: 'Palabra.ai provider not configured. Set PALABRAAI_CLIENT_ID and PALABRAAI_CLIENT_SECRET.',
            },
          });
        }

        const session = await palabraAdapter.createTranslationSession(body);

        return reply.status(201).send({
          session: {
            id: session.sessionId,
            webrtcUrl: session.webrtcUrl,
            publisherToken: session.publisherToken,
            roomName: session.roomName,
            translationConfig: session.translationConfig,
            languages: session.languages,
          },
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Translation session failed';
        log.error({ requestId, error: msg }, 'Translation session creation failed');
        return reply.status(500).send({
          error: { code: 'translation_session_error', message: msg },
        });
      }
    }
  );

  /**
   * DELETE /v1/translation/session/:id
   */
  server.delete(
    '/v1/translation/session/:id',
    {
      preHandler: authenticate,
      schema: {
        tags: ['Translation'],
        summary: 'Delete translation session',
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };

      try {
        const registry = getProviderRegistry();
        const palabraAdapter = registry.get('palabraai') as PalabraAIAdapter | undefined;

        if (palabraAdapter) {
          await palabraAdapter.deleteSession(id);
        }

        return reply.status(200).send({ deleted: true, sessionId: id });
      } catch (error) {
        return reply.status(500).send({
          error: { message: error instanceof Error ? error.message : 'Delete failed' },
        });
      }
    }
  );

  // ══════════════════════════════════════════════════════════
  //  Text Translation (NLLB-200 self-hosted)
  // ══════════════════════════════════════════════════════════

  /**
   * POST /v1/translation/text
   * Translate text directly via NLLB-200 (~50ms per sentence).
   */
  server.post(
    '/v1/translation/text',
    {
      preHandler: authenticate,
      schema: {
        tags: ['Translation'],
        summary: 'Translate text (NLLB-200)',
        description: 'Fast text-to-text translation via self-hosted NLLB-200. ~50ms per sentence, 200+ languages.',
        body: {
          type: 'object',
          required: ['text', 'target_lang'],
          properties: {
            text: { type: 'string', description: 'Text to translate' },
            source_lang: { type: 'string', description: 'Source language ISO 639-1 (e.g., "en"). Auto-detected if omitted.' },
            target_lang: { type: 'string', description: 'Target language ISO 639-1 (e.g., "pt", "ja", "es")' },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as { text: string; source_lang?: string; target_lang: string };

      if (!body.text?.trim()) {
        return reply.status(400).send({ error: { message: 'Empty text' } });
      }

      try {
        const service = getTranslationService();
        const result = await service.translateText(
          body.text,
          body.source_lang || 'en',
          body.target_lang,
        );

        return reply.status(200).send({
          translated_text: result.translatedText,
          source_lang: result.sourceLang,
          target_lang: result.targetLang,
          model: result.model,
          latency_ms: result.latencyMs,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Translation failed';
        log.error({ error: msg }, 'Text translation failed');
        return reply.status(500).send({ error: { message: msg } });
      }
    }
  );

  /**
   * POST /v1/translation/batch
   * Translate multiple texts in a batch.
   */
  server.post(
    '/v1/translation/batch',
    {
      preHandler: authenticate,
      schema: {
        tags: ['Translation'],
        summary: 'Batch translate texts',
        body: {
          type: 'object',
          required: ['texts', 'target_lang'],
          properties: {
            texts: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 100 },
            source_lang: { type: 'string' },
            target_lang: { type: 'string' },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as { texts: string[]; source_lang?: string; target_lang: string };

      try {
        const service = getTranslationService();
        const results = await service.translateBatch(
          body.texts,
          body.source_lang || 'en',
          body.target_lang,
        );

        return reply.status(200).send({
          translations: results.map(r => ({
            translated_text: r.translatedText,
            model: r.model,
            latency_ms: r.latencyMs,
          })),
          source_lang: body.source_lang || 'en',
          target_lang: body.target_lang,
        });
      } catch (error) {
        return reply.status(500).send({
          error: { message: error instanceof Error ? error.message : 'Batch translation failed' },
        });
      }
    }
  );

  /**
   * GET /v1/translation/languages
   * List supported languages.
   */
  server.get(
    '/v1/translation/languages',
    {
      preHandler: authenticate,
      schema: {
        tags: ['Translation'],
        summary: 'List supported translation languages',
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const service = getTranslationService();
        const languages = await service.getLanguages();
        return reply.status(200).send({ languages, total: languages.length });
      } catch (error) {
        return reply.status(500).send({
          error: { message: error instanceof Error ? error.message : 'Failed to list languages' },
        });
      }
    }
  );

  log.info('Translation routes registered (Palabra.ai S2S + NLLB-200 text + batch)');
}
