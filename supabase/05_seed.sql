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
    ('roll_regex', '^[0-9]{2}[A-Z]{2,4}[0-9]{3,5}$|^[A-Za-z0-9_-]{3,20}$', 'Regular expression to validate allowed college roll number formats.'),
    ('break_duration_minutes', '15', 'Enforced break duration in minutes (fixed at 15).'),
    ('cooldown_minutes', '60', 'Rolling cooldown window in minutes between break starts for any roll key.'),
    ('retention_days', '7', 'Number of days to keep historical break records before automated purge.'),
    ('belongings_policy', 'Unattended belongings may be moved after the 15-minute break period has elapsed. Please ensure you return before the timer expires.', 'Policy notice displayed on dashboard regarding personal belongings.')
ON CONFLICT (key) DO UPDATE
SET description = EXCLUDED.description;

-- 2. SEED LABS
INSERT INTO public.labs (id, slug, name, display_order, is_active)
VALUES
    ('a0000000-0000-0000-0000-000000000001', 'lab-1', 'Lab 1', 1, true),
    ('a0000000-0000-0000-0000-000000000002', 'lab-2', 'Lab 2', 2, true)
ON CONFLICT (slug) DO UPDATE
SET name = EXCLUDED.name,
    display_order = EXCLUDED.display_order,
    is_active = EXCLUDED.is_active;

-- 3. SEED COMPUTERS (30 PCs per lab, total 60 PCs)
-- Lab 1 PCs
DO $$
DECLARE
    v_lab1_id UUID := 'a0000000-0000-0000-0000-000000000001';
    v_lab2_id UUID := 'a0000000-0000-0000-0000-000000000002';
    i INTEGER;
BEGIN
    FOR i IN 1..30 LOOP
        INSERT INTO public.computers (lab_id, pc_number)
        VALUES (v_lab1_id, i)
        ON CONFLICT (lab_id, pc_number) DO NOTHING;
    END LOOP;

    FOR i IN 1..30 LOOP
        INSERT INTO public.computers (lab_id, pc_number)
        VALUES (v_lab2_id, i)
        ON CONFLICT (lab_id, pc_number) DO NOTHING;
    END LOOP;
END $$;
