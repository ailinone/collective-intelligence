-- Deactivate deprecated models that cause runtime errors
-- grok-beta was removed from the xAI API and causes 400 "Model not found" via orqai provider
UPDATE "models" SET "status" = 'deprecated' WHERE "name" LIKE '%grok-beta%' AND "status" = 'active';
