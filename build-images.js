// Build images.json: maps every weapon + perk name referenced by the sheet
// to its bungie.net icon path, via the public Destiny 2 manifest CDN.
// Run by GitHub Actions on a schedule (see .github/workflows/refresh-images.yml).

const fs = require('fs');
const path = require('path');
const { INDEX_GID, SKIP_TABS, csvUrl, parseIndexTab, parseWeaponTab } = require('./data.js');

const BUNGIE = 'https://www.bungie.net';
const norm = s => s.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();

(async () => {
  const idxText = await (await fetch(csvUrl(`gid=${INDEX_GID}`))).text();
  const tabs = parseIndexTab(idxText).filter(t => !SKIP_TABS.has(t.tab));
  const weapons = (await Promise.all(tabs.map(async t =>
    parseWeaponTab(t.tab, await (await fetch(csvUrl(`sheet=${encodeURIComponent(t.tab)}`))).text())
  ))).flat();

  const weaponNames = new Set(), perkNames = new Set();
  for (const w of weapons) {
    weaponNames.add(norm(w.name));
    for (const p of w.perks) for (const o of p.options) perkNames.add(norm(o));
  }
  console.log(`sheet: ${weaponNames.size} weapon names, ${perkNames.size} perk names`);

  const manifest = await (await fetch(`${BUNGIE}/Platform/Destiny2/Manifest/`)).json();
  const defPath = manifest.Response.jsonWorldComponentContentPaths.en.DestinyInventoryItemDefinition;
  console.log('downloading item definitions:', defPath);
  const defs = await (await fetch(BUNGIE + defPath)).json();

  const wOut = {}, pOut = {};
  for (const hash in defs) {
    const d = defs[hash];
    const name = d.displayProperties && d.displayProperties.name;
    const icon = d.displayProperties && d.displayProperties.icon;
    if (!name || !icon) continue;
    const key = norm(name);
    if (d.itemType === 3 && weaponNames.has(key)) {
      // several versions of a weapon can exist; prefer one with a season watermark
      const cur = wOut[key];
      if (!cur || (!cur[1] && d.iconWatermark)) wOut[key] = [icon, d.iconWatermark || ''];
    } else if (d.plug && perkNames.has(key) && !(key in pOut)) {
      pOut[key] = icon;
    }
  }

  const missW = [...weaponNames].filter(n => !(n in wOut));
  const missP = [...perkNames].filter(n => !(n in pOut));
  console.log(`matched ${Object.keys(wOut).length}/${weaponNames.size} weapons, ${Object.keys(pOut).length}/${perkNames.size} perks`);
  if (missW.length) console.log('unmatched weapons:', missW.join(' | '));
  if (missP.length) console.log('unmatched perks:', missP.join(' | '));

  const out = { base: BUNGIE, weapons: wOut, perks: pOut };
  fs.writeFileSync(path.join(__dirname, 'images.json'), JSON.stringify(out));
  console.log('wrote images.json', (fs.statSync(path.join(__dirname, 'images.json')).size / 1024).toFixed(0) + 'KB');
})();
