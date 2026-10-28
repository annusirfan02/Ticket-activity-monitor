// api/db.js — Supabase data layer
const { createClient } = require('@supabase/supabase-js');

let supabase = null;
function db() {
  if (!supabase) {
    supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY, // service role key (server-side only)
      { auth: { persistSession: false } }
    );
  }
  return supabase;
}

// ─────────────────────────────────────────────────────────────
// AGENTS
// ─────────────────────────────────────────────────────────────
async function getAgents() {
  const { data, error } = await db().from('agents').select('*').order('name');
  if (error) throw new Error('getAgents: ' + error.message);
  return data || [];
}

async function getActiveAgentEmails() {
  const { data, error } = await db().from('agents').select('email').eq('active', true);
  if (error) throw new Error('getActiveAgentEmails: ' + error.message);
  return (data || []).map(a => a.email.toLowerCase().trim());
}

async function addAgent(email, name) {
  const { data, error } = await db()
    .from('agents')
    .upsert({ email: email.toLowerCase().trim(), name, active: true }, { onConflict: 'email' })
    .select();
  if (error) throw new Error('addAgent: ' + error.message);
  return data?.[0];
}

async function removeAgent(email) {
  const { error } = await db().from('agents').delete().eq('email', email.toLowerCase().trim());
  if (error) throw new Error('removeAgent: ' + error.message);
}

async function setAgentActive(email, active) {
  const { error } = await db().from('agents').update({ active }).eq('email', email.toLowerCase().trim());
  if (error) throw new Error('setAgentActive: ' + error.message);
}

// ─────────────────────────────────────────────────────────────
// TRACKED STATUSES
// ─────────────────────────────────────────────────────────────
async function getStatuses() {
  const { data, error } = await db().from('tracked_statuses').select('*').order('created_at');
  if (error) throw new Error('getStatuses: ' + error.message);
  // attach agent lists
  const statuses = data || [];
  for (const s of statuses) {
    const { data: links } = await db().from('status_agents').select('agent_email').eq('status_id', s.id);
    s.agents = (links || []).map(l => l.agent_email);
  }
  return statuses;
}

async function addStatus(label, choiceId, agentEmails) {
  const { data, error } = await db()
    .from('tracked_statuses')
    .insert({ label, choice_id: choiceId || null })
    .select();
  if (error) throw new Error('addStatus: ' + error.message);
  const status = data[0];
  if (agentEmails?.length) {
    const rows = agentEmails.map(e => ({ status_id: status.id, agent_email: e.toLowerCase().trim() }));
    const { error: e2 } = await db().from('status_agents').insert(rows);
    if (e2) throw new Error('addStatus links: ' + e2.message);
  }
  return status;
}

async function updateStatusAgents(statusId, agentEmails) {
  await db().from('status_agents').delete().eq('status_id', statusId);
  if (agentEmails?.length) {
    const rows = agentEmails.map(e => ({ status_id: statusId, agent_email: e.toLowerCase().trim() }));
    const { error } = await db().from('status_agents').insert(rows);
    if (error) throw new Error('updateStatusAgents: ' + error.message);
  }
}

async function removeStatus(statusId) {
  const { error } = await db().from('tracked_statuses').delete().eq('id', statusId);
  if (error) throw new Error('removeStatus: ' + error.message);
}

// ─────────────────────────────────────────────────────────────
// DAILY STATS
// ─────────────────────────────────────────────────────────────
async function upsertDailyStats(row) {
  const { error } = await db()
    .from('daily_stats')
    .upsert(row, { onConflict: 'agent_email,stat_date' });
  if (error) throw new Error('upsertDailyStats: ' + error.message);
}

async function getDailyStats(statDate) {
  const { data, error } = await db().from('daily_stats').select('*').eq('stat_date', statDate);
  if (error) throw new Error('getDailyStats: ' + error.message);
  return data || [];
}

// ─────────────────────────────────────────────────────────────
// BREAK LOG
// ─────────────────────────────────────────────────────────────
async function addBreakLog(row) {
  // avoid duplicates: same agent + pressed_at within same minute
  const { data: existing } = await db()
    .from('break_log')
    .select('id')
    .eq('agent_email', row.agent_email)
    .eq('log_date', row.log_date)
    .gte('pressed_at', new Date(new Date(row.pressed_at).getTime() - 60000).toISOString())
    .lte('pressed_at', new Date(new Date(row.pressed_at).getTime() + 60000).toISOString());
  if (existing?.length) return;
  const { error } = await db().from('break_log').insert(row);
  if (error) throw new Error('addBreakLog: ' + error.message);
}

async function getBreakLog(logDate) {
  const { data, error } = await db().from('break_log').select('*').eq('log_date', logDate).order('pressed_at');
  if (error) throw new Error('getBreakLog: ' + error.message);
  return data || [];
}

async function getBreakLogRange(fromDate, toDate) {
  const { data, error } = await db().from('break_log')
    .select('*').gte('log_date', fromDate).lte('log_date', toDate).order('log_date', { ascending: false });
  if (error) throw new Error('getBreakLogRange: ' + error.message);
  return data || [];
}

// HISTORY: daily stats by date / range
async function getStatsByDate(statDate) {
  const { data, error } = await db().from('daily_stats').select('*').eq('stat_date', statDate).order('agent_email');
  if (error) throw new Error('getStatsByDate: ' + error.message);
  return data || [];
}

async function getStatsRange(fromDate, toDate, agentEmail = null) {
  let q = db().from('daily_stats').select('*')
    .gte('stat_date', fromDate).lte('stat_date', toDate)
    .order('stat_date', { ascending: true });
  if (agentEmail) q = q.eq('agent_email', agentEmail.toLowerCase().trim());
  const { data, error } = await q;
  if (error) throw new Error('getStatsRange: ' + error.message);
  return data || [];
}

// ─────────────────────────────────────────────────────────────
// OVERDUE TICKETS  (persistent — never auto-reset)
// ─────────────────────────────────────────────────────────────

// Insert or update an overdue ticket record
async function upsertOverdue(row) {
  const { error } = await db()
    .from('overdue_tickets')
    .upsert(row, { onConflict: 'ticket_id' });
  if (error) throw new Error('upsertOverdue: ' + error.message);
}

// Mark a ticket as replied (response finally went out)
async function markReplied(ticketId, repliedAt) {
  const { error } = await db()
    .from('overdue_tickets')
    .update({ replied_at: repliedAt })
    .eq('ticket_id', ticketId)
    .is('replied_at', null);
  if (error) throw new Error('markReplied: ' + error.message);
}

// Remove a stale/false overdue row (e.g. closed with no response owed)
async function deleteOverdue(ticketId) {
  const { error } = await db()
    .from('overdue_tickets')
    .delete()
    .eq('ticket_id', ticketId);
  if (error) throw new Error('deleteOverdue: ' + error.message);
}

// Mark 48h notified
async function mark48hNotified(ticketId) {
  const { error } = await db()
    .from('overdue_tickets')
    .update({ notified_48h: true })
    .eq('ticket_id', ticketId);
  if (error) throw new Error('mark48hNotified: ' + error.message);
}

// Get all overdue tickets for an agent (or all)
async function getOverdue({ agentEmail = null, monthKey = null, onlyUnreplied = false } = {}) {
  let q = db().from('overdue_tickets').select('*').order('response_due_at', { ascending: true });
  if (agentEmail) q = q.eq('agent_email', agentEmail.toLowerCase().trim());
  if (monthKey)   q = q.eq('month_key', monthKey);
  if (onlyUnreplied) q = q.is('replied_at', null);
  const { data, error } = await q;
  if (error) throw new Error('getOverdue: ' + error.message);
  return data || [];
}

// Tickets that crossed 48h and not yet notified
async function getUnnotified48h() {
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const { data, error } = await db()
    .from('overdue_tickets')
    .select('*')
    .is('replied_at', null)
    .eq('notified_48h', false)
    .lte('response_due_at', cutoff);
  if (error) throw new Error('getUnnotified48h: ' + error.message);
  return data || [];
}

// ─────────────────────────────────────────────────────────────
// MONTHLY ARCHIVE
// ─────────────────────────────────────────────────────────────
async function archiveMonth(monthKey, summary) {
  const { error } = await db()
    .from('monthly_archives')
    .upsert({ month_key: monthKey, summary, archived_at: new Date().toISOString() }, { onConflict: 'month_key' });
  if (error) throw new Error('archiveMonth: ' + error.message);
}

async function getArchives() {
  const { data, error } = await db().from('monthly_archives').select('*').order('month_key', { ascending: false });
  if (error) throw new Error('getArchives: ' + error.message);
  return data || [];
}


// ── LATE SHIFTS ──
async function logLateShift(row) {
  // one row per agent per day, holding the current clock-in result (the clock-in
  // doesn't change, so the latest value is the right one)
  const { error } = await db().from('late_shifts').upsert(row, { onConflict: 'agent_email,log_date' });
  if (error) throw new Error('logLateShift: ' + error.message);
}
async function deleteLateShift(agentEmail, logDate) {
  const { error } = await db().from('late_shifts').delete().eq('agent_email', agentEmail).eq('log_date', logDate);
  if (error) throw new Error('deleteLateShift: ' + error.message);
}
async function getLateShifts(monthKey, agentEmail = null) {
  let q = db().from('late_shifts').select('*').eq('month_key', monthKey).order('log_date', { ascending: true });
  if (agentEmail) q = q.eq('agent_email', agentEmail.toLowerCase().trim());
  const { data, error } = await q;
  if (error) throw new Error('getLateShifts: ' + error.message);
  return data || [];
}
async function getLateShiftsRange(fromDate, toDate, agentEmail = null) {
  let q = db().from('late_shifts').select('*').gte('log_date', fromDate).lte('log_date', toDate).order('log_date', { ascending: true });
  if (agentEmail) q = q.eq('agent_email', agentEmail.toLowerCase().trim());
  const { data, error } = await q;
  if (error) throw new Error('getLateShiftsRange: ' + error.message);
  return data || [];
}

// ── IDLE LOG (inactive periods during shift) ──
// Upsert keyed on (agent_email, idle_start): the same episode extends its
// idle_end / idle_min on each poll; a new lastSeen starts a fresh episode.
async function upsertIdleLog(row) {
  const { error } = await db().from('idle_log').upsert(row, { onConflict: 'agent_email,idle_start' });
  if (error) throw new Error('upsertIdleLog: ' + error.message);
}
async function getIdleLog(logDate, agentEmail = null) {
  let q = db().from('idle_log').select('*').eq('log_date', logDate).order('idle_start', { ascending: true });
  if (agentEmail) q = q.eq('agent_email', agentEmail.toLowerCase().trim());
  const { data, error } = await q;
  if (error) throw new Error('getIdleLog: ' + error.message);
  return data || [];
}
async function getIdleRange(monthKey, agentEmail = null) {
  let q = db().from('idle_log').select('*').eq('month_key', monthKey).order('idle_start', { ascending: true });
  if (agentEmail) q = q.eq('agent_email', agentEmail.toLowerCase().trim());
  const { data, error } = await q;
  if (error) throw new Error('getIdleRange: ' + error.message);
  return data || [];
}

// ── SLA DAILY (response-due) ──
async function upsertSlaDaily(row) {
  const { error } = await db().from('sla_daily').upsert(row, { onConflict: 'agent_email,stat_date' });
  if (error) throw new Error('upsertSlaDaily: ' + error.message);
}
async function getSlaRange(fromDate, toDate, agentEmail = null) {
  let q = db().from('sla_daily').select('*').gte('stat_date', fromDate).lte('stat_date', toDate).order('stat_date');
  if (agentEmail) q = q.eq('agent_email', agentEmail.toLowerCase().trim());
  const { data, error } = await q;
  if (error) throw new Error('getSlaRange: ' + error.message);
  return data || [];
}

// ── MISSED SHIFTS (rostered, no clock-in, no leave) ──
async function upsertMissedShift(row) {
  const { error } = await db().from('missed_shifts').upsert(row, { onConflict: 'agent_email,scheduled_start' });
  if (error) throw new Error('upsertMissedShift: ' + error.message);
}
// Drop rows for shifts that turned out to be worked or covered by leave.
async function deleteMissedShift(agentEmail, scheduledStartIso) {
  const { error } = await db().from('missed_shifts').delete().eq('agent_email', agentEmail).eq('scheduled_start', scheduledStartIso);
  if (error) throw new Error('deleteMissedShift: ' + error.message);
}
async function getMissedShiftsRange(fromDate, toDate) {
  const { data, error } = await db().from('missed_shifts').select('*')
    .gte('log_date', fromDate).lte('log_date', toDate).order('scheduled_start', { ascending: true });
  // reports still work before the table is created
  if (error) { if (/schema cache|does not exist/.test(error.message)) return []; throw new Error('getMissedShiftsRange: ' + error.message); }
  return data || [];
}

// ── RESPONSE EVENTS (one row per agent reply that answered a waiting customer) ──
// onlyNew: insert replies not stored yet and leave existing rows untouched
async function upsertResponseEvents(rows, { onlyNew = false } = {}) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db().from('response_events').upsert(rows.slice(i, i + 500), { onConflict: 'ticket_id,replied_at', ignoreDuplicates: onlyNew });
    if (error) throw new Error('upsertResponseEvents: ' + error.message);
  }
}
async function pagedResponseEvents(build) {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(db().from('response_events').select('*')).order('replied_at').range(from, from + 999);
    if (error) throw new Error('responseEvents: ' + error.message);
    all.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return all;
}
// replies dated (DISPLAY_TZ) within an inclusive date range
const getResponseEventsRange = (fromDate, toDate) =>
  pagedResponseEvents(q => q.gte('reply_date', fromDate).lte('reply_date', toDate));
// replies sent at or after a timestamp
const getResponseEventsSince = (iso) => pagedResponseEvents(q => q.gte('replied_at', iso));
// replies whose working-hours time couldn't be calculated yet (Deputy unavailable), max 200
async function getResponseEventsMissingWorking() {
  const { data, error } = await db().from('response_events').select('*').is('wait_working_min', null).limit(200);
  if (error) throw new Error('getResponseEventsMissingWorking: ' + error.message);
  return data || [];
}

// ── OPEN-TICKET SNAPSHOTS (agent's tickets in Open status, once per hour) ──
async function getOpenSnapshotEmails(snapshotHourIso) {
  const { data, error } = await db().from('open_snapshots').select('agent_email').eq('snapshot_hour', snapshotHourIso);
  if (error) throw new Error('getOpenSnapshotEmails: ' + error.message);
  return new Set((data || []).map(r => r.agent_email));
}
async function upsertOpenSnapshots(rows) {
  if (!rows.length) return;
  const { error } = await db().from('open_snapshots').upsert(rows, { onConflict: 'agent_email,snapshot_hour' });
  if (error) throw new Error('upsertOpenSnapshots: ' + error.message);
}
async function getOpenSnapshots(agentEmail, fromIso, toIso) {
  const { data, error } = await db().from('open_snapshots').select('*').eq('agent_email', agentEmail)
    .gte('snapshot_hour', fromIso).lte('snapshot_hour', toIso).order('snapshot_hour');
  if (error) throw new Error('getOpenSnapshots: ' + error.message);
  return data || [];
}
// idle episodes of one agent overlapping [fromIso, toIso]
async function getIdleOverlapping(agentEmail, fromIso, toIso) {
  const { data, error } = await db().from('idle_log').select('*').eq('agent_email', agentEmail.toLowerCase().trim())
    .lt('idle_start', toIso).gt('idle_end', fromIso).order('idle_start');
  if (error) throw new Error('getIdleOverlapping: ' + error.message);
  return data || [];
}
// one agent's replies sent in [fromIso, toIso]
async function getAgentResponseEvents(agentEmail, fromIso, toIso) {
  const { data, error } = await db().from('response_events').select('*').eq('agent_email', agentEmail)
    .gte('replied_at', fromIso).lte('replied_at', toIso).order('replied_at');
  if (error) throw new Error('getAgentResponseEvents: ' + error.message);
  return data || [];
}

// ── AGENT ACTIVITY (own replies/notes) ──
// ticket_id -> updated_at (ms) at the time its conversations were last read
async function getTicketScans(ticketIds) {
  const out = {};
  for (let i = 0; i < ticketIds.length; i += 200) {
    const { data, error } = await db().from('ticket_scan').select('ticket_id,updated_at').in('ticket_id', ticketIds.slice(i, i + 200));
    if (error) throw new Error('getTicketScans: ' + error.message);
    for (const r of data || []) out[r.ticket_id] = Date.parse(r.updated_at);
  }
  return out;
}
async function upsertTicketScans(rows) {
  const { error } = await db().from('ticket_scan').upsert(rows, { onConflict: 'ticket_id' });
  if (error) throw new Error('upsertTicketScans: ' + error.message);
}
// agent_email -> latest own reply/note (ms)
async function getAgentActivity() {
  const { data, error } = await db().from('agent_last_activity').select('agent_email,last_at');
  if (error) throw new Error('getAgentActivity: ' + error.message);
  const out = {}; for (const r of data || []) out[r.agent_email] = Date.parse(r.last_at);
  return out;
}
async function upsertAgentActivity(rows) {
  const { error } = await db().from('agent_last_activity').upsert(rows, { onConflict: 'agent_email' });
  if (error) throw new Error('upsertAgentActivity: ' + error.message);
}

// ── EMPATHY CHECKS (one row per resolved/closed ticket) ──
// ticket_id -> resolved_at (ms) for the given tickets, to skip ones already checked.
async function getEmpathyResolvedAt(ticketIds) {
  const out = {};
  for (let i = 0; i < ticketIds.length; i += 200) {
    const { data, error } = await db().from('empathy_checks').select('ticket_id,resolved_at').in('ticket_id', ticketIds.slice(i, i + 200));
    if (error) throw new Error('getEmpathyResolvedAt: ' + error.message);
    for (const r of data || []) out[r.ticket_id] = Date.parse(r.resolved_at);
  }
  return out;
}
async function upsertEmpathyCheck(row) {
  const { error } = await db().from('empathy_checks').upsert(row, { onConflict: 'ticket_id' });
  if (error) throw new Error('upsertEmpathyCheck: ' + error.message);
}
async function getEmpathyRange(fromDate, toDate) {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db().from('empathy_checks').select('*')
      .gte('resolved_date', fromDate).lte('resolved_date', toDate).order('resolved_at', { ascending: false }).range(from, from + 999);
    if (error) throw new Error('getEmpathyRange: ' + error.message);
    all.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return all;
}

// ── SOP CHECKS (Claude review against the agency SOP, scripts/sop-review/) ──
async function getSopRange(fromDate, toDate) {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db().from('sop_checks').select('*').eq('review_source', 'claude')
      .gte('resolved_date', fromDate).lte('resolved_date', toDate).order('resolved_at', { ascending: false }).range(from, from + 999);
    if (error) throw new Error('getSopRange: ' + error.message);
    all.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return all;
}

// ── GROUP DAILY STATS (per agent × ticket group × day) ──
// Replaces an agent's rows for one stat_date: upserts the groups present now and
// drops groups that no longer have tickets (e.g. a ticket moved to another group).
async function replaceGroupStats(agentEmail, statDate, rows) {
  if (rows.length) {
    const { error } = await db().from('group_daily_stats').upsert(rows, { onConflict: 'agent_email,group_id,stat_date' });
    if (error) throw new Error('replaceGroupStats upsert: ' + error.message);
  }
  let q = db().from('group_daily_stats').delete().eq('agent_email', agentEmail).eq('stat_date', statDate);
  if (rows.length) q = q.not('group_id', 'in', `(${rows.map(r => r.group_id).join(',')})`);
  const { error } = await q;
  if (error) throw new Error('replaceGroupStats delete: ' + error.message);
}
async function getGroupStatsRange(fromDate, toDate) {
  // page through: PostgREST caps a single response at 1000 rows
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db().from('group_daily_stats').select('*')
      .gte('stat_date', fromDate).lte('stat_date', toDate).order('id').range(from, from + 999);
    if (error) throw new Error('getGroupStatsRange: ' + error.message);
    all.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return all;
}

// ── THRESHOLDS ──
async function getThresholds() {
  const { data, error } = await db().from('report_thresholds').select('*');
  if (error) throw new Error('getThresholds: ' + error.message);
  return data || [];
}
async function setThreshold(metric, greenMax, yellowMax) {
  const { error } = await db().from('report_thresholds')
    .upsert({ metric, green_max: greenMax, yellow_max: yellowMax, updated_at: new Date().toISOString() }, { onConflict: 'metric' });
  if (error) throw new Error('setThreshold: ' + error.message);
}
// ranges = { green:{min,max}, yellow:{min,max}, red:{min,max} } (null = no limit)
async function setThresholdRanges(metric, ranges) {
  const { error } = await db().from('report_thresholds')
    .upsert({ metric, ranges, updated_at: new Date().toISOString() }, { onConflict: 'metric' });
  if (error) throw new Error('setThresholdRanges: ' + error.message);
}

// ── MONTHLY REPORTS ──
async function saveReport(monthKey, agentEmail, agentName, payload) {
  const { error } = await db().from('monthly_reports')
    .upsert({ month_key: monthKey, agent_email: agentEmail, agent_name: agentName, payload, generated_at: new Date().toISOString() }, { onConflict: 'month_key,agent_email' });
  if (error) throw new Error('saveReport: ' + error.message);
}
async function getReports(monthKey) {
  const { data, error } = await db().from('monthly_reports').select('*').eq('month_key', monthKey).order('agent_name');
  if (error) throw new Error('getReports: ' + error.message);
  return data || [];
}
async function getReportMonths() {
  const { data, error } = await db().from('monthly_reports').select('month_key').order('month_key', { ascending: false });
  if (error) throw new Error('getReportMonths: ' + error.message);
  return [...new Set((data||[]).map(r => r.month_key))];
}

module.exports = {
  db,
  getAgents, getActiveAgentEmails, addAgent, removeAgent, setAgentActive,
  getStatuses, addStatus, updateStatusAgents, removeStatus,
  upsertDailyStats, getDailyStats,
  addBreakLog, getBreakLog, getBreakLogRange,
  getStatsByDate, getStatsRange,
  upsertOverdue, markReplied, deleteOverdue, mark48hNotified, getOverdue, getUnnotified48h,
  archiveMonth, getArchives,
  logLateShift, deleteLateShift, getLateShifts, getLateShiftsRange,
  upsertIdleLog, getIdleLog, getIdleRange,
  upsertSlaDaily, getSlaRange,
  replaceGroupStats, getGroupStatsRange,
  upsertMissedShift, deleteMissedShift, getMissedShiftsRange,
  getEmpathyResolvedAt, upsertEmpathyCheck, getEmpathyRange, getSopRange,
  getTicketScans, upsertTicketScans, getAgentActivity, upsertAgentActivity,
  upsertResponseEvents, getResponseEventsRange, getResponseEventsSince, getResponseEventsMissingWorking,
  getOpenSnapshotEmails, upsertOpenSnapshots, getOpenSnapshots, getIdleOverlapping, getAgentResponseEvents,
  getThresholds, setThreshold, setThresholdRanges,
  saveReport, getReports, getReportMonths,
};
