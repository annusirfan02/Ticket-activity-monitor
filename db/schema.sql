-- ============================================================
-- Employee Activity Monitor — Supabase Schema
-- Run this in Supabase → SQL Editor → New Query → Run
-- ============================================================

-- ── Monitored agents (managed from the dashboard, not env) ──
create table if not exists agents (
  id          bigint generated always as identity primary key,
  email       text unique not null,
  name        text,
  active      boolean default true,
  created_at  timestamptz default now()
);

-- ── Custom statuses to track, and which agents they apply to ──
create table if not exists tracked_statuses (
  id          bigint generated always as identity primary key,
  label       text not null,          -- e.g. "Waiting on GHL Developer Team"
  choice_id   integer,                -- Freshdesk status choice id (optional)
  created_at  timestamptz default now()
);

-- Many-to-many: which agents each status applies to
create table if not exists status_agents (
  status_id   bigint references tracked_statuses(id) on delete cascade,
  agent_email text not null,
  primary key (status_id, agent_email)
);

-- ── Daily per-agent ticket stats (one row per agent per window-day) ──
create table if not exists daily_stats (
  id              bigint generated always as identity primary key,
  agent_email     text not null,
  stat_date       date not null,        -- the window start date
  window_start    timestamptz,
  new_tickets     integer default 0,
  resolved        integer default 0,
  closed          integer default 0,
  avg_response_min numeric default 0,   -- avg response time (minutes)
  first_reply_min  numeric default 0,   -- avg first reply time (minutes)
  response_due     integer default 0,   -- tickets with first/next response due
  custom_counts   jsonb default '{}',   -- { "status label": count }
  updated_at      timestamptz default now(),
  unique (agent_email, stat_date)
);

-- ── Break compliance log (off-schedule breaks) ──
create table if not exists break_log (
  id              bigint generated always as identity primary key,
  agent_email     text not null,
  agent_name      text,
  log_date        date not null,
  pressed_at      timestamptz,
  scheduled_start timestamptz,
  late_min        integer,
  created_at      timestamptz default now()
);

-- ── Overdue response tickets — PERSISTENT log, never auto-reset ──
-- Each ticket that goes past first/next response due is recorded here.
-- When a response finally goes out, replied_at is filled in.
create table if not exists overdue_tickets (
  id              bigint generated always as identity primary key,
  ticket_id       bigint not null,
  agent_email     text not null,
  agent_name      text,
  subject         text,
  ticket_url      text,
  response_due_at timestamptz,          -- when response was due
  first_flagged_at timestamptz default now(), -- when we first detected overdue
  replied_at      timestamptz,          -- filled when response finally sent (else NULL)
  notified_48h    boolean default false,-- whether 48h Slack alert was sent
  month_key       text,                 -- e.g. "2026-06" for monthly archiving
  unique (ticket_id)
);

-- ── Monthly archive marker (so we know what was reset when) ──
create table if not exists monthly_archives (
  id          bigint generated always as identity primary key,
  month_key   text unique not null,     -- "2026-06"
  archived_at timestamptz default now(),
  summary     jsonb                     -- snapshot of stats at archive time
);

-- ── Helpful indexes ──
create index if not exists idx_daily_stats_email   on daily_stats(agent_email);
create index if not exists idx_daily_stats_date    on daily_stats(stat_date);
create index if not exists idx_overdue_email       on overdue_tickets(agent_email);
create index if not exists idx_overdue_replied     on overdue_tickets(replied_at);
create index if not exists idx_overdue_month       on overdue_tickets(month_key);
create index if not exists idx_break_log_email     on break_log(agent_email);
create index if not exists idx_break_log_date      on break_log(log_date);

-- ── Late shift log (persistent, monthly) ──
-- One row per agent per day they clocked in late vs their scheduled shift start.
create table if not exists late_shifts (
  id              bigint generated always as identity primary key,
  agent_email     text not null,
  agent_name      text,
  log_date        date not null,
  month_key       text not null,        -- "2026-06"
  scheduled_start timestamptz,
  actual_start    timestamptz,          -- first activity / clock-in
  late_min        integer,
  created_at      timestamptz default now(),
  unique (agent_email, log_date)
);

-- ── Idle periods during shift (persistent, for reporting) ──
-- One row per idle episode: agent went inactive past the threshold while on
-- shift (and not on break). idle_start = last activity before going idle;
-- idle_end / idle_min extend as the episode continues across polls.
create table if not exists idle_log (
  id              bigint generated always as identity primary key,
  agent_email     text not null,
  agent_name      text,
  log_date        date not null,
  month_key       text not null,        -- "2026-06"
  idle_start      timestamptz not null, -- last activity before idle began
  idle_end        timestamptz,          -- most recent poll while still idle
  idle_min        integer,              -- duration so far (minutes)
  created_at      timestamptz default now(),
  unique (agent_email, idle_start)
);
create index if not exists idx_idle_email on idle_log(agent_email);
create index if not exists idx_idle_month on idle_log(month_key);

-- ── Daily SLA counts (response-due only) ──
-- Tracks first/next response SLA breaches per agent per day.
create table if not exists sla_daily (
  id              bigint generated always as identity primary key,
  agent_email     text not null,
  stat_date       date not null,
  month_key       text not null,
  total_due       integer default 0,    -- tickets that had a response due
  breached        integer default 0,    -- response due missed (overdue)
  updated_at      timestamptz default now(),
  unique (agent_email, stat_date)
);

-- ── Report flag thresholds (editable from dashboard) ──
create table if not exists report_thresholds (
  id              bigint generated always as identity primary key,
  metric          text unique not null, -- 'late_shifts','off_breaks','avg_response','sla_breach_pct'
  green_max       numeric,              -- <= green_max  => green
  yellow_max      numeric,              -- <= yellow_max => yellow, else red
  updated_at      timestamptz default now()
);

-- ── Generated monthly reports (stored, downloadable anytime) ──
create table if not exists monthly_reports (
  id              bigint generated always as identity primary key,
  month_key       text not null,
  agent_email     text not null,
  agent_name      text,
  generated_at    timestamptz default now(),
  payload         jsonb,                -- computed report data (weeks, totals, flags)
  unique (month_key, agent_email)
);

create index if not exists idx_late_email   on late_shifts(agent_email);
create index if not exists idx_late_month    on late_shifts(month_key);
create index if not exists idx_sla_email      on sla_daily(agent_email);
create index if not exists idx_sla_month      on sla_daily(month_key);
create index if not exists idx_reports_month  on monthly_reports(month_key);
