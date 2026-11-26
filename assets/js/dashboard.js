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

// Application state
const state = {
  labs: [],
  selectedLabId: null,
  computers: new Map(), // computerId -> row
  localTokens: {}, // computerId -> { token, expiresAt, labId, pcNumber }
  connectionStatus: 'connecting', // 'live' | 'connecting' | 'offline'
  activeModalPcId: null,
  deepLinkHandled: false
};

// DOM Elements
const dom = {
  connectionBadge: document.getElementById('connectionBadge'),
  statusText: document.getElementById('statusText'),
  offlineBanner: document.getElementById('offlineBanner'),
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
 */
function updateConnectionUI(status) {
  state.connectionStatus = status;
  if (!dom.connectionBadge) return;

  dom.connectionBadge.className = 'connection-badge';

  if (status === 'live') {
    dom.statusText.textContent = 'Live';
    dom.offlineBanner.classList.remove('is-active');
    document.querySelectorAll('.pc-tile').forEach(tile => tile.classList.remove('is-stale'));
  } else if (status === 'connecting') {
    dom.connectionBadge.classList.add('is-connecting');
    dom.statusText.textContent = 'Connecting...';
  } else {
    dom.connectionBadge.classList.add('is-offline');
    dom.statusText.textContent = 'Offline';
    dom.offlineBanner.classList.add('is-active');
    document.querySelectorAll('.pc-tile').forEach(tile => tile.classList.add('is-stale'));
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
  try {
    const list = await api.fetchComputers(labId);
    state.computers.clear();
    list.forEach(pc => {
      state.computers.set(pc.id, pc);
    });
    updateConnectionUI('live');
  } catch (err) {
    console.error('Failed to load computers:', err);
    updateConnectionUI('offline');
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
  const isMyBreak = !!state.localTokens[pc.id];

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
        <span class="pc-tile-badge">BREAK</span>
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
    const rollInput = document.getElementById('rollNumberInput');
    if (rollInput) {
      rollInput.focus();
    } else {
      const closeBtn = dom.modalCloseBtn;
      if (closeBtn) closeBtn.focus();
    }
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

  if (isExpired) {
    // --------------------------------------------------------------------------
    // CASE A: PC IS BLANK -> Show Start Break Form
    // --------------------------------------------------------------------------
    dom.modalSubtitle.textContent = 'No active break timer';
    dom.modalBody.innerHTML = `
      <div class="info-row">
        <span class="info-label">Break Duration</span>
        <span class="info-val">15 Minutes (Fixed)</span>
      </div>

      <div id="modalError" class="form-error" role="alert"></div>

      <form id="startBreakForm" autocomplete="off">
        <div class="form-group">
          <label for="rollNumberInput" class="form-label">College Roll Number</label>
          <input
            type="text"
            id="rollNumberInput"
            name="rollNumber"
            class="form-input"
            placeholder="e.g. 21CS101"
            required
            maxlength="20"
            autocapitalize="characters"
            spellcheck="false"
          />
          <div class="form-hint">Used only to enforce the rolling 60-minute cooldown. Never shown publicly.</div>
        </div>

        <button type="submit" id="startBreakSubmitBtn" class="btn btn-primary">
          Start 15-Minute Break
        </button>
      </form>
    `;

    const form = document.getElementById('startBreakForm');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      handleStartBreakSubmit(pc);
    });
  } else {
    // --------------------------------------------------------------------------
    // CASE B: PC IS ON BREAK -> Show Active Countdown & "I'm Back" Options
    // --------------------------------------------------------------------------
    const rem = time.getRemainingTime(pc.break_expires_at);
    dom.modalSubtitle.textContent = 'Break timer in progress';

    if (myTokenInfo) {
      // Current device started this break
      dom.modalBody.innerHTML = `
        <div class="active-break-display">
          <div id="modalActiveCountdown" class="active-break-countdown tabular-nums">${rem.mm}:${rem.ss}</div>
          <div class="active-break-note">Active on this device</div>
        </div>

        <div id="modalError" class="form-error" role="alert"></div>

        <button type="button" id="imBackBtn" class="btn btn-primary">
          I'm Back (End Break Early)
        </button>
        <div class="form-hint" style="text-align: center; margin-top: 8px;">
          Ending your break early frees this computer immediately. The 60-minute cooldown remains active.
        </div>
      `;

      const imBackBtn = document.getElementById('imBackBtn');
      imBackBtn.addEventListener('click', () => handleEndBreak(pc.id, myTokenInfo.token, null));
    } else {
      // Another device or guest started this break
      dom.modalBody.innerHTML = `
        <div class="active-break-display">
          <div id="modalActiveCountdown" class="active-break-countdown tabular-nums">${rem.mm}:${rem.ss}</div>
          <div class="active-break-note">Break started by another student</div>
        </div>

        <div id="modalError" class="form-error" role="alert"></div>

        <div class="alt-action-container">
          <button type="button" id="toggleOwnerVerifyBtn" class="alt-action-toggle">
            Did you start this break from another device? Return early
          </button>

          <div id="ownerVerifyPanel" class="alt-action-panel">
            <div class="form-group">
              <label for="verifyRollInput" class="form-label">Verify Your Roll Number</label>
              <input
                type="text"
                id="verifyRollInput"
                class="form-input"
                placeholder="Enter roll number"
                autocapitalize="characters"
              />
            </div>
            <button type="button" id="verifyEndBtn" class="btn btn-outline">
              Verify & End Break
            </button>
          </div>
        </div>
      `;

      const toggleBtn = document.getElementById('toggleOwnerVerifyBtn');
      const panel = document.getElementById('ownerVerifyPanel');
      const verifyEndBtn = document.getElementById('verifyEndBtn');
      const verifyRollInput = document.getElementById('verifyRollInput');

      toggleBtn.addEventListener('click', () => {
        panel.classList.toggle('is-open');
        if (panel.classList.contains('is-open')) verifyRollInput.focus();
      });

      verifyEndBtn.addEventListener('click', () => {
        const rollVal = verifyRollInput.value.trim();
        if (!rollVal) {
          showModalError('Please enter your roll number.');
          return;
        }
        handleEndBreak(pc.id, null, rollVal);
      });
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
 * Handle Start Break form submission
 */
async function handleStartBreakSubmit(pc) {
  const rollInput = document.getElementById('rollNumberInput');
  const submitBtn = document.getElementById('startBreakSubmitBtn');
  const rollNumber = rollInput.value.trim().toUpperCase();

  if (!rollNumber) {
    showModalError('Please enter your college roll number.');
    rollInput.focus();
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = 'Starting Break...';

  try {
    const res = await api.startBreak(pc.lab_id, pc.pc_number, rollNumber);

    if (!res.success) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Start 15-Minute Break';

      if (res.error_code === 'COOLDOWN') {
        const eligibleTime = res.eligible_at ? time.formatLocalTime(res.eligible_at) : 'later';
        showModalError(`Cooldown active: You can only take one break per rolling 60 minutes. Eligible again at ${eligibleTime}.`);
      } else if (res.error_code === 'PC_BUSY') {
        showModalError('This computer already has an active break timer.');
        // Refresh local view
        await loadComputersForLab(pc.lab_id);
        renderGrid();
      } else if (res.error_code === 'INVALID_ROLL') {
        showModalError(res.message || 'Invalid roll number format.');
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
    submitBtn.disabled = false;
    submitBtn.textContent = 'Start 15-Minute Break';
    showModalError('Network error. Please verify your connection.');
  }
}

/**
 * Handle ending a break ("I'm Back" action)
 */
async function handleEndBreak(computerId, token, rollNumber) {
  const btn = document.getElementById('imBackBtn') || document.getElementById('verifyEndBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Ending break...';
  }

  try {
    const res = await api.endBreak(computerId, token, rollNumber);

    if (!res.success) {
      if (btn) {
        btn.disabled = false;
        btn.textContent = token ? "I'm Back (End Break Early)" : "Verify & End Break";
      }
      showModalError(res.message || 'Could not end break.');
      return;
    }

    // Remove token from local storage
    delete state.localTokens[computerId];
    saveLocalTokens();

    // Reset computer in memory
    const pc = state.computers.get(computerId);
    if (pc) {
      pc.break_started_at = null;
      pc.break_expires_at = null;
      state.computers.set(computerId, pc);
      const tile = document.getElementById(`pc-tile-${computerId}`);
      if (tile) updateTileVisual(tile, pc);
    }

    announceAria(`Break ended on PC. Computer is now blank.`);
    closeModal();
  } catch (err) {
    console.error('Error ending break:', err);
    if (btn) {
      btn.disabled = false;
      btn.textContent = "I'm Back";
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
    updateConnectionUI('connecting');
    await api.syncDatabaseClock();
    if (state.selectedLabId) {
      await loadComputersForLab(state.selectedLabId);
      renderGrid();
    }
  });

  window.addEventListener('offline', () => {
    updateConnectionUI('offline');
  });

  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') {
      await api.syncDatabaseClock();
      if (state.selectedLabId) {
        await loadComputersForLab(state.selectedLabId);
        renderGrid();
      }
    }
  });

  // Initial time sync
  await api.syncDatabaseClock();

  // Load labs
  try {
    state.labs = await api.fetchLabs();
    if (state.labs.length > 0) {
      state.selectedLabId = state.labs[0].id;
      renderLabTabs();
      await loadComputersForLab(state.selectedLabId);
      renderGrid();
      handleDeepLink();
    } else {
      if (dom.pcGrid) {
        dom.pcGrid.innerHTML = '<div class="grid-placeholder">No computer labs are active.</div>';
      }
    }
  } catch (err) {
    console.error('Initialization error:', err);
    updateConnectionUI('offline');
  }

  // Setup Realtime Subscription
  api.subscribeToComputerUpdates(
    (payload) => handleRealtimeChange(payload),
    (status) => {
      if (status === 'SUBSCRIBED') {
        updateConnectionUI('live');
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        updateConnectionUI('offline');
      }
    }
  );

  // Setup 1000ms ticker for live tabular-num countdowns
  setInterval(tickCountdowns, 1000);

  // Setup 30-second polling fallback & time sync
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
  }, CONFIG.POLL_INTERVAL_MS);
}

// Start application when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
