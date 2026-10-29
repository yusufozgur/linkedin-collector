// Opens the side panel, routes { type: 'db' } requests from the content script and sidebar
// to the offscreen document (which owns the SQLite worker; service workers can't start
// Workers), and shows desktop notifications.

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

let creating = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Run SQLite (WASM + OPFS) in a worker',
    })
    .finally(() => { creating = null; });
  await creating;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target === 'offscreen') return false;
  if (msg?.type !== 'db') return false;
  ensureOffscreen()
    .then(() => chrome.runtime.sendMessage({ ...msg, target: 'offscreen' }))
    .then(sendResponse, err => sendResponse({ ok: false, error: String(err?.message ?? err) }));
  return true;
});

// Desktop notification from the collector (e.g. paused); clicking it shows the feed tab.
const notifiedTabs = new Map();
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== 'notify') return false;
  chrome.notifications.create({
    type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon-128.png'), title: msg.title, message: msg.message,
  }).then(id => notifiedTabs.set(id, sender.tab));
  return false;
});
chrome.notifications.onClicked.addListener(async id => {
  // The map is empty if Chrome's service worker went idle meanwhile; fall back to any feed tab.
  const tab = notifiedTabs.get(id) ?? (await chrome.tabs.query({ url: 'https://www.linkedin.com/feed/*' }))[0];
  notifiedTabs.delete(id);
  chrome.notifications.clear(id);
  if (!tab) return;
  chrome.tabs.update(tab.id, { active: true });
  chrome.windows.update(tab.windowId, { focused: true });
});
