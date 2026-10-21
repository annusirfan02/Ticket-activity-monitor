// scripts/empathy-review/save.js — step 2 of the Claude empathy review.
//
// Reads Claude's verdicts from .empathy-review/results.json and stores them on
// the matching empathy_checks rows (review_source = 'claude'). Only tickets that
// were in pending.json are accepted, and every field is validated first.
//
// results.json: [{ ticket_id, summary, customer_upset, empathy_missing, reason,
//                  evidence: [{ customer, agent }] }]
// usage: node scripts/empathy-review/save.js [--model NAME]
// env:   SUPABASE_URL, SUPABASE_SERVICE_KEY
require('dotenv').config();
const { describeError } = require('./net');
const fs = require('fs');
const path = require('path');
const D = require('../../api/db');

const DIR = path.join(__dirname, '../../.empathy-review');
const i = process.argv.indexOf('--model');
const MODEL = i > 0 ? process.argv[i + 1] : 'claude';
const str = (v, max) => typeof v === 'string' ? v.trim().slice(0, max) : '';
// tolerate a UTF-8 byte-order mark (some editors/shells add one)
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8').replace(/^﻿/, ''));

(async () => {
  const pending = new Set(readJson('pending.json').map(t => t.ticket_id));
  const results = readJson('results.json');
  if (!Array.isArray(results)) throw new Error('results.json must be an array');
  let saved = 0; const problems = [];
  for (const r of results) {
    const id = +r.ticket_id;
    if (!pending.has(id)) { problems.push(`${r.ticket_id}: not in pending.json`); continue; }
    if (typeof r.customer_upset !== 'boolean' || typeof r.empathy_missing !== 'boolean' || !str(r.summary, 600)) {
      problems.push(`${id}: needs summary, customer_upset (true/false) and empathy_missing (true/false)`); continue;
    }
    const evidence = (Array.isArray(r.evidence) ? r.evidence : []).slice(0, 3)
      .map(e => ({ customer: str(e?.customer, 300), agent: str(e?.agent, 300) })).filter(e => e.customer || e.agent);
    const { error } = await D.db().from('empathy_checks').update({
      review_source: 'claude', summary: str(r.summary, 600),
      ai_upset: r.customer_upset, ai_empathy_missing: r.customer_upset && r.empathy_missing,
      ai_reason: str(r.reason, 600), ai_evidence: evidence,
      reviewed_at: new Date().toISOString(), reviewed_model: MODEL,
    }).eq('ticket_id', id);
    if (error) problems.push(`${id}: ${error.message}`); else saved++;
  }
  console.log(`saved: ${saved} of ${results.length}${problems.length ? `\nproblems:\n  ${problems.join('\n  ')}` : ''}`);
  if (problems.length && !saved) process.exit(1);
})().catch(e => { console.error('ERR', describeError(e)); process.exit(1); });
