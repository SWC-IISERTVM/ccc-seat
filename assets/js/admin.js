/**
 * admin.js - Staff Administration & QR Generation Portal
 * ==============================================================================
 * Handles:
 * - Admin authentication via Supabase Auth
 * - Realtime active break list with live countdowns & clear timer overrides
 * - Physical QR code sheet generator with high-contrast scan cards
 * - Inventory management (add/remove computers)
 * - Administrative audit log viewer
 * ==============================================================================
 */

import { CONFIG } from './config.js';
import * as api from './api.js';
import * as time from './time.js';
import * as qr from './qr.js';

const state = {
  session: null,
  labs: [],
  selectedLabId: null,
  activeBreaks: [],
  inventoryPcs: [],
  selectedPcToClear: null,
  currentTab: 'breaks'
};

const dom = {
  authSection: document.getElementById('adminAuthSection'),
  dashboardSection: document.getElementById('adminDashboardSection'),
  loginForm: document.getElementById('adminLoginForm'),
  loginError: document.getElementById('loginError'),
  googleSignInBtn: document.getElementById('googleSignInBtn'),
  adminEmail: document.getElementById('adminEmail'),
  adminPassword: document.getElementById('adminPassword'),
  adminLoginBtn: document.getElementById('adminLoginBtn'),
  adminSignOutBtn: document.getElementById('adminSignOutBtn'),

  // Tabs
  tabBtnBreaks: document.getElementById('tabBtnBreaks'),
  tabBtnQR: document.getElementById('tabBtnQR'),
  tabBtnInventory: document.getElementById('tabBtnInventory'),
  tabBtnAudit: document.getElementById('tabBtnAudit'),

  panelBreaks: document.getElementById('panelBreaks'),
  panelQR: document.getElementById('panelQR'),
  panelInventory: document.getElementById('panelInventory'),
  panelAudit: document.getElementById('panelAudit'),

  // Breaks
  activeBreaksTbody: document.getElementById('activeBreaksTbody'),
  refreshBreaksBtn: document.getElementById('refreshBreaksBtn'),

  // QR
  qrLabSelect: document.getElementById('qrLabSelect'),
  qrCardsContainer: document.getElementById('qrCardsContainer'),
  printQRBtn: document.getElementById('printQRBtn'),

  // Inventory
  inventoryLabSelect: document.getElementById('inventoryLabSelect'),
  inventoryTbody: document.getElementById('inventoryTbody'),
  addPcForm: document.getElementById('addPcForm'),
  addPcNumber: document.getElementById('addPcNumber'),

  // Audit
  auditTbody: document.getElementById('auditTbody'),
  refreshAuditBtn: document.getElementById('refreshAuditBtn'),

  // Clear modal
  clearBreakModal: document.getElementById('clearBreakModal'),
  clearModalSubtitle: document.getElementById('clearModalSubtitle'),
  clearReasonInput: document.getElementById('clearReasonInput'),
  confirmClearBtn: document.getElementById('confirmClearBtn'),
  cancelClearBtn: document.getElementById('cancelClearBtn'),
  clearModalCloseBtn: document.getElementById('clearModalCloseBtn')
};

// ------------------------------------------------------------------------------
// AUTHENTICATION
// ------------------------------------------------------------------------------

async function checkAuth() {
  await api.syncDatabaseClock();
  try {
    const session = await api.getAdminSession();
    if (session) {
      state.session = session;
      showDashboard();
    } else {
      showLogin();
    }
  } catch (err) {
    console.warn('Session check failed:', err);
    showLogin();
  }
}

function showLogin() {
  state.session = null;
  dom.authSection.style.display = 'block';
  dom.dashboardSection.style.display = 'none';
  dom.adminSignOutBtn.style.display = 'none';
}

async function showDashboard() {
  dom.authSection.style.display = 'none';
  dom.dashboardSection.style.display = 'block';
  dom.adminSignOutBtn.style.display = 'inline-flex';

  // Load labs
  try {
    state.labs = await api.fetchLabs();
    populateLabSelectors();
    switchTab('breaks');
  } catch (err) {
    console.error('Failed to load labs:', err);
  }
}

async function handleGoogleSignIn() {
  dom.loginError.classList.remove('is-visible');
  if (dom.googleSignInBtn) {
    dom.googleSignInBtn.disabled = true;
    dom.googleSignInBtn.textContent = 'Redirecting to Google...';
  }
  try {
    await api.adminSignInWithGoogle();
  } catch (err) {
    dom.loginError.textContent = err.message || 'Failed to initiate Google sign-in.';
    dom.loginError.classList.add('is-visible');
    if (dom.googleSignInBtn) {
      dom.googleSignInBtn.disabled = false;
      dom.googleSignInBtn.innerHTML = `
        <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
          <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/>
          <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/>
        </svg>
        Sign In with Google
      `;
    }
  }
}

async function handleLogin(e) {
  e.preventDefault();
  dom.loginError.classList.remove('is-visible');
  dom.adminLoginBtn.disabled = true;
  dom.adminLoginBtn.textContent = 'Verifying...';

  const email = dom.adminEmail.value.trim();
  const password = dom.adminPassword.value;

  try {
    await api.adminSignIn(email, password);
    const session = await api.getAdminSession();
    if (!session) {
      throw new Error('Access denied: your user account is not registered in admin_users.');
    }
    state.session = session;
    showDashboard();
  } catch (err) {
    dom.loginError.textContent = err.message || 'Authentication failed.';
    dom.loginError.classList.add('is-visible');
  } finally {
    dom.adminLoginBtn.disabled = false;
    dom.adminLoginBtn.textContent = 'Sign In';
  }
}

async function handleSignOut() {
  try {
    await api.adminSignOut();
  } catch (err) {
    console.error('Sign out error:', err);
  }
  showLogin();
}

// ------------------------------------------------------------------------------
// TAB NAVIGATION
// ------------------------------------------------------------------------------

function switchTab(tabName) {
  state.currentTab = tabName;

  [dom.tabBtnBreaks, dom.tabBtnQR, dom.tabBtnInventory, dom.tabBtnAudit].forEach(btn => {
    btn.classList.remove('is-active');
  });
  [dom.panelBreaks, dom.panelQR, dom.panelInventory, dom.panelAudit].forEach(p => {
    p.style.display = 'none';
  });

  if (tabName === 'breaks') {
    dom.tabBtnBreaks.classList.add('is-active');
    dom.panelBreaks.style.display = 'block';
    loadActiveBreaks();
  } else if (tabName === 'qr') {
    dom.tabBtnQR.classList.add('is-active');
    dom.panelQR.style.display = 'block';
    renderQRSheet();
  } else if (tabName === 'inventory') {
    dom.tabBtnInventory.classList.add('is-active');
    dom.panelInventory.style.display = 'block';
    loadInventory();
  } else if (tabName === 'audit') {
    dom.tabBtnAudit.classList.add('is-active');
    dom.panelAudit.style.display = 'block';
    loadAuditLogs();
  }
}

function populateLabSelectors() {
  dom.qrLabSelect.innerHTML = '';
  dom.inventoryLabSelect.innerHTML = '';

  state.labs.forEach(lab => {
    const opt1 = document.createElement('option');
    opt1.value = lab.id;
    opt1.textContent = lab.name;
    dom.qrLabSelect.appendChild(opt1);

    const opt2 = document.createElement('option');
    opt2.value = lab.id;
    opt2.textContent = lab.name;
    dom.inventoryLabSelect.appendChild(opt2);
  });

  if (state.labs.length > 0) {
    state.selectedLabId = state.labs[0].id;
  }
}

// ------------------------------------------------------------------------------
// TAB 1: ACTIVE BREAKS
// ------------------------------------------------------------------------------

async function loadActiveBreaks() {
  dom.activeBreaksTbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-secondary); padding: 24px;">Refreshing active breaks...</td></tr>';
  try {
    state.activeBreaks = await api.adminListActiveBreaks();
    renderActiveBreaks();
  } catch (err) {
    console.error('Error loading breaks:', err);
    dom.activeBreaksTbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--error-text); padding: 24px;">Failed to load active breaks: ${err.message}</td></tr>`;
  }
}

function renderActiveBreaks() {
  dom.activeBreaksTbody.innerHTML = '';

  if (state.activeBreaks.length === 0) {
    dom.activeBreaksTbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-secondary); padding: 24px;">No computers are currently on break.</td></tr>';
    return;
  }

  state.activeBreaks.forEach(b => {
    const tr = document.createElement('tr');
    const rem = time.getRemainingTime(b.scheduled_expires_at);

    tr.innerHTML = `
      <td><strong>${escapeHtml(b.lab_name)}</strong></td>
      <td>PC ${String(b.pc_number).padStart(2, '0')}</td>
      <td>${time.formatLocalTime(b.started_at)}</td>
      <td class="tabular-nums" style="color: var(--break-accent); font-weight: 600;" data-admin-timer="${b.break_id}">
        ${rem.isExpired ? 'EXPIRED' : `${rem.mm}:${rem.ss}`}
      </td>
      <td><code>${escapeHtml(b.roll_key_preview || '***')}</code></td>
      <td style="text-align: right;">
        <button type="button" class="table-btn is-danger" data-clear-pc="${b.computer_id}" data-pc-label="${escapeHtml(b.lab_name)} PC ${b.pc_number}">
          Clear Timer
        </button>
      </td>
    `;

    const clearBtn = tr.querySelector('[data-clear-pc]');
    clearBtn.addEventListener('click', () => {
      openClearModal(b.computer_id, clearBtn.dataset.pcLabel);
    });

    dom.activeBreaksTbody.appendChild(tr);
  });
}

function tickAdminCountdowns() {
  if (state.currentTab !== 'breaks') return;

  state.activeBreaks.forEach(b => {
    const el = document.querySelector(`[data-admin-timer="${b.break_id}"]`);
    if (el) {
      const rem = time.getRemainingTime(b.scheduled_expires_at);
      if (rem.isExpired) {
        el.textContent = 'EXPIRED';
      } else {
        el.textContent = `${rem.mm}:${rem.ss}`;
      }
    }
  });
}

// Clear break modal
function openClearModal(computerId, label) {
  state.selectedPcToClear = computerId;
  dom.clearModalSubtitle.textContent = `Target: ${label}`;
  dom.clearReasonInput.value = 'Staff override / student returned';
  dom.clearBreakModal.classList.add('is-open');
}

function closeClearModal() {
  state.selectedPcToClear = null;
  dom.clearBreakModal.classList.remove('is-open');
}

async function handleConfirmClear() {
  if (!state.selectedPcToClear) return;
  dom.confirmClearBtn.disabled = true;
  dom.confirmClearBtn.textContent = 'Clearing...';

  try {
    const reason = dom.clearReasonInput.value.trim() || 'Staff override';
    await api.adminClearBreak(state.selectedPcToClear, reason);
    closeClearModal();
    await loadActiveBreaks();
  } catch (err) {
    alert(`Failed to clear timer: ${err.message}`);
  } finally {
    dom.confirmClearBtn.disabled = false;
    dom.confirmClearBtn.textContent = 'Confirm Clear Timer';
  }
}

// ------------------------------------------------------------------------------
// TAB 2: QR SHEET GENERATOR
// ------------------------------------------------------------------------------

async function renderQRSheet() {
  const labId = dom.qrLabSelect.value;
  if (!labId) return;

  dom.qrCardsContainer.innerHTML = '<div style="grid-column: 1 / -1; text-align: center; padding: 24px; color: var(--text-secondary);">Generating QR codes...</div>';

  try {
    const lab = state.labs.find(l => l.id === labId);
    const labSlug = lab ? lab.slug : labId;
    const computers = await api.fetchComputers(labId);

    dom.qrCardsContainer.innerHTML = '';

    for (const pc of computers) {
      const card = document.createElement('div');
      card.className = 'qr-card';

      const deepLink = qr.buildComputerDeepLink(labSlug, pc.pc_number);

      card.innerHTML = `
        <div class="qr-card-lab">${escapeHtml(lab ? lab.name : 'Lab')}</div>
        <div class="qr-card-pc">PC ${String(pc.pc_number).padStart(2, '0')}</div>
        <div class="qr-canvas-holder" style="width: 150px; height: 150px; margin: 4px auto;"></div>
        <div class="qr-card-disclaimer">
          Scanning is not proof of presence.<br>
          Blank means no break timer is active.
        </div>
      `;

      dom.qrCardsContainer.appendChild(card);

      // Render QR Canvas asynchronously
      const canvasHolder = card.querySelector('.qr-canvas-holder');
      const canvas = document.createElement('canvas');
      canvasHolder.appendChild(canvas);
      qr.renderQRToCanvas(canvas, deepLink, { width: 150 }).catch(err => {
        console.error('QR render error:', err);
      });
    }
  } catch (err) {
    dom.qrCardsContainer.innerHTML = `<div style="grid-column: 1 / -1; color: var(--error-text);">Failed to generate QR codes: ${err.message}</div>`;
  }
}

// ------------------------------------------------------------------------------
// TAB 3: INVENTORY
// ------------------------------------------------------------------------------

async function loadInventory() {
  const labId = dom.inventoryLabSelect.value;
  if (!labId) return;

  dom.inventoryTbody.innerHTML = '<tr><td colspan="4" style="text-align: center; padding: 24px;">Loading inventory...</td></tr>';

  try {
    const list = await api.fetchComputers(labId);
    state.inventoryPcs = list;
    renderInventory();
  } catch (err) {
    dom.inventoryTbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--error-text); padding: 24px;">${err.message}</td></tr>`;
  }
}

function renderInventory() {
  dom.inventoryTbody.innerHTML = '';
  const lab = state.labs.find(l => l.id === dom.inventoryLabSelect.value);

  if (state.inventoryPcs.length === 0) {
    dom.inventoryTbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-secondary); padding: 24px;">No computers registered.</td></tr>';
    return;
  }

  state.inventoryPcs.forEach(pc => {
    const tr = document.createElement('tr');
    const isBreak = !time.isBreakExpired(pc.break_expires_at);

    tr.innerHTML = `
      <td>${escapeHtml(lab ? lab.name : 'Lab')}</td>
      <td><strong>PC ${String(pc.pc_number).padStart(2, '0')}</strong></td>
      <td>${isBreak ? '<span style="color: var(--break-accent); font-weight: 600;">ON BREAK</span>' : '<span style="color: var(--text-secondary);">BLANK</span>'}</td>
      <td style="text-align: right;">
        <button type="button" class="table-btn is-danger" data-remove-pc="${pc.pc_number}">Remove</button>
      </td>
    `;

    const rmBtn = tr.querySelector('[data-remove-pc]');
    rmBtn.addEventListener('click', async () => {
      if (confirm(`Remove PC ${pc.pc_number} from ${lab ? lab.name : 'lab'}?`)) {
        await api.adminManageComputer('REMOVE', pc.lab_id, pc.pc_number);
        loadInventory();
      }
    });

    dom.inventoryTbody.appendChild(tr);
  });
}

async function handleAddPc(e) {
  e.preventDefault();
  const labId = dom.inventoryLabSelect.value;
  const pcNumber = parseInt(dom.addPcNumber.value, 10);
  if (!labId || isNaN(pcNumber)) return;

  try {
    await api.adminManageComputer('ADD', labId, pcNumber);
    dom.addPcNumber.value = '';
    loadInventory();
  } catch (err) {
    alert(`Failed to add computer: ${err.message}`);
  }
}

// ------------------------------------------------------------------------------
// TAB 4: AUDIT LOGS
// ------------------------------------------------------------------------------

async function loadAuditLogs() {
  dom.auditTbody.innerHTML = '<tr><td colspan="4" style="text-align: center; padding: 24px;">Loading action logs...</td></tr>';
  try {
    const logs = await api.adminGetActionLogs(50);
    renderAuditLogs(logs);
  } catch (err) {
    dom.auditTbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--error-text); padding: 24px;">${err.message}</td></tr>`;
  }
}

function renderAuditLogs(logs) {
  dom.auditTbody.innerHTML = '';
  if (logs.length === 0) {
    dom.auditTbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-secondary); padding: 24px;">No recorded admin actions.</td></tr>';
    return;
  }

  logs.forEach(log => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="white-space: nowrap;">${time.formatLocalTime(log.created_at)}</td>
      <td><code>${escapeHtml(log.action)}</code></td>
      <td>${escapeHtml(log.target_type)} / ${escapeHtml(log.target_id || '-')}</td>
      <td><pre style="font-size: 11px; margin: 0; background: var(--surface-subtle); padding: 4px; border-radius: 4px;">${escapeHtml(JSON.stringify(log.details))}</pre></td>
    `;
    dom.auditTbody.appendChild(tr);
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/[&<>"']/g, m => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[m]);
}

// ------------------------------------------------------------------------------
// EVENT LISTENERS & INIT
// ------------------------------------------------------------------------------

function setupListeners() {
  if (dom.googleSignInBtn) dom.googleSignInBtn.addEventListener('click', handleGoogleSignIn);
  dom.loginForm.addEventListener('submit', handleLogin);
  dom.adminSignOutBtn.addEventListener('click', handleSignOut);

  dom.tabBtnBreaks.addEventListener('click', () => switchTab('breaks'));
  dom.tabBtnQR.addEventListener('click', () => switchTab('qr'));
  dom.tabBtnInventory.addEventListener('click', () => switchTab('inventory'));
  dom.tabBtnAudit.addEventListener('click', () => switchTab('audit'));

  dom.refreshBreaksBtn.addEventListener('click', loadActiveBreaks);
  dom.refreshAuditBtn.addEventListener('click', loadAuditLogs);

  dom.qrLabSelect.addEventListener('change', renderQRSheet);
  dom.printQRBtn.addEventListener('click', () => window.print());

  dom.inventoryLabSelect.addEventListener('change', loadInventory);
  dom.addPcForm.addEventListener('submit', handleAddPc);

  dom.clearModalCloseBtn.addEventListener('click', closeClearModal);
  dom.cancelClearBtn.addEventListener('click', closeClearModal);
  dom.confirmClearBtn.addEventListener('click', handleConfirmClear);

  // Handle auth state changes from Google OAuth redirect or sign out
  api.onAdminAuthStateChange(async (event, session) => {
    if (session) {
      const adminSession = await api.getAdminSession();
      if (adminSession) {
        state.session = adminSession;
        showDashboard();
      } else {
        dom.loginError.textContent = `Access denied: ${session.user.email} is not registered as an authorized administrator.`;
        dom.loginError.classList.add('is-visible');
        showLogin();
      }
    } else {
      showLogin();
    }
  });

  setInterval(tickAdminCountdowns, 1000);
}

// Start
if (window.location.hash && window.location.hash.includes('access_token')) {
  history.replaceState(null, document.title, window.location.pathname + window.location.search);
}
setupListeners();
checkAuth();
