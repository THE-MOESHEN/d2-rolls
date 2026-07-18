// Build images.json: weapon + perk icons, in-game perk descriptions, and the
// complete perk pool for every weapon on the sheet — all from the public
// Destiny 2 manifest CDN. Run daily by GitHub Actions.

const fs = require('fs');
const path = require('path');
const { INDEX_GID, SKIP_TABS, csvUrl, parseIndexTab, parseWeaponTab } = require('./data.js');

const BUNGIE = 'https://www.bungie.net';
const norm = s => s.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();

const CAT_WEAPON_PERKS = 4241085061;
const CAT_INTRINSIC = 3956125808;
// plugCategoryIdentifier keyword -> column label
const CAT_LABEL = [
  ['origins', 'Origin Trait'], ['barrels', 'Barrel'], ['blades', 'Blade'],
  ['grips', 'Grip'], ['batteries', 'Battery'], ['magazines', 'Mag'],
  ['stocks', 'Stock'], ['arrows', 'Arrow'], ['bowstrings', 'String'],
  ['guards', 'Guard'], ['scopes', 'Scope'], ['tubes', 'Tube'], ['hafts', 'Haft'],
  ['intrinsics', 'Intrinsic'], ['frames', 'Trait'],
];
const JUNK_PLUG = /tracker|memento|shader|skin|masterwork|crafting|infus|empty|mods\.|_mod|dummy/i;

async function fetchJson(u) { return (await fetch(u)).json(); }

(async () => {
  // 1. names the sheet references
  const idxText = await (await fetch(csvUrl(`gid=${INDEX_GID}`))).text();
  const tabs = parseIndexTab(idxText).filter(t => !SKIP_TABS.has(t.tab));
  const weapons = (await Promise.all(tabs.map(async t =>
    parseWeaponTab(t.tab, await (await fetch(csvUrl(`sheet=${encodeURIComponent(t.tab)}`))).text())
  ))).flat();

  const weaponNames = new Set(), sheetPerkNames = new Set();
  for (const w of weapons) {
    weaponNames.add(norm(w.name));
    for (const p of w.perks) for (const o of p.options) sheetPerkNames.add(norm(o));
  }
  console.log(`sheet: ${weaponNames.size} weapon names, ${sheetPerkNames.size} perk names`);

  // 2. manifest tables
  const manifest = await fetchJson(`${BUNGIE}/Platform/Destiny2/Manifest/`);
  const paths = manifest.Response.jsonWorldComponentContentPaths.en;
  console.log('downloading item definitions…');
  const defs = await fetchJson(BUNGIE + paths.DestinyInventoryItemDefinition);
  console.log('downloading plug sets…');
  const plugSets = await fetchJson(BUNGIE + paths.DestinyPlugSetDefinition);
  console.log('downloading sandbox perks…');
  const sandbox = await fetchJson(BUNGIE + paths.DestinySandboxPerkDefinition);

  const descOf = d =>
    (d.displayProperties.description ||
     sandbox[d.perks && d.perks[0] && d.perks[0].perkHash]?.displayProperties?.description || '')
    .trim();

  // 3. pick the newest def per weapon name (watermark first, then manifest index)
  const best = new Map();
  for (const hash in defs) {
    const d = defs[hash];
    const name = d.displayProperties && d.displayProperties.name;
    if (!name || !d.displayProperties.icon || d.itemType !== 3) continue;
    const key = norm(name);
    if (!weaponNames.has(key)) continue;
    const cur = best.get(key);
    const better = !cur ||
      (!!d.iconWatermark - !!cur.iconWatermark) > 0 ||
      (!!d.iconWatermark === !!cur.iconWatermark && (d.index || 0) > (cur.index || 0));
    if (better) best.set(key, d);
  }

  // 4. perk dictionary + per-weapon pools
  const perkIdx = new Map();       // norm name -> id
  const poolNames = [];            // id -> [display name, icon, desc]
  const addPerk = d => {
    const k = norm(d.displayProperties.name);
    if (perkIdx.has(k)) return perkIdx.get(k);
    const id = poolNames.length;
    perkIdx.set(k, id);
    poolNames.push([d.displayProperties.name, d.displayProperties.icon || '', descOf(d)]);
    return id;
  };

  const socketPlugs = entry => {
    const setHash = entry.randomizedPlugSetHash || entry.reusablePlugSetHash;
    if (setHash && plugSets[setHash])
      return plugSets[setHash].reusablePlugItems
        .filter(p => p.currentlyCanRoll !== false).map(p => p.plugItemHash);
    if (entry.reusablePlugItems && entry.reusablePlugItems.length)
      return entry.reusablePlugItems.map(p => p.plugItemHash);
    return entry.singleInitialItemHash ? [entry.singleInitialItemHash] : [];
  };

  const labelFor = ident => {
    for (const [kw, label] of CAT_LABEL) if (ident.includes(kw)) return label;
    return 'Perk';
  };

  const pools = {};
  const catCounts = {};
  for (const [key, d] of best) {
    if (!d.sockets) continue;
    const cats = d.sockets.socketCategories || [];
    const idxs = [];
    for (const c of cats) {
      if (c.socketCategoryHash === CAT_INTRINSIC) idxs.unshift(...c.socketIndexes);
      else if (c.socketCategoryHash === CAT_WEAPON_PERKS) idxs.push(...c.socketIndexes);
    }
    const cols = [];
    for (const si of idxs) {
      const entry = d.sockets.socketEntries[si];
      if (!entry) continue;
      const seen = new Set(), ids = [];
      let label = '';
      for (const h of socketPlugs(entry)) {
        const p = defs[h];
        if (!p || !p.displayProperties || !p.displayProperties.name || !p.plug) continue;
        const ident = p.plug.plugCategoryIdentifier || '';
        if (JUNK_PLUG.test(ident)) continue;
        catCounts[ident] = (catCounts[ident] || 0) + 1;
        const nk = norm(p.displayProperties.name);
        if (seen.has(nk)) continue;  // enhanced dupes share the name
        seen.add(nk);
        if (!label) label = labelFor(ident);
        ids.push(addPerk(p));
      }
      if (ids.length) cols.push([label, ids]);
    }
    // two 'Trait' columns -> Perk 1 / Perk 2
    const traits = cols.filter(c => c[0] === 'Trait');
    if (traits.length >= 2) traits.forEach((c, i) => { c[0] = `Perk ${i + 1}`; });
    if (cols.length) pools[key] = cols;
  }

  // 5. sheet-perk map (icon + description), including names not found via pools
  const perkOut = {};
  for (const hash in defs) {
    const d = defs[hash];
    const name = d.displayProperties && d.displayProperties.name;
    if (!name || !d.displayProperties.icon || !d.plug) continue;
    const key = norm(name);
    if (sheetPerkNames.has(key) && !(key in perkOut))
      perkOut[key] = [d.displayProperties.icon, descOf(d)];
  }

  const wOut = {};
  for (const [key, d] of best) wOut[key] = [d.displayProperties.icon, d.iconWatermark || ''];

  const missW = [...weaponNames].filter(n => !(n in wOut));
  const missP = [...sheetPerkNames].filter(n => !(n in perkOut));
  console.log(`matched ${Object.keys(wOut).length}/${weaponNames.size} weapons, ${Object.keys(perkOut).length}/${sheetPerkNames.size} sheet perks`);
  console.log(`pools for ${Object.keys(pools).length} weapons, ${poolNames.length} distinct pool perks`);
  if (missW.length) console.log('unmatched weapons:', missW.join(' | '));
  if (missP.length) console.log('unmatched perks:', missP.join(' | '));
  const noDesc = poolNames.filter(p => !p[2]).length;
  console.log(`pool perks without description: ${noDesc}`);

  const out = { base: BUNGIE, weapons: wOut, perks: perkOut, poolNames, pools };
  fs.writeFileSync(path.join(__dirname, 'images.json'), JSON.stringify(out));
  console.log('wrote images.json', (fs.statSync(path.join(__dirname, 'images.json')).size / 1024).toFixed(0) + 'KB');
})();
