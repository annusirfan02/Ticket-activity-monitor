// scripts/empathy-review/net.js — network setup for the review scripts.
//
// In the Claude Code cloud sandbox, outbound traffic goes through a proxy given
// in HTTPS_PROXY / HTTP_PROXY. axios (Freshdesk) follows those variables, but
// Node's built-in fetch (used by the Supabase client) ignores them, so route
// fetch through the proxy too. Without a proxy (local PC) this does nothing.
const { setGlobalDispatcher, EnvHttpProxyAgent } = require('undici');

if (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy) {
  setGlobalDispatcher(new EnvHttpProxyAgent());
}

// "fetch failed" alone says nothing; include the underlying cause and status.
function describeError(e) {
  const parts = [e.message];
  if (e.cause) parts.push(`cause: ${e.cause.code || ''} ${e.cause.message || e.cause}`.trim());
  if (e.response) parts.push(`HTTP ${e.response.status} from ${e.config?.url?.split('?')[0] || 'request'}`);
  return parts.join(' | ');
}

module.exports = { describeError };
