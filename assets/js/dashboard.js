/**
 * dashboard.js - Public Lab Break-Timer Dashboard
 * ==============================================================================
 * Handles:
 * - Lab switching & responsive PC grid rendering
 * - Realtime updates with polling fallback & clock-skew correction
 * - Zero roll numbers or tokens exposed in the public DOM
 * - Immediate client-side transition to BLANK on expiry (database time)
 * - Start Break modal / bottom sheet with 60m cooldown feedback
 * - "I'm Back" early return handling via localStorage token or roll number
 * - QR deep-link auto-selection (?lab=...&pc=...)
 * ==============================================================================
 */

import { CONFIG } from './config.js';
import * as api from './api.js';
import * as time from './time.js';

// Static resilient default labs (guarantees UI never breaks even during cold network/DNS startup)
const DEFAULT_LABS = [
  { id: 'a0000000-0000-0000-0000-000000000001', slug: 'ccc', name: 'CCC', display_order: 1 },
  { id: 'a0000000-0000-0000-0000-000000000002', slug: 'idc', name: 'IDC', display_order: 2 }
];

// Application state
const state = {
  labs: [...DEFAULT_LABS],
  selectedLabId: DEFAULT_LABS[0].id,
  computers: new Map(), // computerId -> row
  localTokens: {}, // computerId -> { token, expiresAt, labId, pcNumber }
  connectionStatus: 'connecting', // 'live' | 'connecting' | 'offline'
  isRealtimeConnected: false,
  lastSuccessfulSync: 0,
  consecutiveSyncFailures: 0,
  activeModalPcId: null,
  deepLinkHandled: false,
  currentUser: null,
  isAdmin: false,
  myActiveBreak: null // Active break record owned by the authenticated student
};

// DOM Elements
const dom = {
  connectionBadge: document.getElementById('connectionBadge'),
  statusText: document.getElementById('statusText'),
  offlineBanner: document.getElementById('offlineBanner'),
  domainAlert: document.getElementById('domainAlert'),
  userAuthArea: document.getElementById('userAuthArea'),
  staffAccessLink: document.getElementById('staffAccessLink'),
  labTabs: document.getElementById('labTabs'),
  pcGrid: document.getElementById('pcGrid'),
  ariaLive: document.getElementById('ariaLive'),
  modalOverlay: document.getElementById('breakModal'),
  modalTitle: document.getElementById('modalTitle'),
  modalSubtitle: document.getElementById('modalSubtitle'),
  modalBody: document.getElementById('modalBody'),
  modalCloseBtn: document.getElementById('modalCloseBtn'),
  belongingsNotice: document.getElementById('belongingsNotice')
};

/**
 * Announce messages to screen readers via ARIA live region
 */
function announceAria(message) {
  if (dom.ariaLive) {
    dom.ariaLive.textContent = message;
  }
}

/**
 * Load saved break tokens from localStorage
 */
function loadLocalTokens() {
  try {
    const raw = localStorage.getItem(CONFIG.STORAGE_ACTIVE_TOKENS);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Clean up already expired tokens
      const cleaned = {};
      for (const [id, item] of Object.entries(parsed)) {
        if (!time.isBreakExpired(item.expiresAt)) {
          cleaned[id] = item;
        }
      }
      state.localTokens = cleaned;
      saveLocalTokens();
    }
  } catch (err) {
    console.warn('Could not read localStorage break tokens:', err);
    state.localTokens = {};
  }
}

/**
 * Save break tokens to localStorage
 */
function saveLocalTokens() {
  try {
    localStorage.setItem(CONFIG.STORAGE_ACTIVE_TOKENS, JSON.stringify(state.localTokens));
  } catch (err) {
    console.warn('Could not save break tokens to localStorage:', err);
  }
}

/**
 * Update connection indicator in UI
 * Resilient multi-tier logic:
 * - Online/Live as long as HTTP sync is healthy or Realtime is connected
 * - NEVER flags offline merely because an ephemeral WebSocket disconnected
 * - Shows offline warning ONLY when device has no network or repeated HTTP syncs fail for >90s
 */
function updateConnectionUI(overrideStatus = null) {
  if (!dom.connectionBadge) return;

  const isBrowserOnline = typeof navigator.onLine === 'boolean' ? navigator.onLine : true;
  const hasRecentSync = state.lastSuccessfulSync > 0 && (Date.now() - state.lastSuccessfulSync) < 90000;
  const isHardFailure = !isBrowserOnline || (state.consecutiveSyncFailures >= 3 && !hasRecentSync);

  dom.connectionBadge.className = 'connection-badge';

  if (overrideStatus === 'connecting' || (state.lastSuccessfulSync === 0 && !isHardFailure)) {
    state.connectionStatus = 'connecting';
    dom.connectionBadge.classList.add('is-connecting');
    dom.statusText.textContent = 'Connecting...';
    if (dom.offlineBanner) dom.offlineBanner.classList.remove('is-active');
  } else if (isHardFailure) {
    state.connectionStatus = 'offline';
    dom.connectionBadge.classList.add('is-offline');
    dom.statusText.textContent = 'Offline';
    if (dom.offlineBanner) dom.offlineBanner.classList.add('is-active');
    document.querySelectorAll('.pc-tile').forEach(tile => tile.classList.add('is-stale'));
  } else {
    state.connectionStatus = 'live';
    dom.statusText.textContent = 'Live';
    if (dom.offlineBanner) dom.offlineBanner.classList.remove('is-active');
    document.querySelectorAll('.pc-tile').forEach(tile => tile.classList.remove('is-stale'));
  }
}

// ------------------------------------------------------------------------------
// STUDENT & INSTITUTIONAL AUTHENTICATION
// ------------------------------------------------------------------------------

/**
 * Extract roll number from student email if matching the institutional pattern
 * e.g. ims22001@iisertvm.ac.in -> IMS22001
 */
function extractRollFromEmail(email) {
  if (!email) return '';
  const localPart = email.split('@')[0];
  if (/^(IMS|MSC|IPHD|PHD)[0-9]{4,6}$/i.test(localPart)) {
    return localPart.toUpperCase();
  }
  return '';
}

/**
 * Sanitize strings for safe HTML interpolation
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Check active user session and enforce @iisertvm.ac.in restriction
 * Uses cached session if provided to eliminate duplicate network roundtrips
 */
async function checkUserAuth(existingSession = null) {
  try {
    const session = existingSession !== null ? existingSession : await api.getUserSession();
    if (session && session.user && session.user.email) {
      const email = session.user.email.toLowerCase();

      // Check domain restriction: must be @iisertvm.ac.in or an authorized admin
      if (!email.endsWith('@iisertvm.ac.in')) {
        const isAdmin = await api.isCurrentUserAdmin();
        if (!isAdmin) {
          // Block non-institutional account immediately
          await api.signOut();
          state.currentUser = null;
          state.isAdmin = false;
          state.myActiveBreak = null;
          showDomainAlert(`Access restricted: Only @iisertvm.ac.in institutional accounts are permitted. (${session.user.email} signed out)`);
          renderUserAuthUI();
          return;
        }
      }

      state.currentUser = session.user;
      hideDomainAlert();
      renderUserAuthUI();

      // Parallel non-blocking lookup of active break and admin privileges
      api.getMyActiveBreak().then(activeBreak => {
        if (activeBreak && activeBreak.has_active_break) {
          state.myActiveBreak = activeBreak;
          renderGrid();
        } else {
          state.myActiveBreak = null;
        }
      });

      api.isCurrentUserAdmin().then(isAdmin => {
        if (state.isAdmin !== isAdmin) {
          state.isAdmin = isAdmin;
          renderUserAuthUI();
        }
      });
    } else {
      state.currentUser = null;
      state.isAdmin = false;
      state.myActiveBreak = null;
      renderUserAuthUI();
    }
  } catch (err) {
    console.warn('Auth check warning:', err);
    state.currentUser = null;
    state.isAdmin = false;
    state.myActiveBreak = null;
    renderUserAuthUI();
  }
}

/**
 * Display top domain alert banner
 */
function showDomainAlert(message) {
  if (dom.domainAlert) {
    dom.domainAlert.textContent = message;
    dom.domainAlert.style.display = 'block';
    announceAria(message);
  }
}

/**
 * Hide top domain alert banner
 */
function hideDomainAlert() {
  if (dom.domainAlert) {
    dom.domainAlert.style.display = 'none';
  }
}

/**
 * Render authentication pill or sign-in trigger in header
 */
function renderUserAuthUI() {
  if (!dom.userAuthArea) return;

  if (state.currentUser) {
    const rawEmail = state.currentUser.email || '';
    const safeEmail = escapeHtml(rawEmail);
    const shortEmail = safeEmail.length > 20 ? safeEmail.slice(0, 18) + '…' : safeEmail;
    dom.userAuthArea.innerHTML = `
      <div class="user-pill" title="${safeEmail}">
        <span class="user-pill-email">${shortEmail}</span>
        <span class="user-pill-tag">Verified</span>
        <button type="button" id="headerSignOutBtn" class="user-pill-signout" title="Sign Out">Sign Out</button>
      </div>
    `;
    const signOutBtn = document.getElementById('headerSignOutBtn');
    if (signOutBtn) {
      signOutBtn.addEventListener('click', handleUserSignOut);
    }
  } else {
    dom.userAuthArea.innerHTML = `
      <button type="button" id="headerSignInBtn" class="auth-btn-header" title="Sign in with IISER TVM Google account">
        <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
          <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/>
          <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/>
        </svg>
        <span>Sign In (@iisertvm)</span>
      </button>
    `;
    const signInBtn = document.getElementById('headerSignInBtn');
    if (signInBtn) {
      signInBtn.addEventListener('click', () => handleStudentGoogleSignIn());
    }
  }

  // Update staff access portal link based on admin status
  if (dom.staffAccessLink) {
    if (state.isAdmin) {
      dom.staffAccessLink.textContent = 'Staff Portal (Admin)';
    } else {
      dom.staffAccessLink.textContent = 'Staff Access';
    }
  }
}

/**
 * Sign out current student session
 */
async function handleUserSignOut() {
  try {
    await api.signOut();
  } catch (err) {
    console.warn('Sign out error:', err);
  }
  state.currentUser = null;
  state.isAdmin = false;
  state.myActiveBreak = null;
  renderUserAuthUI();
  renderGrid();

  if (state.activeModalPcId) {
    const pc = state.computers.get(state.activeModalPcId);
    if (pc) renderModalContent(pc);
  }
}

/**
 * Initiate Google OAuth for students, preserving PC selection deep link
 */
async function handleStudentGoogleSignIn(pc = null) {
  try {
    const origin = window.location.origin;
    let pathname = window.location.pathname;
    if (!pathname.endsWith('/') && !pathname.endsWith('.html')) {
      pathname += '/';
    }
    let returnUrl = origin + pathname;
    if (pc) {
      const lab = state.labs.find(l => l.id === pc.lab_id);
      if (lab) {
        returnUrl += `?lab=${encodeURIComponent(lab.slug)}&pc=${pc.pc_number}`;
      }
    }
    await api.signInWithGoogle(returnUrl, true);
  } catch (err) {
    alert('Sign in error: ' + (err.message || 'Failed to start Google sign in.'));
  }
}

/**
 * Render Lab selector tabs
 */
function renderLabTabs() {
  if (!dom.labTabs) return;
  dom.labTabs.innerHTML = '';

  state.labs.forEach(lab => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `tab-btn ${lab.id === state.selectedLabId ? 'is-active' : ''}`;
    btn.textContent = lab.name;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', lab.id === state.selectedLabId ? 'true' : 'false');
    btn.addEventListener('click', () => switchLab(lab.id));
    dom.labTabs.appendChild(btn);
  });
}

/**
 * Switch active lab view
 */
async function switchLab(labId) {
  if (state.selectedLabId === labId) return;
  state.selectedLabId = labId;
  renderLabTabs();
  renderGridLoading();
  await loadComputersForLab(labId);
  renderGrid();
}

/**
 * Display skeleton placeholder while computers load
 */
function renderGridLoading() {
  if (!dom.pcGrid) return;
  dom.pcGrid.innerHTML = '<div class="grid-placeholder">Loading computers...</div>';
}

/**
 * Fetch computers for currently selected lab
 */
async function loadComputersForLab(labId) {
  const targetLabId = labId || state.selectedLabId;
  if (!targetLabId) return;

  try {
    const list = await api.fetchComputers(targetLabId);
    state.computers.clear();
    list.forEach(pc => {
      state.computers.set(pc.id, pc);
    });
    state.lastSuccessfulSync = Date.now();
    state.consecutiveSyncFailures = 0;
    updateConnectionUI();
  } catch (err) {
    console.warn(`Sync warning for lab ${targetLabId}:`, err);
    state.consecutiveSyncFailures += 1;
    updateConnectionUI();
  }
}

/**
 * Render the full grid of computers
 */
function renderGrid() {
  if (!dom.pcGrid) return;
  dom.pcGrid.innerHTML = '';

  const pcs = Array.from(state.computers.values())
    .filter(pc => pc.lab_id === state.selectedLabId)
    .sort((a, b) => a.pc_number - b.pc_number);

  if (pcs.length === 0) {
    dom.pcGrid.innerHTML = '<div class="grid-placeholder">No computers configured for this lab.</div>';
    return;
  }

  pcs.forEach(pc => {
    const tile = createPcTileElement(pc);
    dom.pcGrid.appendChild(tile);
  });

  // Re-sync open modal if currently viewing a PC
  if (state.activeModalPcId) {
    const current = state.computers.get(state.activeModalPcId);
    if (current) renderModalContent(current);
  }
}

/**
 * Build a single PC Tile DOM element
 */
function createPcTileElement(pc) {
  const tile = document.createElement('div');
  tile.id = `pc-tile-${pc.id}`;
  tile.dataset.pcId = pc.id;
  tile.setAttribute('role', 'button');
  tile.setAttribute('tabindex', '0');

  updateTileVisual(tile, pc);

  const handleClick = () => openBreakModal(pc.id);
  tile.addEventListener('click', handleClick);
  tile.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleClick();
    }
  });

  return tile;
}

/**
 * Update visual state of an individual PC tile in place
 */
function updateTileVisual(tile, pc) {
  const isExpired = time.isBreakExpired(pc.break_expires_at);
  const isMyBreak = (state.myActiveBreak && state.myActiveBreak.computer_id === pc.id) || !!state.localTokens[pc.id];

  tile.className = 'pc-tile';
  if (state.connectionStatus === 'offline') {
    tile.classList.add('is-stale');
  }

  if (isExpired) {
    // BLANK state: strictly neutral, no "available" or "free" wording
    tile.classList.add('is-blank');
    tile.setAttribute('aria-label', `PC ${String(pc.pc_number).padStart(2, '0')}, blank`);
    tile.innerHTML = `
      <div class="pc-tile-number">PC ${String(pc.pc_number).padStart(2, '0')}</div>
      <div class="pc-tile-status">BLANK</div>
    `;
  } else {
    // ON BREAK state: amber accent, countdown
    const rem = time.getRemainingTime(pc.break_expires_at);
    tile.classList.add('is-break');
    if (isMyBreak) tile.classList.add('is-my-break');

    tile.setAttribute('aria-label', `PC ${String(pc.pc_number).padStart(2, '0')}, on break, ${rem.mm} minutes ${rem.ss} seconds remaining`);
    tile.innerHTML = `
      <div class="pc-tile-number">PC ${String(pc.pc_number).padStart(2, '0')}</div>
      <div class="pc-tile-break-info">
        <span class="pc-tile-badge">${isMyBreak ? 'MY BREAK' : 'BREAK'}</span>
        <span class="pc-tile-timer tabular-nums" data-timer-for="${pc.id}">${rem.mm}:${rem.ss}</span>
      </div>
    `;
  }
}

/**
 * Ticker interval runs every 1000ms:
 * - Updates countdown text for active break tiles in DOM
 * - Instantly transitions any timer that reached 00:00 to BLANK
 */
function tickCountdowns() {
  const serverNow = time.getServerNow();

  // Tick grid tiles
  document.querySelectorAll('[data-timer-for]').forEach(el => {
    const pcId = el.dataset.timerFor;
    const pc = state.computers.get(pcId);
    if (!pc) return;

    if (time.isBreakExpired(pc.break_expires_at)) {
      // Immediate frontend transition to BLANK
      pc.break_expires_at = null;
      pc.break_started_at = null;
      const tile = document.getElementById(`pc-tile-${pcId}`);
      if (tile) updateTileVisual(tile, pc);
      // Clean local storage if this device owned it
      if (state.localTokens[pcId]) {
        delete state.localTokens[pcId];
        saveLocalTokens();
      }
      if (state.myActiveBreak && state.myActiveBreak.computer_id === pcId) {
        state.myActiveBreak = null;
      }
      // If modal is currently viewing this PC, re-render modal
      if (state.activeModalPcId === pcId) {
        renderModalContent(pc);
      }
    } else {
      const rem = time.getRemainingTime(pc.break_expires_at);
      el.textContent = `${rem.mm}:${rem.ss}`;
    }
  });

  // Tick active modal countdown if present
  const modalCountdown = document.getElementById('modalActiveCountdown');
  if (modalCountdown && state.activeModalPcId) {
    const pc = state.computers.get(state.activeModalPcId);
    if (pc && !time.isBreakExpired(pc.break_expires_at)) {
      const rem = time.getRemainingTime(pc.break_expires_at);
      modalCountdown.textContent = `${rem.mm}:${rem.ss}`;
    }
  }
}

// ------------------------------------------------------------------------------
// MODAL / BOTTOM SHEET INTERACTIONS
// ------------------------------------------------------------------------------

/**
 * Open break modal for a computer
 */
function openBreakModal(pcId) {
  const pc = state.computers.get(pcId);
  if (!pc) return;

  state.activeModalPcId = pcId;
  const lab = state.labs.find(l => l.id === pc.lab_id);

  dom.modalTitle.textContent = `${lab ? lab.name : 'Lab'} — PC ${String(pc.pc_number).padStart(2, '0')}`;
  renderModalContent(pc);

  dom.modalOverlay.classList.add('is-open');
  dom.modalOverlay.setAttribute('aria-hidden', 'false');

  // Focus trap / auto-focus
  setTimeout(() => {
    const startBtn = document.getElementById('startBreakSubmitBtn');
    const backBtn = document.getElementById('imBackBtn');
    const viewBtn = document.getElementById('viewMyBreakBtn');
    const googleBtn = document.getElementById('modalGoogleSignInBtn');
    const closeBtn = dom.modalCloseBtn;
    if (startBtn) startBtn.focus();
    else if (backBtn) backBtn.focus();
    else if (viewBtn) viewBtn.focus();
    else if (googleBtn) googleBtn.focus();
    else if (closeBtn) closeBtn.focus();
  }, 100);
}

/**
 * Close break modal
 */
function closeModal() {
  state.activeModalPcId = null;
  dom.modalOverlay.classList.remove('is-open');
  dom.modalOverlay.setAttribute('aria-hidden', 'true');
  dom.modalBody.innerHTML = '';
}

/**
 * Render modal contents based on whether computer is Blank or On Break
 */
function renderModalContent(pc) {
  const isExpired = time.isBreakExpired(pc.break_expires_at);
  const myTokenInfo = state.localTokens[pc.id];
  const isMyBreak = (state.myActiveBreak && state.myActiveBreak.computer_id === pc.id) || !!myTokenInfo;

  if (isExpired) {
    // --------------------------------------------------------------------------
    // CASE A: PC IS BLANK -> Show Start Break Form (Requires @iisertvm Auth)
    // --------------------------------------------------------------------------
    if (!state.currentUser) {
      // Student is not signed in
      dom.modalSubtitle.textContent = 'Institutional verification required';
      dom.modalBody.innerHTML = `
        <div class="auth-gate-box">
          <div class="auth-gate-badge">IISER TVM Verification Required</div>
          <p class="auth-gate-text">
            To activate a 15-minute break timer and protect your computer, please sign in with your official <strong>@iisertvm.ac.in</strong> Google account.
          </p>
          <button type="button" id="modalGoogleSignInBtn" class="btn btn-google">
            <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/>
            </svg>
            Sign In with Google (@iisertvm.ac.in)
          </button>
          <div class="form-hint" style="text-align: center; margin-top: 12px;">
            Access is strictly restricted to students and scholars of IISER Thiruvananthapuram.
          </div>
        </div>
      `;

      const modalSignInBtn = document.getElementById('modalGoogleSignInBtn');
      if (modalSignInBtn) {
        modalSignInBtn.addEventListener('click', () => handleStudentGoogleSignIn(pc));
      }
    } else if (state.myActiveBreak && state.myActiveBreak.computer_id !== pc.id) {
      // Student already has an active break on a different computer!
      dom.modalSubtitle.textContent = 'Account limit reached';
      dom.modalBody.innerHTML = `
        <div class="active-break-notice-card" style="background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 6px; padding: 16px; margin-bottom: 16px;">
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
            <span style="font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--accent-amber);">Active Break in Progress</span>
            <span class="user-pill-tag">1 Account = 1 PC</span>
          </div>
          <p style="font-size: 14px; margin: 0 0 10px 0; color: var(--text-primary); line-height: 1.5;">
            You already have an active break on <strong>PC ${String(state.myActiveBreak.pc_number).padStart(2, '0')}</strong> in <strong>${escapeHtml(state.myActiveBreak.lab_name || 'Lab')}</strong>.
          </p>
          <p class="form-hint" style="margin: 0 0 16px 0; line-height: 1.4;">
            To ensure fair resource sharing, your account may only hold one computer on break at a time across all labs. You can start another break after your active break finishes.
          </p>
          <button type="button" id="viewMyBreakBtn" class="btn btn-outline" style="width: 100%;">
            Go to My Active PC (${String(state.myActiveBreak.pc_number).padStart(2, '0')})
          </button>
        </div>
      `;

      const viewBtn = document.getElementById('viewMyBreakBtn');
      if (viewBtn) {
        viewBtn.addEventListener('click', async () => {
          const targetBreak = state.myActiveBreak;
          if (!targetBreak) return;
          if (targetBreak.lab_id && targetBreak.lab_id !== state.selectedLabId) {
            await switchLab(targetBreak.lab_id);
          }
          openBreakModal(targetBreak.computer_id);
        });
      }
    } else {
      // Student is signed in and eligible to start a break (NO ROLL NUMBER ENTRY)
      dom.modalSubtitle.textContent = 'No active break timer';
      dom.modalBody.innerHTML = `
        <div class="student-session-box" style="margin-bottom: 16px;">
          <div class="student-session-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
            <span class="student-session-label" style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted); font-weight: 600;">Verified Account</span>
            <span class="user-pill-tag" style="font-size: 11px; background: rgba(52, 168, 83, 0.1); color: #1e8e3e; padding: 2px 6px; border-radius: 4px; font-weight: 500;">IISER TVM</span>
          </div>
          <div class="student-session-email" style="font-weight: 600; font-size: 13px; color: var(--text-primary); word-break: break-all;">${escapeHtml(state.currentUser.email)}</div>
        </div>

        <div class="info-row" style="display: flex; justify-content: space-between; padding: 8px 0; border-top: 1px solid var(--border-color); border-bottom: 1px solid var(--border-color); margin-bottom: 16px;">
          <span class="info-label" style="font-size: 13px; color: var(--text-muted);">Duration</span>
          <span class="info-val" style="font-size: 13px; font-weight: 600; color: var(--text-primary);">15 Minutes (Fixed)</span>
        </div>

        <div id="modalError" class="form-error" role="alert"></div>

        <form id="startBreakForm" autocomplete="off">
          <p class="form-hint" style="margin-top: 0; margin-bottom: 16px; line-height: 1.4;">
            Starting a break reserves this computer for 15 minutes. One break per account across all labs. A rolling 60-minute cooldown applies.
          </p>

          <button type="submit" id="startBreakSubmitBtn" class="btn btn-primary" style="width: 100%;">
            Start 15-Minute Break
          </button>
        </form>
      `;

      const form = document.getElementById('startBreakForm');
      if (form) {
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          handleStartBreakSubmit(pc);
        });
      }
    }
  } else {
    // --------------------------------------------------------------------------
    // CASE B: PC IS ON BREAK -> Show Active Countdown & "I'm Back" Options
    // --------------------------------------------------------------------------
    const rem = time.getRemainingTime(pc.break_expires_at);
    dom.modalSubtitle.textContent = 'Break timer in progress';

    if (isMyBreak) {
      // Current authenticated student owns this break
      const token = myTokenInfo ? myTokenInfo.token : null;
      dom.modalBody.innerHTML = `
        <div class="active-break-display">
          <div id="modalActiveCountdown" class="active-break-countdown tabular-nums">${rem.mm}:${rem.ss}</div>
          <div class="active-break-note">Your Active Break</div>
        </div>

        <div id="modalError" class="form-error" role="alert"></div>

        <button type="button" id="imBackBtn" class="btn btn-primary" style="width: 100%;">
          I'm Back (End Break Early)
        </button>
        <div class="form-hint" style="text-align: center; margin-top: 8px; line-height: 1.4;">
          Ending your break early frees this computer immediately. Your 60-minute rolling cooldown remains active.
        </div>
      `;

      const imBackBtn = document.getElementById('imBackBtn');
      if (imBackBtn) {
        imBackBtn.addEventListener('click', () => handleEndBreak(pc.id, token));
      }
    } else {
      // Another student started this break
      dom.modalBody.innerHTML = `
        <div class="active-break-display">
          <div id="modalActiveCountdown" class="active-break-countdown tabular-nums">${rem.mm}:${rem.ss}</div>
          <div class="active-break-note">Break timer in progress by another student</div>
        </div>

        <div id="modalError" class="form-error" role="alert"></div>

        <p class="form-hint" style="text-align: center; margin-top: 14px; line-height: 1.4;">
          This computer is currently reserved. When the timer expires, the computer will automatically revert to blank and become available.
        </p>
      `;
    }
  }
}

/**
 * Display inline error inside modal
 */
function showModalError(message) {
  const errBox = document.getElementById('modalError');
  if (errBox) {
    errBox.textContent = message;
    errBox.classList.add('is-visible');
  }
}

/**
 * Handle Start Break form submission (Account identity verified by backend)
 */
async function handleStartBreakSubmit(pc) {
  const submitBtn = document.getElementById('startBreakSubmitBtn');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Starting Break...';
  }

  try {
    const res = await api.startBreak(pc.lab_id, pc.pc_number);

    if (!res.success) {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Start 15-Minute Break';
      }

      if (res.error_code === 'ACTIVE_BREAK_EXISTS') {
        showModalError(res.message || 'You already have an active break on another computer.');
        api.getMyActiveBreak().then(activeBreak => {
          if (activeBreak && activeBreak.has_active_break) {
            state.myActiveBreak = activeBreak;
            renderGrid();
            renderModalContent(pc);
          }
        });
      } else if (res.error_code === 'COOLDOWN') {
        const eligibleTime = res.eligible_at ? time.formatLocalTime(res.eligible_at) : 'later';
        showModalError(`Cooldown active: You can only take one break per rolling 60 minutes. Eligible again at ${eligibleTime}.`);
      } else if (res.error_code === 'PC_BUSY') {
        showModalError('This computer already has an active break timer.');
        await loadComputersForLab(pc.lab_id);
        renderGrid();
      } else if (res.error_code === 'RACE_DETECTED') {
        showModalError('Another break was just registered on this computer or account. Please refresh.');
        await loadComputersForLab(pc.lab_id);
        renderGrid();
      } else if (res.error_code === 'AUTH_REQUIRED') {
        showModalError('Institutional sign-in required. Please sign in with your @iisertvm.ac.in Google account.');
        state.currentUser = null;
        renderUserAuthUI();
        renderModalContent(pc);
      } else if (res.error_code === 'UNAUTHORIZED_DOMAIN') {
        showModalError('Access restricted: Only verified @iisertvm.ac.in accounts are permitted.');
      } else if (res.error_code === 'RATE_LIMITED') {
        showModalError('Too many attempts. Please wait a minute before trying again.');
      } else {
        showModalError(res.message || 'Failed to start break. Please try again.');
      }
      return;
    }

    // Success: store break token in localStorage for "I'm Back" ownership
    state.localTokens[pc.id] = {
      token: res.break_token,
      expiresAt: res.break_expires_at,
      labId: pc.lab_id,
      pcNumber: pc.pc_number
    };
    saveLocalTokens();

    const activeLab = state.labs.find(l => l.id === pc.lab_id);
    state.myActiveBreak = {
      has_active_break: true,
      computer_id: pc.id,
      pc_number: pc.pc_number,
      lab_id: pc.lab_id,
      lab_name: activeLab ? activeLab.name : 'Lab',
      expires_at: res.break_expires_at
    };

    // Update local computer model
    pc.break_started_at = res.break_started_at;
    pc.break_expires_at = res.break_expires_at;
    state.computers.set(pc.id, pc);

    // Update tile in grid
    const tile = document.getElementById(`pc-tile-${pc.id}`);
    if (tile) updateTileVisual(tile, pc);

    announceAria(`15-minute break started on PC ${pc.pc_number}.`);

    // Switch modal to active break countdown view
    renderModalContent(pc);
  } catch (err) {
    console.error('Error starting break:', err);
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Start 15-Minute Break';
    }
    showModalError('Network error. Please verify your connection.');
  }
}

/**
 * Handle ending a break ("I'm Back" action)
 */
async function handleEndBreak(computerId, token = null) {
  const btn = document.getElementById('imBackBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Ending break...';
  }

  try {
    const res = await api.endBreak(computerId, token);

    if (!res.success) {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "I'm Back (End Break Early)";
      }
      showModalError(res.message || 'Could not end break.');
      return;
    }

    // Remove token from local storage
    delete state.localTokens[computerId];
    saveLocalTokens();
    state.myActiveBreak = null;

    // Reset computer in memory
    const pc = state.computers.get(computerId);
    if (pc) {
      pc.break_started_at = null;
      pc.break_expires_at = null;
      state.computers.set(computerId, pc);
      const tile = document.getElementById(`pc-tile-${computerId}`);
      if (tile) updateTileVisual(tile, pc);
    }

    announceAria('Break ended on PC. Computer is now blank.');
    closeModal();
    renderGrid();
  } catch (err) {
    console.error('Error ending break:', err);
    if (btn) {
      btn.disabled = false;
      btn.textContent = "I'm Back (End Break Early)";
    }
    showModalError('Network error while ending break.');
  }
}

/**
 * Handle incoming Realtime row changes on public.computers
 */
function handleRealtimeChange(payload) {
  const { eventType, new: newRow, old: oldRow } = payload;

  if (eventType === 'DELETE' && oldRow) {
    state.computers.delete(oldRow.id);
    const tile = document.getElementById(`pc-tile-${oldRow.id}`);
    if (tile) tile.remove();
    return;
  }

  if (newRow) {
    state.computers.set(newRow.id, newRow);
    if (newRow.lab_id === state.selectedLabId) {
      const tile = document.getElementById(`pc-tile-${newRow.id}`);
      if (tile) {
        updateTileVisual(tile, newRow);
      } else {
        renderGrid();
      }

      if (state.activeModalPcId === newRow.id) {
        renderModalContent(newRow);
      }
    }
  }
}

/**
 * Process deep link parameters (?lab=<slug_or_id>&pc=<pc_number>)
 */
function handleDeepLink() {
  if (state.deepLinkHandled) return;
  const url = new URL(window.location.href);
  const labParam = url.searchParams.get('lab');
  const pcParam = url.searchParams.get('pc');

  if (!labParam && !pcParam) return;

  // Find matching lab
  let matchedLab = state.labs.find(l => l.slug.toLowerCase() === (labParam || '').toLowerCase() || l.id === labParam);
  if (!matchedLab && state.labs.length > 0) {
    matchedLab = state.labs[0];
  }

  if (matchedLab && matchedLab.id !== state.selectedLabId) {
    switchLab(matchedLab.id).then(() => triggerDeepLinkPc(pcParam));
  } else {
    triggerDeepLinkPc(pcParam);
  }

  state.deepLinkHandled = true;
}

function triggerDeepLinkPc(pcParam) {
  if (!pcParam) return;
  const pcNum = parseInt(pcParam, 10);
  for (const pc of state.computers.values()) {
    if (pc.lab_id === state.selectedLabId && pc.pc_number === pcNum) {
      openBreakModal(pc.id);
      break;
    }
  }
}

// ------------------------------------------------------------------------------
// INITIALIZATION
// ------------------------------------------------------------------------------

async function init() {
  loadLocalTokens();

  // Check for any OAuth errors redirected back from Google or Supabase
  const authError = api.getUrlAuthError();
  if (authError) {
    showDomainAlert(`Sign-in notice: ${authError.description}`);
    api.cleanAuthUrl();
  }

  // Modal event listeners
  if (dom.modalCloseBtn) {
    dom.modalCloseBtn.addEventListener('click', closeModal);
  }
  if (dom.modalOverlay) {
    dom.modalOverlay.addEventListener('click', (e) => {
      if (e.target === dom.modalOverlay) closeModal();
    });
  }
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && dom.modalOverlay.classList.contains('is-open')) {
      closeModal();
    }
  });

  // Re-sync on network reconnect & visibility change
  window.addEventListener('online', async () => {
    state.consecutiveSyncFailures = 0;
    updateConnectionUI('connecting');
    await api.syncDatabaseClock();
    if (state.selectedLabId) {
      await loadComputersForLab(state.selectedLabId);
      renderGrid();
    }
    setupRealtimeSubscription();
  });

  window.addEventListener('offline', () => {
    updateConnectionUI();
  });

  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') {
      await api.syncDatabaseClock();
      if (state.selectedLabId) {
        await loadComputersForLab(state.selectedLabId);
        renderGrid();
      }
      if (!state.isRealtimeConnected) {
        setupRealtimeSubscription();
      }
    }
  });

  // Track user ID to debounce redundant onAuthStateChange runs
  let lastCheckedUserId = undefined;

  // Listen for auth state changes (OAuth redirects or sign-outs)
  api.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
      api.cleanAuthUrl();
    }
    const userId = session?.user?.id || null;
    if (userId === lastCheckedUserId && event !== 'SIGNED_OUT') {
      return; // Skip duplicate auth triggers on INITIAL_SESSION + SIGNED_IN
    }
    lastCheckedUserId = userId;
    await checkUserAuth(session);
    if (state.activeModalPcId) {
      const pc = state.computers.get(state.activeModalPcId);
      if (pc) renderModalContent(pc);
    }
  });

  // Pre-render lab tabs from default labs so UI is instantly populated
  renderLabTabs();

  // Parallel initial data load (eliminates serial waterfalls!)
  try {
    const [clockRes, sessionRes, labsRes] = await Promise.allSettled([
      api.syncDatabaseClock(),
      api.getUserSession(),
      api.fetchLabs()
    ]);

    if (sessionRes.status === 'fulfilled' && sessionRes.value) {
      lastCheckedUserId = sessionRes.value.user?.id || null;
      await checkUserAuth(sessionRes.value);
    } else {
      await checkUserAuth(null);
    }

    if (labsRes.status === 'fulfilled' && labsRes.value && labsRes.value.length > 0) {
      state.labs = labsRes.value;
      if (!state.labs.some(l => l.id === state.selectedLabId)) {
        state.selectedLabId = state.labs[0].id;
      }
      renderLabTabs();
    }

    // Load computers for active lab
    await loadComputersForLab(state.selectedLabId);
    renderGrid();
    handleDeepLink();
  } catch (err) {
    console.warn('Initialization warning:', err);
    state.consecutiveSyncFailures += 1;
    updateConnectionUI();
  }

  // Setup auto-reconnecting Realtime Subscription
  setupRealtimeSubscription();

  // Setup 1000ms ticker for live tabular-num countdowns
  setInterval(tickCountdowns, 1000);

  // Setup resilient polling fallback & time sync (every 10 seconds)
  // Ensures workstations are always synchronized even if WebSockets are restricted by firewall/adblocker
  setInterval(async () => {
    await api.syncDatabaseClock();
    if (state.selectedLabId) {
      await loadComputersForLab(state.selectedLabId);
      // Clean up local tokens against any server resets
      for (const [id, item] of Object.entries(state.localTokens)) {
        const pc = state.computers.get(id);
        if (!pc || time.isBreakExpired(pc.break_expires_at)) {
          delete state.localTokens[id];
        }
      }
      saveLocalTokens();
      renderGrid();
    }
  }, 10000);
}

let realtimeReconnectTimer = null;
let realtimeReconnectDelay = 2000;

/**
 * Setup and manage auto-reconnecting Realtime subscription
 */
function setupRealtimeSubscription() {
  if (realtimeReconnectTimer) {
    clearTimeout(realtimeReconnectTimer);
    realtimeReconnectTimer = null;
  }

  api.subscribeToComputerUpdates(
    (payload) => handleRealtimeChange(payload),
    (status) => {
      if (status === 'SUBSCRIBED') {
        state.isRealtimeConnected = true;
        realtimeReconnectDelay = 2000; // Reset backoff
        updateConnectionUI();
      } else {
        // Realtime disconnected, timed out, or closed:
        // DO NOT mark the app as offline! HTTP polling continues seamlessly.
        state.isRealtimeConnected = false;
        updateConnectionUI();

        // Schedule auto-reconnect with exponential backoff if device is online
        if (!realtimeReconnectTimer && (typeof navigator.onLine !== 'boolean' || navigator.onLine)) {
          const delay = Math.min(realtimeReconnectDelay, 30000);
          realtimeReconnectDelay = Math.min(realtimeReconnectDelay * 1.5, 30000);
          realtimeReconnectTimer = setTimeout(() => {
            realtimeReconnectTimer = null;
            setupRealtimeSubscription();
          }, delay);
        }
      }
    }
  );
}

// Start application when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
