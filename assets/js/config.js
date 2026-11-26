/**
 * config.js - Application Configuration & CDN Imports
 * ==============================================================================
 * IMPORTANT: Replace the placeholders below with your actual Supabase credentials.
 * The public ANON key is safe for client-side use with Row Level Security.
 * The SERVICE-ROLE key must NEVER be placed in client-side code or committed.
 * ==============================================================================
 */

export const CONFIG = {
  // Supabase Project Settings (Replace with your project details from Supabase Dashboard -> Settings -> API)
  SUPABASE_URL: 'https://onofshoylvogapvzahyx.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_-xn_St3BrG2F8_NNb7Nexg_RUyti_Cj',

  // Pinned CDN Libraries (ES modules loaded directly in browser)
  SUPABASE_SDK_CDN: 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.48.1/+esm',
  QRCODE_SDK_CDN: 'https://cdn.jsdelivr.net/npm/qrcode@1.5.4/+esm',

  // Application Defaults
  BREAK_DURATION_MINUTES: 15,
  COOLDOWN_MINUTES: 60,
  POLL_INTERVAL_MS: 30000, // 30 seconds polling fallback
  TIME_SYNC_INTERVAL_MS: 60000, // Sync database server time every 60 seconds

  // Local Storage Keys
  STORAGE_ACTIVE_TOKENS: 'ccc_lab_break_active_tokens', // Stores client-side break tokens: { [computerId]: { token, rollPrefix, expiresAt } }

  // Default Policy Notices (Overridden dynamically if app_config provides customized text)
  VACANCY_NOTICE: 'Blank means no break timer is active. It does not confirm the computer is free. Check in person and follow the lab\'s belongings policy.',
  DEFAULT_BELONGINGS_POLICY: 'Unattended belongings may be moved after the 15-minute break period has elapsed. Please ensure you return before the timer expires.'
};
