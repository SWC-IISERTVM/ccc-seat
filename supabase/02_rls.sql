-- ==============================================================================
-- 02_rls.sql: Row Level Security (RLS) Policies & Role Grants
-- ==============================================================================
-- Enforces zero direct write permissions for anonymous users.
-- The public dashboard has read-only SELECT permissions on public-safe data
-- (labs and computers). Private tables (app_config, break_history, request_log)
-- have strict RLS with NO public policies, accessible only via SECURITY DEFINER
-- functions or authorized admin sessions.
-- ==============================================================================

-- 1. Enable RLS on every table without exception
ALTER TABLE public.labs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.computers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.break_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.request_log ENABLE ROW LEVEL SECURITY;

-- 2. Clean grants: Revoke broad permissions first
REVOKE ALL ON TABLE public.labs FROM anon, authenticated;
REVOKE ALL ON TABLE public.computers FROM anon, authenticated;
REVOKE ALL ON TABLE public.app_config FROM anon, authenticated;
REVOKE ALL ON TABLE public.break_history FROM anon, authenticated;
REVOKE ALL ON TABLE public.admin_users FROM anon, authenticated;
REVOKE ALL ON TABLE public.admin_actions FROM anon, authenticated;
REVOKE ALL ON TABLE public.request_log FROM anon, authenticated;

-- 3. Explicit SELECT grants for public-safe tables
GRANT SELECT ON TABLE public.labs TO anon, authenticated;
GRANT SELECT ON TABLE public.computers TO anon, authenticated;

-- 4. Explicit SELECT grants for admin portal tables
GRANT SELECT ON TABLE public.admin_users TO authenticated;
GRANT SELECT ON TABLE public.admin_actions TO authenticated;

-- ------------------------------------------------------------------------------
-- RLS POLICIES
-- ------------------------------------------------------------------------------

-- LABS: Anyone can read active lab definitions
DROP POLICY IF EXISTS "Public can view labs" ON public.labs;
CREATE POLICY "Public can view labs"
    ON public.labs
    FOR SELECT
    TO anon, authenticated
    USING (is_active = true);

-- COMPUTERS: Anyone can read public computer status (id, lab_id, pc_number, timestamps)
DROP POLICY IF EXISTS "Public can view computers" ON public.computers;
CREATE POLICY "Public can view computers"
    ON public.computers
    FOR SELECT
    TO anon, authenticated
    USING (true);

-- ADMIN_USERS: Authenticated users can verify if their own auth.uid() is an admin
DROP POLICY IF EXISTS "Users can check their own admin status" ON public.admin_users;
CREATE POLICY "Users can check their own admin status"
    ON public.admin_users
    FOR SELECT
    TO authenticated
    USING ((SELECT auth.uid()) = user_id);

-- ADMIN_ACTIONS: Authenticated admins can view the action log
DROP POLICY IF EXISTS "Admins can view action logs" ON public.admin_actions;
CREATE POLICY "Admins can view action logs"
    ON public.admin_actions
    FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.admin_users
            WHERE admin_users.user_id = (SELECT auth.uid())
        )
    );

-- PRIVATE TABLES (app_config, break_history, request_log):
-- Intentionally NO POLICIES exist for anon or authenticated roles.
-- Postgres RLS default-deny ensures no direct REST API queries can read
-- peppers, regexes, roll keys, break tokens, or request logs.
-- Access is strictly through SECURITY DEFINER stored procedures.
