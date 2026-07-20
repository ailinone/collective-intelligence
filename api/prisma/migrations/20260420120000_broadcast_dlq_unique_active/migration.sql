-- Broadcast DLQ — partial unique index on ACTIVE entries.
--
-- Defense-in-depth for ADR-019 (DLQ Contract). The application-level dedup
-- in BroadcastDeliveryExecutor.admitToDlq() prevents same-run duplicate
-- inserts, but only a DB constraint eliminates the race on concurrent
-- tick/replay paths.
--
-- Semantics:
--   * At most ONE un-replayed dlq entry per (envelope_id, destination_id).
--   * After replay (replayed_at IS NOT NULL), the row is no longer in the
--     "active" set — a fresh failure on the same (envelope,destination)
--     CAN insert a new row. This is what we want: replay history is an
--     append-only audit trail.
--
-- Partial unique indexes are a Postgres feature; Prisma's @@unique cannot
-- express `WHERE`. The schema-level constraint is maintained here as raw
-- SQL and ignored by Prisma introspection.

CREATE UNIQUE INDEX IF NOT EXISTS broadcast_dlq_active_envelope_destination_unique
  ON broadcast_dlq (envelope_id, destination_id)
  WHERE replayed_at IS NULL;
