// api/empathy.js — rule-based (no AI) empathy check for resolved/closed tickets.
//
// A ticket is flagged when a customer message shows frustration and the next
// public agent reply contains no acknowledgement phrase. Customer messages
// without frustration cues are not judged (routine replies don't need "sorry").
// Phrase lists are plain regexes so every flag can be explained by the exact
// words that triggered it. Edit the lists below to tune.

// Customer frustration cues. Kept specific: "not working" alone is the normal
// content of a support ticket, so only persistence ("still not working") counts.
const FRUSTRATION = [
  // emotion
  /\bfrustrat\w*/i, /\bannoy\w*/i, /\bupset\b/i, /\bangry\b/i, /\bfurious\b/i, /\bdisappoint\w*/i,
  /\bunhappy\b/i, /\bfed up\b/i, /\b(sick|tired) of\b/i, /\bunacceptable\b/i, /\bridiculous\b/i,
  /\b(terrible|horrible|awful|worst|useless|pathetic)\b/i, /\bwaste of (my )?(time|money)\b/i,
  // persistence / repeat contact
  /\bstill (not|isn'?t|doesn'?t|don'?t|hasn'?t|haven'?t|can'?t|cannot|unable|no|having|getting|seeing|waiting)\b/i,
  /\b(yet|once) again\b/i, /\bkeeps? (happening|failing|breaking|crashing)\b/i, /\bsame (issue|problem|error) again\b/i,
  /\b(how many|so many) times\b/i, /\bfor the (second|third|fourth|\d+(st|nd|rd|th)) time\b/i,
  // waiting / being ignored
  /\bno (response|reply|answer|update)s?\b/i, /\bnobody\b/i, /\bno one (has|is|responded|replied|helped)\b/i,
  /\b(still|been) waiting\b/i, /\bhow long\b/i, /\b(hours|days|weeks) (and|with|without) no\b/i, /\bignor(ed|ing)\b/i,
  // urgency / business impact / threats
  /\burgent(ly)?\b/i, /\basap\b/i, /\bemergency\b/i, /\bcancel (my|our|the) (account|subscription|plan|service)\b/i,
  /\brefund\b/i, /\blos(ing|t) (money|clients|customers|business|leads|sales)\b/i, /\bescalat\w*/i,
  /\bcomplain\w*/i, /\bchargeback\b/i, /\blawyer\b/i,
];
// Shouting: repeated "!!". (All-caps words are not used: company names in
// email signatures are often written in capitals.)
const shouting = (text) => /!{2,}/.test(text) ? '!!' : null;

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
function frustrationCue(text) {
  for (const rx of FRUSTRATION) {
    const m = rx.exec(text);
    if (m) return { cue: m[0], excerpt: excerpt(text, m.index, m[0].length) };
  }
  const s = shouting(text);
  return s ? { cue: s, excerpt: excerpt(text, Math.max(0, text.indexOf(s)), s.length) } : null;
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
      else findings.push({ cue: pending.cue, excerpt: pending.excerpt, customer_at: pending.customer_at, reply_at: m.at,
        reply_excerpt: text.replace(/\s+/g, ' ').slice(0, 160) });
      pending = null;
    }
  }
  return { frustrated, acknowledged, missing: findings.length, findings };
}

module.exports = { analyzeConversation, stripQuoted, frustrationCue, empathyPhrase };
