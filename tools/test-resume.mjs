// Stop/Resume check: starts a run, stops it at random moments (often mid-scroll), resumes,
// and repeats. Then lists feed cards above the last handled one that are not in the database.
// Usage: node tools/test-resume.mjs [cycles=5]
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { connect, evaluate, targets } from './cdp.mjs';
const cycles = Number(process.argv[2] ?? 5);
const extPath = fileURLToPath(new URL('../extension', import.meta.url));
const extId = [...createHash('sha256').update(extPath).digest('hex').slice(0, 32)]
  .map(ch => String.fromCharCode(97 + parseInt(ch, 16))).join('');
const t = await (await fetch(`http://localhost:9222/json/new?chrome-extension://${extId}/sidepanel/sidepanel.html`, { method: 'PUT' })).json();
await new Promise(r => setTimeout(r, 1500));
const c = await connect(t);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tabMsg = msg => evaluate(c, `(async () => { const [tab] = await chrome.tabs.query({ url: 'https://www.linkedin.com/feed/*' });
  return tab ? chrome.tabs.sendMessage(tab.id, ${JSON.stringify(msg)}) : { ok: false, error: 'no feed tab' }; })()`);
const settings = { maxPosts: 50, minDelaySec: 1, maxDelaySec: 2, breakEveryMin: 99, breakEveryMax: 99, skipAds: true };
const s = st => `saved=${st.saved} had=${st.updated} ads=${st.skipped} err=${st.errors} resumable=${st.resumable}`;

for (let i = 0; i < cycles; i++) {
  const r = await tabMsg({ type: 'collector:start', settings });
  await sleep(1500 + Math.random() * 4000);
  const st = (await tabMsg({ type: 'collector:stop' })).state;
  await sleep(300);
  const label = await evaluate(c, `document.getElementById('start').textContent`);
  console.log(`cycle ${i + 1}: ${s(st)} | button: ${label} | current at stop: ${JSON.stringify(st.current)}`);
  await sleep(1500); // let an in-flight save land
}
const recent = (await evaluate(c, `chrome.runtime.sendMessage({ type: 'db', op: 'recent', limit: 500 })`)).result;
const ids = new Set(recent.map(r => r.id));
console.log('recent numbering:', recent.slice(0, 5).map(r => r.n).join(', '));
c.close();
await fetch(`http://localhost:9222/json/close/${t.id}`);

// Cards in page order, with the stored ones marked.
const feed = (await targets()).find(x => x.type === 'page' && x.url.startsWith('https://www.linkedin.com/feed'));
const p = await connect(feed);
const cards = await evaluate(p, `[...document.querySelectorAll('div[role="listitem"][componentkey^="update-card-focus"]')].map(el => ({
  id: el.getAttribute('componentkey').slice('update-card-focus'.length).replace(/FeedType_.*$/, ''),
  promoted: el.innerText.split('\\n').slice(0, 8).includes('Promoted'),
  head: el.innerText.replace(/\\s+/g, ' ').slice(0, 60) }))`);
p.close();
const lastIdx = cards.map(x => ids.has(x.id)).lastIndexOf(true);
const gaps = cards.slice(0, lastIdx).filter(x => !ids.has(x.id));
console.log(`cards on page: ${cards.length}, last stored at #${lastIdx + 1}, not stored above it: ${gaps.length}`);
for (const g of gaps) console.log('  -', g.promoted ? '[ad]' : '[MISSING]', g.head);
