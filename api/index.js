// api/index.js — Vercel Serverless Entry
// Freshdesk + Deputy + Slack + Supabase
require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const path    = require('path');
const crypto  = require('crypto');
const D        = require('./db');
const R        = require('./report');

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

  const [fdAgentList, schedule, liveBreaks, empIdMap, statusChoices, normalTimes] = await Promise.all([
    fdAgents(), getSchedule(activeEmails), depLiveBreaks(), depEmpIdByEmail(activeEmails), fdTicketFields(), getNormalShiftTimes(activeEmails),
  ]);

  const agents = fdAgentList.filter(a => activeEmails.includes((a.contact?.email||'').toLowerCase().trim()));
  const id2email = {}; agents.forEach(a => id2email[a.id] = (a.contact?.email||'').toLowerCase().trim());
  const monitoredIds = agents.map(a => a.id);
  const email2name = {}; allAgents.forEach(a => email2name[a.email] = a.name);

  const tickets = await fdTicketsSince(new Date(now - 24*3600000).toISOString());

  const statusAgentMap = {};
  for (const s of trackedStatuses) statusAgentMap[s.label.toLowerCase()] = new Set((s.agents||[]).map(e=>e.toLowerCase()));

  const metrics = {};
  for (const a of agents) metrics[id2email[a.id]] = {
    lastSeen:0, newTickets:0, resolved:0, closed:0,
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

  // Map each agent -> today's shift start (for late-shift detection)
  const todayShiftStart = {};
  for (const a of agents) {
    const email = id2email[a.id];
    const sEntry = schedule[email];
    if (sEntry && sEntry.shifts && sEntry.shifts.length) {
      const todayShifts = sEntry.shifts.filter(s => {
        const d = new Date(s.startTs).toISOString().split('T')[0];
        return d === new Date().toISOString().split('T')[0];
      });
      if (todayShifts.length) todayShiftStart[email] = Math.min(...todayShifts.map(s=>s.startTs));
    }
  }

  // Existing overdue rows (one query) so the per-ticket loop only touches the DB
  // when something actually changes — not once per ticket.
  let existingOverdue = new Set();
  try { existingOverdue = new Set((await D.getOverdue({})).map(r => r.ticket_id)); }
  catch (e) { console.error('getOverdue:', e.message); }
  const overdueOps = { upsert: [], replied: [], del: [] };

  for (const t of tickets) {
    const respId = t.responder_id;
    if (!monitoredIds.includes(respId)) continue;
    const email = id2email[respId]; if (!email) continue;
    const m = metrics[email];
    const winStart = windowStart[email] || (now - 24*3600000);

    const upd = new Date(t.updated_at).getTime();
    const cre = new Date(t.created_at).getTime();
    if (upd > m.lastSeen) m.lastSeen = upd;
    const sStart = todayShiftStart[email];
    if (sStart && upd >= sStart) { if (!m.firstActivityInShift || upd < m.firstActivityInShift) m.firstActivityInShift = upd; }
    if (cre >= winStart) m.newTickets++;

    const label = (statusChoices?.[t.status] || '').toString().toLowerCase();
    if ((t.status===4 || label.includes('resolved')) && upd>=winStart) m.resolved++;
    if ((t.status===5 || label.includes('closed'))   && upd>=winStart) m.closed++;

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
      if (fr>=0) { m.frSum+=fr; m.frCount++; m.respSum+=fr; m.respCount++; }
    }

    // Freshdesk stats name these agent_responded_at / requester_responded_at.
    const closedOrResolved = t.status === 4 || t.status === 5;
    const agentRespAt = st.agent_responded_at ? new Date(st.agent_responded_at).getTime() : 0;
    const reqRespAt   = st.requester_responded_at ? new Date(st.requester_responded_at).getTime() : 0;
    const awaitingReply = reqRespAt > agentRespAt;   // requester's latest message is unanswered

    // ── Response-due SLA metric (reports only) — uses Freshdesk's due fields ──
    const frDue = st.fr_due_by || t.fr_due_by;
    const nrDue = t.nr_due_by || st.next_response_due_by;
    if ((frDue && !st.first_responded_at) || (nrDue && awaitingReply)) m.slaDue++;
    const slaMissed = !closedOrResolved && (
      (!st.first_responded_at && frDue && new Date(frDue).getTime() < now) ||
      (awaitingReply && nrDue && new Date(nrDue).getTime() < now));
    if (slaMissed) m.slaBreached++;

    // ── Overdue LOG ──
    // Wait time is measured from when the customer STARTED waiting (their last
    // unanswered message, or ticket creation if never first-answered). A ticket
    // is logged only once that wait passes OVERDUE_MS (24h); we store that anchor
    // so the live view shows the ACTUAL elapsed time — not time-since-SLA-due.
    const awaitingSince = awaitingReply ? reqRespAt
                        : (!st.first_responded_at ? new Date(t.created_at).getTime() : 0);
    const waitedMs = awaitingSince ? now - awaitingSince : 0;
    const isOverdue = !closedOrResolved && awaitingSince > 0 && waitedMs >= OVERDUE_MS;
    if (isOverdue) m.responseDue++;

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

  // Apply overdue-log changes in parallel (only the rows that actually changed).
  await Promise.all([
    ...overdueOps.upsert.map(r => D.upsertOverdue(r).catch(e=>console.error('upsertOverdue:',e.message))),
    ...overdueOps.replied.map(([id,ts]) => D.markReplied(id,ts).catch(e=>console.error('markReplied:',e.message))),
    ...overdueOps.del.map(id => D.deleteOverdue(id).catch(e=>console.error('deleteOverdue:',e.message))),
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
    const idleMs = lastSeen ? now-lastSeen : null;
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
        avg_response_min: m.respCount?+(m.respSum/m.respCount).toFixed(1):0,
        first_reply_min: m.frCount?+(m.frSum/m.frCount).toFixed(1):0,
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

    // ── LATE SHIFT detection ──
    // If agent has a shift today and their first activity (lastSeen window) began
    // after shift start + grace, log a late shift for today.
    if (ms.shift) {
      const graceMs = (parseInt(process.env.LATE_GRACE_MINUTES||5))*60000;
      // earliest activity we can see this shift = the agent's lastSeen if within shift,
      // but better: use first ticket activity at/after shift start. We approximate with
      // the earliest ticket update for this agent at/after shift start.
      const firstActivity = m.firstActivityInShift || null;
      if (firstActivity && firstActivity > ms.shift.startTs + graceMs) {
        const lateMin = Math.round((firstActivity - ms.shift.startTs)/60000);
        try {
          await D.logLateShift({
            agent_email: email, agent_name: name, log_date: today, month_key: today.slice(0,7),
            scheduled_start: new Date(ms.shift.startTs).toISOString(),
            actual_start: new Date(firstActivity).toISOString(),
            late_min: lateMin,
          });
        } catch (e) { console.error('lateShift:', e.message); }
      }
    }

    // ── IDLE LOG: record inactive episodes during shift (not on break) ──
    // idle_start = last ticket activity (or shift start if none); the episode
    // extends each poll while still idle. Only while genuinely on-shift.
    if (ms.monitor && (idleMs == null || idleMs >= threshold)) {
      const idleStartTs = lastSeen || (ms.shift ? ms.shift.startTs : winStart);
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
        avgResponseMin: m.respCount?+(m.respSum/m.respCount).toFixed(1):0,
        firstReplyMin: m.frCount?+(m.frSum/m.frCount).toFixed(1):0,
        responseDue: m.responseDue, custom: m.custom,
      },
    });
  }

  mem.lastChecked = new Date().toISOString();
  return { agents: results };
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
      const agentTotals = Object.entries(byAgent).map(([email,a]) => ({
        email, name:a.name, newTickets:a.newTickets, resolved:a.resolved, closed:a.closed,
        responseDue:a.responseDue,
        avgResponseMin: a.avgRespN ? +(a.avgRespSum/a.avgRespN).toFixed(1) : 0,
        firstReplyMin: a.firstReplyN ? +(a.firstReplySum/a.firstReplyN).toFixed(1) : 0,
        days:a.days,
      }));
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

// Download a single agent's PDF for a month
app.get('/api/reports/pdf', authMw, async (req,res)=>{
  try {
    const { month, agent } = req.query;
    if (!month || !agent) return res.status(400).json({ok:false,error:'month and agent required'});
    const rows = await D.getReports(month);
    const row = rows.find(r => r.agent_email === agent.toLowerCase().trim());
    if (!row) return res.status(404).json({ok:false,error:'Report not found — generate it first'});
    const pdf = await R.generatePDF(row.payload);
    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition',`attachment; filename="report-${agent}-${month}.pdf"`);
    res.send(pdf);
  } catch(e){ console.error(e.message); res.status(500).json({ok:false,error:e.message}); }
});

// ── THRESHOLDS ──
app.get('/api/thresholds', authMw, async (req,res)=>{
  try {
    const rows = await D.getThresholds();
    const merged = { ...R.DEFAULT_THRESHOLDS };
    for (const r of rows) merged[r.metric] = { green_max:+r.green_max, yellow_max:+r.yellow_max };
    res.json({ ok:true, thresholds: merged });
  } catch(e){ res.status(500).json({ok:false,error:e.message}); }
});
app.post('/api/thresholds', authMw, async (req,res)=>{
  try { const { metric, greenMax, yellowMax } = req.body; await D.setThreshold(metric, greenMax, yellowMax); res.json({ok:true}); }
  catch(e){ res.status(500).json({ok:false,error:e.message}); }
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

app.get('/api/config', (req,res)=>res.json({ threshold:THRESHOLD_MIN, pollMins:POLL_MIN }));

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
    res.json({ok:true, checked:r.agents.length, reportGen});
  }
  catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

app.get('*', (req,res)=>res.sendFile(path.join(__dirname,'../public/index.html')));

function fmtTime(ts){ return new Date(ts).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:true,timeZone:TZ}); }

module.exports = app;
