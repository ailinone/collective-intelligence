-- Ensure primary role column exists for backward compatibility
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "role" TEXT NOT NULL DEFAULT 'member';

-- Create roles table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'roles' AND table_schema = 'public'
  ) THEN
    CREATE TABLE "roles" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "name" TEXT NOT NULL UNIQUE,
        "description" TEXT,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    );
  END IF;
END;
$$;

-- Create permissions table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'permissions' AND table_schema = 'public'
  ) THEN
    CREATE TABLE "permissions" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "name" TEXT NOT NULL UNIQUE,
        "description" TEXT,
        "category" TEXT NOT NULL DEFAULT 'general',
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    );
  END IF;
END;
$$;

-- Create join table role_permissions
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'role_permissions' AND table_schema = 'public'
  ) THEN
    CREATE TABLE "role_permissions" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "role_id" UUID NOT NULL REFERENCES "roles"("id") ON DELETE CASCADE,
        "permission_id" UUID NOT NULL REFERENCES "permissions"("id") ON DELETE CASCADE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        CONSTRAINT role_permissions_role_permission_unique UNIQUE ("role_id", "permission_id")
    );
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS "role_permissions_permission_idx" ON "role_permissions" ("permission_id");

-- Create user_roles table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'user_roles' AND table_schema = 'public'
  ) THEN
    CREATE TABLE "user_roles" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "organization_id" UUID NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
        "role_id" UUID NOT NULL REFERENCES "roles"("id") ON DELETE CASCADE,
        "assigned_by" UUID,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        CONSTRAINT user_roles_unique UNIQUE ("user_id", "organization_id", "role_id")
    );
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS "user_roles_org_idx" ON "user_roles" ("organization_id");

-- Security audit logs
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'security_audit_logs' AND table_schema = 'public'
  ) THEN
    CREATE TABLE "security_audit_logs" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "event_type" TEXT NOT NULL,
        "severity" TEXT NOT NULL,
        "message" TEXT NOT NULL,
        "user_id" UUID REFERENCES "users"("id") ON DELETE SET NULL,
        "organization_id" UUID REFERENCES "organizations"("id") ON DELETE SET NULL,
        "metadata" JSONB,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    );
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS "security_audit_logs_org_idx" ON "security_audit_logs" ("organization_id");
CREATE INDEX IF NOT EXISTS "security_audit_logs_event_idx" ON "security_audit_logs" ("event_type");
CREATE INDEX IF NOT EXISTS "security_audit_logs_created_idx" ON "security_audit_logs" ("created_at");

