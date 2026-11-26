-- ==============================================================================
-- 05_seed.sql: Idempotent Seed Data for Lab Break-Timer
-- ==============================================================================
-- Seeds default app_config, 2 labs (Lab 1 & Lab 2), and 30 computers per lab.
-- Safe to re-run multiple times (uses ON CONFLICT DO NOTHING / UPDATE).
-- ==============================================================================

-- 1. SEED APP_CONFIG
-- Note: 'roll_pepper' is seeded with a placeholder. Follow MANUAL_SETUP.md
-- to replace this with a cryptographically generated high-entropy random key!
INSERT INTO public.app_config (key, value, description)
VALUES
    ('roll_pepper', 'REPLACE_WITH_64_CHAR_HEX_SECRET_PEPPER_GENERATED_VIA_OPENSSL_RAND_HEX_32', 'Secret pepper string used for HMAC-SHA256 roll key generation. Strictly private.'),
    ('roll_regex', '^(IMS|MSC|IPHD|PHD)[0-9]{4,6}$', 'Regular expression to validate college roll numbers: IMS, MSC, IPHD, PHD prefix followed by 4-6 digits.'),
    ('break_duration_minutes', '15', 'Enforced break duration in minutes (fixed at 15).'),
    ('cooldown_minutes', '60', 'Rolling cooldown window in minutes between break starts for any roll key.'),
    ('retention_days', '7', 'Number of days to keep historical break records before automated purge.'),
    ('belongings_policy', 'Unattended belongings may be moved after the 15-minute break period has elapsed. Please ensure you return before the timer expires.', 'Policy notice displayed on dashboard regarding personal belongings.')
ON CONFLICT (key) DO UPDATE
SET description = EXCLUDED.description;

-- 2. SEED LABS (CCC & IDC)
INSERT INTO public.labs (id, slug, name, display_order, is_active)
VALUES
    ('a0000000-0000-0000-0000-000000000001', 'ccc', 'CCC', 1, true),
    ('a0000000-0000-0000-0000-000000000002', 'idc', 'IDC', 2, true)
ON CONFLICT (slug) DO UPDATE
SET name = EXCLUDED.name,
    display_order = EXCLUDED.display_order,
    is_active = EXCLUDED.is_active;

-- 3. SEED COMPUTERS (151 PCs in CCC, 100 PCs in IDC)
DO $$
DECLARE
    v_ccc_id UUID := 'a0000000-0000-0000-0000-000000000001';
    v_idc_id UUID := 'a0000000-0000-0000-0000-000000000002';
    i INTEGER;
BEGIN
    -- CCC has 151 computers
    FOR i IN 1..151 LOOP
        INSERT INTO public.computers (lab_id, pc_number)
        VALUES (v_ccc_id, i)
        ON CONFLICT (lab_id, pc_number) DO NOTHING;
    END LOOP;

    -- IDC has 100 computers
    FOR i IN 1..100 LOOP
        INSERT INTO public.computers (lab_id, pc_number)
        VALUES (v_idc_id, i)
        ON CONFLICT (lab_id, pc_number) DO NOTHING;
    END LOOP;
END $$;
