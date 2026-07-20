// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Google Live API Client
 * Provides real-time bidirectional streaming with Google Gemini models
 *
 * Features:
 * - WebSocket-based bidirectional communication
 * - Audio streaming (input and output)
 * - Text messaging
 * - Function calling support
 * - Interruption handling
 *
 * Based on Google's Multimodal Live API specification
 */

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { narrowAs } from '@/utils/type-guards';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'google-live-client' });

// ============================================
// Types
// ============================================

export interface GoogleLiveSessionConfig {
  model: string;
  modalities?: ('TEXT' | 'AUDIO')[];
  systemInstruction?: string;
  tools?: GoogleLiveTool[];
  speechConfig?: {
    voiceConfig?: {
      prebuiltVoiceConfig?: {
        voiceName: string;
      };
    };
  };
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
    topP?: number;
    topK?: number;
  };
}

export interface GoogleLiveTool {
  functionDeclarations?: Array<{
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  }>;
  googleSearch?: Record<string, never>;
  codeExecution?: Record<string, never>;
}

interface GoogleLiveClientMessage {
  setup?: {
    model: string;
    generationConfig?: {
      responseModalities?: string[];
      speechConfig?: {
        voiceConfig?: {
          prebuiltVoiceConfig?: {
            voiceName: string;
          };
        };
      };
      temperature?: number;
      maxOutputTokens?: number;
    };
    systemInstruction?: {
      parts: Array<{ text: string }>;
    };
    tools?: GoogleLiveTool[];
  };
  clientContent?: {
    turns: Array<{
      role: 'user' | 'model';
      parts: Array<{
        text?: string;
        inlineData?: {
          mimeType: string;
          data: string;
        };
      }>;
    }>;
    turnComplete: boolean;
  };
  realtimeInput?: {
    mediaChunks: Array<{
      mimeType: string;
      data: string;
    }>;
  };
  toolResponse?: {
    functionResponses: Array<{
      id: string;
      name: string;
      response: Record<string, unknown>;
    }>;
  };
}

interface GoogleLiveServerMessage {
  setupComplete?: Record<string, never>;
  serverContent?: {
    turnComplete?: boolean;
    interrupted?: boolean;
    modelTurn?: {
      parts: Array<{
        text?: string;
        inlineData?: {
          mimeType: string;
          data: string;
        };
        functionCall?: {
          id: string;
          name: string;
          args: Record<string, unknown>;
        };
      }>;
    };
  };
  toolCall?: {
    functionCalls: Array<{
      id: string;
      name: string;
      args: Record<string, unknown>;
    }>;
  };
}

// ============================================
// Google Live API Client
// ============================================

export class GoogleLiveClient extends EventEmitter {
  private apiKey: string;
  private ws: WebSocket | null = null;
  private isConnected = false;
  private sessionConfig: GoogleLiveSessionConfig | null = null;
  private connectionPromise: Promise<void> | null = null;

  // Google Live API WebSocket endpoint
  private static readonly LIVE_API_ENDPOINT =
    'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent';

  constructor(apiKey: string) {
    super();
    this.apiKey = apiKey;
  }

  /**
   * Connect to Google Live API
   */
  async connect(config: GoogleLiveSessionConfig): Promise<void> {
    if (this.isConnected) {
      log.warn('Already connected to Google Live API');
      return;
    }

    this.sessionConfig = config;

    // Build WebSocket URL with API key
    const wsUrl = `${GoogleLiveClient.LIVE_API_ENDPOINT}?key=${this.apiKey}`;

    log.info({ model: config.model }, 'Connecting to Google Live API');

    this.connectionPromise = new Promise<void>((resolve, reject) => {
      try {
        this.ws = new WebSocket(wsUrl);

        this.ws.on('open', () => {
          log.info('WebSocket connection opened to Google Live API');
          this.sendSetupMessage(config);
        });

        this.ws.on('message', (data: Buffer | string) => {
          this.handleMessage(data, resolve);
        });

        this.ws.on('error', (error: Error) => {
          log.error({ error: error.message }, 'Google Live API WebSocket error');
          this.emit('error', error);
          reject(error);
        });

        this.ws.on('close', (code: number, reason: Buffer) => {
          log.info(
            { code, reason: reason.toString() },
            'Google Live API WebSocket closed'
          );
          this.isConnected = false;
          this.emit('close', { code, reason: reason.toString() });
        });
      } catch (error) {
        log.error({ error }, 'Failed to create WebSocket connection');
        reject(error);
      }
    });

    return this.connectionPromise;
  }

  /**
   * Send setup message to configure the session
   */
  private sendSetupMessage(config: GoogleLiveSessionConfig): void {
    const setupMessage: GoogleLiveClientMessage = {
      setup: {
        model: `models/${config.model}`,
        generationConfig: {
          responseModalities: config.modalities ?? ['TEXT', 'AUDIO'],
          speechConfig: config.speechConfig,
          temperature: config.generationConfig?.temperature,
          maxOutputTokens: config.generationConfig?.maxOutputTokens,
        },
        systemInstruction: config.systemInstruction
          ? { parts: [{ text: config.systemInstruction }] }
          : undefined,
        tools: config.tools,
      },
    };

    this.send(setupMessage);
  }

  /**
   * Handle incoming messages from Google Live API
   */
  private handleMessage(data: Buffer | string, onSetupComplete?: () => void): void {
    try {
      const messageStr = typeof data === 'string' ? data : data.toString('utf-8');
      const message = narrowAs<GoogleLiveServerMessage>(JSON.parse(messageStr));

      // Handle setup complete
      if (message.setupComplete) {
        log.info('Google Live API session setup complete');
        this.isConnected = true;
        this.emit('session.created', { model: this.sessionConfig?.model });
        if (onSetupComplete) {
          onSetupComplete();
        }
        return;
      }

      // Handle server content (model responses)
      if (message.serverContent) {
        const content = message.serverContent;

        // Handle interruption
        if (content.interrupted) {
          this.emit('response.interrupted', {});
          return;
        }

        // Handle model turn
        if (content.modelTurn?.parts) {
          for (const part of content.modelTurn.parts) {
            // Text content
            if (part.text) {
              this.emit('response.text.delta', { text: part.text });
            }

            // Audio content
            if (part.inlineData) {
              this.emit('response.audio.delta', {
                delta: part.inlineData.data,
                mimeType: part.inlineData.mimeType,
              });
            }

            // Function call
            if (part.functionCall) {
              this.emit('response.function_call', {
                id: part.functionCall.id,
                name: part.functionCall.name,
                arguments: JSON.stringify(part.functionCall.args),
              });
            }
          }
        }

        // Handle turn complete
        if (content.turnComplete) {
          this.emit('response.done', {});
        }
      }

      // Handle tool calls
      if (message.toolCall?.functionCalls) {
        for (const call of message.toolCall.functionCalls) {
          this.emit('response.function_call', {
            id: call.id,
            name: call.name,
            arguments: JSON.stringify(call.args),
          });
        }
      }
    } catch (error) {
      log.error({ error }, 'Failed to parse Google Live API message');
    }
  }

  /**
   * Send a message to Google Live API
   */
  private send(message: GoogleLiveClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      log.warn('WebSocket not connected, cannot send message');
      return;
    }

    this.ws.send(JSON.stringify(message));
  }

  /**
   * Send text input to the model
   */
  sendText(text: string): void {
    const message: GoogleLiveClientMessage = {
      clientContent: {
        turns: [
          {
            role: 'user',
            parts: [{ text }],
          },
        ],
        turnComplete: true,
      },
    };

    this.send(message);
    this.emit('input.text.sent', { text });
  }

  /**
   * Send audio chunk to the model
   */
  sendAudio(audioBuffer: Buffer, mimeType = 'audio/pcm'): void {
    const message: GoogleLiveClientMessage = {
      realtimeInput: {
        mediaChunks: [
          {
            mimeType,
            data: audioBuffer.toString('base64'),
          },
        ],
      },
    };

    this.send(message);
  }

  /**
   * Send tool response
   */
  sendToolResponse(
    callId: string,
    name: string,
    response: Record<string, unknown>
  ): void {
    const message: GoogleLiveClientMessage = {
      toolResponse: {
        functionResponses: [
          {
            id: callId,
            name,
            response,
          },
        ],
      },
    };

    this.send(message);
  }

  /**
   * Request a response from the model (commit audio buffer)
   */
  requestResponse(): void {
    // Google Live API automatically responds when turnComplete is true
    // This method is for compatibility with OpenAI Realtime API interface
    const message: GoogleLiveClientMessage = {
      clientContent: {
        turns: [],
        turnComplete: true,
      },
    };

    this.send(message);
  }

  /**
   * Cancel the current response (interrupt)
   */
  cancelResponse(): void {
    // Google Live API handles interruptions automatically
    // Sending new input will interrupt the current response
    log.info('Cancel response requested (Google Live handles this automatically)');
    this.emit('response.cancelled', {});
  }

  /**
   * Disconnect from Google Live API
   */
  disconnect(): void {
    if (this.ws) {
      log.info('Disconnecting from Google Live API');
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
    this.connectionPromise = null;
  }

  /**
   * Check if connected
   */
  get connected(): boolean {
    return this.isConnected;
  }
}

