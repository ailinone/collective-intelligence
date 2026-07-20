// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { logger } from '../../utils/logger';
import { narrowAs } from '@/utils/type-guards';
import { buildAilinFallbackPrompt } from '../../core/orchestration/prompts/fallback-prompt';

export interface RealtimeSessionConfig {
  model: string;
  modalities?: ('text' | 'audio')[];
  instructions?: string;
  voice?: string;
  input_audio_format?: 'pcm16' | 'g711_ulaw' | 'g711_alaw';
  output_audio_format?: 'pcm16' | 'g711_ulaw' | 'g711_alaw';
  input_audio_transcription?: {
    model: string;
  };
  turn_detection?: {
    type: 'server_vad';
    threshold?: number;
    prefix_padding_ms?: number;
    silence_duration_ms?: number;
  };
  tools?: Array<{ type: string; [key: string]: unknown }>;
  tool_choice?: string;
  temperature?: number;
  max_response_output_tokens?: number;
}

export interface RealtimeCallConfig {
  sdp: string; // SDP offer from WebRTC
  session: {
    type: 'realtime';
    model: string;
    instructions?: string;
    modalities?: ('text' | 'audio')[];
    voice?: string;
    input_audio_format?: {
      type: string;
      rate: number;
    };
    output_audio_format?: {
      type: string;
      rate: number;
    };
    input_audio_transcription?: {
      model?: string;
    };
    turn_detection?: {
      type: 'server_vad' | 'client_vad';
      threshold?: number;
      prefix_padding_ms?: number;
      silence_duration_ms?: number;
    };
    tools?: Array<{ type: string; [key: string]: unknown }>;
    tool_choice?: 'auto' | 'none' | 'required';
    temperature?: number;
    max_output_tokens?: number;
  };
}

export interface TranscriptionSessionConfig {
  model: string;
  language?: string;
  prompt?: string;
  response_format?: 'json' | 'text' | 'srt' | 'verbose_json' | 'vtt';
  temperature?: number;
}

export interface ClientEvent {
  type: string;
  [key: string]: unknown;
}

export interface ServerEvent {
  type: string;
  event_id?: string;
  [key: string]: unknown;
}

export class OpenAIRealtimeClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private sessionConfig: RealtimeSessionConfig | null = null;
  private clientSecret: string | null = null;
  private connected = false;
  private sdpAnswer: string | null = null;
  private currentCallId: string | null = null;
  private logger = logger.child({ component: 'OpenAIRealtimeClient' });

  private baseUrl: string;

  constructor(private apiKey: string, baseUrl?: string) {
    super();
    // Default to OpenAI; providers like OpenRouter pass their own baseUrl
    this.baseUrl = (baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  }

  /**
   * Generate client secret for WebSocket authentication
   */
  async generateClientSecret(sessionConfig?: Partial<RealtimeSessionConfig>): Promise<string> {
    try {
      // Use provided model or require explicit model (no hardcoded fallback)
      if (!sessionConfig?.model) {
        throw new Error('Model is required for realtime session. Provide model in sessionConfig.');
      }

      const defaultConfig = {
        model: sessionConfig.model,
        instructions: buildAilinFallbackPrompt('openai-realtime-client.default-session-config'),
        modalities: ['text', 'audio'] as ('text' | 'audio')[],
        voice: 'alloy',
        input_audio_format: 'pcm16' as const,
        output_audio_format: 'pcm16' as const,
        input_audio_transcription: {
          model: 'whisper-1',
        },
        turn_detection: {
          type: 'server_vad' as const,
        },
        tools: [],
        tool_choice: 'auto' as const,
        temperature: 0.8,
      };

      interface ConfigWithType {
        type?: unknown;
        [key: string]: unknown;
      }
      const config: ConfigWithType = { ...defaultConfig, ...sessionConfig };

      // Remove 'type' parameter as it's causing issues
      delete config.type;

      const payload = {
        expires_after: {
          anchor: 'created_at',
          seconds: 600, // 10 minutes
        },
        session: config,
      };

      // Try the client_secrets endpoint first (official API)
      let response = await fetch(`${this.baseUrl}/realtime/client_secrets`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      // If client_secrets fails, try sessions endpoint as fallback
      if (!response.ok) {
        this.logger.warn('client_secrets endpoint failed, trying sessions endpoint');
        response = await fetch(`${this.baseUrl}/realtime/sessions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(config),
        });
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Failed to generate client secret: ${response.status} ${response.statusText} - ${errorText}`
        );
      }

      const data = (await response.json()) as {
        value?: string;
        client_secret?: { value?: string };
        secret?: string;
        expires_at?: string;
        session?: { id?: string };
        [key: string]: unknown;
      };
      this.clientSecret = data.value || data.client_secret?.value || data.secret || null;

      if (!this.clientSecret) {
        throw new Error('No client_secret returned from API');
      }

      this.logger.info('Client secret generated successfully', {
        expires_at: data.expires_at,
        session_id: data.session?.id,
      });
      return this.clientSecret;
    } catch (error) {
      this.logger.error('Failed to generate client secret', { error });
      throw error;
    }
  }

  /**
   * Create a new call session using WebRTC SDP offer
   *
   * Based on GA API documentation: POST /v1/realtime/calls with SDP as body
   *
   * NOTE: Despite using the correct GA API format, the endpoint still returns
   * "Failed to parse offer: EOF". This appears to be a limitation of the current
   * OpenAI Realtime API implementation. According to OpenAI documentation,
   * they recommend using the Agents SDK for voice agents instead of direct
   * WebRTC API calls.
   */
  async createCall(callConfig: RealtimeCallConfig): Promise<string> {
    try {
      this.logger.info('Creating WebRTC call with SDP offer (GA format)', {
        sdpLength: callConfig.sdp.length,
        model: callConfig.session.model,
        contentType: 'application/sdp',
      });

      // Use the GA API format: SDP as body with application/sdp content-type
      const response = await fetch(`${this.baseUrl}/realtime/calls`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/sdp',
        },
        body: callConfig.sdp, // SDP as raw body, not multipart
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error('Call creation failed with GA format', {
          status: response.status,
          error: errorText,
          contentType: 'application/sdp',
        });

        // Provide detailed error information
        throw new Error(
          `WebRTC call creation failed: ${response.status} ${response.statusText}. ` +
            `Error: ${errorText}. ` +
            `Note: OpenAI recommends using the Agents SDK (@openai/agents) for voice agents ` +
            `instead of direct WebRTC API calls. The Realtime API may still be in development.`
        );
      }

      // The response should be the SDP answer
      const sdpAnswer = await response.text();
      this.logger.info('Call created successfully - SDP answer received', {
        answerLength: sdpAnswer.length,
      });

      // Store the SDP answer for WebRTC connection
      this.sdpAnswer = sdpAnswer;

      // Extract call ID from response headers or generate one
      const callId = this.extractCallIdFromResponse(response) || this.generateCallId();
      this.currentCallId = callId;

      return callId;
    } catch (error) {
      this.logger.error('Failed to create WebRTC call', { error });
      throw error;
    }
  }

  /**
   * Connect to WebSocket for realtime communication.
   * Supports two auth modes:
   * 1. OpenAI native: generate client_secret → connect with ?client_secret=
   * 2. Direct (OpenRouter, etc.): connect with Authorization header (no client_secret)
   */
  async connect(sessionConfig?: RealtimeSessionConfig): Promise<void> {
    if (this.connected) {
      return;
    }

    // Require explicit model configuration (no hardcoded fallback)
    if (!sessionConfig?.model) {
      throw new Error('Model is required for realtime connection. Provide model in sessionConfig.');
    }

    // Try client_secret flow first; fall back to direct auth if endpoint doesn't exist
    let useDirectAuth = false;
    if (!this.clientSecret) {
      try {
        await this.generateClientSecret(sessionConfig);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes('404') || errMsg.includes('Not Found')) {
          this.logger.info('Provider does not support client_secrets — using direct WebSocket auth');
          useDirectAuth = true;
        } else {
          throw err;
        }
      }
    }

    this.sessionConfig = sessionConfig;

    return new Promise((resolve, reject) => {
      try {
        const wsBase = this.baseUrl.replace('https://', 'wss://').replace('http://', 'ws://');
        let wsUrl: string;
        let wsOptions: { headers?: Record<string, string> } | undefined;

        if (useDirectAuth || !this.clientSecret) {
          // Direct auth: connect with Authorization header + model in query
          wsUrl = `${wsBase}/realtime?model=${encodeURIComponent(sessionConfig.model)}`;
          wsOptions = { headers: { Authorization: `Bearer ${this.apiKey}` } };
        } else {
          // OpenAI client_secret auth
          wsUrl = `${wsBase}/realtime?client_secret=${this.clientSecret}`;
        }

        this.ws = new WebSocket(wsUrl, wsOptions);
        let settled = false;

        this.ws.onopen = () => {
          this.connected = true;
          this.logger.info('WebSocket connected — waiting for session confirmation');

          // Send session configuration
          this.send({
            type: 'session.update',
            session: this.sessionConfig,
          });

          // Timeout: if no session confirmation within 10s, reject
          setTimeout(() => {
            if (!settled) {
              settled = true;
              reject(new Error('Timeout waiting for session confirmation from upstream'));
            }
          }, 10000);
        };

        this.ws.onmessage = (event) => {
          try {
            const message = narrowAs<ServerEvent>(JSON.parse(event.data.toString()));

            // Resolve/reject on first meaningful server event
            if (!settled) {
              if (message.type === 'session.created' || message.type === 'session.updated') {
                settled = true;
                resolve();
              } else if (message.type === 'error') {
                settled = true;
                const errMsg = (message as { error?: { message?: string } }).error?.message || 'Upstream error';
                reject(new Error(errMsg));
                return; // Don't forward this error — it's handled by the catch in the caller
              }
            }

            this.handleServerEvent(message);
          } catch (error) {
            this.logger.error('Failed to parse server message', { error, data: event.data });
          }
        };

        this.ws.onclose = (event) => {
          this.connected = false;
          this.logger.info('WebSocket connection closed', {
            code: event.code,
            reason: event.reason,
          });
          this.emit('disconnected', event);
        };

        this.ws.onerror = (error) => {
          this.logger.error('WebSocket error', { error });
          reject(error);
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Connect to an existing call
   */
  private async connectToCall(callId: string): Promise<void> {
    if (!this.clientSecret) {
      throw new Error('Client secret required for call connection');
    }

    return new Promise((resolve, reject) => {
      try {
        const wsUrl = `${this.baseUrl.replace('https://', 'wss://').replace('http://', 'ws://')}/realtime/calls/${callId}?client_secret=${this.clientSecret}`;
        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
          this.connected = true;
          this.logger.info('Connected to call WebSocket', { callId });
          resolve();
        };

        this.ws.onmessage = (event) => {
          try {
            const message = narrowAs<ServerEvent>(JSON.parse(event.data.toString()));
            this.handleServerEvent(message);
          } catch (error) {
            this.logger.error('Failed to parse call message', { error, data: event.data });
          }
        };

        this.ws.onclose = (event) => {
          this.connected = false;
          this.logger.info('Call WebSocket connection closed', { callId, code: event.code });
          this.emit('call_disconnected', { callId, code: event.code, reason: event.reason });
        };

        this.ws.onerror = (error) => {
          this.logger.error('Call WebSocket error', { error, callId });
          reject(error);
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Send event to the server
   */
  send(event: ClientEvent): void {
    if (!this.ws || !this.connected) {
      throw new Error('WebSocket not connected');
    }

    this.ws.send(JSON.stringify(event));
    this.logger.debug('Event sent', { type: event.type });
  }

  /**
   * Handle server events
   */
  private handleServerEvent(event: ServerEvent): void {
    this.logger.debug('Server event received', { type: event.type });

    // Emit the event for external handling
    this.emit(event.type, event);

    // Handle specific events
    switch (event.type) {
      case 'session.created':
        this.emit('session_ready', event);
        break;

      case 'session.updated':
        this.emit('session_updated', event);
        break;

      case 'call.created':
        this.emit('call_created', event);
        break;

      case 'call.connected':
        this.emit('call_connected', event);
        break;

      case 'call.disconnected':
        this.emit('call_disconnected', event);
        break;

      case 'conversation.item.created':
        this.emit('conversation_item_created', event);
        break;

      case 'conversation.item.input_audio_transcription.completed':
        this.emit('transcription_completed', event);
        break;

      case 'response.created':
        this.emit('response_created', event);
        break;

      case 'response.output_item.added':
        this.emit('response_output_item_added', event);
        break;

      case 'response.output_item.done':
        this.emit('response_output_item_done', event);
        break;

      case 'response.done':
        this.emit('response_done', event);
        break;

      case 'error':
        this.emit('error', event);
        this.logger.error({ serverError: JSON.stringify(event) }, 'Server error event');
        break;
    }
  }

  /**
   * Send text message
   */
  sendText(text: string): void {
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: text,
          },
        ],
      },
    });
  }

  /**
   * Send audio data
   */
  sendAudio(audioData: Buffer): void {
    // Convert audio data to base64
    const audioBase64 = audioData.toString('base64');

    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_audio',
            audio: audioBase64,
          },
        ],
      },
    });
  }

  /**
   * Request a response
   */
  requestResponse(): void {
    this.send({
      type: 'response.create',
    });
  }

  /**
   * Accept incoming call via REST API
   */
  async acceptCall(callId: string, sessionConfig?: Partial<RealtimeSessionConfig>): Promise<void> {
    try {
      const payload = sessionConfig
        ? {
            type: 'realtime',
            model: sessionConfig.model || 'gpt-realtime',
            instructions:
              sessionConfig.instructions ||
              buildAilinFallbackPrompt('openai-realtime-client.accept-call'),
          }
        : {};

      const response = await fetch(`${this.baseUrl}/realtime/calls/${callId}/accept`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Failed to accept call: ${response.status} ${response.statusText} - ${errorText}`
        );
      }

      this.logger.info('Call accepted successfully via REST API', { callId });
    } catch (error) {
      this.logger.error('Failed to accept call via REST API', { error, callId });
      throw error;
    }
  }

  /**
   * Reject incoming call via REST API
   */
  async rejectCall(callId: string): Promise<void> {
    try {
      const response = await fetch(`${this.baseUrl}/realtime/calls/${callId}/reject`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Failed to reject call: ${response.status} ${response.statusText} - ${errorText}`
        );
      }

      this.logger.info('Call rejected successfully via REST API', { callId });
    } catch (error) {
      this.logger.error('Failed to reject call via REST API', { error, callId });
      throw error;
    }
  }

  /**
   * Refer call to another destination via REST API
   */
  async referCall(callId: string, targetUri: string): Promise<void> {
    try {
      const payload = { target_uri: targetUri };

      const response = await fetch(`${this.baseUrl}/realtime/calls/${callId}/refer`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Failed to refer call: ${response.status} ${response.statusText} - ${errorText}`
        );
      }

      this.logger.info('Call referred successfully via REST API', { callId, targetUri });
    } catch (error) {
      this.logger.error('Failed to refer call via REST API', { error, callId, targetUri });
      throw error;
    }
  }

  /**
   * Hang up call via REST API
   */
  async hangUpCall(callId: string): Promise<void> {
    try {
      const response = await fetch(`${this.baseUrl}/realtime/calls/${callId}/hangup`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Failed to hang up call: ${response.status} ${response.statusText} - ${errorText}`
        );
      }

      this.logger.info('Call hung up successfully via REST API', { callId });
    } catch (error) {
      this.logger.error('Failed to hang up call via REST API', { error, callId });
      throw error;
    }
  }

  /**
   * Legacy WebSocket-based call control methods (for backward compatibility)
   */
  acceptCallWebSocket(): void {
    this.send({
      type: 'call.accept',
    });
  }

  rejectCallWebSocket(): void {
    this.send({
      type: 'call.reject',
    });
  }

  hangUpCallWebSocket(): void {
    this.send({
      type: 'call.hang_up',
    });
  }

  transferCallWebSocket(to: string): void {
    this.send({
      type: 'call.transfer',
      to: to,
    });
  }

  referCallWebSocket(to: string): void {
    this.send({
      type: 'call.refer',
      to: to,
    });
  }

  /**
   * Transfer call
   */
  transferCall(to: string): void {
    this.send({
      type: 'call.transfer',
      to: to,
    });
  }

  /**
   * Update session configuration
   */
  updateSession(config: Partial<RealtimeSessionConfig>): void {
    this.sessionConfig = { ...this.sessionConfig, ...config } as RealtimeSessionConfig;

    this.send({
      type: 'session.update',
      session: this.sessionConfig,
    });
  }

  /**
   * Cancel current response
   */
  cancelResponse(): void {
    this.send({
      type: 'response.cancel',
    });
  }

  /**
   * Disconnect from WebSocket
   */
  disconnect(): void {
    if (this.ws && this.connected) {
      this.ws.close(1000, 'Client disconnect');
      this.connected = false;
      this.ws = null;
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Create transcription session
   * NOTE: Transcription session endpoint is not available in current OpenAI API
   */
  async createTranscriptionSession(_config: TranscriptionSessionConfig): Promise<string> {
    throw new Error(
      'Transcription session endpoint is not available in current OpenAI Realtime API.'
    );
  }

  /**
   * Get call information
   * NOTE: Call management endpoints are not available in current OpenAI API
   */
  async getCall(_callId: string): Promise<Record<string, unknown>> {
    throw new Error('Call management endpoints are not available in current OpenAI Realtime API.');
  }

  /**
   * List calls
   * NOTE: Call management endpoints are not available in current OpenAI API
   */
  async listCalls(): Promise<Array<Record<string, unknown>>> {
    throw new Error('Call management endpoints are not available in current OpenAI Realtime API.');
  }

  /**
   * Get current session config
   */
  getSessionConfig(): RealtimeSessionConfig | null {
    return this.sessionConfig;
  }

  /**
   * Get SDP answer from last call creation
   */
  getSDPAnswer(): string | null {
    return this.sdpAnswer;
  }

  /**
   * Get current call ID
   */
  getCurrentCallId(): string | null {
    return this.currentCallId;
  }

  /**
   * Extract call ID from response headers (Location header as per API docs)
   */
  private extractCallIdFromResponse(response: Response): string | null {
    try {
      const location = response.headers.get('location');
      if (location) {
        // Location header should contain the call ID path like /v1/realtime/calls/{call_id}
        const match = location.match(/\/calls\/([^\/]+)/);
        if (match) {
          return match[1];
        }
      }
    } catch (error) {
      this.logger.warn('Failed to extract call ID from response headers', { error });
    }
    return null;
  }

  /**
   * Extract call ID from SDP answer (fallback method)
   */
  private extractCallIdFromSDP(sdp: string): string | null {
    // Try to extract from SDP session ID or other identifiers
    const lines = sdp.split('\n');
    for (const line of lines) {
      if (line.startsWith('o=')) {
        // SDP origin line: o=<username> <session-id> <version> <network-type> <address-type> <address>
        const parts = line.split(' ');
        if (parts.length >= 2) {
          return `call_${parts[1]}`;
        }
      }
    }
    return null;
  }

  /**
   * Generate a unique call ID
   */
  private generateCallId(): string {
    return `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}
