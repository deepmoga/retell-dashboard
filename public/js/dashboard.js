document.addEventListener('DOMContentLoaded', async () => {
  if (!requireAuth()) return;

  await loadStats();
  await loadRecentCalls();
});

let chartBar, chartLine;

async function loadStats() {
  try {
    const data = await apiGet('/dashboard/stats');
    const s = data.stats;

    setText('stat-today', s.todayTotal);
    setText('stat-month', s.monthTotal);
    setText('stat-inbound', s.todayInbound);
    setText('stat-outbound', s.todayOutbound);
    setText('stat-minutes', s.monthMinutes.toFixed(1) + ' min');
    setText('stat-answer-rate', s.answerRate + '%');
    setText('stat-cost', '$' + s.monthCost.toFixed(2));
    setText('stat-active', s.activeNow);

    renderBarChart(s.last7Days);
    await renderCostChart();
  } catch (err) {
    console.error('Stats error:', err);
  }
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function renderBarChart(last7) {
  const ctx = document.getElementById('chart-calls');
  if (!ctx) return;
  if (chartBar) chartBar.destroy();
  chartBar = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: last7.map(d => d.date.slice(5)),
      datasets: [
        { label: 'Inbound', data: last7.map(d => d.inbound), backgroundColor: 'rgba(0,212,170,0.7)', borderRadius: 4 },
        { label: 'Outbound', data: last7.map(d => d.outbound), backgroundColor: 'rgba(52,152,219,0.7)', borderRadius: 4 },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: '#888', font: { size: 12 } } } },
      scales: {
        x: { ticks: { color: '#888' }, grid: { color: '#2a2a2a' } },
        y: { ticks: { color: '#888' }, grid: { color: '#2a2a2a' }, beginAtZero: true },
      },
    },
  });
}

async function renderCostChart() {
  const ctx = document.getElementById('chart-costs');
  if (!ctx) return;
  try {
    const data = await apiGet('/costs/daily?days=30');
    const daily = (data.daily || []).slice().reverse();
    if (chartLine) chartLine.destroy();
    chartLine = new Chart(ctx, {
      type: 'line',
      data: {
        labels: daily.map(d => d.date.slice(5)),
        datasets: [{
          label: 'Daily Cost ($)',
          data: daily.map(d => parseFloat(d.total_cost?.toFixed(4) || 0)),
          borderColor: '#00d4aa',
          backgroundColor: 'rgba(0,212,170,0.1)',
          fill: true,
          tension: 0.4,
          pointRadius: 3,
        }],
      },
      options: {
        responsive: true,
        plugins: { legend: { labels: { color: '#888', font: { size: 12 } } } },
        scales: {
          x: { ticks: { color: '#888', maxTicksLimit: 10 }, grid: { color: '#2a2a2a' } },
          y: { ticks: { color: '#888', callback: v => '$' + v.toFixed(2) }, grid: { color: '#2a2a2a' }, beginAtZero: true },
        },
      },
    });
  } catch (err) {
    console.error('Cost chart error:', err);
  }
}

async function loadRecentCalls() {
  try {
    const data = await apiGet('/calls?limit=10&page=1');
    const tbody = document.getElementById('recent-calls-body');
    if (!tbody) return;

    if (!data.calls.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty-state" style="padding:30px;text-align:center;color:#888">No calls yet</td></tr>';
      return;
    }

    tbody.innerHTML = data.calls.map(c => `
      <tr>
        <td>${callTypeBadge(c.call_type)}</td>
        <td>${escHtml(c.from_number || '—')}</td>
        <td>${escHtml(c.to_number || '—')}</td>
        <td>${fmtDuration(c.duration_seconds)}</td>
        <td>${statusBadge(c.status)}</td>
        <td>${fmtCost(c.total_cost)}</td>
        <td>${fmtDate(c.start_timestamp)}</td>
        <td>
          <div class="table-actions">
            ${c.recording_url || c.recording_local_path ? `<a href="/api/calls/${c.id}/recording" target="_blank" class="btn btn-ghost btn-sm btn-icon" title="Recording">🎵</a>` : ''}
            <button class="btn btn-ghost btn-sm btn-icon" onclick="viewTranscript(${c.id})" title="Transcript">📄</button>
          </div>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    console.error('Recent calls error:', err);
  }
}

async function viewTranscript(callId) {
  try {
    const data = await apiGet(`/calls/${callId}`);
    const c = data.call;
    document.getElementById('modal-summary').textContent = c.call_summary || 'No summary available.';
    document.getElementById('modal-transcript').textContent = c.transcript || 'No transcript available.';
    openModal('transcript-modal');
  } catch (err) {
    toast('Failed to load transcript', 'error');
  }
}

document.getElementById('copy-transcript')?.addEventListener('click', () => {
  const text = document.getElementById('modal-transcript')?.textContent;
  if (text) { navigator.clipboard.writeText(text); toast('Copied!', 'success'); }
});
