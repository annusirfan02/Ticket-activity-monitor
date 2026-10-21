// api/ticket-thread.js — read a ticket's conversation from Freshdesk (read-only).
// Shared by the live empathy check (api/index.js) and the Claude review scripts
// (scripts/empathy-review/), so both see the same messages.
const axios = require('axios');

const fdBase = () => `https://${process.env.FRESHDESK_DOMAIN}/api/v2`;
const fdHeaders = () => ({
  Authorization: 'Basic ' + Buffer.from(`${process.env.FRESHDESK_API_KEY}:X`).toString('base64'),
  'Content-Type': 'application/json',
});

/**
 * Returns { ticket, messages, remaining } where messages are
 * [{ incoming, private, text, at }] (incoming = from the customer) and
 * remaining is Freshdesk's x-ratelimit-remaining after the last call.
 */
async function fetchTicketMessages(id) {
  const r = await axios.get(`${fdBase()}/tickets/${id}?include=conversations`, { headers: fdHeaders(), timeout: 20000 });
  let remaining = parseInt(r.headers['x-ratelimit-remaining'] ?? '9999');
  let convs = r.data.conversations || [];
  if (convs.length >= 10) {   // include= returns only the first 10
    convs = [];
    for (let page = 1; page <= 5; page++) {
      const p = await axios.get(`${fdBase()}/tickets/${id}/conversations?per_page=100&page=${page}`, { headers: fdHeaders(), timeout: 20000 });
      remaining = parseInt(p.headers['x-ratelimit-remaining'] ?? '9999');
      convs = convs.concat(p.data || []);
      if (!p.data || p.data.length < 100) break;
    }
  }
  const t = r.data;
  const messages = [
    // the description is the customer's first message, except on outbound emails (source 10)
    { incoming: t.source !== 10, private: false, text: t.description_text, at: t.created_at },
    ...convs.map(c => ({ incoming: !!c.incoming, private: !!c.private, text: c.body_text, at: c.created_at })),
  ];
  return { ticket: t, messages, remaining };
}

module.exports = { fetchTicketMessages };
