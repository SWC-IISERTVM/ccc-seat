-- ==============================================================================
-- 04_cron.sql: Scheduled Jobs (pg_cron) & Supabase Realtime Setup
-- ==============================================================================
-- Enables pg_cron extension, schedules automated cleanup jobs,
-- and configures Supabase Realtime publication for public.computers.
-- ==============================================================================

-- 1. Enable pg_cron extension (available in Supabase standard extensions)
CREATE EXTENSION IF NOT EXISTS "pg_cron";

-- 2. Schedule expire_breaks() to run every minute
-- Clears break timers whose break_expires_at <= now()
SELECT cron.unschedule('expire-breaks-every-minute')
WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'expire-breaks-every-minute'
);

SELECT cron.schedule(
    'expire-breaks-every-minute',
    '* * * * *',
    'SELECT public.expire_breaks();'
);

-- 3. Schedule cleanup_old_records() to run daily at 03:00 AM UTC
-- Purges break_history older than retention_days (default 7) and request_log older than 24h
SELECT cron.unschedule('cleanup-old-records-daily')
WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'cleanup-old-records-daily'
);

SELECT cron.schedule(
    'cleanup-old-records-daily',
    '0 3 * * *',
    'SELECT public.cleanup_old_records();'
);

-- ------------------------------------------------------------------------------
-- 4. REALTIME CONFIGURATION
-- ------------------------------------------------------------------------------
-- Ensure public.computers has REPLICA IDENTITY FULL so realtime updates send
-- complete row states to subscribers.
ALTER TABLE public.computers REPLICA IDENTITY FULL;

-- Add computers table to Supabase Realtime publication if not already included
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public'
          AND tablename = 'computers'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.computers;
    END IF;
END $$;
