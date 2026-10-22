// api/report.js — month-end report computation + PDF generation
const PDFDocument = require('pdfkit');
const D = require('./db');
const Q = require('./quality');
const RS = require('./responses');

// Flag thresholds: for each metric a Green, Yellow and Red range, each with an
// optional min and max (null = no limit), editable in the dashboard and stored
// in report_thresholds.ranges. A value is checked against Green, then Yellow,
// then Red (bounds inclusive); a value that fits none gets no colour.
const R_ = (min, max) => ({ min, max });
const DEFAULT_THRESHOLDS = {
  late_shifts:        { green: R_(0, 1),     yellow: R_(1, 3),   red: R_(3, null) },    // days late
  off_breaks:         { green: R_(0, 1),     yellow: R_(1, 3),   red: R_(3, null) },    // off-schedule breaks
  avg_response:       { green: R_(0, 15),    yellow: R_(15, 30), red: R_(30, null) },   // minutes
  sla_breach_pct:     { green: R_(0, 5),     yellow: R_(5, 15),  red: R_(15, null) },   // percent
  csat_pct:           { green: R_(90, 100),  yellow: R_(75, 90), red: R_(0, 75) },      // percent positive
  empathy_missed_pct: { green: R_(0, 10),    yellow: R_(10, 25), red: R_(25, 100) },    // % of upset customers
};
// Older saved settings only had green_max / yellow_max; CSAT used them as minimums.
const HIGHER_IS_BETTER = new Set(['csat_pct']);
function legacyRanges(metric, g, y) {
  return HIGHER_IS_BETTER.has(metric)
    ? { green: R_(g, null), yellow: R_(y, g), red: R_(null, y) }
    : { green: R_(null, g), yellow: R_(g, y), red: R_(y, null) };
}
// report_thresholds rows -> { metric: { green, yellow, red } }, defaults filled in.
function thresholdsFromRows(rows = []) {
  const out = JSON.parse(JSON.stringify(DEFAULT_THRESHOLDS));
  for (const r of rows) {
    if (r.ranges && typeof r.ranges === 'object') out[r.metric] = r.ranges;
    else if (r.green_max != null && r.yellow_max != null) out[r.metric] = legacyRanges(r.metric, +r.green_max, +r.yellow_max);
  }
  return out;
}

const inRange = (v, r) => r && (r.min == null || v >= r.min) && (r.max == null || v <= r.max) && (r.min != null || r.max != null);
function flagFor(metric, value, thresholds) {
  const t = thresholds?.[metric] || DEFAULT_THRESHOLDS[metric];
  if (!t || value == null || Number.isNaN(+value)) return undefined;
  for (const color of ['green', 'yellow', 'red']) if (inRange(+value, t[color])) return color;
  return undefined;
}

/**
 * CSAT ratings and empathy checks for a period, for the reports. Each part is
 * null when not wanted, or { unavailable: message } if it couldn't be read, so
 * a Freshdesk hiccup never stops a report.
 */
async function loadCustomerExperience(fromDate, toDate, { csat = true, empathy = true } = {}) {
  const [csatRes, empRes] = await Promise.allSettled([
    csat ? Q.fetchCsatRatings(fromDate, toDate) : Promise.resolve(null),
    empathy ? D.getEmpathyRange(fromDate, toDate) : Promise.resolve(null),
  ]);
  const part = (r, label) => r.status === 'fulfilled' ? r.value
    : (console.error(`${label}:`, r.reason?.message), { unavailable: `${label} could not be loaded` });
  return { ratings: part(csatRes, 'CSAT'), empathyRows: part(empRes, 'Empathy') };
}
const cxList = (x) => Array.isArray(x) ? x : null;

// month boundaries
function monthBounds(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end   = new Date(Date.UTC(y, m, 0)); // last day of month
  return { fromDate: start.toISOString().split('T')[0], toDate: end.toISOString().split('T')[0], y, m };
}

// Split a date range (YYYY-MM-DD, inclusive) into week buckets (Mon-Sun),
// clipped to the range at both ends.
function weeksOfRange(fromDate, toDate) {
  const weeks = []; let cur = [];
  const end = new Date(toDate + 'T00:00:00Z').getTime();
  for (let ts = new Date(fromDate + 'T00:00:00Z').getTime(); ts <= end; ts += 86400000) {
    const date = new Date(ts);
    cur.push(date.toISOString().split('T')[0]);
    if (date.getUTCDay() === 0 || ts === end) { // Sunday or range end
      weeks.push({ label: `${cur[0]} → ${cur[cur.length-1]}`, days: [...cur] });
      cur = [];
    }
  }
  return weeks;
}

// Split a month into ISO week buckets (Mon-Sun) covering all days
function weeksOfMonth(monthKey) {
  const { fromDate, toDate } = monthBounds(monthKey);
  return weeksOfRange(fromDate, toDate);
}

/**
 * Build the full report data for ALL active agents for a given month.
 * options.selected = array of section keys to include (checkbox selection).
 */
async function buildMonthlyReports(monthKey, options = {}) {
  const { fromDate, toDate } = monthBounds(monthKey);
  return buildReports(fromDate, toDate, options, monthKey);
}

/**
 * Same as buildMonthlyReports but for any inclusive date range (not stored).
 * The payload carries `range: { from, to }` so the PDFs label the period.
 */
async function buildRangeReports(fromDate, toDate, options = {}) {
  return buildReports(fromDate, toDate, options, null);
}

async function buildReports(fromDate, toDate, options, monthKey) {
  const selected = options.selected || ['resolved_closed','a2p','ghl','custom','avg_response','first_reply','sla','late_shifts','off_breaks','csat','empathy'];

  // thresholds
  const thresholds = thresholdsFromRows(await D.getThresholds());

  // pull data
  const [agents, statsRange, slaRange, lateShifts, breakLogs, missedShifts, cx] = await Promise.all([
    D.getAgents(),
    D.getStatsRange(fromDate, toDate),
    D.getSlaRange(fromDate, toDate),
    monthKey ? D.getLateShifts(monthKey) : D.getLateShiftsRange(fromDate, toDate),
    D.getBreakLogRange(fromDate, toDate),
    D.getMissedShiftsRange(fromDate, toDate),
    // CSAT / empathy for the same period; stored with monthly reports as a snapshot
    loadCustomerExperience(fromDate, toDate, { csat: selected.includes('csat'), empathy: selected.includes('empathy') }),
  ]);
  const ratings = cxList(cx.ratings), empathyRows = cxList(cx.empathyRows);
  // reply times (working hours) from response_events; null -> fall back to the older daily figures
  const respEvents = await D.getResponseEventsRange(fromDate, toDate).catch(e => {
    if (!/schema cache/.test(e.message)) console.error('reply times:', e.message); return null; });

  const weeks = weeksOfRange(fromDate, toDate);
  const range = monthKey ? undefined : { from: fromDate, to: toDate };

  // index data by agent
  const byAgent = {};
  for (const a of agents) byAgent[a.email] = { email: a.email, name: a.name || a.email, stats: [], sla: [], late: [], breaks: [], missed: [] };
  for (const s of statsRange) (byAgent[s.agent_email] = byAgent[s.agent_email] || { email:s.agent_email, name:s.agent_email, stats:[], sla:[], late:[], breaks:[], missed:[] }).stats.push(s);
  for (const s of slaRange)   (byAgent[s.agent_email] || {}).sla?.push(s);
  for (const l of lateShifts) (byAgent[l.agent_email] || {}).late?.push(l);
  for (const b of breakLogs)  (byAgent[b.agent_email] || {}).breaks?.push(b);
  for (const x of missedShifts) (byAgent[x.agent_email] || {}).missed?.push(x);

  // compute team averages for comparison
  const teamAgg = { resolved:0, closed:0, avgRespSum:0, avgRespN:0, agents:0 };

  const reports = [];
  for (const email of Object.keys(byAgent)) {
    const a = byAgent[email];

    // weekly breakdown
    const weekly = weeks.map(w => {
      const wStats = a.stats.filter(s => w.days.includes(s.stat_date));
      const wSla   = a.sla.filter(s => w.days.includes(s.stat_date));
      const newT = sum(wStats,'new_tickets'), res = sum(wStats,'resolved'), cl = sum(wStats,'closed');
      const due = sum(wSla,'total_due'), br = sum(wSla,'breached');
      const wResp = respEvents ? RS.responseTotals(respEvents.filter(e => e.agent_email === email && w.days.includes(e.reply_date))) : null;
      const avgResp = wResp ? wResp.avgResponseMin : avg(wStats, 'avg_response_min');
      const firstReply = wResp ? wResp.firstReplyMin : avg(wStats, 'first_reply_min');
      // custom statuses for the week
      const custom = {};
      for (const s of wStats) for (const [k,v] of Object.entries(s.custom_counts||{})) custom[k]=(custom[k]||0)+(+v||0);
      return {
        label: w.label, newTickets:newT, resolved:res, closed:cl,
        avgResponseMin: avgResp, firstReplyMin: firstReply,
        responses: wResp?.responses ?? null, firstReplies: wResp?.firstReplies ?? null,
        slaDue: due, slaBreached: br,
        slaBreachPct: due ? +((br/due)*100).toFixed(1) : 0,
        custom,
      };
    });

    // month totals
    const totResolved = sum(a.stats,'resolved');
    const totClosed   = sum(a.stats,'closed');
    const totDue = sum(a.sla,'total_due'), totBreach = sum(a.sla,'breached');
    const slaBreachPct = totDue ? +((totBreach/totDue)*100).toFixed(1) : 0;
    const resp = respEvents ? RS.responseTotals(respEvents.filter(e => e.agent_email === email)) : null;
    const avgResp = resp ? resp.avgResponseMin : avg(a.stats,'avg_response_min');
    const firstReply = resp ? resp.firstReplyMin : avg(a.stats,'first_reply_min');
    const lateDays = a.late.length;
    const offBreaks = a.breaks.length;
    const customTotals = {};
    for (const s of a.stats) for (const [k,v] of Object.entries(s.custom_counts||{})) customTotals[k]=(customTotals[k]||0)+(+v||0);

    teamAgg.resolved += totResolved; teamAgg.closed += totClosed;
    if (avgResp) { teamAgg.avgRespSum += avgResp; teamAgg.avgRespN++; }
    teamAgg.agents++;

    // flags
    const flags = {
      late_shifts:    flagFor('late_shifts', lateDays, thresholds),
      off_breaks:     flagFor('off_breaks', offBreaks, thresholds),
      avg_response:   flagFor('avg_response', avgResp, thresholds),
      sla_breach_pct: flagFor('sla_breach_pct', slaBreachPct, thresholds),
    };
    // top concerns = red metrics
    const concerns = [];
    if (flags.late_shifts==='red') concerns.push(`${lateDays} late shifts`);
    if (flags.off_breaks==='red') concerns.push(`${offBreaks} off-schedule breaks`);
    if (flags.avg_response==='red') concerns.push(`${avgResp}m avg response`);
    if (flags.sla_breach_pct==='red') concerns.push(`${slaBreachPct}% response-SLA breach`);
    // shown with the attendance (late shifts) section
    const missedCount = a.missed.length;
    if (missedCount && selected.includes('late_shifts')) concerns.push(`${missedCount} shift${missedCount===1?'':'s'} with no clock-in`);

    // customer experience: CSAT ratings and empathy checks for this agent
    let csat = null, empathy = null;
    if (selected.includes('csat')) {
      csat = ratings ? Q.csatTotals(ratings.filter(r => r.email === email)) : { unavailable: cx.ratings?.unavailable };
      if (csat.csatPct != null) {
        flags.csat_pct = flagFor('csat_pct', csat.csatPct, thresholds);
        if (flags.csat_pct === 'red') concerns.push(`${csat.csatPct}% CSAT (${csat.negative} negative of ${csat.total})`);
      }
    }
    if (selected.includes('empathy')) {
      if (empathyRows) {
        const mine = empathyRows.filter(r => r.agent_email === email);
        empathy = { ...Q.empathyTotals(mine), missedList: Q.empathyMissedList(mine) };
      } else empathy = { unavailable: cx.empathyRows?.unavailable };
      if (empathy.missedPct != null) {
        flags.empathy_missed_pct = flagFor('empathy_missed_pct', empathy.missedPct, thresholds);
        if (flags.empathy_missed_pct === 'red') concerns.push(`empathy missed with ${empathy.missed} of ${empathy.upset} upset customers`);
      }
    }

    reports.push({
      email, name: a.name, monthKey, range,
      weekly,
      totals: {
        resolved: totResolved, closed: totClosed,
        avgResponseMin: avgResp, firstReplyMin: firstReply,
        responses: resp?.responses ?? null, firstReplies: resp?.firstReplies ?? null,
        slaDue: totDue, slaBreached: totBreach, slaBreachPct,
        lateShifts: lateDays, offBreaks, missedShifts: missedCount,
        custom: customTotals,
      },
      lateDetail: a.late.map(l=>({date:l.log_date, lateMin:l.late_min})),
      missedDetail: a.missed.map(x=>({ start:x.scheduled_start, end:x.scheduled_end })),
      breakDetail: a.breaks.map(b=>({date:b.log_date, lateMin:b.late_min})),
      csat, empathy,
      flags, concerns, selected,
    });
  }

  // team CSAT / empathy are over tracked agents' ratings and tickets only
  const tracked = new Set(Object.keys(byAgent));
  const teamAvg = {
    resolved: teamAgg.agents ? +(teamAgg.resolved/teamAgg.agents).toFixed(1) : 0,
    closed: teamAgg.agents ? +(teamAgg.closed/teamAgg.agents).toFixed(1) : 0,
    avgResponseMin: teamAgg.avgRespN ? +(teamAgg.avgRespSum/teamAgg.avgRespN).toFixed(1) : 0,
    // weighted over every reply by tracked agents (working hours)
    ...(respEvents ? (() => { const t = RS.responseTotals(respEvents.filter(e => tracked.has(e.agent_email)));
      return { avgResponseMin: t.avgResponseMin, firstReplyMin: t.firstReplyMin, responses: t.responses, firstReplies: t.firstReplies }; })() : {}),
    csat: ratings ? Q.csatTotals(ratings.filter(r => tracked.has(r.email))) : null,
    empathy: empathyRows ? Q.empathyTotals(empathyRows.filter(r => tracked.has(r.agent_email))) : null,
  };
  for (const r of reports) r.teamAvg = teamAvg;

  return reports;
}

function sum(arr, key){ return arr.reduce((s,x)=>s+(+x[key]||0),0); }
function avg(arr, key){ const v=arr.filter(x=>+x[key]>0); return v.length ? +(v.reduce((s,x)=>s+(+x[key]),0)/v.length).toFixed(1) : 0; }

// ── PDF GENERATION ──
// Standard PDF fonts only cover WinAnsi: no arrows/emoji/check marks — status
// is drawn with shapes and colour instead.
const FLAG_COLOR = { green:'#1a9d6a', yellow:'#d99400', red:'#d6334e' };
const FLAG_TINT  = { green:'#e8f6f0', yellow:'#fdf4e3', red:'#fdecee' };
const FLAG_LABEL = { green:'On target', yellow:'Watch', red:'Needs attention' };
const C = {
  brand:'#0f172a', brandSub:'#94a3b8', ink:'#111827', body:'#374151', muted:'#6b7280',
  faint:'#9ca3af', line:'#e5e7eb', panel:'#f8fafc', head:'#f1f5f9', neutral:'#cbd5e1',
};

// 2029.6 → "1d 9h", 95 → "1h 35m", 12.4 → "12m"
function fmtMin(m) {
  m = +m || 0;
  if (!m) return '–';
  if (m < 60) return `${Math.round(m)}m`;
  const h = Math.floor(m / 60), r = Math.round(m % 60);
  if (h < 24) return r ? `${h}h ${r}m` : `${h}h`;
  const d = Math.floor(h / 24), hh = h % 24;
  return hh ? `${d}d ${hh}h` : `${d}d`;
}
const isoDate = (iso) => new Date(iso + 'T00:00:00Z');
const dayLabel = (iso, weekday = false) => isoDate(iso).toLocaleDateString('en-US',
  { timeZone:'UTC', month:'short', day:'numeric', ...(weekday ? { weekday:'short' } : {}) });
const monthLabel = (monthKey) => isoDate(monthKey + '-01').toLocaleDateString('en-US',
  { timeZone:'UTC', month:'long', year:'numeric' });
// Shift times are shown in DISPLAY_TZ, like the rest of the dashboard.
const REPORT_TZ = process.env.DISPLAY_TZ || 'America/Los_Angeles';
const shiftDayLabel = (iso) => new Date(iso).toLocaleDateString('en-US', { timeZone:REPORT_TZ, weekday:'short', month:'short', day:'numeric' });
const shiftTime = (iso) => iso ? new Date(iso).toLocaleTimeString('en-US', { timeZone:REPORT_TZ, hour:'2-digit', minute:'2-digit', hour12:false }) : '?';
const tzAbbr = () => new Date().toLocaleTimeString('en-US', { timeZone:REPORT_TZ, timeZoneName:'short' }).split(' ').pop();

// "Sep 15 – Oct 14, 2026" (years shown on both ends only when they differ)
function rangeLabel(from, to) {
  const opt = (withYear) => ({ timeZone:'UTC', month:'short', day:'numeric', ...(withYear ? { year:'numeric' } : {}) });
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  return `${isoDate(from).toLocaleDateString('en-US', opt(!sameYear))} – ${isoDate(to).toLocaleDateString('en-US', opt(true))}`;
}
// Report period: the month for stored monthly reports, else the custom range.
const periodLabel = (report, monthKey) => report?.range ? rangeLabel(report.range.from, report.range.to) : monthLabel(monthKey || report.monthKey);
function weekLabel(label) {
  const [a, b] = String(label).match(/\d{4}-\d{2}-\d{2}/g) || [];
  if (!a) return String(label);
  return !b || a === b ? dayLabel(a) : `${dayLabel(a)} – ${dayLabel(b)}`;
}

function generatePDF(report) {
  return new Promise((resolve, reject) => {
    const month = periodLabel(report);
    const unit = report.range ? 'period' : 'month';   // wording for custom ranges
    const Unit = unit[0].toUpperCase() + unit.slice(1);
    const doc = new PDFDocument({
      size:'A4', margin:40, bufferPages:true,
      info:{ Title:`Performance Report – ${report.name} – ${month}`, Author:'Activity Monitor' },
    });
    const chunks = [];
    doc.on('data', c=>chunks.push(c));
    doc.on('end', ()=>resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const sel = report.selected || [];
    const inc = (k)=>sel.includes(k);
    const t = report.totals || {}, f = report.flags || {}, ta = report.teamAvg || {};
    const M = 40, PW = doc.page.width, W = PW - 2*M, BOTTOM = doc.page.height - 56;
    let y = M;
    const ensure = (h) => { if (y + h > BOTTOM) { doc.addPage(); y = M; return true; } return false; };
    // `keep` = height of content that should stay on the same page as the title
    // (capped at a full page so long sections still flow).
    const sectionTitle = (title, note, keep = 30) => {
      ensure(Math.min(36 + keep, BOTTOM - M));
      y += 8;
      doc.font('Helvetica-Bold').fontSize(12).fillColor(C.ink).text(title, M, y, { lineBreak:false });
      if (note) doc.font('Helvetica').fontSize(8.5).fillColor(C.muted).text(note, M, y + 2, { width:W, align:'right', lineBreak:false });
      y += 18;
      doc.moveTo(M, y).lineTo(M + W, y).lineWidth(0.75).strokeColor(C.line).stroke();
      y += 10;
    };

    // ── Header band ──
    doc.rect(0, 0, PW, 104).fill(C.brand);
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.brandSub)
       .text(report.range ? 'PERFORMANCE REPORT' : 'MONTHLY PERFORMANCE REPORT', M, 30, { characterSpacing:1.5, lineBreak:false });
    doc.font('Helvetica-Bold').fontSize(22).fillColor('#ffffff').text(month, M, 46, { lineBreak:false });
    doc.font('Helvetica').fontSize(8.5).fillColor(C.brandSub)
       .text(`Generated ${new Date().toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })}`, M, 76, { lineBreak:false });
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#ffffff').text(report.name || report.email, M, 46, { width:W, align:'right', lineBreak:false });
    doc.font('Helvetica').fontSize(9.5).fillColor(C.brandSub).text(report.email || '', M, 64, { width:W, align:'right', lineBreak:false });
    y = 124;

    // ── Concerns callout (rebuilt from flags so durations format nicely) ──
    const concerns = [];
    if (inc('late_shifts')  && f.late_shifts === 'red')    concerns.push(['Late shifts', `${t.lateShifts} days started late`]);
    if (inc('off_breaks')   && f.off_breaks === 'red')     concerns.push(['Off-schedule breaks', `${t.offBreaks} breaks taken outside the schedule`]);
    if (inc('avg_response') && f.avg_response === 'red')   concerns.push(['Average response time', `${fmtMin(t.avgResponseMin)} on average`]);
    if (inc('sla')          && f.sla_breach_pct === 'red') concerns.push(['Response-SLA breach', `${t.slaBreachPct}% of due responses missed (${t.slaBreached} of ${t.slaDue})`]);
    if (inc('late_shifts')  && t.missedShifts) concerns.push(['No clock-in', `${t.missedShifts} rostered shift${t.missedShifts === 1 ? '' : 's'} with no clock-in and no leave`]);
    const cs = report.csat, em = report.empathy;   // absent on reports generated before these existed
    if (inc('csat') && f.csat_pct === 'red') concerns.push(['CSAT', `${cs.csatPct}% positive (${cs.negative} negative of ${cs.total} ratings)`]);
    if (inc('empathy') && f.empathy_missed_pct === 'red') concerns.push(['Empathy missed', `with ${em.missed} of ${em.upset} upset customers`]);
    {
      const tone = concerns.length ? 'red' : 'green';
      const h = concerns.length ? 34 + concerns.length * 16 : 36;
      doc.roundedRect(M, y, W, h, 6).fill(FLAG_TINT[tone]);
      doc.rect(M, y, 4, h).fill(FLAG_COLOR[tone]);
      doc.font('Helvetica-Bold').fontSize(10.5).fillColor(FLAG_COLOR[tone])
         .text(concerns.length ? 'Top concerns' : `No red-flag concerns this ${unit}`, M + 18, y + 12, { lineBreak:false });
      let cy = y + 32;
      for (const [label, detail] of concerns) {
        doc.circle(M + 22, cy + 4, 2.2).fill(FLAG_COLOR.red);
        doc.font('Helvetica-Bold').fontSize(9.5).fillColor(C.ink).text(label, M + 32, cy, { continued:true })
           .font('Helvetica').fillColor(C.body).text(`  –  ${detail}`, { lineBreak:false });
        cy += 16;
      }
      y += h + 14;
    }

    // ── KPI cards ──
    const cards = [];
    if (inc('resolved_closed')) {
      cards.push({ label:'Resolved', value:String(t.resolved ?? 0), sub:`Team avg ${ta.resolved ?? '–'}` });
      cards.push({ label:'Closed',   value:String(t.closed ?? 0),   sub:`Team avg ${ta.closed ?? '–'}` });
    }
    if (inc('avg_response')) cards.push({ label:'Avg response', value:fmtMin(t.avgResponseMin),
      sub: ta.avgResponseMin ? `Team avg ${fmtMin(ta.avgResponseMin)}` : '', flag:f.avg_response });
    if (inc('first_reply'))  cards.push({ label:'Avg first reply', value:fmtMin(t.firstReplyMin) });
    if (inc('sla'))          cards.push({ label:'Response-SLA breach', value:`${t.slaBreachPct ?? 0}%`,
      sub:`${t.slaBreached ?? 0} of ${t.slaDue ?? 0} due`, flag:f.sla_breach_pct });
    if (inc('late_shifts'))  cards.push({ label:'Late shifts', value:String(t.lateShifts ?? 0),
      sub: `${t.lateShifts === 1 ? 'day' : 'days'} this ${unit}`, flag:f.late_shifts });
    if (inc('off_breaks'))   cards.push({ label:'Off-schedule breaks', value:String(t.offBreaks ?? 0),
      sub:`this ${unit}`, flag:f.off_breaks });
    // reports generated before this metric existed have no missedShifts field
    if (inc('late_shifts') && t.missedShifts !== undefined) cards.push({ label:'No clock-in', value:String(t.missedShifts),
      sub:'rostered shifts, no leave', flag: t.missedShifts ? 'red' : 'green' });
    if (inc('csat') && cs && !cs.unavailable) cards.push({ label:'CSAT', value: cs.csatPct != null ? `${cs.csatPct}%` : '–',
      sub: cs.total ? `${cs.total} ratings${ta.csat?.csatPct != null ? ` · team ${ta.csat.csatPct}%` : ''}` : 'no ratings', flag:f.csat_pct });
    if (inc('empathy') && em && !em.unavailable) cards.push({ label:'Empathy missed', value: String(em.missed),
      sub: em.upset ? `of ${em.upset} upset · ${em.missedPct}%` : (em.checked ? 'no upset customers' : 'no data'), flag:f.empathy_missed_pct });

    if (cards.length) {
      sectionTitle(`${Unit} at a glance`);
      const perRow = 4, gap = 10, cw = (W - gap*(perRow-1)) / perRow, ch = 64;
      cards.forEach((c, i) => {
        if (i % perRow === 0 && i) y += ch + gap;
        if (i % perRow === 0) ensure(ch);
        const x = M + (i % perRow) * (cw + gap);
        doc.roundedRect(x, y, cw, ch, 5).fill(C.panel);
        doc.rect(x, y, 3, ch).fill(c.flag ? FLAG_COLOR[c.flag] : C.neutral);
        doc.font('Helvetica').fontSize(8).fillColor(C.muted).text(c.label, x + 12, y + 10, { width:cw - 30, lineBreak:false, ellipsis:true });
        if (c.flag) doc.circle(x + cw - 12, y + 14, 3.5).fill(FLAG_COLOR[c.flag]);
        doc.font('Helvetica-Bold').fontSize(19).fillColor(C.ink).text(c.value, x + 12, y + 25, { width:cw - 20, lineBreak:false });
        if (c.sub) doc.font('Helvetica').fontSize(7.5).fillColor(C.faint)
          .text(c.sub, x + 12, y + 50, { lineBreak:false });
      });
      y += ch + 8;
      // legend
      let lx = M;
      for (const k of ['green','yellow','red']) {
        doc.circle(lx + 3, y + 4, 3).fill(FLAG_COLOR[k]);
        doc.font('Helvetica').fontSize(7.5).fillColor(C.muted).text(FLAG_LABEL[k], lx + 10, y + 1, { lineBreak:false });
        lx += 18 + doc.widthOfString(FLAG_LABEL[k]) + 6;
      }
      y += 14;
    }

    // Generic table: cols = [{ label, width, align }], rows = arrays of cell strings.
    const ROW_H = 22;
    const drawTable = (cols, rows, { totalRow } = {}) => {
      const header = () => {
        doc.rect(M, y, W, ROW_H).fill(C.head);
        let x = M;
        for (const c of cols) {
          doc.font('Helvetica-Bold').fontSize(8).fillColor(C.muted)
             .text(c.label.toUpperCase(), x + 8, y + 7.5, { width:c.width - 16, align:c.align || 'left', lineBreak:false, characterSpacing:0.4 });
          x += c.width;
        }
        y += ROW_H;
      };
      ensure(ROW_H * 2); header();
      const all = totalRow ? [...rows, totalRow] : rows;
      all.forEach((cells, ri) => {
        const isTotal = totalRow && ri === all.length - 1;
        if (ensure(ROW_H)) header();
        if (isTotal) { doc.moveTo(M, y).lineTo(M + W, y).lineWidth(1).strokeColor(C.ink).stroke(); }
        else if (ri % 2) doc.rect(M, y, W, ROW_H).fill(C.panel);
        let x = M;
        cells.forEach((cell, ci) => {
          const c = cols[ci], v = typeof cell === 'object' && cell ? cell : { text:cell };
          doc.font(isTotal || ci === 0 ? 'Helvetica-Bold' : 'Helvetica').fontSize(9)
             .fillColor(v.color || (isTotal ? C.ink : C.body))
             .text(String(v.text ?? '–'), x + 8, y + 7, { width:c.width - 16, align:c.align || 'left', lineBreak:false, ellipsis:true });
          x += c.width;
        });
        y += ROW_H;
      });
      doc.moveTo(M, y).lineTo(M + W, y).lineWidth(0.75).strokeColor(C.line).stroke();
      y += 6;
    };

    // ── Custom statuses ──
    const custom = Object.entries(t.custom || {});
    if ((inc('custom') || inc('a2p') || inc('ghl')) && custom.length) {
      sectionTitle('Ticket statuses', `Total for the ${unit}`, (custom.length + 1) * 22);
      drawTable([{ label:'Status', width:W - 120 }, { label:'Tickets', width:120, align:'right' }],
        custom.sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, String(v)]));
    }

    // ── Weekly breakdown ──
    const weekly = report.weekly || [];
    if (weekly.length) {
      sectionTitle('Weekly breakdown', null, (weekly.length + 2) * 22);
      const cols = [
        { label:'Week', width:W - 398 },
        { label:'New', width:52, align:'right' }, { label:'Resolved', width:64, align:'right' },
        { label:'Closed', width:56, align:'right' }, { label:'Avg resp.', width:70, align:'right' },
        { label:'1st reply', width:70, align:'right' }, { label:'SLA breach', width:86, align:'right' },
      ];
      const totalNew = weekly.reduce((s, w) => s + (+w.newTickets || 0), 0);
      drawTable(cols,
        weekly.map(w => [weekLabel(w.label), String(w.newTickets), String(w.resolved), String(w.closed),
          fmtMin(w.avgResponseMin), fmtMin(w.firstReplyMin), w.slaDue ? `${w.slaBreachPct}%` : '–']),
        { totalRow: [`${Unit} total`, String(totalNew), String(t.resolved ?? 0), String(t.closed ?? 0),
          fmtMin(t.avgResponseMin), fmtMin(t.firstReplyMin),
          { text: t.slaDue ? `${t.slaBreachPct}%` : '–', color: f.sla_breach_pct ? FLAG_COLOR[f.sla_breach_pct] : undefined }] });
    }

    // ── Customer experience: CSAT counts and empathy check results ──
    const note = (text) => { ensure(20); doc.font('Helvetica').fontSize(8.5).fillColor(C.muted).text(text, M, y, { width:W }); y = doc.y + 8; };
    const showCsat = inc('csat') && cs, showEmp = inc('empathy') && em;
    if (showCsat || showEmp) {
      sectionTitle('Customer experience', `${month} · CSAT from Freshdesk, empathy from resolved/closed tickets`, 90);
      if (showCsat) {
        if (cs.unavailable) note(`CSAT: ${cs.unavailable}.`);
        else drawTable([{ label:'CSAT', width:W - 340 }, { label:'Ratings', width:64, align:'right' }, { label:'Positive', width:66, align:'right' },
          { label:'Neutral', width:64, align:'right' }, { label:'Negative', width:66, align:'right' }, { label:'CSAT %', width:80, align:'right' }],
          [['This agent', String(cs.total), String(cs.positive), String(cs.neutral),
            cs.negative ? { text:String(cs.negative), color:FLAG_COLOR.red } : '0',
            cs.csatPct != null ? { text:`${cs.csatPct}%`, color: f.csat_pct && f.csat_pct !== 'green' ? FLAG_COLOR[f.csat_pct] : undefined } : '–'],
           ...(ta.csat ? [['Team', String(ta.csat.total), String(ta.csat.positive), String(ta.csat.neutral), String(ta.csat.negative),
             ta.csat.csatPct != null ? `${ta.csat.csatPct}%` : '–']] : [])]);
      }
      if (showEmp) {
        if (em.unavailable) note(`Empathy: ${em.unavailable}.`);
        else if (!em.checked) note(`Empathy: no resolved or closed tickets were checked in this ${unit}. Empathy checks started on Oct 7, 2026.`);
        else {
          y += 4;
          drawTable([{ label:'Empathy', width:W - 380 }, { label:'Checked', width:62, align:'right' }, { label:'By Claude', width:66, align:'right' },
            { label:'Upset', width:56, align:'right' }, { label:'Acknowl.', width:66, align:'right' }, { label:'Missed', width:58, align:'right' },
            { label:'Missed %', width:72, align:'right' }],
            [['This agent', String(em.checked), String(em.reviewed), String(em.upset), String(em.acknowledged),
              em.missed ? { text:String(em.missed), color:FLAG_COLOR.red } : '0',
              em.missedPct != null ? { text:`${em.missedPct}%`, color: f.empathy_missed_pct && f.empathy_missed_pct !== 'green' ? FLAG_COLOR[f.empathy_missed_pct] : undefined } : '–']]);
          // the tickets where empathy was missed, with the reason (no customer quotes)
          const list = em.missedList || [];
          if (list.length) {
            ensure(40); y += 4;
            doc.font('Helvetica-Bold').fontSize(9.5).fillColor(C.ink).text('Tickets where empathy was missed', M, y); y = doc.y + 6;
            for (const it of list) {
              const head = `#${it.ticketId}  ·  ${it.date ? dayLabel(it.date) : ''}  ·  ${it.source === 'claude' ? 'Reviewed by Claude' : 'Quick check'}`;
              doc.font('Helvetica').fontSize(8.5);
              const h = 14 + doc.heightOfString(it.reason || '–', { width:W - 14 });
              ensure(h + 8);
              doc.rect(M, y, 3, h).fill(FLAG_COLOR.red);
              doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.ink).text(head, M + 10, y, { width:W - 14, lineBreak:false });
              doc.font('Helvetica').fontSize(8.5).fillColor(C.body).text(it.reason || '–', M + 10, y + 13, { width:W - 14 });
              y += h + 8;
            }
          }
          if (em.checked > em.reviewed) note(`${em.checked - em.reviewed} of ${em.checked} tickets show the quick check only (Claude review pending or outside the review window).`);
        }
      }
    }

    // Day/minutes grid used by the late-shift and break detail sections.
    const drawDayGrid = (items, color, perRow) => {
      const gap = 10, cw = (W - gap*(perRow-1)) / perRow, ch = 22;
      items.forEach((it, i) => {
        if (i % perRow === 0) { if (i) y += ch + 5; ensure(ch); }
        const x = M + (i % perRow) * (cw + gap);
        doc.roundedRect(x, y, cw, ch, 4).fill(C.panel);
        doc.font('Helvetica').fontSize(9).fillColor(C.body).text(it.day, x + 10, y + 7, { lineBreak:false });
        doc.font('Helvetica-Bold').fontSize(9).fillColor(color).text(it.value, x + 10, y + 7, { width:cw - 20, align:'right', lineBreak:false });
      });
      y += ch + 8;
    };

    // ── Late shift detail ──
    const late = (report.lateDetail || []).slice().sort((a, b) => a.date < b.date ? -1 : 1);
    if (inc('late_shifts') && late.length) {
      const mins = late.map(l => +l.lateMin || 0);
      const totalLate = mins.reduce((s, v) => s + v, 0);
      sectionTitle('Late shift detail', `${late.length} days · ${fmtMin(totalLate)} total · longest ${fmtMin(Math.max(...mins))}`);
      drawDayGrid(late.map(l => ({ day:dayLabel(l.date, true), value:fmtMin(l.lateMin) })), FLAG_COLOR.red, 4);
    }

    // ── No clock-in detail ──
    const missed = report.missedDetail || [];
    if (inc('late_shifts') && missed.length) {
      sectionTitle('Shifts with no clock-in', `Rostered, no Deputy timesheet, no leave · times ${tzAbbr()}`);
      drawDayGrid(missed.map(x => ({ day:shiftDayLabel(x.start), value:`${shiftTime(x.start)}–${shiftTime(x.end)}` })), FLAG_COLOR.red, 3);
    }

    // ── Off-schedule break detail ──
    const brk = (report.breakDetail || []).slice().sort((a, b) => a.date < b.date ? -1 : 1);
    if (inc('off_breaks') && brk.length) {
      sectionTitle('Off-schedule break detail', `${brk.length} breaks outside the scheduled time`);
      drawDayGrid(brk.map(b => ({ day:dayLabel(b.date, true),
        value:`${fmtMin(Math.abs(b.lateMin))} ${b.lateMin < 0 ? 'early' : 'late'}` })), FLAG_COLOR.yellow, 3);
    }

    // ── Footer on every page ──
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.page.margins.bottom = 0;            // let the footer sit below the content area
      const fy = doc.page.height - 34;
      doc.moveTo(M, fy - 8).lineTo(M + W, fy - 8).lineWidth(0.5).strokeColor(C.line).stroke();
      doc.font('Helvetica').fontSize(7.5).fillColor(C.faint);
      doc.text(`${report.name || report.email} · ${month}`, M, fy, { width:W / 3, lineBreak:false, ellipsis:true });
      doc.text('Confidential – for performance discussion only', M, fy, { width:W, align:'center', lineBreak:false });
      doc.text(`Page ${i - range.start + 1} of ${range.count}`, M, fy, { width:W, align:'right', lineBreak:false });
    }

    doc.end();
  });
}

// ── TEAM PDF (all agents in one report) ──
// Built from the stored per-agent payloads for the month; `thresholds` flags the
// team-level averages the same way agent metrics are flagged.
function generateTeamPDF(monthKey, reports, thresholds = DEFAULT_THRESHOLDS) {
  return new Promise((resolve, reject) => {
    const month = periodLabel(reports[0], monthKey);
    const unit = reports[0]?.range ? 'period' : 'month';
    const Unit = unit[0].toUpperCase() + unit.slice(1);
    const doc = new PDFDocument({
      size:'A4', margin:40, bufferPages:true,
      info:{ Title:`Team Performance Report – ${month}`, Author:'Activity Monitor' },
    });
    const chunks = [];
    doc.on('data', c=>chunks.push(c));
    doc.on('end', ()=>resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const agents = reports.slice().sort((a, b) =>
      ((b.totals?.resolved || 0) - (a.totals?.resolved || 0)) || String(a.name).localeCompare(String(b.name)));
    const sel = agents[0]?.selected || [];
    const inc = (k)=>sel.includes(k);
    const M = 40, PW = doc.page.width, W = PW - 2*M, BOTTOM = doc.page.height - 56, ROW_H = 22;
    let y = M;
    const ensure = (h) => { if (y + h > BOTTOM) { doc.addPage(); y = M; return true; } return false; };
    const sectionTitle = (title, note, keep = 30) => {
      ensure(Math.min(36 + keep, BOTTOM - M));
      y += 8;
      doc.font('Helvetica-Bold').fontSize(12).fillColor(C.ink).text(title, M, y, { lineBreak:false });
      if (note) doc.font('Helvetica').fontSize(8.5).fillColor(C.muted).text(note, M, y + 2, { width:W, align:'right', lineBreak:false });
      y += 18;
      doc.moveTo(M, y).lineTo(M + W, y).lineWidth(0.75).strokeColor(C.line).stroke();
      y += 10;
    };
    // cols = [{ label, width, align }], rows = arrays of strings or { text, color }
    const drawTable = (cols, rows, { totalRow } = {}) => {
      const header = () => {
        doc.rect(M, y, W, ROW_H).fill(C.head);
        let x = M;
        for (const c of cols) {
          doc.font('Helvetica-Bold').fontSize(7.5).fillColor(C.muted)
             .text(c.label.toUpperCase(), x + 6, y + 8, { width:c.width - 12, align:c.align || 'left', lineBreak:false, characterSpacing:0.3 });
          x += c.width;
        }
        y += ROW_H;
      };
      ensure(ROW_H * 2); header();
      const all = totalRow ? [...rows, totalRow] : rows;
      all.forEach((cells, ri) => {
        const isTotal = totalRow && ri === all.length - 1;
        if (ensure(ROW_H)) header();
        if (isTotal) doc.moveTo(M, y).lineTo(M + W, y).lineWidth(1).strokeColor(C.ink).stroke();
        else if (ri % 2) doc.rect(M, y, W, ROW_H).fill(C.panel);
        let x = M;
        cells.forEach((cell, ci) => {
          const c = cols[ci], v = typeof cell === 'object' && cell ? cell : { text:cell };
          doc.font(isTotal || ci === 0 || v.color ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5)
             .fillColor(v.color || (isTotal ? C.ink : C.body))
             .text(String(v.text ?? '–'), x + 6, y + 7.5, { width:c.width - 12, align:c.align || 'left', lineBreak:false, ellipsis:true });
          x += c.width;
        });
        y += ROW_H;
      });
      doc.moveTo(M, y).lineTo(M + W, y).lineWidth(0.75).strokeColor(C.line).stroke();
      y += 6;
    };
    // colour a value only when it is off target
    const flagged = (text, flag) => flag && flag !== 'green' ? { text, color:FLAG_COLOR[flag] } : text;
    const sumT = (k) => agents.reduce((s, r) => s + (+r.totals?.[k] || 0), 0);
    const avgT = (k) => { const v = agents.map(r => +r.totals?.[k] || 0).filter(n => n > 0); return v.length ? +(v.reduce((s, n) => s + n, 0) / v.length).toFixed(1) : 0; };

    // ── Team totals ──
    // reply times: weighted over all replies when the payloads carry reply counts
    // (working-hours reply events); older payloads fall back to averaging agents.
    const ta0 = agents[0]?.teamAvg || {};
    const weighted = ta0.responses != null;
    const team = {
      resolved:sumT('resolved'), closed:sumT('closed'),
      newTickets:agents.reduce((s, r) => s + (r.weekly || []).reduce((ws, w) => ws + (+w.newTickets || 0), 0), 0),
      avgResponseMin: weighted ? ta0.avgResponseMin : avgT('avgResponseMin'),
      firstReplyMin: weighted ? ta0.firstReplyMin : avgT('firstReplyMin'),
      slaDue:sumT('slaDue'), slaBreached:sumT('slaBreached'),
      lateShifts:sumT('lateShifts'), offBreaks:sumT('offBreaks'),
    };
    team.slaBreachPct = team.slaDue ? +((team.slaBreached / team.slaDue) * 100).toFixed(1) : 0;
    const teamFlags = {
      avg_response:flagFor('avg_response', team.avgResponseMin, thresholds),
      sla_breach_pct:flagFor('sla_breach_pct', team.slaBreachPct, thresholds),
    };
    const countFlag = (metric, color) => agents.filter(r => r.flags?.[metric] === color).length;

    // ── Header band ──
    doc.rect(0, 0, PW, 104).fill(C.brand);
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.brandSub)
       .text('TEAM PERFORMANCE REPORT', M, 30, { characterSpacing:1.5, lineBreak:false });
    doc.font('Helvetica-Bold').fontSize(22).fillColor('#ffffff').text(month, M, 46, { lineBreak:false });
    doc.font('Helvetica').fontSize(8.5).fillColor(C.brandSub)
       .text(`Generated ${new Date().toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })}`, M, 76, { lineBreak:false });
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#ffffff').text('All agents', M, 46, { width:W, align:'right', lineBreak:false });
    doc.font('Helvetica').fontSize(9.5).fillColor(C.brandSub).text(`${agents.length} agent${agents.length === 1 ? '' : 's'}`, M, 64, { width:W, align:'right', lineBreak:false });
    y = 124;

    // ── Agents needing attention ──
    const attention = [];
    for (const r of agents) {
      const t = r.totals || {}, f = r.flags || {}, items = [];
      if (inc('late_shifts')  && f.late_shifts === 'red')    items.push(`${t.lateShifts} late shifts`);
      if (inc('off_breaks')   && f.off_breaks === 'red')     items.push(`${t.offBreaks} off-schedule breaks`);
      if (inc('avg_response') && f.avg_response === 'red')   items.push(`${fmtMin(t.avgResponseMin)} avg response`);
      if (inc('sla')          && f.sla_breach_pct === 'red') items.push(`${t.slaBreachPct}% SLA breach`);
      if (inc('late_shifts')  && t.missedShifts) items.push(`${t.missedShifts} shift${t.missedShifts === 1 ? '' : 's'} with no clock-in`);
      if (inc('csat')    && f.csat_pct === 'red') items.push(`${r.csat.csatPct}% CSAT`);
      if (inc('empathy') && f.empathy_missed_pct === 'red') items.push(`empathy missed with ${r.empathy.missed} of ${r.empathy.upset} upset`);
      if (items.length) attention.push([r.name || r.email, items.join(', ')]);
    }
    {
      const tone = attention.length ? 'red' : 'green';
      const h = attention.length ? 34 + attention.length * 16 : 36;
      ensure(h);
      doc.roundedRect(M, y, W, h, 6).fill(FLAG_TINT[tone]);
      doc.rect(M, y, 4, h).fill(FLAG_COLOR[tone]);
      doc.font('Helvetica-Bold').fontSize(10.5).fillColor(FLAG_COLOR[tone])
         .text(attention.length ? `Agents needing attention (${attention.length} of ${agents.length})` : `No agents with red-flag concerns this ${unit}`, M + 18, y + 12, { lineBreak:false });
      let cy = y + 32;
      for (const [name, detail] of attention) {
        doc.circle(M + 22, cy + 4, 2.2).fill(FLAG_COLOR.red);
        doc.font('Helvetica-Bold').fontSize(9.5).fillColor(C.ink).text(name, M + 32, cy, { continued:true })
           .font('Helvetica').fillColor(C.body).text(`  –  ${detail}`, { lineBreak:false });
        cy += 16;
      }
      y += h + 14;
    }

    // ── Team KPI cards ──
    const cards = [];
    if (inc('resolved_closed')) {
      cards.push({ label:'Resolved', value:String(team.resolved), sub:`${fmtNum(team.resolved / (agents.length || 1))} per agent` });
      cards.push({ label:'Closed', value:String(team.closed), sub:`${fmtNum(team.closed / (agents.length || 1))} per agent` });
    }
    if (inc('avg_response')) cards.push({ label:'Avg response', value:fmtMin(team.avgResponseMin),
      sub: weighted ? `${ta0.responses} replies · working hours` : 'average across agents', flag:teamFlags.avg_response });
    if (inc('first_reply'))  cards.push({ label:'Avg first reply', value:fmtMin(team.firstReplyMin),
      sub: weighted ? `${ta0.firstReplies} tickets · working hours` : 'average across agents' });
    if (inc('sla'))          cards.push({ label:'Response-SLA breach', value:`${team.slaBreachPct}%`, sub:`${team.slaBreached} of ${team.slaDue} due`, flag:teamFlags.sla_breach_pct });
    if (inc('late_shifts'))  cards.push({ label:'Late shifts', value:String(team.lateShifts), sub:`${countFlag('late_shifts', 'red')} agents flagged red` });
    if (inc('off_breaks'))   cards.push({ label:'Off-schedule breaks', value:String(team.offBreaks), sub:`${countFlag('off_breaks', 'red')} agents flagged red` });
    const hasMissed = agents.some(r => r.totals?.missedShifts !== undefined);
    if (inc('late_shifts') && hasMissed) {
      const n = sumT('missedShifts'), who = agents.filter(r => r.totals?.missedShifts).length;
      cards.push({ label:'No clock-in', value:String(n), sub:`${who} agent${who === 1 ? '' : 's'} · rostered, no leave`, flag: n ? 'red' : 'green' });
    }
    // team CSAT / empathy (absent on reports generated before these existed)
    const tcs = agents[0]?.teamAvg?.csat, tem = agents[0]?.teamAvg?.empathy;
    const teamCsatFlag = tcs?.csatPct != null ? flagFor('csat_pct', tcs.csatPct, thresholds) : undefined;
    const teamEmpFlag = tem?.missedPct != null ? flagFor('empathy_missed_pct', tem.missedPct, thresholds) : undefined;
    if (inc('csat') && tcs) cards.push({ label:'CSAT', value: tcs.csatPct != null ? `${tcs.csatPct}%` : '–',
      sub: tcs.total ? `${tcs.total} ratings · ${tcs.negative} negative` : 'no ratings', flag:teamCsatFlag });
    if (inc('empathy') && tem) cards.push({ label:'Empathy missed', value:String(tem.missed),
      sub: tem.upset ? `of ${tem.upset} upset · ${tem.missedPct}%` : (tem.checked ? 'no upset customers' : 'no data'), flag:teamEmpFlag });
    if (cards.length) {
      sectionTitle('Team at a glance');
      const perRow = 4, gap = 10, cw = (W - gap*(perRow-1)) / perRow, ch = 64;
      cards.forEach((c, i) => {
        if (i % perRow === 0 && i) y += ch + gap;
        if (i % perRow === 0) ensure(ch);
        const x = M + (i % perRow) * (cw + gap);
        doc.roundedRect(x, y, cw, ch, 5).fill(C.panel);
        doc.rect(x, y, 3, ch).fill(c.flag ? FLAG_COLOR[c.flag] : C.neutral);
        doc.font('Helvetica').fontSize(8).fillColor(C.muted).text(c.label, x + 12, y + 10, { width:cw - 30, lineBreak:false, ellipsis:true });
        if (c.flag) doc.circle(x + cw - 12, y + 14, 3.5).fill(FLAG_COLOR[c.flag]);
        doc.font('Helvetica-Bold').fontSize(19).fillColor(C.ink).text(c.value, x + 12, y + 25, { width:cw - 20, lineBreak:false });
        if (c.sub) doc.font('Helvetica').fontSize(7.5).fillColor(C.faint).text(c.sub, x + 12, y + 50, { lineBreak:false });
      });
      y += ch + 8;
      let lx = M;
      for (const k of ['green','yellow','red']) {
        doc.circle(lx + 3, y + 4, 3).fill(FLAG_COLOR[k]);
        doc.font('Helvetica').fontSize(7.5).fillColor(C.muted).text(FLAG_LABEL[k], lx + 10, y + 1, { lineBreak:false });
        lx += 18 + doc.widthOfString(FLAG_LABEL[k]) + 6;
      }
      y += 14;
    }

    // ── Agent comparison ──
    {
      const metricCols = [];
      if (inc('resolved_closed')) {
        metricCols.push({ label:'Resolved', width:56, align:'right', cell:r => String(r.totals?.resolved ?? 0), total:String(team.resolved) });
        metricCols.push({ label:'Closed',   width:50, align:'right', cell:r => String(r.totals?.closed ?? 0),   total:String(team.closed) });
      }
      if (inc('avg_response')) metricCols.push({ label:'Avg resp.', width:62, align:'right',
        cell:r => flagged(fmtMin(r.totals?.avgResponseMin), r.flags?.avg_response), total:flagged(fmtMin(team.avgResponseMin), teamFlags.avg_response) });
      if (inc('first_reply'))  metricCols.push({ label:'1st reply', width:62, align:'right',
        cell:r => fmtMin(r.totals?.firstReplyMin), total:fmtMin(team.firstReplyMin) });
      if (inc('sla'))          metricCols.push({ label:'SLA breach', width:70, align:'right',
        cell:r => flagged(r.totals?.slaDue ? `${r.totals.slaBreachPct}%` : '–', r.flags?.sla_breach_pct),
        total:flagged(team.slaDue ? `${team.slaBreachPct}%` : '–', teamFlags.sla_breach_pct) });
      if (inc('late_shifts'))  metricCols.push({ label:'Late', width:42, align:'right',
        cell:r => flagged(String(r.totals?.lateShifts ?? 0), r.flags?.late_shifts), total:String(team.lateShifts) });
      if (inc('off_breaks'))   metricCols.push({ label:'Off-brk', width:50, align:'right',
        cell:r => flagged(String(r.totals?.offBreaks ?? 0), r.flags?.off_breaks), total:String(team.offBreaks) });
      const used = metricCols.reduce((s, c) => s + c.width, 0);
      const cols = [{ label:'Agent', width:W - used }, ...metricCols];
      sectionTitle('Agent comparison', 'Sorted by tickets resolved', (agents.length + 2) * ROW_H);
      drawTable(cols, agents.map(r => [r.name || r.email, ...metricCols.map(c => c.cell(r))]),
        { totalRow:['Team', ...metricCols.map(c => c.total)] });
    }

    // ── Weekly team breakdown ──
    const weekCount = Math.max(0, ...agents.map(r => (r.weekly || []).length));
    if (weekCount) {
      const weeks = [];
      for (let i = 0; i < weekCount; i++) {
        const ws = agents.map(r => r.weekly?.[i]).filter(Boolean);
        const sumW = (k) => ws.reduce((s, w) => s + (+w[k] || 0), 0);
        // weighted by each agent's reply count for the week when available
        const avgW = (k) => {
          const countKey = k === 'firstReplyMin' ? 'firstReplies' : 'responses';
          if (ws.every(w => w[countKey] != null)) {
            const n = ws.reduce((s, w) => s + w[countKey], 0);
            return n ? ws.reduce((s, w) => s + (+w[k] || 0) * w[countKey], 0) / n : 0;
          }
          const v = ws.map(w => +w[k] || 0).filter(x => x > 0); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0;
        };
        const due = sumW('slaDue'), br = sumW('slaBreached');
        weeks.push([weekLabel(ws[0]?.label), String(sumW('newTickets')), String(sumW('resolved')), String(sumW('closed')),
          fmtMin(avgW('avgResponseMin')), fmtMin(avgW('firstReplyMin')), due ? `${+((br / due) * 100).toFixed(1)}%` : '–']);
      }
      sectionTitle('Weekly team breakdown', weighted ? 'Totals across all agents; reply times over all replies, working hours' : 'Totals across all agents; times averaged', (weeks.length + 2) * ROW_H);
      drawTable([
        { label:'Week', width:W - 398 },
        { label:'New', width:52, align:'right' }, { label:'Resolved', width:64, align:'right' },
        { label:'Closed', width:56, align:'right' }, { label:'Avg resp.', width:70, align:'right' },
        { label:'1st reply', width:70, align:'right' }, { label:'SLA breach', width:86, align:'right' },
      ], weeks, { totalRow:[`${Unit} total`, String(team.newTickets), String(team.resolved), String(team.closed),
        fmtMin(team.avgResponseMin), fmtMin(team.firstReplyMin),
        flagged(team.slaDue ? `${team.slaBreachPct}%` : '–', teamFlags.sla_breach_pct)] });
    }

    // ── Attendance ──
    if (inc('late_shifts') || inc('off_breaks')) {
      const rows = agents
        .map(r => {
          const mins = (r.lateDetail || []).map(l => +l.lateMin || 0);
          return { r, mins, total:mins.reduce((s, n) => s + n, 0) };
        })
        .sort((a, b) => (b.r.totals?.lateShifts || 0) - (a.r.totals?.lateShifts || 0) || b.total - a.total)
        .map(({ r, mins, total }) => [
          r.name || r.email,
          ...(inc('late_shifts') ? [flagged(String(r.totals?.lateShifts ?? 0), r.flags?.late_shifts), fmtMin(total), fmtMin(mins.length ? Math.max(...mins) : 0)] : []),
          ...(inc('late_shifts') && hasMissed ? [flagged(String(r.totals?.missedShifts ?? 0), r.totals?.missedShifts ? 'red' : null)] : []),
          ...(inc('off_breaks') ? [flagged(String(r.totals?.offBreaks ?? 0), r.flags?.off_breaks)] : []),
        ]);
      const cols = [
        ...(inc('late_shifts') ? [{ label:'Late days', width:66, align:'right' }, { label:'Total late', width:70, align:'right' }, { label:'Longest', width:62, align:'right' }] : []),
        ...(inc('late_shifts') && hasMissed ? [{ label:'No clock-in', width:74, align:'right' }] : []),
        ...(inc('off_breaks') ? [{ label:'Off-sched. breaks', width:100, align:'right' }] : []),
      ];
      sectionTitle('Attendance', 'Sorted by late days', (rows.length + 1) * ROW_H);
      drawTable([{ label:'Agent', width:W - cols.reduce((s, c) => s + c.width, 0) }, ...cols], rows);
    }

    // ── Customer experience by agent: CSAT counts and empathy results ──
    if ((inc('csat') && tcs) || (inc('empathy') && tem)) {
      const withCsat = inc('csat') && tcs, withEmp = inc('empathy') && tem;
      const red = (n) => n ? { text:String(n), color:FLAG_COLOR.red } : '0';
      const pctCell = (v, flag) => v == null ? '–' : flagged(`${v}%`, flag);
      const cols = [
        ...(withCsat ? [{ label:'Ratings', width:50, align:'right' }, { label:'Negative', width:56, align:'right' }, { label:'CSAT %', width:56, align:'right' }] : []),
        ...(withEmp ? [{ label:'Checked', width:54, align:'right' }, { label:'Upset', width:46, align:'right' }, { label:'Missed', width:50, align:'right' }, { label:'Missed %', width:60, align:'right' }] : []),
      ];
      const row = (name, c, e, cf, ef) => [name,
        ...(withCsat ? [String(c?.total ?? 0), red(c?.negative), pctCell(c?.csatPct, cf)] : []),
        ...(withEmp ? [String(e?.checked ?? 0), String(e?.upset ?? 0), red(e?.missed), pctCell(e?.missedPct, ef)] : [])];
      const rows = agents.slice()
        .sort((a, b) => (b.empathy?.missed || 0) - (a.empathy?.missed || 0) || (a.csat?.csatPct ?? 101) - (b.csat?.csatPct ?? 101))
        .map(r => row(r.name || r.email, r.csat, r.empathy, r.flags?.csat_pct, r.flags?.empathy_missed_pct));
      const noteText = withEmp && tem && tem.checked > tem.reviewed ? `${tem.reviewed} of ${tem.checked} tickets reviewed by Claude` : 'Sorted by empathy missed';
      sectionTitle('Customer experience', noteText, (rows.length + 2) * ROW_H);
      drawTable([{ label:'Agent', width:W - cols.reduce((s, c) => s + c.width, 0) }, ...cols], rows,
        { totalRow: row('Team', tcs, tem, teamCsatFlag, teamEmpFlag) });
    }

    // ── Ticket statuses (team totals) ──
    if (inc('custom') || inc('a2p') || inc('ghl')) {
      const custom = {};
      for (const r of agents) for (const [k, v] of Object.entries(r.totals?.custom || {})) custom[k] = (custom[k] || 0) + (+v || 0);
      const entries = Object.entries(custom).sort((a, b) => b[1] - a[1]);
      if (entries.length) {
        sectionTitle('Ticket statuses', `Team total for the ${unit}`, (entries.length + 1) * ROW_H);
        drawTable([{ label:'Status', width:W - 120 }, { label:'Tickets', width:120, align:'right' }],
          entries.map(([k, v]) => [k, String(v)]));
      }
    }

    // ── Footer on every page ──
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.page.margins.bottom = 0;
      const fy = doc.page.height - 34;
      doc.moveTo(M, fy - 8).lineTo(M + W, fy - 8).lineWidth(0.5).strokeColor(C.line).stroke();
      doc.font('Helvetica').fontSize(7.5).fillColor(C.faint);
      doc.text(`Team report · ${month}`, M, fy, { width:W / 3, lineBreak:false, ellipsis:true });
      doc.text('Confidential – for performance discussion only', M, fy, { width:W, align:'center', lineBreak:false });
      doc.text(`Page ${i - range.start + 1} of ${range.count}`, M, fy, { width:W, align:'right', lineBreak:false });
    }

    doc.end();
  });
}
const fmtNum = (n) => (+n || 0).toFixed(1).replace(/\.0$/, '');

// ── GROUP REPORTS (by the ticket's Freshdesk group) ──
const blankGroupAcc = () => ({ newTickets:0, resolved:0, closed:0, respSum:0, respCount:0, frSum:0, frCount:0, slaDue:0, slaBreached:0, overdue:0 });
function addGroupRow(acc, r) {
  acc.newTickets += +r.new_tickets || 0; acc.resolved += +r.resolved || 0; acc.closed += +r.closed || 0;
  acc.respSum += +r.resp_sum_min || 0;   acc.respCount += +r.resp_count || 0;
  acc.frSum += +r.fr_sum_min || 0;       acc.frCount += +r.fr_count || 0;
  acc.slaDue += +r.sla_due || 0;         acc.slaBreached += +r.sla_breached || 0; acc.overdue += +r.overdue || 0;
}
// Times are weighted by ticket count (sum ÷ count), so they combine correctly.
const finishGroupAcc = ({ respSum, respCount, frSum, frCount, ...acc }) => ({
  ...acc,
  avgResponseMin: respCount ? +(respSum / respCount).toFixed(1) : 0,
  firstReplyMin:  frCount ? +(frSum / frCount).toFixed(1) : 0,
  slaBreachPct:   acc.slaDue ? +((acc.slaBreached / acc.slaDue) * 100).toFixed(1) : 0,
});
const groupActivity = (t) => t.newTickets + t.resolved + t.closed + t.slaDue + t.overdue;

/**
 * Per-group totals, per-agent breakdown and weekly split for an inclusive range.
 * Returns { from, to, dataFrom, groups } — dataFrom = earliest group data stored
 * (group stats only exist from when collection started).
 */
async function buildGroupReports(fromDate, toDate) {
  const agents = await D.getAgents();
  const [rows, cx] = await Promise.all([
    D.getGroupStatsRange(fromDate, toDate),
    // CSAT and empathy per group for the same period (never fails the report)
    Q.groupCustomerExperience(fromDate, toDate, new Set(agents.map(a => a.email.toLowerCase())))
      .catch(e => { console.error('group cx:', e.message); return null; }),
  ]);
  const names = {}; agents.forEach(a => names[a.email] = a.name || a.email);
  const weeks = weeksOfRange(fromDate, toDate);
  const groups = {}, all = blankGroupAcc();
  let dataFrom = null;
  for (const r of rows) {   // ordered by id, so the latest group_name wins
    if (!dataFrom || r.stat_date < dataFrom) dataFrom = r.stat_date;
    addGroupRow(all, r);
    const G = groups[r.group_id] = groups[r.group_id] || {
      id:r.group_id, name:r.group_name, totals:blankGroupAcc(), agents:{},
      weekly: weeks.map(w => ({ label:w.label, days:new Set(w.days), acc:blankGroupAcc() })),
    };
    if (r.group_name) G.name = r.group_name;
    addGroupRow(G.totals, r);
    addGroupRow(G.agents[r.agent_email] = G.agents[r.agent_email] || blankGroupAcc(), r);
    const w = G.weekly.find(w => w.days.has(r.stat_date)); if (w) addGroupRow(w.acc, r);
  }
  const out = Object.values(groups).map(G => ({
    id:G.id, name:G.name || (G.id ? `Group ${G.id}` : 'No group'),
    totals: finishGroupAcc(G.totals),
    agents: Object.entries(G.agents).map(([email, acc]) => ({ email, name:names[email] || email, ...finishGroupAcc(acc) }))
      .filter(groupActivity).sort((a, b) => b.resolved - a.resolved || b.closed - a.closed || a.name.localeCompare(b.name)),
    weekly: G.weekly.map(w => ({ label:w.label, ...finishGroupAcc(w.acc) })),
  })).filter(g => groupActivity(g.totals))
    // busiest first; "No group" last
    .sort((a, b) => (!a.id) - (!b.id) || (b.totals.resolved + b.totals.closed) - (a.totals.resolved + a.totals.closed));
  // Reply times from response_events (working hours, weighted) replace the
  // daily-stat estimates wherever reply events exist for the period.
  const respEvents = await D.getResponseEventsRange(fromDate, toDate).catch(() => null);
  const totals = finishGroupAcc(all);
  if (respEvents) {
    const trackedEv = respEvents.filter(e => names[e.agent_email]);
    const apply = (target, evs) => { const t = RS.responseTotals(evs); target.avgResponseMin = t.avgResponseMin; target.firstReplyMin = t.firstReplyMin; };
    for (const g of out) {
      const ge = trackedEv.filter(e => (+e.group_id || 0) === (+g.id || 0));
      apply(g.totals, ge);
      for (const a of g.agents) apply(a, ge.filter(e => e.agent_email === a.email));
      for (const w of g.weekly) { const days = new Set(weeks.find(x => x.label === w.label)?.days || []); apply(w, ge.filter(e => days.has(e.reply_date))); }
    }
    apply(totals, trackedEv);
  }
  return { from:fromDate, to:toDate, dataFrom, groups:out, totals, cx };
}

// Shared page layout for the group PDF: header band, section titles, callouts,
// tables and footers, all tracking the current y position in `L.y`.
function pdfLayout(doc) {
  const L = { M:40, W:doc.page.width - 80, BOTTOM:doc.page.height - 56, ROW_H:22, y:40 };
  L.ensure = (h) => { if (L.y + h > L.BOTTOM) { doc.addPage(); L.y = L.M; return true; } return false; };
  L.header = ({ kicker, title, right, rightSub }) => {
    const { M, W } = L;
    doc.rect(0, 0, doc.page.width, 104).fill(C.brand);
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.brandSub).text(kicker, M, 30, { characterSpacing:1.5, lineBreak:false });
    doc.font('Helvetica-Bold').fontSize(22).fillColor('#ffffff').text(title, M, 46, { lineBreak:false });
    doc.font('Helvetica').fontSize(8.5).fillColor(C.brandSub)
       .text(`Generated ${new Date().toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })}`, M, 76, { lineBreak:false });
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#ffffff').text(right, M, 46, { width:W, align:'right', lineBreak:false });
    doc.font('Helvetica').fontSize(9.5).fillColor(C.brandSub).text(rightSub, M, 64, { width:W, align:'right', lineBreak:false });
    L.y = 124;
  };
  L.sectionTitle = (title, note, keep = 30) => {
    const { M, W } = L;
    L.ensure(Math.min(36 + keep, L.BOTTOM - M));
    L.y += 8;
    doc.font('Helvetica-Bold').fontSize(12).fillColor(C.ink).text(title, M, L.y, { width:W * 0.62, lineBreak:false, ellipsis:true });
    if (note) doc.font('Helvetica').fontSize(8.5).fillColor(C.muted).text(note, M, L.y + 2, { width:W, align:'right', lineBreak:false });
    L.y += 18;
    doc.moveTo(M, L.y).lineTo(M + W, L.y).lineWidth(0.75).strokeColor(C.line).stroke();
    L.y += 10;
  };
  // tone: green|yellow|red; lines: [[boldPart, rest], ...]
  L.callout = (tone, title, lines = []) => {
    const { M, W } = L, h = lines.length ? 34 + lines.length * 16 : 36;
    L.ensure(h);
    doc.roundedRect(M, L.y, W, h, 6).fill(FLAG_TINT[tone]);
    doc.rect(M, L.y, 4, h).fill(FLAG_COLOR[tone]);
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(FLAG_COLOR[tone]).text(title, M + 18, L.y + 12, { lineBreak:false });
    let cy = L.y + 32;
    for (const [bold, rest] of lines) {
      doc.circle(M + 22, cy + 4, 2.2).fill(FLAG_COLOR[tone]);
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(C.ink).text(bold, M + 32, cy, { continued:!!rest, lineBreak:false });
      if (rest) doc.font('Helvetica').fillColor(C.body).text(rest, { lineBreak:false });
      cy += 16;
    }
    L.y += h + 14;
  };
  // Trim text to fit `width` at the current font (pdfkit wraps rather than clips).
  const fit = (text, width) => {
    if (doc.widthOfString(text) <= width) return text;
    let t = text;
    while (t.length > 1 && doc.widthOfString(t + '…') > width) t = t.slice(0, -1);
    return t.trimEnd() + '…';
  };
  // cols = [{ label, width, align }], rows = arrays of strings or { text, color }
  L.table = (cols, rows, { totalRow } = {}) => {
    const { M, W, ROW_H } = L;
    const header = () => {
      doc.rect(M, L.y, W, ROW_H).fill(C.head);
      let x = M;
      for (const c of cols) {
        doc.font('Helvetica-Bold').fontSize(7.5).fillColor(C.muted)
           .text(c.label.toUpperCase(), x + 6, L.y + 8, { width:c.width - 12, align:c.align || 'left', lineBreak:false, characterSpacing:0.3 });
        x += c.width;
      }
      L.y += ROW_H;
    };
    L.ensure(ROW_H * 2); header();
    const all = totalRow ? [...rows, totalRow] : rows;
    all.forEach((cells, ri) => {
      const isTotal = totalRow && ri === all.length - 1;
      if (L.ensure(ROW_H)) header();
      if (isTotal) doc.moveTo(M, L.y).lineTo(M + W, L.y).lineWidth(1).strokeColor(C.ink).stroke();
      else if (ri % 2) doc.rect(M, L.y, W, ROW_H).fill(C.panel);
      let x = M;
      cells.forEach((cell, ci) => {
        const c = cols[ci], v = typeof cell === 'object' && cell ? cell : { text:cell };
        doc.font(isTotal || ci === 0 || v.color ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5)
           .fillColor(v.color || (isTotal ? C.ink : C.body));
        doc.text(fit(String(v.text ?? '–'), c.width - 12), x + 6, L.y + 7.5, { width:c.width - 12, align:c.align || 'left', lineBreak:false });
        x += c.width;
      });
      L.y += ROW_H;
    });
    doc.moveTo(M, L.y).lineTo(M + W, L.y).lineWidth(0.75).strokeColor(C.line).stroke();
    L.y += 6;
  };
  L.footers = (left) => {
    const { M, W } = L, range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.page.margins.bottom = 0;
      const fy = doc.page.height - 34;
      doc.moveTo(M, fy - 8).lineTo(M + W, fy - 8).lineWidth(0.5).strokeColor(C.line).stroke();
      doc.font('Helvetica').fontSize(7.5).fillColor(C.faint);
      doc.text(left, M, fy, { width:W / 3, lineBreak:false, ellipsis:true });
      doc.text('Confidential – for performance discussion only', M, fy, { width:W, align:'center', lineBreak:false });
      doc.text(`Page ${i - range.start + 1} of ${range.count}`, M, fy, { width:W, align:'right', lineBreak:false });
    }
  };
  return L;
}

/**
 * One PDF covering every ticket group for the period.
 * data = buildGroupReports() result; monthKey set → labelled as that month.
 */
function generateGroupPDF(data, { monthKey, thresholds = DEFAULT_THRESHOLDS } = {}) {
  return new Promise((resolve, reject) => {
    const period = monthKey ? monthLabel(monthKey) : rangeLabel(data.from, data.to);
    const unit = monthKey ? 'month' : 'period', Unit = unit[0].toUpperCase() + unit.slice(1);
    const doc = new PDFDocument({ size:'A4', margin:40, bufferPages:true,
      info:{ Title:`Group Performance Report – ${period}`, Author:'Activity Monitor' } });
    const chunks = [];
    doc.on('data', c=>chunks.push(c));
    doc.on('end', ()=>resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const L = pdfLayout(doc), groups = data.groups || [];
    const flagged = (text, flag) => flag && flag !== 'green' ? { text, color:FLAG_COLOR[flag] } : text;
    const respCell = (t) => flagged(fmtMin(t.avgResponseMin), t.avgResponseMin ? flagFor('avg_response', t.avgResponseMin, thresholds) : null);
    const slaCell  = (t) => flagged(t.slaDue ? `${t.slaBreachPct}%` : '–', t.slaDue ? flagFor('sla_breach_pct', t.slaBreachPct, thresholds) : null);
    const overdueCell = (t) => t.overdue ? { text:String(t.overdue), color:FLAG_COLOR.red } : '0';
    // Metric columns shared by every table; first column is the row label.
    const metricCols = [
      { label:'New', width:44, align:'right' }, { label:'Resolved', width:58, align:'right' },
      { label:'Closed', width:50, align:'right' }, { label:'Avg resp.', width:60, align:'right' },
      { label:'1st reply', width:60, align:'right' }, { label:'SLA breach', width:66, align:'right' },
      { label:'Overdue', width:54, align:'right' },
    ];
    const used = metricCols.reduce((s, c) => s + c.width, 0);
    const cells = (t) => [String(t.newTickets), String(t.resolved), String(t.closed), respCell(t), fmtMin(t.firstReplyMin), slaCell(t), overdueCell(t)];

    L.header({ kicker:'GROUP PERFORMANCE REPORT', title:period, right:'All groups',
      rightSub:`${groups.length} group${groups.length === 1 ? '' : 's'} with activity` });

    // Data coverage note: group stats only exist from when collection started.
    if (!groups.length) {
      L.callout('yellow', `No group data for this ${unit} yet`,
        [['Group stats are collected by each poll from the day this feature went live.', '']]);
    } else if (data.dataFrom && data.dataFrom > data.from) {
      L.callout('yellow', `Partial ${unit}: group data starts ${dayLabel(data.dataFrom)}`,
        [['Earlier days are not included', ' – group stats are collected from the day this feature went live.']]);
    }

    // ── Customer experience by group: CSAT counts and empathy results ──
    const drawCustomerExperience = () => {
      const cx = data.cx;
      if (!cx || (!cx.totals.csat && !cx.totals.empathy)) return;
      const rows = cx.groups.filter(g => (g.csat?.total || 0) + (g.empathy?.checked || 0) > 0)
        .sort((a, b) => (b.empathy?.missed || 0) - (a.empathy?.missed || 0) || (b.csat?.total || 0) - (a.csat?.total || 0));
      if (!rows.length) return;
      const red = (n) => n ? { text:String(n), color:FLAG_COLOR.red } : '0';
      const csatCell = (c) => c?.csatPct == null ? '–' : flagged(`${c.csatPct}%`, flagFor('csat_pct', c.csatPct, thresholds));
      const missCell = (e) => e?.missedPct == null ? '–' : flagged(`${e.missedPct}%`, flagFor('empathy_missed_pct', e.missedPct, thresholds));
      const cols = [
        { label:'Ratings', width:50, align:'right' }, { label:'Negative', width:56, align:'right' }, { label:'CSAT %', width:56, align:'right' },
        { label:'Checked', width:54, align:'right' }, { label:'Upset', width:46, align:'right' }, { label:'Missed', width:50, align:'right' },
        { label:'Missed %', width:60, align:'right' },
      ];
      const row = (name, c, e) => [name, String(c?.total ?? 0), red(c?.negative), csatCell(c),
        String(e?.checked ?? 0), String(e?.upset ?? 0), red(e?.missed), missCell(e)];
      const note = cx.unknownGroup ? `${cx.unknownGroup} empathy checks predate group tracking and only count in the total` : 'CSAT from Freshdesk · empathy from resolved/closed tickets';
      L.sectionTitle('Customer experience by group', note, (rows.length + 2) * L.ROW_H);
      L.table([{ label:'Group', width:L.W - cols.reduce((s, c) => s + c.width, 0) }, ...cols],
        rows.map(g => row(g.name, g.csat, g.empathy)),
        { totalRow: row('All groups', cx.totals.csat, cx.totals.empathy) });
    };

    if (!groups.length) drawCustomerExperience();

    if (groups.length) {
      const totals = data.totals;

      // ── Group comparison ──
      L.sectionTitle('Group comparison', 'Busiest groups first', (groups.length + 2) * L.ROW_H);
      L.table([{ label:'Group', width:L.W - used }, ...metricCols],
        groups.map(g => [g.name, ...cells(g.totals)]),
        { totalRow:['All groups', ...cells(totals)] });

      drawCustomerExperience();

      // ── One section per group ──
      for (const g of groups) {
        const agentRows = g.agents.map(a => [a.name, ...cells(a)]);
        const weekRows = g.weekly.filter(groupActivity).map(w => [weekLabel(w.label), ...cells(w)]);
        L.sectionTitle(g.name, `${g.agents.length} agent${g.agents.length === 1 ? '' : 's'} · ${g.totals.resolved} resolved · ${g.totals.closed} closed`,
          (agentRows.length + 2) * L.ROW_H);
        L.table([{ label:'Agent', width:L.W - used }, ...metricCols], agentRows,
          { totalRow:[`${Unit} total`, ...cells(g.totals)] });
        if (weekRows.length > 1) {
          L.ensure((weekRows.length + 1) * L.ROW_H + 4);
          L.y += 4;
          L.table([{ label:'Week', width:L.W - used }, ...metricCols], weekRows);
        }
      }
    }

    L.footers(`Group report · ${period}`);
    doc.end();
  });
}

module.exports = { buildMonthlyReports, buildRangeReports, buildGroupReports, generatePDF, generateTeamPDF, generateGroupPDF, monthBounds, weeksOfMonth,
  DEFAULT_THRESHOLDS, thresholdsFromRows, flagFor };
