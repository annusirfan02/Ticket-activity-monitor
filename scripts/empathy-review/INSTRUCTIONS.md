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

## What to decide per ticket

Each ticket has `messages` in time order, each `from: "customer"` or `"agent"`.
Email addresses and phone numbers are masked as `[email]` / `[phone]`.

```json
{
  "ticket_id": 12345,
  "summary": "1–3 neutral sentences: what the customer needed and how it ended.",
  "customer_upset": true,
  "empathy_missing": true,
  "reason": "One or two sentences explaining the verdict.",
  "evidence": [{ "customer": "short exact quote", "agent": "short exact quote" }]
}
```

**customer_upset** — true only if the customer expresses a negative feeling:
frustration, anger, disappointment, feeling ignored, being fed up, chasing
repeatedly with irritation, or worry about real harm to their business.
False for neutral status updates and polite requests, even when the problem is
still open or urgent — e.g. "I still can't see the contacts, can you check?",
"Error 404 when adding a card", "please escalate ASAP, thanks".

**empathy_missing** — only when `customer_upset` is true. Look at the **first
agent reply after each upset customer message** (that is the reply that should
have acknowledged it). Empathy is missing if, for any upset message, that first
reply does not acknowledge the customer's feelings or situation at all: no
apology, no "I understand how frustrating this is", no recognition of their
concern, the delay or the impact, no reassurance of ownership. These are not
acknowledgement: a greeting ("I hope you're doing great!"), only answering the
technical question, or a stock closing line ("Thank you for your patience and
understanding") that ignores what the customer just said. An apology that only
comes in a later reply doesn't undo a missed first reply — mention it in
`reason` instead. If `customer_upset` is false, set `empathy_missing` to false.

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

Be consistent: judge the conversation as a support team lead would, not by
single words.
