import express from 'express';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getTenantBySubdomain, upsertTenant, listTenants } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app  = express();
const PORT = process.env.PORT || 3000;

// Admin secret for protected endpoints (set as Fly secret: ADMIN_SECRET)
const ADMIN_SECRET   = process.env.ADMIN_SECRET;
// Fallback subdomain when no custom domain match (e.g. apex-reviews-dash.fly.dev → 'apex')
const DEFAULT_TENANT = process.env.DEFAULT_TENANT || '';

const GHL_BASE    = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';
const TAG_REVIEW  = 'review-request-sent';
const SMS_ALERT_PCT = 0.8;

app.use(express.json());

// ── Tenant middleware ─────────────────────────────────────────────────────────
/**
 * Resolves the requesting subdomain to a tenant row from the DB.
 * Resolution order:
 *   1. Subdomain from Host if it matches *.clientflowapp.uk
 *   2. DEFAULT_TENANT env var (covers legacy fly.dev URL and local dev)
 *
 * Attaches req.tenant on success; next(err) on failure.
 */
function resolveTenant(req, res, next) {
  const host = (req.headers.host || '').toLowerCase();

  // Match: {sub}.clientflowapp.uk
  let subdomain = '';
  const customMatch = host.match(/^([a-z0-9-]+)\.clientflowapp\.uk$/);
  if (customMatch) {
    subdomain = customMatch[1];
  } else if (DEFAULT_TENANT) {
    subdomain = DEFAULT_TENANT;
  }

  if (!subdomain) {
    return res.status(404).json({ error: 'Unknown tenant. No subdomain matched.' });
  }

  const tenant = getTenantBySubdomain(subdomain);
  if (!tenant) {
    return res.status(404).json({ error: `No active tenant found for subdomain: ${subdomain}` });
  }

  req.tenant = tenant;
  next();
}

// ── Admin auth middleware ─────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (!ADMIN_SECRET) {
    return res.status(503).json({ error: 'Admin endpoint not configured (ADMIN_SECRET not set).' });
  }
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${ADMIN_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorised.' });
  }
  next();
}

// ── GHL helper ─────────────────────────────────────────────────────────────
async function ghl(path, tenant, opts = {}) {
  const url = `${GHL_BASE}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization:  `Bearer ${tenant.ghl_token}`,
      Version:        GHL_VERSION,
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

// ── API: tenant config (safe — no token) ─────────────────────────────────────
app.get('/api/config', resolveTenant, (req, res) => {
  const { ghl_token, ghl_token_enc, ...safe } = req.tenant;
  res.json(safe);
});

// ── API: private feedback ─────────────────────────────────────────────────────
app.get('/api/feedback', resolveTenant, async (req, res) => {
  const tenant = req.tenant;
  try {
    const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
    const data  = await ghl(
      `/surveys/submissions?locationId=${tenant.location_id}&surveyId=${tenant.survey_id}&limit=${limit}`,
      tenant,
    );

    const rows = (data.submissions || []).map(sub => {
      const others     = sub.others || {};
      const rawRating  = others[tenant.field_key_rating] ?? others[`contact.${tenant.field_key_rating}`];
      const rating     = rawRating !== undefined && rawRating !== null
        ? parseInt(rawRating, 10) : null;
      const feedback   = others[tenant.field_key_feedback]
        ?? others[`contact.${tenant.field_key_feedback}`] ?? '';

      return {
        contactId: sub.contactId || null,
        name:      sub.name || sub.others?.name || 'Unknown',
        email:     sub.email || '',
        rating,
        feedback,
        date: sub.createdAt || null,
      };
    });

    const filtered = rows.filter(r => r.rating !== null);
    res.json({ rows: filtered, total: filtered.length });
  } catch (err) {
    console.error(`[${tenant.subdomain}] feedback error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── API: SMS count ────────────────────────────────────────────────────────────
app.get('/api/sms-count', resolveTenant, async (req, res) => {
  const tenant = req.tenant;
  try {
    const now        = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const monthEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999).getTime();
    const monthLabel = now.toLocaleString('en-IE', { month: 'long', year: 'numeric' });

    let page = 1;
    let sent = 0;
    let hasMore = true;

    while (hasMore) {
      const data = await ghl('/contacts/search', tenant, {
        method: 'POST',
        body: JSON.stringify({
          locationId: tenant.location_id,
          filters: [{ field: 'tags', operator: 'contains', value: TAG_REVIEW }],
          pageLimit: 100,
          page,
        }),
      });

      const contacts = data.contacts || [];
      for (const c of contacts) {
        const updated = new Date(c.dateUpdated).getTime();
        if (updated >= monthStart && updated <= monthEnd) sent++;
      }

      const allOlder = contacts.every(c => new Date(c.dateUpdated).getTime() < monthStart);
      hasMore = contacts.length === 100 && !allOlder;
      page++;
    }

    const cap     = tenant.sms_monthly_cap;
    const isAlert = sent / cap >= SMS_ALERT_PCT;

    res.json({
      sent,
      cap,
      alertPct:   SMS_ALERT_PCT * 100,
      isAlert,
      pct:        Math.round((sent / cap) * 100),
      monthLabel,
    });
  } catch (err) {
    console.error(`[${tenant.subdomain}] sms-count error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: list tenants ───────────────────────────────────────────────────────
app.get('/admin/tenants', requireAdmin, (req, res) => {
  res.json({ tenants: listTenants() });
});

// ── Admin: upsert tenant ──────────────────────────────────────────────────────
/**
 * POST /admin/tenants
 * Body (JSON): all tenant fields including ghl_token (plaintext — encrypted by db.js).
 * Required: location_id, subdomain, business_name, survey_id,
 *           field_key_rating, field_key_feedback, ghl_token
 * Optional: gbp_link, alert_email, ai_tone, sms_monthly_cap, active
 */
app.post('/admin/tenants', requireAdmin, (req, res) => {
  const required = ['location_id', 'subdomain', 'business_name', 'survey_id',
                    'field_key_rating', 'field_key_feedback', 'ghl_token'];
  const missing  = required.filter(f => !req.body[f]);
  if (missing.length) {
    return res.status(422).json({ error: `Missing required fields: ${missing.join(', ')}` });
  }

  try {
    const created = upsertTenant(req.body);
    // Return safe view (no token)
    const { ghl_token, ghl_token_enc, ...safe } = created;
    res.status(201).json({ tenant: safe });
  } catch (err) {
    console.error('upsertTenant error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Static frontend ───────────────────────────────────────────────────────────
app.use(express.static(join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`ClientFlow Dashboard running on port ${PORT}`);
  console.log(`Default tenant: ${DEFAULT_TENANT || '(none — subdomain required)'}`);
});
