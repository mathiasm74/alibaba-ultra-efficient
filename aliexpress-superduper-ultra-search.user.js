// ==UserScript==
// @name         AliExpress SuperDuper Ultra Search
// @namespace    mathias.aliexpress.ultra
// @version      2.7
// @description  Filter out irrelevant AliExpress search results, hide sponsored items and duplicates, fetch shipping costs, and sort results by total price (client-side). A modern rebuild of the classic "AliExpress Ultra Efficient".
// @homepageURL  https://github.com/mathiasm74/superduper-ultra-ali-search
// @supportURL   https://github.com/mathiasm74/superduper-ultra-ali-search/issues
// @downloadURL  https://raw.githubusercontent.com/mathiasm74/superduper-ultra-ali-search/main/aliexpress-superduper-ultra-search.user.js
// @updateURL    https://raw.githubusercontent.com/mathiasm74/superduper-ultra-ali-search/main/aliexpress-superduper-ultra-search.user.js
// @license      MIT
// @match        https://*.aliexpress.com/w/*
// @match        https://*.aliexpress.com/wholesale*
// @match        https://*.aliexpress.com/af/*
// @match        https://*.aliexpress.us/w/*
// @match        https://*.aliexpress.us/wholesale*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        unsafeWindow
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------- settings

  const DEFAULTS = {
    // Master switch: off restores the page as if the script weren't installed
    // (the panel stays, so it can be turned back on).
    enabled: true,
    // Minimum fraction of your search words that must appear in a product
    // title for it to be considered relevant.
    // 'all' = 1.0, 'most' = 0.75, 'half' = 0.5, 'any' = one word, 'off' = no filtering
    strictness: 'most',
    // 'hide' removes irrelevant results, 'dim' greys them out instead
    mode: 'hide',
    hideSponsored: true,
    sortByPrice: false,
    // Panel-managed terms; neither ever reaches the site's search engine.
    // includeTerms are all mandatory (like "quoted" query terms) — the only
    // way to filter image-search results, which have no text query.
    // excludeTerms are forbidden; typed as -terms in the query they'd be
    // sent as positive keywords, ATTRACTING the results you want gone.
    includeTerms: '',
    excludeTerms: '',
    // Price bounds in the displayed currency; localized input accepted
    // ("29,49", "1 481"). Empty = no bound.
    minPrice: '',
    maxPrice: '',
    // Fetch each kept item's page for its shipping cost and show/sort/filter
    // by the total price. Fetched fees are cached.
    includeShipping: true,
    // Treat "Free shipping over X" as free even when the item alone doesn't
    // reach X — for orders that will.
    assumeFreeLimit: false,
  };

  const settings = Object.assign({}, DEFAULTS, GM_getValue('settings', {}));
  // The 'debug' mode was removed; map settings saved by older versions
  if (settings.mode === 'debug') settings.mode = 'hide';
  const saveSettings = () => GM_setValue('settings', settings);

  const STRICTNESS_FRACTION = { all: 1.0, most: 0.75, half: 0.5, any: 0.0001, off: 0 };

  // Words in the query that carry no meaning for matching
  const STOPWORDS = new Set([
    'a', 'an', 'and', 'for', 'the', 'of', 'to', 'in', 'on', 'with', 'by',
    'or', 'per', 'new', 'high', 'quality', 'hot', 'sale',
  ]);

  // ------------------------------------------------------------------ query

  function getQueryText() {
    const params = new URLSearchParams(location.search);
    // Image search (/w/wholesale-.html?isNewImageSearch=y&imageId=…) has no
    // text query — don't scrape junk from the path or the search box. The
    // panel's "Require words" field is the way to filter these results.
    if (params.get('isNewImageSearch') === 'y' || params.has('imageId')) return '';
    for (const key of ['SearchText', 'searchText', 'keywords', 'keyword', 'q']) {
      const v = params.get(key);
      if (v) return v;
    }
    // Search pages encode the query in the path: /w/wholesale-usb-c-cable.html
    const m = location.pathname.match(/\/(?:w\/)?wholesale-?(.+?)\.html/) ||
      location.pathname.match(/\/af\/(.+?)\.html/);
    if (m) return decodeURIComponent(m[1]).replace(/[-_]/g, ' ');
    // Last resort: whatever is in the search box
    const box = document.querySelector('input[name="SearchText"], input[type="search"]');
    return box ? box.value : '';
  }

  function singularize(word) {
    if (word.length > 3 && word.endsWith('es')) return word.slice(0, -2);
    if (word.length > 3 && word.endsWith('s')) return word.slice(0, -1);
    return word;
  }

  function tokenize(text) {
    return text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 1 && !STOPWORDS.has(w))
      .map(singularize);
  }

  // "quoted" words or phrases in the query are mandatory, and -negated ones
  // (-word, -"a phrase") are forbidden: both override the strictness setting.
  function parseQuery(text) {
    const required = [];
    const excluded = [];
    let rest = text.replace(/(^|\s)-"([^"]*)"/g, (_, sp, phrase) => {
      const p = phrase.trim().toLowerCase();
      if (p) excluded.push(p);
      return sp;
    });
    rest = rest.replace(/"([^"]*)"/g, (_, phrase) => {
      const p = phrase.trim().toLowerCase();
      if (p) required.push(p);
      return ' ';
    });
    // (^|\s) keeps in-word hyphens intact: "usb-c" is one term, not -c negated
    rest = rest.replace(/(^|\s)-([a-z0-9][\w-]*)/gi, (_, sp, word) => {
      excluded.push(word.toLowerCase());
      return sp;
    });
    return { required, excluded, optional: tokenize(rest) };
  }

  // Parse a panel term field: bare words and "quoted phrases";
  // a leading - is tolerated but not required.
  function parseTermList(text) {
    const out = [];
    let rest = String(text || '').replace(/"([^"]*)"/g, (_, p) => {
      p = p.trim().toLowerCase();
      if (p) out.push(p);
      return ' ';
    });
    for (const w of rest.toLowerCase().split(/\s+/)) {
      const t = w.replace(/^-/, '');
      if (t) out.push(t);
    }
    return out;
  }

  function hasPhrase(title, phrase) {
    const haystack = title.toLowerCase().replace(/\s+/g, ' ');
    if (haystack.includes(phrase)) return true;
    // Also match ignoring punctuation/spacing ("usb c" vs "USB-C")
    const compact = haystack.replace(/[^a-z0-9]/g, '');
    return compact.includes(phrase.replace(/[^a-z0-9]/g, ''));
  }

  function isExcluded(title, excluded) {
    if (!excluded.length) return false;
    const tokens = title.toLowerCase().split(/[^a-z0-9]+/).map(singularize);
    return excluded.some((term) =>
      // Plain single words match whole tokens only, so -led doesn't kill
      // "sealed"; phrases and hyphenated terms use the substring matcher.
      /[^a-z0-9]/.test(term)
        ? hasPhrase(title, term)
        : tokens.includes(singularize(term))
    );
  }

  // ----------------------------------------------------------- card scraping

  // Not all result cards link to /item/…: "Bundle deals" cards link to an
  // /ssr/…BundleDealsDutyCovered page with the product in ?productIds=.
  // Both card types share the stable search-card-item anchor class.
  const PRODUCT_LINK = 'a[href*="/item/"], a.search-card-item';
  // Known card containers as of 2026 (fy26 markup); AliExpress renames its
  // hashed classes constantly, so cardFromLink() below is the future-proof
  // fallback.
  const KNOWN_CARDS = '.card-out-wrapper, .search-item-card-wrapper-gallery, .search-item-card-wrapper-list';

  // A card can link to its product more than once, so links must be grouped
  // by product before climbing, or each link looks like its own card.
  function productId(href) {
    const m =
      href.match(/\/item\/(\d+)/) ||
      // Bundle-deal links: ?productIds=<productId>:<skuId>
      href.match(/[?&]productIds=(\d+)/) ||
      // Last resort: the tracking param both link styles carry
      href.match(/x_object_id%3A(\d+)/);
    return m ? m[1] : href.split(/[?#]/)[0];
  }

  // Climb from a product link to the largest ancestor that contains only
  // links to this same product — that ancestor is the result card. Keep
  // climbing even past a known card class: the grid slot is an OUTER
  // per-card wrapper, and hiding an inner one leaves a hole in the grid.
  function cardFromLink(link, id) {
    let el = link.closest(KNOWN_CARDS) || link;
    while (el.parentElement && el.parentElement !== document.body) {
      const parentLinks = el.parentElement.querySelectorAll(PRODUCT_LINK);
      let foreign = false;
      for (const l of parentLinks) {
        if (productId(l.href) !== id) { foreign = true; break; }
      }
      if (foreign) break;
      el = el.parentElement;
    }
    return el;
  }

  // Overlays (preview/quick-view modals, floating widgets) contain product
  // links too, but must never be treated as result cards — hiding a
  // "duplicate" preview of a grid item would slam the modal shut. They sit
  // in position:fixed or role=dialog containers; the results grid never does.
  function inOverlay(el) {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      if (n.getAttribute('role') === 'dialog' || n.hasAttribute('aria-modal')) return true;
      if (/(modal|dialog|drawer|popup|preview|lightbox)/i.test(String(n.className))) return true;
      const cs = getComputedStyle(n);
      if (cs.position === 'fixed') return true;
      // Overlays float on an explicit stacking level; the results grid never
      // needs one. If a grid ancestor ever does carry a high z-index, the
      // failure mode is "nothing gets filtered", never "content hidden".
      if (cs.position !== 'static') {
        const z = parseInt(cs.zIndex, 10);
        if (!isNaN(z) && z >= 100) return true;
      }
    }
    return false;
  }

  // Remove our stamp and styling from something that turned out not to be a
  // result card, so it can never be left hidden.
  function unstamp(el) {
    if (!el.dataset.aueState) return;
    delete el.dataset.aueState;
    el.style.display = '';
    clearVisual(el);
    clearVisual(visualTarget(el));
  }

  // Locate the main results grid: the deepest element containing >=60% of
  // all product links. Cards inside it are accepted unconditionally — the
  // site restyles grid ancestors while scrolling (sticky/fixed toolbars,
  // z-index changes), and judging cards by ancestor styling made every card
  // flip to "overlay" at once, collapsing the counts to 0/0.
  function findGrid(links) {
    if (links.length < 3) return null;
    const counts = new Map();
    for (const link of links) {
      for (let n = link.parentElement; n && n !== document.documentElement; n = n.parentElement) {
        counts.set(n, (counts.get(n) || 0) + 1);
      }
    }
    const need = Math.max(3, Math.ceil(links.length * 0.6));
    let best = null;
    for (const [el, c] of counts) {
      // Qualifying elements are necessarily nested (two disjoint elements
      // can't both hold 60% of the links), so the deepest one is the one
      // contained by every other qualifier.
      if (c < need) continue;
      if (!best || best.contains(el)) best = el;
    }
    return best;
  }

  function findCards() {
    // Multiple links of a card climb to the same element, so the Set dedupes
    // them — but a product listed twice (sponsored + organic duplicate)
    // yields two cards, each classified and counted separately.
    const links = [...document.querySelectorAll(PRODUCT_LINK)].filter(
      (l) => !l.closest('header, nav')
    );
    const grid = findGrid(links);
    const cards = new Set();
    for (const link of links) {
      const card = cardFromLink(link, productId(link.href));
      if (!card || card === document.body) continue;
      // Cards inside the results grid are always accepted. Anything else
      // (preview modals portaled under <body>, cart sidebars, floating
      // widgets) must prove it's not an overlay: portals mount directly
      // under <body> behind a bare wrapper div whose modal classes live on
      // its DESCENDANTS — invisible to the ancestor walk in inOverlay().
      const inGrid = grid && card !== grid && grid.contains(card);
      if (
        !inGrid &&
        (card.parentElement === document.body ||
          card.querySelector('[role="dialog"], [aria-modal], [class*="modal" i]') ||
          inOverlay(card))
      ) {
        unstamp(card);
        continue;
      }
      cards.add(card);
    }
    // Drop cards that contain other cards (grid wrappers picked up by the climb)
    return [...cards].filter((c) => ![...cards].some((o) => o !== c && c.contains(o)));
  }

  function cardProductId(card) {
    const link = card.querySelector(PRODUCT_LINK);
    return link ? productId(link.href) : null;
  }

  function getTitle(card) {
    // AliExpress renders result titles as <h3>; keep generic fallbacks for
    // markup churn. Specific selectors first: [class*="title"] can match
    // wrapper divs whose text includes badge junk alongside the real title.
    const el =
      card.querySelector('h3, h2, h1') ||
      card.querySelector('[class*="title"]');
    if (el && el.textContent.trim()) return el.textContent.trim();
    const link = card.querySelector(PRODUCT_LINK);
    if (link) {
      if (link.title) return link.title;
      const img = link.querySelector('img[alt]');
      if (img && img.alt) return img.alt;
      return link.textContent.trim();
    }
    return '';
  }

  // Parse one localized amount: "1,234.56", "2 705,22", "1.234,56" …
  // The last . or , followed by 1-2 digits is the decimal separator; every
  // other separator is grouping.
  function parseAmount(str) {
    const s = str.replace(/[\s  ]/g, '');
    const sep = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
    const decimals = s.length - sep - 1;
    let normalized;
    if (sep >= 0 && decimals >= 1 && decimals <= 2) {
      normalized = s.slice(0, sep).replace(/[.,]/g, '') + '.' + s.slice(sep + 1);
    } else {
      normalized = s.replace(/[.,]/g, '');
    }
    const v = parseFloat(normalized);
    return isNaN(v) ? null : v;
  }

  const AMOUNT = '\\d(?:[\\d\\s\\u00a0\\u202f.,]*\\d)?';
  // kr/NOK/DKK are suffix-only: in concatenated card text a "kr" is followed
  // by whatever comes next (crossed-out price, rating, sold count), so
  // treating it as a prefix parsed "922,35kr5 | 2 sold" as price 52.
  const CURRENCY_BEFORE = new RegExp(`(?:US\\s?\\$|\\$|€|£|USD|EUR|GBP|SEK)\\s*(${AMOUNT})`, 'i');
  const CURRENCY_AFTER = new RegExp(`(${AMOUNT})\\s*(?:USD|EUR|GBP|SEK|NOK|DKK|kr|US\\s?\\$|\\$|€|£)`, 'i');
  const ARIA_PRICE = new RegExp(
    `^\\s*(?:US\\s?\\$|\\$|€|£|SEK)?\\s*(${AMOUNT})\\s*(?:kr|SEK|USD|EUR|GBP)?\\s*$`, 'i');

  // The price container carries the complete price as an aria-label
  // (e.g. aria-label="1 481,77kr") — the only clean per-card price marker
  // in AliExpress's hashed-class markup. Require a currency marker so
  // rating/count labels can't qualify.
  function priceElement(card) {
    for (const el of card.querySelectorAll('[aria-label]')) {
      const label = el.getAttribute('aria-label');
      if (!label || !/\d/.test(label) || !/kr|SEK|USD|EUR|GBP|\$|€|£/i.test(label)) continue;
      if (ARIA_PRICE.test(label)) return el;
    }
    return null;
  }

  function getPrice(card) {
    const priceEl = priceElement(card);
    if (priceEl) {
      const m = priceEl.getAttribute('aria-label').match(ARIA_PRICE);
      if (m) return parseAmount(m[1]);
    }
    // Fallback: currency-adjacent amount in the card text — minus our own
    // shipping badge, whose amounts would otherwise match. The sale price
    // precedes the crossed-out original, so the first match is the sort key.
    let text = card.textContent;
    const badge = card.querySelector('.aue-ship');
    if (badge) text = text.replace(badge.textContent, '');
    const m = text.match(CURRENCY_BEFORE) || text.match(CURRENCY_AFTER);
    return m ? parseAmount(m[1]) : null;
  }

  function isSponsored(card) {
    // Structural marker first: sponsored items carry p4p (pay-for-performance)
    // tracking parameters in their product links, present whether or not the
    // "Ad" badge text is rendered.
    for (const link of card.querySelectorAll(PRODUCT_LINK)) {
      if (/(?:[?&]|_)p4p/i.test(link.href)) return true;
    }
    for (const el of card.querySelectorAll('span, div, i, em')) {
      const t = el.textContent.trim();
      if (t.length <= 12 && /^(ad|ads|sponsored)$/i.test(t)) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- shipping

  // Search cards show the item price without shipping. For every card that
  // survives filtering, the shipping fee is looked up and the card then
  // shows and sorts by the total price. Sources, in order:
  //  1. the card's own "Free shipping" badge (no request needed);
  //  2. the pdp API (mtop.aliexpress.pdp.pc.query) — the same call the item
  //     page makes on load; the item page itself is a client-rendered shell
  //     with no shipping data in its HTML. The call runs with the user's
  //     session cookies, so fees match their ship-to country and currency.
  // Requests run one at a time, ~1s apart, and fees are cached in GM storage
  // so pagination and revisits don't re-hit the server.

  const SHIP_TTL = 24 * 3600 * 1000;         // known fees stay fresh a day
  const SHIP_UNKNOWN_TTL = 6 * 3600 * 1000;  // retry unparsable pages sooner
  const SHIP_CACHE_MAX = 1000;
  const SHIP_MAX_FAILURES = 3;

  // v2 key: 'shipCache' (v1) held null entries from a defunct HTML-scraping
  // fetcher, which would wrongly suppress lookups for their whole TTL.
  const shipCache = GM_getValue('shipCacheV2', {});
  GM_deleteValue('shipCache');
  let shipSaveTimer = null;

  // Sub-fields of the aep_usuc_f site cookie, whose value is itself a query
  // string ("site=glo&c_tp=SEK&region=SE&b_locale=en_US&…").
  function siteCookieField(key) {
    const m = document.cookie.match(/aep_usuc_f=([^;]*)/);
    if (!m) return '';
    const v = new URLSearchParams(m[1]).get(key) || '';
    try { return decodeURIComponent(v); } catch { return v; }
  }

  // The fee depends on the ship-to country and display currency — so they
  // are part of the cache key.
  const SHIP_CTX = `${siteCookieField('region')}:${siteCookieField('c_tp')}`;

  const shipKey = (id) => `${SHIP_CTX}|${id}`;

  // Cache entries: {f: fee number | null (page had no readable fee),
  //                 d: fee as the site formats it ("kr58,71"), t: timestamp}
  function shipEntry(id) {
    const e = shipCache[shipKey(id)];
    if (!e) return null;
    const ttl = typeof e.f === 'number' ? SHIP_TTL : SHIP_UNKNOWN_TTL;
    return Date.now() - e.t < ttl ? e : null;
  }

  function shippingFee(id) {
    const e = shipEntry(id);
    return e && typeof e.f === 'number' ? e.f : null;
  }

  function saveShipCache() {
    clearTimeout(shipSaveTimer);
    shipSaveTimer = setTimeout(() => {
      const keys = Object.keys(shipCache);
      if (keys.length > SHIP_CACHE_MAX) {
        keys.sort((a, b) => shipCache[a].t - shipCache[b].t);
        for (const k of keys.slice(0, keys.length - SHIP_CACHE_MAX)) delete shipCache[k];
      }
      GM_setValue('shipCacheV2', shipCache);
    }, 1500);
  }

  // Walk pdp API data for shipping options. The delivery component's
  // entries carry {shippingFee: 'free'|'charge', displayAmount,
  // formattedAmount}; other layouts nest a freightAmount money object.
  function collectShipOptions(node, out, depth) {
    if (!node || typeof node !== 'object' || depth > 40) return;
    if (Array.isArray(node)) {
      for (const v of node) collectShipOptions(v, out, depth + 1);
      return;
    }
    if (node.shippingFee === 'free') {
      out.push({ fee: 0, text: '' });
    } else if ('shippingFee' in node) {
      const amount = parseFloat(node.displayAmount);
      if (!isNaN(amount)) out.push({ fee: amount, text: String(node.formattedAmount || '') });
    }
    const fa = node.freightAmount;
    if (fa && typeof fa === 'object') {
      const amount = parseFloat(fa.value);
      if (!isNaN(amount)) {
        out.push({ fee: amount, text: String(fa.formatedAmount || fa.formattedAmount || '') });
      }
    }
    for (const k in node) collectShipOptions(node[k], out, depth + 1);
  }

  // Scan delivery/freight-named subtrees first: the response can also embed
  // other products (bundles, recommendations), and a whole-tree scan could
  // pick up one of their shipping markers instead of this item's.
  function extractFees(root) {
    const options = [];
    (function findComponents(node, depth) {
      if (!node || typeof node !== 'object' || depth > 12) return;
      for (const k in node) {
        if (/freight|delivery|shipping/i.test(k) && node[k] && typeof node[k] === 'object') {
          collectShipOptions(node[k], options, 0);
        } else {
          findComponents(node[k], depth + 1);
        }
      }
    })(root, 0);
    if (!options.length) collectShipOptions(root, options, 0);
    if (!options.length) return null;
    return options.reduce((a, b) => (a.fee <= b.fee ? a : b));
  }

  // ----- mtop API client (how every aliexpress page talks to its backend)

  const MTOP_APPKEY = '12574478';
  const MAIN_DOMAIN = location.hostname.split('.').slice(-2).join('.');

  // Compact MD5 (RFC 1321) of a JS string, UTF-8 encoded — mtop requests are
  // signed with it and WebCrypto offers no MD5.
  function md5(input) {
    const s = unescape(encodeURIComponent(input));
    const K = [...Array(64)].map((_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32));
    const R = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
      5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
      4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
      6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
    const n = s.length;
    const words = new Array((((n + 8) >> 6) + 1) * 16).fill(0);
    for (let i = 0; i < n; i++) words[i >> 2] |= s.charCodeAt(i) << ((i % 4) * 8);
    words[n >> 2] |= 0x80 << ((n % 4) * 8);
    words[words.length - 2] = n * 8;
    let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
    for (let i = 0; i < words.length; i += 16) {
      let [A, B, C, D] = [a, b, c, d];
      for (let j = 0; j < 64; j++) {
        let f, g;
        if (j < 16) { f = (B & C) | (~B & D); g = j; }
        else if (j < 32) { f = (D & B) | (~D & C); g = (5 * j + 1) % 16; }
        else if (j < 48) { f = B ^ C ^ D; g = (3 * j + 5) % 16; }
        else { f = C ^ (B | ~D); g = (7 * j) % 16; }
        const tmp = D;
        D = C; C = B;
        const x = (A + f + K[j] + words[i + g]) | 0;
        B = (B + ((x << R[j]) | (x >>> (32 - R[j])))) | 0;
        A = tmp;
      }
      a = (a + A) | 0; b = (b + B) | 0; c = (c + C) | 0; d = (d + D) | 0;
    }
    return [a, b, c, d].map((x) =>
      [0, 8, 16, 24].map((sh) => ((x >>> sh) & 255).toString(16).padStart(2, '0')).join('')
    ).join('');
  }

  // JSONP transport, in case the fetch is CORS-blocked: the response script
  // runs in the page context, so the callback must live on the page window.
  let jsonpCounter = 0;
  function mtopJsonp(base, params) {
    return new Promise((resolve, reject) => {
      const cb = `mtopjsonpaue${++jsonpCounter}`;
      const w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
      const p = new URLSearchParams(params);
      p.set('dataType', 'originaljsonp');
      p.set('callback', cb);
      const script = document.createElement('script');
      let timer = null;
      const finish = (fn) => (arg) => {
        clearTimeout(timer);
        try { delete w[cb]; } catch { /* some pages seal window */ }
        script.remove();
        fn(arg);
      };
      const ok = finish(resolve);
      const fail = finish(reject);
      w[cb] = ok;
      script.onerror = () => fail(new Error('mtop: JSONP failed to load'));
      timer = setTimeout(() => fail(new Error('mtop: JSONP timeout')), 10000);
      script.src = `${base}?${p}`;
      document.head.appendChild(script);
    });
  }

  async function mtopRequest(api, dataStr) {
    // The signing token lives in the _m_h5_tk cookie. When it's missing or
    // stale the gateway rejects the call but sets a fresh token cookie in
    // that same response, so a retry then succeeds.
    for (let attempt = 0; attempt < 3; attempt++) {
      const token = (document.cookie.match(/_m_h5_tk=([^_;]+)_/) || [])[1] || '';
      const t = Date.now();
      const params = new URLSearchParams({
        jsv: '2.5.1',
        appKey: MTOP_APPKEY,
        t: String(t),
        sign: md5(`${token}&${t}&${MTOP_APPKEY}&${dataStr}`),
        api,
        v: '1.0',
        type: 'originaljson',
        dataType: 'originaljson',
        timeout: '15000',
        data: dataStr,
      });
      const base = `https://acs.${MAIN_DOMAIN}/h5/${api.toLowerCase()}/1.0/`;
      let json;
      try {
        const res = await fetch(`${base}?${params}`, { credentials: 'include' });
        json = await res.json();
      } catch {
        json = await mtopJsonp(base, params);
      }
      const ret = String((json && json.ret && json.ret[0]) || 'empty response');
      if (ret.startsWith('SUCCESS')) return json.data;
      // Anything else (RGV587_ERROR = rate-limited/captcha, FAIL_SYS_…) is a
      // real failure the queue should back off from.
      if (!/TOKEN_EMPTY|TOKEN_EXPIRED|ILLEGAL_ACCESS/i.test(ret)) {
        throw new Error(`mtop: ${ret}`);
      }
    }
    throw new Error('mtop: could not obtain an API token');
  }

  // The exact payload the item page's own prefetch builds for this API
  // (field list lifted from its inline bootstrap script).
  function pdpQueryData(id) {
    let region = siteCookieField('region') || 'US';
    if (region === 'CN') region = 'US';
    const locale = siteCookieField('b_locale') || 'en_US';
    return JSON.stringify({
      productId: id,
      _lang: `${locale.split('_')[0] || 'en'}_${region}`,
      _currency: siteCookieField('c_tp') || 'USD',
      country: region,
      province: siteCookieField('province'),
      city: siteCookieField('city'),
      channel: '',
      pdp_ext_f: '',
      pdpNPI: '',
      sourceType: '',
      clientType: 'pc',
      ext: '{}',
    });
  }

  async function fetchShipping(id) {
    const data = await mtopRequest('mtop.aliexpress.pdp.pc.query', pdpQueryData(id));
    return extractFees(data); // null = response ok, but no readable fee
  }

  // The search cards themselves often settle it without any request: a plain
  // "Free shipping" badge, or "Free shipping over 100kr" when the item's own
  // price already clears the threshold. Returns 'free' for those, 'over' for
  // a threshold badge the item doesn't clear on its own (free only if the
  // order reaches the limit — see the assumeFreeLimit setting), else null.
  function cardShipsFree(card) {
    let status = null;
    for (const el of card.querySelectorAll('span, div')) {
      const t = el.textContent.trim();
      if (!t || t.length > 40 || !/^free shipping/i.test(t)) continue;
      if (/^free shipping$/i.test(t)) return 'free';
      const over = t.match(/^free shipping (?:on orders )?over (.+)$/i);
      if (over) {
        const threshold = parseAmount(over[1].replace(/^[^\d]+/, ''));
        const p = getPrice(card);
        if (threshold !== null && p !== null && p >= threshold) return 'free';
        status = 'over';
      }
    }
    return status;
  }

  // The assumption is a preference, not data — it must never enter the
  // persistent cache, so that toggling it off falls back to real fees.
  function assumedFreeShipping(card) {
    return settings.assumeFreeLimit && cardShipsFree(card) === 'over';
  }

  const shipQueue = [];
  const shipQueued = new Set();
  let shipPumping = false;
  let shipFailures = 0;
  let okIds = new Set();       // product ids kept by the last apply()
  let assumedOkIds = new Set(); // kept ids whose shipping is assumed free

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function queueShipping(id) {
    if (shipFailures >= SHIP_MAX_FAILURES) return;
    if (shipQueued.has(id) || shipEntry(id)) return;
    shipQueued.add(id);
    shipQueue.push(id);
    pumpShipQueue();
  }

  async function pumpShipQueue() {
    if (shipPumping) return;
    shipPumping = true;
    try {
      while (shipQueue.length) {
        const id = shipQueue.shift();
        shipQueued.delete(id);
        // The card may have been filtered out (or the setting turned off)
        // since it was queued — only ever fetch for items on display.
        if (!settings.includeShipping || !okIds.has(id) || shipEntry(id)) continue;
        try {
          const opt = await fetchShipping(id);
          shipCache[shipKey(id)] = opt
            ? { f: opt.fee, d: opt.text, t: Date.now() }
            : { f: null, t: Date.now() };
          shipFailures = 0;
          saveShipCache();
          console.debug('[AliExpress SuperDuper Ultra Search] shipping for', id,
            opt ? `= ${opt.text || opt.fee}` : ': no fee in the API response');
          updatePanel();   // tick the progress bar right away…
          scheduleApply(); // …and re-render badges / re-sort with the new fee
        } catch (e) {
          shipFailures++;
          console.warn('[AliExpress SuperDuper Ultra Search] shipping fetch failed:', e.message);
          if (shipFailures >= SHIP_MAX_FAILURES) {
            console.warn('[AliExpress SuperDuper Ultra Search]',
              'pausing shipping fetches — AliExpress may be rate-limiting');
            shipQueue.length = 0;
            shipQueued.clear();
            updatePanel();
          }
        }
        await sleep(800 + Math.random() * 700);
      }
    } finally {
      shipPumping = false;
    }
  }

  // Total price (item + shipping) when the fee is known; the bare item price
  // otherwise. Sorting and the price-range filter both use this.
  function getTotalPrice(card) {
    const p = getPrice(card);
    if (p === null || !settings.includeShipping) return p;
    if (assumedFreeShipping(card)) return p;
    const id = cardProductId(card);
    const fee = id ? shippingFee(id) : null;
    return fee === null ? p : p + fee;
  }

  // Format `value` the way `sample` (a site-scraped price string like
  // "kr58,71" or "$3.99") formats its amount: same currency token on the
  // same side, same decimal separator.
  function formatLike(sample, value) {
    const s = sample || '';
    const sym = s.replace(/[\d\s  .,]/g, '');
    let num = value.toFixed(2);
    if (/,\d{1,2}\D*$/.test(s)) num = num.replace('.', ',');
    if (!sym) return num;
    return /^\d/.test(s.trim()) ? num + sym : sym + num;
  }

  function updateShipBadge(card) {
    const id = cardProductId(card);
    const entry = settings.includeShipping && id ? shipEntry(id) : null;
    const fee = entry && typeof entry.f === 'number' ? entry.f : null;
    let text = '';
    if (settings.includeShipping && assumedFreeShipping(card)) {
      text = 'free shipping (assumed)';
    } else if (fee === 0) {
      text = 'free shipping';
    } else if (fee !== null) {
      const base = getPrice(card);
      const feeText = entry.d || fee.toFixed(2);
      text = base !== null
        ? `+${feeText} shipping = ${formatLike(entry.d, base + fee)}`
        : `+${feeText} shipping`;
    }
    let badge = card.querySelector('.aue-ship');
    if (!text) {
      if (badge) badge.remove();
      return;
    }
    if (badge && badge.textContent === text) return;
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'aue-ship';
      // Right under the price if it can be found, else at the card's end
      const anchor = priceElement(card);
      if (anchor) anchor.insertAdjacentElement('afterend', badge);
      else visualTarget(card).appendChild(badge);
    }
    badge.textContent = text;
  }

  // -------------------------------------------------------------- filtering

  function relevance(title, queryTokens) {
    if (!queryTokens.length) return 1;
    const haystack = title.toLowerCase();
    const compact = haystack.replace(/[^a-z0-9]/g, '');
    let hits = 0;
    for (const tok of queryTokens) {
      if (haystack.includes(tok) || compact.includes(tok)) hits++;
    }
    return hits / queryTokens.length;
  }

  // The site's re-renders can copy our data-aue-state onto a fresh node
  // while wiping the inline styles — trusting the stamp alone then leaves
  // "zombie" cards: counted as hidden but fully visible. Verify the styling.
  // Outer card wrappers can be display:contents — no box, so outline,
  // opacity, and filter on them are silently ignored (display:none still
  // works). Visual styling must land on the first descendant that renders.
  function visualTarget(card) {
    let t = card;
    for (let i = 0; i < 5 && t.firstElementChild && getComputedStyle(t).display === 'contents'; i++) {
      t = t.firstElementChild;
    }
    return t;
  }

  function styleMatches(card, state) {
    const t = visualTarget(card);
    if (state === 'ok') {
      return card.style.display !== 'none' && t.style.opacity === '';
    }
    if (settings.mode === 'hide') return card.style.display === 'none';
    return t.style.opacity === '0.45';
  }

  function setCardState(card, state) {
    // state: 'ok' | 'irrelevant' | 'sponsored' | 'duplicate' | 'price'
    // Skip when unchanged AND correctly styled: since the observer watches
    // style mutations, redundant style writes would re-trigger it in an
    // endless loop.
    if (card.dataset.aueState === state && styleMatches(card, state)) return;
    card.dataset.aueState = state;
    restyleCard(card, state);
  }

  // Undo all our styling so every card is re-classified from scratch —
  // needed when the hide/dim mode changes but card states stay the same.
  function resetCardStates() {
    for (const card of document.querySelectorAll('[data-aue-state]')) {
      delete card.dataset.aueState;
      card.style.display = '';
      clearVisual(card);
      clearVisual(visualTarget(card));
    }
  }

  function clearVisual(el) {
    el.style.opacity = '';
    el.style.filter = '';
  }

  function restyleCard(card, state) {
    const t = visualTarget(card);
    if (state === 'ok') {
      card.style.display = '';
      clearVisual(card);
      clearVisual(t);
    } else if (settings.mode === 'hide') {
      card.style.display = 'none';
    } else {
      card.style.display = '';
      t.style.opacity = '0.45';
      t.style.filter = 'grayscale(1)';
    }
  }

  // ---------------------------------------------------------------- sorting

  let mutatingOurselves = false;

  function sortCards(cards) {
    const byParent = new Map();
    for (const card of cards) {
      const p = card.parentElement;
      if (!p) continue;
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p).push(card);
    }
    mutatingOurselves = true;
    try {
      for (const [parent, group] of byParent) {
        if (group.length < 2) continue;
        const sorted = [...group].sort((a, b) => {
          const pa = getTotalPrice(a), pb = getTotalPrice(b);
          if (pa === null && pb === null) return 0;
          if (pa === null) return 1;
          if (pb === null) return -1;
          return pa - pb;
        });
        // Skip the DOM writes when already in order: re-appending even an
        // already-last node generates mutation records, so every debounced
        // apply() would churn the observer (and fight site re-renders).
        if (sorted.every((card, i) => card === group[i])) continue;
        for (const card of sorted) parent.appendChild(card);
        console.debug('[AliExpress SuperDuper Ultra Search] sorted prices (incl. shipping when known):',
          sorted.slice(0, 20).map((c) => getTotalPrice(c)));
      }
    } finally {
      mutatingOurselves = false;
    }
  }

  // ------------------------------------------------------------------ apply

  let lastCounts = { shown: 0, filtered: 0, sponsored: 0, duplicates: 0, priced: 0, total: 0 };

  function apply() {
    if (!settings.enabled) { updatePanel(); return; }
    const { required, excluded, optional } = parseQuery(getQueryText());
    required.push(...parseTermList(settings.includeTerms));
    excluded.push(...parseTermList(settings.excludeTerms));
    const minPrice = parseAmount(settings.minPrice);
    const maxPrice = parseAmount(settings.maxPrice);
    const threshold = STRICTNESS_FRACTION[settings.strictness] ?? 0.75;

    // The markup can contain card nodes the site never displays (templates,
    // offscreen sections). Classifying those skews the counts without any
    // visible effect, so only keep cards that render — or that we hid
    // ourselves (aueState set), which must stay managed so they can reappear.
    const allCards = findCards();
    const cards = allCards.filter(
      (c) => c.dataset.aueState || c.getClientRects().length > 0
    );
    if (cards.length < allCards.length) {
      console.debug('[AliExpress SuperDuper Ultra Search]',
        `ignoring ${allCards.length - cards.length} cards the site itself hides`);
    }

    // A card with an unparsable price is never price-filtered (fail open).
    // The bound applies to the total incl. shipping once the fee is known.
    const priceOutOfRange = (card) => {
      if (minPrice === null && maxPrice === null) return false;
      const p = getTotalPrice(card);
      if (p === null) return false;
      return (minPrice !== null && p < minPrice) || (maxPrice !== null && p > maxPrice);
    };

    const counts = { shown: 0, filtered: 0, sponsored: 0, duplicates: 0, priced: 0, total: cards.length };
    // Product ids already shown in this pass; a second listing of the same
    // product (typically a sponsored copy of an organic result) is a dupe.
    // Only listings we actually kept count, so hiding an ad never causes its
    // organic twin to be hidden as a "duplicate" too.
    const keptIds = new Set();
    const assumedIds = new Set();
    const adTitles = [];
    for (const card of cards) {
      const title = getTitle(card);
      const id = cardProductId(card);
      if (settings.hideSponsored && isSponsored(card)) {
        setCardState(card, 'sponsored');
        counts.sponsored++;
        adTitles.push(title || '(no title)');
      } else if (id && keptIds.has(id)) {
        setCardState(card, 'duplicate');
        counts.duplicates++;
      } else if (priceOutOfRange(card)) {
        setCardState(card, 'price');
        counts.priced++;
      // No title extracted means we can't judge relevance — fail open, never hide
      } else if (title && isExcluded(title, excluded)) {
        setCardState(card, 'irrelevant');
        counts.filtered++;
      } else if (title && required.some((p) => !hasPhrase(title, p))) {
        setCardState(card, 'irrelevant');
        counts.filtered++;
      } else if (title && threshold > 0 && relevance(title, optional) < threshold) {
        setCardState(card, 'irrelevant');
        counts.filtered++;
      } else {
        setCardState(card, 'ok');
        counts.shown++;
        if (id) {
          keptIds.add(id);
          if (settings.includeShipping && !shipEntry(id)) {
            // The card's own badge can settle it for free — no request needed
            if (cardShipsFree(card) === 'free') {
              shipCache[shipKey(id)] = { f: 0, d: '', t: Date.now() };
              saveShipCache();
            } else if (assumedFreeShipping(card)) {
              assumedIds.add(id);
            }
          }
        }
      }
      updateShipBadge(card);
    }

    // Fetch shipping only for the cards that survived filtering; anything
    // hidden above never triggers a request, and neither do cards whose
    // shipping is assumed free.
    okIds = keptIds;
    assumedOkIds = assumedIds;
    if (settings.includeShipping) {
      for (const id of keptIds) {
        if (!assumedIds.has(id)) queueShipping(id);
      }
    }

    if (settings.sortByPrice) sortCards(cards);

    const changed = JSON.stringify(counts) !== JSON.stringify(lastCounts);
    lastCounts = counts;
    if (changed) {
      console.info('[AliExpress SuperDuper Ultra Search]',
        `${counts.total} cards found — ${counts.shown} shown, ${counts.filtered} off-topic, ` +
        `${counts.sponsored} ads, ${counts.duplicates} dupes, ${counts.priced} priced out`);
      if (adTitles.length) {
        console.debug('[AliExpress SuperDuper Ultra Search] flagged as ads:', adTitles);
      }
    }
    updatePanel();
  }

  // ------------------------------------------------------------------ panel

  let panel;

  // Undo everything the script did to the page (the panel itself stays)
  function switchOff() {
    clearTimeout(debounceTimer);
    resetCardStates();
    for (const badge of document.querySelectorAll('.aue-ship')) badge.remove();
    okIds = new Set();
    assumedOkIds = new Set();
    shipQueue.length = 0;
    shipQueued.clear();
    panel.classList.add('aue-off');
    updatePanel();
  }

  function updatePanel() {
    if (!panel) return;
    const progress = panel.querySelector('#aue-progress');
    if (!settings.enabled) {
      panel.querySelector('#aue-counts').textContent = 'off';
      progress.hidden = true;
      return;
    }
    const c = lastCounts;
    let text =
      `${c.shown}/${c.total} shown · ${c.filtered} off-topic · ${c.sponsored} ads · ` +
      `${c.duplicates} dupes` + (c.priced ? ` · ${c.priced} priced out` : '');
    let pending = false;
    if (settings.includeShipping && okIds.size) {
      if (shipFailures >= SHIP_MAX_FAILURES) {
        text += ' · shipping paused';
      } else {
        // Assumed-free cards need no lookup, so they don't count as pending
        const wanted = [...okIds].filter((id) => !assumedOkIds.has(id));
        const known = wanted.filter((id) => shipEntry(id)).length;
        if (known < wanted.length) {
          pending = true;
          panel.querySelector('#aue-progress-bar').style.width =
            `${Math.round((known / wanted.length) * 100)}%`;
          panel.querySelector('#aue-progress-count').textContent = `${known}/${wanted.length}`;
        }
      }
    }
    progress.hidden = !pending;
    panel.querySelector('#aue-counts').textContent = text;
  }

  function buildPanel() {
    panel = document.createElement('div');
    panel.id = 'aue-panel';
    panel.innerHTML = `
      <style>
        #aue-panel {
          /* bottom-left: the site parks its own floating widgets bottom-right */
          position: fixed; bottom: 16px; left: 16px; z-index: 999999;
          background: rgba(20, 20, 25, 0.92); color: #eee;
          font: 12px/1.5 -apple-system, "Segoe UI", sans-serif;
          border-radius: 8px; padding: 10px 12px;
          box-shadow: 0 4px 16px rgba(0,0,0,.35);
          display: flex; flex-direction: column; gap: 6px; min-width: 220px;
        }
        #aue-panel.aue-collapsed > :not(#aue-header) { display: none; }
        #aue-panel #aue-header { cursor: pointer; font-weight: 600; display: flex; justify-content: space-between; }
        #aue-panel label { display: flex; justify-content: space-between; align-items: center; gap: 8px; cursor: pointer; }
        #aue-panel select { background: #333; color: #eee; border: 1px solid #555; border-radius: 4px; padding: 1px 4px; }
        #aue-panel input[type="text"] { background: #333; color: #eee; border: 1px solid #555; border-radius: 4px; padding: 1px 4px; width: 165px; }
        #aue-panel #aue-min, #aue-panel #aue-max { width: 46px; }
        #aue-panel #aue-counts { color: #9ad; }
        #aue-panel.aue-off > label:not(#aue-enabled-row) { opacity: 0.45; pointer-events: none; }
        #aue-panel #aue-progress { display: flex; align-items: center; gap: 6px; color: #9ad; }
        #aue-panel #aue-progress[hidden] { display: none; }
        #aue-panel #aue-progress-track { flex: 1; height: 4px; background: #444; border-radius: 2px; overflow: hidden; }
        #aue-panel #aue-progress-bar { height: 100%; width: 0; background: #9ad; border-radius: 2px; transition: width 0.3s; }
        .aue-ship { font: 12px/1.4 -apple-system, "Segoe UI", sans-serif; color: #0a7a4b; }
      </style>
      <div id="aue-header"><span>AliExpress SuperDuper Ultra Search</span><span id="aue-toggle">–</span></div>
      <label id="aue-enabled-row">Enabled <input type="checkbox" id="aue-enabled"></label>
      <div id="aue-counts"></div>
      <div id="aue-progress" hidden>
        <span>shipping</span>
        <div id="aue-progress-track"><div id="aue-progress-bar"></div></div>
        <span id="aue-progress-count"></span>
      </div>
      <label>Match strictness
        <select id="aue-strictness">
          <option value="all">all words</option>
          <option value="most">most words</option>
          <option value="half">half the words</option>
          <option value="any">any word</option>
          <option value="off">off</option>
        </select>
      </label>
      <label>Filtered results
        <select id="aue-mode">
          <option value="hide">hide</option>
          <option value="dim">dim</option>
        </select>
      </label>
      <label>Hide sponsored <input type="checkbox" id="aue-ads"></label>
      <label>Sort by price <input type="checkbox" id="aue-sort"></label>
      <label>Add shipping to prices <input type="checkbox" id="aue-shipping"></label>
      <label title='Treat "Free shipping over X" as free even when this item alone stays under X'>
        Assume free-shipping limit met <input type="checkbox" id="aue-freelimit"></label>
      <label>Require words
        <input type="text" id="aue-include" placeholder="word &quot;a phrase&quot;">
      </label>
      <label>Exclude words
        <input type="text" id="aue-exclude" placeholder="word &quot;a phrase&quot;">
      </label>
      <label>Price range
        <span><input type="text" id="aue-min" placeholder="min"> – <input type="text" id="aue-max" placeholder="max"></span>
      </label>
    `;
    document.body.appendChild(panel);

    const $ = (sel) => panel.querySelector(sel);
    $('#aue-enabled').checked = settings.enabled;
    panel.classList.toggle('aue-off', !settings.enabled);
    $('#aue-strictness').value = settings.strictness;
    $('#aue-mode').value = settings.mode;
    $('#aue-ads').checked = settings.hideSponsored;
    $('#aue-sort').checked = settings.sortByPrice;
    $('#aue-shipping').checked = settings.includeShipping;
    $('#aue-freelimit').checked = settings.assumeFreeLimit;
    $('#aue-include').value = settings.includeTerms;
    $('#aue-exclude').value = settings.excludeTerms;
    $('#aue-min').value = settings.minPrice;
    $('#aue-max').value = settings.maxPrice;

    $('#aue-enabled').addEventListener('change', (e) => {
      settings.enabled = e.target.checked; saveSettings();
      if (settings.enabled) {
        panel.classList.remove('aue-off');
        apply();
      } else if (settings.sortByPrice) {
        location.reload(); // restore the original result order
      } else {
        switchOff();
      }
    });
    $('#aue-header').addEventListener('click', () => {
      panel.classList.toggle('aue-collapsed');
      $('#aue-toggle').textContent = panel.classList.contains('aue-collapsed') ? '+' : '–';
    });
    $('#aue-strictness').addEventListener('change', (e) => {
      settings.strictness = e.target.value; saveSettings(); apply();
    });
    $('#aue-mode').addEventListener('change', (e) => {
      settings.mode = e.target.value; saveSettings();
      resetCardStates();
      apply();
    });
    $('#aue-ads').addEventListener('change', (e) => {
      settings.hideSponsored = e.target.checked; saveSettings(); apply();
    });
    $('#aue-sort').addEventListener('change', (e) => {
      settings.sortByPrice = e.target.checked; saveSettings();
      if (settings.sortByPrice) apply();
      else location.reload(); // restore the original order
    });
    $('#aue-shipping').addEventListener('change', (e) => {
      settings.includeShipping = e.target.checked; saveSettings(); apply();
    });
    $('#aue-freelimit').addEventListener('change', (e) => {
      settings.assumeFreeLimit = e.target.checked; saveSettings(); apply();
    });
    // 'change' fires on Enter or when the field loses focus
    $('#aue-include').addEventListener('change', (e) => {
      settings.includeTerms = e.target.value; saveSettings(); apply();
    });
    $('#aue-exclude').addEventListener('change', (e) => {
      settings.excludeTerms = e.target.value; saveSettings(); apply();
    });
    $('#aue-min').addEventListener('change', (e) => {
      settings.minPrice = e.target.value; saveSettings(); apply();
    });
    $('#aue-max').addEventListener('change', (e) => {
      settings.maxPrice = e.target.value; saveSettings(); apply();
    });
  }

  // ------------------------------------------------- observe lazy loading

  let debounceTimer = null;

  function scheduleApply() {
    if (mutatingOurselves || !settings.enabled) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(apply, 400);
  }

  function start() {
    buildPanel();
    apply();
    const observer = new MutationObserver((mutations) => {
      if (mutatingOurselves) return;
      // Ignore mutations inside our own panel
      if (mutations.every((m) => panel.contains(m.target))) return;
      scheduleApply();
    });
    // attributes too: cards can be shown/hidden by toggling style/class,
    // which childList alone never sees — that would freeze the counts at
    // whatever was rendered when apply() last ran. setCardState's
    // skip-when-unchanged guard keeps our own style writes from looping this.
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class'],
    });
    // Re-apply on SPA-style navigation (query changes without a page load)
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        scheduleApply();
      }
    }, 800);
  }

  // ---------------------------------------------------------------- bootstrap

  const log = (...args) => console.info('[AliExpress SuperDuper Ultra Search]', ...args);

  function isSearchPage() {
    if (/\/w\/|\/wholesale|\/af\//.test(location.pathname)) return true;
    if (/searchtext|keyword/i.test(location.search)) return true;
    return document.querySelector(PRODUCT_LINK) !== null;
  }

  let started = false;

  function tryStart() {
    if (started) return true;
    if (!isSearchPage()) return false;
    started = true;
    log(`active on ${location.href} — query: "${getQueryText()}"`);
    start();
    return true;
  }

  log('script loaded');
  // Never give up: on cold sessions (incognito) results only render after the
  // slider captcha / cookie banner, long after any fixed startup window. The
  // 1s poll is cheap (a path regex, plus one querySelector on non-search
  // pages) and also catches SPA navigation onto a search page.
  let attempts = 0;
  const bootTimer = setInterval(() => {
    if (tryStart()) {
      clearInterval(bootTimer);
    } else if (++attempts === 12) {
      log('no search results detected yet — captcha or slow load? Still watching.');
    }
  }, 1000);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryStart);
  } else {
    tryStart();
  }
})();
