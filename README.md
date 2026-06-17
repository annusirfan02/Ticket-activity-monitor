# 🟢 Employee Activity Monitor — Full Version
Freshdesk + Deputy + Slack + Supabase. Persistent records, manageable from the dashboard.

## What it does
- Tracks only the agents you add (managed in dashboard, no env editing)
- Deputy shift-aware; tracking pauses ONLY when the live break button is pressed
- Flags off-schedule breaks (wrong time)
- Per-agent ticket stats: new, resolved, closed, avg response, first reply, response-due count
- Custom Freshdesk statuses you define + assign to specific agents (e.g. "Waiting on GHL Developer Team")
- Persistent overdue-response log: every ticket past first/next response due, with "X days/hours since no response"; replied ones show a Replied timestamp, unreplied stay empty
- Slack alert when any ticket hits 48h without response
- Monthly records preserved in DB (view anytime)

---

## 🚀 Setup

### 1. Create Supabase project (free)
1. supabase.com → New Project
2. SQL Editor → paste contents of `db/schema.sql` → Run
3. Settings → API → copy **Project URL** and **service_role key**

### 2. Push to GitHub & import on Vercel
Framework: Other → Deploy

### 3. Environment Variables (Vercel → Settings)
| Variable | Value |
|---|---|
| `FRESHDESK_DOMAIN` | yourcompany.freshdesk.com |
| `FRESHDESK_API_KEY` | Freshdesk → Profile → API Key |
| `DEPUTY_DOMAIN` | yourcompany.na.deputy.com |
| `DEPUTY_ACCESS_TOKEN` | Deputy → Integrations → API token |
| `SLACK_WEBHOOK_URL` | Slack incoming webhook |
| `SUPABASE_URL` | from Supabase Settings → API |
| `SUPABASE_SERVICE_KEY` | service_role key (keep secret!) |
| `INACTIVITY_THRESHOLD_MINUTES` | 30 |
| `POLL_INTERVAL_MINUTES` | 5 |
| `BREAK_GRACE_MINUTES` | 15 |
| `DISPLAY_TZ` | America/Los_Angeles |
| `ADMIN_EMAIL` | Annus@mycrmsupport.com |
| `ADMIN_PASSWORD` | **change after deploy** |
| `CRON_SECRET` | any random string |

### 4. Redeploy ✅

---

## 🔐 SECURITY — change your password
`ADMIN_PASSWORD` was set during setup and shared in chat. After first login, change it in
Vercel env vars and redeploy. The `service_role` key bypasses DB security — never expose it client-side (it stays server-only here).

---

## 📊 Using the Dashboard

**Manage Agents** — add agents by email (must match Deputy email). Pause/resume/remove anytime.

**Manage Statuses** — add a Freshdesk status name (and optional choice ID), then tick which agents it applies to. That status count then appears per-agent in Ticket Stats. Example: add "Waiting on GHL Developer Team", assign to your dev-facing agents.

**Overdue Tickets** — switch agent from the dropdown to see their overdue tickets. Each row shows the ticket # (clickable to your Freshdesk), how long since no response, and a Replied timestamp once answered (empty if still no reply). This log is persistent — it does not reset.

**Ticket Stats** — 24h window starting at each agent's shift start; resets next day at shift start.

---

## 🗄️ Data & Monthly Reset
All stats, breaks, and overdue tickets live in Supabase. The live dashboard view resets each
window, but the database keeps full history. At month end you can archive/reset the live
counts while the `overdue_tickets` and `daily_stats` tables retain everything for later review.

## 📅 Off-Days, Weekends & PTO (stats still tracked)
Stats are tracked **every day**, even when an agent has no shift (weekend, day off, PTO).

- The 24h stats window normally anchors to the agent's **shift start** that day.
- On a day with **no shift in Deputy**, the app uses the agent's **normal shift time-of-day**, auto-detected from their last ~21 days of rosters (e.g. an agent who usually starts at 4 AM gets a 4 AM window even on Saturday).
- This means when you view **Last 7 Days**, tickets created on weekends/off-days are counted too — no empty rows.
- On off-days, **inactivity and break alerts are OFF** (the agent isn't working), but ticket stats (new/resolved/closed/response times) keep recording.
- Off-day agents show an **"OFF DAY (tracking)"** badge in Live Status.

## ⚠️ Note on A2P / response-due fields
Response-due detection uses Freshdesk's `fr_due_by` / `nr_due_by` (requires SLA policies set
in Freshdesk). If your account uses different SLA setup, tweak the due-field logic in
`api/index.js` (search "response due / overdue").

## 📄 Monthly PDF Reports

**Generate:** Reports tab → pick month → tick which sections to include → Generate. Each agent's report is computed and stored in the DB.

**Auto-generate:** On the 1st of each month, the cron auto-generates the previous month's reports (once). They sit in the DB ready to download anytime.

**Download:** Reports tab → Load → click ⬇ PDF next to any agent.

**What's in each PDF:**
- Top Concerns banner (auto from red-flag metrics)
- Month summary with color flags (green/yellow/red) + team-average comparison
- Weekly breakdown table (new / resolved / closed / avg response / first reply / SLA %)
- Late shift detail (which days, how many minutes late)
- Off-schedule break detail
- Custom statuses (A2P, GHL Dev Team, etc.)

**Sections are checkbox-selectable** before generating.

### Flag thresholds (editable)
Reports tab → Flag Thresholds table. Each metric: green ≤ X, yellow ≤ Y, else red.
Defaults: late shifts (1/3), off-breaks (1/3), avg response (15/30 min), SLA breach (5%/15%).
**Top Concerns** = any metric in the red zone.

### Late shift tracking
Logged persistently per agent per day when their first activity starts more than
`LATE_GRACE_MINUTES` (default 5) after their scheduled shift start. Monthly totals appear
in the report. New env var: `LATE_GRACE_MINUTES`.

### Response SLA
Uses Freshdesk's response-due fields only (first response / next response due).
**Resolution SLA is intentionally excluded** per requirement. Breach % = missed ÷ total-due.

## 🔭 Kumospace
Skipped for now — Kumospace has no public API; data only via manual CSV export from their
legacy analytics. Can be added later as a CSV upload import.

## ⚠️ Database update
This version adds new tables. Re-run `db/schema.sql` in Supabase (it uses
`create table if not exists`, so existing tables are untouched and new ones are added).
