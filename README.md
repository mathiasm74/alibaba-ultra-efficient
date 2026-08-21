# SuperDuper Ultra search userscripts for AliExpress & Alibaba

Tampermonkey userscripts that clean up search results:

- **Alibaba SuperDuper Ultra Search** (`alibaba-superduper-ultra-search.user.js`) — for
  Alibaba.com (`/search/page`)
- **AliExpress SuperDuper Ultra Search** (`aliexpress-superduper-ultra-search.user.js`) —
  for AliExpress text and image search (`/w/wholesale-*`), a modern rebuild of the
  classic [AliExpress Ultra Efficient](https://greasyfork.org/en/scripts/27093-aliexpress-ultra-efficient)

Both share the same engine. Since these sites expose no sorting or filtering
through URL parameters anymore, everything works client-side on the rendered page.

![The control panel on an Alibaba search: dim mode fades 59 of 60 results,
leaving the one matching all query terms at full color](screenshot-alibaba.png)

![The control panel filtering an AliExpress image search: 3 of 60 results kept
by required words, the rest dimmed](screenshot-aliexpress.png)

## Features

- **Relevance filter** — hides (or dims) results whose titles don't contain enough
  of your search words. Strictness is adjustable: all / most / half / any / off.
- **Query operators** — `"quoted words"` are mandatory; `-word` and `-"a phrase"`
  are forbidden. Both override the strictness setting.
- **Sponsored filter** — detects ad cards via structural markers
  (Alibaba: `data-aplus-auto-normal-offer`; AliExpress: `p4p` link tracking
  params), with the visible "Ad" badge as fallback, and hides them.
- **Duplicate filter** — hides repeated listings of a product that's already shown.
- **Price sort** — optional client-side low-to-high sort. Parses localized prices
  ("US$1.20", "2 705,22 SEK"); ranges sort by their minimum. On AliExpress the
  sort uses the total including shipping once fees are fetched (see below);
  Alibaba's search cards don't carry shipping costs.
- **Shipping-inclusive prices** (AliExpress) — looks up each kept item's
  cheapest shipping option, shows "+kr58,71 shipping = kr980,06" (or
  "free shipping") on the card, and uses the total for the price sort and the
  price-range filter. Free shipping is read straight off the card's own badge;
  otherwise the fee comes from the site's product API (the same
  `mtop.aliexpress.pdp.pc.query` call the item page makes on load — the item
  page HTML itself is a client-rendered shell with no shipping data). Only
  items that survive filtering are requested — one at a time, ~1s apart,
  backing off if AliExpress starts blocking — and fees are cached for a day
  per ship-to country and currency, so pagination and repeat searches don't
  re-hit the server. Toggle: "Add shipping to prices".
- **Control panel** — bottom-left overlay with live counts
  ("37/60 shown · 12 off-topic · 10 ads · 1 dupes") and all toggles; settings persist.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) and enable
   **Allow User Scripts** for it (`chrome://extensions` → Tampermonkey → Details).
2. Click to install — Tampermonkey shows its install screen, and updates are
   picked up automatically from this repo:
   - [**Alibaba script**](https://raw.githubusercontent.com/mathiasm74/superduper-ultra-ali-search/main/alibaba-superduper-ultra-search.user.js)
   - [**AliExpress script**](https://raw.githubusercontent.com/mathiasm74/superduper-ultra-ali-search/main/aliexpress-superduper-ultra-search.user.js)
3. Search on the site — a control panel appears bottom-left on search result pages.

## Notes

- Alibaba renames its CSS classes regularly. The script keys on stable signals
  (product-detail links, `data-` attributes) with generic fallbacks, and fails
  open: a card whose title can't be read is never hidden.
- Diagnostics go to the browser console under `[Alibaba SuperDuper Ultra Search]`
  (flagged ad titles are logged at Verbose/debug level).
- Shipping lookups use your AliExpress session, so fees match your ship-to
  country and currency. If the site answers with a captcha or rate limit, the
  script stops fetching for that page (the counts row shows "shipping paused").
