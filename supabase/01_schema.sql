-- ==============================================================================
-- 01_schema.sql: Database Schema & Extensions for Lab Break-Timer
-- ==============================================================================
-- Enables required extensions, creates tables, primary/foreign keys, and indexes.
-- Designed to be idempotent (IF NOT EXISTS).
-- ==============================================================================

-- 1. Enable cryptographic functions for HMAC-SHA256 and SHA-256 digests
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 2. LABS Table
-- Stores the physical computer lab information (e.g. Lab 1, Lab 2).
CREATE TABLE IF NOT EXISTS public.labs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    display_order INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for ordering active labs
CREATE INDEX IF NOT EXISTS idx_labs_active_order ON public.labs (is_active, display_order);

-- 3. COMPUTERS Table
-- PUBLIC-SAFE TABLE: Read and subscribed to by the public dashboard.
-- MUST CONTAIN ONLY PUBLIC-SAFE COLUMNS.
-- Zero roll numbers, hashes, tokens, or student identifiers are ever stored here.
CREATE TABLE IF NOT EXISTS public.computers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lab_id UUID NOT NULL REFERENCES public.labs(id) ON DELETE CASCADE,
    pc_number INTEGER NOT NULL,
    break_started_at TIMESTAMPTZ,
    break_expires_at TIMESTAMPTZ,
    cooldown_expires_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_lab_pc UNIQUE (lab_id, pc_number)
);

-- Indexes for fast lookup and public polling / realtime subscriptions
CREATE INDEX IF NOT EXISTS idx_computers_lab_pc ON public.computers (lab_id, pc_number);
CREATE INDEX IF NOT EXISTS idx_computers_expiry ON public.computers (break_expires_at) WHERE break_expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_computers_cooldown ON public.computers (cooldown_expires_at) WHERE cooldown_expires_at IS NOT NULL;

-- 4. PRIVATE APP_CONFIG Table
-- Stores system settings, regex patterns, and the secret HMAC pepper.
-- STRICTLY PRIVATE: No anon/authenticated role has SELECT access.
CREATE TABLE IF NOT EXISTS public.app_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    description TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5. PRIVATE BREAK_HISTORY Table
-- Stores historical records and current active break metadata.
-- Holds the authenticated account identity (auth.uid() and verified email).
-- STRICTLY PRIVATE: No anon access.
CREATE TABLE IF NOT EXISTS public.break_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    computer_id UUID NOT NULL REFERENCES public.computers(id) ON DELETE CASCADE,
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL, -- Canonical authenticated identity (auth.uid())
    user_email TEXT, -- Verified institutional email (@iisertvm.ac.in)
    roll_key TEXT, -- HMAC-SHA256(normalized_roll, secret_pepper) (optional/legacy)
    break_token_hash TEXT, -- SHA-256(raw_one_time_token) for device storage
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    scheduled_expires_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ,
    end_reason TEXT CHECK (end_reason IN ('completed', 'early_return', 'admin_cleared', 'expired')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Partial Unique Index: Strictly enforces AT MOST ONE active break per account across both labs!
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_break_user 
    ON public.break_history (user_id) 
    WHERE ended_at IS NULL;

-- Partial Unique Index: Strictly enforces AT MOST ONE active break per computer!
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_break_computer 
    ON public.break_history (computer_id) 
    WHERE ended_at IS NULL;

-- Index for rolling 60-minute cooldown checks on student accounts
CREATE INDEX IF NOT EXISTS idx_break_history_user_cooldown ON public.break_history (user_id, started_at DESC);

-- Index for locating active break by computer
CREATE INDEX IF NOT EXISTS idx_break_history_computer_active ON public.break_history (computer_id, ended_at) WHERE ended_at IS NULL;

-- Index for retention cleanup
CREATE INDEX IF NOT EXISTS idx_break_history_retention ON public.break_history (started_at);

-- 6. PRIVATE ADMIN_USERS Table
-- Maps authorized Supabase Auth users to the admin role.
CREATE TABLE IF NOT EXISTS public.admin_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 7. PRIVATE ADMIN_ACTIONS Table
-- Immutable audit log for all administrative actions (e.g. clearing timers, modifying inventory).
CREATE TABLE IF NOT EXISTS public.admin_actions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_actions_created ON public.admin_actions (created_at DESC);

-- 8. PRIVATE REQUEST_LOG Table
-- Ephemeral log for best-effort rate limiting in RPC calls.
CREATE TABLE IF NOT EXISTS public.request_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ip_hash TEXT,
    identifier_key TEXT,
    action TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_request_log_rate_limit ON public.request_log (ip_hash, action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_request_log_ident_rate_limit ON public.request_log (identifier_key, action, created_at DESC);
