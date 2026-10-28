// scripts/sop-review/pending.js — step 1 of the Claude SOP review.
//
// Lists recently resolved/closed tickets (from empathy_checks, which has every
// tracked agent's resolved ticket) that have no SOP verdict yet, or were queued
// for a re-review (sop_checks.review_source = 'recheck'). Reads each ticket and
// its conversation from Freshdesk (read-only), works out the agency's
// relationship ID, and writes them to .sop-review/pending.json for Claude.
// Prints how many are pending; 0 means there is nothing to do.
//
// usage: node scripts/sop-review/pending.js [--days N] [--limit N]
// env:   FRESHDESK_DOMAIN, FRESHDESK_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY
require('dotenv').config();
const { describeError } = require('../empathy-review/net');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const D = require('../../api/db');
const E = require('../../api/empathy');
const T = require('../../api/ticket-thread');

const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 ? +process.argv[i + 1] : def; };
const DAYS = arg('--days', 3), LIMIT = arg('--limit', 15);
const MAX_MSG_CHARS = 1500;
const OUT_DIR = path.join(__dirname, '../../.sop-review');

// Agents quote the agency's support/escalation email, so emails in agent
// messages stay; customer emails and all phone numbers are masked.
const maskPhone = (s) => s.replace(/\+?\d[\d\s().-]{7,}\d/g, '[phone]');
const maskEmail = (s) => s.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]');
// "0-116-776", "0116776", "0 -013 -416" -> "0-116-776"
function relationshipId(v) {
  const m = String(v || '').match(/\b0\s*-?\s*\d{3}\s*-?\s*\d{3}\b/);
  if (!m) return null;
  const d = m[0].replace(/\D/g, '');
  return `${d[0]}-${d.slice(1, 4)}-${d.slice(4)}`;
}
const host = (u) => { try { return new URL(/^https?:/.test(u) ? u : 'https://' + u).hostname; } catch { return null; } };

const fdHeaders = () => ({ Authorization: 'Basic ' + Buffer.from(`${process.env.FRESHDESK_API_KEY}:X`).toString('base64') });
const companies = {};
async function company(id) {
  if (!id) return null;
  if (!(id in companies)) {
    try {
      const { data } = await axios.get(`https://${process.env.FRESHDESK_DOMAIN}/api/v2/companies/${id}`, { headers: fdHeaders(), timeout: 20000 });
      companies[id] = { name: data.name, relationshipId: relationshipId(data.custom_fields?.relationship_id), wlUrl: data.custom_fields?.white_label_url || null };
    } catch { companies[id] = null; }
  }
  return companies[id];
}

(async () => {
  for (const k of ['FRESHDESK_DOMAIN', 'FRESHDESK_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY'])
    if (!process.env[k]) { console.error(`Missing env var ${k}`); process.exit(1); }
  const from = new Date(Date.now() - DAYS * 86400000).toISOString().slice(0, 10);
  const cols = 'ticket_id,agent_email,agent_name,subject,ticket_url,group_id,resolved_at,resolved_date,status';
  const sb = D.db();
  const { data: recent, error } = await sb.from('empathy_checks').select(cols).gte('resolved_date', from).order('resolved_at', { ascending: true });
  if (error) throw new Error(`Supabase: ${error.message}`);
  const { data: rechecks, error: e2 } = await sb.from('sop_checks').select('ticket_id').eq('review_source', 'recheck');
  if (e2) throw new Error(`Supabase: ${e2.message}${/schema cache/.test(e2.message) ? ' (run the sop_checks SQL from db/schema.sql)' : ''}`);
  // already reviewed (any verdict) -> skip, unless queued for a recheck
  const done = new Set();
  const ids = (recent || []).map(r => r.ticket_id);
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error: e3 } = await sb.from('sop_checks').select('ticket_id').eq('review_source', 'claude').in('ticket_id', ids.slice(i, i + 200));
    if (e3) throw new Error(`Supabase: ${e3.message}`);
    (data || []).forEach(r => done.add(r.ticket_id));
  }
  let rows = (recent || []).filter(r => !done.has(r.ticket_id));
  const recheckIds = (rechecks || []).map(r => r.ticket_id).filter(id => !rows.some(r => r.ticket_id === id));
  if (recheckIds.length) {
    const { data, error: e4 } = await sb.from('empathy_checks').select(cols).in('ticket_id', recheckIds.slice(0, 200));
    if (e4) throw new Error(`Supabase: ${e4.message}`);
    rows = [...(data || []), ...rows];
  }
  rows = rows.slice(0, LIMIT);

  const tickets = [];
  for (const row of rows) {
    try {
      const { ticket: t, messages } = await T.fetchTicketMessages(row.ticket_id);
      const co = await company(t.company_id);
      const cf = t.custom_fields || {};
      const thread = messages
        .filter(m => m.text)
        .sort((a, b) => new Date(a.at) - new Date(b.at))
        .map(m => {
          let text = maskPhone(E.stripQuoted(m.text));
          if (m.incoming) text = maskEmail(text);
          return { from: m.incoming ? 'customer' : m.private ? 'agent_internal_note' : 'agent', at: m.at, text: text.slice(0, MAX_MSG_CHARS) };
        })
        .filter(m => m.text);
      tickets.push({
        ticket_id: row.ticket_id, agent: row.agent_name, subject: maskPhone(row.subject || ''),
        status: row.status === 5 ? 'closed' : 'resolved', resolved_at: row.resolved_at,
        agency: {
          relationship_id: relationshipId(cf.cf_relationship_id) || co?.relationshipId || null,
          company: co?.name || null,
          white_label_host: host(co?.wlUrl || '') || host(cf.cf_current_url || '') || null,
        },
        area: cf.cf_area_ticket_relates_to || null,
        messages: thread,
        // for save.js; not needed for the review
        _meta: { agent_email: row.agent_email, agent_name: row.agent_name, subject: row.subject, ticket_url: row.ticket_url,
          group_id: row.group_id, resolved_at: row.resolved_at, resolved_date: row.resolved_date },
      });
    } catch (e) {
      console.error(`ticket ${row.ticket_id}: ${describeError(e)} (skipped, retried next run)`);
    }
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'pending.json'), JSON.stringify(tickets, null, 1));
  console.log(`pending: ${tickets.length}`);
})().catch(e => { console.error('ERR', describeError(e)); process.exit(1); });
