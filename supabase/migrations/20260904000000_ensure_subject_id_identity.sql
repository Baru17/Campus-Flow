-- Migration: Ensure all existing IT subject tables have a proper
-- subject_id sequence/identity so that INSERT without subject_id works.
--
-- This fixes: ERROR: 23502 null value in column "subject_id"
--            violates not-null constraint
--
-- The admin-students Edge Function now calls ensureSubjectIdIdentity()
-- for newly created tables, but this migration repairs existing tables.

DO $$
DECLARE
  tbl TEXT;
  seq_name TEXT;
BEGIN
  FOR tbl IN
    SELECT tablename
    FROM pg_catalog.pg_tables
    WHERE schemaname = 'public'
      AND tablename LIKE 'it\_subjects\_%'
  LOOP
    -- Check if the column already has a sequence.
    IF pg_get_serial_sequence('public.' || tbl, 'subject_id') IS NULL THEN
      seq_name := tbl || '_subject_id_seq';

      -- Create sequence if it doesn't exist.
      EXECUTE format(
        'CREATE SEQUENCE IF NOT EXISTS public.%I',
        seq_name
      );

      -- Set the default to use the sequence.
      EXECUTE format(
        'ALTER TABLE public.%I ALTER COLUMN subject_id SET DEFAULT nextval(%L)',
        tbl,
        'public.' || seq_name
      );

      -- Set sequence ownership.
      EXECUTE format(
        'ALTER SEQUENCE public.%I OWNED BY public.%I.subject_id',
        seq_name,
        tbl
      );

      RAISE NOTICE 'Repaired subject_id sequence for table %', tbl;
    ELSE
      RAISE NOTICE 'Table % already has subject_id sequence', tbl;
    END IF;
  END LOOP;
END $$;
