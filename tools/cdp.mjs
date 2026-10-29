// Tiny CDP helper for the dev Chromium (port 9222).
// Usage: node tools/cdp.mjs eval '<js expression>'   (runs in the first non-extension page)
//        node tools/cdp.mjs goto <url>
//        node tools/cdp.mjs targets
const base = process.env.CDP || 'http://localhost:9222';
export async function targets() { return (await fetch(base + '/json/list')).json(); }
export async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0; const pending = {}; const listeners = [];
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending[m.id]) pending[m.id](m); else listeners.forEach(l => l(m)); };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const send = (method, params = {}) => new Promise(r => { pending[++id] = r; ws.send(JSON.stringify({ id, method, params })); });
  return { ws, send, on: l => listeners.push(l), close: () => ws.close() };
}
export async function page() {
  const t = (await targets()).find(t => t.type === 'page' && !t.url.startsWith('chrome-extension://'));
  if (!t) throw new Error('no page target');
  return connect(t);
}
export async function evaluate(c, expression) {
  const r = await c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval error');
  return r.result?.result?.value;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'targets') { for (const t of await targets()) console.log(t.type.padEnd(16), t.url); process.exit(0); }
  const c = await page();
  if (cmd === 'goto') { await c.send('Page.navigate', { url: arg }); await new Promise(r => setTimeout(r, 4000)); console.log(await evaluate(c, 'location.href')); }
  if (cmd === 'eval') { const v = await evaluate(c, arg); console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2)); }
  c.close();
}
