-- Schema sync migration: align Prisma schema with DB reality after 20260410_multi_provider_models.
-- This migration is intentionally empty for DDL — the structural changes are already applied.
-- We add a trigger as a safety net for uid auto-generation on INSERT.

-- Safety-net trigger: auto-compute uid if not provided on INSERT
CREATE OR REPLACE FUNCTION generate_model_uid()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.uid IS NULL OR NEW.uid = '' THEN
    NEW.uid := SUBSTRING(MD5(NEW.provider_id || ':' || NEW.id), 1, 25);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_model_uid ON models;
CREATE TRIGGER set_model_uid
  BEFORE INSERT ON models
  FOR EACH ROW
  EXECUTE FUNCTION generate_model_uid();
