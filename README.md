# SuperDuper Ultra search userscripts for AliExpress & Alibaba

Tampermonkey userscripts that clean up search results:

- **Alibaba Ultra Efficient** (`alibaba-ultra-efficient.user.js`) — for
  Alibaba.com (`/search/page`)
- **AliExpress SuperDuper Ultra Search** (`aliexpress-superduper-ultra-search.user.js`) —
  for AliExpress text and image search (`/w/wholesale-*`), a modern rebuild of the
  classic [AliExpress Ultra Efficient](https://greasyfork.org/en/scripts/27093-aliexpress-ultra-efficient)

Both share the same engine. Since these sites expose no sorting or filtering
through URL parameters anymore, everything works client-side on the rendered page.

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
  ("US$1.20", "2 705,22 SEK"); ranges sort by their minimum. Shipping is not
  included — Alibaba's search cards don't carry shipping costs.
- **Control panel** — bottom-left overlay with live counts
  ("37/60 shown · 12 off-topic · 10 ads · 1 dupes") and all toggles; settings persist.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) and enable
   **Allow User Scripts** for it (`chrome://extensions` → Tampermonkey → Details).
2. Click to install — Tampermonkey shows its install screen, and updates are
   picked up automatically from this repo:
   - [**Alibaba script**](https://raw.githubusercontent.com/mathiasm74/superduper-ultra-ali-search/main/alibaba-ultra-efficient.user.js)
   - [**AliExpress script**](https://raw.githubusercontent.com/mathiasm74/superduper-ultra-ali-search/main/aliexpress-superduper-ultra-search.user.js)
3. Search on the site — a control panel appears bottom-left on search result pages.

## Notes

- Alibaba renames its CSS classes regularly. The script keys on stable signals
  (product-detail links, `data-` attributes) with generic fallbacks, and fails
  open: a card whose title can't be read is never hidden.
- Diagnostics go to the browser console under `[Alibaba Ultra Efficient]`
  (flagged ad titles are logged at Verbose/debug level).
