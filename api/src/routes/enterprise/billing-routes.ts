// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import type { FastifyInstance } from 'fastify';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';
import { authenticate } from '@/middleware/auth-middleware';
import {
  requireTenantContext,
  getTenantContext,
} from '@/api/middleware/tenant-isolation-middleware';
import { requirePermission } from '@/middleware/require-permission-middleware';
import {
  createInvoice,
  createSubscription,
  getBillingConfig,
  getInvoice,
  listInvoices,
  listSubscriptions,
  markInvoicePaid,
  upsertBillingConfig,
  cancelSubscription,
  listAvailableBillingPlans,
  listPaymentMethodsForOrganization,
  createSetupIntentForOrganization,
  attachPaymentMethodToOrganization,
  detachPaymentMethodFromOrganization,
} from '@/services/billing-service';
import type {
  BillingConfig,
  BillingSubscription,
  BillingPlan,
  BillingPaymentMethod,
  BillingSetupIntent,
  CreateInvoiceRequest,
  Invoice,
  SubscriptionRequest,
} from '@/types';
import { recordSecurityEvent } from '@/services/security-audit-service';

interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
  };
}

export async function registerEnterpriseBillingRoutes(server: FastifyInstance): Promise<void> {
  const hasSchema = (schemaId: string): boolean => {
    // Fastify has getSchema method but it's not in the public types
    // We check if the method exists at runtime
    interface FastifyWithSchema {
      getSchema?: (id: string) => unknown;
    }
    const fastifyInstance = server as FastifyWithSchema;
    if (typeof fastifyInstance.getSchema === 'function') {
      return Boolean(fastifyInstance.getSchema(schemaId));
    }
    return false;
  };

  if (!hasSchema('InvoiceItem')) {
    server.addSchema({
      $id: 'InvoiceItem',
      type: 'object',
      properties: {
        id: { type: 'string' },
        description: { type: 'string' },
        quantity: { type: 'number' },
        unitPrice: { type: 'number' },
        total: { type: 'number' },
        metadata: { type: 'object' },
      },
      required: ['description', 'quantity', 'unitPrice', 'total'],
      additionalProperties: true,
    });
  }

  if (!hasSchema('Invoice')) {
    server.addSchema({
      $id: 'Invoice',
      type: 'object',
      properties: {
        id: { type: 'string' },
        organizationId: { type: 'string' },
        userId: { type: 'string' },
        periodStart: { type: 'number' },
        periodEnd: { type: 'number' },
        items: {
          type: 'array',
          items: { $ref: 'InvoiceItem' },
        },
        subtotal: { type: 'number' },
        tax: { type: 'number' },
        total: { type: 'number' },
        currency: { type: 'string' },
        status: {
          type: 'string',
          enum: ['draft', 'pending', 'paid', 'overdue', 'cancelled'],
        },
        dueDate: { type: 'number' },
        createdAt: { type: 'number' },
        paidAt: { type: 'number' },
        hostedInvoiceUrl: { type: 'string' },
        stripeInvoiceId: { type: 'string' },
        stripePaymentIntentId: { type: 'string' },
        stripeCustomerId: { type: 'string' },
        lastSyncedAt: { type: 'number' },
        metadata: { type: 'object' },
      },
      required: [
        'id',
        'organizationId',
        'periodStart',
        'periodEnd',
        'subtotal',
        'tax',
        'total',
        'currency',
        'status',
        'dueDate',
        'createdAt',
      ],
      additionalProperties: true,
    });
  }

  if (!hasSchema('BillingSubscription')) {
    server.addSchema({
      $id: 'BillingSubscription',
      type: 'object',
      properties: {
        id: { type: 'string' },
        organizationId: { type: 'string' },
        plan: { type: 'string' },
        status: { type: 'string', enum: ['active', 'cancelled', 'expired'] },
        billingCycle: { type: 'string', enum: ['monthly', 'yearly'] },
        amount: { type: 'number' },
        currency: { type: 'string' },
        startDate: { type: 'number' },
        endDate: { type: 'number' },
        priceId: { type: 'string' },
        stripeSubscriptionId: { type: 'string' },
        stripeCustomerId: { type: 'string' },
        stripeStatus: { type: 'string' },
        currentPeriodStart: { type: 'number' },
        currentPeriodEnd: { type: 'number' },
        cancelAtPeriodEnd: { type: 'boolean' },
        defaultPaymentMethodId: { type: 'string' },
        metadata: { type: 'object' },
      },
      required: [
        'id',
        'organizationId',
        'plan',
        'status',
        'billingCycle',
        'amount',
        'currency',
        'startDate',
      ],
      additionalProperties: true,
    });
  }

  server.get<{ Reply: { config: BillingConfig | null } | ApiErrorResponse }>(
    '/v1/enterprise/billing/config',
    {
      schema: {
        tags: ['Enterprise'],
        summary: 'Get billing configuration',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      },
      preHandler: [authenticate, requireTenantContext(), requirePermission('billing:read')],
    },
    async (request, reply) => {
      const { organizationId } = getTenantContext(request);
      const config = await getBillingConfig(organizationId);
      return reply.send({ config });
    }
  );

  server.get<{ Reply: { methods: BillingPaymentMethod[] } | ApiErrorResponse }>(
    '/v1/enterprise/billing/payment-methods',
    {
      schema: {
        tags: ['Enterprise'],
        summary: 'List payment methods',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        response: {
          200: {
            type: 'object',
            properties: {
              methods: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    brand: { type: 'string' },
                    last4: { type: 'string' },
                    expMonth: { type: 'number' },
                    expYear: { type: 'number' },
                    funding: { type: 'string' },
                    country: { type: 'string' },
                    customerId: { type: 'string' },
                    default: { type: 'boolean' },
                  },
                },
              },
            },
          },
        },
      },
      preHandler: [authenticate, requireTenantContext(), requirePermission('billing:read')],
    },
    async (request, reply) => {
      const { organizationId } = getTenantContext(request);
      const methods = await listPaymentMethodsForOrganization(organizationId);
      return reply.send({ methods });
    }
  );

  server.post<{ Reply: BillingSetupIntent | ApiErrorResponse }>(
    '/v1/enterprise/billing/payment-methods/setup-intent',
    {
      schema: {
        tags: ['Enterprise'],
        summary: 'Create payment method setup intent',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      },
      preHandler: [authenticate, requireTenantContext(), requirePermission('billing:update')],
    },
    async (request, reply) => {
      const { organizationId } = getTenantContext(request);
      const intent = await createSetupIntentForOrganization(organizationId);
      return reply.send(intent);
    }
  );

  server.post<{
    Body: { paymentMethodId: string; setDefault?: boolean };
    Reply: BillingPaymentMethod | ApiErrorResponse;
  }>(
    '/v1/enterprise/billing/payment-methods/attach',
    {
      schema: {
        tags: ['Enterprise'],
        summary: 'Attach payment method to organization',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        body: {
          type: 'object',
          properties: {
            paymentMethodId: { type: 'string' },
            setDefault: { type: 'boolean' },
          },
          required: ['paymentMethodId'],
          additionalProperties: false,
        },
      },
      preHandler: [authenticate, requireTenantContext(), requirePermission('billing:update')],
    },
    async (request, reply) => {
      const { organizationId } = getTenantContext(request);
      const method = await attachPaymentMethodToOrganization(
        organizationId,
        request.body.paymentMethodId,
        request.body.setDefault ?? true
      );
      return reply.send(method);
    }
  );

  server.delete<{ Params: { paymentMethodId: string }; Reply: ApiErrorResponse | void }>(
    '/v1/enterprise/billing/payment-methods/:paymentMethodId',
    {
      schema: {
        tags: ['Enterprise'],
        summary: 'Detach payment method',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      },
      preHandler: [authenticate, requireTenantContext(), requirePermission('billing:update')],
    },
    async (request, reply) => {
      const { organizationId } = getTenantContext(request);
      await detachPaymentMethodFromOrganization(organizationId, request.params.paymentMethodId);
      return reply.status(204).send();
    }
  );

  server.put<{
    Body: {
      billingEmail: string;
      paymentMethod?: string;
      defaultPaymentMethodId?: string;
      autoPay?: boolean;
      taxRate?: number;
      currency?: string;
      metadata?: Record<string, unknown>;
    };
    Reply: ApiErrorResponse | void;
  }>(
    '/v1/enterprise/billing/config',
    {
      schema: {
        tags: ['Enterprise'],
        summary: 'Update billing configuration',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        body: {
          type: 'object',
          properties: {
            billingEmail: { type: 'string', format: 'email' },
            paymentMethod: { type: 'string' },
            defaultPaymentMethodId: { type: 'string' },
            autoPay: { type: 'boolean' },
            taxRate: { type: 'number' },
            currency: { type: 'string' },
            metadata: { type: 'object' },
          },
          required: ['billingEmail'],
          additionalProperties: false,
        },
      },
      preHandler: [authenticate, requireTenantContext(), requirePermission('billing:update')],
    },
    async (request, reply) => {
      const { organizationId } = getTenantContext(request);

      await upsertBillingConfig({
        ...request.body,
        organizationId,
      });

      return reply.status(204).send();
    }
  );

  server.get<{
    Querystring: { refresh?: string };
    Reply: { plans: BillingPlan[] } | ApiErrorResponse;
  }>(
    '/v1/enterprise/billing/plans',
    {
      schema: {
        tags: ['Enterprise'],
        summary: 'List available billing plans',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            refresh: { type: 'string', enum: ['true', 'false'] },
          },
        },
      },
      preHandler: [authenticate, requireTenantContext()],
    },
    async (request, reply) => {
      getTenantContext(request); // Ensures tenant context is present
      const refresh = request.query.refresh === 'true';
      const plans = await listAvailableBillingPlans(refresh);
      return reply.send({ plans });
    }
  );

  server.post<{
    Body: Omit<CreateInvoiceRequest, 'organizationId'> & { organizationId?: string };
    Reply: Invoice | ApiErrorResponse;
  }>(
    '/v1/enterprise/billing/invoices',
    {
      schema: {
        tags: ['Enterprise'],
        summary: 'Create invoice',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        body: {
          type: 'object',
          properties: {
            organizationId: { type: 'string' },
            periodStart: { type: 'number' },
            periodEnd: { type: 'number' },
            costMetrics: { type: 'object' },
            costEvents: {
              type: 'array',
              items: { type: 'object' },
            },
            items: {
              type: 'array',
              items: { $ref: 'InvoiceItem' },
            },
            currency: { type: 'string' },
            metadata: { type: 'object' },
          },
          required: ['periodStart', 'periodEnd'],
          additionalProperties: false,
        },
        response: {
          200: { $ref: 'Invoice' },
          403: {
            type: 'object',
            properties: {
              error: {
                type: 'object',
                properties: {
                  code: { type: 'string' },
                  message: { type: 'string' },
                },
                required: ['code', 'message'],
                additionalProperties: false,
              },
            },
            required: ['error'],
            additionalProperties: false,
          },
        },
      },
      preHandler: [authenticate, requireTenantContext(), requirePermission('billing:update')],
    },
    async (request, reply) => {
      const extendedRequest = request as ExtendedFastifyRequest;
      const tenantContext = extendedRequest.tenantContext || getTenantContext(request);
      if (!tenantContext || !tenantContext.organizationId) {
        if (!reply.sent) {
          return reply.status(403).send({
            error: {
              code: 'tenant_context_required',
              message: 'Tenant context is required for this operation.',
            },
          });
        }
        return reply;
      }

      if (
        request.body.organizationId &&
        request.body.organizationId !== tenantContext.organizationId
      ) {
        await recordSecurityEvent({
          eventType: 'organization_mismatch',
          severity: 'critical',
          message: 'Attempted to create invoice for mismatched organization.',
          organizationId: tenantContext.organizationId,
          userId: tenantContext.userId,
          metadata: {
            attemptedOrganizationId: request.body.organizationId,
            route: request.url,
          },
        });
        return reply.status(403).send({
          error: {
            code: 'organization_mismatch',
            message: 'Organization in payload does not match authenticated tenant.',
          },
        });
      }

      const invoice = await createInvoice({
        ...request.body,
        organizationId: tenantContext.organizationId,
      });

      return reply.send(invoice);
    }
  );

  server.get<{ Reply: { invoices: Invoice[] } | ApiErrorResponse }>(
    '/v1/enterprise/billing/invoices',
    {
      schema: {
        tags: ['Enterprise'],
        summary: 'List invoices',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      },
      preHandler: [authenticate, requireTenantContext(), requirePermission('billing:read')],
    },
    async (request, reply) => {
      const { organizationId } = getTenantContext(request);
      const invoices = await listInvoices(organizationId);
      return reply.send({ invoices });
    }
  );

  server.get<{ Params: { invoiceId: string }; Reply: Invoice | ApiErrorResponse }>(
    '/v1/enterprise/billing/invoices/:invoiceId',
    {
      schema: {
        tags: ['Enterprise'],
        summary: 'Get invoice by ID',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        params: {
          type: 'object',
          required: ['invoiceId'],
          properties: {
            invoiceId: { type: 'string', format: 'uuid' },
          },
        },
        response: {
          200: { $ref: 'Invoice' },
          404: {
            type: 'object',
            properties: {
              error: {
                type: 'object',
                properties: {
                  code: { type: 'string' },
                  message: { type: 'string' },
                },
              },
            },
          },
        },
      },
      preHandler: [authenticate, requireTenantContext(), requirePermission('billing:read')],
    },
    async (request, reply) => {
      const { organizationId } = getTenantContext(request);
      const invoice = await getInvoice(organizationId, request.params.invoiceId);
      if (!invoice) {
        return reply.status(404).send({
          error: {
            code: 'invoice_not_found',
            message: 'Invoice not found or inaccessible.',
          },
        });
      }
      return reply.send(invoice);
    }
  );

  server.post<{ Params: { invoiceId: string } }>(
    '/v1/enterprise/billing/invoices/:invoiceId/pay',
    {
      schema: {
        tags: ['Enterprise'],
        summary: 'Mark invoice as paid',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        params: {
          type: 'object',
          required: ['invoiceId'],
          properties: {
            invoiceId: { type: 'string', format: 'uuid' },
          },
        },
      },
      preHandler: [authenticate, requireTenantContext(), requirePermission('billing:update')],
    },
    async (request, reply) => {
      const { organizationId } = getTenantContext(request);
      await markInvoicePaid(organizationId, request.params.invoiceId);
      return reply.status(204).send();
    }
  );

  server.post<{
    Body: Omit<SubscriptionRequest, 'organizationId'> & { organizationId?: string };
    Reply: BillingSubscription | ApiErrorResponse;
  }>(
    '/v1/enterprise/billing/subscriptions',
    {
      schema: {
        tags: ['Enterprise'],
        summary: 'Create subscription',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        body: {
          type: 'object',
          required: ['plan', 'billingCycle'],
          properties: {
            organizationId: { type: 'string' },
            plan: { type: 'string' },
            billingCycle: { type: 'string', enum: ['monthly', 'yearly'] },
            amount: { type: 'number', minimum: 0 },
            currency: { type: 'string' },
            paymentMethodId: { type: 'string' },
            priceId: { type: 'string' },
            trialDays: { type: 'number', minimum: 0 },
            cancelAtPeriodEnd: { type: 'boolean' },
            metadata: { type: 'object' },
          },
          additionalProperties: false,
        },
        response: {
          200: { $ref: 'BillingSubscription' },
          403: {
            type: 'object',
            properties: {
              error: {
                type: 'object',
                properties: {
                  code: { type: 'string' },
                  message: { type: 'string' },
                },
                required: ['code', 'message'],
                additionalProperties: false,
              },
            },
            required: ['error'],
            additionalProperties: false,
          },
        },
      },
      preHandler: [authenticate, requireTenantContext(), requirePermission('billing:update')],
    },
    async (request, reply) => {
      const extendedRequest = request as ExtendedFastifyRequest;
      const tenantContext = extendedRequest.tenantContext || getTenantContext(request);
      if (!tenantContext || !tenantContext.organizationId) {
        if (!reply.sent) {
          return reply.status(403).send({
            error: {
              code: 'tenant_context_required',
              message: 'Tenant context is required for this operation.',
            },
          });
        }
        return reply;
      }

      if (
        request.body.organizationId &&
        request.body.organizationId !== tenantContext.organizationId
      ) {
        await recordSecurityEvent({
          eventType: 'organization_mismatch',
          severity: 'critical',
          message: 'Attempted to create subscription for mismatched organization.',
          organizationId: tenantContext.organizationId,
          userId: tenantContext.userId,
          metadata: {
            attemptedOrganizationId: request.body.organizationId,
            route: request.url,
          },
        });
        return reply.status(403).send({
          error: {
            code: 'organization_mismatch',
            message: 'Organization in payload does not match authenticated tenant.',
          },
        });
      }

      const { organizationId: _ignoredOrgId, ...payload } = request.body;

      const subscription = await createSubscription({
        ...payload,
        organizationId: tenantContext.organizationId,
      });

      return reply.send(normalizeSubscriptionResponse(subscription, tenantContext.organizationId));
    }
  );

  server.get<{ Reply: { subscriptions: BillingSubscription[] } | ApiErrorResponse }>(
    '/v1/enterprise/billing/subscriptions',
    {
      schema: {
        tags: ['Enterprise'],
        summary: 'List subscriptions',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      },
      preHandler: [authenticate, requireTenantContext(), requirePermission('billing:read')],
    },
    async (request, reply) => {
      const { organizationId } = getTenantContext(request);
      const subscriptions = await listSubscriptions(organizationId);
      return reply.send({ subscriptions });
    }
  );

  server.post<{
    Params: { subscriptionId: string };
    Body: { cancelAtPeriodEnd?: boolean };
    Reply: ApiErrorResponse | void;
  }>(
    '/v1/enterprise/billing/subscriptions/:subscriptionId/cancel',
    {
      schema: {
        tags: ['Enterprise'],
        summary: 'Cancel subscription',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      },
      preHandler: [authenticate, requireTenantContext(), requirePermission('billing:update')],
    },
    async (request, reply) => {
      const { organizationId } = getTenantContext(request);
      await cancelSubscription(
        organizationId,
        request.params.subscriptionId,
        request.body.cancelAtPeriodEnd ?? true
      );

      return reply.status(204).send();
    }
  );
}

function normalizeSubscriptionResponse(
  subscription: BillingSubscription,
  fallbackOrganizationId: string
): BillingSubscription {
  const now = Date.now();
  return {
    ...subscription,
    organizationId: subscription.organizationId ?? fallbackOrganizationId,
    amount: typeof subscription.amount === 'number' ? subscription.amount : 0,
    currency: subscription.currency ?? 'USD',
    startDate: typeof subscription.startDate === 'number' ? subscription.startDate : now,
  };
}
