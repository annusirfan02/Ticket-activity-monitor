// api/responses.js — reply-time measurement, shared by the poll and history recalculation.
//
// Each public agent reply that answers a waiting customer is one "response event":
//   wait starts at the customer's first unanswered message (or ticket creation)
//   and ends at the agent's reply. The first agent reply on a ticket is also its
//   "first reply". Times count only the replying agent's rostered Deputy shifts
//   (working hours): a message at 11 PM answered at 5 AM by an agent whose shift
//   starts at 4 AM counts as 60 minutes.
const axios = require('axios');
const A = require('./attendance');

const depBase = () => `https://${process.env.DEPUTY_DOMAIN}/api/v1`;
const depHeaders = () => ({ Authorization: `Bearer ${process.env.DEPUTY_ACCESS_TOKEN}`, 'Content-Type': 'application/json', 'dp-meta-option': 'none' });

/**
 * Reply events in one ticket. ticket: { id, created_at, source, group_id };
 * convs: Freshdesk conversations; agentEmail: Freshdesk user id -> tracked agent email.
 * Returns [{ ticket_id, agent_email, replied_at, wait_start, is_first, group_id }]
 * for replies by tracked agents only (other agents' replies still end a wait).
 */
function extractReplyEvents(ticket, convs, agentEmail) {
  const msgs = [
    // the description is the customer's first message, except on outbound emails (source 10)
    ...(ticket.source !== 10 ? [{ incoming: true, at: ticket.created_at }] : []),
    ...(convs || []).filter(c => !c.private).map(c => ({ incoming: !!c.incoming, at: c.created_at, userId: c.user_id })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const out = [];
  let waitingSince = null, firstDone = false;
  for (const m of msgs) {
    if (m.incoming) { if (waitingSince == null) waitingSince = m.at; continue; }
    const isFirst = !firstDone; firstDone = true;
    if (waitingSince != null) {
      const email = agentEmail[m.userId];
      if (email) out.push({ ticket_id: ticket.id, agent_email: email, replied_at: m.at, wait_start: waitingSince,
        is_first: isFirst, group_id: ticket.group_id || 0 });
      waitingSince = null;
    }
  }
  return out;
}

// Minutes of [start, end] that fall inside the given shifts ([{start, end}] ms).
function workingMinutes(startMs, endMs, shifts) {
  let ms = 0;
  for (const s of shifts || []) {
    const a = Math.max(startMs, s.start), b = Math.min(endMs, s.end);
    if (b > a) ms += b - a;
  }
  return +(ms / 60000).toFixed(1);
}

// Deputy employee id by (lower-case) email, for the given emails.
async function deputyIdsByEmail(emails) {
  const { data } = await axios.get(`${depBase()}/supervise/employee?max=500`, { headers: depHeaders(), timeout: 20000 });
  const want = new Set(emails.map(e => e.toLowerCase()));
  const out = {};
  for (const e of data || []) { const em = (e.Email || '').toLowerCase().trim(); if (want.has(em)) out[em] = e.Id; }
  return out;
}

/**
 * Published roster shifts per agent email between two dates (inclusive):
 * { email: [{ start, end }] } in ms. Queried in ~2-week chunks to stay under
 * Deputy's 500-row page.
 */
async function fetchShifts(fromDate, toDate, emails) {
  const ids = await deputyIdsByEmail(emails);
  const byId = {}; Object.entries(ids).forEach(([em, id]) => byId[id] = em);
  const out = {}; emails.forEach(e => out[e.toLowerCase()] = []);
  const day = 86400000;
  for (let s = Date.parse(fromDate + 'T00:00:00Z'); s <= Date.parse(toDate + 'T00:00:00Z'); s += 14 * day) {
    const f = new Date(s).toISOString().slice(0, 10), t = new Date(Math.min(s + 13 * day, Date.parse(toDate + 'T00:00:00Z'))).toISOString().slice(0, 10);
    const { data } = await axios.post(`${depBase()}/resource/Roster/QUERY`,
      { search: { s1:{field:'Date',type:'ge',data:f}, s2:{field:'Date',type:'le',data:t}, s3:{field:'Published',type:'eq',data:true} }, max:500 },
      { headers: depHeaders(), timeout: 30000 });
    for (const r of data || []) {
      const em = byId[r.Employee];
      if (em && r.StartTime && r.EndTime) out[em].push({ start: r.StartTime * 1000, end: r.EndTime * 1000 });
    }
  }
  // the same roster can come back in two chunks; keep one of each
  for (const em of Object.keys(out)) {
    const seen = new Set();
    out[em] = out[em].filter(s => { const k = `${s.start}-${s.end}`; if (seen.has(k)) return false; seen.add(k); return true; });
  }
  return out;
}

// Adds wait_calendar_min, wait_working_min and reply_date to events, using shifts by email.
function timeEvents(events, shiftsByEmail) {
  return events.map(e => {
    const s = Date.parse(e.wait_start), r = Date.parse(e.replied_at);
    return { ...e, wait_calendar_min: +((r - s) / 60000).toFixed(1),
      wait_working_min: shiftsByEmail ? workingMinutes(s, r, shiftsByEmail[e.agent_email]) : null,
      reply_date: A.shiftDate(r) };
  });
}

// Weighted averages over events: { avgResponseMin, responses, firstReplyMin, firstReplies }.
function responseTotals(events) {
  const timed = events.filter(e => e.wait_working_min != null);
  const first = timed.filter(e => e.is_first);
  const avg = (xs) => xs.length ? +(xs.reduce((s, e) => s + +e.wait_working_min, 0) / xs.length).toFixed(1) : 0;
  return { avgResponseMin: avg(timed), responses: timed.length, firstReplyMin: avg(first), firstReplies: first.length };
}

module.exports = { extractReplyEvents, workingMinutes, fetchShifts, deputyIdsByEmail, timeEvents, responseTotals };
