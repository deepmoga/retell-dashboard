let editingAgentId = null;
let deleteAgentId = null;

const VAPI_VOICES = [
  { provider: '11labs', voiceId: 'paula',   name: 'Paula',   gender: 'female' },
  { provider: '11labs', voiceId: 'rachel',  name: 'Rachel',  gender: 'female' },
  { provider: '11labs', voiceId: 'lily',    name: 'Lily',    gender: 'female' },
  { provider: '11labs', voiceId: 'sarah',   name: 'Sarah',   gender: 'female' },
  { provider: '11labs', voiceId: 'alice',   name: 'Alice',   gender: 'female' },
  { provider: '11labs', voiceId: 'jessica', name: 'Jessica', gender: 'female' },
  { provider: '11labs', voiceId: 'adam',    name: 'Adam',    gender: 'male'   },
  { provider: '11labs', voiceId: 'charlie', name: 'Charlie', gender: 'male'   },
  { provider: '11labs', voiceId: 'james',   name: 'James',   gender: 'male'   },
  { provider: '11labs', voiceId: 'george',  name: 'George',  gender: 'male'   },
  { provider: '11labs', voiceId: 'brian',   name: 'Brian',   gender: 'male'   },
  { provider: '11labs', voiceId: 'liam',    name: 'Liam',    gender: 'male'   },
  { provider: 'openai', voiceId: 'alloy',   name: 'Alloy',   gender: 'neutral' },
  { provider: 'openai', voiceId: 'echo',    name: 'Echo',    gender: 'male'   },
  { provider: 'openai', voiceId: 'fable',   name: 'Fable',   gender: 'female' },
  { provider: 'openai', voiceId: 'onyx',    name: 'Onyx',    gender: 'male'   },
  { provider: 'openai', voiceId: 'nova',    name: 'Nova',    gender: 'female' },
  { provider: 'openai', voiceId: 'shimmer', name: 'Shimmer', gender: 'female' },
  { provider: 'azure',  voiceId: 'en-US-JennyNeural',    name: 'Jenny (US)',      gender: 'female' },
  { provider: 'azure',  voiceId: 'en-AU-NatashaNeural',  name: 'Natasha (AU)',    gender: 'female' },
  { provider: 'azure',  voiceId: 'en-GB-SoniaNeural',    name: 'Sonia (GB)',      gender: 'female' },
  { provider: 'azure',  voiceId: 'en-IN-NeerjaNeural',   name: 'Neerja (IN)',     gender: 'female' },
  { provider: 'azure',  voiceId: 'hi-IN-SwaraNeural',    name: 'Swara 🇮🇳 Hindi', gender: 'female' },
  { provider: 'azure',  voiceId: 'hi-IN-MadhurNeural',   name: 'Madhur 🇮🇳 Hindi',gender: 'male'   },
  { provider: 'azure',  voiceId: 'ur-PK-UzmaNeural',     name: 'Uzma 🇵🇰 Urdu',  gender: 'female' },
];

const TEMPLATES = {
  sales: `You are a professional sales agent for [Company Name]. Your goal is to qualify leads and schedule product demonstrations.

When speaking with prospects:
- Start by asking about their current challenges
- Listen carefully and identify pain points
- Explain how our solution addresses their specific needs
- Address objections confidently and empathetically
- Guide qualified leads toward booking a demo

Keep conversations focused, friendly, and under 5 minutes.`,

  support: `You are a helpful customer support agent for [Company Name]. You help customers resolve issues quickly.

Your approach:
- Greet warmly and identify the customer's issue
- Ask clarifying questions to fully understand the problem
- Provide clear, step-by-step solutions
- Confirm the issue is resolved before ending the call
- Escalate to a human agent if the issue is complex

Always be patient, empathetic, and professional.`,

  booking: `You are a friendly booking assistant for [Business Name].

LANGUAGE: Speak in clear, simple English. Be warm and casual.

IMPORTANT: At the very start of every call, silently call the getTodayDate tool to know today's correct date. Never guess the date from memory.

DATE & TIME RULES — Very Important:
- When asking for date, ALWAYS give examples: "Which day works for you? For example, you can say: this Monday, next Friday, or the 15th of June."
- When asking for time, ALWAYS give examples: "What time suits you? For example: 10 in the morning, 2 in the afternoon, or 4:30 PM."
- After customer says a date/time, REPEAT IT BACK in full: "So that's [FULL DAY], [DATE] at [TIME] — is that right?"
- NEVER assume a date. Always confirm the full date including day, month, and year.
- If the customer is unclear, gently ask again: "Just to make sure I have it right — did you mean [DATE]?"

BOOKING FLOW:
Step 1 — Ask service: "What service can I help you with today?"
Step 2 — Ask date with examples: "Which day works for you? You can say something like: this Friday, or the 12th of June."
Step 3 — Ask time with examples: "And what time? For example: 10 in the morning, or 2 in the afternoon."
Step 4 — Confirm FULL details out loud: "Perfect! Just to confirm — [NAME], you'd like [SERVICE] on [FULL DATE e.g. Friday the 13th of June 2026] at [TIME]. Is that correct?"
Step 5 — Wait for YES, then call checkAvailability tool.
Step 6 — If available: ask name and phone: "Great! Can I get your name?" then "And your best contact number?"
Step 7 — Call bookAppointment tool with all details.
Step 8 — Confirm: "All booked! Your appointment is confirmed for [DATE] at [TIME]. See you then!"

IMPORTANT RULES:
- Maximum 1 question at a time
- Keep responses under 2 sentences
- If customer says a past date, say: "That date has already passed. What's a good upcoming date for you?"
- NEVER book without hearing YES from the customer first`,

  survey: `You are a survey agent conducting customer satisfaction research for [Company Name].

Your process:
- Introduce yourself and explain the survey takes 2-3 minutes
- Ask each question clearly and wait for a complete response
- Thank participants for their time

Keep a neutral, friendly tone throughout.`,
};

let allVoices = [...VAPI_VOICES];
let filteredVoices = [...VAPI_VOICES];

document.addEventListener('DOMContentLoaded', async () => {
  if (!requireAuth()) return;
  renderVoices(allVoices);
  await loadAgents();

  document.getElementById('new-agent-btn').addEventListener('click', openNewAgentModal);
  document.getElementById('save-agent-btn').addEventListener('click', saveAgent);

  document.getElementById('fix-analysis-btn').addEventListener('click', async () => {
    const btn = document.getElementById('fix-analysis-btn');
    btn.disabled = true;
    btn.textContent = '⏳ Updating...';
    try {
      const data = await apiPost('/agents/fix-analysis', {});
      toast(data.message || `✅ Updated ${data.updated} agents`, 'success', 6000);
    } catch(err) {
      toast('Failed: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '🗓 Fix Date in All Agents';
    }
  });
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
    const prompt = a.model?.systemPrompt || a.model?.messages?.[0]?.content || '';
    const voiceInfo = a.voice ? `${a.voice.provider || '11labs'} · ${a.voice.voiceId || '—'}` : 'No voice set';
    return `
      <div class="agent-card">
        <div class="agent-card-header">
          <div class="agent-avatar">🤖</div>
          <div style="flex:1;min-width:0">
            <div class="agent-name">${escHtml(a.name || 'Unnamed Agent')}</div>
            <div class="agent-meta">${escHtml(voiceInfo)} · ${escHtml(a.language || 'en-US')}</div>
          </div>
          <span class="badge badge-ended" style="font-size:10px">Active</span>
        </div>
        ${prompt
          ? `<div class="agent-prompt-preview">${escHtml(prompt)}</div>`
          : '<div class="agent-prompt-preview" style="color:var(--text-dim)">No system prompt configured</div>'}
        <div class="agent-card-actions">
          <button class="btn btn-secondary btn-sm" style="flex:1" onclick="openEditAgentModal('${escHtml(a.id)}')">✏️ Edit</button>
          <button class="btn btn-danger btn-sm" onclick="openDeleteModal('${escHtml(a.id)}','${escHtml(a.name || 'this agent')}')">🗑</button>
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
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:20px;color:var(--text-muted)">No voices found</div>';
    return;
  }
  const selProvider = document.getElementById('f-voice-provider')?.value || '';
  const selVoiceId = document.getElementById('f-voice-id')?.value || '';

  grid.innerHTML = voices.map(v => {
    const gender = v.gender === 'female' ? '👩' : v.gender === 'male' ? '👨' : '🎙️';
    const isSelected = selProvider === v.provider && selVoiceId === v.voiceId;
    return `
      <div class="voice-card ${isSelected ? 'selected' : ''}"
           id="vc-${escHtml(v.provider)}-${escHtml(v.voiceId)}"
           onclick="selectVoice('${escHtml(v.provider)}','${escHtml(v.voiceId)}','${escHtml(v.name)}')">
        <div class="voice-gender">${gender}</div>
        <div class="voice-name">${escHtml(v.name)}</div>
        <div class="voice-provider">${escHtml(v.provider)}</div>
      </div>`;
  }).join('');
}

function filterVoices(query) {
  const q = query.toLowerCase();
  filteredVoices = q
    ? allVoices.filter(v => v.name.toLowerCase().includes(q) || v.provider.toLowerCase().includes(q))
    : [...allVoices];
  renderVoices(filteredVoices);
}

function selectVoice(provider, voiceId, name) {
  document.getElementById('f-voice-provider').value = provider;
  document.getElementById('f-voice-id').value = voiceId;
  document.getElementById('voice-selected-label').textContent = `${name} (${provider})`;
  renderVoices(filteredVoices);
}

function switchTab(tabName) {
  document.querySelectorAll('.modal-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + tabName));
}

function openNewAgentModal() {
  editingAgentId = null;
  document.getElementById('modal-title').textContent = 'New Agent';
  document.getElementById('f-name').value = '';
  document.getElementById('f-language').value = 'en-US';
  document.getElementById('f-begin-message').value = '';
  document.getElementById('f-system-prompt').value = '';
  document.getElementById('f-voice-provider').value = '';
  document.getElementById('f-voice-id').value = '';
  document.getElementById('voice-selected-label').textContent = 'Paula (11labs)';
  selectVoice('11labs', 'paula', 'Paula');
  switchTab('basic');
  openModal('agent-modal');
}

async function openEditAgentModal(agentId) {
  try {
    toast('Loading agent...', 'info', 1500);
    const data = await apiGet('/agents/' + agentId);
    const a = data.agent;
    editingAgentId = agentId;

    document.getElementById('modal-title').textContent = 'Edit Agent';
    document.getElementById('f-name').value = a.name || '';
    document.getElementById('f-language').value = a.language || 'en-US';
    document.getElementById('f-begin-message').value = a.firstMessage || '';

    // VAPI returns system prompt in multiple possible locations — check all
    const systemPrompt =
      a.model?.systemPrompt ||
      a.model?.messages?.find(m => m.role === 'system')?.content ||
      a.model?.prompt?.messages?.find(m => m.role === 'system')?.content ||
      '';
    document.getElementById('f-system-prompt').value = systemPrompt;

    const vp = a.voice?.provider || '11labs';
    const vid = a.voice?.voiceId || a.voice?.voice_id || 'paula';
    const vname = allVoices.find(v => v.provider === vp && v.voiceId === vid)?.name || vid;
    selectVoice(vp, vid, vname);

    const modelSel = document.getElementById('f-model-id');
    const currentModel = a.model?.model || a.model?.modelId || 'gpt-4o-mini';
    if (modelSel) {
      // Try to set value, fallback to gpt-4o-mini if not found
      modelSel.value = currentModel;
      if (!modelSel.value) modelSel.value = 'gpt-4o-mini';
    }

    console.log('[Edit Agent] Loaded:', {
      name: a.name,
      model: currentModel,
      voice: `${vp}/${vid}`,
      systemPromptLength: systemPrompt.length,
      firstMessage: a.firstMessage,
    });

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
    voice_provider: document.getElementById('f-voice-provider').value || '11labs',
    voice_id: document.getElementById('f-voice-id').value || 'paula',
    language: document.getElementById('f-language').value,
    first_message: document.getElementById('f-begin-message').value.trim(),
    system_prompt: document.getElementById('f-system-prompt').value.trim(),
    model_id: document.getElementById('f-model-id').value || 'gpt-4o-mini',
  };

  const btn = document.getElementById('save-agent-btn');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    if (editingAgentId) {
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
  if (ta) { ta.value = TEMPLATES[type] || ''; ta.focus(); toast('Template inserted', 'success'); }
}
