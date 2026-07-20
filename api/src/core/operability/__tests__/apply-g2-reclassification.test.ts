// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-G2 — Tests for the static G→G2 reclassification migrator.
 *
 * These tests pin each migration path (capability-kind override, budget
 * skip, pass-through, auth refinement, model-not-supported resolution,
 * unknown refinement). They run against synthetic G-audit records so we
 * never depend on a real audit JSON file.
 */
import { describe, it, expect } from 'vitest';
import {
  applyG2Reclassification,
  type GAuditRecordLike,
} from '../apply-g2-reclassification';

function rec(partial: Partial<GAuditRecordLike> & { providerId: string; bucket: string }): GAuditRecordLike {
  return {
    adapterRegistered: true,
    adapterInstantiable: true,
    secretsResolvedFromGcp: true,
    discoverySupported: true,
    discoveryReady: true,
    chatProbeAttempted: true,
    chatReady: false,
    ...partial,
  };
}

describe('applyG2Reclassification — capability-kind override', () => {
  it('reclassifies deepgram (STT) to N even when G said unknown', () => {
    const out = applyG2Reclassification({
      gAudit: [rec({ providerId: 'deepgram', bucket: 'unknown' })],
    });
    expect(out.records[0].bucketG2).toBe('N_specialized_non_chat_provider');
    expect(out.records[0].reclassified).toBe(true);
  });

  it('reclassifies elevenlabs (TTS) to N even when G said H', () => {
    const out = applyG2Reclassification({
      gAudit: [rec({
        providerId: 'elevenlabs',
        bucket: 'H_registered_adapter_ready_model_not_supported',
        errorKind: 'model_not_supported',
      })],
    });
    expect(out.records[0].bucketG2).toBe('N_specialized_non_chat_provider');
  });

  it('reclassifies voyage (embeddings) to N', () => {
    const out = applyG2Reclassification({
      gAudit: [rec({ providerId: 'voyage', bucket: 'unknown' })],
    });
    expect(out.records[0].bucketG2).toBe('N_specialized_non_chat_provider');
  });
});

describe('applyG2Reclassification — pass-through buckets', () => {
  it('A_registered_and_chat_ready → A_chat_ready', () => {
    const out = applyG2Reclassification({
      gAudit: [rec({
        providerId: 'somechatprovider',
        bucket: 'A_registered_and_chat_ready',
        chatReady: true,
      })],
    });
    expect(out.records[0].bucketG2).toBe('A_chat_ready');
    expect(out.records[0].g2RecommendedFix).toBeNull();
  });

  it('C_…blocked_by_credit → C_blocked_by_credit', () => {
    const out = applyG2Reclassification({
      gAudit: [rec({
        providerId: 'somechatprovider',
        bucket: 'C_registered_adapter_ready_blocked_by_credit',
        errorKind: 'insufficient_credits',
      })],
    });
    expect(out.records[0].bucketG2).toBe('C_blocked_by_credit');
    expect(out.records[0].g2RecommendedFix).toBe('top_up_provider_balance');
  });

  it('I_…adapter_missing → I_adapter_missing', () => {
    const out = applyG2Reclassification({
      gAudit: [rec({
        providerId: 'somechatprovider',
        bucket: 'I_registered_but_adapter_missing',
        adapterRegistered: false,
      })],
    });
    expect(out.records[0].bucketG2).toBe('I_adapter_missing');
  });

  it('J_…secret_missing → J_secret_missing', () => {
    const out = applyG2Reclassification({
      gAudit: [rec({
        providerId: 'somechatprovider',
        bucket: 'J_registered_but_secret_missing',
        secretsResolvedFromGcp: false,
      })],
    });
    expect(out.records[0].bucketG2).toBe('J_secret_missing');
  });
});

describe('applyG2Reclassification — auth refinement', () => {
  it('D auth-blocked with no hint stays D_blocked_by_auth_confirmed', () => {
    const out = applyG2Reclassification({
      gAudit: [rec({
        providerId: 'aihubmix',
        bucket: 'D_registered_adapter_ready_blocked_by_auth',
        errorKind: 'invalid_auth',
      })],
    });
    expect(out.records[0].bucketG2).toBe('D_blocked_by_auth_confirmed');
  });

  it('promotes to R when secret-alias mismatch hinted', () => {
    const out = applyG2Reclassification({
      gAudit: [rec({
        providerId: 'novita',
        bucket: 'D_registered_adapter_ready_blocked_by_auth',
        errorKind: 'invalid_auth',
      })],
      secretAliasMismatched: ['novita'],
    });
    expect(out.records[0].bucketG2).toBe('R_secret_alias_mismatch');
  });

  it('promotes to Q when auth-header / base-url mismatch hinted', () => {
    const out = applyG2Reclassification({
      gAudit: [rec({
        providerId: 'phala',
        bucket: 'D_registered_adapter_ready_blocked_by_auth',
        errorKind: 'invalid_auth',
      })],
      authHeaderMismatched: ['phala'],
    });
    expect(out.records[0].bucketG2).toBe('Q_auth_header_or_base_url_mismatch');
  });

  it('promotes to S when deployment-required hinted', () => {
    const out = applyG2Reclassification({
      gAudit: [rec({
        providerId: 'azure-openai',
        bucket: 'D_registered_adapter_ready_blocked_by_auth',
        errorKind: 'invalid_auth',
      })],
      requiresDeployment: ['azure-openai'],
    });
    expect(out.records[0].bucketG2).toBe('S_provider_requires_deployment_or_endpoint');
  });
});

describe('applyG2Reclassification — model_not_supported refinement', () => {
  it('reclassifies H → G when sampleModelId has double-prefix alias signal', () => {
    const out = applyG2Reclassification({
      gAudit: [rec({
        providerId: 'openai',
        bucket: 'H_registered_adapter_ready_model_not_supported',
        errorKind: 'model_not_supported',
        sampleModelId: 'openai/openai-gpt-5.1-mini',
        lastSanitizedMessage: 'model not found',
      })],
    });
    expect(out.records[0].bucketG2).toBe('G_model_alias_mismatch_probable');
  });

  it('reclassifies H → G when resolver finds catalog_alias', () => {
    const out = applyG2Reclassification({
      gAudit: [rec({
        providerId: 'openai',
        bucket: 'H_registered_adapter_ready_model_not_supported',
        errorKind: 'model_not_supported',
        sampleModelId: 'gpt-4o',  // no alias signal on its own
      })],
      catalogLookup: (pid) =>
        pid === 'openai'
          ? [{ id: 'openai/openai-gpt-5.1-mini', capabilities: ['chat'] }]
          : [],
    });
    expect(out.records[0].bucketG2).toBe('G_model_alias_mismatch_probable');
    expect(out.records[0].canonicalProbeApiModelId).toBe('gpt-5.1-mini');
    expect(out.records[0].canonicalProbeSource).toBe('catalog_alias');
  });

  it('keeps H when no alias signal and resolver has no alias-mappable catalog', () => {
    const out = applyG2Reclassification({
      gAudit: [rec({
        providerId: 'deepseek',
        bucket: 'H_registered_adapter_ready_model_not_supported',
        errorKind: 'model_not_supported',
        sampleModelId: 'deepseek-something-rare',
      })],
      catalogLookup: () => [{ id: 'deepseek-chat', capabilities: ['chat'] }],
    });
    expect(out.records[0].bucketG2).toBe('H_model_not_supported_confirmed');
  });
});

describe('applyG2Reclassification — unknown refinement', () => {
  it('unknown without adapter → I_adapter_missing', () => {
    const out = applyG2Reclassification({
      gAudit: [rec({
        providerId: 'newprovider',
        bucket: 'unknown',
        adapterRegistered: false,
      })],
    });
    expect(out.records[0].bucketG2).toBe('I_adapter_missing');
  });

  it('unknown with no chat probe + discovery ready → B', () => {
    const out = applyG2Reclassification({
      gAudit: [rec({
        providerId: 'newprovider',
        bucket: 'unknown',
        chatProbeAttempted: false,
        discoveryReady: true,
      })],
    });
    expect(out.records[0].bucketG2).toBe('B_discovery_ready_chat_not_probed');
  });

  it('unknown with no chat probe + discovery FAILED → U', () => {
    const out = applyG2Reclassification({
      gAudit: [rec({
        providerId: 'newprovider',
        bucket: 'unknown',
        chatProbeAttempted: false,
        discoveryReady: false,
      })],
    });
    expect(out.records[0].bucketG2).toBe('U_discovery_supported_but_empty');
  });

  it('unknown with no chat probe + discovery null → O (no catalog binding)', () => {
    const out = applyG2Reclassification({
      gAudit: [rec({
        providerId: 'newprovider',
        bucket: 'unknown',
        chatProbeAttempted: false,
        discoveryReady: null,
      })],
    });
    expect(out.records[0].bucketG2).toBe('O_no_catalog_model_bound_to_provider');
  });

  it('unknown with catalog-id mismatch hint → P', () => {
    const out = applyG2Reclassification({
      gAudit: [rec({
        providerId: 'sambanova',
        bucket: 'unknown',
        chatProbeAttempted: true,  // probe ran but cross-provider leakage
      })],
      catalogIdMismatched: ['sambanova'],
    });
    expect(out.records[0].bucketG2).toBe('P_provider_id_catalog_mismatch');
  });

  it('unknown with no hints → V_unknown_unclassified', () => {
    const out = applyG2Reclassification({
      gAudit: [rec({
        providerId: 'mysterious',
        bucket: 'unknown',
        chatProbeAttempted: true,
      })],
    });
    expect(out.records[0].bucketG2).toBe('V_unknown_unclassified');
  });
});

describe('applyG2Reclassification — budget-skipped detection', () => {
  it('promotes provider from caller-supplied skippedByBudget list to T', () => {
    const out = applyG2Reclassification({
      gAudit: [rec({ providerId: 'cohere', bucket: 'unknown' })],
      skippedByBudget: ['cohere'],
    });
    expect(out.records[0].bucketG2).toBe('T_probe_skipped_by_budget_or_policy');
  });
});

describe('applyG2Reclassification — distribution + diff invariants', () => {
  it('distributionBefore + distributionAfter total to same provider count', () => {
    const out = applyG2Reclassification({
      gAudit: [
        rec({ providerId: 'openai', bucket: 'A_registered_and_chat_ready', chatReady: true }),
        rec({ providerId: 'deepgram', bucket: 'unknown' }),
        rec({ providerId: 'newprov', bucket: 'unknown', adapterRegistered: false }),
      ],
    });
    const totalBefore = Object.values(out.distributionBefore).reduce((a, b) => a + b, 0);
    const totalAfter = Object.values(out.distributionAfter).reduce((a, b) => a + b, 0);
    expect(totalBefore).toBe(3);
    expect(totalAfter).toBe(3);
  });

  it('diff only contains providers whose bucket actually changed', () => {
    const out = applyG2Reclassification({
      gAudit: [
        rec({ providerId: 'openai', bucket: 'A_registered_and_chat_ready', chatReady: true }),
        rec({ providerId: 'deepgram', bucket: 'unknown' }),
      ],
    });
    // openai: A_registered_and_chat_ready → A_chat_ready (different name, changed)
    // deepgram: unknown → N (changed)
    expect(out.diff).toHaveLength(2);
    expect(out.diff.find((d) => d.providerId === 'deepgram')?.to).toBe('N_specialized_non_chat_provider');
  });
});
