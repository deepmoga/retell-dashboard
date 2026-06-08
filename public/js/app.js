// === Auth ===
function getToken() { return localStorage.getItem('token'); }
function getUser() { try { return JSON.parse(localStorage.getItem('user')); } catch { return null; } }
function isLoggedIn() { return !!getToken(); }

function requireAuth() {
  if (!isLoggedIn()) { window.location.href = '/'; return false; }
  return true;
}

function logout() {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  window.location.href = '/';
}

// === API ===
async function api(method, path, body, opts = {}) {
  const token = getToken();
  const res = await fetch('/api' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    ...opts,
  });

  if (res.status === 401) { logout(); return null; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function apiGet(path) { return api('GET', path); }
async function apiPost(path, body) { return api('POST', path, body); }
async function apiPut(path, body) { return api('PUT', path, body); }
async function apiDelete(path) { return api('DELETE', path); }

async function apiFormData(path, formData) {
  const token = getToken();
  const res = await fetch('/api' + path, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: formData,
  });
  if (res.status === 401) { logout(); return null; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// === Toast ===
function toast(msg, type = 'info', duration = 4000) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const icons = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `<span>${icons[type] || 'ℹ'}</span><span>${escHtml(msg)}</span>`;
  container.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateX(100%)'; t.style.transition = '0.3s'; setTimeout(() => t.remove(), 300); }, duration);
}

// === Helpers ===
function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtDuration(seconds) {
  if (!seconds) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function fmtCost(amount) {
  if (amount == null) return '—';
  return '$' + parseFloat(amount).toFixed(4);
}

function fmtCostShort(amount) {
  if (amount == null) return '—';
  return '$' + parseFloat(amount).toFixed(2);
}

function fmtDate(ts) {
  if (!ts) return '—';
  const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
  if (isNaN(d)) return '—';
  return d.toLocaleString();
}

function fmtDateShort(ts) {
  if (!ts) return '—';
  const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
  if (isNaN(d)) return '—';
  return d.toLocaleDateString();
}

function timeSince(ts) {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

function fmtElapsed(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function badge(text, cls) {
  return `<span class="badge badge-${cls}">${escHtml(text)}</span>`;
}

function callTypeBadge(type) {
  return badge(type || 'unknown', type === 'inbound' ? 'inbound' : 'outbound');
}

function statusBadge(status) {
  const map = { ended: 'ended', ongoing: 'ongoing', error: 'error', registered: 'ended' };
  return badge(status || '?', map[status] || 'ended');
}

function leadStatusBadge(status) {
  const labels = { pending: 'Pending', called: 'Called', qualified: 'Qualified', callback: 'Callback', not_interested: 'Not Interested' };
  return badge(labels[status] || status, status || 'pending');
}

// === Sidebar active state ===
function setActiveSidebarItem() {
  const page = window.location.pathname.replace('/', '') || 'index';
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.remove('active');
    if (el.dataset.page === page) el.classList.add('active');
  });
}

// === Sidebar user info ===
function renderSidebarUser() {
  const user = getUser();
  if (!user) return;
  const nameEl = document.getElementById('sidebar-user-name');
  const roleEl = document.getElementById('sidebar-user-role');
  const avatarEl = document.getElementById('sidebar-user-avatar');
  if (nameEl) nameEl.textContent = user.name || user.email;
  if (roleEl) roleEl.textContent = user.role === 'admin' ? 'Admin' : (user.company_name || 'Client');
  if (avatarEl) avatarEl.textContent = (user.name || user.email || 'U')[0].toUpperCase();

  // Show admin-only items via CSS class (no flash — hidden by default in CSS)
  if (user.role === 'admin') {
    document.body.classList.add('user-admin');
  } else {
    document.body.classList.remove('user-admin');
  }

  // Read-only mode
  if (user.is_readonly) {
    document.body.classList.add('readonly-mode');
    // Show readonly badge in sidebar
    const badge = document.getElementById('readonly-badge');
    if (badge) badge.style.display = 'inline-flex';
  }
}

// === Modal helpers ===
function openModal(id) { document.getElementById(id)?.classList.add('open'); }
function closeModal(id) { document.getElementById(id)?.classList.remove('open'); }

document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-overlay')) {
    e.target.classList.remove('open');
  }
  if (e.target.classList.contains('modal-close')) {
    e.target.closest('.modal-overlay')?.classList.remove('open');
  }
});

// === CSV Export ===
function exportCSV(data, filename) {
  if (!data.length) return;
  const headers = Object.keys(data[0]);
  const rows = data.map(r => headers.map(h => JSON.stringify(r[h] ?? '')).join(','));
  const csv = [headers.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// === Init ===
document.addEventListener('DOMContentLoaded', () => {
  renderSidebarUser();
  setActiveSidebarItem();

  document.getElementById('logout-btn')?.addEventListener('click', logout);
});
