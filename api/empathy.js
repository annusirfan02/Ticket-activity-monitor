// api/empathy.js — rule-based (no AI) empathy check for resolved/closed tickets.
//
// A ticket is flagged when a customer message is upset and the next public
// agent reply contains no acknowledgement phrase. Messages that aren't upset are
// not judged (routine replies don't need "sorry").
//
// "Upset" = negative tone OR strong emotion words:
//  - Tone is scored with VADER (vader-sentiment), a rule-based sentiment scorer
//    for short informal text: it weighs negation, intensifiers, "but" clauses,
//    caps and "!!", and gives -1 (very negative) … +1 (very positive). A whole
//    message at or below NEGATIVE_TONE counts. Status updates like "still can't
//    see it" score neutral, so they no longer trigger on their own.
//  - Strong emotion words catch frustration VADER underrates in support
//    language ("this is getting ridiculous", "tired of", "!!").
// Urgency alone ("ASAP", "please escalate") is not treated as upset.
const vader = require('vader-sentiment');
const NEGATIVE_TONE = -0.5;
// Support vocabulary that describes the problem, not the customer's mood. VADER
// scores these as negative ("Error 404 when adding a card", "No other email",
// "tel no.", "this failed"), so they're neutralised before scoring tone.
const TECHNICAL_WORDS = /\b(no\.?|errors?|issues?|problems?|bugs?|fail(s|ed|ing|ure)?|missing|wrong|incorrect|invalid|denied|declined|rejected|rejection|stuck|unable|cannot|can'?t|not working)\b/gi;
const STRONG_EMOTION = [
  /\bfrustrat\w*/i, /\bunacceptable\b/i, /\bridiculous\b/i, /\b(tired|sick) of\b/i, /\bfed up\b/i,
  /\bangry\b/i, /\bfurious\b/i, /\bdisappoint\w*/i, /\bupset\b/i, /\bannoy\w*/i,
  /\b(terrible|horrible|awful|worst|useless|pathetic)\b/i, /\bwaste of (my )?(time|money)\b/i,
  /\blos(ing|t) (money|clients|customers|business|leads|sales)\b/i,
  /\bcancel (my|our|the) (account|subscription|plan|service)\b/i,
  /\b(how many|so many) times\b/i, /\bchargeback\b/i, /\blawyer\b/i,
  /!{2,}/,
];
const tone = (text) => vader.SentimentIntensityAnalyzer.polarity_scores(text.replace(TECHNICAL_WORDS, 'item')).compound;
// The most negative sentence, to show as the excerpt when tone alone triggered.
function mostNegativeSentence(text) {
  const parts = text.split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(s => s.length > 3);
  let best = null, bestScore = Infinity;
  for (const s of parts) { const v = tone(s); if (v < bestScore) { best = s; bestScore = v; } }
  return best || text;
}

// Agent acknowledgement / empathy phrases.
const EMPATHY = [
  /\bsorry\b/i, /\bapolog\w*/i, /\bregret\b/i,
  /\b(i|we) (completely |totally |fully |really |truly )?understand\b/i,
  /\b(i|we) can (see|imagine|understand)\b/i, /\bi hear you\b/i, /\b(i|we) know how\b/i,
  /\b(this|that|it) (must|can|could) be (so |very |really )?(frustrating|annoying|difficult|stressful|inconvenient|confusing)\b/i,
  /\b(this|that|it) (sounds|is) (so |very |really )?(frustrating|annoying|stressful|inconvenient)\b/i,
  /\binconvenience\b/i,
  /\bthank(s| you) (so much |very much )?for (your|the) (patience|understanding|waiting|bearing|cooperation|feedback|time)\b/i,
  /\bappreciate (your|the) (patience|understanding|feedback|time|cooperation)\b/i,
  /\brest assured\b/i, /\b(i|we)('ll| will) (make sure|personally|take care of)\b/i,
  /\b(i|we)('m| am|'re| are) (here to help|happy to help|glad to help)\b/i,
];

// Drop quoted history and signatures so a reply is judged on its own words.
function stripQuoted(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim(), next = (lines[i + 1] || '').trim();
    if ((/^On\b.{0,200}\d/.test(l) && /wrote:\s*$/i.test(l + ' ' + next))
      || /^-{2,}\s*(Original|Forwarded) Message/i.test(l)
      || /^_{10,}$/.test(l)                                        // Outlook separator line
      || (/^(From|Från|Fra|Von|De|Van|Da|Od):\s/i.test(l) && out.length)  // quoted header, several languages
      || /^Sent from my\b/i.test(l)) break;
    if (l.startsWith('>')) continue;
    out.push(lines[i]);
  }
  return out.join('\n').trim();
}

function excerpt(text, index, len) {
  const s = Math.max(0, index - 60), e = Math.min(text.length, index + len + 60);
  return (s > 0 ? '…' : '') + text.slice(s, e).replace(/\s+/g, ' ').trim() + (e < text.length ? '…' : '');
}
// Returns { cue, excerpt, tone } when the customer message is upset, else null.
// cue = the strong-emotion words, or "negative tone" when VADER alone triggered.
function frustrationCue(text) {
  const t = +tone(text).toFixed(2);
  for (const rx of STRONG_EMOTION) {
    const m = rx.exec(text);
    if (m) return { cue: m[0], excerpt: excerpt(text, m.index, m[0].length), tone: t };
  }
  if (t <= NEGATIVE_TONE) {
    const s = mostNegativeSentence(text), i = Math.max(0, text.indexOf(s));
    return { cue: 'negative tone', excerpt: excerpt(text, i, s.length), tone: t };
  }
  return null;
}
const empathyPhrase = (text) => { for (const rx of EMPATHY) { const m = rx.exec(text); if (m) return m[0]; } return null; };

/**
 * messages: [{ incoming, private, text, at }] in any order (incoming = from the
 * customer). Returns counts plus one finding per frustrated customer message
 * whose next public agent reply had no empathy phrase.
 */
function analyzeConversation(messages) {
  const msgs = messages.filter(m => !m.private && m.text).sort((a, b) => new Date(a.at) - new Date(b.at));
  let pending = null, frustrated = 0, acknowledged = 0;
  const findings = [];
  for (const m of msgs) {
    const text = stripQuoted(m.text);
    if (!text) continue;
    if (m.incoming) {
      const cue = frustrationCue(text);
      if (cue) { if (!pending) frustrated++; pending = pending || { ...cue, customer_at: m.at }; }
    } else if (pending) {
      const phrase = empathyPhrase(text);
      if (phrase) acknowledged++;
      else findings.push({ cue: pending.cue, tone: pending.tone, excerpt: pending.excerpt, customer_at: pending.customer_at, reply_at: m.at,
        reply_excerpt: text.replace(/\s+/g, ' ').slice(0, 160) });
      pending = null;
    }
  }
  return { frustrated, acknowledged, missing: findings.length, findings };
}

module.exports = { analyzeConversation, stripQuoted, frustrationCue, empathyPhrase };
