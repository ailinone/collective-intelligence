-- F3/F1 §P6 — Custom moderation policies (per-tenant).
--
-- Adds the `moderation_policies` table. A policy layers org-specific category
-- thresholds (and optional custom categories) on top of the base OpenAI-style
-- /v1/moderations result. Applied only when a request passes `policy_id`.
--
-- Design notes:
--   - `thresholds` JSONB maps category key -> number in [0,1]; a base score
--     >= threshold trips (re-flags) that category.
--   - `custom_categories` JSONB (nullable) declares org-defined categories that
--     don't exist in the base provider taxonomy (keyword/regex matched at apply).
--   - `action` enum is minimal: 'flag' (annotate only) | 'block' (caller must
--     reject). CHECK constraint enforces the enum at the DB level — fail loud
--     if app code drifts.
--   - `enabled=false` keeps the policy for audit / re-enable but makes apply a
--     pass-through no-op.
--   - Name uniqueness is scoped per (organization_id, name): two orgs can both
--     have a "strict" policy without collision.
--   - Cascade delete on the org FK: deleting an Org wipes its policies.
--   - This migration is ADDITIVE ONLY: no existing tables are touched.

CREATE TABLE "moderation_policies" (
    "id"                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    "organization_id"   UUID         NOT NULL,
    "name"              TEXT         NOT NULL,
    "thresholds"        JSONB        NOT NULL DEFAULT '{}',
    "custom_categories" JSONB,
    "action"            VARCHAR(16)  NOT NULL DEFAULT 'flag',
    "enabled"           BOOLEAN      NOT NULL DEFAULT true,
    "created_at"        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    "updated_at"        TIMESTAMPTZ  NOT NULL DEFAULT now(),

    -- Cascade delete is intentional: deleting an Org wipes its moderation
    -- policies. Acceptable because Org delete is admin-gated + triggers full
    -- tenant cleanup.
    CONSTRAINT "moderation_policies_organization_id_fkey"
        FOREIGN KEY ("organization_id")
        REFERENCES "organizations"("id")
        ON DELETE CASCADE
        ON UPDATE CASCADE,

    -- Policy name uniqueness scoped per-org.
    CONSTRAINT "moderation_policies_organization_id_name_unique"
        UNIQUE ("organization_id", "name"),

    -- Action enum enforced at DB level — fail loud if app code drifts.
    CONSTRAINT "moderation_policies_action_check"
        CHECK ("action" IN ('flag', 'block'))
);

-- Hot-path index: list an org's policies.
CREATE INDEX "moderation_policies_org_idx"
    ON "moderation_policies" ("organization_id");

-- Filtered list of an org's enabled policies (apply path).
CREATE INDEX "moderation_policies_org_enabled_idx"
    ON "moderation_policies" ("organization_id", "enabled");

COMMENT ON TABLE "moderation_policies" IS 'Per-tenant custom content-moderation policy. Layers org-specific category thresholds + custom categories on top of the base /v1/moderations result. Applied when a request passes policy_id.';
COMMENT ON COLUMN "moderation_policies"."thresholds" IS 'JSONB map category key -> number in [0,1]. Base score >= threshold re-flags that category.';
COMMENT ON COLUMN "moderation_policies"."custom_categories" IS 'JSONB org-defined categories not in the base taxonomy; score derived via keyword/regex match at apply time.';
COMMENT ON COLUMN "moderation_policies"."action" IS 'flag = annotate only; block = caller must reject the content.';
COMMENT ON COLUMN "moderation_policies"."enabled" IS 'false = policy kept for audit / re-enable but apply is a pass-through no-op.';
