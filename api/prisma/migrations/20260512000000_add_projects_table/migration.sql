-- Slice 1 — Project entity (resource-layer sub-entity of Organization)
--
-- Adds the `projects` table for the dev/platform feature. A Project is a
-- container for application-scoped resources (API keys, deploys, telemetry).
--
-- Design notes:
--   - Slug is unique per (organization_id, slug) — two orgs can have
--     identically-named projects without collision.
--   - Status enum is minimal: 'active' | 'archived'. Hard delete is gated
--     behind a separate admin-only flow (CWE-274: not exposed to UI).
--   - `archived_at` is separate from `status` so archives can be audited
--     (when, by whom) without parsing status state changes.
--   - `settings` JSONB is an extensibility escape hatch (region, default
--     model, webhook URLs) so we don't migrate the schema every time we
--     add a project-level setting.
--   - This migration is ADDITIVE ONLY: no existing tables are touched. The
--     ApiKey / UsageEvent project_id FKs come in a later slice.

CREATE TABLE "projects" (
    "id"              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    "organization_id" UUID         NOT NULL,
    "name"            TEXT         NOT NULL,
    "slug"            TEXT         NOT NULL,
    "description"     TEXT,
    "status"          VARCHAR(32)  NOT NULL DEFAULT 'active',
    "settings"        JSONB        NOT NULL DEFAULT '{}',
    "created_at"      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    "updated_at"      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    "archived_at"     TIMESTAMPTZ,
    "created_by"      UUID         NOT NULL,

    -- Cascade delete is intentional: deleting an Org wipes its projects.
    -- Tradeoff: cannot orphan a Project. Acceptable because Org delete
    -- itself is gated by admin-only flow and triggers full tenant cleanup.
    CONSTRAINT "projects_organization_id_fkey"
        FOREIGN KEY ("organization_id")
        REFERENCES "organizations"("id")
        ON DELETE CASCADE
        ON UPDATE CASCADE,

    -- Slug uniqueness scoped per-org. Two orgs can both have "customer-portal".
    CONSTRAINT "projects_organization_id_slug_unique"
        UNIQUE ("organization_id", "slug"),

    -- Status enum enforced at DB level — fail loud if app code drifts.
    CONSTRAINT "projects_status_check"
        CHECK ("status" IN ('active', 'archived'))
);

-- Hot-path index: list active projects for an org (default dashboard view).
CREATE INDEX "projects_org_status_idx"
    ON "projects" ("organization_id", "status");

-- Sort index: paginated list by recency.
CREATE INDEX "projects_org_created_at_idx"
    ON "projects" ("organization_id", "created_at" DESC);

COMMENT ON TABLE "projects" IS 'Resource-layer container for application-scoped resources within an Organization. Owns API keys (via ApiKey.project_id FK in later slice), deploys, telemetry.';
COMMENT ON COLUMN "projects"."slug" IS 'URL-safe identifier derived from name. Unique per organization_id, not globally.';
COMMENT ON COLUMN "projects"."status" IS 'Lifecycle state. active = visible/usable. archived = hidden, reversible via restore action.';
COMMENT ON COLUMN "projects"."settings" IS 'JSONB extensibility hatch — region, default model, webhook URLs without schema migrations.';
COMMENT ON COLUMN "projects"."created_by" IS 'User UUID for audit trail. Not FK-enforced to avoid coupling with id/ User mirror.';
