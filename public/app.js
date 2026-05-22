// ── Apex Motors Review Dashboard ────────────────────────────────────────────
// Fetches from /api/feedback and /api/sms-count (Express proxy to GHL).
// Auto-refreshes every 5 minutes.

const REFRESH_MS = 5 * 60 * 1000;

// ── Helpers ──────────────────────────────────────────────────────────────────
function stars(rating, max = 5) {
  if (rating === null || rating === undefined) return '—';
  const n = Math.max(0, Math.min(max, Math.round(rating)));
  return Array.from({ length: max }, (_, i) =>
    `<span class="star${i < n ? ' on' : ''}">★</span>`
  ).join('');
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-IE', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

function setLastUpdated() {
  const el = document.getElementById('last-updated');
  if (el) {
    el.textContent = 'Updated ' + new Date().toLocaleTimeString('en-IE', {
      hour: '2-digit', minute: '2-digit',
    });
  }
}

// ── Widget 3: SMS counter ────────────────────────────────────────────────────
async function loadSmsCount() {
  try {
    const r    = await fetch('/api/sms-count');
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Server error');

    document.getElementById('sms-sent').textContent        = data.sent;
    document.getElementById('sms-cap').textContent         = data.cap;
    document.getElementById('sms-month-label').textContent = data.monthLabel;

    const bar = document.getElementById('sms-bar');
    bar.style.width = Math.min(data.pct, 100) + '%';
    bar.classList.remove('warn', 'alert');
    if (data.pct >= 100)      bar.classList.add('alert');
    else if (data.isAlert)    bar.classList.add('warn');

    const alertEl = document.getElementById('sms-alert');
    alertEl.hidden = !data.isAlert;
  } catch (err) {
    console.error('sms-count failed:', err);
    document.getElementById('sms-sent').textContent        = '—';
    document.getElementById('sms-month-label').textContent = 'Error loading data';
  }
}

// ── Widget 1: Private Feedback ───────────────────────────────────────────────
async function loadFeedback() {
  const stateEl = document.getElementById('feedback-state');
  const tableEl = document.getElementById('feedback-table');
  const bodyEl  = document.getElementById('feedback-body');

  stateEl.innerHTML = '<p class="loading">Loading…</p>';
  tableEl.hidden    = true;

  try {
    const r    = await fetch('/api/feedback?limit=20');
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Server error');

    if (!data.rows || data.rows.length === 0) {
      stateEl.innerHTML = `
        <div class="empty-state">
          <div class="icon">📬</div>
          <p>No private feedback yet.<br>Submissions will appear here once customers respond.</p>
        </div>`;
      return;
    }

    // Populate table
    bodyEl.innerHTML = data.rows.map(row => `
      <tr>
        <td class="td-name">${esc(row.name)}</td>
        <td class="td-rating">
          <span class="stars">${stars(row.rating)}</span>
        </td>
        <td class="td-feedback">${esc(row.feedback || '—')}</td>
        <td class="td-date">${formatDate(row.date)}</td>
      </tr>
    `).join('');

    stateEl.innerHTML = '';
    tableEl.hidden    = false;
  } catch (err) {
    console.error('feedback failed:', err);
    stateEl.innerHTML = `<div class="error-state">⚠️ Could not load feedback: ${esc(err.message)}</div>`;
  }
}

// Safe HTML escape
function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Init & auto-refresh ──────────────────────────────────────────────────────
async function refresh() {
  await Promise.all([loadSmsCount(), loadFeedback()]);
  setLastUpdated();
}

refresh();
setInterval(refresh, REFRESH_MS);
