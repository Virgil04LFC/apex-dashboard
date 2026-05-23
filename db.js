/**
 * db.js — Multi-tenant SQLite layer
 *
 * DB lives at /data/dashboard.db (Fly.io persistent volume).
 * ghl_token is encrypted at rest with AES-256-GCM.
 * DB_ENCRYPTION_KEY env var = 64-char hex (32 bytes).
 */

import Database from 'better-sqlite3';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';
import { mkdirSync } from 'fs';

const DB_DIR  = process.env.DB_DIR  || '/data';
const DB_PATH = process.env.DB_PATH || `${DB_DIR}/dashboard.db`;
const ENC_KEY = process.env.DB_ENCRYPTION_KEY;

// Ensure data directory exists (Fly volume may not pre-create subdirs)
try { mkdirSync(DB_DIR, { recursive: true }); } catch {}

if (!ENC_KEY || ENC_KEY.length !== 64) {
  console.error('FATAL: DB_ENCRYPTION_KEY must be a 64-char hex string (32 bytes).');
  process.exit(1);
}

const db = new Database(DB_PATH);

// WAL mode for safer concurrent reads
db.pragma('journal_mode = WAL');

// ── Schema ────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS tenants (
    location_id        TEXT PRIMARY KEY,
    subdomain          TEXT UNIQUE NOT NULL,
    business_name      TEXT NOT NULL,
    survey_id          TEXT NOT NULL,
    field_key_rating   TEXT NOT NULL,
    field_key_feedback TEXT NOT NULL,
    gbp_link           TEXT    DEFAULT '',
    alert_email        TEXT    DEFAULT '',
    ai_tone            TEXT    DEFAULT '',
    sms_monthly_cap    INTEGER DEFAULT 50,
    ghl_token_enc      TEXT    NOT NULL,
    active             INTEGER DEFAULT 1,
    created_at         TEXT    DEFAULT (datetime('now'))
  );
`);

// ── Migrations (idempotent) ───────────────────────────────────────────────────
// SQLite doesn't support IF NOT EXISTS on ALTER TABLE — check column list first.
{
  const cols = db.prepare('PRAGMA table_info(tenants)').all().map(c => c.name);
  if (!cols.includes('portal_pin_hash'))
    db.exec("ALTER TABLE tenants ADD COLUMN portal_pin_hash TEXT DEFAULT ''");
  if (!cols.includes('form_id'))
    db.exec("ALTER TABLE tenants ADD COLUMN form_id TEXT DEFAULT ''");
  if (!cols.includes('reputation_url'))
    db.exec("ALTER TABLE tenants ADD COLUMN reputation_url TEXT DEFAULT ''");
}

// ── Encryption (AES-256-GCM) ──────────────────────────────────────────────────
function encrypt(plaintext) {
  const key    = Buffer.from(ENC_KEY, 'hex');
  const iv     = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct     = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();
  // Stored as: ivHex:tagHex:ciphertextHex
  return `${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

function decrypt(stored) {
  const key              = Buffer.from(ENC_KEY, 'hex');
  const [ivHex, tagHex, ctHex] = stored.split(':');
  const iv               = Buffer.from(ivHex, 'hex');
  const tag              = Buffer.from(tagHex, 'hex');
  const ct               = Buffer.from(ctHex, 'hex');
  const decipher         = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ct) + decipher.final('utf8');
}

// ── Tenant queries ────────────────────────────────────────────────────────────

/** Return tenant by subdomain (active only), with decrypted token. */
export function getTenantBySubdomain(subdomain) {
  const row = db.prepare(
    'SELECT * FROM tenants WHERE subdomain = ? AND active = 1'
  ).get(subdomain.toLowerCase());
  if (!row) return null;
  return { ...row, ghl_token: decrypt(row.ghl_token_enc) };
}

/** Return tenant by GHL location ID (active only), with decrypted token. */
export function getTenantByLocationId(locationId) {
  const row = db.prepare(
    'SELECT * FROM tenants WHERE location_id = ? AND active = 1'
  ).get(locationId);
  if (!row) return null;
  return { ...row, ghl_token: decrypt(row.ghl_token_enc) };
}

/**
 * Insert or update a tenant row.
 * Pass ghl_token as plaintext — this function encrypts it before storing.
 */
export function upsertTenant({
  location_id, subdomain, business_name, survey_id,
  field_key_rating, field_key_feedback,
  gbp_link = '', alert_email = '', ai_tone = '',
  sms_monthly_cap = 50, ghl_token, active = 1,
  form_id = '', reputation_url = '',
  portal_pin,          // plaintext PIN — hashed here before storage
  portal_pin_hash,     // pre-hashed PIN (takes precedence if supplied)
}) {
  const ghl_token_enc   = encrypt(ghl_token);
  const pin_hash        = portal_pin_hash || (portal_pin ? hashPin(portal_pin) : '');
  db.prepare(`
    INSERT INTO tenants
      (location_id, subdomain, business_name, survey_id,
       field_key_rating, field_key_feedback, gbp_link, alert_email,
       ai_tone, sms_monthly_cap, ghl_token_enc, active,
       form_id, reputation_url, portal_pin_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(location_id) DO UPDATE SET
      subdomain          = excluded.subdomain,
      business_name      = excluded.business_name,
      survey_id          = excluded.survey_id,
      field_key_rating   = excluded.field_key_rating,
      field_key_feedback = excluded.field_key_feedback,
      gbp_link           = excluded.gbp_link,
      alert_email        = excluded.alert_email,
      ai_tone            = excluded.ai_tone,
      sms_monthly_cap    = excluded.sms_monthly_cap,
      ghl_token_enc      = excluded.ghl_token_enc,
      active             = excluded.active,
      form_id            = excluded.form_id,
      reputation_url     = excluded.reputation_url,
      portal_pin_hash    = CASE
        WHEN excluded.portal_pin_hash != '' THEN excluded.portal_pin_hash
        ELSE portal_pin_hash
      END
  `).run(
    location_id, subdomain.toLowerCase(), business_name, survey_id,
    field_key_rating, field_key_feedback, gbp_link, alert_email,
    ai_tone, sms_monthly_cap, ghl_token_enc, active ? 1 : 0,
    form_id, reputation_url, pin_hash,
  );
  return getTenantByLocationId(location_id);
}

// ── PIN helpers ────────────────────────────────────────────────────────────────────
export function hashPin(pin) {
  return createHash('sha256').update(String(pin).trim()).digest('hex');
}

export function verifyPin(pin, storedHash) {
  if (!storedHash) return false;
  return hashPin(pin) === storedHash;
}

/** List all tenants (safe — no tokens). */
export function listTenants() {
  return db.prepare(`
    SELECT location_id, subdomain, business_name, sms_monthly_cap, active, created_at
    FROM tenants ORDER BY created_at ASC
  `).all();
}
