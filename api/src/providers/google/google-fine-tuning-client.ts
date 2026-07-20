// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Google Gemini Fine-tuning (Tuning) Client
 *
 * Thin, typed wrapper around the REAL Google Generative Language tuning API
 * (`https://generativelanguage.googleapis.com/v1beta/tunedModels`). This is
 * the same surface the Gemini API exposes for supervised tuning of base
 * models (e.g. `models/gemini-1.5-flash-001-tuning`).
 *
 * Responsibilities (mirrors what the OpenAI SDK gives us for free):
 *  - create a tuning job (returns a long-running Operation whose metadata
 *    carries the `tunedModel` resource name → our providerJobId)
 *  - fetch a tuned model's current state (CREATING/ACTIVE/FAILED → normalized)
 *  - delete/cancel a tuned model
 *  - surface per-step tuning snapshots (mapped to events + checkpoints)
 *
 * NO MOCKS, NO PLACEHOLDERS — every method hits the real endpoint. Tests mock
 * `fetch` (via the injectable `fetchImpl`) so no live calls happen in CI.
 */

const GOOGLE_TUNING_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta';

/**
 * Injectable fetch — defaults to the global fetch. Tests pass a mock so no
 * real network calls happen.
 */
export type FetchImpl = typeof fetch;

/**
 * Normalized tuning lifecycle state, aligned with the OpenAI/normalized
 * fine-tuning status vocabulary used across providers.
 */
export type NormalizedTuningStatus =
  | 'validating_files'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

/**
 * Google TunedModel `state` enum (subset we care about).
 * @see https://ai.google.dev/api/tuning#State
 */
export type GoogleTunedModelState =
  | 'STATE_UNSPECIFIED'
  | 'CREATING'
  | 'ACTIVE'
  | 'FAILED';

/**
 * Per-step tuning metrics snapshot returned by the Gemini tuning API.
 */
export interface GoogleTuningSnapshot {
  step?: number;
  epoch?: number;
  meanLoss?: number;
  computeTime?: string;
}

/**
 * Hyperparameters block accepted by the Gemini tuning task.
 */
export interface GoogleTuningHyperparameters {
  epochCount?: number;
  batchSize?: number;
  learningRateMultiplier?: number;
  learningRate?: number;
}

/**
 * Single training example in the Gemini tuning dataset.
 */
export interface GoogleTuningExample {
  textInput: string;
  output: string;
}

export interface CreateGoogleTuningJobParams {
  /** Base model resource, e.g. `models/gemini-1.5-flash-001-tuning`. */
  baseModel: string;
  /** Display name for the resulting tuned model. */
  displayName?: string;
  hyperparameters?: GoogleTuningHyperparameters;
  /** Supervised training examples. */
  examples: GoogleTuningExample[];
}

/**
 * Shape of a Gemini TunedModel resource (fields we read).
 */
export interface GoogleTunedModel {
  name?: string;
  displayName?: string;
  state?: GoogleTunedModelState;
  createTime?: string;
  updateTime?: string;
  tuningTask?: {
    startTime?: string;
    completeTime?: string;
    snapshots?: GoogleTuningSnapshot[];
    hyperparameters?: GoogleTuningHyperparameters;
  };
  error?: { code?: number; message?: string; status?: string };
}

/**
 * Long-running Operation returned by tunedModels.create.
 */
export interface GoogleTuningOperation {
  name?: string;
  done?: boolean;
  metadata?: {
    tunedModel?: string;
    totalSteps?: number;
    completedSteps?: number;
    [key: string]: unknown;
  };
  response?: GoogleTunedModel;
  error?: { code?: number; message?: string; status?: string };
}

/**
 * Error thrown when the Google credential/project is not configured. The
 * service translates this into a 503 `provider_not_configured` response.
 */
export class GoogleTuningNotConfiguredError extends Error {
  readonly statusCode = 503;
  readonly code = 'provider_not_configured';
  constructor(message: string) {
    super(message);
    this.name = 'GoogleTuningNotConfiguredError';
  }
}

/**
 * Error thrown when the Gemini tuning API returns a non-2xx response.
 */
export class GoogleTuningApiError extends Error {
  readonly statusCode: number;
  readonly code = 'google_tuning_error';
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'GoogleTuningApiError';
    this.statusCode = statusCode;
  }
}

/**
 * Map a Google TunedModel state to the normalized fine-tuning status.
 *
 * - STATE_UNSPECIFIED → queued (created but no state yet)
 * - CREATING          → running (tuning in progress)
 * - ACTIVE            → succeeded (tuned model is ready)
 * - FAILED            → failed
 */
export function mapGoogleStateToNormalizedStatus(
  state: GoogleTunedModelState | string | undefined
): NormalizedTuningStatus {
  switch (state) {
    case 'ACTIVE':
      return 'succeeded';
    case 'FAILED':
      return 'failed';
    case 'CREATING':
      return 'running';
    case 'STATE_UNSPECIFIED':
    case undefined:
    case '':
      return 'queued';
    default:
      return 'queued';
  }
}

/**
 * Client for the Google Gemini tuning API.
 */
export class GoogleFineTuningClient {
  private readonly apiKey: string;
  private readonly fetchImpl: FetchImpl;
  private readonly baseUrl: string;

  constructor(options: {
    apiKey: string;
    fetchImpl?: FetchImpl;
    baseUrl?: string;
  }) {
    const apiKey = (options.apiKey || '').trim();
    if (!apiKey) {
      throw new GoogleTuningNotConfiguredError(
        'Google fine-tuning requires a configured Gemini API key (GEMINI/GOOGLE credential). ' +
          'Set the provider credential to enable tuning.'
      );
    }
    this.apiKey = apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = (options.baseUrl ?? GOOGLE_TUNING_BASE_URL).replace(/\/+$/, '');
  }

  private buildUrl(path: string): string {
    const cleanPath = path.replace(/^\/+/, '');
    const separator = cleanPath.includes('?') ? '&' : '?';
    return `${this.baseUrl}/${cleanPath}${separator}key=${encodeURIComponent(this.apiKey)}`;
  }

  private async request<T>(
    path: string,
    init: { method: string; body?: unknown }
  ): Promise<T> {
    const url = this.buildUrl(path);
    const response = await this.fetchImpl(url, {
      method: init.method,
      headers: { 'Content-Type': 'application/json' },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });

    if (!response.ok) {
      let detail = '';
      try {
        detail = await response.text();
      } catch {
        detail = '';
      }
      throw new GoogleTuningApiError(
        `Google tuning API request failed (${response.status} ${response.statusText}): ${detail.slice(
          0,
          800
        )}`,
        response.status
      );
    }

    return (await response.json()) as T;
  }

  /**
   * Create a supervised tuning job. Returns the long-running Operation whose
   * `metadata.tunedModel` is the resource name we persist as providerJobId.
   */
  async createTuningJob(
    params: CreateGoogleTuningJobParams
  ): Promise<GoogleTuningOperation> {
    const tuningTask: Record<string, unknown> = {
      trainingData: {
        examples: {
          examples: params.examples.map((example) => ({
            textInput: example.textInput,
            output: example.output,
          })),
        },
      },
    };

    if (params.hyperparameters) {
      const hp: Record<string, number> = {};
      if (typeof params.hyperparameters.epochCount === 'number') {
        hp.epochCount = params.hyperparameters.epochCount;
      }
      if (typeof params.hyperparameters.batchSize === 'number') {
        hp.batchSize = params.hyperparameters.batchSize;
      }
      if (typeof params.hyperparameters.learningRateMultiplier === 'number') {
        hp.learningRateMultiplier =
          params.hyperparameters.learningRateMultiplier;
      }
      if (typeof params.hyperparameters.learningRate === 'number') {
        hp.learningRate = params.hyperparameters.learningRate;
      }
      if (Object.keys(hp).length > 0) {
        tuningTask.hyperparameters = hp;
      }
    }

    const body: Record<string, unknown> = {
      baseModel: params.baseModel,
      tuningTask,
    };
    if (params.displayName) {
      body.displayName = params.displayName.slice(0, 40);
    }

    return this.request<GoogleTuningOperation>('tunedModels', {
      method: 'POST',
      body,
    });
  }

  /**
   * Fetch the current state of a tuned model by its resource name
   * (e.g. `tunedModels/my-model-abc123`).
   */
  async getTunedModel(tunedModelName: string): Promise<GoogleTunedModel> {
    const name = tunedModelName.replace(/^\/+/, '');
    return this.request<GoogleTunedModel>(name, { method: 'GET' });
  }

  /**
   * Delete (cancel) a tuned model by its resource name. The Gemini tuning API
   * has no separate "cancel" verb — deleting a CREATING/ACTIVE tuned model is
   * how a job is stopped/removed.
   */
  async deleteTunedModel(tunedModelName: string): Promise<void> {
    const name = tunedModelName.replace(/^\/+/, '');
    await this.request<Record<string, unknown>>(name, { method: 'DELETE' });
  }
}

export { GOOGLE_TUNING_BASE_URL };
