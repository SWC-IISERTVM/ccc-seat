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

  setInterval(tickAdminCountdowns, 1000);
}

// Start
setupListeners();
checkAuth();
