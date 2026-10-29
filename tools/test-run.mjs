// Starts a short collector run in the LinkedIn tab (via an extension tab), waits for it to finish,
// then prints the run state and what landed in the database.
// Usage: node tools/test-run.mjs [maxPosts=3]
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { connect, evaluate } from './cdp.mjs';
const maxPosts = Number(process.argv[2] ?? 3);
const extPath = fileURLToPath(new URL('../extension', import.meta.url));
const extId = [...createHash('sha256').update(extPath).digest('hex').slice(0, 32)]
  .map(ch => String.fromCharCode(97 + parseInt(ch, 16))).join('');
const t = await (await fetch(`http://localhost:9222/json/new?chrome-extension://${extId}/sidepanel/sidepanel.html`, { method: 'PUT' })).json();
await new Promise(r => setTimeout(r, 1500));
const c = await connect(t);
const tabMsg = msg => `(async () => { const [tab] = await chrome.tabs.query({ url: 'https://www.linkedin.com/feed/*' });
  return tab ? chrome.tabs.sendMessage(tab.id, ${JSON.stringify(msg)}) : { ok: false, error: 'no feed tab' }; })()`;
const settings = { maxPosts, minDelaySec: 2, maxDelaySec: 4, breakEveryMin: 99, breakEveryMax: 99, skipAds: true };
console.log('start:', JSON.stringify((await evaluate(c, tabMsg({ type: 'collector:start', settings })))?.ok));
let st;
for (let i = 0; i < 90; i++) {
  await new Promise(r => setTimeout(r, 2000));
  st = (await evaluate(c, tabMsg({ type: 'collector:status' })))?.state;
  if (st && !st.running) break;
}
console.log('state:', JSON.stringify({ status: st.status, reason: st.reason, saved: st.saved, updated: st.updated, skipped: st.skipped, errors: st.errors }));
console.log('stats:', JSON.stringify((await evaluate(c, `chrome.runtime.sendMessage({ type: 'db', op: 'stats' })`)).result));
const recent = (await evaluate(c, `chrome.runtime.sendMessage({ type: 'db', op: 'recent', limit: ${maxPosts} })`)).result;
for (const r of recent) console.log(' -', r.author_name, '|', r.posted_label, '|', r.reactions, 'react |', r.images, 'img |', (r.text ?? '').slice(0, 70).replace(/\n/g, ' '));
c.close();
await fetch(`http://localhost:9222/json/close/${t.id}`);
