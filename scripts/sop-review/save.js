// scripts/sop-review/save.js — step 2 of the Claude SOP review.
//
// Reads Claude's verdicts from .sop-review/results.json and stores them in
// sop_checks (review_source = 'claude'). Only tickets that were in
// pending.json are accepted, and every field is validated first.
//
// results.json: [{ ticket_id, verdict, summary, topic, sop_title, sop_url,
//                  sop_rule, agent_action, reason }]
//   verdict: 'no_sop' | 'not_covered' | 'followed' | 'incorrect'
// usage: node scripts/sop-review/save.js [--model NAME]
// env:   SUPABASE_URL, SUPABASE_SERVICE_KEY
require('dotenv').config();
const { describeError } = require('../empathy-review/net');
const fs = require('fs');
const path = require('path');
const D = require('../../api/db');

const DIR = path.join(__dirname, '../../.sop-review');
const i = process.argv.indexOf('--model');
const MODEL = i > 0 ? process.argv[i + 1] : 'claude';
const VERDICTS = ['no_sop', 'not_covered', 'followed', 'incorrect'];
const str = (v, max) => typeof v === 'string' ? v.trim().slice(0, max) : '';
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8').replace(/^﻿/, ''));
const notionUrl = (u) => /^https:\/\/(app|www)\.notion\.(com|so)\//.test(str(u, 300)) ? str(u, 300) : '';

(async () => {
  const pending = new Map(readJson('pending.json').map(t => [t.ticket_id, t]));
  const results = readJson('results.json');
  if (!Array.isArray(results)) throw new Error('results.json must be an array');
  let saved = 0; const problems = [];
  for (const r of results) {
    const id = +r.ticket_id, p = pending.get(id);
    if (!p) { problems.push(`${r.ticket_id}: not in pending.json`); continue; }
    if (!VERDICTS.includes(r.verdict) || !str(r.summary, 600)) {
      problems.push(`${id}: needs summary and verdict (${VERDICTS.join(' / ')})`); continue;
    }
    const hasSop = r.verdict !== 'no_sop';
    if (hasSop && !notionUrl(r.sop_url)) { problems.push(`${id}: verdict ${r.verdict} needs sop_url (the Notion page you read)`); continue; }
    if (['followed', 'incorrect'].includes(r.verdict) && !str(r.sop_rule, 600)) { problems.push(`${id}: verdict ${r.verdict} needs sop_rule`); continue; }
    if (r.verdict === 'incorrect' && (!str(r.agent_action, 600) || !str(r.reason, 600))) {
      problems.push(`${id}: verdict incorrect needs agent_action and reason`); continue;
    }
    const m = p._meta;
    const row = {
      ticket_id: id, agent_email: m.agent_email, agent_name: m.agent_name, subject: m.subject, ticket_url: m.ticket_url,
      group_id: m.group_id, resolved_at: m.resolved_at, resolved_date: m.resolved_date,
      relationship_id: p.agency?.relationship_id || null,
      review_source: 'claude', verdict: r.verdict, summary: str(r.summary, 600), topic: str(r.topic, 200),
      sop_title: hasSop ? str(r.sop_title, 200) : null, sop_url: hasSop ? notionUrl(r.sop_url) : null,
      sop_rule: hasSop ? str(r.sop_rule, 600) || null : null,
      agent_action: r.verdict === 'incorrect' ? str(r.agent_action, 600) : null,
      reason: str(r.reason, 600), reviewed_at: new Date().toISOString(), reviewed_model: MODEL,
    };
    const { error } = await D.db().from('sop_checks').upsert(row, { onConflict: 'ticket_id' });
    if (error) problems.push(`${id}: ${error.message}`); else saved++;
  }
  console.log(`saved: ${saved} of ${results.length}${problems.length ? `\nproblems:\n  ${problems.join('\n  ')}` : ''}`);
  if (problems.length && !saved) process.exit(1);
})().catch(e => { console.error('ERR', describeError(e)); process.exit(1); });
