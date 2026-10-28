// api/quality.js — CSAT and empathy figures shared by the Quality tab and the
// PDF reports, so every view counts the same way. Periods are inclusive
// YYYY-MM-DD dates in DISPLAY_TZ.
const axios = require('axios');
const D = require('./db');
const A = require('./attendance');

const fdBase = () => `https://${process.env.FRESHDESK_DOMAIN}/api/v2`;
const fdHeaders = () => ({
  Authorization: 'Basic ' + Buffer.from(`${process.env.FRESHDESK_API_KEY}:X`).toString('base64'),
  'Content-Type': 'application/json',
});
const ticketUrl = (id) => `https://${process.env.FRESHDESK_DOMAIN}/a/tickets/${id}`;
const pct = (n, d) => d ? +((n / d) * 100).toFixed(1) : null;

// ── CSAT (Freshdesk satisfaction ratings, read live) ──
// Freshdesk scores: 101–103 positive, 100 neutral, -101…-103 negative.
const csatTone = (v) => v > 100 ? 'positive' : v < 0 ? 'negative' : 'neutral';

async function fdAgentEmails() {
  const out = {};
  for (let page = 1; page <= 5; page++) {
    const { data } = await axios.get(`${fdBase()}/agents?per_page=100&page=${page}`, { headers: fdHeaders(), timeout: 20000 });
    for (const a of data || []) out[a.id] = (a.contact?.email || '').toLowerCase().trim();
    if (!data || data.length < 100) break;
  }
  return out;
}

// Ratings created in the period: [{ email, groupId, tone, ticketId, createdAt, feedback }]
async function fetchCsatRatings(fromDate, toDate) {
  // a day of margin either side; exact filtering is by date in DISPLAY_TZ
  const since = new Date(Date.parse(fromDate + 'T00:00:00Z') - 86400000).toISOString();
  const raw = [];
  for (let page = 1; page <= 30; page++) {
    const { data } = await axios.get(`${fdBase()}/surveys/satisfaction_ratings?created_since=${since}&per_page=100&page=${page}`,
      { headers: fdHeaders(), timeout: 20000 });
    raw.push(...(data || []));
    if (!data || data.length < 100) break;
  }
  const emails = await fdAgentEmails();
  return raw
    .filter(r => { const day = A.shiftDate(Date.parse(r.created_at)); return day >= fromDate && day <= toDate; })
    .map(r => ({ email: emails[r.agent_id] || null, groupId: r.group_id || 0, tone: csatTone(+(r.ratings?.default_question)),
      ticketId: r.ticket_id, createdAt: r.created_at, feedback: r.feedback || '' }));
}

function csatTotals(ratings) {
  const t = { total: ratings.length, positive: 0, neutral: 0, negative: 0 };
  for (const r of ratings) t[r.tone]++;
  t.csatPct = pct(t.positive, t.total);
  return t;
}

// ── EMPATHY (empathy_checks) ──
// Only the Claude review (scheduled routine) decides: it reads and summarises
// the whole thread. The keyword quick check just queues tickets; a ticket that
// hasn't been reviewed yet is "awaiting review" and counts neither way.
function empathyVerdict(r) {
  const reviewed = r.review_source === 'claude';
  return { reviewed, pending: !reviewed, upset: reviewed && !!r.ai_upset, missed: reviewed && !!r.ai_empathy_missing };
}

function empathyTotals(rows) {
  const t = { checked: rows.length, reviewed: 0, pending: 0, upset: 0, acknowledged: 0, missed: 0 };
  for (const r of rows) {
    const v = empathyVerdict(r);
    if (v.reviewed) t.reviewed++; else t.pending++;
    if (v.upset) t.upset++;
    if (v.upset && !v.missed) t.acknowledged++;
    if (v.missed) t.missed++;
  }
  t.missedPct = pct(t.missed, t.upset);
  return t;
}

// Missed tickets for a report: ticket, date and a short reason (no customer quotes).
function empathyMissedList(rows) {
  return rows.filter(r => empathyVerdict(r).missed).map(r => ({
    ticketId: r.ticket_id, url: r.ticket_url || ticketUrl(r.ticket_id), date: r.resolved_date,
    source: 'claude', reason: r.ai_reason || '',
    frustration: r.ai_frustration ?? null, handling: r.ai_handling ?? null, coaching: r.ai_coaching || '',
  }));
}

// Handling score (1–5, flagged tickets) -> label
function handlingLabel(s) {
  return s == null ? null : s >= 4 ? 'Minor miss' : s === 3 ? 'Partial' : 'Major miss';
}

// ── SOP (sop_checks, Claude review against the agency SOP in Notion) ──
// Only tickets whose SOP covers the topic are judged; 'no_sop' and
// 'not_covered' are never flagged.
function sopTotals(rows) {
  const t = { reviewed: rows.length, noSop: 0, notCovered: 0, followed: 0, incorrect: 0 };
  for (const r of rows) {
    if (r.verdict === 'no_sop') t.noSop++;
    else if (r.verdict === 'not_covered') t.notCovered++;
    else if (r.verdict === 'followed') t.followed++;
    else if (r.verdict === 'incorrect') t.incorrect++;
  }
  t.covered = t.followed + t.incorrect;
  t.incorrectPct = pct(t.incorrect, t.covered);
  return t;
}

// Flagged (incorrect) tickets: ticket, date, topic, what the SOP says and what the agent did.
function sopIncorrectList(rows) {
  return rows.filter(r => r.verdict === 'incorrect').map(r => ({
    ticketId: r.ticket_id, url: r.ticket_url || ticketUrl(r.ticket_id), date: r.resolved_date,
    topic: r.topic || '', sopTitle: r.sop_title || '', sopUrl: r.sop_url || '',
    sopRule: r.sop_rule || '', agentAction: r.agent_action || '', reason: r.reason || '',
  }));
}

// Freshdesk group id -> name (0 = no group).
async function fdGroupNames() {
  const out = { 0: 'No group' };
  for (let page = 1; page <= 5; page++) {
    const { data } = await axios.get(`${fdBase()}/groups?per_page=100&page=${page}`, { headers: fdHeaders(), timeout: 20000 });
    for (const g of data || []) out[g.id] = g.name;
    if (!data || data.length < 100) break;
  }
  return out;
}

/**
 * CSAT and empathy per ticket group for a period (Group PDF). Only ratings and
 * tickets of tracked agents count, like the group stats. Returns
 * { groups: [{ id, name, csat, empathy }], totals: { csat, empathy } } where a
 * part is null if it couldn't be loaded.
 */
async function groupCustomerExperience(fromDate, toDate, trackedEmails) {
  const [ratingsRes, rowsRes, namesRes, sopRes] = await Promise.allSettled([
    fetchCsatRatings(fromDate, toDate), D.getEmpathyRange(fromDate, toDate), fdGroupNames(), D.getSopRange(fromDate, toDate),
  ]);
  const ratings = ratingsRes.status === 'fulfilled' ? ratingsRes.value.filter(r => trackedEmails.has(r.email)) : null;
  const rows = rowsRes.status === 'fulfilled' ? rowsRes.value.filter(r => trackedEmails.has(r.agent_email)) : null;
  const names = namesRes.status === 'fulfilled' ? namesRes.value : { 0: 'No group' };
  const sop = sopRes.status === 'fulfilled' ? sopRes.value.filter(r => trackedEmails.has(r.agent_email)) : null;
  const grouped = rows ? rows.filter(r => r.group_id != null) : null;   // group known
  const ids = new Set([...(ratings || []).map(r => +r.groupId || 0), ...(grouped || []).map(r => +r.group_id || 0),
    ...(sop || []).map(r => +r.group_id || 0)]);
  const groups = [...ids].map(id => ({
    id, name: names[id] || `Group ${id}`,
    csat: ratings ? csatTotals(ratings.filter(r => (+r.groupId || 0) === id)) : null,
    empathy: grouped ? empathyTotals(grouped.filter(r => (+r.group_id || 0) === id)) : null,
    sop: sop ? sopTotals(sop.filter(r => (+r.group_id || 0) === id)) : null,
  }));
  // flagged SOP tickets with agent and group, for the Group PDF
  const sopIncorrect = sop ? sopIncorrectList(sop).map((it, i) => {
    const r = sop.filter(x => x.verdict === 'incorrect')[i];
    return { ...it, agent: r.agent_name || r.agent_email, group: names[+r.group_id || 0] || `Group ${r.group_id}` };
  }) : [];
  return { groups, sopIncorrect,
    totals: { csat: ratings ? csatTotals(ratings) : null, empathy: rows ? empathyTotals(rows) : null, sop: sop ? sopTotals(sop) : null },
    // rows checked before group_id was recorded have no group
    unknownGroup: rows ? rows.filter(r => r.group_id == null).length : 0 };
}

module.exports = { fetchCsatRatings, csatTotals, csatTone, empathyVerdict, empathyTotals, empathyMissedList, handlingLabel,
  sopTotals, sopIncorrectList, fdAgentEmails,
  fdGroupNames, groupCustomerExperience, ticketUrl, pct };
