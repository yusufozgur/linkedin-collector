// Pause check: runs until the collector pauses at the end of the loaded posts, checks the
// notification, sends one real wheel scroll to the feed (as you would), and checks it continues.
// Usage: node tools/test-pause.mjs
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { connect, evaluate, targets } from './cdp.mjs';
const extPath = fileURLToPath(new URL('../extension', import.meta.url));
const extId = [...createHash('sha256').update(extPath).digest('hex').slice(0, 32)]
  .map(ch => String.fromCharCode(97 + parseInt(ch, 16))).join('');
const t = await (await fetch(`http://localhost:9222/json/new?chrome-extension://${extId}/sidepanel/sidepanel.html`, { method: 'PUT' })).json();
await new Promise(r => setTimeout(r, 1500));
const c = await connect(t);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tabMsg = msg => evaluate(c, `(async () => { const [tab] = await chrome.tabs.query({ url: 'https://www.linkedin.com/feed/*' });
  return tab ? chrome.tabs.sendMessage(tab.id, ${JSON.stringify(msg)}) : { ok: false, error: 'no feed tab' }; })()`);
const fmt = st => `${st.status} | saved=${st.saved} had=${st.updated} ads=${st.skipped} err=${st.errors}`;
const settings = { maxPosts: 200, minDelaySec: 1, maxDelaySec: 2, breakEveryMin: 99, breakEveryMax: 99, skipAds: true };
const t0 = Date.now();
const secs = () => Math.round((Date.now() - t0) / 1000);
await tabMsg({ type: 'collector:start', settings });
let st;
for (let i = 0; i < 120; i++) {
  await sleep(2000);
  st = (await tabMsg({ type: 'collector:status' })).state;
  if (!st.running || st.status.startsWith('paused')) break;
}
console.log(`${secs()}s`, fmt(st));
console.log('notifications:', JSON.stringify(await evaluate(c, `chrome.notifications.getAll()`)));
console.log('sidebar says:', await evaluate(c, `document.getElementById('reason').textContent`));

const feed = await connect((await targets()).find(x => x.type === 'page' && x.url.startsWith('https://www.linkedin.com/feed')));
await feed.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 600, y: 600, deltaX: 0, deltaY: 120 });
console.log(`${secs()}s one wheel scroll sent`);
for (let i = 0; i < 10; i++) {
  await sleep(3000);
  st = (await tabMsg({ type: 'collector:status' })).state;
  console.log(`${secs()}s`, fmt(st));
}
await tabMsg({ type: 'collector:stop' });
feed.close(); c.close();
await fetch(`http://localhost:9222/json/close/${t.id}`);
