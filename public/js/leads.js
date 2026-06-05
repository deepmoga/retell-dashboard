let selectedLeads = new Set();
let allAgents = [];
let allPhoneNumbers = [];

document.addEventListener('DOMContentLoaded', async () => {
  if (!requireAuth()) return;
  await Promise.all([loadLeads(), loadAgentsAndNumbers()]);
  bindEvents();
});

async function loadLeads() {
  const status = document.getElementById('filter-status')?.value || '';
  try {
    const params = new URLSearchParams();
    if (status && status !== 'all') params.set('status', status);
    const data = await apiGet(`/leads?${params}`);
    renderLeads(data.leads);
  } catch (err) {
    toast('Failed to load leads', 'error');
  }
}

async function loadAgentsAndNumbers() {
  try {
    const [agentsData, numsData] = await Promise.all([
      apiGet('/leads/agents').catch(() => ({ agents: [] })),
      apiGet('/leads/phone-numbers').catch(() => ({ phone_numbers: [] })),
    ]);
    allAgents = agentsData.agents || [];
    allPhoneNumbers = numsData.phone_numbers || [];

    const agentSel = document.getElementById('call-agent');
    const fromSel = document.getElementById('call-from');
    if (agentSel) {
      agentSel.innerHTML = '<option value="">Select Agent</option>' +
        allAgents.map(a => {
          const badge = a.provider === 'vapi' ? ' 🎙️ VAPI' : ' 🤖 Retell';
          return `<option value="${escHtml(a.id)}" data-provider="${escHtml(a.provider || 'retell')}">${escHtml(a.name || a.id)}${badge}</option>`;
        }).join('');
    }
    if (fromSel) {
      fromSel.innerHTML = '<option value="">Select Number</option>' +
        allPhoneNumbers.map(n => {
          const num = n.number || n.phone_number || '';
          const badge = n.provider === 'vapi' ? ' 🎙️' : ' 🤖';
          return `<option value="${escHtml(n.id || num)}" data-provider="${escHtml(n.provider || 'retell')}">${escHtml(num)}${n.nickname ? ' ('+n.nickname+')' : ''}${badge}</option>`;
        }).join('');
    }
  } catch (err) {
    console.error('Agent/number load error:', err);
  }
}

function renderLeads(leads) {
  const tbody = document.getElementById('leads-tbody');
  document.getElementById('lead-count').textContent = leads.length;
  selectedLeads.clear();
  updateBulkBar();

  if (!leads.length) {
    tbody.innerHTML = `<tr><td colspan="9"><div class="empty-state"><div class="empty-icon">👥</div><p>No leads yet — upload a CSV or add manually</p></div></td></tr>`;
    return;
  }

  tbody.innerHTML = leads.map(l => `
    <tr id="lead-row-${l.id}">
      <td><input type="checkbox" class="lead-check" data-id="${l.id}" onchange="toggleSelect(${l.id}, this.checked)"></td>
      <td>${escHtml(l.name || '—')}</td>
      <td style="font-family:monospace">${escHtml(l.phone)}</td>
      <td>${escHtml(l.city || '—')}</td>
      <td>${leadStatusBadge(l.status)}</td>
      <td style="color:var(--text-muted)">${l.last_called_at ? fmtDateShort(l.last_called_at) : '—'}</td>
      <td>${l.call_count || 0}</td>
      <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(l.notes || '')}">${escHtml(l.notes || '—')}</td>
      <td>
        <div class="table-actions">
          <button class="btn btn-ghost btn-sm btn-icon" onclick="callLead(${l.id}, '${escHtml(l.name || l.phone)}')" title="Call Now">📞</button>
          <button class="btn btn-ghost btn-sm btn-icon" onclick="editLead(${l.id})" title="Edit">✏️</button>
          <button class="btn btn-ghost btn-sm btn-icon" onclick="deleteLead(${l.id})" title="Delete" style="color:var(--danger)">🗑️</button>
        </div>
      </td>
    </tr>
  `).join('');
}

function toggleSelect(id, checked) {
  if (checked) selectedLeads.add(id);
  else selectedLeads.delete(id);
  updateBulkBar();
}

function updateBulkBar() {
  const bar = document.getElementById('bulk-bar');
  const count = document.getElementById('bulk-count');
  if (bar) bar.classList.toggle('visible', selectedLeads.size > 0);
  if (count) count.textContent = selectedLeads.size;
}

document.getElementById('select-all')?.addEventListener('change', (e) => {
  document.querySelectorAll('.lead-check').forEach(cb => {
    cb.checked = e.target.checked;
    const id = parseInt(cb.dataset.id);
    if (e.target.checked) selectedLeads.add(id);
    else selectedLeads.delete(id);
  });
  updateBulkBar();
});

function callLead(id, name) {
  document.getElementById('confirm-lead-name').textContent = name;
  document.getElementById('confirm-lead-id').value = id;
  openModal('call-confirm-modal');
}

document.getElementById('confirm-call-btn')?.addEventListener('click', async () => {
  const leadId = document.getElementById('confirm-lead-id').value;
  const agentSel = document.getElementById('call-agent');
  const fromSel = document.getElementById('call-from');
  const agentId = agentSel.value;
  const fromNumber = fromSel.value;
  const provider = agentSel.selectedOptions[0]?.dataset?.provider || 'retell';

  if (!agentId || !fromNumber) {
    toast('Please select an agent and phone number', 'warning');
    return;
  }

  try {
    await apiPost(`/leads/${leadId}/call`, { agent_id: agentId, from_number: fromNumber, provider });
    closeModal('call-confirm-modal');
    toast('Call initiated!', 'success');
    loadLeads();
  } catch (err) {
    toast('Call failed: ' + err.message, 'error');
  }
});

document.getElementById('bulk-call-btn')?.addEventListener('click', async () => {
  if (!selectedLeads.size) return;
  const agentId = document.getElementById('call-agent').value;
  const fromNumber = document.getElementById('call-from').value;

  if (!agentId || !fromNumber) {
    toast('Please select agent and number first', 'warning');
    openModal('call-confirm-modal');
    return;
  }

  if (!confirm(`Call ${selectedLeads.size} leads?`)) return;

  try {
    const result = await apiPost('/leads/bulk-call', {
      lead_ids: Array.from(selectedLeads),
      agent_id: agentId,
      from_number: fromNumber,
    });
    toast(`Called ${result.success} leads, ${result.failed} failed`, result.failed > 0 ? 'warning' : 'success');
    loadLeads();
  } catch (err) {
    toast('Bulk call failed: ' + err.message, 'error');
  }
});

function editLead(id) {
  const row = document.getElementById(`lead-row-${id}`);
  if (!row) return;
  const cells = row.querySelectorAll('td');
  document.getElementById('edit-lead-id').value = id;
  document.getElementById('edit-name').value = cells[1].textContent.trim().replace('—','');
  document.getElementById('edit-phone').value = cells[2].textContent.trim();
  document.getElementById('edit-city').value = cells[3].textContent.trim().replace('—','');
  document.getElementById('edit-notes').value = row.cells[7].title || '';
  openModal('edit-lead-modal');
}

document.getElementById('save-lead-btn')?.addEventListener('click', async () => {
  const id = document.getElementById('edit-lead-id').value;
  try {
    await apiPut(`/leads/${id}`, {
      name: document.getElementById('edit-name').value,
      phone: document.getElementById('edit-phone').value,
      city: document.getElementById('edit-city').value,
      notes: document.getElementById('edit-notes').value,
    });
    closeModal('edit-lead-modal');
    toast('Lead updated', 'success');
    loadLeads();
  } catch (err) {
    toast('Update failed: ' + err.message, 'error');
  }
});

async function deleteLead(id) {
  if (!confirm('Delete this lead?')) return;
  try {
    await apiDelete(`/leads/${id}`);
    toast('Lead deleted', 'success');
    loadLeads();
  } catch (err) {
    toast('Delete failed', 'error');
  }
}

function bindEvents() {
  document.getElementById('filter-status')?.addEventListener('change', loadLeads);

  document.getElementById('add-lead-btn')?.addEventListener('click', () => openModal('add-lead-modal'));

  document.getElementById('add-lead-submit')?.addEventListener('click', async () => {
    const phone = document.getElementById('new-phone').value;
    if (!phone) { toast('Phone number required', 'warning'); return; }
    try {
      await apiPost('/leads', {
        name: document.getElementById('new-name').value,
        phone,
        email: document.getElementById('new-email').value,
        city: document.getElementById('new-city').value,
        notes: document.getElementById('new-notes').value,
      });
      closeModal('add-lead-modal');
      document.querySelectorAll('#add-lead-modal input, #add-lead-modal textarea').forEach(el => el.value = '');
      toast('Lead added', 'success');
      loadLeads();
    } catch (err) {
      toast('Failed: ' + err.message, 'error');
    }
  });

  // CSV Upload
  document.getElementById('upload-btn')?.addEventListener('click', () => openModal('upload-modal'));

  const zone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('csv-file-input');

  zone?.addEventListener('click', () => fileInput?.click());
  zone?.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
  zone?.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone?.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) handleCSVUpload(file);
  });

  fileInput?.addEventListener('change', () => {
    if (fileInput.files[0]) handleCSVUpload(fileInput.files[0]);
  });
}

async function handleCSVUpload(file) {
  if (!file.name.endsWith('.csv')) { toast('Please upload a CSV file', 'warning'); return; }
  const formData = new FormData();
  formData.append('file', file);

  const resultEl = document.getElementById('upload-result');
  if (resultEl) resultEl.textContent = 'Uploading...';

  try {
    const data = await apiFormData('/leads/upload', formData);
    if (resultEl) resultEl.innerHTML = `<span style="color:var(--accent)">✓ Imported ${data.imported} leads</span>${data.skipped > 0 ? `, skipped ${data.skipped}` : ''}`;
    toast(`Imported ${data.imported} leads`, 'success');
    setTimeout(() => { closeModal('upload-modal'); loadLeads(); }, 2000);
  } catch (err) {
    if (resultEl) resultEl.innerHTML = `<span style="color:var(--danger)">Error: ${escHtml(err.message)}</span>`;
    toast('Upload failed: ' + err.message, 'error');
  }
}
