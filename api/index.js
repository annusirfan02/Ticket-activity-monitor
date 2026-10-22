// api/index.js — Vercel Serverless Entry
// Freshdesk + Deputy + Slack + Supabase
require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const path    = require('path');
const crypto  = require('crypto');
const D        = require('./db');
const R        = require('./report');
const A        = require('./attendance');
const E        = require('./empathy');
const T        = require('./ticket-thread');
const Q        = require('./quality');
const RS       = require('./responses');
const HR       = require('./hourly');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── CONFIG ──
const THRESHOLD_MIN  = parseInt(process.env.INACTIVITY_THRESHOLD_MINUTES || 30);
const POLL_MIN       = parseInt(process.env.POLL_INTERVAL_MINUTES || 5);
const BREAK_GRACE_MIN= parseInt(process.env.BREAK_GRACE_MINUTES || 15);
const TZ             = process.env.DISPLAY_TZ || 'America/Los_Angeles';

const mem = {
  agentActivity: {},
  schedule: {}, schedAt: null,
  empIdByEmail: null,
  shiftWindowStart: {},
  normalShiftTimes: null, normalShiftAt: null,
  lastChecked: null,
  currentCounts: {},   // "fdAgentId:statusId" -> { count, at }
};
const SCHED_TTL = 30 * 60 * 1000;
const CURRENT_TTL = 3 * 60 * 1000;   // live status-count cache TTL
// A ticket is only logged as overdue once the customer has waited this long
// (measured from their last unanswered message), and the log shows actual elapsed.
const OVERDUE_MS = (parseInt(process.env.OVERDUE_AFTER_HOURS || 24)) * 3600000;
// Custom statuses whose label matches stay on the 24h window; all others show
// the agent's CURRENT total (live snapshot).
const WINDOWED_STATUS_RX = /a2p approval/i;
// Resolved/Closed already have their own columns — never show them as custom pills.
const CORE_STATUS_IDS = new Set([4, 5]);
// Tickets whose status label or a tag matches are ignored entirely: stats, SLA,
// activity and the overdue log.
const EXCLUDED_STATUS_RX = /archive/i;
// Matched case-insensitively on tickets; Freshdesk tag *search* is case-sensitive,
// so the cleanup sweep searches the listed spelling and its lowercase form.
const EXCLUDED_TAGS = ['Archive'];
const agentLabel = (choice) => Array.isArray(choice) ? String(choice[0]) : String(choice || '');
const hasExcludedTag = (t) => (t.tags || []).some(tag =>
  EXCLUDED_TAGS.some(x => x.toLowerCase() === String(tag).toLowerCase().trim()));

// ── FRESHDESK ──
const fdHeaders = () => ({
  Authorization: 'Basic ' + Buffer.from(`${process.env.FRESHDESK_API_KEY}:X`).toString('base64'),
  'Content-Type': 'application/json',
});
const fdBase    = () => `https://${process.env.FRESHDESK_DOMAIN}/api/v2`;
const ticketUrl = (id) => `https://${process.env.FRESHDESK_DOMAIN}/a/tickets/${id}`;

async function fdAgents() {
  const { data } = await axios.get(`${fdBase()}/agents?per_page=100`, { headers: fdHeaders() });
  return data;
}
async function fdTicketFields() {
  try {
    const { data } = await axios.get(`${fdBase()}/ticket_fields`, { headers: fdHeaders() });
    const sf = data.find(f => f.type === 'default_status');
    return sf?.choices || {};
  } catch { return {}; }
}
async function fdTicketsSince(sinceIso) {
  let page = 1, all = [];
  while (page <= 15) {
    const { data } = await axios.get(
      `${fdBase()}/tickets?updated_since=${sinceIso}&order_by=updated_at&order_type=desc&per_page=100&page=${page}&include=stats`,
      { headers: fdHeaders() }
    );
    if (!data.length) break;
    all = all.concat(data);
    if (data.length < 100) break;
    page++;
  }
  return all;
}

// Freshdesk group id -> name, cached (groups rarely change).
async function fdGroupNames() {
  if (mem.groupNames && Date.now() - mem.groupNamesAt < SCHED_TTL) return mem.groupNames;
  try {
    const names = {};
    for (let page = 1; page <= 5; page++) {
      const { data } = await axios.get(`${fdBase()}/groups?per_page=100&page=${page}`, { headers: fdHeaders() });
      for (const g of (data || [])) names[g.id] = g.name;
      if (!data || data.length < 100) break;
    }
    mem.groupNames = names; mem.groupNamesAt = Date.now();
  } catch (e) { console.warn('[FD] groups:', e.message); }
  return mem.groupNames || {};
}

// Current (live) count of an agent's tickets in a given status — cached briefly.
async function fdCountByStatus(agentId, statusId) {
  const key = `${agentId}:${statusId}`;
  const c = mem.currentCounts[key];
  if (c && Date.now() - c.at < CURRENT_TTL) return c.count;
  try {
    const q = encodeURIComponent(`"agent_id:${agentId} AND status:${statusId}"`);
    const { data } = await axios.get(`${fdBase()}/search/tickets?query=${q}`, { headers: fdHeaders() });
    const count = (data && typeof data.total === 'number') ? data.total : (data?.results?.length || 0);
    mem.currentCounts[key] = { count, at: Date.now() };
    return count;
  } catch (e) { console.warn('[FD] count', key, e.message); return c ? c.count : 0; }
}

// IDs of tickets currently in any of the given statuses or carrying any of the
// given tags (search API caps at 10 pages of 30).
async function fdTicketIdsExcluded(statusIds, tags) {
  const tagVariants = [...new Set(tags.flatMap(tag => [tag, tag.toLowerCase()]))];
  const clauses = [...[...statusIds].map(id => `status:${id}`), ...tagVariants.map(tag => `tag:'${tag}'`)];
  const q = encodeURIComponent(`"${clauses.join(' OR ')}"`);
  const ids = [];
  for (let page = 1; page <= 10; page++) {
    const { data } = await axios.get(`${fdBase()}/search/tickets?query=${q}&page=${page}`, { headers: fdHeaders() });
    const rs = data?.results || [];
    ids.push(...rs.map(r => r.id));
    if (rs.length < 30) break;
  }
  return ids;
}

// ── DEPUTY ──
const depHeaders = () => ({
  Authorization: `Bearer ${process.env.DEPUTY_ACCESS_TOKEN}`,
  'Content-Type': 'application/json', 'dp-meta-option': 'none',
});
const depBase = () => `https://${process.env.DEPUTY_DOMAIN}/api/v1`;

async function depEmpIdByEmail(activeEmails) {
  if (mem.empIdByEmail) return mem.empIdByEmail;
  try {
    const { data } = await axios.get(`${depBase()}/supervise/employee?max=500`, { headers: depHeaders() });
    const map = {};
    for (const e of (data || [])) {
      const email = (e.Email || '').toLowerCase().trim();
      if (email && activeEmails.includes(email)) map[email] = e.Id;
    }
    mem.empIdByEmail = map;
    return map;
  } catch (e) { console.warn('[Deputy] emp map:', e.message); return {}; }
}

async function depSchedule(activeEmails) {
  const today = new Date().toISOString().split('T')[0];
  const idMap = await depEmpIdByEmail(activeEmails);
  const id2email = {}; Object.entries(idMap).forEach(([em, id]) => id2email[id] = em);
  const ids = Object.values(idMap);
  if (!ids.length) return {};

  const rRes = await axios.post(`${depBase()}/resource/Roster/QUERY`,
    { search: { s1:{field:'Date',type:'eq',data:today}, s2:{field:'Published',type:'eq',data:true} }, max:500 },
    { headers: depHeaders() });
  const rosters = (rRes.data || []).filter(r => ids.includes(r.Employee));

  // Breaks live inside each Roster's `Slots` array (strType 'B'); this Deputy
  // account has no separate RosterBreak resource (it 404s).
  const sched = {};
  for (const r of rosters) {
    const em = id2email[r.Employee]; if (!em) continue;
    const slotBreaks = (r.Slots || [])
      .filter(s => s.strType === 'B' && !s.blnEmptySlot && s.intUnixStart && s.intUnixEnd)
      .map(s => ({ startTs: s.intUnixStart*1000, endTs: s.intUnixEnd*1000 }));
    (sched[em] = sched[em] || { shifts:[], onLeave:false }).shifts.push({
      startTs:r.StartTime*1000, endTs:r.EndTime*1000, breaks: slotBreaks
    });
  }
  try {
    const lRes = await axios.post(`${depBase()}/resource/Leave/QUERY`,
      { search: { s1:{field:'DateStart',type:'le',data:today}, s2:{field:'DateEnd',type:'ge',data:today}, s3:{field:'Status',type:'eq',data:1} }, max:500 },
      { headers: depHeaders() });
    for (const lv of (lRes.data || [])) {
      const em = id2email[lv.Employee]; if (!em) continue;
      (sched[em] = sched[em] || { shifts:[], onLeave:false }).onLeave = true;
    }
  } catch (e) { console.warn('[Deputy] leave:', e.message); }
  return sched;
}

async function getSchedule(activeEmails) {
  const now = Date.now();
  if (mem.schedAt && now - mem.schedAt < SCHED_TTL && Object.keys(mem.schedule).length) return mem.schedule;
  mem.schedule = await depSchedule(activeEmails);
  mem.schedAt  = now;
  return mem.schedule;
}

// Detect each agent's NORMAL shift start time-of-day from recent rosters.
// Anchors the 24h stats window on off-days/weekends/PTO when no shift exists.
// Returns: email -> { hour, minute } in DISPLAY_TZ. Cached ~12h.
async function getNormalShiftTimes(activeEmails) {
  if (mem.normalShiftTimes && mem.normalShiftAt && Date.now() - mem.normalShiftAt < 12*3600000) {
    return mem.normalShiftTimes;
  }
  const idMap = await depEmpIdByEmail(activeEmails);
  const id2email = {}; Object.entries(idMap).forEach(([em,id]) => id2email[id] = em);
  const ids = Object.values(idMap);
  const result = {};
  if (!ids.length) { mem.normalShiftTimes = result; mem.normalShiftAt = Date.now(); return result; }

  const from = new Date(Date.now() - 21*86400000).toISOString().split('T')[0];
  const to   = new Date(Date.now() + 1*86400000).toISOString().split('T')[0];
  try {
    const rRes = await axios.post(`${depBase()}/resource/Roster/QUERY`,
      { search: { s1:{ field:'Date', type:'ge', data:from }, s2:{ field:'Date', type:'le', data:to } }, max:2000 },
      { headers: depHeaders() });
    const rosters = (rRes.data || []).filter(r => ids.includes(r.Employee));
    const tally = {};
    for (const r of rosters) {
      const em = id2email[r.Employee]; if (!em) continue;
      const d = new Date(r.StartTime*1000);
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour12:false, hour:'2-digit', minute:'2-digit' }).formatToParts(d);
      const hh = parts.find(p=>p.type==='hour').value;
      const mm = parts.find(p=>p.type==='minute').value;
      const key = `${parseInt(hh)}:${parseInt(mm)}`;
      (tally[em] = tally[em] || {})[key] = (tally[em][key]||0) + 1;
    }
    for (const [em, counts] of Object.entries(tally)) {
      let best=null, bestN=0;
      for (const [k,n] of Object.entries(counts)) if (n>bestN){bestN=n;best=k;}
      if (best) { const [h,m]=best.split(':').map(Number); result[em]={hour:h,minute:m}; }
    }
  } catch (e) { console.warn('[Deputy] normal shift detect:', e.message); }

  mem.normalShiftTimes = result;
  mem.normalShiftAt = Date.now();
  return result;
}

// Window start for a no-shift day, from the agent's normal time-of-day.
function normalWindowStart(normal) {
  if (!normal) return null;
  const now = new Date();
  const dParts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(now);
  const y = dParts.find(p=>p.type==='year').value;
  const mo= dParts.find(p=>p.type==='month').value;
  const da= dParts.find(p=>p.type==='day').value;
  const hh = String(normal.hour).padStart(2,'0');
  const mm = String(normal.minute).padStart(2,'0');
  const guess = new Date(`${y}-${mo}-${da}T${hh}:${mm}:00`);
  const tzOff = tzOffsetMinutes(TZ, guess);
  const serverOff = -guess.getTimezoneOffset();
  let ts = guess.getTime() + (serverOff - tzOff)*60000;
  if (ts > now.getTime()) ts -= 24*3600000;
  return ts;
}

function tzOffsetMinutes(tz, date) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12:false, year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit' });
  const parts = dtf.formatToParts(date);
  const map = {}; parts.forEach(p=>map[p.type]=p.value);
  const asUTC = Date.UTC(map.year, map.month-1, map.day, map.hour, map.minute, map.second);
  return Math.round((asUTC - date.getTime())/60000);
}

// Live (pressed) meal break, from the in-progress timesheet. This account marks
// active timesheets with IsInProgress=true (not EndTime=0), and records meal
// breaks in MealbreakSlots as {ts:'OUT'} (break start) / {ts:'IN'} (break end).
// An 'OUT' with no matching 'IN' ⇒ the employee is on a live break right now.
// Returns: Deputy employee Id -> break-start ms.
async function depLiveBreaks() {
  try {
    const { data } = await axios.post(`${depBase()}/resource/Timesheet/QUERY`,
      { search: { s1:{field:'IsInProgress',type:'eq',data:true} }, max:500 },
      { headers: depHeaders() });
    const map = {};
    for (const t of (data || [])) {
      if (!t.Employee) continue;
      let breakStart = null;
      // Primary: a break slot currently in progress. mixedActivity.intState is
      // 0 = not started, 1 = on break, 2 = finished. Match on the number — NOT on
      // strState text ("Not Start" contains "start" and would false-positive).
      for (const s of (t.Slots||[])) {
        if (s.strType==='B' && s.mixedActivity && s.mixedActivity.intState===1 && s.intUnixStart) {
          breakStart = s.intUnixStart*1000;
        }
      }
      // Fallback: MealbreakSlots (an object) with an 'OUT' lacking a matching 'IN'.
      // It can be an empty string when no break has been taken — guard for that.
      if (!breakStart && t.MealbreakSlots && typeof t.MealbreakSlots === 'object') {
        const entries = Object.entries(t.MealbreakSlots);
        const outs = entries.filter(([,v]) => String(v).toUpperCase()==='OUT').map(([k])=>parseInt(k));
        const ins  = entries.filter(([,v]) => String(v).toUpperCase()==='IN').length;
        if (outs.length > ins) breakStart = Math.max(...outs)*1000;
      }
      if (breakStart) map[t.Employee] = breakStart;
    }
    return map;
  } catch (e) { console.warn('[Deputy] live break:', e.message); return {}; }
}

const depDay = (offset) => new Date(Date.now() + offset*86400000).toISOString().split('T')[0];

// Timesheets from Deputy (2 days back to today, so shifts near UTC midnight and
// recently ended shifts are covered). Returns: Deputy employee Id -> [{ start, end }]
// (ms; end = now while in progress). Returns null when Deputy can't be reached,
// so late/missed detection is skipped rather than guessed.
async function depTimesheets() {
  try {
    const { data } = await axios.post(`${depBase()}/resource/Timesheet/QUERY`,
      { search: { s1:{field:'Date',type:'ge',data:depDay(-2)}, s2:{field:'Date',type:'le',data:depDay(0)} }, max:500 },
      { headers: depHeaders() });
    const map = {};
    for (const t of (data || [])) {
      if (!t.Employee || !t.StartTime) continue;
      (map[t.Employee] = map[t.Employee] || []).push(A.toTimesheet(t));
    }
    return map;
  } catch (e) { console.warn('[Deputy] timesheets:', e.message); return null; }
}

// Published rosters and leave for the last 2 days, for no-clock-in detection.
// Returns { shifts: Id -> [shift], leave: Id -> [leave] } or null on failure.
async function depRecentRostersAndLeave() {
  try {
    const [rRes, lRes] = await Promise.all([
      axios.post(`${depBase()}/resource/Roster/QUERY`,
        { search: { s1:{field:'Date',type:'ge',data:depDay(-2)}, s2:{field:'Date',type:'le',data:depDay(0)}, s3:{field:'Published',type:'eq',data:true} }, max:500 },
        { headers: depHeaders() }),
      axios.post(`${depBase()}/resource/Leave/QUERY`,
        { search: { s1:{field:'DateEnd',type:'ge',data:depDay(-3)}, s2:{field:'DateStart',type:'le',data:depDay(1)} }, max:500 },
        { headers: depHeaders() }),
    ]);
    const shifts = {}, leave = {};
    for (const r of (rRes.data || [])) if (r.Employee && r.StartTime) (shifts[r.Employee] = shifts[r.Employee] || []).push(A.toShift(r));
    for (const l of (lRes.data || [])) if (l.Employee && l.Start) (leave[l.Employee] = leave[l.Employee] || []).push(A.toLeave(l));
    return { shifts, leave };
  } catch (e) { console.warn('[Deputy] rosters/leave:', e.message); return null; }
}

// ── MONITOR STATE (pauses only on live break) ──
function monitorState(email, schedule, liveBreakStart) {
  const now = Date.now();
  const e = schedule[email];
  if (!e) return { monitor:false, reason:'Not scheduled in Deputy', shift:null, onBreak:false };
  if (e.onLeave) return { monitor:false, reason:'On approved leave', shift:null, onBreak:false };
  if (!e.shifts?.length) return { monitor:false, reason:'No shift today', shift:null, onBreak:false };

  const shift = e.shifts.find(s => now >= s.startTs && now <= s.endTs);
  if (liveBreakStart) {
    let flaggedLate=false, scheduledStart=null, lateMin=null;
    if (shift?.breaks?.length) {
      const near = shift.breaks.reduce((b,c)=>Math.abs(c.startTs-liveBreakStart)<Math.abs((b?.startTs??Infinity)-liveBreakStart)?c:b,null);
      if (near){ scheduledStart=near.startTs; lateMin=Math.round((liveBreakStart-near.startTs)/60000); flaggedLate=Math.abs(lateMin)>BREAK_GRACE_MIN; }
    }
    return { monitor:false, reason: flaggedLate?`Break OFF-SCHEDULE (${lateMin}m)`:'On live break',
             shift:shift||null, onBreak:true, liveBreak:true, breakStartTs:liveBreakStart, scheduledStart, lateMin, flaggedLate };
  }
  // NOTE: scheduled breaks do NOT pause tracking. Only a pressed (live) break
  // pauses idle/alerts. Scheduled breaks are the reference for off-schedule
  // compliance logging (see addBreakLog on flaggedLate).
  if (!shift) {
    const up = e.shifts.find(s=>s.startTs>now);
    if (up) return { monitor:false, reason:`Shift starts ${fmtTime(up.startTs)}`, shift:up, onBreak:false };
    return { monitor:false, reason:'Shift ended', shift:e.shifts[e.shifts.length-1], onBreak:false };
  }
  return { monitor:true, reason:`Active ${fmtTime(shift.startTs)}-${fmtTime(shift.endTs)}`, shift, onBreak:false };
}

// ── SLACK ──
// Only post when a real webhook is configured (placeholder/empty = disabled).
const slackEnabled = () => {
  const u = process.env.SLACK_WEBHOOK_URL || '';
  return /^https:\/\/hooks\.slack\.com\//.test(u) && !/XXX|YYY|ZZZ/.test(u);
};
async function slackInactivity(name, email, idleMs, shift) {
  if (!slackEnabled()) return;
  const idleMin = idleMs!=null?Math.floor(idleMs/60000):null;
  await axios.post(process.env.SLACK_WEBHOOK_URL, { text:`🚨 Inactivity - ${name}`, blocks:[
    { type:'header', text:{ type:'plain_text', text:'🚨 Inactivity Alert', emoji:true } },
    { type:'section', fields:[
      { type:'mrkdwn', text:`*Agent:*\n${name}` },
      { type:'mrkdwn', text:`*Email:*\n${email}` },
      { type:'mrkdwn', text:`*Idle:*\n${idleMin!=null?idleMin+'m':'no activity'}` },
      { type:'mrkdwn', text:`*Threshold:*\n${THRESHOLD_MIN}m` },
      { type:'mrkdwn', text:`*Shift:*\n${shift?fmtTime(shift.startTs)+'-'+fmtTime(shift.endTs):'—'}` },
      { type:'mrkdwn', text:`*Time:*\n${new Date().toLocaleString('en-US',{timeZone:TZ,hour12:true})}` },
    ]},
  ]});
}

async function slack48h(t) {
  if (!slackEnabled()) return;
  const hrs = Math.floor((Date.now() - new Date(t.response_due_at).getTime())/3600000);
  await axios.post(process.env.SLACK_WEBHOOK_URL, { text:`⏰ 48h+ No Response - Ticket #${t.ticket_id}`, blocks:[
    { type:'header', text:{ type:'plain_text', text:'⏰ Response Overdue 48h+', emoji:true } },
    { type:'section', fields:[
      { type:'mrkdwn', text:`*Agent:*\n${t.agent_name||t.agent_email}` },
      { type:'mrkdwn', text:`*Ticket:*\n<${t.ticket_url}|#${t.ticket_id}>` },
      { type:'mrkdwn', text:`*Overdue:*\n${hrs} hours` },
      { type:'mrkdwn', text:`*Subject:*\n${(t.subject||'').slice(0,80)}` },
    ]},
    { type:'context', elements:[{ type:'mrkdwn', text:'⚠️ No response for 48+ hours. Take action ASAP.' }] },
    { type:'divider' },
  ]});
}

// ── CORE POLL ──
async function runPoll() {
  const now = Date.now();
  const threshold = THRESHOLD_MIN*60000;
  const monthKey = new Date().toISOString().slice(0,7);

  const [activeEmails, trackedStatuses, allAgents] = await Promise.all([
    D.getActiveAgentEmails(), D.getStatuses(), D.getAgents(),
  ]);
  if (!activeEmails.length) { mem.lastChecked = new Date().toISOString(); return { agents: [] }; }

  const [fdAgentList, schedule, liveBreaks, empIdMap, statusChoices, normalTimes, timesheets, recentRoster] = await Promise.all([
    fdAgents(), getSchedule(activeEmails), depLiveBreaks(), depEmpIdByEmail(activeEmails), fdTicketFields(), getNormalShiftTimes(activeEmails),
    depTimesheets(), depRecentRostersAndLeave(),
  ]);

  const agents = fdAgentList.filter(a => activeEmails.includes((a.contact?.email||'').toLowerCase().trim()));
  const id2email = {}; agents.forEach(a => id2email[a.id] = (a.contact?.email||'').toLowerCase().trim());
  const monitoredIds = agents.map(a => a.id);
  const email2name = {}; allAgents.forEach(a => email2name[a.email] = a.name);

  const tickets = await fdTicketsSince(new Date(now - 24*3600000).toISOString());
  const excludedIds = new Set(Object.keys(statusChoices || {})
    .filter(k => EXCLUDED_STATUS_RX.test(agentLabel(statusChoices[k]))).map(Number));
  const groupNames = await fdGroupNames();
  // email -> group id (0 = none) -> counters; mirrors `metrics` for the same tickets
  const groupMetrics = {};
  const groupBucket = (email, groupId) => {
    const gid = groupId || 0, byG = groupMetrics[email] = groupMetrics[email] || {};
    return byG[gid] = byG[gid] || { newTickets:0, resolved:0, closed:0, respSum:0, respCount:0, frSum:0, frCount:0, slaDue:0, slaBreached:0, overdue:0 };
  };

  const statusAgentMap = {};
  for (const s of trackedStatuses) statusAgentMap[s.label.toLowerCase()] = new Set((s.agents||[]).map(e=>e.toLowerCase()));

  const metrics = {};
  for (const a of agents) metrics[id2email[a.id]] = {
    lastSeen:0, ticketSeen:0, newTickets:0, resolved:0, closed:0,
    respSum:0, respCount:0, frSum:0, frCount:0, responseDue:0, slaDue:0, slaBreached:0, custom:{},
  };

  // ── Resolve each agent's 24h window start (works on off-days/weekends too) ──
  // If a shift exists today, use its start. Otherwise use the agent's normal
  // shift time-of-day so stats still roll/track on off days.
  const windowStart = {}; // email -> ts
  for (const a of agents) {
    const email = id2email[a.id];
    const sEntry = schedule[email];
    let ws = null;
    if (sEntry && sEntry.shifts && sEntry.shifts.length) {
      // most recent shift start that is <= now, else the earliest upcoming
      const past = sEntry.shifts.filter(s => s.startTs <= now).sort((x,y)=>y.startTs-x.startTs);
      ws = past.length ? past[0].startTs : sEntry.shifts.sort((x,y)=>x.startTs-y.startTs)[0].startTs;
    }
    if (!ws) ws = normalWindowStart(normalTimes[email]);     // off-day → normal time
    if (!ws) ws = mem.shiftWindowStart[email] || (now - 24*3600000); // fallback
    windowStart[email] = ws;
    mem.shiftWindowStart[email] = ws;
  }

  // Existing overdue rows (one query) so the per-ticket loop only touches the DB
  // when something actually changes — not once per ticket.
  let existingOverdue = new Set();
  try { existingOverdue = new Set((await D.getOverdue({})).map(r => r.ticket_id)); }
  catch (e) { console.error('getOverdue:', e.message); }
  const overdueOps = { upsert: [], replied: [], del: [] };

  // Overdue rows for tickets excluded (status/tag) more than 24h ago won't show
  // up in the poll below, so sweep them out periodically via search.
  if (existingOverdue.size && now - (mem.excludedPurgeAt || 0) > SCHED_TTL) {
    try {
      for (const id of await fdTicketIdsExcluded(excludedIds, EXCLUDED_TAGS)) if (existingOverdue.has(id)) overdueOps.del.push(id);
      mem.excludedPurgeAt = now;
    } catch (e) { console.warn('[FD] excluded purge:', e.message); }
  }

  const empathyCandidates = [];
  for (const t of tickets) {
    if (excludedIds.has(t.status) || hasExcludedTag(t)) {
      if (existingOverdue.has(t.id)) overdueOps.del.push(t.id);
      continue;
    }
    const respId = t.responder_id;
    if (!monitoredIds.includes(respId)) continue;
    const email = id2email[respId]; if (!email) continue;
    const m = metrics[email];
    const g = groupBucket(email, t.group_id);
    const winStart = windowStart[email] || (now - 24*3600000);

    const upd = new Date(t.updated_at).getTime();
    const cre = new Date(t.created_at).getTime();
    // fallback only: used when the agent-activity tables aren't set up
    if (upd > m.ticketSeen) m.ticketSeen = upd;
    if (cre >= winStart) { m.newTickets++; g.newTickets++; }

    const label = (statusChoices?.[t.status] || '').toString().toLowerCase();
    if ((t.status===4 || label.includes('resolved')) && upd>=winStart) { m.resolved++; g.resolved++; }
    if ((t.status===5 || label.includes('closed'))   && upd>=winStart) { m.closed++; g.closed++; }
    // resolved/closed tickets are handed to the empathy check (run from /api/cron)
    if (t.status === 4 || t.status === 5) empathyCandidates.push({
      id: t.id, email, name: email2name[email] || email, subject: t.subject, status: t.status, groupId: t.group_id || 0,
      resolvedAt: t.stats?.resolved_at || t.stats?.closed_at || t.updated_at,
    });

    for (const s of trackedStatuses) {
      if (CORE_STATUS_IDS.has(s.choice_id)) continue;       // Resolved/Closed have columns
      const lbl = s.label.toLowerCase();
      const applies = statusAgentMap[lbl];
      if (applies && applies.has(email) && (label.includes(lbl) || (s.choice_id && t.status===s.choice_id))) {
        if (upd>=winStart) m.custom[s.label] = (m.custom[s.label]||0)+1;
      }
    }

    const st = t.stats || {};
    if (st.first_responded_at) {
      const fr = (new Date(st.first_responded_at)-new Date(t.created_at))/60000;
      if (fr>=0) { m.frSum+=fr; m.frCount++; m.respSum+=fr; m.respCount++;
                   g.frSum+=fr; g.frCount++; g.respSum+=fr; g.respCount++; }
    }

    // Freshdesk stats name these agent_responded_at / requester_responded_at.
    const closedOrResolved = t.status === 4 || t.status === 5;
    const agentRespAt = st.agent_responded_at ? new Date(st.agent_responded_at).getTime() : 0;
    const reqRespAt   = st.requester_responded_at ? new Date(st.requester_responded_at).getTime() : 0;
    const awaitingReply = reqRespAt > agentRespAt;   // requester's latest message is unanswered

    // ── Response-due SLA metric (reports only) — uses Freshdesk's due fields ──
    const frDue = st.fr_due_by || t.fr_due_by;
    const nrDue = t.nr_due_by || st.next_response_due_by;
    if ((frDue && !st.first_responded_at) || (nrDue && awaitingReply)) { m.slaDue++; g.slaDue++; }
    const slaMissed = !closedOrResolved && (
      (!st.first_responded_at && frDue && new Date(frDue).getTime() < now) ||
      (awaitingReply && nrDue && new Date(nrDue).getTime() < now));
    if (slaMissed) { m.slaBreached++; g.slaBreached++; }

    // ── Overdue LOG ──
    // Wait time is measured from when the customer STARTED waiting (their last
    // unanswered message, or ticket creation if never first-answered). A ticket
    // is logged only once that wait passes OVERDUE_MS (24h); we store that anchor
    // so the live view shows the ACTUAL elapsed time — not time-since-SLA-due.
    const awaitingSince = awaitingReply ? reqRespAt
                        : (!st.first_responded_at ? new Date(t.created_at).getTime() : 0);
    const waitedMs = awaitingSince ? now - awaitingSince : 0;
    const isOverdue = !closedOrResolved && awaitingSince > 0 && waitedMs >= OVERDUE_MS;
    if (isOverdue) { m.responseDue++; g.overdue++; }

    if (isOverdue) {
      overdueOps.upsert.push({
        ticket_id: t.id, agent_email: email, agent_name: email2name[email]||email,
        subject: (t.subject||'').slice(0,250), ticket_url: ticketUrl(t.id),
        response_due_at: new Date(awaitingSince).toISOString(), month_key: monthKey,
      });
    } else if (existingOverdue.has(t.id)) {
      // only tickets already in the log need a write
      if (!awaitingReply && (st.agent_responded_at || st.first_responded_at)) {
        overdueOps.replied.push([t.id, new Date(st.agent_responded_at || st.first_responded_at).toISOString()]);
      } else {
        overdueOps.del.push(t.id);   // under 24h / closed / no longer waiting
      }
    }
  }

  // Last activity = the agent's own latest reply/note on any ticket.
  let activity = null;
  const replyEvents = [];
  try { activity = await scanAgentActivity(tickets, id2email, replyEvents); }
  catch (e) { console.error('agent activity:', e.message); }
  for (const email of Object.keys(metrics)) metrics[email].lastSeen = activity ? (activity[email] || 0) : metrics[email].ticketSeen;

  // Reply times in working hours (api/responses.js): store the replies found in
  // the conversations just read, then take each agent's averages over their
  // current 24h window from the stored replies. respByEmail stays null if the
  // response_events table isn't set up, and the older estimate is used instead.
  let respByEmail = null, respEventsByEmail = {};
  try {
    const emails = Object.keys(metrics);
    const pending = await D.getResponseEventsMissingWorking().catch(() => []);   // shifts were unavailable earlier
    // only recent replies; older history is filled in by the one-off recalculation script
    const toTime = [...replyEvents.filter(e => Date.parse(e.replied_at) >= now - 35*86400000), ...pending];
    if (toTime.length) {
      const earliest = Math.max(Math.min(...toTime.map(e => Date.parse(e.wait_start))), now - 60*86400000);
      const shifts = await cachedShifts(new Date(earliest - 86400000).toISOString().slice(0, 10), emails).catch(e => {
        console.warn('[Deputy] shifts for reply times:', e.message); return null; });
      // without shifts, only add new replies so earlier calculated times aren't wiped
      await D.upsertResponseEvents(RS.timeEvents(toTime.map(({ wait_calendar_min, wait_working_min, reply_date, ...e }) => e), shifts),
        { onlyNew: !shifts });
    }
    const sinceMs = Math.min(...emails.map(e => windowStart[e] || now - 24*3600000));
    const recent = await D.getResponseEventsSince(new Date(sinceMs).toISOString());
    respByEmail = {};
    for (const email of emails) {
      respEventsByEmail[email] = recent.filter(e => e.agent_email === email && Date.parse(e.replied_at) >= (windowStart[email] || now - 24*3600000));
      respByEmail[email] = RS.responseTotals(respEventsByEmail[email]);
    }
  } catch (e) { if (!/schema cache/.test(e.message)) console.error('reply times:', e.message); respByEmail = null; }
  const respAvg = (email, m) => respByEmail
    ? { avg: respByEmail[email].avgResponseMin, first: respByEmail[email].firstReplyMin }
    : { avg: m.respCount ? +(m.respSum/m.respCount).toFixed(1) : 0, first: m.frCount ? +(m.frSum/m.frCount).toFixed(1) : 0 };

  // Apply overdue-log changes in parallel (only the rows that actually changed).
  await Promise.all([
    ...overdueOps.upsert.map(r => D.upsertOverdue(r).catch(e=>console.error('upsertOverdue:',e.message))),
    ...overdueOps.replied.map(([id,ts]) => D.markReplied(id,ts).catch(e=>console.error('markReplied:',e.message))),
    ...[...new Set(overdueOps.del)].map(id => D.deleteOverdue(id).catch(e=>console.error('deleteOverdue:',e.message))),
  ]);

  // ── Custom statuses: non-windowed ones show the agent's CURRENT total ──
  // (live snapshot from Freshdesk), overwriting the 24h-window tally above.
  // Windowed statuses (A2P approval) keep the 24h count.
  const countJobs = [];
  for (const a of agents) {
    const email = id2email[a.id];
    const m = metrics[email];
    for (const s of trackedStatuses) {
      if (CORE_STATUS_IDS.has(s.choice_id)) continue;    // Resolved/Closed have columns
      const applies = statusAgentMap[s.label.toLowerCase()];
      if (!applies || !applies.has(email)) continue;
      if (WINDOWED_STATUS_RX.test(s.label)) continue;   // keep 24h window
      if (!s.choice_id) continue;                        // need a status id to count live
      countJobs.push({ m, label:s.label, agentId:a.id, choiceId:s.choice_id });
    }
  }
  await Promise.all(countJobs.map(async j => {
    const c = await fdCountByStatus(j.agentId, j.choiceId);
    if (c > 0) j.m.custom[j.label] = c; else delete j.m.custom[j.label];
  }));

  // 48h Slack notifications (skip entirely until a real webhook is configured,
  // so these tickets still alert once Slack is set up)
  if (slackEnabled()) try {
    const due48 = await D.getUnnotified48h();
    for (const tk of due48) {
      try { await slack48h(tk); await D.mark48hNotified(tk.ticket_id); }
      catch (e) { console.error('48h slack:', e.message); }
    }
  } catch (e) { console.error('48h check:', e.message); }

  const results = [];
  const today = new Date().toISOString().split('T')[0];

  for (const a of agents) {
    const id = a.id, email = id2email[id];
    const name = email2name[email] || a.contact?.name || email;
    const prev = mem.agentActivity[id] || { lastSeen:null, alertedAt:null };

    const depId = empIdMap[email] || null;
    const lbStart = depId ? (liveBreaks[depId]||null) : null;
    const ms = monitorState(email, schedule, lbStart);

    if (ms.liveBreak && ms.flaggedLate) {
      try {
        await D.addBreakLog({
          agent_email: email, agent_name: name, log_date: today,
          pressed_at: new Date(ms.breakStartTs).toISOString(),
          scheduled_start: ms.scheduledStart ? new Date(ms.scheduledStart).toISOString() : null,
          late_min: ms.lateMin,
        });
      } catch (e) { console.error('breakLog:', e.message); }
    }

    const m = metrics[email];
    let lastSeen = prev.lastSeen;
    if (m.lastSeen && m.lastSeen > (lastSeen||0)) lastSeen = m.lastSeen;
    let { alertedAt } = prev;
    if (alertedAt && lastSeen && lastSeen > alertedAt) alertedAt = null;
    // Idle is only meaningful DURING the shift: activity before shift start
    // (e.g. the previous day) must not count. So measure idle from the later
    // of (last activity, shift start) — otherwise an agent shows as hours-idle
    // the moment their shift begins.
    const idleBaseline = (ms.monitor && ms.shift)
      ? Math.max(lastSeen || 0, ms.shift.startTs)
      : lastSeen;
    const idleMs = idleBaseline ? now-idleBaseline : null;
    const isIdle = idleMs==null || idleMs>threshold;

    if (ms.monitor && isIdle && !alertedAt) {
      try { await slackInactivity(name, email, idleMs, ms.shift); alertedAt=now; }
      catch (e) { console.error('inactivity slack:', e.message); }
    }
    mem.agentActivity[id] = { lastSeen, alertedAt };

    const winStart = windowStart[email] || now;
    const statDate = new Date(winStart).toISOString().split('T')[0];
    try {
      await D.upsertDailyStats({
        agent_email: email, stat_date: statDate, window_start: new Date(winStart).toISOString(),
        new_tickets: m.newTickets, resolved: m.resolved, closed: m.closed,
        avg_response_min: respAvg(email, m).avg,
        first_reply_min: respAvg(email, m).first,
        response_due: m.responseDue, custom_counts: m.custom, updated_at: new Date().toISOString(),
      });
    } catch (e) { console.error('upsertStats:', e.message); }

    // Persist response-due SLA daily
    try {
      await D.upsertSlaDaily({
        agent_email: email, stat_date: statDate, month_key: statDate.slice(0,7),
        total_due: m.slaDue, breached: m.slaBreached, updated_at: new Date().toISOString(),
      });
    } catch (e) { console.error('sla persist:', e.message); }

    // Persist the same day's stats split by ticket group
    try {
      // reply times per group come from this agent's reply events in the window
      const evs = respByEmail ? respEventsByEmail[email] : null;
      const byGroup = { ...(groupMetrics[email] || {}) };
      if (evs) for (const e of evs) byGroup[e.group_id || 0] = byGroup[e.group_id || 0] || groupBucket(email, e.group_id);
      const rows = Object.entries(byGroup).map(([gid, gm]) => {
        const ge = evs ? evs.filter(e => (e.group_id || 0) === +gid && e.wait_working_min != null) : null;
        const sum = (xs) => +xs.reduce((s, e) => s + +e.wait_working_min, 0).toFixed(1);
        return {
          agent_email: email, group_id: +gid, group_name: +gid ? (groupNames[gid] || `Group ${gid}`) : 'No group',
          stat_date: statDate, new_tickets: gm.newTickets, resolved: gm.resolved, closed: gm.closed,
          resp_sum_min: ge ? sum(ge) : +gm.respSum.toFixed(1), resp_count: ge ? ge.length : gm.respCount,
          fr_sum_min: ge ? sum(ge.filter(e => e.is_first)) : +gm.frSum.toFixed(1), fr_count: ge ? ge.filter(e => e.is_first).length : gm.frCount,
          sla_due: gm.slaDue, sla_breached: gm.slaBreached, overdue: gm.overdue, updated_at: new Date().toISOString(),
        };
      });
      await D.replaceGroupStats(email, statDate, rows);
    } catch (e) { console.error('group stats:', e.message); }

    // ── LATE SHIFT detection ──
    // Late = Deputy clock-in (timesheet start) after rostered shift start + grace.
    // Ticket activity is NOT used: a ticket's updated_at is its latest change (often
    // by the customer or automation), so it says nothing about when the agent began.
    // Only the earliest clock-in near this shift counts; nothing is logged until the
    // agent clocks in, and an on-time clock-in clears any row logged earlier today.
    if (ms.shift && timesheets && depId) {
      const graceMs = (parseInt(process.env.LATE_GRACE_MINUTES||5))*60000;
      const clockIn = (timesheets[depId] || []).map(t => t.start)
        .filter(ts => ts >= ms.shift.startTs - 3*3600000 && ts <= ms.shift.endTs)
        .sort((a, b) => a - b)[0];
      if (clockIn) {
        try {
          if (clockIn > ms.shift.startTs + graceMs) {
            await D.logLateShift({
              agent_email: email, agent_name: name, log_date: today, month_key: today.slice(0,7),
              scheduled_start: new Date(ms.shift.startTs).toISOString(),
              actual_start: new Date(clockIn).toISOString(),
              late_min: Math.round((clockIn - ms.shift.startTs)/60000),
            });
          } else {
            await D.deleteLateShift(email, today);
          }
        } catch (e) { console.error('lateShift:', e.message); }
      }
    }

    // ── NO CLOCK-IN: rostered shifts that ended in the last 36h with no timesheet
    // and no leave (rule in api/attendance.js). Re-checked each poll, so a shift
    // later covered by leave or a late-entered timesheet is removed again.
    if (recentRoster && timesheets && depId) {
      const recent = (recentRoster.shifts[depId] || []).filter(s => s.end <= now && s.end > now - 36*3600000);
      const missed = new Set(A.findMissedShifts({
        shifts: recent, timesheets: timesheets[depId] || [], leave: recentRoster.leave[depId] || [], now,
      }));
      for (const s of recent) {
        const startIso = new Date(s.start).toISOString(), day = A.shiftDate(s.start);
        try {
          if (missed.has(s)) {
            await D.upsertMissedShift({
              agent_email: email, agent_name: name, log_date: day, month_key: day.slice(0,7),
              scheduled_start: startIso, scheduled_end: new Date(s.end).toISOString(),
            });
          } else {
            await D.deleteMissedShift(email, startIso);
          }
        } catch (e) { if (!/schema cache/.test(e.message)) console.error('missedShift:', e.message); }
      }
    }

    // ── IDLE LOG: record inactive episodes during shift (not on break) ──
    // idle_start = last ticket activity (or shift start if none); the episode
    // extends each poll while still idle. Only while genuinely on-shift.
    if (ms.monitor && (idleMs == null || idleMs >= threshold)) {
      const rawStart = lastSeen || (ms.shift ? ms.shift.startTs : winStart);
      // Never log idle time from before the shift began.
      const idleStartTs = ms.shift ? Math.max(rawStart, ms.shift.startTs) : rawStart;
      try {
        await D.upsertIdleLog({
          agent_email: email, agent_name: name, log_date: today, month_key: today.slice(0,7),
          idle_start: new Date(idleStartTs).toISOString(),
          idle_end: new Date(now).toISOString(),
          idle_min: Math.max(0, Math.floor((now - idleStartTs)/60000)),
        });
      } catch (e) { console.error('idleLog:', e.message); }
    }

    results.push({
      id, name, email,
      status: ms.onBreak ? (ms.flaggedLate?'break-late':'break')
            : !ms.monitor ? 'off-shift'
            : (idleMs==null||idleMs>threshold)?'alert'
            : (idleMs>threshold*0.7)?'idle':'active',
      monitor: ms.monitor, reason: ms.reason, shift: ms.shift,
      offDayTracking: (!ms.shift && !ms.onBreak),  // no shift but stats still tracked
      onBreak: ms.onBreak, liveBreak: ms.liveBreak||false, flaggedLate: ms.flaggedLate||false,
      lateMin: ms.lateMin??null, breakStartTs: ms.breakStartTs??null,
      lastSeen, idleMinutes: idleMs!=null?Math.floor(idleMs/60000):null, windowStart: winStart,
      stats: {
        newTickets:m.newTickets, resolved:m.resolved, closed:m.closed,
        avgResponseMin: respAvg(email, m).avg,
        firstReplyMin: respAvg(email, m).first,
        responses: respByEmail ? respByEmail[email].responses : null,
        firstReplies: respByEmail ? respByEmail[email].firstReplies : null,
        responseDue: m.responseDue, custom: m.custom,
      },
    });
  }

  try { await takeOpenSnapshots(agents, id2email); }
  catch (e) { if (!/schema cache/.test(e.message)) console.error('open snapshots:', e.message); }

  mem.lastChecked = new Date().toISOString();
  return { agents: results, empathyCandidates };
}

// Hourly snapshot for the Hourly tab: at the first poll of each hour, count each
// tracked agent's tickets in Open status (Freshdesk status 2). Skips agents
// already recorded for this hour, so overlapping polls don't repeat the calls.
async function takeOpenSnapshots(agents, id2email) {
  const hour = new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString();
  if (mem.snapshotHour === hour) return;
  const have = await D.getOpenSnapshotEmails(hour);
  const rows = [];
  for (const a of agents) {
    const email = id2email[a.id];
    if (!email || have.has(email)) continue;
    const q = encodeURIComponent(`"agent_id:${a.id} AND status:2"`);
    const { data } = await axios.get(`${fdBase()}/search/tickets?query=${q}`, { headers: fdHeaders(), timeout: 15000 });
    rows.push({ agent_email: email, snapshot_hour: hour, open_count: typeof data?.total === 'number' ? data.total : (data?.results?.length || 0),
      taken_at: new Date().toISOString() });
  }
  await D.upsertOpenSnapshots(rows);
  mem.snapshotHour = hour;
}

// Deputy roster shifts per agent from `fromDate` to tomorrow, cached for 30 min
// (reply times are measured in the replying agent's working hours).
async function cachedShifts(fromDate, emails) {
  const c = mem.shiftCache;
  if (c && c.fromDate <= fromDate && Date.now() - c.at < SCHED_TTL && emails.every(e => c.data[e])) return c.data;
  const to = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const data = await RS.fetchShifts(fromDate, to, emails);
  mem.shiftCache = { fromDate, at: Date.now(), data };
  return data;
}

// ── AGENT ACTIVITY: the agent's own replies and notes, on any ticket ──
// A ticket's updated_at changes for customer replies and automations too, so
// it can't tell when the agent last worked. Instead, each poll reads the
// conversations of tickets that changed since they were last scanned and keeps
// each tracked agent's latest reply/note. Newest tickets first, at most
// ACTIVITY_MAX_PER_POLL per poll, stopping when the Freshdesk rate limit runs
// low; the rest are picked up next poll. Returns email -> last activity (ms),
// or null when the tables aren't set up (the caller then falls back).
const ACTIVITY_MAX_PER_POLL = 20, ACTIVITY_MIN_RATE_LEFT = 150;
async function scanAgentActivity(tickets, id2email, replyEvents = []) {
  let scanned;
  try { scanned = await D.getTicketScans(tickets.map(t => t.id)); }
  catch (e) { if (/schema cache/.test(e.message)) return null; throw e; }
  const changed = tickets.filter(t => scanned[t.id] !== Date.parse(t.updated_at))
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
    .slice(0, ACTIVITY_MAX_PER_POLL);
  const latest = {}, scans = [];
  for (let i = 0; i < changed.length; i += 5) {
    const batch = await Promise.all(changed.slice(i, i + 5).map(t =>
      axios.get(`${fdBase()}/tickets/${t.id}/conversations?per_page=100`, { headers: fdHeaders(), timeout: 15000 })
        .then(r => ({ t, convs: r.data || [], left: parseInt(r.headers['x-ratelimit-remaining'] ?? '9999') }))
        .catch(err => ({ t, err }))));
    let low = false;
    for (const { t, convs, left, err } of batch) {
      if (err) { if (err.response?.status === 429) low = true; continue; }   // retried next poll
      // reply-time events from the same conversations (api/responses.js)
      replyEvents.push(...RS.extractReplyEvents(t, convs, id2email));
      for (const c of convs) {
        const email = !c.incoming && id2email[c.user_id];
        if (!email) continue;
        const at = Date.parse(c.created_at);
        if (!latest[email] || at > latest[email].at) latest[email] = { at, ticketId: t.id, kind: c.private ? 'note' : 'reply' };
      }
      scans.push({ ticket_id: t.id, updated_at: t.updated_at, scanned_at: new Date().toISOString() });
      if (left < ACTIVITY_MIN_RATE_LEFT) low = true;
    }
    if (low) break;
  }
  const current = await D.getAgentActivity();
  const newer = Object.entries(latest).filter(([email, v]) => !(current[email] >= v.at))
    .map(([email, v]) => ({ agent_email: email, last_at: new Date(v.at).toISOString(), ticket_id: v.ticketId, kind: v.kind, updated_at: new Date().toISOString() }));
  if (newer.length) { await D.upsertAgentActivity(newer); newer.forEach(r => current[r.agent_email] = Date.parse(r.last_at)); }
  if (scans.length) await D.upsertTicketScans(scans);
  return current;
}

// ── EMPATHY CHECK (resolved/closed tickets; rule in api/empathy.js) ──
// Runs after the cron poll. Each ticket costs a Freshdesk call, so a run checks
// at most EMPATHY_MAX_PER_RUN tickets, stops early when the shared rate limit
// runs low or the time budget is used, and the rest are picked up next run.
// A ticket is re-checked only if its resolution time changed (reopened).
const EMPATHY_MAX_PER_RUN = 15, EMPATHY_MIN_RATE_LEFT = 150;
async function runEmpathyChecks(candidates, budgetMs = 8000) {
  if (!candidates?.length) return { checked: 0, pending: 0 };
  const t0 = Date.now();
  let done;
  try { done = await D.getEmpathyResolvedAt(candidates.map(c => c.id)); }
  catch (e) { if (/schema cache/.test(e.message)) return { skipped: 'empathy_checks table missing' }; throw e; }
  const todo = candidates.filter(c => done[c.id] !== Date.parse(c.resolvedAt));
  let checked = 0;
  for (const c of todo.slice(0, EMPATHY_MAX_PER_RUN)) {
    if (Date.now() - t0 > budgetMs) break;
    try {
      const { messages, remaining } = await T.fetchTicketMessages(c.id);
      const r = E.analyzeConversation(messages);
      await D.upsertEmpathyCheck({
        ticket_id: c.id, agent_email: c.email, agent_name: c.name, subject: (c.subject || '').slice(0, 250),
        ticket_url: ticketUrl(c.id), status: c.status, group_id: c.groupId,
        resolved_at: new Date(c.resolvedAt).toISOString(), resolved_date: A.shiftDate(Date.parse(c.resolvedAt)),
        frustrated: r.frustrated, acknowledged: r.acknowledged, missing: r.missing, findings: r.findings,
        checked_at: new Date().toISOString(),
        // new or re-resolved ticket: any earlier Claude review is out of date
        review_source: 'quick', summary: null, ai_upset: null, ai_empathy_missing: null, ai_reason: null,
        ai_evidence: null, reviewed_at: null, reviewed_model: null,
      });
      checked++;
      if (remaining < EMPATHY_MIN_RATE_LEFT) break;
    } catch (e) {
      if (e.response?.status === 429) break;   // rate limited: try again next run
      console.warn('[empathy]', c.id, e.message);
    }
  }
  return { checked, pending: todo.length - checked };
}

// ── AUTH ──
// Stateless signed tokens (HMAC). No in-memory store, so they work across
// Vercel's serverless instances — otherwise a request landing on a different
// instance than the one that issued the token would 401 and log the user out.
const SESSION_SECRET = process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD || process.env.CRON_SECRET || 'dev-secret';
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000; // 7 days
const mkTok = () => {
  const exp = Date.now() + SESSION_TTL_MS;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(String(exp)).digest('hex');
  return `${exp}.${sig}`;
};
function verifyTok(t){
  if (!t || typeof t !== 'string' || t.indexOf('.') < 0) return false;
  const [expStr, sig] = t.split('.');
  const exp = parseInt(expStr, 10);
  if (!exp || Date.now() > exp) return false;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(String(exp)).digest('hex');
  if (!sig || sig.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}
app.post('/api/login', (req,res)=>{
  const { email, password } = req.body||{};
  if ((email||'').toLowerCase()===(process.env.ADMIN_EMAIL||'').toLowerCase() && password===process.env.ADMIN_PASSWORD) {
    return res.json({ ok:true, token: mkTok() });
  }
  res.status(401).json({ ok:false, error:'Invalid credentials' });
});
function authMw(req,res,next){ const t=req.headers['x-auth-token']; if(verifyTok(t))return next(); res.status(401).json({ok:false,error:'Unauthorized'}); }

app.get('/api/status', authMw, async (req,res)=>{
  try {
    const r = await runPoll();
    const a = r.agents;
    const today = new Date().toISOString().split('T')[0];
    const breakIssues = await D.getBreakLog(today);
    res.json({
      ok:true, lastChecked: mem.lastChecked, threshold: THRESHOLD_MIN, pollMins: POLL_MIN,
      stats: {
        total:a.length, active:a.filter(x=>x.status==='active').length,
        alert:a.filter(x=>x.status==='alert').length, onBreak:a.filter(x=>x.onBreak).length,
        lateBreak:a.filter(x=>x.flaggedLate).length, offShift:a.filter(x=>x.status==='off-shift').length,
      },
      agents:a, breakIssues,
    });
  } catch(e){ console.error(e.message); res.status(500).json({ok:false,error:e.message}); }
});

app.post('/api/poll', authMw, async (req,res)=>{
  try { const r=await runPoll(); res.json({ok:true, checked:r.agents.length}); }
  catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

app.get('/api/overdue', authMw, async (req,res)=>{
  try {
    const { agent, month } = req.query;
    const rows = await D.getOverdue({ agentEmail: agent||null, monthKey: month||null });
    const now = Date.now();
    const enriched = rows.map(t=>{
      // response_due_at holds when the customer STARTED waiting; show actual elapsed.
      const sinceTs = new Date(t.response_due_at).getTime();
      const hrs = Math.max(0, Math.floor((now-sinceTs)/3600000));
      const days = Math.floor(hrs/24), remH = hrs%24;
      const sinceText = t.replied_at ? null
        : days>=1 ? `${days}d ${remH}h since no response`
        : `${hrs}h since no response`;
      return { ...t, sinceText, repliedText: t.replied_at ? 'Replied '+new Date(t.replied_at).toLocaleString('en-US',{timeZone:TZ,hour12:true}) : '' };
    });
    res.json({ ok:true, tickets: enriched });
  } catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

// AGENTS CRUD
app.get('/api/agents', authMw, async (req,res)=>{ try{ res.json({ok:true, agents:await D.getAgents()}); }catch(e){ res.status(500).json({ok:false,error:e.message}); }});
app.post('/api/agents', authMw, async (req,res)=>{ try{ const {email,name}=req.body; await D.addAgent(email,name); mem.empIdByEmail=null; mem.schedAt=null; res.json({ok:true}); }catch(e){ res.status(500).json({ok:false,error:e.message}); }});
app.delete('/api/agents/:email', authMw, async (req,res)=>{ try{ await D.removeAgent(req.params.email); mem.empIdByEmail=null; mem.schedAt=null; res.json({ok:true}); }catch(e){ res.status(500).json({ok:false,error:e.message}); }});
app.patch('/api/agents/:email', authMw, async (req,res)=>{ try{ await D.setAgentActive(req.params.email,!!req.body.active); res.json({ok:true}); }catch(e){ res.status(500).json({ok:false,error:e.message}); }});

// STATUS MGMT
// Available Freshdesk statuses (choice id + agent-facing label) for the picker
app.get('/api/fd-statuses', authMw, async (req,res)=>{
  try{
    const choices = await fdTicketFields();
    const list = Object.keys(choices||{}).map(k=>({
      choiceId: parseInt(k),
      label: Array.isArray(choices[k]) ? choices[k][0] : String(choices[k]),
    })).sort((a,b)=>a.choiceId-b.choiceId);
    res.json({ ok:true, statuses:list });
  }catch(e){ res.status(500).json({ok:false,error:e.message}); }
});
app.get('/api/statuses', authMw, async (req,res)=>{ try{ res.json({ok:true, statuses:await D.getStatuses()}); }catch(e){ res.status(500).json({ok:false,error:e.message}); }});
app.post('/api/statuses', authMw, async (req,res)=>{ try{ const {label,choiceId,agents}=req.body; const s=await D.addStatus(label,choiceId,agents||[]); res.json({ok:true,status:s}); }catch(e){ res.status(500).json({ok:false,error:e.message}); }});
app.patch('/api/statuses/:id', authMw, async (req,res)=>{ try{ await D.updateStatusAgents(parseInt(req.params.id),req.body.agents||[]); res.json({ok:true}); }catch(e){ res.status(500).json({ok:false,error:e.message}); }});
app.delete('/api/statuses/:id', authMw, async (req,res)=>{ try{ await D.removeStatus(parseInt(req.params.id)); res.json({ok:true}); }catch(e){ res.status(500).json({ok:false,error:e.message}); }});

app.get('/api/archives', authMw, async (req,res)=>{ try{ res.json({ok:true, archives:await D.getArchives()}); }catch(e){ res.status(500).json({ok:false,error:e.message}); }});

// ── HISTORY ──
// Single date: /api/history?date=2026-06-16
// Range:       /api/history?from=2026-06-10&to=2026-06-16 [&agent=email]
app.get('/api/history', authMw, async (req,res)=>{
  try {
    const { date, from, to, agent } = req.query;
    if (!date && !(from && to)) return res.status(400).json({ ok:false, error:'Provide ?date= or ?from=&to=' });
    const email2name = {};
    (await D.getAgents()).forEach(a => email2name[a.email] = a.name);

    if (date) {
      const rows = await D.getStatsByDate(date);
      const breaks = await D.getBreakLog(date);
      return res.json({ ok:true, mode:'single', date,
        rows: rows.map(r => ({ ...r, name: email2name[r.agent_email] || r.agent_email })),
        breaks,
      });
    }

    if (from && to) {
      const rows = await D.getStatsRange(from, to, agent || null);
      // Aggregate per agent + per day for charts
      const byAgent = {}; // email -> totals
      const byDay = {};   // date -> { newTickets, resolved, closed }
      for (const r of rows) {
        const a = byAgent[r.agent_email] = byAgent[r.agent_email] || {
          name: email2name[r.agent_email] || r.agent_email,
          newTickets:0, resolved:0, closed:0, responseDue:0,
          avgRespSum:0, avgRespN:0, firstReplySum:0, firstReplyN:0, days:0,
        };
        a.newTickets += r.new_tickets||0; a.resolved += r.resolved||0;
        a.closed += r.closed||0; a.responseDue += r.response_due||0;
        if (r.avg_response_min) { a.avgRespSum += +r.avg_response_min; a.avgRespN++; }
        if (r.first_reply_min) { a.firstReplySum += +r.first_reply_min; a.firstReplyN++; }
        a.days++;

        const d = byDay[r.stat_date] = byDay[r.stat_date] || { date:r.stat_date, newTickets:0, resolved:0, closed:0 };
        d.newTickets += r.new_tickets||0; d.resolved += r.resolved||0; d.closed += r.closed||0;
      }
      // reply times over the whole range from the stored replies (weighted, working hours)
      const respEvents = await D.getResponseEventsRange(from, to).catch(() => null);
      const agentTotals = Object.entries(byAgent).map(([email,a]) => {
        const rt = respEvents ? RS.responseTotals(respEvents.filter(e => e.agent_email === email)) : null;
        return {
          email, name:a.name, newTickets:a.newTickets, resolved:a.resolved, closed:a.closed,
          responseDue:a.responseDue,
          avgResponseMin: rt ? rt.avgResponseMin : (a.avgRespN ? +(a.avgRespSum/a.avgRespN).toFixed(1) : 0),
          firstReplyMin: rt ? rt.firstReplyMin : (a.firstReplyN ? +(a.firstReplySum/a.firstReplyN).toFixed(1) : 0),
          days:a.days,
        };
      });
      const dayTrend = Object.values(byDay).sort((x,y)=>x.date.localeCompare(y.date));
      const breaks = await D.getBreakLogRange(from, to);
      return res.json({ ok:true, mode:'range', from, to, agent: agent||null,
        rows: rows.map(r => ({ ...r, name: email2name[r.agent_email] || r.agent_email })),
        agentTotals, dayTrend, breaks });
    }

    res.status(400).json({ ok:false, error:'Provide ?date= or ?from=&to=' });
  } catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

// ── REPORTS ──
// Generate (compute + store) reports for a month for all agents
app.post('/api/reports/generate', authMw, async (req,res)=>{
  try {
    const { month, selected } = req.body || {};
    const monthKey = month || new Date().toISOString().slice(0,7);
    const reports = await R.buildMonthlyReports(monthKey, { selected });
    for (const rep of reports) await D.saveReport(monthKey, rep.email, rep.name, rep);
    res.json({ ok:true, month: monthKey, count: reports.length });
  } catch(e){ console.error(e.message); res.status(500).json({ok:false,error:e.message}); }
});

// List months that have stored reports
app.get('/api/reports/months', authMw, async (req,res)=>{
  try { res.json({ ok:true, months: await D.getReportMonths() }); }
  catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

// List stored reports for a month (summary, no PDF)
app.get('/api/reports', authMw, async (req,res)=>{
  try {
    const month = req.query.month || new Date().toISOString().slice(0,7);
    const rows = await D.getReports(month);
    res.json({ ok:true, month, reports: rows.map(r=>({ email:r.agent_email, name:r.agent_name, generatedAt:r.generated_at, totals:r.payload?.totals, concerns:r.payload?.concerns, flags:r.payload?.flags })) });
  } catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

// Custom date range (?from=YYYY-MM-DD&to=YYYY-MM-DD[&sections=a,b]) — computed on
// the fly, never stored. Returns null when no range was given, or { error }.
const MAX_RANGE_DAYS = 366;
function parseRange(q) {
  if (!q.from && !q.to) return null;
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!iso.test(q.from||'') || !iso.test(q.to||'') || isNaN(Date.parse(q.from)) || isNaN(Date.parse(q.to)))
    return { error:'from and to must be dates (YYYY-MM-DD)' };
  if (q.from > q.to) return { error:'from must be on or before to' };
  if ((Date.parse(q.to) - Date.parse(q.from)) / 86400000 + 1 > MAX_RANGE_DAYS) return { error:`Range is limited to ${MAX_RANGE_DAYS} days` };
  const selected = q.sections ? String(q.sections).split(',').map(s=>s.trim()).filter(Boolean) : undefined;
  return { from:q.from, to:q.to, selected };
}

// Reports for a custom date range (summary rows, same shape as /api/reports)
app.get('/api/reports/range', authMw, async (req,res)=>{
  try {
    const range = parseRange(req.query);
    if (!range || range.error) return res.status(400).json({ok:false,error:range?.error||'from and to required'});
    const reports = await R.buildRangeReports(range.from, range.to, { selected: range.selected });
    res.json({ ok:true, from:range.from, to:range.to, reports: reports.map(r=>({ email:r.email, name:r.name, totals:r.totals, concerns:r.concerns, flags:r.flags })) });
  } catch(e){ console.error(e.message); res.status(500).json({ok:false,error:e.message}); }
});

// Download a single agent's PDF for a month (stored) or a custom range (computed)
app.get('/api/reports/pdf', authMw, async (req,res)=>{
  try {
    const { month, agent } = req.query;
    const range = parseRange(req.query);
    if (range?.error) return res.status(400).json({ok:false,error:range.error});
    if ((!month && !range) || !agent) return res.status(400).json({ok:false,error:'month (or from/to) and agent required'});
    const email = agent.toLowerCase().trim();
    let payload;
    if (range) {
      payload = (await R.buildRangeReports(range.from, range.to, { selected: range.selected })).find(r => r.email === email);
      if (!payload) return res.status(404).json({ok:false,error:'Agent not found'});
    } else {
      const row = (await D.getReports(month)).find(r => r.agent_email === email);
      if (!row) return res.status(404).json({ok:false,error:'Report not found — generate it first'});
      payload = row.payload;
    }
    const pdf = await R.generatePDF(payload);
    const period = range ? `${range.from}_to_${range.to}` : month;
    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition',`attachment; filename="report-${agent}-${period}.pdf"`);
    res.send(pdf);
  } catch(e){ console.error(e.message); res.status(500).json({ok:false,error:e.message}); }
});

// Download one PDF covering all agents for a month (stored) or a custom range (computed)
app.get('/api/reports/team-pdf', authMw, async (req,res)=>{
  try {
    const { month } = req.query;
    const range = parseRange(req.query);
    if (range?.error) return res.status(400).json({ok:false,error:range.error});
    if (!month && !range) return res.status(400).json({ok:false,error:'month (or from/to) required'});
    const [payloads, thRows] = await Promise.all([
      range ? R.buildRangeReports(range.from, range.to, { selected: range.selected })
            : D.getReports(month).then(rows => rows.map(r => r.payload)),
      D.getThresholds(),
    ]);
    if (!payloads.length) return res.status(404).json({ok:false,error: range ? 'No agents found' : 'No reports for this month — generate them first'});
    const thresholds = R.thresholdsFromRows(thRows);
    const pdf = await R.generateTeamPDF(month || range.from.slice(0,7), payloads, thresholds);
    const period = range ? `${range.from}_to_${range.to}` : month;
    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition',`attachment; filename="team-report-${period}.pdf"`);
    res.send(pdf);
  } catch(e){ console.error(e.message); res.status(500).json({ok:false,error:e.message}); }
});

// Download one PDF covering every ticket group, for a month or a custom range.
// Always computed from group_daily_stats (nothing stored, no Generate step).
app.get('/api/reports/group-pdf', authMw, async (req,res)=>{
  try {
    const { month } = req.query;
    const range = parseRange(req.query);
    if (range?.error) return res.status(400).json({ok:false,error:range.error});
    if (!range && !/^\d{4}-\d{2}$/.test(month||'')) return res.status(400).json({ok:false,error:'month (or from/to) required'});
    const { fromDate, toDate } = range ? { fromDate:range.from, toDate:range.to } : R.monthBounds(month);
    const [data, thRows] = await Promise.all([R.buildGroupReports(fromDate, toDate), D.getThresholds()]);
    const thresholds = R.thresholdsFromRows(thRows);
    const pdf = await R.generateGroupPDF(data, { monthKey: range ? null : month, thresholds });
    const period = range ? `${range.from}_to_${range.to}` : month;
    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition',`attachment; filename="group-report-${period}.pdf"`);
    res.send(pdf);
  } catch(e){
    console.error(e.message);
    if (/group_daily_stats/.test(e.message) && /schema cache|does not exist/.test(e.message))
      return res.status(503).json({ok:false,error:'Group stats table is not set up yet — run the group_daily_stats SQL from db/schema.sql in Supabase'});
    res.status(500).json({ok:false,error:e.message});
  }
});

// ── QUALITY TAB ──
// Both views take ?from=YYYY-MM-DD&to=YYYY-MM-DD (dates in DISPLAY_TZ).
function qualityRange(q) {
  const r = parseRange(q);
  if (!r) return { error:'from and to required' };
  return r;
}
const agentNames = async () => { const m = {}; (await D.getAgents()).forEach(a => m[a.email.toLowerCase()] = a.name || a.email); return m; };

// Empathy: summary per agent + flagged tickets (from empathy_checks)
app.get('/api/quality/empathy', authMw, async (req,res)=>{
  try {
    const range = qualityRange(req.query);
    if (range.error) return res.status(400).json({ok:false,error:range.error});
    const [rows, names] = await Promise.all([D.getEmpathyRange(range.from, range.to), agentNames()]);
    // per-agent totals use the same rules as the PDF reports (api/quality.js)
    const byEmail = {};
    for (const email of Object.keys(names)) byEmail[email] = [];
    for (const r of rows) (byEmail[r.agent_email] = byEmail[r.agent_email] || []).push(r);
    const agents = Object.entries(byEmail).map(([email, list]) => {
      const t = Q.empathyTotals(list);
      return { email, name: names[email] || list[0]?.agent_name || email, checked:t.checked, reviewed:t.reviewed,
        frustrated:t.upset, acknowledged:t.acknowledged, flagged:t.missed, flaggedPct:t.missedPct ?? 0 };
    }).sort((a, b) => b.flagged - a.flagged || b.checked - a.checked || a.name.localeCompare(b.name));
    const reviewed = (r) => Q.empathyVerdict(r).reviewed;
    const flagged = rows.filter(r => Q.empathyVerdict(r).missed).map(r => ({
      ticketId:r.ticket_id, url:r.ticket_url, subject:r.subject, email:r.agent_email, name:r.agent_name,
      status:r.status, resolvedAt:r.resolved_at, source: reviewed(r) ? 'claude' : 'quick',
      // quick check
      missing:r.missing, frustrated:r.frustrated, findings:r.findings || [],
      // Claude review
      summary:r.summary, reason:r.ai_reason, evidence:r.ai_evidence || [], reviewedAt:r.reviewed_at,
    }));
    res.json({ ok:true, from:range.from, to:range.to, checked:rows.length, reviewed:rows.filter(reviewed).length, agents, flagged });
  } catch(e){
    if (/empathy_checks/.test(e.message) && /schema cache/.test(e.message))
      return res.status(503).json({ok:false,error:'Empathy table is not set up yet — run the empathy_checks SQL from db/schema.sql in Supabase'});
    res.status(500).json({ok:false,error:e.message});
  }
});

// CSAT: Freshdesk satisfaction ratings, read live (api/quality.js).
app.get('/api/quality/csat', authMw, async (req,res)=>{
  try {
    const range = qualityRange(req.query);
    if (range.error) return res.status(400).json({ok:false,error:range.error});
    const [ratings, names] = await Promise.all([Q.fetchCsatRatings(range.from, range.to), agentNames()]);
    const tracked = ratings.filter(r => r.email && names[r.email]);
    const agents = Object.keys(names).map(email => ({ email, name:names[email], ...Q.csatTotals(tracked.filter(r => r.email === email)) }))
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
    const negatives = tracked.filter(r => r.tone === 'negative').map(r => ({ ticketId:r.ticketId, url:ticketUrl(r.ticketId),
      email:r.email, name:names[r.email], createdAt:r.createdAt, feedback:r.feedback }));
    const other = ratings.length - tracked.length;   // ratings for agents not tracked here
    negatives.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    res.json({ ok:true, from:range.from, to:range.to, agents, negatives, otherAgents:other });
  } catch(e){ console.error('csat:', e.message); res.status(500).json({ok:false,error:e.message}); }
});

// ── HOURLY TAB: one agent's day hour by hour (api/hourly.js) ──
app.get('/api/hourly', authMw, async (req,res)=>{
  try {
    const { date, agent } = req.query;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !agent) return res.status(400).json({ok:false,error:'date (YYYY-MM-DD) and agent required'});
    res.json({ ok:true, ...(await HR.buildHourly(date, agent)) });
  } catch(e){ console.error('hourly:', e.message); res.status(500).json({ok:false,error:e.message}); }
});

// ── THRESHOLDS ──
app.get('/api/thresholds', authMw, async (req,res)=>{
  try {
    res.json({ ok:true, thresholds: R.thresholdsFromRows(await D.getThresholds()) });
  } catch(e){ res.status(500).json({ok:false,error:e.message}); }
});
// body: { metric, ranges: { green:{min,max}, yellow:{min,max}, red:{min,max} } }, null = no limit
app.post('/api/thresholds', authMw, async (req,res)=>{
  try {
    const { metric, ranges } = req.body || {};
    if (!R.DEFAULT_THRESHOLDS[metric]) return res.status(400).json({ok:false,error:'Unknown metric'});
    const clean = {};
    for (const color of ['green','yellow','red']) {
      const r = ranges?.[color] || {};
      const num = (v) => v === '' || v == null ? null : Number(v);
      const min = num(r.min), max = num(r.max);
      if ([min, max].some(v => v != null && !Number.isFinite(v))) return res.status(400).json({ok:false,error:`${color}: min and max must be numbers or empty`});
      if (min != null && max != null && min > max) return res.status(400).json({ok:false,error:`${color}: min is greater than max`});
      clean[color] = { min, max };
    }
    await D.setThresholdRanges(metric, clean);
    res.json({ok:true, ranges:clean});
  } catch(e){
    if (/ranges/.test(e.message) && /schema cache|column/.test(e.message))
      return res.status(503).json({ok:false,error:'Run the report_thresholds "ranges" SQL from db/schema.sql in Supabase first'});
    res.status(500).json({ok:false,error:e.message});
  }
});

// ── LATE SHIFTS (live view) ──
app.get('/api/late-shifts', authMw, async (req,res)=>{
  try { const month = req.query.month || new Date().toISOString().slice(0,7); res.json({ ok:true, month, lateShifts: await D.getLateShifts(month, req.query.agent||null) }); }
  catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

// ── IDLE LOG (inactive periods during shift) ──
app.get('/api/idle-log', authMw, async (req,res)=>{
  try {
    const agent = req.query.agent||null;
    const rows = req.query.month
      ? await D.getIdleRange(req.query.month, agent)
      : await D.getIdleLog(req.query.date || new Date().toISOString().split('T')[0], agent);
    const enriched = rows.map(r=>({
      ...r,
      from: r.idle_start ? new Date(r.idle_start).toLocaleString('en-US',{timeZone:TZ,hour12:true,month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '—',
      to:   r.idle_end   ? new Date(r.idle_end).toLocaleString('en-US',{timeZone:TZ,hour12:true,month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '—',
    }));
    res.json({ ok:true, idle: enriched });
  } catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

app.get('/api/config', (req,res)=>res.json({ threshold:THRESHOLD_MIN, pollMins:POLL_MIN, tz:TZ }));

app.post('/api/cron', async (req,res)=>{
  if (process.env.CRON_SECRET && req.headers['x-cron-secret']!==process.env.CRON_SECRET) return res.status(401).json({ok:false});
  try {
    const r=await runPoll();
    // Month-end auto-generate: on the 1st of the month, generate previous month's reports once.
    let reportGen = null;
    const nowD = new Date();
    if (nowD.getUTCDate() === 1) {
      const prev = new Date(Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth()-1, 1));
      const monthKey = prev.toISOString().slice(0,7);
      try {
        const existing = await D.getReports(monthKey);
        if (!existing.length) {
          const reps = await R.buildMonthlyReports(monthKey, {});
          for (const rep of reps) await D.saveReport(monthKey, rep.email, rep.name, rep);
          reportGen = { month: monthKey, count: reps.length };
        }
      } catch (e) { console.error('auto report:', e.message); }
    }
    let empathy = null;
    try { empathy = await runEmpathyChecks(r.empathyCandidates); }
    catch (e) { console.error('empathy:', e.message); }
    res.json({ok:true, checked:r.agents.length, reportGen, empathy});
  }
  catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

app.get('*', (req,res)=>res.sendFile(path.join(__dirname,'../public/index.html')));

function fmtTime(ts){ return new Date(ts).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:true,timeZone:TZ}); }

module.exports = app;
