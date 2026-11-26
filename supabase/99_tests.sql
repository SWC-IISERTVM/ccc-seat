-- ==============================================================================
-- 99_tests.sql: Comprehensive Verification Test Suite
-- ==============================================================================
-- Tests business rules, concurrency guarantees, cooldown enforcement,
-- early returns, expiration logic, and public privacy isolation.
-- Run in Supabase SQL Editor. Outputs PASS / FAIL summary table.
-- ==============================================================================

DO $$
DECLARE
    v_lab_id UUID;
    v_pc1_num INTEGER := 101;
    v_pc2_num INTEGER := 102;
    v_roll_alice TEXT := '21CS101';
    v_roll_bob TEXT := '21CS102';
    v_res1 JSONB;
    v_res2 JSONB;
    v_res3 JSONB;
    v_res4 JSONB;
    v_res5 JSONB;
    v_res6 JSONB;
    v_token_alice TEXT;
    v_eligible_at TIMESTAMPTZ;
    v_pass_count INTEGER := 0;
    v_total_count INTEGER := 0;
    v_computer_row RECORD;
BEGIN
    PERFORM set_config('search_path', 'public, extensions, pg_temp', true);
    RAISE NOTICE '=== STARTING COMPUTER LAB BREAK TIMER TEST SUITE ===';

    -- 0. Setup isolated test lab and computers
    INSERT INTO public.labs (id, slug, name, display_order, is_active)
    VALUES ('f0000000-0000-0000-0000-000000000099', 'test-lab', 'Test Lab', 99, true)
    ON CONFLICT (slug) DO UPDATE SET is_active = true
    RETURNING id INTO v_lab_id;

    -- Ensure test computers exist and are clean
    INSERT INTO public.computers (lab_id, pc_number, break_started_at, break_expires_at)
    VALUES
        (v_lab_id, v_pc1_num, NULL, NULL),
        (v_lab_id, v_pc2_num, NULL, NULL)
    ON CONFLICT (lab_id, pc_number) DO UPDATE
    SET break_started_at = NULL, break_expires_at = NULL;

    -- Clear any history for test rolls
    DELETE FROM public.break_history
    WHERE roll_key IN (
        SELECT encode(hmac(upper(r)::bytea, (SELECT value FROM public.app_config WHERE key = 'roll_pepper')::bytea, 'sha256'), 'hex')
        FROM unnest(ARRAY[v_roll_alice, v_roll_bob]) AS r
    );

    -- --------------------------------------------------------------------------
    -- TEST 1: start_break sets exactly 15 minutes database time
    -- --------------------------------------------------------------------------
    v_total_count := v_total_count + 1;
    v_res1 := public.start_break(v_lab_id, v_pc1_num, v_roll_alice);

    IF (v_res1->>'success')::boolean = true
       AND (v_res1->>'break_token') IS NOT NULL
       AND ((v_res1->>'break_expires_at')::timestamptz - (v_res1->>'break_started_at')::timestamptz) = interval '15 minutes' THEN
        v_pass_count := v_pass_count + 1;
        v_token_alice := v_res1->>'break_token';
        RAISE NOTICE 'TEST 1 PASSED: Break started with exact 15-minute duration and generated token.';
    ELSE
        RAISE WARNING 'TEST 1 FAILED: %', v_res1;
    END IF;

    -- --------------------------------------------------------------------------
    -- TEST 2: Second simultaneous break on SAME computer is rejected (PC_BUSY)
    -- --------------------------------------------------------------------------
    v_total_count := v_total_count + 1;
    v_res2 := public.start_break(v_lab_id, v_pc1_num, v_roll_bob);

    IF (v_res2->>'success')::boolean = false AND v_res2->>'error_code' = 'PC_BUSY' THEN
        v_pass_count := v_pass_count + 1;
        RAISE NOTICE 'TEST 2 PASSED: Second break on busy PC properly rejected with PC_BUSY.';
    ELSE
        RAISE WARNING 'TEST 2 FAILED: Expected PC_BUSY but got %', v_res2;
    END IF;

    -- --------------------------------------------------------------------------
    -- TEST 3: Same roll number trying another break on different PC is rejected (COOLDOWN)
    -- --------------------------------------------------------------------------
    v_total_count := v_total_count + 1;
    v_res3 := public.start_break(v_lab_id, v_pc2_num, v_roll_alice);

    IF (v_res3->>'success')::boolean = false
       AND v_res3->>'error_code' = 'COOLDOWN'
       AND (v_res3->>'eligible_at') IS NOT NULL THEN
        v_pass_count := v_pass_count + 1;
        v_eligible_at := (v_res3->>'eligible_at')::timestamptz;
        RAISE NOTICE 'TEST 3 PASSED: Second break within 60m rejected with COOLDOWN. Eligible at: %', v_eligible_at;
    ELSE
        RAISE WARNING 'TEST 3 FAILED: Expected COOLDOWN but got %', v_res3;
    END IF;

    -- --------------------------------------------------------------------------
    -- TEST 4: Unauthorized user cannot end another student's break
    -- --------------------------------------------------------------------------
    v_total_count := v_total_count + 1;
    SELECT id INTO v_computer_row FROM public.computers WHERE lab_id = v_lab_id AND pc_number = v_pc1_num;

    -- Attempt with invalid token
    v_res4 := public.end_break(v_computer_row.id, 'bad_token_1234567890', NULL);

    -- Attempt with wrong roll number
    v_res5 := public.end_break(v_computer_row.id, NULL, v_roll_bob);

    IF (v_res4->>'success')::boolean = false AND v_res4->>'error_code' = 'UNAUTHORIZED_OWNER'
       AND (v_res5->>'success')::boolean = false AND v_res5->>'error_code' = 'UNAUTHORIZED_OWNER' THEN
        v_pass_count := v_pass_count + 1;
        RAISE NOTICE 'TEST 4 PASSED: Unauthorized end_break attempts properly rejected.';
    ELSE
        RAISE WARNING 'TEST 4 FAILED: Bad token result: %, Wrong roll result: %', v_res4, v_res5;
    END IF;

    -- --------------------------------------------------------------------------
    -- TEST 5: Early return ("I'm Back") with valid token ends break; cooldown remains!
    -- --------------------------------------------------------------------------
    v_total_count := v_total_count + 1;
    v_res6 := public.end_break(v_computer_row.id, v_token_alice, NULL);

    -- Check computer state is now BLANK
    SELECT * INTO v_computer_row FROM public.computers WHERE lab_id = v_lab_id AND pc_number = v_pc1_num;

    -- Check if Alice still has cooldown despite early return
    v_res2 := public.start_break(v_lab_id, v_pc1_num, v_roll_alice);

    IF (v_res6->>'success')::boolean = true
       AND v_computer_row.break_expires_at IS NULL
       AND (v_res2->>'success')::boolean = false AND v_res2->>'error_code' = 'COOLDOWN' THEN
        v_pass_count := v_pass_count + 1;
        RAISE NOTICE 'TEST 5 PASSED: Early return blanked computer successfully; 60m cooldown is retained.';
    ELSE
        RAISE WARNING 'TEST 5 FAILED: res6: %, computer blanked: %, cooldown retained: %', v_res6, (v_computer_row.break_expires_at IS NULL), v_res2;
    END IF;

    -- --------------------------------------------------------------------------
    -- TEST 6: Public computers table contains zero private identifiers
    -- --------------------------------------------------------------------------
    v_total_count := v_total_count + 1;
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'computers'
          AND column_name IN ('roll_number', 'roll_key', 'token', 'token_hash', 'student_id', 'break_token')
    ) THEN
        v_pass_count := v_pass_count + 1;
        RAISE NOTICE 'TEST 6 PASSED: public.computers schema is strictly public-safe (no private columns).';
    ELSE
        RAISE WARNING 'TEST 6 FAILED: Found sensitive column names in public.computers!';
    END IF;

    -- --------------------------------------------------------------------------
    -- TEST 7: expire_breaks cleans up past expired timers
    -- --------------------------------------------------------------------------
    v_total_count := v_total_count + 1;
    -- Artificially simulate an expired break
    UPDATE public.computers
    SET break_started_at = now() - interval '20 minutes',
        break_expires_at = now() - interval '5 minutes'
    WHERE lab_id = v_lab_id AND pc_number = v_pc2_num;

    PERFORM public.expire_breaks();

    SELECT * INTO v_computer_row FROM public.computers WHERE lab_id = v_lab_id AND pc_number = v_pc2_num;

    IF v_computer_row.break_expires_at IS NULL THEN
        v_pass_count := v_pass_count + 1;
        RAISE NOTICE 'TEST 7 PASSED: expire_breaks correctly cleared past expired timer.';
    ELSE
        RAISE WARNING 'TEST 7 FAILED: Computer still has break_expires_at after expire_breaks.';
    END IF;

    -- Cleanup test data
    DELETE FROM public.computers WHERE lab_id = v_lab_id;
    DELETE FROM public.labs WHERE id = v_lab_id;

    RAISE NOTICE '==================================================';
    RAISE NOTICE 'TEST RESULTS: % / % PASSED', v_pass_count, v_total_count;
    IF v_pass_count = v_total_count THEN
        RAISE NOTICE 'ALL MANDATORY DATABASE TESTS PASSED SUCCESSFULLY!';
    ELSE
        RAISE EXCEPTION 'TEST SUITE FAILED: Only % of % tests passed.', v_pass_count, v_total_count;
    END IF;
    RAISE NOTICE '==================================================';
END $$;
