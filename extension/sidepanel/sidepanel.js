const $ = id => document.getElementById(id);
const DEFAULTS = {
  minDelaySec: 3, maxDelaySec: 8, breakEveryMin: 15, breakEveryMax: 25,
  breakMinSec: 20, breakMaxSec: 45, maxPosts: 200, skipAds: true,
};
const form = $('settings');

async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const s = { ...DEFAULTS, ...settings };
  for (const [k, v] of Object.entries(s)) {
    const el = form.elements[k];
    if (!el) continue;
    el.type === 'checkbox' ? (el.checked = v) : (el.value = v);
  }
}
function readSettings() {
  const s = {};
  for (const k of Object.keys(DEFAULTS)) {
    const el = form.elements[k];
    s[k] = el.type === 'checkbox' ? el.checked : Number(el.value);
  }
  return s;
}
form.addEventListener('change', () => chrome.storage.local.set({ settings: readSettings() }));

async function feedTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.url?.startsWith('https://www.linkedin.com/') ? tab : null;
}
async function toTab(type, extra = {}) {
  const tab = await feedTab();
  if (!tab) return null;
  try { return await chrome.tabs.sendMessage(tab.id, { type, ...extra }); }
  catch { return null; } // content script not loaded (e.g. tab opened before the extension)
}
async function db(op, extra = {}) {
  const res = await chrome.runtime.sendMessage({ type: 'db', op, ...extra });
  if (!res?.ok) throw new Error(res?.error ?? 'database unavailable');
  return res.result;
}

function renderState(st, onFeed) {
  const pill = $('status');
  pill.className = 'pill';
  if (!st) {
    pill.textContent = 'open the LinkedIn feed';
    pill.classList.add('warn');
    $('start').disabled = true; $('stop').disabled = true;
    $('reason').textContent = 'Go to linkedin.com/feed in this tab (reload it if the extension was just installed).';
    return;
  }
  pill.textContent = st.running ? st.status : (onFeed === false ? 'not on feed' : st.status === 'stopped' ? 'stopped' : 'ready');
  if (st.running) pill.classList.add(st.status.startsWith('paused') ? 'warn' : 'running');
  $('start').disabled = st.running || onFeed === false;
  $('start').textContent = st.resumable && !st.running ? 'Resume' : 'Start';
  $('stop').disabled = !st.running;
  $('clear').disabled = st.running;
  $('reason').textContent = st.reason
    ?? (st.status === 'waiting for more posts'
      ? 'At the end of the loaded posts. Trying to get LinkedIn to load more…'
    : st.status === 'paused: scroll to load more'
      ? 'LinkedIn stopped loading posts. Scroll the feed once with your mouse wheel; the run continues by itself.'
    : st.current ? `Saving: ${st.current.author ?? '?'}${st.current.images ? ` (downloading ${st.current.images} image${st.current.images > 1 ? 's' : ''})` : ''}…`
    : st.last ? `Last: ${st.last.author ?? '?'} — ${st.last.text ?? '(no text)'}` : '');
  $('c-saved').textContent = st.saved;
  $('c-updated').textContent = st.updated;
  $('c-skipped').textContent = st.skipped;
  $('c-errors').textContent = st.errors;
}

// Refreshes can overlap while a run is going; only the newest one may render.
let refreshSeq = 0;
async function refreshDb() {
  const seq = ++refreshSeq;
  try {
    const [s, rows] = await Promise.all([db('stats'), db('recent', { limit: 5 })]);
    if (seq !== refreshSeq) return;
    $('db-stats').textContent = `${s.posts} posts · ${s.images} images · ${(s.bytes / 1048576).toFixed(1)} MB`;
    $('recent').replaceChildren(...rows.map(r => {
      const li = Object.assign(document.createElement('li'), { value: r.n }); // the post's number in the database
      const who = Object.assign(document.createElement('div'), { className: 'who', textContent: r.author_name ?? 'Unknown' });
      const txt = Object.assign(document.createElement('div'), { textContent: r.text ?? '(no text)' });
      const meta = Object.assign(document.createElement('div'), {
        className: 'meta',
        textContent: `${r.posted_label ?? '?'} · ${r.reactions ?? 0} reactions · ${r.comments ?? 0} comments · ${r.images} img`,
      });
      li.append(who, txt, meta);
      return li;
    }));
  } catch (e) {
    if (seq === refreshSeq) $('db-stats').textContent = `Database error: ${e.message}`;
  }
}

async function refresh() {
  const res = await toTab('collector:status');
  renderState(res?.state, res?.onFeed);
}

$('start').addEventListener('click', async () => {
  const settings = readSettings();
  await chrome.storage.local.set({ settings });
  const res = await toTab('collector:start', { settings });
  renderState(res?.state, true);
});
$('stop').addEventListener('click', async () => {
  const res = await toTab('collector:stop');
  renderState(res?.state, true);
});
$('export').addEventListener('click', async () => {
  const btn = $('export');
  btn.disabled = true;
  try {
    const { url } = await db('export');
    const blob = await (await fetch(url)).blob();
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
      download: `linkedin-feed-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.sqlite3`,
    });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  } catch (e) {
    $('db-stats').textContent = `Export failed: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
});

// Reload the database view only when a save actually changed something.
let lastWrites = -1;
// Clearing needs two clicks within 4 s; the first one only arms the button.
let clearArmed = null;
$('clear').addEventListener('click', async () => {
  const btn = $('clear');
  if (!clearArmed) {
    btn.classList.add('armed');
    btn.textContent = 'Click again to delete everything';
    clearArmed = setTimeout(disarmClear, 4000);
    return;
  }
  disarmClear();
  btn.disabled = true;
  try {
    await db('clear');
    const res = await toTab('collector:reset');
    lastWrites = -1;
    renderState(res?.state, res ? true : undefined);
    await refreshDb();
  } catch (e) {
    $('db-stats').textContent = `Clear failed: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
});
function disarmClear() {
  clearTimeout(clearArmed);
  clearArmed = null;
  $('clear').classList.remove('armed');
  $('clear').textContent = 'Clear all data';
}

chrome.runtime.onMessage.addListener(msg => {
  if (msg?.type !== 'collector:progress') return;
  renderState(msg.state, true);
  const writes = msg.state.saved + msg.state.updated;
  if (writes !== lastWrites) { lastWrites = writes; refreshDb(); }
});
chrome.tabs.onActivated.addListener(refresh);
chrome.tabs.onUpdated.addListener((_id, info) => { if (info.url || info.status === 'complete') refresh(); });

loadSettings();
refresh();
refreshDb();
