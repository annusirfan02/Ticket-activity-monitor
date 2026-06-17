// Local dev server with cron (not used by Vercel)
require('dotenv').config();
const cron = require('node-cron');
const app  = require('./index');
const PORT = process.env.PORT || 3000;
const pm   = parseInt(process.env.POLL_INTERVAL_MINUTES || 5);
app.listen(PORT, () => console.log(`🟢 http://localhost:${PORT}  (poll every ${pm}m)`));
cron.schedule(`*/${pm} * * * *`, async () => {
  try {
    const r = await fetch(`http://localhost:${PORT}/api/cron`, { method:'POST', headers:{'x-cron-secret':process.env.CRON_SECRET||''} });
    const d = await r.json();
    console.log(`[${new Date().toLocaleTimeString()}] cron:`, JSON.stringify(d));
  } catch (e) { console.error('cron error', e.message); }
});
