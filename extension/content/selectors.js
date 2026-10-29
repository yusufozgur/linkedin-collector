// Everything that depends on LinkedIn's markup lives here, so when LinkedIn
// changes its DOM this is the only file to fix. Checked against the feed on 2026-10-29.

globalThis.LIC = (() => {
  const S = {
    card: 'div[role="listitem"][componentkey^="update-card-focus"]',
    cardKeyPrefix: 'update-card-focus',
    textBox: '[data-testid="expandable-text-box"]',
    moreButton: '[data-testid="expandable-text-button"]',
    actorLink: 'a[href*="/in/"], a[href*="/company/"], a[href*="/showcase/"], a[href*="/school/"]',
    reactionButton: 'button[aria-label^="Reaction button state"]',
    commentButton: 'button[aria-label="Comment"]',
    repostButton: 'button[aria-label="Repost"]',
  };

  const TIME_RE = /^(\d+)\s*(s|m|h|d|w|mo|yr|y)\b/;
  const CONTEXT_RE = /\b(likes|loves|celebrates|supports|finds this|commented on|reposted|follows|insightful|funny)\b|['’]s? job update/i;
  const NON_CONTENT_IMG_RE = /profile-displayphoto|profile-frame|company-logo|school-logo|ghost|emoji|static\.licdn\.com|data:image/;
  const UNIT_MS = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5, mo: 2592e6, yr: 31536e6, y: 31536e6 };

  const cleanUrl = href => {
    try { const u = new URL(href, location.origin); u.search = ''; u.hash = ''; return u.href; }
    catch { return href ?? null; }
  };
  // aria-label looks like "Jane Doe, Hiring  3rd+", "Jane Doe Verified Profile 3rd+"
  // or (job updates) "View Jane Doe’s profile".
  const BADGE_RE = /\s+(Verified( Profile)?|Premium|Hiring|Influencer|Creator|•|(1st|2nd|3rd)\+?|Out of network)(\s.*)?$/;
  const VIEW_PROFILE_RE = /^View (.+?)[’']s? profile$/;
  const cleanName = label => {
    const view = label.trim().match(VIEW_PROFILE_RE);
    return view ? view[1] : label.split(',')[0].replace(BADGE_RE, '').trim();
  };
  const isBadge = t => t.startsWith('•') || /^(Verified|Premium|Hiring|Follow|Book an appointment|Visit my website)\b/.test(t) || /^(1st|2nd|3rd)\+?$/.test(t);

  const before = (a, b) => !b || !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

  function parseCount(s) {
    if (!s) return null;
    const m = s.replace(/\s/g, '').match(/^([\d.,]+)([KkMm]?)/);
    if (!m) return null;
    let [, n, suffix] = m;
    if (suffix) return Math.round(parseFloat(n.replace(',', '.')) * (/k/i.test(suffix) ? 1e3 : 1e6));
    return parseInt(n.replace(/[.,]/g, ''), 10);
  }

  function countIn(card, selector) {
    const btn = card.querySelector(selector);
    if (!btn) return null;
    for (const span of btn.querySelectorAll('span')) {
      const n = parseCount(span.textContent.trim());
      if (n !== null) return n;
    }
    return 0;
  }

  function cardId(card) {
    return card.getAttribute('componentkey').slice(S.cardKeyPrefix.length).replace(/FeedType_.*$/, '');
  }

  // Author blocks are profile/company links that wrap a div[aria-label="Name, …"].
  // Only those above the reaction bar count (comment previews sit below it).
  function actors(card, barEl) {
    const seen = new Map();
    for (const a of card.querySelectorAll(S.actorLink)) {
      const label = a.querySelector('div[aria-label]')?.getAttribute('aria-label');
      if (!label || !before(a, barEl)) continue;
      const url = cleanUrl(a.getAttribute('href'));
      if (!seen.has(url)) seen.set(url, { url, name: cleanName(label), anchor: a });
    }
    return [...seen.values()];
  }

  // Headline and time are sibling spans near the author's name link.
  function actorDetails(actor) {
    let box = actor.anchor;
    for (let i = 0; i < 5 && box.parentElement; i++) {
      box = box.parentElement;
      const spans = [...box.querySelectorAll('span')].map(s => s.textContent.trim()).filter(Boolean);
      const time = spans.find(t => TIME_RE.test(t));
      if (!time) continue;
      const headline = spans.find(t => !t.includes(actor.name) && !isBadge(t) && !TIME_RE.test(t)
        && !/followers$/.test(t));
      return { postedLabel: time.match(TIME_RE)[0], headline: headline ?? null };
    }
    return { postedLabel: null, headline: null };
  }

  function estimateTime(label, now) {
    const m = label?.match(TIME_RE);
    if (!m) return null;
    return new Date(now - parseInt(m[1], 10) * UNIT_MS[m[2]]).toISOString();
  }

  function bestSrc(img) {
    const set = img.getAttribute('srcset');
    if (set) {
      const best = set.split(',').map(s => s.trim().split(/\s+/))
        .map(([u, w]) => ({ u, w: parseInt(w, 10) || 0 })).sort((a, b) => b.w - a.w)[0];
      if (best?.u) return best.u;
    }
    return img.currentSrc || img.src;
  }

  function contentImages(card, barEl, actorAnchors) {
    const urls = [];
    for (const img of card.querySelectorAll('img')) {
      if (!before(img, barEl) || actorAnchors.some(a => a.contains(img))) continue;
      const src = bestSrc(img);
      if (!src || NON_CONTENT_IMG_RE.test(src)) continue;
      if (Math.max(img.naturalWidth, img.width) < 150) continue;
      if (!urls.includes(src)) urls.push(src);
    }
    return urls;
  }

  async function expand(card) {
    const buttons = [...card.querySelectorAll(S.moreButton)].filter(b => /more/i.test(b.textContent));
    for (const b of buttons) b.click();
    return buttons.length;
  }

  function extract(card) {
    const now = Date.now();
    const lines = card.innerText.split('\n').map(s => s.trim()).filter(Boolean);
    const bar = card.querySelector(S.reactionButton) ?? card.querySelector(S.commentButton);
    const who = actors(card, bar);
    const author = who[0];
    const details = author ? actorDetails(author) : { postedLabel: null, headline: null };
    const boxes = [...card.querySelectorAll(S.textBox)].filter(b => before(b, bar));
    const second = who[1];
    const isRepost = !!second && boxes.length > 1;
    const context = lines[1] && CONTEXT_RE.test(lines[1]) ? lines[1] : null;
    return {
      id: cardId(card),
      url: null, // the feed card carries no permalink
      isAd: lines.slice(0, 6).includes('Promoted') || !author,
      authorName: author?.name ?? null,
      authorUrl: author?.url ?? null,
      authorHeadline: details.headline,
      context,
      postedLabel: details.postedLabel,
      postedAtEst: estimateTime(details.postedLabel, now),
      text: boxes[0]?.innerText.trim() || null,
      reactions: countIn(card, S.reactionButton),
      comments: countIn(card, S.commentButton),
      reposts: countIn(card, S.repostButton),
      hasVideo: !!card.querySelector('video'),
      isRepost: isRepost || /\breposted\b/i.test(context ?? ''),
      origAuthorName: isRepost ? second.name : null,
      origAuthorUrl: isRepost ? second.url : null,
      origText: isRepost ? boxes[1]?.innerText.trim() || null : null,
      imageUrls: contentImages(card, bar, who.map(w => w.anchor)),
      rawText: card.innerText.slice(0, 20000),
      collectedAt: new Date(now).toISOString(),
    };
  }

  const cards = () => [...document.querySelectorAll(S.card)];
  const onFeed = () => location.pathname.startsWith('/feed');
  // The feed scrolls inside an inner container (main#workspace in 2026), not the window.
  function scroller() {
    for (let el = cards().at(-1)?.parentElement; el; el = el.parentElement) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) return el;
    }
    return document.scrollingElement;
  }
  const blocked = () => /\/(checkpoint|authwall|uas\/login|login)/.test(location.pathname);

  return { S, cards, cardId, extract, expand, onFeed, blocked, parseCount, scroller };
})();
