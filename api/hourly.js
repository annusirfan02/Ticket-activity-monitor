// api/hourly.js — one agent's day, hour by hour (Hourly tab).
//
// For each rostered shift that starts on the chosen date (DISPLAY_TZ), the shift
// is split into hours from its start. Per hour:
//   open      — tickets in Open status at the start of the hour (hourly snapshot)
//   replies   — replies sent to customers in the hour, and their average
//               working-hours reply time (response_events)
//   breakMin  — minutes on break (Deputy timesheet), idleMin — minutes idle (idle_log)
// In the LAST hour of a shift, tickets opened during that hour are left out of
// the replies and reply time (an agent can't be expected to clear them before
// the shift ends), going by the ticket's created_at in Freshdesk.
const axios = require('axios');
const D = require('./db');
const A = require('./attendance');
const RS = require('./responses');

const depBase = () => `https://${process.env.DEPUTY_DOMAIN}/api/v1`;
const depHeaders = () => ({ Authorization: `Bearer ${process.env.DEPUTY_ACCESS_TOKEN}`, 'Content-Type': 'application/json', 'dp-meta-option': 'none' });
const fdBase = () => `https://${process.env.FRESHDESK_DOMAIN}/api/v2`;
const fdHeaders = () => ({ Authorization: 'Basic ' + Buffer.from(`${process.env.FRESHDESK_API_KEY}:X`).toString('base64') });
const HOUR = 3600000, DAY = 86400000;

// ticket id -> created_at (ms) from Freshdesk; a ticket that can't be read is left out
async function ticketCreatedAt(ids) {
  const out = {};
  await Promise.all([...ids].map(async id => {
    try { const { data } = await axios.get(`${fdBase()}/tickets/${id}`, { headers: fdHeaders(), timeout: 15000 }); out[id] = Date.parse(data.created_at); }
    catch (e) { console.error(`hourly: ticket ${id}:`, e.response?.status || e.message); }
  }));
  return out;
}
const overlapMin = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)) / 60000;
const dayShift = (date, n) => new Date(Date.parse(date + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);

async function depQuery(resource, search) {
  const { data } = await axios.post(`${depBase()}/resource/${resource}/QUERY`, { search, max: 500 }, { headers: depHeaders(), timeout: 30000 });
  return data || [];
}

// Actual breaks from a timesheet: MealbreakSlots is { unixSeconds: 'OUT'|'IN' }.
function timesheetBreaks(t) {
  const out = [];
  if (t.MealbreakSlots && typeof t.MealbreakSlots === 'object') {
    const marks = Object.entries(t.MealbreakSlots).map(([k, v]) => ({ at: +k * 1000, kind: String(v).toUpperCase() })).sort((x, y) => x.at - y.at);
    let open = null;
    for (const m of marks) {
      if (m.kind === 'OUT') open = m.at;
      else if (m.kind === 'IN' && open != null) { out.push({ start: open, end: m.at }); open = null; }
    }
    if (open != null) out.push({ start: open, end: Math.min(Date.now(), (t.EndTime || 0) * 1000 || Date.now()), ongoing: true });
  }
  return out;
}

async function buildHourly(date, email) {
  email = email.toLowerCase().trim();
  const ids = await RS.deputyIdsByEmail([email]);
  const empId = ids[email];
  if (!empId) return { date, email, shifts: [], note: 'Agent not found in Deputy' };
  const search = { s1:{field:'Employee',type:'eq',data:empId}, s2:{field:'Date',type:'ge',data:dayShift(date, -1)}, s3:{field:'Date',type:'le',data:dayShift(date, 1)} };
  const [rosters, sheets] = await Promise.all([depQuery('Roster', search), depQuery('Timesheet', search)]);
  const shifts = rosters.filter(r => r.StartTime && r.EndTime && r.Published !== false && A.shiftDate(r.StartTime * 1000) === date)
    .map(r => ({ start: r.StartTime * 1000, end: r.EndTime * 1000,
      plannedBreaks: (r.Slots || []).filter(s => s.strType === 'B' && !s.blnEmptySlot && s.intUnixStart && s.intUnixEnd)
        .map(s => ({ start: s.intUnixStart * 1000, end: s.intUnixEnd * 1000 })) }))
    .sort((a, b) => a.start - b.start);
  if (!shifts.length) return { date, email, shifts: [], note: 'No rostered shift on this date' };

  const from = shifts[0].start - HOUR, to = shifts[shifts.length - 1].end;
  const [snaps, events, idle] = await Promise.all([
    D.getOpenSnapshots(email, new Date(from).toISOString(), new Date(to).toISOString()).catch(() => null),
    D.getAgentResponseEvents(email, new Date(from).toISOString(), new Date(to).toISOString()).catch(() => null),
    D.getIdleOverlapping(email, new Date(from).toISOString(), new Date(to).toISOString()).catch(() => []),
  ]);
  const actualBreaks = sheets.flatMap(timesheetBreaks);
  const clockIns = sheets.filter(t => t.StartTime).map(t => ({ start: t.StartTime * 1000, end: t.EndTime && !t.IsInProgress ? t.EndTime * 1000 : null }));

  // creation time of every ticket replied to in a shift's last hour
  const lastHourIds = new Set();
  for (const s of shifts) {
    const ls = s.start + Math.floor((s.end - 1 - s.start) / HOUR) * HOUR;
    for (const e of events || []) { const t = Date.parse(e.replied_at); if (t >= ls && t < s.end) lastHourIds.add(e.ticket_id); }
  }
  const created = lastHourIds.size ? await ticketCreatedAt(lastHourIds) : {};

  const out = shifts.map(s => {
    // hour slots from the shift start
    const slots = [];
    for (let h = s.start; h < s.end; h += HOUR) slots.push({ start: h, end: Math.min(h + HOUR, s.end) });
    const windowEnd = s.end;
    const lastStart = slots[slots.length - 1].start;
    // tickets opened in the shift's last hour: not counted in that hour
    const newInLast = new Set((events || []).filter(e => Date.parse(e.replied_at) >= lastStart && Date.parse(e.replied_at) < s.end
      && created[e.ticket_id] >= lastStart).map(e => e.ticket_id));
    const counted = (events || []).filter(e => !(Date.parse(e.replied_at) >= lastStart && newInLast.has(e.ticket_id)));
    const hours = slots.map(sl => {
      // snapshot taken closest to the start of the hour (within 40 min)
      const snap = (snaps || []).map(x => ({ x, d: Math.abs(Date.parse(x.snapshot_hour) - sl.start) }))
        .filter(o => o.d <= 40 * 60000).sort((p, q) => p.d - q.d)[0]?.x;
      const ev = counted.filter(e => { const t = Date.parse(e.replied_at); return t >= sl.start && t < sl.end; });
      const last = sl.start === lastStart;
      const rt = RS.responseTotals(ev);
      return {
        start: sl.start, end: sl.end, last,
        newExcluded: last ? newInLast.size : 0,
        open: snap ? snap.open_count : null,
        replies: events ? ev.length : null,
        avgReplyMin: ev.length ? rt.avgResponseMin : null,
        breakMin: Math.round(actualBreaks.reduce((n, b) => n + overlapMin(b.start, b.end, sl.start, sl.end), 0)),
        idleMin: Math.round(idle.reduce((n, i) => n + overlapMin(Date.parse(i.idle_start), Date.parse(i.idle_end), sl.start, sl.end), 0)),
      };
    });
    const withOpen = hours.filter(h => h.open != null);
    const shownEvents = counted.filter(e => { const t = Date.parse(e.replied_at); return t >= s.start && t < windowEnd; });
    const clip = (list) => list.map(x => ({ ...x, start: Math.max(x.start, s.start), end: Math.min(x.end, windowEnd) })).filter(x => x.end > x.start);
    return {
      start: s.start, end: s.end, shownUntil: windowEnd, hours,
      clockIn: clockIns.find(c => c.start >= s.start - 3 * HOUR && c.start <= s.end)?.start || null,
      summary: {
        hoursShown: hours.length,
        avgOpen: withOpen.length ? +(withOpen.reduce((n, h) => n + h.open, 0) / withOpen.length).toFixed(1) : null,
        snapshotsRecorded: withOpen.length,
        replies: events ? shownEvents.length : null,
        repliesPerHour: events && hours.length ? +(shownEvents.length / hours.length).toFixed(1) : null,
        avgReplyMin: shownEvents.length ? RS.responseTotals(shownEvents).avgResponseMin : null,
        breakMin: hours.reduce((n, h) => n + h.breakMin, 0),
        idleMin: hours.reduce((n, h) => n + h.idleMin, 0),
      },
      breaks: clip(actualBreaks),
      plannedBreaks: clip(s.plannedBreaks),
      idle: clip(idle.map(i => ({ start: Date.parse(i.idle_start), end: Date.parse(i.idle_end) }))),
    };
  });
  return { date, email, shifts: out, snapshotsAvailable: snaps != null };
}

module.exports = { buildHourly };
