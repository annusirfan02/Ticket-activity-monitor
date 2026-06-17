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
const FLAG_COLOR = { green:'#1a9d6a', yellow:'#d99400', red:'#d6334e' };

function generatePDF(report) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size:'A4', margin:42 });
    const chunks = [];
    doc.on('data', c=>chunks.push(c));
    doc.on('end', ()=>resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const sel = report.selected || [];
    const inc = (k)=>sel.includes(k);

    // Header
    doc.fillColor('#0d0f14').fontSize(20).font('Helvetica-Bold').text('Monthly Performance Report', { continued:false });
    doc.moveDown(0.2);
    doc.fontSize(12).fillColor('#444').font('Helvetica').text(`${report.name}  ·  ${report.email}`);
    doc.fontSize(10).fillColor('#888').text(`Month: ${report.monthKey}   |   Generated: ${new Date().toLocaleString('en-US')}`);
    doc.moveDown(0.6);

    // Top concerns banner
    if (report.concerns?.length) {
      doc.rect(42, doc.y, doc.page.width-84, 26).fill('#fdecee');
      doc.fillColor('#d6334e').fontSize(11).font('Helvetica-Bold')
         .text('⚠ Top Concerns: ' + report.concerns.join('  ·  '), 50, doc.y-19, { width: doc.page.width-100 });
      doc.moveDown(1.2);
    } else {
      doc.fillColor('#1a9d6a').fontSize(11).font('Helvetica-Bold').text('✓ No red-flag concerns this month');
      doc.moveDown(0.6);
    }

    doc.fillColor('#0d0f14');

    // Month totals with flags
    doc.fontSize(13).font('Helvetica-Bold').text('Month Summary');
    doc.moveDown(0.3);
    const t = report.totals;
    const row = (label, val, flag) => {
      const y = doc.y;
      doc.fontSize(10).font('Helvetica').fillColor('#333').text(label, 50, y, { width: 220, continued:false });
      if (flag) { doc.circle(285, y+5, 4).fill(FLAG_COLOR[flag]); doc.fillColor('#333'); }
      doc.font('Helvetica-Bold').fillColor('#0d0f14').text(String(val), 300, y);
      doc.moveDown(0.25);
    };
    if (inc('resolved_closed')) { row('Resolved (vs team avg '+report.teamAvg.resolved+')', t.resolved); row('Closed (vs team avg '+report.teamAvg.closed+')', t.closed); }
    if (inc('avg_response'))  row('Avg Response Time', t.avgResponseMin+' min', report.flags.avg_response);
    if (inc('first_reply'))   row('Avg First Reply Time', t.firstReplyMin+' min');
    if (inc('sla'))           row('Response-SLA Breach', t.slaBreachPct+'%  ('+t.slaBreached+'/'+t.slaDue+')', report.flags.sla_breach_pct);
    if (inc('late_shifts'))   row('Late Shifts (days)', t.lateShifts, report.flags.late_shifts);
    if (inc('off_breaks'))    row('Off-Schedule Breaks', t.offBreaks, report.flags.off_breaks);
    // custom statuses
    if (inc('custom') || inc('a2p') || inc('ghl')) {
      for (const [k,v] of Object.entries(t.custom||{})) row(k, v);
    }
    doc.moveDown(0.6);

    // Weekly breakdown table
    doc.fontSize(13).font('Helvetica-Bold').fillColor('#0d0f14').text('Weekly Breakdown');
    doc.moveDown(0.4);
    const cols = ['Week','New','Res','Closed','AvgResp','1stReply','SLA%'];
    const colX = [50, 200, 240, 280, 330, 400, 470];
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#666');
    cols.forEach((c,i)=>doc.text(c, colX[i], doc.y, { continued: i<cols.length-1 }));
    doc.moveDown(0.4);
    doc.font('Helvetica').fillColor('#222');
    for (const w of report.weekly) {
      const y = doc.y;
      const cells = [
        w.label.replace(/-\d{4}/g,'').replace(/2026-/g,''),
        w.newTickets, w.resolved, w.closed, w.avgResponseMin+'m', w.firstReplyMin+'m', w.slaBreachPct+'%'
      ];
      cells.forEach((c,i)=>doc.fontSize(8.5).text(String(c), colX[i], y, { continued: i<cells.length-1, width: i===0?145:38 }));
      doc.moveDown(0.5);
      if (doc.y > doc.page.height - 80) doc.addPage();
    }

    // Late shift detail
    if (inc('late_shifts') && report.lateDetail?.length) {
      doc.moveDown(0.6);
      doc.fontSize(12).font('Helvetica-Bold').fillColor('#0d0f14').text('Late Shift Detail');
      doc.moveDown(0.2);
      doc.fontSize(9).font('Helvetica').fillColor('#444');
      report.lateDetail.forEach(l=>doc.text(`• ${l.date}: ${l.lateMin} min late`));
    }

    // Off-break detail
    if (inc('off_breaks') && report.breakDetail?.length) {
      doc.moveDown(0.5);
      doc.fontSize(12).font('Helvetica-Bold').fillColor('#0d0f14').text("Off-Schedule Break Detail");
      doc.moveDown(0.2);
      doc.fontSize(9).font('Helvetica').fillColor('#444');
      report.breakDetail.forEach(b=>doc.text(`• ${b.date}: ${b.lateMin>0?'+':''}${b.lateMin} min off schedule`));
    }

    doc.moveDown(1);
    doc.fontSize(8).fillColor('#aaa').text('Generated by Activity Monitor · for performance discussion only', { align:'center' });

    doc.end();
  });
}

module.exports = { buildMonthlyReports, generatePDF, weeksOfMonth, DEFAULT_THRESHOLDS };
