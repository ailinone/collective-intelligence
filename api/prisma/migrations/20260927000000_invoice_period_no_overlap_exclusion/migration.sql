-- Invoice period overlap — DB-level exclusion constraint (fraud follow-up to #654)
--
-- #654 added an application-level guard (findOverlappingInvoice: a SELECT
-- run before the INSERT) so a non-platform-admin self-service invoice cannot
-- double-bill an organization for a period the daily usage job already
-- invoiced. That guard is check-then-act with no lock and no DB constraint
-- tying the two operations together: two concurrent callers (the daily
-- billing-usage-reconciliation job racing a self-service POST
-- /v1/enterprise/billing/invoices, or two racing self-service calls for the
-- same org) can both pass the SELECT before either INSERT commits, producing
-- two invoices that both get charged in Stripe for the same usage.
--
-- Why an EXCLUDE constraint and not a simple
-- UNIQUE(organization_id, period_start, period_end):
--   Colliding periods are NOT always exact duplicates. The daily job
--   (billing-usage-reconciliation-job.ts -> previousDayWindow) always invoices
--   an exact UTC-day window, but the self-service route
--   (billing-routes.ts, POST /v1/enterprise/billing/invoices) lets the caller
--   pick ANY periodStart/periodEnd as long as periodStart < periodEnd <= now
--   — there is no requirement that it align to day boundaries. So a
--   self-service invoice can PARTIALLY overlap a day-boundary invoice with
--   different exact bounds (e.g. yesterday 14:00 -> today 10:00 against a
--   daily invoice for yesterday 00:00 -> today 00:00). This is exactly what
--   findOverlappingInvoice already checks for with `periodStart: { lt: end },
--   periodEnd: { gt: start }` (a half-open-interval overlap test, not
--   equality) — a plain UNIQUE constraint would only catch exact-bounds
--   duplicates and would miss the partial-overlap case entirely, leaving the
--   double-billing hole half-open. Prisma cannot express EXCLUDE natively
--   (see the comment on the `Invoice` model in schema.prisma), so this is a
--   raw-SQL migration, same pattern already used for
--   20260718000000_semantic_cache_pgvector and
--   20260421000000_broadcast_outbox_request_id_unique.
--
-- Why the partial `WHERE (status <> 'cancelled')`:
--   An invoice moves to 'cancelled' when its Stripe invoice is voided
--   (mapStripeInvoiceStatus, billing-service.ts). findOverlappingInvoice
--   deliberately excludes cancelled invoices from the overlap check
--   (`status: { not: 'cancelled' }`) so a voided invoice does not permanently
--   block re-invoicing that period. The DB constraint mirrors that exactly —
--   without this WHERE clause, a single voided invoice would make its period
--   permanently uninvoiceable, which is a correctness regression this
--   migration must not introduce.
--
-- Why `tsrange`, not `tstzrange`:
--   Invoice.periodStart/periodEnd are Prisma `DateTime` with no `@db.Timestamptz`
--   override, i.e. plain TIMESTAMP(3) WITHOUT TIME ZONE columns (see
--   20251101_initial_schema/migration.sql). `tstzrange(period_start,
--   period_end)` would only work via Postgres's implicit timestamp ->
--   timestamptz cast, which reinterprets the naive value using the DB
--   session's `TimeZone` setting — a hidden, environment-dependent shift
--   that has no reason to be introduced into a monetary boundary check.
--   `tsrange` operates on the stored TIMESTAMP(3) values as-is, with no
--   timezone reinterpretation, and is the exact range counterpart of the
--   column type.
--
-- Half-open interval semantics match findOverlappingInvoice:
--   `tsrange(period_start, period_end)` defaults to `'[)'` (inclusive start,
--   exclusive end), i.e. two ranges overlap (`&&`) iff
--   `a.period_start < b.period_end AND a.period_end > b.period_start` — the
--   exact comparison findOverlappingInvoice already does in application code.
--
-- Operational note (read before deploying): ADD CONSTRAINT ... EXCLUDE
-- validates ALL existing rows against the new constraint. If production
-- already has overlapping/duplicate invoices from the very race this
-- migration closes, this statement will FAIL at deploy time until those rows
-- are identified and resolved (e.g. void/cancel the duplicate in Stripe and
-- mark it 'cancelled' here, which the partial WHERE then exempts). See the
-- PR description for the query to check this before deploying.

-- btree_gist is a "trusted" extension since Postgres 13 — installable by the
-- app's migration role without superuser, same as `vector` in
-- 20260718000000_semantic_cache_pgvector. It supplies the GiST-compatible
-- equality operator class for `organization_id` (uuid) so it can be combined
-- with the range overlap operator in one GiST index.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "invoices"
  ADD CONSTRAINT "no_overlapping_invoice_period"
  EXCLUDE USING gist (
    "organization_id" WITH =,
    tsrange("period_start", "period_end") WITH &&
  )
  WHERE ("status" <> 'cancelled');
