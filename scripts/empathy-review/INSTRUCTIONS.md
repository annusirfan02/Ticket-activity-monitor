# Empathy review — instructions for the scheduled Claude routine

You review resolved/closed support tickets for missing empathy and store the
result. This is **read-only** towards customers: never reply to a customer,
never call any API that writes to Freshdesk, never change code, never commit or
push. The only data you write is through `save.js` below.

## Steps

1. `npm ci --omit=dev` (first run in a fresh checkout)
2. `node scripts/empathy-review/pending.js`
   - If it prints `pending: 0`, stop — nothing to review.
   - Otherwise read `.empathy-review/pending.json`.
3. For **every** ticket in `pending.json`, decide the fields below, then write
   all of them as one JSON array to `.empathy-review/results.json`.
4. `node scripts/empathy-review/save.js --model <the model you are running as>`
   - If it reports problems, fix those entries in `results.json` and run it again.
5. Finish with one line: how many tickets were reviewed and how many had
   empathy missing.

## How to review a ticket: read, summarise, then decide

Each ticket has `messages` in time order, each `from: "customer"` or `"agent"`.
Email addresses and phone numbers are masked as `[email]` / `[phone]`.

Do **not** decide from words or phrases. "Cancel", "frustrated", "two weeks",
"costing me money", "urgent" or "!!" mean nothing on their own: the same word
can be a complaint, a plan, a quote, or good news. Work in this order for every
ticket:

1. **Read the whole conversation**, start to finish, before judging anything.
2. **Summarise it for yourself** — what the customer needed, what happened, how
   it ended, and how the customer *felt* over time: their tone towards us and
   the agent (polite? appreciative? irritated? angry?), and what any worry or
   negative words were actually about.
3. **Only then decide**, from that understanding, the way an experienced support
   team lead would after reading the thread.

Things to get right when reading:
- **What is the feeling directed at?** Cancelling or leaving *another* service
  (an old platform, a website builder, a provider they are moving away from),
  ending their own trial as a planning step, or a deadline elsewhere is the
  customer's situation, not a complaint about us.
- **Tone over topic.** A customer who stays polite, thanks the agent and says
  they like the product while explaining stakes and deadlines is not upset,
  even if the issue drags on. Upset means they actually sound frustrated,
  angry, disappointed, ignored or fed up with us or the service.
- **Good news is not upset.** Excitement ("it worked!!"), relief and thanks
  are positive.
- **Judge the agent across the thread too.** If the agent already acknowledged
  the customer's situation and kept owning the issue, a later short status
  update to the same, unchanged situation is not a missed-empathy moment.

## What to record per ticket

```json
{
  "ticket_id": 12345,
  "summary": "1–3 neutral sentences: what the customer needed and how it ended.",
  "customer_upset": true,
  "empathy_missing": true,
  "reason": "One or two sentences explaining the verdict.",
  "evidence": [{ "customer": "short exact quote", "agent": "short exact quote" }],
  "frustration_score": 3,
  "handling_score": 4,
  "coaching": "One or two sentences: what the agent could have said or done to show more empathy."
}
```

`frustration_score`, `handling_score` and `coaching` are **only for tickets
where `empathy_missing` is true**; leave them out (or null) otherwise.

**frustration_score** (1–5) — how frustrated the customer actually was at the
missed moment, from your reading of the thread:
1 mild concern or worry · 2 impatient or uneasy · 3 clearly frustrated ·
4 very frustrated or exasperated · 5 angry, threatening to leave, escalate or
dispute.

**handling_score** (1–5) — how well the agent handled the customer overall
across the ticket, not only the missed reply:
5 handled well, one small miss · 4 mostly good, a noticeable miss ·
3 mixed: some acknowledgement, some clear misses · 2 mostly missed the
customer's feelings · 1 ignored or dismissed them throughout.

**coaching** — concrete and kind, aimed at the agent: what to acknowledge and
how (e.g. "Thank the customer for testing every step, apologise for the
two-day wait and acknowledge the repeated failures before giving the next
suggestion."). Same rules as `reason`: own words, no customer quotes, no names.

**customer_upset** — true only if the customer expresses a negative feeling:
frustration, anger, disappointment, feeling ignored, being fed up, or chasing
repeatedly with irritation.
False for neutral status updates and polite requests, even when the problem is
still open or urgent — e.g. "I still can't see the contacts, can you check?",
"Error 404 when adding a card", "please escalate ASAP, thanks".
Business impact or urgency **on its own** is also not upset: a customer calmly
explaining that the issue is costing them sales, blocking a launch, affecting
their clients or needed by a deadline is giving context, not expressing a
feeling. It only counts when the same message also shows frustration, anger,
disappointment or irritation (e.g. "this is the third time I'm asking and I'm
losing clients", "I'm really frustrated, this is costing me sales").

**empathy_missing** — only when `customer_upset` is true. Look at the **first
agent reply after each message where the customer was genuinely upset** (that
is the reply that should have acknowledged it). Empathy is missing if that
reply does not acknowledge the customer's feelings or situation at all: no
apology, no "I understand how frustrating this is", no recognition of their
concern, the delay or the impact, no reassurance of ownership. These are not
acknowledgement: a greeting ("I hope you're doing great!"), only answering the
technical question, or a stock closing line ("Thank you for your patience and
understanding") that ignores what the customer just said. An apology that only
comes in a later reply doesn't undo a missed first reply — mention it in
`reason` instead. But if the agent had already acknowledged the same situation
and the customer's next message only repeats or updates it, a reply that
continues to own the issue is fine. If `customer_upset` is false, set
`empathy_missing` to false.

When in doubt, don't flag: a flag should be something a team lead would agree
with after reading the thread.

If **no agent reply follows** an upset message in the ticket (the customer had
the last word, e.g. the issue was handled by phone or the ticket was closed),
that message can't be judged: it does not count as missed empathy. If that is
the only upset message, set `empathy_missing` to false and say in `reason` that
no agent reply followed.

Some tickets (e.g. from chat) contain almost no customer text (just a subject
like "Other -"). Judge only what is there; with no customer wording, the
customer is not upset.

**reason** — paraphrase in your own words; it is printed in PDF reports, so
never quote the customer's words and never include names of people. Agent
wording may be described ("a stock 'thank you for your patience' line").

**evidence** — up to 3 short exact quotes (customer message and the agent reply
that followed) that support the verdict. Empty array when nothing stands out.
These stay in the dashboard only.

**summary** — factual, no names of people, no masked values, no judgement words.

Be consistent: judge the conversation as a support team lead would, from your
understanding of the whole thread, never by single words.
