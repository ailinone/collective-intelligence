// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Fine-tuning API Types
 * OpenAI-compatible types for Fine-tuning API
 */

import type { RequestUserContext } from './index';

export interface FineTuningHyperparameters {
  n_epochs?: number | 'auto';
  batch_size?: number | 'auto';
  learning_rate_multiplier?: number | 'auto';
}

export interface FineTuningIntegration {
  type: string;
  wandb?: {
    project: string;
    name?: string;
    entity?: string;
    tags?: string[];
  };
}

export interface CreateFineTuningJobRequest {
  training_file: string;
  validation_file?: string;
  model: string;
  hyperparameters?: FineTuningHyperparameters;
  suffix?: string;
  integrations?: FineTuningIntegration[];
  seed?: number;
  userContext: RequestUserContext;
  requestId: string;
}

export interface ListFineTuningJobsRequest {
  limit?: number;
  after?: string;
  before?: string;
  userContext: RequestUserContext;
  requestId: string;
}

export interface GetFineTuningJobRequest {
  jobId: string;
  userContext: RequestUserContext;
  requestId: string;
}

export interface CancelFineTuningJobRequest {
  jobId: string;
  userContext: RequestUserContext;
  requestId: string;
}

export interface ListFineTuningEventsRequest {
  jobId: string;
  limit?: number;
  after?: string;
  before?: string;
  userContext: RequestUserContext;
  requestId: string;
}

export interface ListFineTuningCheckpointsRequest {
  jobId: string;
  limit?: number;
  after?: string;
  before?: string;
  userContext: RequestUserContext;
  requestId: string;
}

export interface DeleteFineTuningJobRequest {
  jobId: string;
  userContext: RequestUserContext;
  requestId: string;
}

export interface FineTuningJob {
  id: string;
  object: 'fine_tuning.job';
  created_at: number;
  finished_at: number | null;
  model: string;
  fine_tuned_model: string | null;
  organization_id: string;
  result_files: string[];
  status: 'validating_files' | 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  validation_file: string | null;
  training_file: string;
  hyperparameters: FineTuningHyperparameters;
  trained_tokens: number | null;
  integrations?: FineTuningIntegration[];
  seed?: number;
  estimated_finish?: number | null;
  error?: {
    message: string;
    code: string;
    param?: string;
  };
}

export interface FineTuningEvent {
  id: string;
  object: 'fine_tuning.job.event';
  created_at: number;
  level: 'info' | 'warn' | 'error';
  message: string;
  data?: Record<string, unknown>;
}

export interface FineTuningCheckpoint {
  id: string;
  object: 'fine_tuning.job.checkpoint';
  created_at: number;
  fine_tuned_model_checkpoint: string;
  step_number: number;
  metrics: {
    step: number;
    train_loss: number;
    train_mean_token_accuracy: number;
    valid_loss?: number;
    valid_mean_token_accuracy?: number;
    full_valid_loss?: number;
    full_valid_mean_token_accuracy?: number;
  };
}

export interface ListFineTuningJobsResponse {
  jobs: FineTuningJob[];
  has_more: boolean;
}

export interface ListFineTuningEventsResponse {
  events: FineTuningEvent[];
  has_more: boolean;
}

export interface ListFineTuningCheckpointsResponse {
  checkpoints: FineTuningCheckpoint[];
  has_more: boolean;
}

export interface DeleteFineTuningJobResponse {
  id: string;
  object: 'fine_tuning.job';
  deleted: boolean;
}

