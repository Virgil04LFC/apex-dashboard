// ── ClientFlow Dealer Portal ─────────────────────────────────────────────────
// PIN-gated PWA. Token stored in sessionStorage (24h TTL).
// Tenant resolved server-side from subdomain.

const SESSION_KEY = 'cf_portal_token';

// ── Register service worker (PWA requirement) ────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/portal/sw.js', { scope: '/' }).catch(() => {});
}

// ── Detect install context ───────────────────────────────────────────────────
const isStandalone =
  window.matchMedia('(display-mode: standalone)').matches ||
  window.navigator.standalone === true;

const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const isAndroid = /android/i.test(navigator.userAgent);
const isSafariBrowser = /safari/i.test(navigator.userAgent) &&
  !/chrome|crios|fxios/i.test(navigator.userAgent);

let deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstallPrompt = e;
});

// ── PIN state ────────────────────────────────────────────────────────────────
let pinBuffer = '';
const PIN_LENGTH = 4;

function updateDots() {
  const dots = document.querySelectorAll('#pin-dots span');
  dots.forEach((d, i) => {
    d.classList.toggle('filled', i < pinBuffer.length);
  });
}

function shakeAndClear() {
  const dotsEl = document.getElementById('pin-dots');
  dotsEl.classList.add('shake');
  dotsEl.addEventListener('animationend', () => dotsEl.classList.remove('shake'), { once: true });
  pinBuffer = '';
  updateDots();
}

function showPinError(msg) {
  const el = document.getElementById('pin-error');
  el.textContent = msg;
  el.hidden = false;
}

function hidePinError() {
  document.getElementById('pin-error').hidden = true;
}

// ── Screens ──────────────────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => {
    s.classList.remove('active');
    s.style.removeProperty('display'); // clear inline style so CSS display:none takes over
  });
  document.getElementById(id).classList.add('active'); // CSS .screen.active { display: flex }
}

// ── API helpers ──────────────────────────────────────────────────────────────
async function apiFetch(path, opts = {}) {
  const token = sessionStorage.getItem(SESSION_KEY);
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, { ...opts, headers });
  return { res, data: await res.json() };
}

// ── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  // Load business name for PIN screen (no auth needed)
  try {
    const { res, data } = await apiFetch('/api/portal/tenant-info');
    if (res.ok) {
      document.getElementById('pin-business-name').textContent = data.business_name;
    }
  } catch {}

  // Check for existing valid token
  const token = sessionStorage.getItem(SESSION_KEY);
  if (token) {
    const ok = await tryLoadPortal(token);
    if (ok) return;
    sessionStorage.removeItem(SESSION_KEY);
  }

  showScreen('screen-pin');
}

// ── Submit PIN ────────────────────────────────────────────────────────────────
async function submitPin() {
  hidePinError();
  try {
    const { res, data } = await apiFetch('/api/portal/auth', {
      method: 'POST',
      body: JSON.stringify({ pin: pinBuffer }),
    });
    if (res.ok) {
      sessionStorage.setItem(SESSION_KEY, data.token);
      pinBuffer = '';
      updateDots();
      const loaded = await tryLoadPortal(data.token);
      if (!loaded) showPinError('Failed to load portal. Try again.');
    } else {
      showPinError(data.error || 'Incorrect PIN.');
      shakeAndClear();
    }
  } catch {
    showPinError('Network error. Check your connection.');
    shakeAndClear();
  }
}

// ── Load portal after auth ────────────────────────────────────────────────────
async function tryLoadPortal(token) {
  try {
    const res  = await fetch('/api/portal/config', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return false;
    const cfg = await res.json();
    renderPortal(cfg);
    showScreen('screen-portal');
    maybeShowInstallBanner();
    return true;
  } catch { return false; }
}

function renderPortal(cfg) {
  // Header business name
  document.getElementById('portal-business-name').textContent = cfg.business_name;

  // Button 1: Send Review Request
  const btnForm = document.getElementById('btn-form');
  if (cfg.form_url) {
    btnForm.href = cfg.form_url;
  } else {
    btnForm.style.opacity = '0.5';
    btnForm.removeAttribute('href');
    btnForm.querySelector('.btn-label').textContent = 'Review Form (not configured)';
  }

  // Button 2: View Dashboard — link to the current origin's root (the dashboard)
  document.getElementById('btn-dashboard').href = '/';

  // Button 3: Manage Reviews
  if (cfg.gbp_connected && cfg.reputation_url) {
    document.getElementById('btn-reviews-connected').style.display = 'flex';
    document.getElementById('btn-reviews-link').href = cfg.reputation_url;
  } else if (cfg.gbp_connected && !cfg.reputation_url) {
    // GBP connected but no reputation URL set yet — show generic GHL link
    document.getElementById('btn-reviews-connected').style.display = 'flex';
    document.getElementById('btn-reviews-link').href = 'https://app.gohighlevel.com';
  } else {
    document.getElementById('btn-reviews-pending').style.display = 'flex';
  }
}

// ── Keypad ────────────────────────────────────────────────────────────────────
document.querySelectorAll('.key[data-digit]').forEach(btn => {
  btn.addEventListener('click', () => {
    if (pinBuffer.length >= PIN_LENGTH) return;
    hidePinError();
    pinBuffer += btn.dataset.digit;
    updateDots();
    if (pinBuffer.length === PIN_LENGTH) submitPin();
  });
});

document.getElementById('key-back').addEventListener('click', () => {
  pinBuffer = pinBuffer.slice(0, -1);
  updateDots();
  hidePinError();
});

// ── Install banner ────────────────────────────────────────────────────────────
function maybeShowInstallBanner() {
  if (isStandalone) return;                        // already installed
  if (sessionStorage.getItem('cf_install_dismissed')) return;

  const banner = document.getElementById('install-banner');

  if (isIOS && isSafariBrowser) {
    // iOS Safari: guide user to share sheet
    document.getElementById('install-instructions').innerHTML =
      'Tap the <strong>Share</strong> button ↑ then <strong>Add to Home Screen</strong>';
    document.getElementById('install-arrow-ios').hidden = false;
    banner.hidden = false;
  } else if (deferredInstallPrompt) {
    // Android Chrome: native prompt available
    document.getElementById('install-instructions').textContent =
      'Tap to add ClientFlow to your home screen';
    banner.hidden = false;
    // Tapping the banner triggers native prompt
    banner.addEventListener('click', async e => {
      if (e.target.id === 'install-dismiss') return;
      deferredInstallPrompt.prompt();
      const { outcome } = await deferredInstallPrompt.userChoice;
      if (outcome === 'accepted') banner.hidden = true;
      deferredInstallPrompt = null;
    });
  }
  // No banner for: already-installed, or browsers without prompt support
}

document.getElementById('install-dismiss').addEventListener('click', () => {
  document.getElementById('install-banner').hidden = true;
  sessionStorage.setItem('cf_install_dismissed', '1');
});

// ── Start ─────────────────────────────────────────────────────────────────────
init();
