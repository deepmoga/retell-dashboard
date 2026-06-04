let currentPage = 1;
let totalPages = 1;
let allCallsData = [];
let activePlayer = null;

document.addEventListener('DOMContentLoaded', async () => {
  if (!requireAuth()) return;
  await loadCalls();
  bindFilters();
  bindExport();
});

function bindFilters() {
  ['filter-type', 'filter-status', 'filter-from', 'filter-to'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', () => { currentPage = 1; loadCalls(); });
  });
  let searchTimer;
  document.getElementById('filter-search')?.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { currentPage = 1; loadCalls(); }, 400);
  });
}

function getFilters() {
  return {
    type: document.getElementById('filter-type')?.value || '',
    status: document.getElementById('filter-status')?.value || '',
    from_date: document.getElementById('filter-from')?.value || '',
    to_date: document.getElementById('filter-to')?.value || '',
    search: document.getElementById('filter-search')?.value || '',
  };
}

async function loadCalls() {
  const f = getFilters();
  const params = new URLSearchParams({ page: currentPage, limit: 25 });
  if (f.type) params.set('type', f.type);
  if (f.status) params.set('status', f.status);
  if (f.from_date) params.set('from_date', f.from_date);
  if (f.to_date) params.set('to_date', f.to_date);
  if (f.search) params.set('search', f.search);

  try {
    const data = await apiGet(`/calls?${params}`);
    allCallsData = data.calls;
    totalPages = data.pagination.pages;
    renderTable(data.calls);
    renderPagination(data.pagination);
  } catch (err) {
    toast('Failed to load calls: ' + err.message, 'error');
  }
}

function renderTable(calls) {
  const tbody = document.getElementById('calls-tbody');
  if (!calls.length) {
    tbody.innerHTML = '<tr><td colspan="11"><div class="empty-state"><div class="empty-icon">📞</div><p>No calls found</p></div></td></tr>';
    return;
  }

  tbody.innerHTML = calls.map((c, i) => `
    <tr id="row-${c.id}">
      <td style="color:var(--text-muted)">${((currentPage - 1) * 25) + i + 1}</td>
      <td>${callTypeBadge(c.call_type)}</td>
      <td style="font-family:monospace">${escHtml(c.from_number || '—')}</td>
      <td style="font-family:monospace">${escHtml(c.to_number || '—')}</td>
      <td style="color:var(--text-muted)">${escHtml(c.agent_name || '—')}</td>
      <td>${fmtDuration(c.duration_seconds)}</td>
      <td>${statusBadge(c.status)}</td>
      <td>${c.call_outcome ? badge(c.call_outcome.replace('_', ' '), 'callback') : '<span style="color:var(--text-dim)">—</span>'}</td>
      <td style="font-variant-numeric:tabular-nums">${fmtCost(c.total_cost)}</td>
      <td style="color:var(--text-muted)">${fmtDate(c.start_timestamp)}</td>
      <td>
        <div class="table-actions">
          ${(c.recording_url || c.recording_local_path)
            ? `<button class="btn btn-ghost btn-sm btn-icon" onclick="togglePlayer(${c.id})" title="Play Recording">🎵</button>`
            : '<button class="btn btn-ghost btn-sm btn-icon" disabled title="No recording" style="opacity:0.3">🎵</button>'}
          <button class="btn btn-ghost btn-sm btn-icon" onclick="viewTranscript(${c.id})" title="Transcript">📄</button>
          <button class="btn btn-ghost btn-sm btn-icon" onclick="setOutcome(${c.id}, '${escHtml(c.call_outcome || '')}')" title="Set Outcome">✏️</button>
        </div>
      </td>
    </tr>
    <tr id="player-row-${c.id}" style="display:none">
      <td colspan="11" style="padding:0">
        <div class="inline-player">
          <audio controls src="/api/calls/${c.id}/recording" preload="none" style="width:100%;height:36px"></audio>
        </div>
      </td>
    </tr>
  `).join('');
}

function togglePlayer(callId) {
  const row = document.getElementById(`player-row-${callId}`);
  if (!row) return;
  const isOpen = row.style.display !== 'none';
  if (activePlayer && activePlayer !== callId) {
    const prev = document.getElementById(`player-row-${activePlayer}`);
    if (prev) { prev.style.display = 'none'; prev.querySelector('audio')?.pause(); }
  }
  row.style.display = isOpen ? 'none' : 'table-row';
  activePlayer = isOpen ? null : callId;
}

async function viewTranscript(callId) {
  try {
    const data = await apiGet(`/calls/${callId}`);
    const c = data.call;
    const summaryEl = document.getElementById('modal-summary');
    const transcriptEl = document.getElementById('modal-transcript');
    if (summaryEl) summaryEl.textContent = c.call_summary || 'No summary available.';
    if (transcriptEl) transcriptEl.textContent = c.transcript || 'No transcript available.';
    openModal('transcript-modal');
  } catch (err) {
    toast('Failed to load transcript', 'error');
  }
}

function setOutcome(callId, current) {
  document.getElementById('outcome-call-id').value = callId;
  document.getElementById('outcome-select').value = current || '';
  openModal('outcome-modal');
}

document.getElementById('save-outcome')?.addEventListener('click', async () => {
  const callId = document.getElementById('outcome-call-id').value;
  const outcome = document.getElementById('outcome-select').value;
  try {
    await apiPut(`/calls/${callId}/outcome`, { outcome });
    closeModal('outcome-modal');
    toast('Outcome updated', 'success');
    loadCalls();
  } catch (err) {
    toast('Failed to update: ' + err.message, 'error');
  }
});

document.getElementById('copy-transcript')?.addEventListener('click', () => {
  const text = document.getElementById('modal-transcript')?.textContent;
  if (text) { navigator.clipboard.writeText(text); toast('Copied!', 'success'); }
});

function renderPagination(p) {
  const el = document.getElementById('pagination');
  if (!el) return;
  const pages = [];
  pages.push(`<button class="page-btn" onclick="goPage(${p.page - 1})" ${p.page <= 1 ? 'disabled' : ''}>← Prev</button>`);
  const start = Math.max(1, p.page - 2);
  const end = Math.min(p.pages, p.page + 2);
  for (let i = start; i <= end; i++) {
    pages.push(`<button class="page-btn ${i === p.page ? 'active' : ''}" onclick="goPage(${i})">${i}</button>`);
  }
  pages.push(`<span class="page-info">${p.total} calls</span>`);
  pages.push(`<button class="page-btn" onclick="goPage(${p.page + 1})" ${p.page >= p.pages ? 'disabled' : ''}>Next →</button>`);
  el.innerHTML = pages.join('');
}

function goPage(p) {
  if (p < 1 || p > totalPages) return;
  currentPage = p;
  loadCalls();
}

function bindExport() {
  document.getElementById('export-btn')?.addEventListener('click', async () => {
    try {
      const f = getFilters();
      const params = new URLSearchParams({ limit: 10000, page: 1 });
      if (f.type) params.set('type', f.type);
      if (f.status) params.set('status', f.status);
      if (f.from_date) params.set('from_date', f.from_date);
      if (f.to_date) params.set('to_date', f.to_date);
      if (f.search) params.set('search', f.search);
      const data = await apiGet(`/calls?${params}`);
      const rows = data.calls.map(c => ({
        call_id: c.call_id,
        type: c.call_type,
        from: c.from_number,
        to: c.to_number,
        agent: c.agent_name,
        duration_s: c.duration_seconds,
        status: c.status,
        outcome: c.call_outcome,
        cost: c.total_cost,
        date: fmtDate(c.start_timestamp),
      }));
      exportCSV(rows, `calls-${new Date().toISOString().slice(0,10)}.csv`);
    } catch (err) {
      toast('Export failed', 'error');
    }
  });
}

document.getElementById('sync-btn')?.addEventListener('click', async () => {
  try {
    await apiPost('/calls/sync');
    toast('Sync started — refreshing in 5s...', 'info');
    setTimeout(loadCalls, 5000);
  } catch (err) {
    toast('Sync failed', 'error');
  }
});
