// Opens the sidebar page in its own tab and checks stats + export through the real message path.
import { connect, evaluate } from './cdp.mjs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
// Unpacked extension IDs are derived from the extension's absolute path.
const extPath = fileURLToPath(new URL('../extension', import.meta.url));
const extId = [...createHash('sha256').update(extPath).digest('hex').slice(0, 32)]
  .map(ch => String.fromCharCode(97 + parseInt(ch, 16))).join('');
const t = await (await fetch(`http://localhost:9222/json/new?chrome-extension://${extId}/sidepanel/sidepanel.html`, { method: 'PUT' })).json();
await new Promise(r => setTimeout(r, 1500));
const c = await connect(t);
const send = op => `chrome.runtime.sendMessage({ type: 'db', op: '${op}' })`;
console.log('stats :', JSON.stringify(await evaluate(c, send('stats'))));
console.log('recent:', JSON.stringify(await evaluate(c, send('recent'))));
console.log('export:', JSON.stringify(await evaluate(c, `(async () => {
  const r = await ${send('export')}; if (!r.ok) return r;
  const buf = new Uint8Array(await (await fetch(r.result.url)).arrayBuffer());
  return { size: buf.length, header: new TextDecoder().decode(buf.slice(0, 15)) }; })()`)));
console.log('panel :', JSON.stringify(await evaluate(c, `document.getElementById('db-stats').textContent + ' | status=' + document.getElementById('status').textContent`)));
c.close();
await fetch(`http://localhost:9222/json/close/${t.id}`);
