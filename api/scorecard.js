// api/scorecard.js — Tickets seat weekly scorecard. Takes the team's
// measurables for one Mon–Sun week (dates as in the reports) from the same
// figures the reports use, and is stored as a snapshot in weekly_scorecards.
const R = require('./report');
const D = require('./db');
const Q = require('./quality');

const SECTIONS = ['resolved_closed', 'avg_response', 'first_reply', 'sla', 'csat', 'empathy', 'sop'];
const DAY = 86400000;
const iso = (ts) => new Date(ts).toISOString().split('T')[0];

// Monday..Sunday of the week containing dateStr (YYYY-MM-DD)
function weekBounds(dateStr) {
  const ts = Date.parse(dateStr + 'T00:00:00Z');
  const mon = ts - ((new Date(ts).getUTCDay() + 6) % 7) * DAY;
  return { from: iso(mon), to: iso(mon + 6 * DAY) };
}
// Monday of the last full week before `now`
const lastFullWeekStart = (now = Date.now()) => weekBounds(iso(now - 7 * DAY)).from;

async function buildScorecard(weekStart) {
  const { from, to } = weekBounds(weekStart);
  const [thresholds, reps] = await Promise.all([
    D.getThresholds().then(R.thresholdsFromRows),
    R.buildRangeReports(from, to, { selected: SECTIONS }),
  ]);
  const team = reps[0]?.teamAvg || {};
  const tsum = (k) => reps.reduce((s, r) => s + (+r.totals[k] || 0), 0);
  const due = tsum('slaDue'), breached = tsum('slaBreached');
  const csat = team.csat, emp = team.empathy, sop = team.sop;

  const measurables = [
    { key: 'sla', label: 'First response within SLA', unit: '%',
      value: due ? +(100 - (breached / due) * 100).toFixed(1) : null,
      detail: due ? `${due - breached} of ${due} met · ${breached} breached` : 'no tickets due',
      flag: due ? R.flagFor('sla_breach_pct', +((breached / due) * 100).toFixed(1), thresholds) : null },
    { key: 'first_reply', label: 'Avg first reply time', unit: 'min',
      value: team.firstReplyMin || null,
      detail: team.firstReplies != null ? `${team.firstReplies} first replies · working hours` : 'working hours',
      flag: null },
    { key: 'csat', label: 'CSAT', unit: '%',
      value: csat?.csatPct ?? null,
      detail: csat?.total ? `${csat.positive} positive · ${csat.neutral} neutral · ${csat.negative} negative of ${csat.total}` : 'no ratings',
      flag: csat?.csatPct != null ? R.flagFor('csat_pct', csat.csatPct, thresholds) : null },
    { key: 'empathy', label: 'QA · Empathy missed', unit: '%',
      value: emp?.missedPct ?? null,
      detail: emp ? `${emp.missed} missed of ${emp.upset} upset · ${emp.reviewed} reviewed${emp.pending ? ` · ${emp.pending} awaiting review` : ''}` : 'not available',
      flag: emp?.missedPct != null ? R.flagFor('empathy_missed_pct', emp.missedPct, thresholds) : null },
    { key: 'sop', label: 'QA · Against SOP', unit: '%',
      value: sop?.covered ? sop.incorrectPct : null,
      detail: sop ? `${sop.incorrect} incorrect of ${sop.covered} covered · ${sop.reviewed} reviewed` : 'not available',
      flag: sop?.covered ? (sop.incorrect ? 'red' : 'green') : null },
  ];

  // agents with any activity in the week
  const agents = reps.map(r => {
    const t = r.totals;
    return {
      name: r.name || r.email, email: r.email, resolved: t.resolved, closed: t.closed,
      slaDue: t.slaDue, slaBreached: t.slaBreached,
      slaMetPct: t.slaDue ? +(100 - t.slaBreachPct).toFixed(1) : null,
      firstReplyMin: t.firstReplyMin || null,
      csat: r.csat && !r.csat.unavailable ? { total: r.csat.total, positive: r.csat.positive, negative: r.csat.negative, csatPct: r.csat.csatPct } : null,
      empathy: r.empathy && !r.empathy.unavailable ? { reviewed: r.empathy.reviewed, upset: r.empathy.upset, missed: r.empathy.missed, missedPct: r.empathy.missedPct } : null,
      sop: r.sop && !r.sop.unavailable ? { reviewed: r.sop.reviewed, covered: r.sop.covered, incorrect: r.sop.incorrect, incorrectPct: r.sop.incorrectPct } : null,
    };
  }).filter(a => a.resolved || a.closed || a.slaDue || a.csat?.total || a.empathy?.reviewed || a.sop?.reviewed)
    .sort((a, b) => (b.resolved + b.closed) - (a.resolved + a.closed));

  // flagged tickets (reasons only, no customer quotes)
  const flagged = {
    empathy: reps.flatMap(r => (r.empathy?.missedList || []).map(it => ({
      ticketId: it.ticketId, url: it.url, date: it.date, agent: r.name || r.email,
      reason: it.reason, handling: Q.handlingLabel(it.handling) }))),
    sop: reps.flatMap(r => (r.sop?.incorrectList || []).map(it => ({
      ticketId: it.ticketId, url: it.url, date: it.date, agent: r.name || r.email,
      topic: it.topic, sopRule: it.sopRule, agentAction: it.agentAction }))),
  };

  return {
    weekStart: from, weekEnd: to, generatedAt: new Date().toISOString(),
    measurables, agents, flagged,
    totals: { resolved: tsum('resolved'), closed: tsum('closed'), slaDue: due, slaBreached: breached, csatRatings: csat?.total ?? 0 },
  };
}

async function generateAndSave(weekStart) {
  const card = await buildScorecard(weekStart);
  await D.saveScorecard(card.weekStart, card.weekEnd, card);
  return card;
}

module.exports = { weekBounds, lastFullWeekStart, buildScorecard, generateAndSave };
