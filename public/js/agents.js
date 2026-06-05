let allVoices = [];
let editingAgentId = null;
let editingLlmId = null;
let deleteAgentId = null;

const TEMPLATES = {
  sales: `You are a professional sales agent for [Company Name]. Your goal is to qualify leads and schedule product demonstrations.

When speaking with prospects:
- Start by asking about their current challenges
- Listen carefully and identify pain points
- Explain how our solution addresses their specific needs
- Address objections confidently and empathetically
- Guide qualified leads toward booking a demo

Keep conversations focused, friendly, and under 5 minutes. Always confirm the prospect's availability before suggesting demo times.`,

  support: `You are a helpful customer support agent for [Company Name]. You help customers resolve issues quickly and leave them satisfied.

Your approach:
- Greet warmly and identify the customer's issue
- Ask clarifying questions to fully understand the problem
- Provide clear, step-by-step solutions
- Confirm the issue is resolved before ending the call
- Escalate to a human agent if the issue is complex

Always be patient, empathetic, and professional. Never make promises you cannot keep.`,

  booking: `You are a booking assistant for [Business Name]. You help customers schedule appointments efficiently.

During the call:
- Confirm the service they need
- Check their preferred date and time
- Verify availability and offer alternatives if needed
- Collect required details: name, phone number, and any special requests
- Confirm the booking and provide a reference number

Always double-check appointment details before confirming. If a slot is unavailable, proactively suggest the nearest available alternatives.`,

  survey: `You are a survey agent conducting customer satisfaction research for [Company Name].

Your process:
- Introduce yourself and explain the survey takes 2-3 minutes
- Ask each question clearly and wait for a complete response
- Probe for more detail when answers are vague
- Thank participants for their time and honesty
- Keep a neutral, friendly tone throughout

Do not lead respondents toward any particular answer. Record responses accurately and objectively.`,
};

document.addEventListener('DOMContentLoaded', async () => {
  if (!requireAuth()) return;
  await loadAgents();
  await loadVoices();

  document.getElementById('new-agent-btn').addEventListener('click', openNewAgentModal);
  document.getElementById('save-agent-btn').addEventListener('click', saveAgent);
  document.getElementById('confirm-delete-btn').addEventListener('click', confirmDelete);

  document.querySelectorAll('.modal-tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });
});

async function loadAgents() {
  try {
    const data = await apiGet('/agents');
    if (data.no_key) {
      document.getElementById('no-key-banner').style.display = 'flex';
    }
    renderAgents(data.agents || []);
  } catch (err) {
    document.getElementById('agents-container').innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">⚠️</div>
        <div class="empty-title">Failed to load agents</div>
        <div style="font-size:13px;margin-top:4px">${escHtml(err.message)}</div>
      </div>`;
  }
}

async function loadVoices() {
  try {
    const data = await apiGet('/agents/voices');
    allVoices = data.voices || [];
    renderVoices(allVoices);
  } catch (_) {
    document.getElementById('voice-grid').innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:20px;color:var(--text-muted)">Could not load voices</div>';
  }
}

function renderAgents(agents) {
  const container = document.getElementById('agents-container');
  if (!agents.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🤖</div>
        <div class="empty-title">No agents yet</div>
        <div style="font-size:13px;margin-top:4px;margin-bottom:20px">Create your first AI voice agent to get started</div>
        <button class="btn btn-primary" onclick="openNewAgentModal()">+ Create Agent</button>
      </div>`;
    return;
  }

  const cards = agents.map(a => {
    const prompt = a.llm?.system_prompt || a.response_engine?.system_prompt || '';
    const voice = a.voice_id || 'Unknown voice';
    const lang = a.language || 'en-US';
    return `
      <div class="agent-card">
        <div class="agent-card-header">
          <div class="agent-avatar">🤖</div>
          <div style="flex:1;min-width:0">
            <div class="agent-name">${escHtml(a.agent_name || 'Unnamed Agent')}</div>
            <div class="agent-meta">${escHtml(voice)} · ${escHtml(lang)}</div>
          </div>
          <div>
            <span class="badge badge-ended" style="font-size:10px">Active</span>
          </div>
        </div>
        ${prompt ? `<div class="agent-prompt-preview">${escHtml(prompt)}</div>` : '<div class="agent-prompt-preview" style="color:var(--text-dim)">No system prompt configured</div>'}
        <div class="agent-card-actions">
          <button class="btn btn-secondary btn-sm" style="flex:1" onclick="openEditAgentModal('${escHtml(a.agent_id)}')">✏️ Edit</button>
          <button class="btn btn-danger btn-sm" onclick="openDeleteModal('${escHtml(a.agent_id)}','${escHtml(a.agent_name || 'this agent')}')">🗑</button>
        </div>
      </div>`;
  });

  cards.push(`
    <div class="add-agent-card" onclick="openNewAgentModal()">
      <div class="add-icon">+</div>
      <div class="add-label">Create New Agent</div>
    </div>`);

  container.innerHTML = `<div class="agents-grid">${cards.join('')}</div>`;
}

function renderVoices(voices) {
  const grid = document.getElementById('voice-grid');
  if (!voices.length) {
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:20px;color:var(--text-muted)">No voices available</div>';
    return;
  }
  grid.innerHTML = voices.map(v => {
    const gender = v.gender === 'female' ? '👩' : v.gender === 'male' ? '👨' : '🎙️';
    const provider = v.provider || (v.voice_id?.split('-')[0] || 'Unknown');
    return `
      <div class="voice-card" id="vc-${escHtml(v.voice_id)}" onclick="selectVoice('${escHtml(v.voice_id)}','${escHtml(v.voice_name || v.voice_id)}')">
        <div class="voice-gender">${gender}</div>
        <div class="voice-name">${escHtml(v.voice_name || v.voice_id)}</div>
        <div class="voice-provider">${escHtml(provider)}</div>
      </div>`;
  }).join('');
}

function filterVoices(query) {
  const q = query.toLowerCase();
  const filtered = q ? allVoices.filter(v =>
    (v.voice_name || '').toLowerCase().includes(q) ||
    (v.voice_id || '').toLowerCase().includes(q) ||
    (v.provider || '').toLowerCase().includes(q)
  ) : allVoices;
  renderVoices(filtered);
  const saved = document.getElementById('f-voice-id').value;
  if (saved) {
    const el = document.getElementById('vc-' + saved);
    if (el) el.classList.add('selected');
  }
}

function selectVoice(id, name) {
  document.querySelectorAll('.voice-card').forEach(c => c.classList.remove('selected'));
  const el = document.getElementById('vc-' + id);
  if (el) el.classList.add('selected');
  document.getElementById('f-voice-id').value = id;
  document.getElementById('voice-selected-label').textContent = name;
}

function switchTab(tabName) {
  document.querySelectorAll('.modal-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + tabName));
}

function openNewAgentModal() {
  editingAgentId = null;
  editingLlmId = null;
  document.getElementById('modal-title').textContent = 'New Agent';
  document.getElementById('f-name').value = '';
  document.getElementById('f-language').value = 'en-US';
  document.getElementById('f-begin-message').value = '';
  document.getElementById('f-system-prompt').value = '';
  document.getElementById('f-voice-id').value = '';
  document.getElementById('voice-selected-label').textContent = 'None';
  document.getElementById('f-responsiveness').value = 1;
  document.getElementById('resp-val').textContent = '1.00';
  document.getElementById('f-interruption').value = 1;
  document.getElementById('intr-val').textContent = '1.00';
  document.querySelectorAll('.voice-card').forEach(c => c.classList.remove('selected'));
  switchTab('basic');
  openModal('agent-modal');
}

async function openEditAgentModal(agentId) {
  try {
    toast('Loading agent...', 'info', 1500);
    const data = await apiGet('/agents/' + agentId);
    const a = data.agent;

    editingAgentId = agentId;
    editingLlmId = a.llm?.llm_id || a.response_engine?.llm_id || null;

    document.getElementById('modal-title').textContent = 'Edit Agent';
    document.getElementById('f-name').value = a.agent_name || '';
    document.getElementById('f-language').value = a.language || 'en-US';
    document.getElementById('f-begin-message').value = a.llm?.begin_message || '';
    document.getElementById('f-system-prompt').value = a.llm?.system_prompt || '';

    const voiceId = a.voice_id || '';
    document.getElementById('f-voice-id').value = voiceId;

    const voiceName = allVoices.find(v => v.voice_id === voiceId)?.voice_name || voiceId || 'None';
    document.getElementById('voice-selected-label').textContent = voiceName || 'None';
    document.querySelectorAll('.voice-card').forEach(c => c.classList.remove('selected'));
    if (voiceId) {
      const el = document.getElementById('vc-' + voiceId);
      if (el) el.classList.add('selected');
    }

    const resp = a.responsiveness !== undefined ? a.responsiveness : 1;
    const intr = a.interruption_sensitivity !== undefined ? a.interruption_sensitivity : 1;
    document.getElementById('f-responsiveness').value = resp;
    document.getElementById('resp-val').textContent = parseFloat(resp).toFixed(2);
    document.getElementById('f-interruption').value = intr;
    document.getElementById('intr-val').textContent = parseFloat(intr).toFixed(2);

    switchTab('basic');
    openModal('agent-modal');
  } catch (err) {
    toast('Failed to load agent: ' + err.message, 'error');
  }
}

async function saveAgent() {
  const name = document.getElementById('f-name').value.trim();
  if (!name) { toast('Agent name is required', 'warning'); switchTab('basic'); return; }

  const payload = {
    agent_name: name,
    voice_id: document.getElementById('f-voice-id').value || '11labs-Adrian',
    language: document.getElementById('f-language').value,
    begin_message: document.getElementById('f-begin-message').value.trim() || null,
    system_prompt: document.getElementById('f-system-prompt').value.trim(),
    responsiveness: parseFloat(document.getElementById('f-responsiveness').value),
    interruption_sensitivity: parseFloat(document.getElementById('f-interruption').value),
  };

  const btn = document.getElementById('save-agent-btn');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    if (editingAgentId) {
      payload.llm_id = editingLlmId;
      await apiPut('/agents/' + editingAgentId, payload);
      toast('Agent updated successfully', 'success');
    } else {
      await apiPost('/agents', payload);
      toast('Agent created successfully', 'success');
    }
    closeModal('agent-modal');
    await loadAgents();
  } catch (err) {
    toast('Failed to save agent: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Agent';
  }
}

function openDeleteModal(agentId, agentName) {
  deleteAgentId = agentId;
  document.getElementById('delete-agent-name').textContent = agentName;
  openModal('delete-modal');
}

async function confirmDelete() {
  if (!deleteAgentId) return;
  const btn = document.getElementById('confirm-delete-btn');
  btn.disabled = true;
  btn.textContent = 'Deleting...';
  try {
    await apiDelete('/agents/' + deleteAgentId);
    toast('Agent deleted', 'success');
    closeModal('delete-modal');
    await loadAgents();
  } catch (err) {
    toast('Failed to delete agent: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Delete Agent';
    deleteAgentId = null;
  }
}

function insertTemplate(type) {
  const ta = document.getElementById('f-system-prompt');
  if (ta) {
    ta.value = TEMPLATES[type] || '';
    ta.focus();
    toast('Template inserted', 'success');
  }
}
