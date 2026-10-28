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
  yellow_max      numeric,              -- <= yellow_max => yellow, else red (older format)
  updated_at      timestamptz default now()
);
-- Current format: {"green":{"min":0,"max":5},"yellow":{"min":5,"max":15},"red":{"min":15,"max":null}}
-- (null = no limit). When set it replaces green_max / yellow_max.
alter table report_thresholds add column if not exists ranges jsonb;

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

-- ── Daily per-agent stats split by the ticket's Freshdesk group ──
-- Collected by the same poll as daily_stats, from the same tickets. Times are
-- stored as sum + count so they average correctly across agents and days.
-- group_id 0 = ticket has no group.
create table if not exists group_daily_stats (
  id              bigint generated always as identity primary key,
  agent_email     text not null,
  group_id        bigint not null,
  group_name      text,
  stat_date       date not null,        -- same window-start date as daily_stats
  new_tickets     integer default 0,
  resolved        integer default 0,
  closed          integer default 0,
  resp_sum_min    numeric default 0,
  resp_count      integer default 0,
  fr_sum_min      numeric default 0,
  fr_count        integer default 0,
  sla_due         integer default 0,
  sla_breached    integer default 0,
  overdue         integer default 0,    -- waiting on a reply past OVERDUE_AFTER_HOURS
  updated_at      timestamptz default now(),
  unique (agent_email, group_id, stat_date)
);
create index if not exists idx_group_stats_date  on group_daily_stats(stat_date);
create index if not exists idx_group_stats_group on group_daily_stats(group_id);

-- ── Rostered shifts with no clock-in and no leave (possible absences) ──
-- Logged by the poll once a shift has ended; see api/attendance.js for the rule.
create table if not exists missed_shifts (
  id              bigint generated always as identity primary key,
  agent_email     text not null,
  agent_name      text,
  log_date        date not null,        -- date of the scheduled start in DISPLAY_TZ
  month_key       text not null,
  scheduled_start timestamptz not null,
  scheduled_end   timestamptz,
  created_at      timestamptz default now(),
  unique (agent_email, scheduled_start)
);
create index if not exists idx_missed_date on missed_shifts(log_date);

-- ── Empathy check for resolved/closed tickets (rule-based, see api/empathy.js) ──
-- One row per ticket; re-checked if the ticket is resolved again later.
create table if not exists empathy_checks (
  ticket_id       bigint primary key,
  agent_email     text not null,        -- ticket's assigned agent
  agent_name      text,
  subject         text,
  ticket_url      text,
  status          integer,              -- 4 resolved, 5 closed
  resolved_at     timestamptz,
  resolved_date   date,                 -- in DISPLAY_TZ, for date-range filters
  frustrated      integer default 0,    -- customer messages showing frustration
  acknowledged    integer default 0,    -- ...answered with an empathy phrase
  missing         integer default 0,    -- ...answered without one
  findings        jsonb default '[]',   -- [{cue, excerpt, customer_at, reply_at, reply_excerpt}]
  checked_at      timestamptz default now()
);
create index if not exists idx_empathy_date  on empathy_checks(resolved_date);
create index if not exists idx_empathy_agent on empathy_checks(agent_email);

-- Claude review (scheduled routine, scripts/empathy-review/) on top of the quick check.
-- review_source: 'quick' = only the rule-based check so far; 'claude' = reviewed.
alter table empathy_checks add column if not exists review_source      text default 'quick';
alter table empathy_checks add column if not exists summary            text;
alter table empathy_checks add column if not exists ai_upset           boolean;
alter table empathy_checks add column if not exists ai_empathy_missing boolean;
alter table empathy_checks add column if not exists ai_reason          text;
alter table empathy_checks add column if not exists ai_evidence        jsonb;   -- [{customer, agent}] short quotes
alter table empathy_checks add column if not exists reviewed_at        timestamptz;
alter table empathy_checks add column if not exists reviewed_model     text;
create index if not exists idx_empathy_review on empathy_checks(review_source);
-- ticket's Freshdesk group (0 = none), for the Group PDF
alter table empathy_checks add column if not exists group_id bigint;
-- flagged tickets only (Claude review): how frustrated the customer was (1–5),
-- how well the agent handled it overall (1–5) and what would have helped
alter table empathy_checks add column if not exists ai_frustration smallint;
alter table empathy_checks add column if not exists ai_handling    smallint;
alter table empathy_checks add column if not exists ai_coaching    text;

-- ── SOP check: was a resolved ticket handled the way the agency's SOP says? ──
-- Claude routine (scripts/sop-review/) reads the agency SOP in Notion. One row
-- per ticket. verdict: 'no_sop' (agency has no SOP), 'not_covered' (SOP says
-- nothing about this topic), 'followed', 'incorrect' (flagged).
-- review_source: 'claude' = reviewed; 'recheck' = queued for a re-review.
create table if not exists sop_checks (
  ticket_id       bigint primary key,
  agent_email     text not null,
  agent_name      text,
  subject         text,
  ticket_url      text,
  group_id        bigint,
  resolved_at     timestamptz,
  resolved_date   date,                 -- in DISPLAY_TZ
  relationship_id text,                 -- agency, e.g. 0-116-776
  review_source   text default 'claude',
  verdict         text,
  topic           text,                 -- what the ticket was about
  sop_title       text,
  sop_url         text,
  sop_rule        text,                 -- what the SOP says for this topic
  agent_action    text,                 -- what the agent did instead (incorrect only)
  summary         text,
  reason          text,
  reviewed_at     timestamptz,
  reviewed_model  text
);
create index if not exists idx_sop_date  on sop_checks(resolved_date);
create index if not exists idx_sop_agent on sop_checks(agent_email);

-- ── Reply times: one row per agent reply that answered a waiting customer ──
-- (api/responses.js). wait_start = the customer's first unanswered message;
-- wait_working_min counts only the replying agent's rostered shifts.
create table if not exists response_events (
  ticket_id         bigint not null,
  replied_at        timestamptz not null,
  agent_email       text not null,
  wait_start        timestamptz not null,
  wait_calendar_min numeric,
  wait_working_min  numeric,            -- null if shifts couldn't be read yet
  is_first          boolean default false, -- the ticket's first agent reply
  group_id          bigint,
  reply_date        date,               -- in DISPLAY_TZ
  primary key (ticket_id, replied_at)
);
create index if not exists idx_resp_date  on response_events(reply_date);
create index if not exists idx_resp_agent on response_events(agent_email);

-- ── Hourly open-ticket snapshots (Hourly tab) ──
-- Once per hour the poll records how many tickets in Freshdesk's Open status
-- each agent has. snapshot_hour is the hour (UTC, truncated); taken_at is when
-- the count was read (within a few minutes after the hour).
create table if not exists open_snapshots (
  agent_email   text not null,
  snapshot_hour timestamptz not null,
  open_count    integer not null,
  taken_at      timestamptz default now(),
  primary key (agent_email, snapshot_hour)
);

-- ── Agent activity: latest own reply/note per agent, on any ticket ──
-- ticket_scan remembers which ticket version was already read, so each
-- ticket's conversations are fetched only after it changes.
create table if not exists ticket_scan (
  ticket_id       bigint primary key,
  updated_at      timestamptz,          -- ticket updated_at when last read
  scanned_at      timestamptz default now()
);
create table if not exists agent_last_activity (
  agent_email     text primary key,
  last_at         timestamptz not null, -- agent's latest reply or private note
  ticket_id       bigint,
  kind            text,                 -- 'reply' | 'note'
  updated_at      timestamptz default now()
);

create index if not exists idx_late_email   on late_shifts(agent_email);
create index if not exists idx_late_month    on late_shifts(month_key);
create index if not exists idx_sla_email      on sla_daily(agent_email);
create index if not exists idx_sla_month      on sla_daily(month_key);
create index if not exists idx_reports_month  on monthly_reports(month_key);
