let socket = null;
let activeCalls = {};
let timerInterval = null;

document.addEventListener('DOMContentLoaded', async () => {
  if (!requireAuth()) return;
  await loadLiveCalls();
  connectSocket();
});

async function loadLiveCalls() {
  try {
    const data = await apiGet('/live/calls');
    activeCalls = {};
    data.calls.forEach(c => { activeCalls[c.call_id] = c; });
    renderCalls();
  } catch (err) {
    console.error('Live calls error:', err);
  }
}

function connectSocket() {
  socket = io({ auth: { token: getToken() } });

  socket.on('connect', () => {
    console.log('[Socket] Connected');
    document.getElementById('socket-status')?.classList.add('connected');
  });

  socket.on('disconnect', () => {
    document.getElementById('socket-status')?.classList.remove('connected');
  });

  socket.on('call_started', (data) => {
    activeCalls[data.callId] = {
      call_id: data.callId,
      from_number: data.fromNumber,
      to_number: data.toNumber,
      agent_name: data.agentName,
      start_timestamp: data.startTime,
      status: 'ongoing',
      elapsed_seconds: 0,
    };
    renderCalls();
    toast(`📞 New call: ${data.fromNumber || data.toNumber}`, 'info');
  });

  socket.on('call_ended', (data) => {
    delete activeCalls[data.callId];
    renderCalls();
  });

  socket.on('calls_updated', (data) => {
    updateCount(Object.keys(activeCalls).length);
  });
}

function renderCalls() {
  const calls = Object.values(activeCalls);
  updateCount(calls.length);

  const grid = document.getElementById('live-calls-grid');
  if (!grid) return;

  if (!calls.length) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1">
        <div class="empty-icon">📵</div>
        <p>No active calls right now</p>
      </div>`;
    clearInterval(timerInterval);
    return;
  }

  grid.innerHTML = calls.map(c => `
    <div class="live-call-card" id="call-card-${c.call_id}">
      <div style="display:flex;align-items:center;gap:8px;justify-content:space-between">
        <div style="display:flex;align-items:center;gap:8px">
          <span class="pulse-dot"></span>
          <span style="font-size:12px;color:var(--text-muted);font-weight:600;text-transform:uppercase">Live</span>
        </div>
        ${callTypeBadge('outbound')}
      </div>
      <div class="live-number">${escHtml(c.to_number || c.from_number || 'Unknown')}</div>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px">
        ${c.agent_name ? `Agent: ${escHtml(c.agent_name)}` : 'Agent active'}
      </div>
      <div class="live-timer" id="timer-${c.call_id}">${fmtElapsed(c.elapsed_seconds || 0)}</div>
      <div style="font-size:11px;color:var(--text-muted);margin-top:4px">
        Started ${fmtDate(c.start_timestamp)}
      </div>
    </div>
  `).join('');

  clearInterval(timerInterval);
  timerInterval = setInterval(tickTimers, 1000);
}

function tickTimers() {
  const calls = Object.values(activeCalls);
  calls.forEach(c => {
    const el = document.getElementById(`timer-${c.call_id}`);
    if (el && c.start_timestamp) {
      const elapsed = Math.round((Date.now() - c.start_timestamp) / 1000);
      el.textContent = fmtElapsed(elapsed);
    }
  });
}

function updateCount(n) {
  const el = document.getElementById('live-count');
  if (el) el.textContent = n;
  const badge = document.getElementById('live-badge');
  if (badge) { badge.textContent = n; badge.style.display = n > 0 ? '' : 'none'; }
}

document.getElementById('refresh-btn')?.addEventListener('click', loadLiveCalls);

// Refresh every 30 seconds as backup
setInterval(loadLiveCalls, 30000);
