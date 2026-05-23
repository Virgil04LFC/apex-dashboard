# Deploy Runbook — Multi-Tenant Dashboard (v2)

## One-time setup (first deploy only)

### 1. Create the Fly.io persistent volume
From your Mac terminal, in the repo directory:
```bash
flyctl volumes create dashboard_data --region fra --size 1
```
(1 GB is more than enough — SQLite for 500 dealers is kilobytes.)

### 2. Set Fly secrets
Run this once (substituting the real values):
```bash
flyctl secrets set \
  DB_ENCRYPTION_KEY="f9616fd1c0892bc1ea5eede174604bcd5f3ff55659cd01a3d4b07e220c3eb2d6" \
  ADMIN_SECRET="k4Vgl9XIBybRY9BsOGDQAIYqpcu1jNwT" \
  GHL_TOKEN="" \
  LOCATION_ID="" \
  SURVEY_ID=""
```

⚠️ GHL_TOKEN, LOCATION_ID, SURVEY_ID are now UNUSED by the app (config comes from DB).
   Set them to empty strings or omit them — they're no longer needed as secrets.
   The DB_ENCRYPTION_KEY and ADMIN_SECRET are the two critical secrets.

⚠️ SAVE the DB_ENCRYPTION_KEY and ADMIN_SECRET somewhere safe (1Password / notes).
   If DB_ENCRYPTION_KEY is lost, all stored tokens are unrecoverable.

### 3. Deploy
```bash
cd ~/apex-dashboard
git pull
flyctl deploy --remote-only
```

### 4. Seed Apex as tenant #1 (dashboard + portal)
After deploy, run this curl from your Mac:
```bash
curl -s -X POST https://apex-reviews-dash.fly.dev/admin/tenants \
  -H "Authorization: Bearer k4Vgl9XIBybRY9BsOGDQAIYqpcu1jNwT" \
  -H "Content-Type: application/json" \
  -d '{
    "location_id":        "WqqCMnmsoIF1BZY8iWt5",
    "subdomain":          "apex",
    "business_name":      "Apex Motors",
    "survey_id":          "JfibjKzc2dKhEmvfwDG5",
    "field_key_rating":   "rating_rat584_how_would_you_rate_your_experience",
    "field_key_feedback": "or_if_youd_prefer_to_tell_us_privately_leave_a_message_here",
    "gbp_link":           "https://g.page/r/CQsUFFgVqljMEAE/review",
    "alert_email":        "liamoflanagan@gmail.com",
    "ai_tone":            "",
    "sms_monthly_cap":    50,
    "ghl_token":          "PASTE_APEX_TOKEN_HERE",
    "form_id":            "NYPZtAhKVQwX8FIqXaAP",
    "reputation_url":     "https://app.gohighlevel.com/v2/location/WqqCMnmsoIF1BZY8iWt5/reputation",
    "portal_pin":         "0000"
  }'
```
Replace `PASTE_APEX_TOKEN_HERE` with: pit-bd707132-1838-41e3-bda3-ffe50a3a06b5

The `portal_pin` field is the dealer's 4-digit PIN (plaintext — hashed before storage).
For testing use `"0000"` now; swap to Terry's real PIN before handover.

Expected response:
```json
{ "tenant": { "location_id": "WqqCMnmsoIF1BZY8iWt5", "subdomain": "apex", ... } }
```

### 5. Verify
```bash
# Should return Apex's data (same as before the refactor)
curl https://apex-reviews-dash.fly.dev/api/config
curl https://apex-reviews-dash.fly.dev/api/sms-count
curl https://apex-reviews-dash.fly.dev/api/feedback
```

---

## Regular deploys (after first setup)

```bash
cd ~/apex-dashboard
git pull
flyctl deploy --remote-only
```
Secrets and volume persist across deploys — no re-seeding needed.

---

## Adding a new dealer (Step 2 — onboarding script will automate this)

Manual method until the onboarding script is built:
```bash
curl -s -X POST https://apex-reviews-dash.fly.dev/admin/tenants \
  -H "Authorization: Bearer k4Vgl9XIBybRY9BsOGDQAIYqpcu1jNwT" \
  -H "Content-Type: application/json" \
  -d '{
    "location_id":        "GHL_LOCATION_ID",
    "subdomain":          "dealername",
    "business_name":      "Dealer Name",
    "survey_id":          "SURVEY_ID_FROM_GHL",
    "field_key_rating":   "rating_rat584_how_would_you_rate_your_experience",
    "field_key_feedback": "or_if_youd_prefer_to_tell_us_privately_leave_a_message_here",
    "gbp_link":           "https://g.page/r/...",
    "alert_email":        "dealer@example.com",
    "sms_monthly_cap":    50,
    "ghl_token":          "pit-..."
  }'
```

Their dashboard is then live at: `https://dealername.clientflowapp.uk`
(once DNS CNAME for `dealername.clientflowapp.uk` → `apex-reviews-dash.fly.dev` is added,
and the custom domain added in Fly: `flyctl certs add dealername.clientflowapp.uk`)

---

## List all tenants
```bash
curl -s https://apex-reviews-dash.fly.dev/admin/tenants \
  -H "Authorization: Bearer k4Vgl9XIBybRY9BsOGDQAIYqpcu1jNwT"
```

---

## Monthly running cost estimate
- Fly shared-cpu-1x + 256MB RAM: ~$3/mo (or free on Hobby plan)
- Fly volume 1GB: ~$0.15/mo
- SQLite: $0 (on-volume)
- **Total: ~$3.15/mo regardless of dealer count** (single app, single volume)
- Scale point: if traffic grows to need multiple machines, migrate DB to Turso (~$0/mo free tier) or Fly Postgres (~$7/mo). Not needed until meaningful concurrent load.
