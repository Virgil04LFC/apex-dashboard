import express from 'express';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createHmac, timingSafeEqual } from 'crypto';
import { getTenantBySubdomain, upsertTenant, listTenants, verifyPin } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app  = express();
const PORT = process.env.PORT || 3000;

const ADMIN_SECRET   = process.env.ADMIN_SECRET;
const DEFAULT_TENANT = process.env.DEFAULT_TENANT || '';

const GHL_BASE      = 'https://services.leadconnectorhq.com';
const GHL_VERSION   = '2021-07-28';
const TAG_REVIEW    = 'review-request-sent';
const SMS_ALERT_PCT = 0.8;

app.use(express.json());

// ── Tenant middleware ─────────────────────────────────────────────────────────
function resolveTenant(req, res, next) {
  const host = (req.headers.host || '').toLowerCase();
  let subdomain = '';
  const customMatch = host.match(/^([a-z0-9-]+)\.clientflowapp\.uk$/);
  if (customMatch) {
    subdomain = customMatch[1];
  } else if (DEFAULT_TENANT) {
    subdomain = DEFAULT_TENANT;
  }
  if (!subdomain) {
    return res.status(404).json({ error: 'Unknown tenant.' });
  }
  const tenant = getTenantBySubdomain(subdomain);
  if (!tenant) {
    return res.status(404).json({ error: `No active tenant for subdomain: ${subdomain}` });
  }
  req.tenant = tenant;
  next();
}

// ── Admin auth middleware ─────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (!ADMIN_SECRET) return res.status(503).json({ error: 'ADMIN_SECRET not set.' });
  if (req.headers.authorization !== `Bearer ${ADMIN_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorised.' });
  }
  next();
}

// ── Portal: session token helpers (stateless HMAC, 24h TTL) ──────────────────
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

function issueToken(locationId) {
  const expiry  = Date.now() + TOKEN_TTL_MS;
  const payload = `${locationId}:${expiry}`;
  const sig     = createHmac('sha256', ADMIN_SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}:${sig}`).toString('base64url');
}

function verifyToken(token) {
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const lastColon       = decoded.lastIndexOf(':');
    const secondLastColon = decoded.lastIndexOf(':', lastColon - 1);
    if (lastColon < 0 || secondLastColon < 0) return null;
    const locationId = decoded.slice(0, secondLastColon);
    const expiry     = decoded.slice(secondLastColon + 1, lastColon);
    const sig        = decoded.slice(lastColon + 1);
    if (Date.now() > parseInt(expiry, 10)) return null;
    const expected = createHmac('sha256', ADMIN_SECRET)
      .update(`${locationId}:${expiry}`).digest('hex');
    const a = Buffer.from(sig, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return locationId;
  } catch { return null; }
}

function requirePortalAuth(req, res, next) {
  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const locationId = verifyToken(token);
  if (!locationId) {
    return res.status(401).json({ error: 'Session expired. Please enter your PIN.' });
  }
  req.portalLocationId = locationId;
  next();
}

// ── GHL helper ────────────────────────────────────────────────────────────────
async function ghl(path, tenant, opts = {}) {
  const res = await fetch(`${GHL_BASE}${path}`, {
    ...opts,
    headers: {
      Authorization:  `Bearer ${tenant.ghl_token}`,
      Version:        GHL_VERSION,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`GHL ${res.status} on ${path}: ${await res.text()}`);
  return res.json();
}

// ── Dashboard API: tenant config ──────────────────────────────────────────────
app.get('/api/config', resolveTenant, (req, res) => {
  const { ghl_token, ghl_token_enc, portal_pin_hash, ...safe } = req.tenant;
  res.json(safe);
});

// ── Dashboard API: private feedback ──────────────────────────────────────────
app.get('/api/feedback', resolveTenant, async (req, res) => {
  const tenant = req.tenant;
  try {
    const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
    const data  = await ghl(
      `/surveys/submissions?locationId=${tenant.location_id}&surveyId=${tenant.survey_id}&limit=${limit}`,
      tenant,
    );
    const rows = (data.submissions || []).map(sub => {
      const others    = sub.others || {};
      const rawRating = others[tenant.field_key_rating] ?? others[`contact.${tenant.field_key_rating}`];
      const rating    = rawRating != null ? parseInt(rawRating, 10) : null;
      const feedback  = others[tenant.field_key_feedback]
        ?? others[`contact.${tenant.field_key_feedback}`] ?? '';
      return {
        contactId: sub.contactId || null,
        name:      sub.name || sub.others?.name || 'Unknown',
        email:     sub.email || '',
        rating,
        feedback,
        date: sub.createdAt || null,
      };
    }).filter(r => r.rating !== null);
    res.json({ rows, total: rows.length });
  } catch (err) {
    console.error(`[${tenant.subdomain}] feedback error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Dashboard API: SMS count ──────────────────────────────────────────────────
app.get('/api/sms-count', resolveTenant, async (req, res) => {
  const tenant = req.tenant;
  try {
    const now        = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const monthEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999).getTime();
    const monthLabel = now.toLocaleString('en-IE', { month: 'long', year: 'numeric' });

    let page = 1, sent = 0, hasMore = true;
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
        const t = new Date(c.dateUpdated).getTime();
        if (t >= monthStart && t <= monthEnd) sent++;
      }
      const allOlder = contacts.every(c => new Date(c.dateUpdated).getTime() < monthStart);
      hasMore = contacts.length === 100 && !allOlder;
      page++;
    }

    const cap     = tenant.sms_monthly_cap;
    const isAlert = sent / cap >= SMS_ALERT_PCT;
    res.json({ sent, cap, alertPct: SMS_ALERT_PCT * 100, isAlert,
               pct: Math.round((sent / cap) * 100), monthLabel });
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
app.post('/admin/tenants', requireAdmin, (req, res) => {
  const required = ['location_id', 'subdomain', 'business_name', 'survey_id',
                    'field_key_rating', 'field_key_feedback', 'ghl_token'];
  const missing  = required.filter(f => !req.body[f]);
  if (missing.length) {
    return res.status(422).json({ error: `Missing fields: ${missing.join(', ')}` });
  }
  try {
    const created = upsertTenant(req.body);
    const { ghl_token, ghl_token_enc, portal_pin_hash, ...safe } = created;
    res.status(201).json({ tenant: safe });
  } catch (err) {
    console.error('upsertTenant error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Portal: public tenant info (no auth — just name for PIN screen) ───────────
app.get('/api/portal/tenant-info', resolveTenant, (req, res) => {
  res.json({
    business_name: req.tenant.business_name,
    has_pin:       !!req.tenant.portal_pin_hash,
  });
});

// ── Portal: PIN auth ──────────────────────────────────────────────────────────
app.post('/api/portal/auth', resolveTenant, (req, res) => {
  const { pin } = req.body;
  if (!pin) return res.status(400).json({ error: 'PIN required.' });
  if (!req.tenant.portal_pin_hash) {
    return res.status(503).json({ error: 'Portal not yet configured. Contact ClientFlow.' });
  }
  if (!verifyPin(pin, req.tenant.portal_pin_hash)) {
    return res.status(401).json({ error: 'Incorrect PIN.' });
  }
  res.json({ token: issueToken(req.tenant.location_id), expires_in: TOKEN_TTL_MS });
});

// ── Portal: full config (auth required) ──────────────────────────────────────
app.get('/api/portal/config', requirePortalAuth, (req, res) => {
  const row = listTenants().find(t => t.location_id === req.portalLocationId);
  if (!row) return res.status(404).json({ error: 'Tenant not found.' });
  const tenant = getTenantBySubdomain(row.subdomain);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found.' });
  res.json({
    business_name:   tenant.business_name,
    form_url:        tenant.form_id
      ? `https://link.msgsndr.com/widget/form/${tenant.form_id}` : '',
    gbp_connected:   !!tenant.gbp_link,
    reputation_url:  tenant.reputation_url || '',
    sms_monthly_cap: tenant.sms_monthly_cap,
  });
});

// ── Portal: serve PWA ─────────────────────────────────────────────────────────
app.get('/portal', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'portal', 'index.html'));
});
app.get('/portal/sw.js', (req, res) => {
  res.setHeader('Service-Worker-Allowed', '/');
  res.sendFile(join(__dirname, 'public', 'portal', 'sw.js'));
});

// ── Static frontend ───────────────────────────────────────────────────────────
app.use(express.static(join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`ClientFlow Dashboard running on port ${PORT}`);
  console.log(`Default tenant: ${DEFAULT_TENANT || '(none — subdomain required)'}`);
});
