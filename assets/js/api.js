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
let clientPromise = null;
let realtimeChannel = null;

/**
 * Initializes and returns the singleton Supabase client
 * Uses eager memoized promise with automatic CDN fallback and retry capability
 */
export async function getSupabase() {
  if (supabaseClient) return supabaseClient;
  if (!clientPromise) {
    clientPromise = (async () => {
      try {
        if (!CONFIG.SUPABASE_URL || CONFIG.SUPABASE_URL.includes('YOUR_PROJECT_ID')) {
          console.warn('Supabase URL is not configured. Please set SUPABASE_URL in config.js.');
        }

        let module;
        try {
          module = await import(CONFIG.SUPABASE_SDK_CDN);
        } catch (primaryCdnErr) {
          console.warn('Primary Supabase CDN unreachable, falling back to secondary CDN:', primaryCdnErr.message);
          module = await import('https://esm.sh/@supabase/supabase-js@2.48.1');
        }

        const { createClient } = module;
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
      } catch (err) {
        // Reset clientPromise on failure so future calls or retries can re-attempt initialization
        clientPromise = null;
        console.error('Failed to initialize Supabase client:', err);
        throw err;
      }
    })();
  }
  return clientPromise;
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
 * Fetch all active labs with automatic single retry
 */
export async function fetchLabs() {
  const executeQuery = async () => {
    const supabase = await getSupabase();
    const { data, error } = await supabase
      .from('labs')
      .select('id, slug, name, display_order')
      .eq('is_active', true)
      .order('display_order', { ascending: true });

    if (error) throw error;
    return data || [];
  };

  try {
    return await executeQuery();
  } catch (err) {
    console.warn('fetchLabs failed, retrying once...', err.message);
    await new Promise(r => setTimeout(r, 800));
    return await executeQuery();
  }
}

/**
 * Fetch computers for a given lab with automatic single retry (public-safe data only)
 * @param {string} labId
 */
export async function fetchComputers(labId) {
  const executeQuery = async () => {
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
  };

  try {
    return await executeQuery();
  } catch (err) {
    console.warn(`fetchComputers for lab ${labId} failed, retrying once...`, err.message);
    await new Promise(r => setTimeout(r, 800));
    return await executeQuery();
  }
}

/**
 * Start a break on a computer (Authenticated account identity enforced on backend)
 * @param {string} labId
 * @param {number} pcNumber
 * @returns {Promise<{ success: boolean, break_token?: string, break_expires_at?: string, error_code?: string, message?: string, eligible_at?: string, active_pc_number?: number, active_lab_name?: string }>}
 */
export async function startBreak(labId, pcNumber) {
  const supabase = await getSupabase();
  const { data, error } = await supabase.rpc('start_break', {
    p_lab_id: labId,
    p_pc_number: parseInt(pcNumber, 10)
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
 */
export async function endBreak(computerId, breakToken = null) {
  const supabase = await getSupabase();
  const { data, error } = await supabase.rpc('end_break', {
    p_computer_id: computerId,
    p_break_token: breakToken || null
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
 * Check if the currently authenticated user has an active break anywhere
 */
export async function getMyActiveBreak() {
  try {
    const supabase = await getSupabase();
    const { data, error } = await supabase.rpc('get_my_active_break');
    if (error) return { has_active_break: false };
    return data || { has_active_break: false };
  } catch (err) {
    return { has_active_break: false };
  }
}

/**
 * Subscribe to realtime computer status updates
 * @param {function} onComputerChange - Callback with changed row
 * @param {function} onStatusChange - Callback with connection status ('SUBSCRIBED', 'CLOSED', 'CHANNEL_ERROR')
 */
export async function subscribeToComputerUpdates(onComputerChange, onStatusChange) {
  try {
    const supabase = await getSupabase();

    if (realtimeChannel) {
      try {
        await supabase.removeChannel(realtimeChannel);
      } catch (removeErr) {
        console.warn('Channel remove warning:', removeErr);
      }
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
  } catch (err) {
    console.warn('Realtime subscription initialization error:', err);
    if (onStatusChange) {
      onStatusChange('CHANNEL_ERROR', err);
    }
    return null;
  }
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
// AUTHENTICATION API METHODS (STUDENTS & STAFF)
// ------------------------------------------------------------------------------

/**
 * Safely removes OAuth access tokens, refresh tokens, and codes from URL
 * without triggering a page reload. Preserves query parameters like ?lab=ccc&pc=12.
 */
export function cleanAuthUrl() {
  if (typeof window === 'undefined' || !window.history || !window.history.replaceState) return;
  try {
    const url = new URL(window.location.href);
    let changed = false;

    // Remove hash if it contains auth tokens or errors
    if (url.hash && (
      url.hash.includes('access_token') ||
      url.hash.includes('refresh_token') ||
      url.hash.includes('error') ||
      url.hash.includes('type=')
    )) {
      url.hash = '';
      changed = true;
    }

    // Remove OAuth query parameters if present
    const authParams = ['code', 'error', 'error_description', 'error_code'];
    for (const p of authParams) {
      if (url.searchParams.has(p)) {
        url.searchParams.delete(p);
        changed = true;
      }
    }

    if (changed) {
      const cleanUrl = url.pathname + (url.search ? url.search : '') + (url.hash ? url.hash : '');
      window.history.replaceState(null, document.title, cleanUrl);
    }
  } catch (e) {
    console.warn('Could not clean auth URL:', e);
  }
}

/**
 * Inspects URL hash and query string for OAuth redirect errors from Google or Supabase
 */
export function getUrlAuthError() {
  if (typeof window === 'undefined') return null;
  try {
    const url = new URL(window.location.href);
    const hash = (url.hash || '').slice(1);
    const hashParams = new URLSearchParams(hash);
    const searchParams = url.searchParams;

    const error = searchParams.get('error') || hashParams.get('error');
    const errorDescription = searchParams.get('error_description') || hashParams.get('error_description');
    const errorCode = searchParams.get('error_code') || hashParams.get('error_code');

    if (error || errorDescription || errorCode) {
      return {
        error,
        error_code: errorCode,
        description: decodeURIComponent(errorDescription || error || 'Authentication failed').replace(/\+/g, ' ')
      };
    }
  } catch (e) {
    console.warn('Could not inspect auth error from URL:', e);
  }
  return null;
}

/**
 * Sign in with Google OAuth (Students & Administrators)
 * @param {string} [returnUrl] - URL to redirect back to after OAuth flow
 * @param {boolean} [restrictDomain=true] - Restrict account picker to @iisertvm.ac.in
 */
export async function signInWithGoogle(returnUrl = null, restrictDomain = true) {
  const supabase = await getSupabase();
  
  let cleanRedirect = returnUrl;
  if (!cleanRedirect && typeof window !== 'undefined') {
    const origin = window.location.origin;
    let pathname = window.location.pathname;
    if (!pathname.endsWith('/') && !pathname.endsWith('.html')) {
      pathname += '/';
    }
    cleanRedirect = origin + pathname;
  }
  
  const queryParams = {
    prompt: 'select_account'
  };
  if (restrictDomain) {
    queryParams.hd = 'iisertvm.ac.in';
  }

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: cleanRedirect,
      queryParams
    }
  });
  if (error) throw error;
  if (data?.url && typeof window !== 'undefined') {
    window.location.href = data.url;
  }
  return data;
}

/**
 * Sign out the currently authenticated user
 */
export async function signOut() {
  const supabase = await getSupabase();
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

/**
 * Get current session and user object.
 * Resolves PKCE authorization codes if present in URL.
 */
export async function getUserSession() {
  const supabase = await getSupabase();

  // If OAuth code is in URL search params (PKCE flow), exchange code for session explicitly
  if (typeof window !== 'undefined' && window.location.search && window.location.search.includes('code=')) {
    try {
      const { data: codeData, error: codeError } = await supabase.auth.exchangeCodeForSession(window.location.href);
      if (!codeError && codeData?.session) {
        cleanAuthUrl();
        return codeData.session;
      }
    } catch (e) {
      console.warn('PKCE exchange warning (falling back to getSession):', e.message);
    }
  }

  const { data: { session }, error } = await supabase.auth.getSession();
  if (error || !session) return null;

  cleanAuthUrl();
  return session;
}

/**
 * Check if the currently authenticated user is an authorized admin
 */
export async function isCurrentUserAdmin() {
  try {
    const supabase = await getSupabase();
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return false;
    const { data, error } = await supabase.rpc('is_admin');
    if (error) return false;
    return !!data;
  } catch (err) {
    return false;
  }
}

/**
 * Subscribe to global Auth state changes
 */
export async function onAuthStateChange(callback) {
  const supabase = await getSupabase();
  return supabase.auth.onAuthStateChange(callback);
}

// ------------------------------------------------------------------------------
// ADMIN API METHODS
// ------------------------------------------------------------------------------

/**
 * Admin Sign In with Google OAuth
 */
export async function adminSignInWithGoogle() {
  let cleanRedirect = null;
  if (typeof window !== 'undefined') {
    const origin = window.location.origin;
    let pathname = window.location.pathname;
    if (!pathname.endsWith('/') && !pathname.endsWith('.html')) {
      pathname += '/admin.html';
    }
    cleanRedirect = origin + pathname;
  }
  return signInWithGoogle(cleanRedirect, false);
}

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
  return signOut();
}

/**
 * Get current session and check if user is admin.
 * Resolves PKCE authorization codes if present in URL.
 */
export async function getAdminSession() {
  const supabase = await getSupabase();

  if (typeof window !== 'undefined' && window.location.search && window.location.search.includes('code=')) {
    try {
      const { data: codeData, error: codeError } = await supabase.auth.exchangeCodeForSession(window.location.href);
      if (!codeError && codeData?.session) {
        cleanAuthUrl();
      }
    } catch (e) {
      console.warn('Admin PKCE exchange warning:', e.message);
    }
  }

  const { data: { session }, error } = await supabase.auth.getSession();
  if (error || !session) return null;

  cleanAuthUrl();

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
  return onAuthStateChange(callback);
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
