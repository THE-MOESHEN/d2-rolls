# D2 God Roll Lookup

Search any Destiny 2 weapon and get its best PvE roll — perks in priority order,
tier, rank and notes. A static page, no backend.

**Live:** https://the-moeshen.github.io/d2-rolls/

## How it stays fresh

- **Roll data** is fetched in the browser, live from
  [The Aegis' Destiny 2 Shopping List](https://docs.google.com/spreadsheets/d/1JM-0SlxVDAi-C6rGVlLxa-J1WGewEeL8Qvq4htWZHhY/edit)
  (community sheet by **@theaegisrelic**) via the public CSV endpoints, cached
  in `localStorage` for 15 minutes. Nothing is baked in — if the sheet changes,
  the site changes.
- **Weapon & perk icons, perk descriptions, and full perk pools** come from the
  Bungie manifest. `build-images.js` resolves every weapon on the sheet to its
  newest manifest version and extracts each socket's currently-rollable plug
  set, writing it all to `images.json`; a GitHub Action re-runs it daily.
  Icons themselves are hotlinked from bungie.net.

## Files

- `index.html` / `styles.css` — UI (design language shared with checkpoint-helper)
- `data.js` — sheet fetching + CSV/tab parsing (shared with the build script)
- `app.js` — search, autocomplete, rendering
- `build-images.js` — name → icon mapping via the Destiny 2 manifest
- `images.json` — generated; committed so the page needs no API at view time

All weapon data belongs to the community-maintained Shopping List; all icons
and names are © Bungie.
