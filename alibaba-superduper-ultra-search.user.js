// ==UserScript==
// @name         Alibaba SuperDuper Ultra Search
// @namespace    mathias.alibaba.ultra
// @version      2.1
// @description  Filter out irrelevant Alibaba search results, optionally hide sponsored items, and sort results by price (client-side). Inspired by "AliExpress Ultra Efficient".
// @homepageURL  https://github.com/mathiasm74/superduper-ultra-ali-search
// @supportURL   https://github.com/mathiasm74/superduper-ultra-ali-search/issues
// @downloadURL  https://raw.githubusercontent.com/mathiasm74/superduper-ultra-ali-search/main/alibaba-superduper-ultra-search.user.js
// @updateURL    https://raw.githubusercontent.com/mathiasm74/superduper-ultra-ali-search/main/alibaba-superduper-ultra-search.user.js
// @license      MIT
// @match        https://www.alibaba.com/search/page*
// @match        https://*.alibaba.com/search/page*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------- settings

  const DEFAULTS = {
    // Minimum fraction of your search words that must appear in a product
    // title for it to be considered relevant.
    // 'all' = 1.0, 'most' = 0.75, 'half' = 0.5, 'any' = one word, 'off' = no filtering
    strictness: 'most',
    // 'hide' removes irrelevant results, 'dim' greys them out instead
    mode: 'hide',
    hideSponsored: true,
    sortByPrice: false,
    // Panel-managed terms; neither ever reaches the site's search engine.
    // includeTerms are all mandatory (like "quoted" query terms).
    // excludeTerms are forbidden; typed as -terms in the query they'd be
    // sent as positive keywords, ATTRACTING the results you want gone.
    includeTerms: '',
    excludeTerms: '',
    // Price bounds in the displayed currency; localized input accepted
    // ("29,49", "1 481"). Empty = no bound. Applies to a range's minimum.
    minPrice: '',
    maxPrice: '',
  };

  const settings = Object.assign({}, DEFAULTS, GM_getValue('settings', {}));
  // The 'debug' mode was removed; map settings saved by older versions
  if (settings.mode === 'debug') settings.mode = 'hide';
  const saveSettings = () => GM_setValue('settings', settings);

  const STRICTNESS_FRACTION = { all: 1.0, most: 0.75, half: 0.5, any: 0.0001, off: 0 };

  // Words in the query that carry no meaning for matching
  const STOPWORDS = new Set([
    'a', 'an', 'and', 'for', 'the', 'of', 'to', 'in', 'on', 'with', 'by',
    'or', 'per', 'new', 'high', 'quality', 'hot', 'sale', 'oem', 'odm',
  ]);

  // ------------------------------------------------------------------ query

  function getQueryText() {
    const params = new URLSearchParams(location.search);
    for (const key of ['SearchText', 'searchText', 'keyword', 'keywords', 'q']) {
      const v = params.get(key);
      if (v) return v;
    }
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

  const PRODUCT_LINK = 'a[href*="product-detail"], a[href*="/product/"]';
  // Known card containers as of 2025; Alibaba renames these regularly,
  // so cardFromLink() below is the future-proof fallback.
  const KNOWN_CARDS = '.fy23-search-card, .fy24-search-card, .J-search-card, .m-gallery-product-item-v2';

  // A card links to its product more than once (image + title), so links must
  // be grouped by product before climbing, or each link looks like its own card.
  function productId(href) {
    const m = href.match(/_(\d{6,})\.html/) || href.match(/product-detail\/([^?#]+)/);
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
    // Both links of a card (image + title) climb to the same element, so the
    // Set dedupes them — but a product listed twice (sponsored + organic
    // duplicate) yields two cards, each classified and counted separately.
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
    // Specific selectors first: the generic [class*="title"] can match wrapper
    // divs (e.g. searchx-title-area) whose text includes badge junk like
    // "certified" and "Money-back guarantee" alongside the real title.
    const el =
      card.querySelector('h2, .searchx-product-e-title, .search-card-e-title') ||
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
    const s = str.replace(/[\s  ]/g, '');
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
  // kr/NOK/DKK are suffix-only currencies — as a prefix they'd match the
  // digits that happen to follow a price in concatenated card text.
  const CURRENCY_BEFORE = new RegExp(`(?:US\\s?\\$|\\$|€|£|USD|EUR|GBP|SEK)\\s*(${AMOUNT})`, 'i');
  const CURRENCY_AFTER = new RegExp(`(${AMOUNT})\\s*(?:USD|EUR|GBP|SEK|NOK|DKK|kr|US\\s?\\$|\\$|€|£)`, 'i');

  function getPrice(card) {
    // Prices are shown in the visitor's currency ("US$1.20", "2 705,22 SEK");
    // ranges list the minimum first, so the first amount is the sort key.
    const el = card.querySelector('.product-price, .searchx-price-area, [class*="price"]');
    if (el) {
      // Inside a dedicated price element the first number IS the (min) price.
      // Currency-adjacency matching would grab the range maximum for suffix
      // currencies ("70,11-761,83 SEK"), so don't use it here.
      const m = el.textContent.match(new RegExp(AMOUNT));
      return m ? parseAmount(m[0]) : null;
    }
    // No price element found: only trust an amount right next to a currency
    // marker anywhere in the card's text.
    const m = card.textContent.match(CURRENCY_BEFORE) || card.textContent.match(CURRENCY_AFTER);
    return m ? parseAmount(m[1]) : null;
  }

  function isSponsored(card) {
    // Structural marker first: verified live to mirror the "Ad" badge exactly
    // (11/11, no mismatches), and it works even in page variants where the
    // badge text only renders on hover.
    if (
      card.hasAttribute('data-aplus-auto-normal-offer') ||
      card.querySelector('[data-aplus-auto-normal-offer]')
    ) return true;
    for (const el of card.querySelectorAll('span, div, i, em')) {
      const t = el.textContent.trim();
      if (t.length <= 12 && /^(ad|ads|sponsored)$/i.test(t)) return true;
    }
    return false;
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
          const pa = getPrice(a), pb = getPrice(b);
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
        console.debug('[Alibaba SuperDuper Ultra Search] sorted prices:',
          sorted.slice(0, 20).map((c) => getPrice(c)));
      }
    } finally {
      mutatingOurselves = false;
    }
  }

  // ------------------------------------------------------------------ apply

  let lastCounts = { shown: 0, filtered: 0, sponsored: 0, duplicates: 0, priced: 0, total: 0 };

  function apply() {
    const { required, excluded, optional } = parseQuery(getQueryText());
    required.push(...parseTermList(settings.includeTerms));
    excluded.push(...parseTermList(settings.excludeTerms));
    const minPrice = parseAmount(settings.minPrice);
    const maxPrice = parseAmount(settings.maxPrice);
    const threshold = STRICTNESS_FRACTION[settings.strictness] ?? 0.75;

    // Alibaba's markup contains card nodes it never displays (templates,
    // offscreen sections). Classifying those skews the counts without any
    // visible effect, so only keep cards that render — or that we hid
    // ourselves (aueState set), which must stay managed so they can reappear.
    const allCards = findCards();
    const cards = allCards.filter(
      (c) => c.dataset.aueState || c.getClientRects().length > 0
    );
    if (cards.length < allCards.length) {
      console.debug('[Alibaba SuperDuper Ultra Search]',
        `ignoring ${allCards.length - cards.length} cards the site itself hides`);
    }

    // A card with an unparsable price is never price-filtered (fail open)
    const priceOutOfRange = (card) => {
      if (minPrice === null && maxPrice === null) return false;
      const p = getPrice(card);
      if (p === null) return false;
      return (minPrice !== null && p < minPrice) || (maxPrice !== null && p > maxPrice);
    };

    const counts = { shown: 0, filtered: 0, sponsored: 0, duplicates: 0, priced: 0, total: cards.length };
    // Product ids already shown in this pass; a second listing of the same
    // product (typically a sponsored copy of an organic result) is a dupe.
    // Only listings we actually kept count, so hiding an ad never causes its
    // organic twin to be hidden as a "duplicate" too.
    const keptIds = new Set();
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
        if (id) keptIds.add(id);
      }
    }

    if (settings.sortByPrice) sortCards(cards);

    const changed = JSON.stringify(counts) !== JSON.stringify(lastCounts);
    lastCounts = counts;
    if (changed) {
      console.info('[Alibaba SuperDuper Ultra Search]',
        `${counts.total} cards found — ${counts.shown} shown, ${counts.filtered} off-topic, ` +
        `${counts.sponsored} ads, ${counts.duplicates} dupes, ${counts.priced} priced out`);
      if (adTitles.length) {
        console.debug('[Alibaba SuperDuper Ultra Search] flagged as ads:', adTitles);
      }
    }
    updatePanel();
  }

  // ------------------------------------------------------------------ panel

  let panel;

  function updatePanel() {
    if (!panel) return;
    const c = lastCounts;
    panel.querySelector('#aue-counts').textContent =
      `${c.shown}/${c.total} shown · ${c.filtered} off-topic · ${c.sponsored} ads · ` +
      `${c.duplicates} dupes` + (c.priced ? ` · ${c.priced} priced out` : '');
  }

  function buildPanel() {
    panel = document.createElement('div');
    panel.id = 'aue-panel';
    panel.innerHTML = `
      <style>
        #aue-panel {
          /* bottom-left: Alibaba parks its own floating widgets bottom-right */
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
      </style>
      <div id="aue-header"><span>Alibaba SuperDuper Ultra Search</span><span id="aue-toggle">–</span></div>
      <div id="aue-counts"></div>
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
    $('#aue-strictness').value = settings.strictness;
    $('#aue-mode').value = settings.mode;
    $('#aue-ads').checked = settings.hideSponsored;
    $('#aue-sort').checked = settings.sortByPrice;
    $('#aue-include').value = settings.includeTerms;
    $('#aue-exclude').value = settings.excludeTerms;
    $('#aue-min').value = settings.minPrice;
    $('#aue-max').value = settings.maxPrice;

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
    if (mutatingOurselves) return;
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
    // attributes too: Alibaba shows/hides existing cards by toggling
    // style/class, which childList alone never sees — that froze the counts
    // at whatever was rendered when apply() last ran. setCardState's
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

  const log = (...args) => console.info('[Alibaba SuperDuper Ultra Search]', ...args);

  function isSearchPage() {
    if (/\/search\/page/.test(location.pathname)) return true;
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
