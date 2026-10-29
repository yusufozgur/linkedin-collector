// Saves the extension's SQLite database to a local file (default: data/linkedin-feed.sqlite3).
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { connect, evaluate } from './cdp.mjs';
const out = process.argv[2] ?? fileURLToPath(new URL('../data/linkedin-feed.sqlite3', import.meta.url));
const extPath = fileURLToPath(new URL('../extension', import.meta.url));
const extId = [...createHash('sha256').update(extPath).digest('hex').slice(0, 32)]
  .map(ch => String.fromCharCode(97 + parseInt(ch, 16))).join('');
const t = await (await fetch(`http://localhost:9222/json/new?chrome-extension://${extId}/sidepanel/sidepanel.html`, { method: 'PUT' })).json();
await new Promise(r => setTimeout(r, 1500));
const c = await connect(t);
const b64 = await evaluate(c, `(async () => {
  const r = await chrome.runtime.sendMessage({ type: 'db', op: 'export' });
  if (!r.ok) throw new Error(r.error);
  const blob = await (await fetch(r.result.url)).blob();
  return await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result.split(',')[1]); fr.readAsDataURL(blob); });
})()`);
c.close();
await fetch(`http://localhost:9222/json/close/${t.id}`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.from(b64, 'base64'));
console.log(`wrote ${out} (${Buffer.from(b64, 'base64').length} bytes)`);
