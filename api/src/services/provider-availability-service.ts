// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { logger } from '@/utils/logger';

type ProviderStatusType = 'available' | 'missing_credentials' | 'invalid_credentials' | 'degraded';

export interface ProviderStatus {
  status: ProviderStatusType;
  reason?: string;
  missingEnv?: string[];
  lastUpdated: Date;
}

interface ProviderRequirement {
  displayName: string;
  requiredEnv: string[];
  optionalEnv?: string[];
}

const PROVIDER_ENV_REQUIREMENTS: Record<string, ProviderRequirement> = {
  openai: {
    displayName: 'OpenAI',
    requiredEnv: ['OPENAI_API_KEY'],
  },
  anthropic: {
    displayName: 'Anthropic',
    requiredEnv: ['ANTHROPIC_API_KEY'],
  },
  google: {
    displayName: 'Google Generative AI',
    requiredEnv: ['GOOGLE_API_KEY'],
    optionalEnv: ['GOOGLE_GENAI_API_KEY'],
  },
  'vertex-ai': {
    displayName: 'Vertex AI',
    requiredEnv: ['VERTEX_AI_PROJECT_ID', 'VERTEX_AI_LOCATION'],
    optionalEnv: ['VERTEX_AI_API_KEY', 'GOOGLE_GENAI_API_KEY', 'GOOGLE_API_KEY'],
  },
  'azure-openai': {
    displayName: 'Azure OpenAI',
    requiredEnv: ['AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT'],
    optionalEnv: ['AZURE_OPENAI_DEPLOYMENT', 'AZURE_OPENAI_API_VERSION'],
  },
  deepseek: {
    displayName: 'DeepSeek',
    requiredEnv: ['DEEPSEEK_API_KEY'],
  },
  mistral: {
    displayName: 'Mistral AI',
    requiredEnv: ['MISTRAL_API_KEY'],
  },
  xai: {
    displayName: 'xAI',
    requiredEnv: ['XAI_API_KEY'],
  },
  cohere: {
    displayName: 'Cohere',
    requiredEnv: ['COHERE_API_KEY'],
  },
  nvidia: {
    displayName: 'NVIDIA',
    requiredEnv: ['NVIDIA_API_KEY'],
    optionalEnv: ['NVIDIA_BASE_URL'],
  },
  'nvidia-hub': {
    displayName: 'NVIDIA Hub',
    requiredEnv: ['NVIDIA_API_KEY'],
    optionalEnv: ['NVIDIA_HUB_BASE_URL'],
  },
  aihubmix: {
    displayName: 'AiHubMix',
    requiredEnv: ['AIHUBMIX_API_KEY'],
    optionalEnv: ['AIHUBMIX_BASE_URL'],
  },
  novita: {
    displayName: 'Novita',
    requiredEnv: ['NOVITA_API_KEY'],
    optionalEnv: ['NOVITA_BASE_URL'],
  },
  moonshot: {
    displayName: 'Moonshot AI',
    requiredEnv: ['MOONSHOT_API_KEY'],
    optionalEnv: ['MOONSHOT_BASE_URL'],
  },
  minimax: {
    displayName: 'MiniMax',
    requiredEnv: ['MINIMAX_API_KEY'],
    optionalEnv: ['MINIMAX_BASE_URL'],
  },
  jina: {
    displayName: 'Jina AI',
    requiredEnv: ['JINA_API_KEY'],
    optionalEnv: ['JINA_API_BASE_URL', 'JINA_DEEPSEARCH_BASE_URL'],
  },
  friendli: {
    displayName: 'Friendli',
    requiredEnv: ['FRIENDLI_API_KEY'],
    optionalEnv: ['FRIENDLI_BASE_URL', 'FRIENDLI_TEAM_ID'],
  },
  aiml: {
    displayName: 'AIML API',
    requiredEnv: ['AIML_API_KEY'],
    optionalEnv: ['AIML_BASE_URL', 'AIML_MODELS_BASE_URL'],
  },
  imagerouter: {
    displayName: 'ImageRouter',
    requiredEnv: ['IMAGEROUTER_API_KEY'],
    optionalEnv: ['IMAGEROUTER_BASE_URL'],
  },
  openrouter: {
    displayName: 'OpenRouter',
    requiredEnv: ['OPENROUTER_API_KEY'],
  },
  orqai: {
    displayName: 'ORQ.ai',
    requiredEnv: ['ORQAI_API_KEY'],
  },
  edenai: {
    displayName: 'Eden AI',
    requiredEnv: ['EDENAI_API_KEY'],
  },
  heliconeai: {
    displayName: 'Helicone AI Gateway',
    requiredEnv: ['HELICONEAI_API_KEY'],
  },
  'aws-bedrock': {
    displayName: 'AWS Bedrock',
    // AWS_ACCESS_KEY_ID is the canonical SDK key; AWS_BEARER_TOKEN_BEDROCK is
    // the alternate Bedrock-direct auth (newer 2024 path). Only one is
    // required; the SDK credential chain will pick whichever is present
    // (and fall through to instance/role credentials when neither is set).
    requiredEnv: ['AWS_ACCESS_KEY_ID'],
    optionalEnv: ['AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK', 'AWS_BEDROCK_REGION', 'AWS_REGION', 'AWS_BEDROCK_INFERENCE_PROFILE_ARN'],
  },
  oci: {
    displayName: 'Oracle OCI Generative AI',
    requiredEnv: ['OCI_TENANCY_ID', 'OCI_USER_ID', 'OCI_FINGERPRINT', 'OCI_PRIVATE_KEY', 'OCI_REGION'],
  },
  // ── 2026-05-06 closure batch ──────────────────────────────────────────
  // Adapters/factories already registered (via catalog or factory registry);
  // adding rows here surfaces them to the /providers diagnostic view and
  // gives an explicit boot-time signal when a key is missing.
  alibaba: {
    displayName: 'Alibaba Cloud (Dashscope / Qwen)',
    requiredEnv: ['QWEN_API_KEY'],
    optionalEnv: ['DASHSCOPE_BASE_URL', 'ALIBABA_ACCESS_KEY_ID', 'ALIBABA_ACCESS_KEY_SECRET'],
  },
  cometapi: {
    displayName: 'CometAPI',
    requiredEnv: ['COMETAPI_API_KEY'],
    optionalEnv: ['COMETAPI_BASE_URL'],
  },
  routeway: {
    displayName: 'Routeway',
    requiredEnv: ['ROUTEWAY_API_KEY'],
    optionalEnv: ['ROUTEWAY_BASE_URL'],
  },
  upstage: {
    displayName: 'Upstage',
    requiredEnv: ['UPSTAGE_API_KEY'],
  },
  voyage: {
    displayName: 'Voyage AI',
    requiredEnv: ['VOYAGE_API_KEY'],
  },
  replicate: {
    displayName: 'Replicate',
    requiredEnv: ['REPLICATE_API_KEY'],
    optionalEnv: ['REPLICATE_BASE_URL'],
  },
  inworld: {
    displayName: 'Inworld AI',
    requiredEnv: ['INWORLD_API_KEY'],
  },
  bfl: {
    displayName: 'Black Forest Labs (FLUX)',
    requiredEnv: ['BFL_API_KEY'],
  },
  v0: {
    displayName: 'v0 (Vercel)',
    requiredEnv: ['V0_API_KEY'],
  },
  runwayml: {
    displayName: 'RunwayML',
    requiredEnv: ['RUNWAYML_API_KEY'],
  },
  recraft: {
    displayName: 'Recraft',
    requiredEnv: ['RECRAFT_API_KEY'],
  },
  topaz: {
    displayName: 'Topaz Labs',
    requiredEnv: ['TOPAZ_API_KEY'],
  },
  databricks: {
    displayName: 'Databricks Model Serving',
    requiredEnv: ['DATABRICKS_TOKEN'],
    optionalEnv: ['DATABRICKS_HOST', 'DATABRICKS_SERVING_ENDPOINT'],
  },
};

class ProviderAvailabilityService {
  private statuses = new Map<string, ProviderStatus>();
  private log = logger.child({ component: 'provider-availability' });

  initializeFromEnv(): void {
    Object.entries(PROVIDER_ENV_REQUIREMENTS).forEach(([provider, requirement]) => {
      const missing = this.getMissingEnv(requirement.requiredEnv);

      if (missing.length > 0) {
        this.setStatus(provider, 'missing_credentials', `Missing env vars: ${missing.join(', ')}`, missing);
      } else {
        this.setStatus(provider, 'available');
      }
    });
  }

  logSummary(): void {
    const missing = Array.from(this.statuses.entries()).filter(
      ([, status]) => status.status === 'missing_credentials'
    );

    if (missing.length === 0) {
      this.log.info('All tracked providers have the required credentials configured');
      return;
    }

    this.log.info(
      {
        providers: missing.map(([provider, status]) => ({
          provider,
          reason: status.reason,
          missingEnv: status.missingEnv,
        })),
      },
      'Optional providers are missing credentials and will be skipped until configured'
    );
  }

  isProviderUsable(provider: string): boolean {
    const status = this.statuses.get(provider);
    if (!status) {
      return true;
    }

    return status.status === 'available';
  }

  getStatus(provider: string): ProviderStatus | undefined {
    return this.statuses.get(provider);
  }

  getSnapshot(): Record<string, ProviderStatus> {
    const snapshot: Record<string, ProviderStatus> = {};
    this.statuses.forEach((value, key) => {
      snapshot[key] = value;
    });
    return snapshot;
  }

  markInvalidCredentials(provider: string, reason: string): void {
    this.setStatus(provider, 'invalid_credentials', reason);
  }

  markDegraded(provider: string, reason: string): void {
    this.setStatus(provider, 'degraded', reason);
  }

  markAvailable(provider: string): void {
    this.setStatus(provider, 'available');
  }

  private setStatus(
    provider: string,
    status: ProviderStatusType,
    reason?: string,
    missingEnv?: string[]
  ): void {
    const current = this.statuses.get(provider);
    if (current && current.status === status && current.reason === reason) {
      return;
    }

    const nextStatus: ProviderStatus = {
      status,
      reason,
      missingEnv,
      lastUpdated: new Date(),
    };

    this.statuses.set(provider, nextStatus);

    if (status === 'available') {
      this.log.info({ provider }, 'Provider marked as available');
    } else if (status === 'missing_credentials') {
      this.log.info({ provider, status, reason, missingEnv }, 'Provider skipped due to missing optional credentials');
    } else {
      this.log.warn({ provider, status, reason, missingEnv }, 'Provider marked as unavailable');
    }
  }

  private getMissingEnv(envVars: string[]): string[] {
    return envVars.filter((envVar) => {
      const value = process.env[envVar];
      return !value || value.trim().length === 0;
    });
  }
}

export const providerAvailabilityService = new ProviderAvailabilityService();
export { PROVIDER_ENV_REQUIREMENTS };

