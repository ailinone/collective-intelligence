-- GAP-A13 (2026-09-05) — allow `runtime-probe` as a capability-assertion source.
--
-- The empirical function-calling probe (function-calling-probe.ts) proved a
-- model's tool support by sending a real request with a real tool definition,
-- then stored the verdict as a bare '1'/'0' string in Redis with a 7-day TTL:
-- no timestamp, no observation count, no audit trail, and — crucially — no
-- path into `models.capability_uris`, which is the column the selector's
-- fail-closed hard filter reads. That made tool-calling the one capability
-- served by a second, parallel evidence system.
--
-- Admitting the source here lets the probe write into the SAME append-only
-- assertion log as discovery, so the materialiser fuses it like any other
-- evidence and an empirically-confirmed capability is promoted into the
-- canonical projection automatically.
--
-- `hierarchy-inherited` is deliberately still absent: it is a synthetic,
-- in-memory propagation step inside the materialiser and is never persisted.

ALTER TABLE "model_capability_assertions"
    DROP CONSTRAINT "chk_mca_source";

ALTER TABLE "model_capability_assertions"
    ADD CONSTRAINT "chk_mca_source"
    CHECK ("source" IN (
        'provider-declared', 'helicone-oracle', 'modality-derived',
        'parameter-derived', 'name-regex', 'llm-extracted', 'operator-override',
        'runtime-probe'
    ));
