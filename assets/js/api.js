/**
 * api.js - Supabase Client & Backend RPC Wrapper
 * ==============================================================================
 * Encapsulates all database interactions.
 * - Public reads: only public-safe tables (labs, computers).
 * - Public mutations: strictly through SECURITY DEFINER RPC functions.
 * - Admin mutations: authenticated RPC functions with is_admin() checks.
 * ==============================================================================
 */

import { CONFIG } from './config.js';
import { syncServerTime } from './time.js';

let supabaseClient = null;
let realtimeChannel = null;

/**
 * Initializes and returns the singleton Supabase client
 */
export async function getSupabase() {
  if (supabaseClient) return supabaseClient;

  // Verify configuration placeholders
  if (!CONFIG.SUPABASE_URL || CONFIG.SUPABASE_URL.includes('YOUR_PROJECT_ID')) {
    console.warn('Supabase URL is not configured. Please set SUPABASE_URL in config.js.');
  }

  const { createClient } = await import(CONFIG.SUPABASE_SDK_CDN);
  supabaseClient = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true
    },
    realtime: {
      params: {
        eventsPerSecond: 10
      }
    }
  });

  return supabaseClient;
}

/**
 * Sync server clock skew with database
 */
export async function syncDatabaseClock() {
  try {
    const supabase = await getSupabase();
    const { data, error } = await supabase.rpc('server_now');
    if (error) throw error;
    if (data) {
      syncServerTime(data);
      return data;
    }
  } catch (err) {
    console.warn('Clock synchronization warning:', err.message);
  }
  return null;
}

/**
 * Fetch all active labs
 */
export async function fetchLabs() {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('labs')
    .select('id, slug, name, display_order')
    .eq('is_active', true)
    .order('display_order', { ascending: true });

  if (error) throw error;
  return data || [];
}

/**
 * Fetch computers for a given lab (public-safe data only)
 * @param {string} labId
 */
export async function fetchComputers(labId) {
  const supabase = await getSupabase();
  let query = supabase
    .from('computers')
    .select('id, lab_id, pc_number, break_started_at, break_expires_at, updated_at')
    .order('pc_number', { ascending: true });

  if (labId) {
    query = query.eq('lab_id', labId);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

/**
 * Start a break on a computer
 * @param {string} labId
 * @param {number} pcNumber
 * @param {string} rollNumber
 * @returns {Promise<{ success: boolean, break_token?: string, break_expires_at?: string, error_code?: string, message?: string, eligible_at?: string }>}
 */
export async function startBreak(labId, pcNumber, rollNumber) {
  const supabase = await getSupabase();
  const { data, error } = await supabase.rpc('start_break', {
    p_lab_id: labId,
    p_pc_number: parseInt(pcNumber, 10),
    p_roll_number: rollNumber
  });

  if (error) {
    return {
      success: false,
      error_code: 'SERVER_ERROR',
      message: error.message || 'Failed to start break timer.'
    };
  }

  return data;
}

/**
 * End an active break (Early return / "I'm Back")
 * @param {string} computerId
 * @param {string|null} breakToken
 * @param {string|null} rollNumber
 */
export async function endBreak(computerId, breakToken = null, rollNumber = null) {
  const supabase = await getSupabase();
  const { data, error } = await supabase.rpc('end_break', {
    p_computer_id: computerId,
    p_break_token: breakToken || null,
    p_roll_number: rollNumber || null
  });

  if (error) {
    return {
      success: false,
      error_code: 'SERVER_ERROR',
      message: error.message || 'Failed to end break timer.'
    };
  }

  return data;
}

/**
 * Subscribe to realtime computer status updates
 * @param {function} onComputerChange - Callback with changed row
 * @param {function} onStatusChange - Callback with connection status ('SUBSCRIBED', 'CLOSED', 'CHANNEL_ERROR')
 */
export async function subscribeToComputerUpdates(onComputerChange, onStatusChange) {
  const supabase = await getSupabase();

  if (realtimeChannel) {
    await supabase.removeChannel(realtimeChannel);
  }

  realtimeChannel = supabase
    .channel('public:computers')
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'computers'
      },
      (payload) => {
        if (onComputerChange) {
          onComputerChange(payload);
        }
      }
    )
    .subscribe((status, err) => {
      if (onStatusChange) {
        onStatusChange(status, err);
      }
    });

  return realtimeChannel;
}

/**
 * Unsubscribe realtime channel
 */
export async function unsubscribeFromComputerUpdates() {
  if (realtimeChannel && supabaseClient) {
    await supabaseClient.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
}

// ------------------------------------------------------------------------------
// ADMIN API METHODS
// ------------------------------------------------------------------------------

/**
 * Admin Sign In with Email & Password
 */
export async function adminSignIn(email, password) {
  const supabase = await getSupabase();
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password
  });
  if (error) throw error;
  return data;
}

/**
 * Admin Sign Out
 */
export async function adminSignOut() {
  const supabase = await getSupabase();
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

/**
 * Get current session and check if user is admin
 */
export async function getAdminSession() {
  const supabase = await getSupabase();
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error || !session) return null;

  // Verify against is_admin() RPC
  const { data: isAdmin, error: rpcError } = await supabase.rpc('is_admin');
  if (rpcError || !isAdmin) {
    return null;
  }

  return session;
}

/**
 * Listen for Auth state changes
 */
export async function onAdminAuthStateChange(callback) {
  const supabase = await getSupabase();
  return supabase.auth.onAuthStateChange(callback);
}

/**
 * Admin: List active breaks across all labs
 */
export async function adminListActiveBreaks() {
  const supabase = await getSupabase();
  const { data, error } = await supabase.rpc('admin_list_active_breaks');
  if (error) throw error;
  return data || [];
}

/**
 * Admin: Clear an active break timer
 * @param {string} computerId
 * @param {string} reason
 */
export async function adminClearBreak(computerId, reason = 'Admin manual override') {
  const supabase = await getSupabase();
  const { data, error } = await supabase.rpc('admin_clear_break', {
    p_computer_id: computerId,
    p_reason: reason
  });
  if (error) throw error;
  return data;
}

/**
 * Admin: Add or remove computer in inventory
 * @param {'ADD'|'REMOVE'} action
 * @param {string} labId
 * @param {number} pcNumber
 */
export async function adminManageComputer(action, labId, pcNumber) {
  const supabase = await getSupabase();
  const { data, error } = await supabase.rpc('admin_manage_computer', {
    p_action: action,
    p_lab_id: labId,
    p_pc_number: parseInt(pcNumber, 10)
  });
  if (error) throw error;
  return data;
}

/**
 * Admin: Fetch action logs
 * @param {number} limit
 */
export async function adminGetActionLogs(limit = 50) {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('admin_actions')
    .select('id, admin_id, action, target_type, target_id, details, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data || [];
}
