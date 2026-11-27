-- ==============================================================================
-- 03_functions.sql: Stored Procedures & Business Logic for Lab Break-Timer
-- ==============================================================================
-- All functions are SECURITY DEFINER with fixed search_path = public, pg_temp.
-- Explicit EXECUTE grants are configured at the bottom.
-- Public functions never return roll numbers, full hashes, or secret peppers.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. SERVER_NOW: Clock Synchronization RPC
-- ------------------------------------------------------------------------------
-- Returns database server time to allow frontend client-clock skew correction.
CREATE OR REPLACE FUNCTION public.server_now()
RETURNS TIMESTAMPTZ
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
    SELECT clock_timestamp();
$$;

-- ------------------------------------------------------------------------------
-- 2. IS_ADMIN: Security Helper for Admin RPC Authorization
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_email TEXT;
BEGIN
    IF auth.uid() IS NULL THEN
        RETURN FALSE;
    END IF;

    IF EXISTS (SELECT 1 FROM public.admin_users WHERE user_id = auth.uid()) THEN
        RETURN TRUE;
    END IF;

    v_email := lower(coalesce(auth.jwt()->>'email', ''));
    IF v_email <> '' AND EXISTS (
        SELECT 1 FROM public.admin_users WHERE lower(email) = v_email
    ) THEN
        RETURN TRUE;
    END IF;

    RETURN FALSE;
END;
$$;

-- Trigger to link user_id when user signs in with Google OAuth
CREATE OR REPLACE FUNCTION public.sync_admin_user_on_auth()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.email IS NOT NULL THEN
    UPDATE public.admin_users
    SET user_id = NEW.id
    WHERE lower(email) = lower(NEW.email) AND (user_id IS NULL OR user_id <> NEW.id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp;

DROP TRIGGER IF EXISTS tr_sync_admin_user ON auth.users;
CREATE TRIGGER tr_sync_admin_user
  AFTER INSERT OR UPDATE OF email ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_admin_user_on_auth();

-- ------------------------------------------------------------------------------
-- 3. CHECK_RATE_LIMIT: Internal Helper for Best-Effort Abuse Prevention
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_rate_limit(
    p_ip_hash TEXT,
    p_ident_key TEXT,
    p_action TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_ip_count INTEGER := 0;
    v_ident_count INTEGER := 0;
BEGIN
    -- Check requests from IP within last 60 seconds (max 20 per minute)
    IF p_ip_hash IS NOT NULL THEN
        SELECT COUNT(*) INTO v_ip_count
        FROM public.request_log
        WHERE ip_hash = p_ip_hash
          AND action = p_action
          AND created_at > (now() - interval '1 minute');

        IF v_ip_count >= 20 THEN
            RETURN false;
        END IF;
    END IF;

    -- Check requests for identifier/roll key within last 60 seconds (max 6 per minute)
    IF p_ident_key IS NOT NULL THEN
        SELECT COUNT(*) INTO v_ident_count
        FROM public.request_log
        WHERE identifier_key = p_ident_key
          AND action = p_action
          AND created_at > (now() - interval '1 minute');

        IF v_ident_count >= 6 THEN
            RETURN false;
        END IF;
    END IF;

    -- Log this attempt
    INSERT INTO public.request_log (ip_hash, identifier_key, action)
    VALUES (p_ip_hash, p_ident_key, p_action);

    RETURN true;
END;
$$;

-- ------------------------------------------------------------------------------
-- 4. START_BREAK: Account-Identified Atomic Break Creation RPC
-- ------------------------------------------------------------------------------
-- Enforces:
-- 1. Verified institutional domain (@iisertvm.ac.in) via auth.uid() & JWT context.
-- 2. Exact 15-minute duration (server-controlled, client cannot modify duration).
-- 3. Atomic reconciliation of naturally expired records before checking limits.
-- 4. Advisory lock on authenticated user ID (prevents concurrent race conditions).
-- 5. Strict Account Invariant: Exactly ONE active break per account across both labs.
-- 6. Rolling 60-minute cooldown calculated from authenticated user's previous start.
-- 7. Row lock on computer (FOR UPDATE) & database partial unique constraints.
-- 8. Returns random one-time break token stored in student's browser localStorage.
CREATE OR REPLACE FUNCTION public.start_break(
    p_lab_id UUID,
    p_pc_number INTEGER,
    p_roll_number TEXT DEFAULT NULL -- Obsolete parameter preserved for backward-compatibility
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_user_id UUID;
    v_user_email TEXT;
    v_computer RECORD;
    v_active_break RECORD;
    v_last_started TIMESTAMPTZ;
    v_eligible_at TIMESTAMPTZ;
    v_pc_cooldown_until TIMESTAMPTZ;
    v_raw_token TEXT;
    v_token_hash TEXT;
    v_now TIMESTAMPTZ;
    v_expires_at TIMESTAMPTZ;
    v_break_id UUID;
    v_ip_header TEXT;
    v_ip_hash TEXT;
    v_rate_ok BOOLEAN;
BEGIN
    -- 1. Identity & Domain Verification (auth.uid() and institutional @iisertvm.ac.in)
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error_code', 'AUTH_REQUIRED',
            'message', 'Institutional sign-in required. Please sign in with your @iisertvm.ac.in Google account.'
        );
    END IF;

    v_user_email := lower(coalesce(auth.jwt()->>'email', ''));
    IF v_user_email NOT LIKE '%@iisertvm.ac.in' AND NOT public.is_admin() THEN
        RETURN jsonb_build_object(
            'success', false,
            'error_code', 'UNAUTHORIZED_DOMAIN',
            'message', 'Access restricted: Only verified @iisertvm.ac.in institutional accounts are permitted.'
        );
    END IF;

    -- 2. IP extraction & rate limiting (abuse prevention)
    BEGIN
        v_ip_header := current_setting('request.headers', true)::json->>'x-forwarded-for';
    EXCEPTION WHEN OTHERS THEN
        v_ip_header := 'direct';
    END;
    IF v_ip_header IS NOT NULL THEN
        v_ip_hash := encode(digest(split_part(v_ip_header, ',', 1), 'sha256'), 'hex');
    ELSE
        v_ip_hash := 'anonymous';
    END IF;

    v_rate_ok := public.check_rate_limit(v_ip_hash, v_user_id::text, 'start_break');
    IF NOT v_rate_ok THEN
        RETURN jsonb_build_object(
            'success', false,
            'error_code', 'RATE_LIMITED',
            'message', 'Too many requests. Please wait a minute before trying again.'
        );
    END IF;

    -- 3. Atomic reconciliation of naturally expired breaks before evaluating constraints
    UPDATE public.break_history
    SET ended_at = scheduled_expires_at,
        end_reason = 'expired'
    WHERE ended_at IS NULL
      AND scheduled_expires_at <= clock_timestamp();

    UPDATE public.computers
    SET break_started_at = NULL,
        break_expires_at = NULL,
        cooldown_expires_at = break_expires_at + interval '15 minutes',
        updated_at = clock_timestamp()
    WHERE break_expires_at IS NOT NULL
      AND break_expires_at <= clock_timestamp();

    UPDATE public.computers
    SET cooldown_expires_at = NULL,
        updated_at = clock_timestamp()
    WHERE cooldown_expires_at IS NOT NULL
      AND cooldown_expires_at <= clock_timestamp();

    -- 4. Serialized transaction locking per user account (pg_advisory_xact_lock)
    PERFORM pg_advisory_xact_lock(hashtext('user:' || v_user_id::text));

    -- 5. Strict Account Constraint: Exactly ONE active break per account across both labs
    SELECT bh.computer_id, c.pc_number, l.name AS lab_name, bh.scheduled_expires_at
    INTO v_active_break
    FROM public.break_history bh
    JOIN public.computers c ON c.id = bh.computer_id
    JOIN public.labs l ON l.id = c.lab_id
    WHERE bh.user_id = v_user_id
      AND bh.ended_at IS NULL
      AND bh.scheduled_expires_at > clock_timestamp();

    IF FOUND THEN
        RETURN jsonb_build_object(
            'success', false,
            'error_code', 'ACTIVE_BREAK_EXISTS',
            'message', format('You already have an active break on PC %s in %s. You can start another break after your current break ends.', 
                              lpad(v_active_break.pc_number::text, 2, '0'), v_active_break.lab_name),
            'active_pc_number', v_active_break.pc_number,
            'active_lab_name', v_active_break.lab_name,
            'active_expires_at', to_char(v_active_break.scheduled_expires_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        );
    END IF;

    -- 6. Rolling 60-Minute Cooldown by Account
    SELECT started_at INTO v_last_started
    FROM public.break_history
    WHERE user_id = v_user_id
      AND started_at > (clock_timestamp() - interval '60 minutes')
    ORDER BY started_at DESC
    LIMIT 1;

    IF v_last_started IS NOT NULL THEN
        v_eligible_at := v_last_started + interval '60 minutes';
        RETURN jsonb_build_object(
            'success', false,
            'error_code', 'COOLDOWN',
            'message', 'Account cooldown active: Each account can only initiate one break every rolling 60 minutes.',
            'eligible_at', to_char(v_eligible_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        );
    END IF;

    -- 7. Lock and verify requested computer
    SELECT * INTO v_computer
    FROM public.computers
    WHERE lab_id = p_lab_id
      AND pc_number = p_pc_number
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'success', false,
            'error_code', 'INVALID_PC',
            'message', 'Selected computer was not found in this lab.'
        );
    END IF;

    IF v_computer.break_expires_at IS NOT NULL AND v_computer.break_expires_at > clock_timestamp() THEN
        RETURN jsonb_build_object(
            'success', false,
            'error_code', 'PC_BUSY',
            'message', 'This computer already has an active break timer running.'
        );
    END IF;

    -- 8. Computer-Level Cooldown (15 minutes after previous break expires/ends)
    IF v_computer.cooldown_expires_at IS NOT NULL AND v_computer.cooldown_expires_at > clock_timestamp() THEN
        RETURN jsonb_build_object(
            'success', false,
            'error_code', 'PC_COOLDOWN',
            'message', 'This computer is in a 15-minute cooldown following its previous break. Another break cannot be started on this computer yet.',
            'cooldown_expires_at', to_char(v_computer.cooldown_expires_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            'remaining_seconds', ceil(extract(epoch from (v_computer.cooldown_expires_at - clock_timestamp())))
        );
    END IF;

    SELECT (coalesce(ended_at, scheduled_expires_at) + interval '15 minutes') INTO v_pc_cooldown_until
    FROM public.break_history
    WHERE computer_id = v_computer.id
      AND (coalesce(ended_at, scheduled_expires_at) + interval '15 minutes') > clock_timestamp()
    ORDER BY started_at DESC
    LIMIT 1;

    IF v_pc_cooldown_until IS NOT NULL AND v_pc_cooldown_until > clock_timestamp() THEN
        UPDATE public.computers
        SET cooldown_expires_at = v_pc_cooldown_until,
            updated_at = clock_timestamp()
        WHERE id = v_computer.id;

        RETURN jsonb_build_object(
            'success', false,
            'error_code', 'PC_COOLDOWN',
            'message', 'This computer is in a 15-minute cooldown following its previous break. Another break cannot be started on this computer yet.',
            'cooldown_expires_at', to_char(v_pc_cooldown_until, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            'remaining_seconds', ceil(extract(epoch from (v_pc_cooldown_until - clock_timestamp())))
        );
    END IF;

    -- 9. Compute timestamps (exactly 15-minute fixed duration)
    v_now := clock_timestamp();
    v_expires_at := v_now + interval '15 minutes';

    -- One-time token for localStorage ownership
    v_raw_token := encode(gen_random_bytes(24), 'hex');
    v_token_hash := encode(digest(v_raw_token, 'sha256'), 'hex');

    -- 10. Insert into break_history
    BEGIN
        INSERT INTO public.break_history (
            computer_id,
            user_id,
            user_email,
            break_token_hash,
            started_at,
            scheduled_expires_at
        )
        VALUES (
            v_computer.id,
            v_user_id,
            v_user_email,
            v_token_hash,
            v_now,
            v_expires_at
        )
        RETURNING id INTO v_break_id;
    EXCEPTION WHEN unique_violation THEN
        RETURN jsonb_build_object(
            'success', false,
            'error_code', 'RACE_DETECTED',
            'message', 'Another break was just activated on this computer or by your account.'
        );
    END;

    -- 11. Update computer status (clear cooldown on start)
    UPDATE public.computers
    SET break_started_at = v_now,
        break_expires_at = v_expires_at,
        cooldown_expires_at = NULL,
        updated_at = v_now
    WHERE id = v_computer.id;

    RETURN jsonb_build_object(
        'success', true,
        'break_id', v_break_id,
        'break_token', v_raw_token,
        'break_started_at', to_char(v_now, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'break_expires_at', to_char(v_expires_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    );
END;
$$;

-- ------------------------------------------------------------------------------
-- 5. END_BREAK: Account-Authorized Early Return RPC
-- ------------------------------------------------------------------------------
-- Allows ending an active break if:
-- 1. Caller is the authenticated user who initiated the break
-- 2. Caller is an authorized staff member (is_admin())
-- 3. Caller presents the private break token saved on this device
-- Cooldown remains active and is NOT refunded.
CREATE OR REPLACE FUNCTION public.end_break(
    p_computer_id UUID,
    p_break_token TEXT DEFAULT NULL,
    p_roll_number TEXT DEFAULT NULL -- Obsolete parameter preserved for backward-compatibility
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_computer RECORD;
    v_break RECORD;
    v_caller_id UUID;
    v_is_authorized BOOLEAN := false;
BEGIN
    v_caller_id := auth.uid();

    -- Lock computer row
    SELECT * INTO v_computer
    FROM public.computers
    WHERE id = p_computer_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'success', false,
            'error_code', 'INVALID_PC',
            'message', 'Computer not found.'
        );
    END IF;

    -- Find active break record for this computer
    SELECT * INTO v_break
    FROM public.break_history
    WHERE computer_id = p_computer_id
      AND ended_at IS NULL
      AND scheduled_expires_at > clock_timestamp()
    ORDER BY started_at DESC
    LIMIT 1
    FOR UPDATE;

    IF NOT FOUND THEN
        -- Reconcile computer status
        UPDATE public.computers
        SET break_started_at = NULL,
            break_expires_at = NULL,
            updated_at = clock_timestamp()
        WHERE id = p_computer_id;

        RETURN jsonb_build_object(
            'success', true,
            'message', 'No active break was running on this computer.'
        );
    END IF;

    -- Authorization validation:
    -- 1. Caller is the authenticated student who created the break
    IF v_caller_id IS NOT NULL AND v_break.user_id IS NOT NULL AND v_caller_id = v_break.user_id THEN
        v_is_authorized := true;
    -- 2. Caller is an authorized admin
    ELSIF public.is_admin() THEN
        v_is_authorized := true;
    -- 3. Caller presents the secret break token saved on this device
    ELSIF p_break_token IS NOT NULL AND v_break.break_token_hash IS NOT NULL AND
          encode(digest(p_break_token, 'sha256'), 'hex') = v_break.break_token_hash THEN
        v_is_authorized := true;
    END IF;

    IF NOT v_is_authorized THEN
        RETURN jsonb_build_object(
            'success', false,
            'error_code', 'UNAUTHORIZED',
            'message', 'You are not authorized to end this break. Only the student who started it or staff can end it.'
        );
    END IF;

    -- Terminate active break record (cooldown remains active on started_at)
    UPDATE public.break_history
    SET ended_at = clock_timestamp(),
        end_reason = 'early_return'
    WHERE id = v_break.id;

    -- Reset computer to BLANK with 15-minute computer-level cooldown
    UPDATE public.computers
    SET break_started_at = NULL,
        break_expires_at = NULL,
        cooldown_expires_at = clock_timestamp() + interval '15 minutes',
        updated_at = clock_timestamp()
    WHERE id = p_computer_id;

    RETURN jsonb_build_object(
        'success', true,
        'message', 'Welcome back! Your break timer ended successfully. The computer is now blank and in a 15-minute cooldown.',
        'cooldown_expires_at', to_char(clock_timestamp() + interval '15 minutes', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    );
END;
$$;

-- ------------------------------------------------------------------------------
-- 6. GET_MY_ACTIVE_BREAK: Fast Active Break Lookup for Authenticated User
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_my_active_break()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_user_id UUID;
    v_rec RECORD;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('has_active_break', false);
    END IF;

    SELECT bh.id AS break_id, bh.computer_id, c.pc_number, l.id AS lab_id, l.slug AS lab_slug, l.name AS lab_name,
           bh.started_at, bh.scheduled_expires_at
    INTO v_rec
    FROM public.break_history bh
    JOIN public.computers c ON c.id = bh.computer_id
    JOIN public.labs l ON l.id = c.lab_id
    WHERE bh.user_id = v_user_id
      AND bh.ended_at IS NULL
      AND bh.scheduled_expires_at > clock_timestamp();

    IF FOUND THEN
        RETURN jsonb_build_object(
            'has_active_break', true,
            'break_id', v_rec.break_id,
            'computer_id', v_rec.computer_id,
            'pc_number', v_rec.pc_number,
            'lab_id', v_rec.lab_id,
            'lab_slug', v_rec.lab_slug,
            'lab_name', v_rec.lab_name,
            'started_at', to_char(v_rec.started_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            'expires_at', to_char(v_rec.scheduled_expires_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        );
    ELSE
        RETURN jsonb_build_object('has_active_break', false);
    END IF;
END;
$$;

-- ------------------------------------------------------------------------------
-- 7. EXPIRE_BREAKS: Cleanup Stale Timers
-- ------------------------------------------------------------------------------
-- Invoked via pg_cron every minute, or automatically by dashboard/admin sweeps.
-- Ensures computers whose scheduled_expires_at <= now() revert to BLANK.
CREATE OR REPLACE FUNCTION public.expire_breaks()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_cleared_count INTEGER := 0;
BEGIN
    UPDATE public.break_history
    SET ended_at = scheduled_expires_at,
        end_reason = 'expired'
    WHERE ended_at IS NULL
      AND scheduled_expires_at <= clock_timestamp();

    -- Set 15-minute cooldown on computers whose break naturally expired
    UPDATE public.computers
    SET break_started_at = NULL,
        break_expires_at = NULL,
        cooldown_expires_at = break_expires_at + interval '15 minutes',
        updated_at = clock_timestamp()
    WHERE break_expires_at IS NOT NULL
      AND break_expires_at <= clock_timestamp();

    -- Clean up completed cooldowns
    UPDATE public.computers
    SET cooldown_expires_at = NULL,
        updated_at = clock_timestamp()
    WHERE cooldown_expires_at IS NOT NULL
      AND cooldown_expires_at <= clock_timestamp();

    GET DIAGNOSTICS v_cleared_count = ROW_COUNT;
    RETURN v_cleared_count;
END;
$$;

-- ------------------------------------------------------------------------------
-- 7. ADMIN RPCS: Protected by is_admin() check & logged to admin_actions
-- ------------------------------------------------------------------------------

-- Admin Clear Break
CREATE OR REPLACE FUNCTION public.admin_clear_break(
    p_computer_id UUID,
    p_reason TEXT DEFAULT 'Manual admin override'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_computer RECORD;
    v_break RECORD;
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'Unauthorized: only registered administrators can clear timers.';
    END IF;

    SELECT * INTO v_computer
    FROM public.computers
    WHERE id = p_computer_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error_code', 'NOT_FOUND', 'message', 'Computer not found.');
    END IF;

    -- Find active break if any
    SELECT * INTO v_break
    FROM public.break_history
    WHERE computer_id = p_computer_id
      AND ended_at IS NULL
    ORDER BY started_at DESC
    LIMIT 1
    FOR UPDATE;

    IF FOUND THEN
        UPDATE public.break_history
        SET ended_at = clock_timestamp(),
            end_reason = 'admin_cleared'
        WHERE id = v_break.id;
    END IF;

    UPDATE public.computers
    SET break_started_at = NULL,
        break_expires_at = NULL,
        cooldown_expires_at = NULL,
        updated_at = clock_timestamp()
    WHERE id = p_computer_id;

    -- Audit log
    INSERT INTO public.admin_actions (
        admin_id,
        action,
        target_type,
        target_id,
        details
    ) VALUES (
        auth.uid(),
        'CLEAR_BREAK',
        'computer',
        p_computer_id::text,
        jsonb_build_object(
            'reason', p_reason,
            'lab_id', v_computer.lab_id,
            'pc_number', v_computer.pc_number,
            'break_id', v_break.id
        )
    );

    RETURN jsonb_build_object(
        'success', true,
        'message', 'Break timer successfully cleared by administrator.'
    );
END;
$$;

-- Admin List Active Breaks (includes masked roll key prefix for diagnostic distinction)
CREATE OR REPLACE FUNCTION public.admin_list_active_breaks()
RETURNS TABLE (
    break_id UUID,
    computer_id UUID,
    lab_id UUID,
    lab_name TEXT,
    pc_number INTEGER,
    started_at TIMESTAMPTZ,
    scheduled_expires_at TIMESTAMPTZ,
    roll_key_preview TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'Unauthorized: admin access required.';
    END IF;

    RETURN QUERY
    SELECT
        bh.id AS break_id,
        c.id AS computer_id,
        l.id AS lab_id,
        l.name AS lab_name,
        c.pc_number,
        bh.started_at,
        bh.scheduled_expires_at,
        COALESCE(bh.user_email, substring(bh.roll_key from 1 for 8) || '...', 'Student') AS roll_key_preview
    FROM public.break_history bh
    JOIN public.computers c ON c.id = bh.computer_id
    JOIN public.labs l ON l.id = c.lab_id
    WHERE bh.ended_at IS NULL
      AND bh.scheduled_expires_at > clock_timestamp()
    ORDER BY bh.scheduled_expires_at ASC;
END;
$$;

-- Admin Manage Computer (Add / Edit / Remove)
CREATE OR REPLACE FUNCTION public.admin_manage_computer(
    p_action TEXT, -- 'ADD' or 'REMOVE'
    p_lab_id UUID,
    p_pc_number INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_computer_id UUID;
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'Unauthorized: admin access required.';
    END IF;

    IF p_action = 'ADD' THEN
        INSERT INTO public.computers (lab_id, pc_number)
        VALUES (p_lab_id, p_pc_number)
        ON CONFLICT (lab_id, pc_number) DO NOTHING
        RETURNING id INTO v_computer_id;

        INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, details)
        VALUES (auth.uid(), 'ADD_COMPUTER', 'computer', v_computer_id::text, jsonb_build_object('lab_id', p_lab_id, 'pc_number', p_pc_number));

        RETURN jsonb_build_object('success', true, 'message', 'Computer added.');
    ELSIF p_action = 'REMOVE' THEN
        SELECT id INTO v_computer_id FROM public.computers WHERE lab_id = p_lab_id AND pc_number = p_pc_number;
        DELETE FROM public.computers WHERE lab_id = p_lab_id AND pc_number = p_pc_number;

        INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, details)
        VALUES (auth.uid(), 'REMOVE_COMPUTER', 'computer', v_computer_id::text, jsonb_build_object('lab_id', p_lab_id, 'pc_number', p_pc_number));

        RETURN jsonb_build_object('success', true, 'message', 'Computer removed.');
    ELSE
        RETURN jsonb_build_object('success', false, 'message', 'Unknown action.');
    END IF;
END;
$$;

-- ------------------------------------------------------------------------------
-- 8. RETENTION CLEANUP: Purge Expired History & Logs
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cleanup_old_records()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_retention_days INTEGER := 7;
    v_config_val TEXT;
    v_deleted_breaks INTEGER := 0;
    v_deleted_logs INTEGER := 0;
BEGIN
    SELECT value INTO v_config_val
    FROM public.app_config
    WHERE key = 'retention_days';

    IF v_config_val IS NOT NULL THEN
        BEGIN
            v_retention_days := v_config_val::integer;
        EXCEPTION WHEN OTHERS THEN
            v_retention_days := 7;
        END;
    END IF;

    -- Delete old break history past retention period
    DELETE FROM public.break_history
    WHERE started_at < (clock_timestamp() - (v_retention_days || ' days')::interval);
    GET DIAGNOSTICS v_deleted_breaks = ROW_COUNT;

    -- Delete old request logs (keep only 24 hours)
    DELETE FROM public.request_log
    WHERE created_at < (clock_timestamp() - interval '24 hours');
    GET DIAGNOSTICS v_deleted_logs = ROW_COUNT;

    RETURN jsonb_build_object(
        'success', true,
        'deleted_breaks', v_deleted_breaks,
        'deleted_logs', v_deleted_logs
    );
END;
$$;

-- ------------------------------------------------------------------------------
-- 9. PERMISSION GRANTS
-- ------------------------------------------------------------------------------
-- Revoke default public execute
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;

-- Public (anon & authenticated) execution grants for essential student RPCs
GRANT EXECUTE ON FUNCTION public.server_now() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_break(UUID, INTEGER, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.end_break(UUID, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_active_break() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_breaks() TO anon, authenticated;

-- Admin execution grants (functions internally enforce is_admin())
GRANT EXECUTE ON FUNCTION public.is_admin() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_clear_break(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_active_breaks() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_manage_computer(TEXT, UUID, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_old_records() TO authenticated;
