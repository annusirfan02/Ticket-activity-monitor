// api/report.js — month-end report computation + PDF generation
const PDFDocument = require('pdfkit');
const D = require('./db');

// Default flag thresholds (editable via dashboard → stored in DB)
const DEFAULT_THRESHOLDS = {
  late_shifts:    { green_max: 1,  yellow_max: 3 },   // days late in month
  off_breaks:     { green_max: 1,  yellow_max: 3 },   // off-schedule breaks in month
  avg_response:   { green_max: 15, yellow_max: 30 },  // minutes
  sla_breach_pct: { green_max: 5,  yellow_max: 15 },  // percent
};

function flagFor(metric, value, thresholds) {
  const t = thresholds[metric] || DEFAULT_THRESHOLDS[metric];
  if (!t) return 'green';
  if (value <= t.green_max) return 'green';
  if (value <= t.yellow_max) return 'yellow';
  return 'red';
}

// month boundaries
function monthBounds(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end   = new Date(Date.UTC(y, m, 0)); // last day of month
  return { fromDate: start.toISOString().split('T')[0], toDate: end.toISOString().split('T')[0], y, m };
}

// Split a month into ISO week buckets (Mon-Sun) covering all days
function weeksOfMonth(monthKey) {
  const { y, m } = monthBounds(monthKey);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const weeks = []; let cur = [];
  for (let d = 1; d <= last; d++) {
    const date = new Date(Date.UTC(y, m - 1, d));
    cur.push(date.toISOString().split('T')[0]);
    if (date.getUTCDay() === 0 || d === last) { // Sunday or month end
      weeks.push({ label: `${cur[0]} → ${cur[cur.length-1]}`, days: [...cur] });
      cur = [];
    }
  }
  return weeks;
}

/**
 * Build the full report data for ALL active agents for a given month.
 * options.selected = array of section keys to include (checkbox selection).
 */
async function buildMonthlyReports(monthKey, options = {}) {
  const { fromDate, toDate } = monthBounds(monthKey);
  const selected = options.selected || ['resolved_closed','a2p','ghl','custom','avg_response','first_reply','sla','late_shifts','off_breaks'];

  // thresholds
  const thRows = await D.getThresholds();
  const thresholds = { ...DEFAULT_THRESHOLDS };
  for (const r of thRows) thresholds[r.metric] = { green_max: +r.green_max, yellow_max: +r.yellow_max };

  // pull data
  const [agents, statsRange, slaRange, lateShifts, breakLogs] = await Promise.all([
    D.getAgents(),
    D.getStatsRange(fromDate, toDate),
    D.getSlaRange(fromDate, toDate),
    D.getLateShifts(monthKey),
    D.getBreakLogRange(fromDate, toDate),
  ]);

  const weeks = weeksOfMonth(monthKey);

  // index data by agent
  const byAgent = {};
  for (const a of agents) byAgent[a.email] = { email: a.email, name: a.name || a.email, stats: [], sla: [], late: [], breaks: [] };
  for (const s of statsRange) (byAgent[s.agent_email] = byAgent[s.agent_email] || { email:s.agent_email, name:s.agent_email, stats:[], sla:[], late:[], breaks:[] }).stats.push(s);
  for (const s of slaRange)   (byAgent[s.agent_email] || {}).sla?.push(s);
  for (const l of lateShifts) (byAgent[l.agent_email] || {}).late?.push(l);
  for (const b of breakLogs)  (byAgent[b.agent_email] || {}).breaks?.push(b);

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
      const avgResp = avg(wStats, 'avg_response_min');
      const firstReply = avg(wStats, 'first_reply_min');
      // custom statuses for the week
      const custom = {};
      for (const s of wStats) for (const [k,v] of Object.entries(s.custom_counts||{})) custom[k]=(custom[k]||0)+(+v||0);
      return {
        label: w.label, newTickets:newT, resolved:res, closed:cl,
        avgResponseMin: avgResp, firstReplyMin: firstReply,
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
    const avgResp = avg(a.stats,'avg_response_min');
    const firstReply = avg(a.stats,'first_reply_min');
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

    reports.push({
      email, name: a.name, monthKey,
      weekly,
      totals: {
        resolved: totResolved, closed: totClosed,
        avgResponseMin: avgResp, firstReplyMin: firstReply,
        slaDue: totDue, slaBreached: totBreach, slaBreachPct,
        lateShifts: lateDays, offBreaks,
        custom: customTotals,
      },
      lateDetail: a.late.map(l=>({date:l.log_date, lateMin:l.late_min})),
      breakDetail: a.breaks.map(b=>({date:b.log_date, lateMin:b.late_min})),
      flags, concerns, selected,
    });
  }

  const teamAvg = {
    resolved: teamAgg.agents ? +(teamAgg.resolved/teamAgg.agents).toFixed(1) : 0,
    closed: teamAgg.agents ? +(teamAgg.closed/teamAgg.agents).toFixed(1) : 0,
    avgResponseMin: teamAgg.avgRespN ? +(teamAgg.avgRespSum/teamAgg.avgRespN).toFixed(1) : 0,
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
function weekLabel(label) {
  const [a, b] = String(label).match(/\d{4}-\d{2}-\d{2}/g) || [];
  if (!a) return String(label);
  return !b || a === b ? dayLabel(a) : `${dayLabel(a)} – ${dayLabel(b)}`;
}

function generatePDF(report) {
  return new Promise((resolve, reject) => {
    const month = monthLabel(report.monthKey);
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
       .text('MONTHLY PERFORMANCE REPORT', M, 30, { characterSpacing:1.5, lineBreak:false });
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
    {
      const tone = concerns.length ? 'red' : 'green';
      const h = concerns.length ? 34 + concerns.length * 16 : 36;
      doc.roundedRect(M, y, W, h, 6).fill(FLAG_TINT[tone]);
      doc.rect(M, y, 4, h).fill(FLAG_COLOR[tone]);
      doc.font('Helvetica-Bold').fontSize(10.5).fillColor(FLAG_COLOR[tone])
         .text(concerns.length ? 'Top concerns' : 'No red-flag concerns this month', M + 18, y + 12, { lineBreak:false });
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
      sub: t.lateShifts === 1 ? 'day this month' : 'days this month', flag:f.late_shifts });
    if (inc('off_breaks'))   cards.push({ label:'Off-schedule breaks', value:String(t.offBreaks ?? 0),
      sub:'this month', flag:f.off_breaks });

    if (cards.length) {
      sectionTitle('Month at a glance');
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
      sectionTitle('Ticket statuses', 'Total for the month', (custom.length + 1) * 22);
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
        { totalRow: ['Month total', String(totalNew), String(t.resolved ?? 0), String(t.closed ?? 0),
          fmtMin(t.avgResponseMin), fmtMin(t.firstReplyMin),
          { text: t.slaDue ? `${t.slaBreachPct}%` : '–', color: f.sla_breach_pct ? FLAG_COLOR[f.sla_breach_pct] : undefined }] });
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

module.exports = { buildMonthlyReports, generatePDF, weeksOfMonth, DEFAULT_THRESHOLDS };
