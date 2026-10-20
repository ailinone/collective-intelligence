// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * billing-usage-report-client.ts
 *
 * Caller ci do POST /v1/usage/report do billing (ADR-ENTITLEMENTS-CONTRACT
 * §2.2, "Caminho A"): reporta consumo acumulável por tenant no lado onde o
 * PLANO vive, fechando o ciclo que o /v1/plans/resolve abriu — até aqui os
 * limites resolvidos não tinham consumo correspondente no billing para
 * serem enforceados (Usage.current_usage nunca era incrementado por ninguém).
 *
 * Mesma filosofia de duas categorias de falha do billing-entitlements-
 * client.ts (ver aquele módulo): indisponibilidade de rede/serviço NUNCA
 * lança e NUNCA bloqueia o caminho de resposta — o report é fire-and-forget
 * pós-execução, degradar para "não reportado agora" é aceitável e o buraco
 * é fechado pelo próximo report (contadores são acumulativos, não
 * transacionais).
 *
 * ## Idempotência
 *
 * A `idempotencyKey` é o `requestId` do chat completion (única por
 * execução lógica). Retries de rede reutilizam a MESMA chave; o billing
 * aplica o lote uma única vez (tabela usage_report_events). Um 409
 * `idempotency_retry` (corrida perdida no insert) ou `idempotent: true`
 * (replay) é sucesso do ponto de vista deste caller — log info e pronto.
 *
 * ## Flag
 *
 * `BILLING_USAGE_REPORT_ENABLED` (default FALSE): o wiring existe mas
 * dormente até ligar por org/canary — mesmo padrão dos demais gates deste
 * repo (ver feedback_three_rollout_states: código mergeado com flag off é
 * estado (b), não "em produção").
 */

import { logger } from '@/utils/logger';
import { noteFailOpen } from '@/utils/metrics';
import { getBillingActorHeaders } from '@/services/billing-actor-token';
import { billableTenantId } from '@/services/billing-tenant-resolver';

const log = logger.child({ component: 'billing-usage-report-client' });

export interface UsageReportEntry {
  resourceType: string;
  amount: number;
}

const FETCH_TIMEOUT_MS = 3000;

export function isBillingUsageReportEnabled(): boolean {
  return process.env.BILLING_USAGE_REPORT_ENABLED === 'true';
}

/**
 * Reporta um lote de consumo ao billing. Retorna true quando o billing
 * confirmou aplicação (ou confirmou replay idempotente), false em qualquer
 * falha — e NUNCA lança para o caller.
 *
 * `userId` (opcional) é o ci `User.id` do usuário FINAL do org cobrado —
 * quando presente e BILLING_TENANT_MAPPING_ENABLED, o `tenant_id` (e o
 * `X-Acting-Tenant-Id` do actor token) passam a ser o tenant canônico do id
 * (billing-tenant-resolver), não o UUID de org do ci. Flag off ou resolução
 * não encontrada => `organizationId` exatamente como antes.
 */
export async function reportUsageToBilling(
  organizationId: string,
  idempotencyKey: string,
  entries: UsageReportEntry[],
  userId?: string
): Promise<boolean> {
  if (!organizationId || !idempotencyKey || entries.length === 0) {
    return false;
  }

  const billingUrl = (process.env.BILLING_SERVICE_URL ?? '').replace(/\/+$/, '');
  const billingSecret = process.env.BILLING_API_SECRET_KEY ?? '';
  if (!billingUrl || !billingSecret) {
    // Não configurado — categoria rede/config, não dado de negócio: no-op.
    return false;
  }

  const billableTenant = await billableTenantId(organizationId, userId);
  const actorHeaders = await getBillingActorHeaders(billableTenant);

  try {
    const response = await fetch(`${billingUrl}/v1/usage/report`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'billing-api-secret-key': billingSecret,
        ...actorHeaders,
      },
      body: JSON.stringify({
        tenant_id: billableTenant,
        idempotency_key: idempotencyKey,
        reports: entries.map((entry) => ({
          resource_type: entry.resourceType,
          amount: entry.amount,
        })),
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (response.status === 409) {
      // Corrida de insert perdida OU replay: o lote já está aplicado do
      // lado de lá sob a MESMA chave — é sucesso para este caller.
      log.info(
        { organizationId, idempotencyKey },
        'billing usage report returned 409 (already applied under this key) -- treating as success'
      );
      return true;
    }

    if (!response.ok) {
      log.warn(
        { status: response.status, organizationId },
        'billing usage report returned a non-2xx status -- dropping this batch (counters are cumulative; next report carries future usage)'
      );
      noteFailOpen('billing_usage_report_non_2xx', { organizationId, status: response.status });
      return false;
    }

    return true;
  } catch (error) {
    log.warn(
      { error, organizationId, idempotencyKey },
      'billing usage report request failed (network/timeout) -- dropping this batch'
    );
    noteFailOpen('billing_usage_report_network', { organizationId });
    return false;
  }
}
