-- Organization.billing_tenant_id — cached ci_org -> id canonical tenant mapping.
--
-- ci today addresses billing with `tenant_id = organizationId` (ci's own org
-- UUID). The canonical namespace where plan + Stripe actually live is id's
-- tenant_id; services/billing-tenant-resolver.ts resolves it via id's
-- GET /internal/tenants/by-account/<account_id> and persists the answer here
-- (write-through) so the mapping survives Redis loss and id outages.
--
-- Nullable: NULL means "not resolved yet" — every call site falls back to the
-- status-quo organizationId. Expand-only, idempotent, no existing structure
-- touched (same pattern as the wallet_grants migration).

ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "billing_tenant_id" TEXT;
