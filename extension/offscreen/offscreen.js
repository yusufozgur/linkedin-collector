// Hosts the SQLite worker, downloads post images, and answers
// { type: 'db', op, ... } messages forwarded by the background worker.

let worker = null; // started on first use
let nextId = 0;
const pending = new Map();
function db(op, args = {}, transfer = []) {
  if (!worker) {
    worker = new Worker(new URL('db-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      const p = pending.get(data.id);
      if (!p) return;
      pending.delete(data.id);
      data.ok ? p.resolve(data.result) : p.reject(new Error(data.error));
    };
  }
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, op, args }, transfer);
  });
}

async function sha256Hex(buf) {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function fetchImage(src) {
  const res = await fetch(src, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bytes = await res.arrayBuffer();
  const mime = res.headers.get('content-type') || 'application/octet-stream';
  let width = null, height = null;
  try {
    const bmp = await createImageBitmap(new Blob([bytes], { type: mime }));
    ({ width, height } = bmp);
    bmp.close();
  } catch { /* not decodable as an image; keep the bytes anyway */ }
  return { src, bytes, mime, width, height, sha256: await sha256Hex(bytes) };
}

async function savePost(post) {
  if (await db('has', { id: post.id })) {
    await db('touch', { post });
    return { saved: false, updated: true };
  }
  const images = [];
  const errors = [];
  for (const src of post.imageUrls ?? []) {
    try { images.push(await fetchImage(src)); }
    catch (e) { errors.push(`${src}: ${e.message}`); }
  }
  await db('save', { post, images }, images.map(i => i.bytes));
  return { saved: true, images: images.length, imageErrors: errors };
}

const exportUrls = [];
async function exportDb() {
  const bytes = await db('export');
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.sqlite3' }));
  exportUrls.push(url);
  setTimeout(() => URL.revokeObjectURL(exportUrls.shift()), 5 * 60_000);
  return { url, size: bytes.byteLength };
}

// Resolves to { ok: true, result } or { ok: false, error }; never rejects.
async function handleDb(msg) {
  const run = {
    savePost: () => savePost(msg.post),
    stats: () => db('stats'),
    recent: () => db('recent', { limit: msg.limit ?? 5 }),
    export: () => exportDb(),
    clear: () => db('clear'),
  }[msg.op];
  if (!run) return { ok: false, error: `unknown op ${msg.op}` };
  try { return { ok: true, result: await run() }; }
  catch (err) { return { ok: false, error: String(err?.message ?? err) }; }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;
  handleDb(msg).then(sendResponse);
  return true;
});
