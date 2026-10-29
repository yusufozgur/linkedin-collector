// Human-paced feed walker: centers one post at a time, expands it, extracts it,
// saves it, pauses, and repeats until stopped or a limit is reached.

(() => {
  const DEFAULTS = {
    minDelaySec: 3, maxDelaySec: 8,      // pause after each saved post
    breakEveryMin: 15, breakEveryMax: 25, // take a longer break every N posts
    breakMinSec: 20, breakMaxSec: 45,
    maxPosts: 200,
    skipAds: true,
  };
  // LinkedIn loads the next batch reliably only on a real wheel/touch scroll. At the end of the
  // loaded posts the collector tries scripted scrolling for a while, then pauses and notifies
  // you; one scroll of yours loads more and the run continues by itself.
  const SCRIPTED_TRIES_MS = 30_000;
  const PAUSED = 'paused: scroll to load more';

  const state = {
    running: false, saved: 0, updated: 0, skipped: 0, errors: 0,
    status: 'idle', reason: null, last: null, current: null, startedAt: null,
    resumable: false, // stopped mid-run: the next Start continues this run's counters
  };
  const seen = new Set();
  let settings = { ...DEFAULTS };
  let runToken = 0;
  let sinceBreak = 0, nextBreak = 0; // kept across Stop/Resume

  const rand = (a, b) => a + Math.random() * (b - a);
  const report = patch => {
    Object.assign(state, patch);
    chrome.runtime.sendMessage({ type: 'collector:progress', state: { ...state } }).catch(() => {});
  };

  // Sleeps in small steps so Stop takes effect quickly.
  async function sleep(ms, token) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (token !== runToken) throw new Error('stopped');
      await new Promise(r => setTimeout(r, Math.min(250, end - Date.now())));
    }
  }

  // LinkedIn's feed container ignores smooth scrollBy, so ease the scroll by hand.
  async function scrollBy(dist, token) {
    const sc = LIC.scroller();
    const from = sc.scrollTop;
    dist = Math.max(-from, Math.min(dist, sc.scrollHeight - sc.clientHeight - from));
    const t0 = performance.now(), dur = rand(500, 900);
    for (let t = 0; t < 1; t = (performance.now() - t0) / dur) {
      sc.scrollTop = from + dist * (1 - (1 - t) ** 3);
      await sleep(16, token);
    }
    sc.scrollTop = from + dist;
  }
  const atBottom = () => { const sc = LIC.scroller(); return sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 5; };

  async function save(post) {
    const res = await chrome.runtime.sendMessage({ type: 'db', op: 'savePost', post });
    if (!res?.ok) throw new Error(res?.error ?? 'no response from database');
    return res.result;
  }

  async function step(token) {
    const card = LIC.cards().find(c => !seen.has(LIC.cardId(c)));
    if (!card) return false;
    // Mark the card seen only once it is handled: if Stop lands while it is being
    // scrolled to or expanded, the next run has to pick it up again.
    const id = LIC.cardId(card);

    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(rand(700, 1500), token);
    if (await LIC.expand(card)) await sleep(rand(300, 700), token);

    let post;
    try { post = LIC.extract(card); }
    catch (e) { // a card the selectors can't read: count it and move on instead of stopping the run
      console.warn('[collector] extract failed', e);
      seen.add(id);
      report({ errors: state.errors + 1 });
      return true;
    }
    if (post.isAd && settings.skipAds) {
      seen.add(id);
      report({ skipped: state.skipped + 1 });
      await sleep(rand(800, 1800), token);
      return true;
    }
    seen.add(id);
    report({ current: { author: post.authorName, images: post.imageUrls.length } });
    try {
      const r = await save(post);
      report(r.saved
        ? { current: null, saved: state.saved + 1, last: { author: post.authorName, text: post.text?.slice(0, 120), images: r.images } }
        : { current: null, updated: state.updated + 1 });
    } catch (e) {
      console.warn('[collector] save failed', e);
      report({ current: null, errors: state.errors + 1 });
    }
    return true;
  }

  async function run(token) {
    let waitingSince = null;
    try {
      while (token === runToken) {
        if (LIC.blocked()) return stop('LinkedIn showed a login or security check page');
        if (!LIC.onFeed()) return stop('Left the feed');
        if (state.saved >= settings.maxPosts) return stop(`Reached the limit of ${settings.maxPosts} posts`, false);

        const before = state.saved;
        if (await step(token)) {
          if (waitingSince) { waitingSince = null; report({ status: 'running' }); }
          if (state.saved > before) {
            sinceBreak++;
            if (sinceBreak >= nextBreak) {
              const secs = rand(settings.breakMinSec, settings.breakMaxSec);
              report({ status: `break (${Math.round(secs)} s)` });
              await sleep(secs * 1000, token);
              report({ status: 'running' });
              sinceBreak = 0;
              nextBreak = Math.round(rand(settings.breakEveryMin, settings.breakEveryMax));
            } else {
              await sleep(rand(settings.minDelaySec, settings.maxDelaySec) * 1000, token);
            }
          }
          continue;
        }
        // Nothing new in the DOM: scroll down; at the bottom, glance back up and return.
        waitingSince ??= Date.now();
        if (Date.now() - waitingSince > SCRIPTED_TRIES_MS) {
          // Hand the scrolling to you; keep checking for new posts.
          if (state.status !== PAUSED) {
            report({ status: PAUSED });
            chrome.runtime.sendMessage({ type: 'notify', title: 'Feed Collector paused',
              message: `No more posts loaded after ${state.saved} saved. Scroll the feed once to continue.` }).catch(() => {});
          }
          await sleep(2000, token);
        } else if (!atBottom()) {
          await scrollBy(LIC.scroller().clientHeight * rand(0.7, 1.1), token);
          await sleep(rand(1500, 3000), token);
        } else {
          report({ status: 'waiting for more posts' });
          await scrollBy(-rand(1500, 2500), token);
          await sleep(rand(1000, 2000), token);
          await scrollBy(1e6, token); // back to the (possibly grown) bottom
          await sleep(rand(2000, 3500), token);
        }
      }
    } catch (e) {
      if (e.message !== 'stopped') { console.error('[collector]', e); stop(`Error: ${e.message}`); }
    }
  }

  // Start begins a new run (counters from 0); after a Stop it resumes the same run instead.
  // Either way it walks on from the first post on the page not handled yet.
  function start(newSettings) {
    if (state.running) return;
    settings = { ...DEFAULTS, ...newSettings };
    const token = ++runToken;
    if (state.resumable) {
      report({ running: true, status: 'running', reason: null });
    } else {
      sinceBreak = 0;
      nextBreak = Math.round(rand(settings.breakEveryMin, settings.breakEveryMax));
      report({ running: true, status: 'running', reason: null, saved: 0, updated: 0, skipped: 0, errors: 0,
               startedAt: new Date().toISOString() });
    }
    run(token);
  }

  function stop(reason = 'Stopped by you', resumable = true) {
    runToken++;
    report({ running: false, status: 'stopped', reason, current: null, resumable });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg?.type) {
      case 'collector:start': start(msg.settings); sendResponse({ ok: true, state }); break;
      case 'collector:stop': stop(); sendResponse({ ok: true, state }); break;
      case 'collector:reset': // database was cleared: forget this page's posts and counters
        if (state.running) stop();
        seen.clear();
        Object.assign(state, { status: 'idle', reason: 'All data cleared', saved: 0, updated: 0, skipped: 0,
                               errors: 0, last: null, current: null, startedAt: null, resumable: false });
        sendResponse({ ok: true, state });
        break;
      case 'collector:status': sendResponse({ ok: true, state, onFeed: LIC.onFeed(), cards: LIC.cards().length }); break;
      default: return false;
    }
    return false;
  });
})();
