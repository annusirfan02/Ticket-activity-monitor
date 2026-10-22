// scripts/empathy-review/pending.js — step 1 of the Claude empathy review.
//
// Lists resolved/closed tickets that have only the quick check so far, reads
// their conversations from Freshdesk (read-only), strips quoted email history,
// masks email addresses and phone numbers, and writes them to
// .empathy-review/pending.json for Claude to review. Prints how many are
// pending; 0 means there is nothing to do.
//
// usage: node scripts/empathy-review/pending.js [--days N] [--limit N]
// env:   FRESHDESK_DOMAIN, FRESHDESK_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY
require('dotenv').config();
const { describeError } = require('./net');
const fs = require('fs');
const path = require('path');
const D = require('../../api/db');
const E = require('../../api/empathy');
const T = require('../../api/ticket-thread');

const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 ? +process.argv[i + 1] : def; };
const DAYS = arg('--days', 3), LIMIT = arg('--limit', 25);
const MAX_MSG_CHARS = 1500;   // keep each message readable; long logs/signatures add nothing
const OUT_DIR = path.join(__dirname, '../../.empathy-review');

const mask = (s) => s
  .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
  .replace(/\+?\d[\d\s().-]{7,}\d/g, '[phone]');

(async () => {
  for (const k of ['FRESHDESK_DOMAIN', 'FRESHDESK_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY'])
    if (!process.env[k]) { console.error(`Missing env var ${k}`); process.exit(1); }
  const from = new Date(Date.now() - DAYS * 86400000).toISOString().slice(0, 10);
  // not yet reviewed and recent, or explicitly queued for a re-review ('recheck', any date)
  const { data, error } = await D.db().from('empathy_checks')
    .select('ticket_id,agent_name,subject,resolved_at,status')
    .or(`review_source.eq.recheck,and(review_source.neq.claude,resolved_date.gte.${from})`)
    .order('resolved_at', { ascending: true }).limit(LIMIT);
  if (error) throw new Error(`Supabase: ${error.message}${error.details ? ' | ' + error.details : ''}`);
  const tickets = [];
  for (const row of data || []) {
    try {
      const { messages } = await T.fetchTicketMessages(row.ticket_id);
      const thread = messages
        .filter(m => !m.private && m.text)
        .sort((a, b) => new Date(a.at) - new Date(b.at))
        .map(m => ({ from: m.incoming ? 'customer' : 'agent', at: m.at, text: mask(E.stripQuoted(m.text)).slice(0, MAX_MSG_CHARS) }))
        .filter(m => m.text);
      tickets.push({ ticket_id: row.ticket_id, agent: row.agent_name, subject: mask(row.subject || ''),
        status: row.status === 5 ? 'closed' : 'resolved', resolved_at: row.resolved_at, messages: thread });
    } catch (e) {
      console.error(`ticket ${row.ticket_id}: ${describeError(e)} (skipped, retried next run)`);
    }
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'pending.json'), JSON.stringify(tickets, null, 1));
  console.log(`pending: ${tickets.length}`);
})().catch(e => { console.error('ERR', describeError(e)); process.exit(1); });
