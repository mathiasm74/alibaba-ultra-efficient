# Alibaba Ultra Efficient

A Tampermonkey userscript that cleans up Alibaba.com search results. Inspired by
[AliExpress Ultra Efficient](https://greasyfork.org/en/scripts/27093-aliexpress-ultra-efficient),
but since Alibaba exposes no sorting or filtering through URL parameters, everything
works client-side on the rendered page.

## Features

- **Relevance filter** — hides (or dims) results whose titles don't contain enough
  of your search words. Strictness is adjustable: all / most / half / any / off.
- **Query operators** — `"quoted words"` are mandatory; `-word` and `-"a phrase"`
  are forbidden. Both override the strictness setting.
- **Sponsored filter** — detects ad cards via Alibaba's `data-aplus-auto-normal-offer`
  marker (with the visible "Ad" badge as fallback) and hides them.
- **Duplicate filter** — hides repeated listings of a product that's already shown.
- **Price sort** — optional client-side low-to-high sort. Parses localized prices
  ("US$1.20", "2 705,22 SEK"); ranges sort by their minimum. Shipping is not
  included — Alibaba's search cards don't carry shipping costs.
- **Control panel** — bottom-left overlay with live counts
  ("37/60 shown · 12 off-topic · 10 ads · 1 dupes") and all toggles; settings persist.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) and enable
   **Allow User Scripts** for it (`chrome://extensions` → Tampermonkey → Details).
2. [**Click here to install the script**](https://raw.githubusercontent.com/mathiasm74/alibaba-ultra-efficient/main/alibaba-ultra-efficient.user.js)
   — Tampermonkey will show its install screen. Updates are picked up
   automatically from this repo.
3. Search on Alibaba.com — the script runs on `www.alibaba.com/search/page` URLs.

## Notes

- Alibaba renames its CSS classes regularly. The script keys on stable signals
  (product-detail links, `data-` attributes) with generic fallbacks, and fails
  open: a card whose title can't be read is never hidden.
- Diagnostics go to the browser console under `[Alibaba Ultra Efficient]`
  (flagged ad titles are logged at Verbose/debug level).
