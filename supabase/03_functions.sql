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
    v_email := lower(coalesce(auth.jwt()->>'email', ''));
    RETURN EXISTS (
        SELECT 1
        FROM public.admin_users
        WHERE user_id = auth.uid()
           OR (v_email <> '' AND lower(email) = v_email)
    );
END;
$$;

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
-- 4. START_BREAK: Atomic Break Creation RPC
-- ------------------------------------------------------------------------------
-- Enforces:
-- 1. Exact 15-minute duration (server controlled, client cannot pass duration).
-- 2. Normalized roll regex validation.
-- 3. Roll-key HMAC-SHA256 with private secret pepper.
-- 4. Advisory lock on roll key (prevents concurrent race conditions).
-- 5. Exclusive row lock on computer (FOR UPDATE).
-- 6. Rolling 60-minute cooldown from previous break start.
-- 7. Returns random one-time break token (only SHA-256 hash stored in DB).
CREATE OR REPLACE FUNCTION public.start_break(
    p_lab_id UUID,
    p_pc_number INTEGER,
    p_roll_number TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_norm_roll TEXT;
    v_roll_regex TEXT;
    v_pepper TEXT;
    v_roll_key TEXT;
    v_ip_header TEXT;
    v_ip_hash TEXT;
    v_computer RECORD;
    v_last_started TIMESTAMPTZ;
    v_eligible_at TIMESTAMPTZ;
    v_raw_token TEXT;
    v_token_hash TEXT;
    v_now TIMESTAMPTZ;
    v_expires_at TIMESTAMPTZ;
    v_break_id UUID;
    v_rate_ok BOOLEAN;
BEGIN
    -- 1. Extract best-effort IP header from PostgREST environment
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

    -- 2. Validate roll number input
    IF p_roll_number IS NULL OR trim(p_roll_number) = '' THEN
        RETURN jsonb_build_object(
            'success', false,
            'error_code', 'INVALID_ROLL',
            'message', 'Roll number is required.'
        );
    END IF;

    v_norm_roll := upper(trim(p_roll_number));

    -- Load roll regex pattern from private app_config
    SELECT value INTO v_roll_regex
    FROM public.app_config
    WHERE key = 'roll_regex';

    IF v_roll_regex IS NOT NULL AND v_roll_regex <> '' THEN
        IF v_norm_roll !~ v_roll_regex THEN
            RETURN jsonb_build_object(
                'success', false,
                'error_code', 'INVALID_ROLL',
                'message', 'Roll number does not match the college format requirements.'
            );
        END IF;
    END IF;

    -- Load secret pepper from private app_config
    SELECT value INTO v_pepper
    FROM public.app_config
    WHERE key = 'roll_pepper';

    IF v_pepper IS NULL OR length(v_pepper) < 16 THEN
        RAISE EXCEPTION 'System configuration error: roll_pepper is not configured properly in app_config.';
    END IF;

    -- Compute HMAC-SHA256 roll key
    v_roll_key := encode(hmac(v_norm_roll::bytea, v_pepper::bytea, 'sha256'), 'hex');

    -- Best-effort rate limiting
    v_rate_ok := public.check_rate_limit(v_ip_hash, v_roll_key, 'start_break');
    IF NOT v_rate_ok THEN
        RETURN jsonb_build_object(
            'success', false,
            'error_code', 'RATE_LIMITED',
            'message', 'Too many requests. Please wait a minute before trying again.'
        );
    END IF;

    -- 3. Take advisory transaction lock on the student's roll key
    -- Guarantees that concurrent requests for the same roll key run strictly serialized.
    PERFORM pg_advisory_xact_lock(hashtext('roll:' || v_roll_key));

    -- 4. Lock and verify the computer row
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

    -- Check if computer currently has an active break
    -- Note: Expiry is checked strictly against database time
    IF v_computer.break_expires_at IS NOT NULL AND v_computer.break_expires_at > clock_timestamp() THEN
        RETURN jsonb_build_object(
            'success', false,
            'error_code', 'PC_BUSY',
            'message', 'This computer already has an active break timer running.'
        );
    END IF;

    -- 5. Check rolling 60-minute cooldown on the student's roll key
    SELECT started_at INTO v_last_started
    FROM public.break_history
    WHERE roll_key = v_roll_key
      AND started_at > (clock_timestamp() - interval '60 minutes')
    ORDER BY started_at DESC
    LIMIT 1;

    IF FOUND THEN
        v_eligible_at := v_last_started + interval '60 minutes';
        RETURN jsonb_build_object(
            'success', false,
            'error_code', 'COOLDOWN',
            'message', 'You can only take one break per rolling 60 minutes.',
            'eligible_at', v_eligible_at
        );
    END IF;

    -- 6. Generate cryptographic one-time break token (client receives raw token; DB stores SHA-256)
    v_raw_token := encode(gen_random_bytes(24), 'hex');
    v_token_hash := encode(digest(v_raw_token, 'sha256'), 'hex');

    -- Calculate timestamps using exact database time
    v_now := clock_timestamp();
    v_expires_at := v_now + interval '15 minutes';

    -- Mark any past un-ended break on this computer as expired in history
    UPDATE public.break_history
    SET ended_at = coalesce(ended_at, scheduled_expires_at),
        end_reason = coalesce(end_reason, 'expired')
    WHERE computer_id = v_computer.id
      AND ended_at IS NULL;

    -- Update computer row (public-safe data only)
    UPDATE public.computers
    SET break_started_at = v_now,
        break_expires_at = v_expires_at,
        updated_at = v_now
    WHERE id = v_computer.id;

    -- Record in private break history
    INSERT INTO public.break_history (
        computer_id,
        roll_key,
        break_token_hash,
        started_at,
        scheduled_expires_at
    ) VALUES (
        v_computer.id,
        v_roll_key,
        v_token_hash,
        v_now,
        v_expires_at
    )
    RETURNING id INTO v_break_id;

    -- Return success payload with client-only break token
    RETURN jsonb_build_object(
        'success', true,
        'computer_id', v_computer.id,
        'lab_id', p_lab_id,
        'pc_number', p_pc_number,
        'break_token', v_raw_token,
        'break_started_at', v_now,
        'break_expires_at', v_expires_at
    );
END;
$$;

-- ------------------------------------------------------------------------------
-- 5. END_BREAK: Early Return ("I'm Back") RPC
-- ------------------------------------------------------------------------------
-- Allows ending an active break only if the caller presents the matching break_token
-- or the matching roll_number. Cooldown remains active and is NOT refunded.
CREATE OR REPLACE FUNCTION public.end_break(
    p_computer_id UUID,
    p_break_token TEXT DEFAULT NULL,
    p_roll_number TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_computer RECORD;
    v_break RECORD;
    v_token_hash TEXT;
    v_norm_roll TEXT;
    v_pepper TEXT;
    v_roll_key TEXT;
    v_is_authorized BOOLEAN := false;
BEGIN
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
        -- Computer might have already expired or was cleared
        UPDATE public.computers
        SET break_started_at = NULL,
            break_expires_at = NULL,
            updated_at = clock_timestamp()
        WHERE id = p_computer_id;

        RETURN jsonb_build_object(
            'success', true,
            'message', 'Timer was already blank or expired.'
        );
    END IF;

    -- Validate ownership: Method A (break token)
    IF p_break_token IS NOT NULL AND trim(p_break_token) <> '' THEN
        v_token_hash := encode(digest(trim(p_break_token), 'sha256'), 'hex');
        IF v_token_hash = v_break.break_token_hash THEN
            v_is_authorized := true;
        END IF;
    END IF;

    -- Validate ownership: Method B (roll number re-entry from new device)
    IF NOT v_is_authorized AND p_roll_number IS NOT NULL AND trim(p_roll_number) <> '' THEN
        v_norm_roll := upper(trim(p_roll_number));
        SELECT value INTO v_pepper FROM public.app_config WHERE key = 'roll_pepper';
        IF v_pepper IS NOT NULL THEN
            v_roll_key := encode(hmac(v_norm_roll::bytea, v_pepper::bytea, 'sha256'), 'hex');
            IF v_roll_key = v_break.roll_key THEN
                v_is_authorized := true;
            END IF;
        END IF;
    END IF;

    IF NOT v_is_authorized THEN
        RETURN jsonb_build_object(
            'success', false,
            'error_code', 'UNAUTHORIZED_OWNER',
            'message', 'Invalid break token or roll number. You cannot end another student''s break.'
        );
    END IF;

    -- Mark break ended in history (early return)
    UPDATE public.break_history
    SET ended_at = clock_timestamp(),
        end_reason = 'early_return'
    WHERE id = v_break.id;

    -- Blank the computer status
    UPDATE public.computers
    SET break_started_at = NULL,
        break_expires_at = NULL,
        updated_at = clock_timestamp()
    WHERE id = p_computer_id;

    RETURN jsonb_build_object(
        'success', true,
        'message', 'Welcome back! Break timer ended successfully.'
    );
END;
$$;

-- ------------------------------------------------------------------------------
-- 6. EXPIRE_BREAKS: Cleanup Stale Timers
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
    -- Mark break_history records as expired
    UPDATE public.break_history
    SET ended_at = scheduled_expires_at,
        end_reason = 'expired'
    WHERE ended_at IS NULL
      AND scheduled_expires_at <= clock_timestamp();

    -- Blank computers whose timer expired
    UPDATE public.computers
    SET break_started_at = NULL,
        break_expires_at = NULL,
        updated_at = clock_timestamp()
    WHERE break_expires_at IS NOT NULL
      AND break_expires_at <= clock_timestamp();

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
        substring(bh.roll_key from 1 for 8) || '...' AS roll_key_preview
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
GRANT EXECUTE ON FUNCTION public.expire_breaks() TO anon, authenticated;

-- Admin execution grants (functions internally enforce is_admin())
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_clear_break(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_active_breaks() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_manage_computer(TEXT, UUID, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_old_records() TO authenticated;
