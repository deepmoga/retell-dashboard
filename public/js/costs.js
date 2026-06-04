let costChart = null;

document.addEventListener('DOMContentLoaded', async () => {
  if (!requireAuth()) return;
  await Promise.all([loadSummary(), loadDaily()]);
  bindBudget();
});

async function loadSummary() {
  try {
    const data = await apiGet('/costs/summary');
    const s = data.summary;
    setText('cost-total', '$' + parseFloat(s.total_cost || 0).toFixed(2));
    setText('cost-retell', '$' + parseFloat(s.retell_cost || 0).toFixed(2));
    setText('cost-twilio', '$' + parseFloat(s.twilio_cost || 0).toFixed(2));
    setText('cost-llm', '$' + parseFloat(s.llm_cost || 0).toFixed(2));
    setText('cost-minutes', parseFloat(s.total_minutes || 0).toFixed(1) + ' min');
    const perCall = s.total_calls > 0 ? (s.total_cost / s.total_calls) : 0;
    setText('cost-per-call', '$' + perCall.toFixed(4));

    const budget = parseFloat(localStorage.getItem('monthly_budget') || 0);
    if (budget > 0) updateBudgetProgress(s.total_cost || 0, budget);
  } catch (err) {
    toast('Failed to load cost summary', 'error');
  }
}

async function loadDaily() {
  try {
    const data = await apiGet('/costs/daily?days=30');
    const daily = data.daily || [];
    renderTable(daily);
    renderChart(daily);
  } catch (err) {
    console.error('Daily costs error:', err);
  }
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function renderTable(daily) {
  const tbody = document.getElementById('costs-tbody');
  if (!tbody) return;

  const sorted = daily.slice().sort((a, b) => b.date.localeCompare(a.date));

  if (!sorted.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:30px;color:var(--text-muted)">No cost data yet</td></tr>';
    return;
  }

  const totals = sorted.reduce((acc, d) => ({
    calls: acc.calls + (d.total_calls || 0),
    minutes: acc.minutes + (d.total_minutes || 0),
    retell: acc.retell + (d.retell_cost || 0),
    twilio: acc.twilio + (d.twilio_cost || 0),
    llm: acc.llm + (d.llm_cost || 0),
    total: acc.total + (d.total_cost || 0),
  }), { calls: 0, minutes: 0, retell: 0, twilio: 0, llm: 0, total: 0 });

  const rows = sorted.map(d => `
    <tr>
      <td>${d.date}</td>
      <td>${d.total_calls || 0}</td>
      <td>${parseFloat(d.total_minutes || 0).toFixed(1)}</td>
      <td>$${parseFloat(d.retell_cost || 0).toFixed(4)}</td>
      <td>$${parseFloat(d.twilio_cost || 0).toFixed(4)}</td>
      <td>$${parseFloat(d.llm_cost || 0).toFixed(4)}</td>
      <td style="font-weight:600">$${parseFloat(d.total_cost || 0).toFixed(4)}</td>
    </tr>
  `).join('');

  const totalRow = `
    <tr style="background:var(--surface2);font-weight:600;border-top:2px solid var(--border2)">
      <td>Total (30 days)</td>
      <td>${totals.calls}</td>
      <td>${totals.minutes.toFixed(1)}</td>
      <td>$${totals.retell.toFixed(4)}</td>
      <td>$${totals.twilio.toFixed(4)}</td>
      <td>$${totals.llm.toFixed(4)}</td>
      <td>$${totals.total.toFixed(4)}</td>
    </tr>
  `;

  tbody.innerHTML = rows + totalRow;
}

function renderChart(daily) {
  const ctx = document.getElementById('cost-chart');
  if (!ctx) return;

  const sorted = daily.slice().sort((a, b) => a.date.localeCompare(b.date));

  if (costChart) costChart.destroy();
  costChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: sorted.map(d => d.date.slice(5)),
      datasets: [
        { label: 'Retell AI', data: sorted.map(d => parseFloat(d.retell_cost || 0)), backgroundColor: 'rgba(0,212,170,0.8)', borderRadius: 3 },
        { label: 'Twilio', data: sorted.map(d => parseFloat(d.twilio_cost || 0)), backgroundColor: 'rgba(52,152,219,0.8)', borderRadius: 3 },
        { label: 'LLM', data: sorted.map(d => parseFloat(d.llm_cost || 0)), backgroundColor: 'rgba(243,156,18,0.7)', borderRadius: 3 },
      ],
    },
    options: {
      responsive: true,
      scales: {
        x: { stacked: true, ticks: { color: '#888', maxTicksLimit: 12 }, grid: { color: '#2a2a2a' } },
        y: { stacked: true, ticks: { color: '#888', callback: v => '$' + v.toFixed(2) }, grid: { color: '#2a2a2a' }, beginAtZero: true },
      },
      plugins: { legend: { labels: { color: '#888' } } },
    },
  });
}

function bindBudget() {
  const input = document.getElementById('budget-input');
  const saved = localStorage.getItem('monthly_budget');
  if (saved && input) input.value = saved;

  document.getElementById('save-budget')?.addEventListener('click', async () => {
    const val = parseFloat(input?.value || 0);
    if (isNaN(val) || val < 0) { toast('Invalid budget amount', 'warning'); return; }
    localStorage.setItem('monthly_budget', val);
    const data = await apiGet('/costs/summary').catch(() => null);
    if (data) updateBudgetProgress(data.summary?.total_cost || 0, val);
    toast('Budget saved', 'success');
  });
}

function updateBudgetProgress(current, budget) {
  const pct = budget > 0 ? Math.min(100, (current / budget) * 100) : 0;
  const fill = document.getElementById('budget-fill');
  const label = document.getElementById('budget-label');
  const warn = document.getElementById('budget-warning');

  if (fill) {
    fill.style.width = pct + '%';
    fill.className = 'progress-fill' + (pct >= 100 ? ' danger' : pct >= 80 ? ' warning' : '');
  }
  if (label) label.textContent = `$${current.toFixed(2)} / $${budget.toFixed(2)} (${pct.toFixed(0)}%)`;
  if (warn) warn.style.display = pct >= 80 ? '' : 'none';
}
