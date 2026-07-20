-- F3.3 prep — seed feedback_extraction_state for the 'collective' stream
--
-- The training-data-export job follows a watermark-based pattern: each
-- extraction stream owns one row in feedback_extraction_state keyed by
-- extraction_type. The 'outcomes' and 'shadow' rows were seeded by
-- 20260402000000_feedback_extraction_state. This migration adds the
-- third row for the Ailin¹ Collective Coordination Layer (F1.5) so the
-- job's UPDATE on the watermark is not silently dropped on the first run.

INSERT INTO "feedback_extraction_state" ("extraction_type") VALUES ('collective')
ON CONFLICT ("extraction_type") DO NOTHING;
