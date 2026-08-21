# SuperDuper Ultra Search

Cleans up marketplace search results, client-side. A modern rebuild of the
classic *AliExpress Ultra Efficient*: that script worked by appending URL
parameters the sites no longer honor, so this one filters the rendered page
instead — and does a lot more.

## What it does

- **Relevance filter** — hides (or dims) results whose titles don't contain
  enough of your search words. Strictness is adjustable: all / most / half /
  any words, or off.
- **Query operators** — `"quoted words"` in your search are mandatory;
  `-word` and `-"a phrase"` are forbidden. Both override the strictness
  setting.
- **Require / Exclude fields** — standing filters in the control panel. They
  work like the query operators but are never sent to the search engine.
  Prefer the Exclude field over `-terms` in the query: these sites have no
  negative-search syntax, so a typed `-term` is treated as a positive keyword
  and *attracts* the results you want gone. The Require field also makes
  image-search results filterable (they have no text query).
- **Price range** — min/max bounds in your displayed currency, localized
  input accepted ("29,49", "1 481").
- **Sponsored filter** — detects ad listings via the sites' own ad-tech
  markers, not just the visible "Ad" badge, and hides them.
- **Duplicate filter** — hides repeated listings of a product already shown
  (typically the sponsored copy of an organic result).
- **Sort by price** — client-side low-to-high sort of the loaded results by
  the displayed price (ranges sort by their minimum). On AliExpress the sort
  uses the total including shipping once fees are fetched; Alibaba's search
  pages don't carry shipping costs.
- **Shipping-inclusive prices** (AliExpress only) — looks up each kept item's
  cheapest shipping option, shows "+kr58,71 shipping = kr980,06" (or
  "free shipping") under the price, and applies the total to the price sort
  and the price range. Free shipping is read straight off the card's own
  badge; otherwise the fee comes from the same product API the item page
  itself loads its data from. Only items that survive filtering are
  requested — one at a time, spaced ~1s apart, with a progress bar in the
  panel while fees load — and fees are cached for a day per ship-to country
  and currency, so pagination and repeat searches don't re-request them. The "Assume free-shipping limit met" toggle treats
  "Free shipping over X" badges as free even when the item alone stays
  under X — for orders that will reach it.
- **Control panel** — bottom-left overlay with live counts
  ("37/60 shown · 12 off-topic · 10 ads · 1 dupes") and all settings, which
  persist across searches and sessions. An Enabled switch (AliExpress) turns
  the whole script off and restores the page, without uninstalling.

## Good to know

- Everything fails open: a result whose title or price can't be read is never
  hidden.
- Shipping fees come from item pages fetched in the background with your
  session, so they match your ship-to country and currency. If AliExpress
  answers with a captcha or rate limit, fetching pauses for that page (the
  counts row shows "shipping paused"); it can be turned off entirely with
  the "Add shipping to prices" toggle.
- The panel fields persist by design — a leftover Require/Exclude term or
  price bound will also apply to your next, unrelated search. The counts row
  is your tell.
- These sites change their markup often. If filtering misbehaves, check the
  browser console (messages are prefixed with the script name) and report an
  issue on [GitHub](https://github.com/mathiasm74/superduper-ultra-ali-search),
  where the source lives. Both the AliExpress and the Alibaba variant are
  developed there.
