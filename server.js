import express from 'express';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

// ── Config ─────────────────────────────────────────────────────────────────
const GHL_TOKEN   = process.env.GHL_TOKEN;
const LOCATION_ID = process.env.LOCATION_ID;
const GHL_BASE    = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';

// Survey IDs (set once per sub-account — update via env if it ever changes)
const SURVEY_ID = process.env.SURVEY_ID || 'JfibjKzc2dKhEmvfwDG5';

// Survey field keys (GHL uses contact.xxx keys; strip prefix for others lookup)
const FIELD_RATING   = 'rating_rat584_how_would_you_rate_your_experience';
const FIELD_FEEDBACK = 'or_if_youd_prefer_to_tell_us_privately_leave_a_message_here';

// Widget 3 config
const SMS_MONTHLY_CAP  = parseInt(process.env.SMS_CAP || '50', 10);
const SMS_ALERT_PCT    = 0.8;
const TAG_REVIEW       = 'review-request-sent';

if (!GHL_TOKEN || !LOCATION_ID) {
  console.error('Missing required env vars: GHL_TOKEN, LOCATION_ID');
  process.exit(1);
}

// ── GHL helper ─────────────────────────────────────────────────────────────
async function ghl(path, opts = {}) {
  const url = `${GHL_BASE}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${GHL_TOKEN}`,
      Version:       GHL_VERSION,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GHL ${res.status} on ${path}: ${body}`);
  }
  return res.json();
}

// ── API routes ──────────────────────────────────────────────────────────────

/**
 * GET /api/feedback
 * Returns the 20 most recent private feedback submissions.
 * Each row: { name, rating, feedback, date, contactId }
 */
app.get('/api/feedback', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
    const data  = await ghl(
      `/surveys/submissions?locationId=${LOCATION_ID}&surveyId=${SURVEY_ID}&limit=${limit}`
    );

    const rows = (data.submissions || []).map(sub => {
      const others   = sub.others || {};
      const rawRating = others[FIELD_RATING] ?? others[`contact.${FIELD_RATING}`];
      const rating    = rawRating !== undefined && rawRating !== null
        ? parseInt(rawRating, 10)
        : null;
      const feedback  = others[FIELD_FEEDBACK] ?? others[`contact.${FIELD_FEEDBACK}`] ?? '';

      return {
        contactId: sub.contactId || null,
        name:      sub.name || sub.others?.name || 'Unknown',
        email:     sub.email || '',
        rating,
        feedback,
        date: sub.createdAt || null,
      };
    });

    // Only return rows that have a rating (i.e., the customer completed the survey)
    const filtered = rows.filter(r => r.rating !== null);
    res.json({ rows: filtered, total: filtered.length });
  } catch (err) {
    console.error('feedback error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/sms-count
 * Counts contacts tagged review-request-sent with dateUpdated in the current
 * calendar month. Returns { sent, cap, alertPct, isAlert, monthLabel }.
 *
 * Note (v1): This counts unique contacts tagged this month. If a contact is
 * re-tagged (re-request) in the same month, dateUpdated updates and they
 * still count once. Good enough for v1 with a clean per-customer send model.
 * Phase 2: use monthly rotating tags (review-sent-YYYY-MM) for exact counts.
 */
app.get('/api/sms-count', async (req, res) => {
  try {
    const now          = new Date();
    const monthStart   = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const monthEnd     = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59).toISOString();
    const monthLabel   = now.toLocaleString('en-IE', { month: 'long', year: 'numeric' });

    // Search contacts tagged review-request-sent, updated this month
    const data = await ghl(`/contacts/search`, {
      method: 'POST',
      body: JSON.stringify({
        locationId: LOCATION_ID,
        filters: [
          { field: 'tags',        operator: 'contains',         value: TAG_REVIEW },
          { field: 'dateUpdated', operator: 'greater_than',     value: monthStart },
          { field: 'dateUpdated', operator: 'less_than_equal',  value: monthEnd   },
        ],
        pageLimit: 1, // We only need the total count
      }),
    });

    const sent     = data.total || 0;
    const isAlert  = sent / SMS_MONTHLY_CAP >= SMS_ALERT_PCT;

    res.json({
      sent,
      cap:        SMS_MONTHLY_CAP,
      alertPct:   SMS_ALERT_PCT * 100,
      isAlert,
      pct:        Math.round((sent / SMS_MONTHLY_CAP) * 100),
      monthLabel,
    });
  } catch (err) {
    console.error('sms-count error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Static frontend ─────────────────────────────────────────────────────────
app.use(express.static(join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Apex Dashboard running on port ${PORT}`);
  console.log(`Location: ${LOCATION_ID}`);
});
