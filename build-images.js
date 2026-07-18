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

  // 2. manifest tables (D2_CACHE env var points at a dir of cached copies for local runs)
  const manifest = await fetchJson(`${BUNGIE}/Platform/Destiny2/Manifest/`);
  const paths = manifest.Response.jsonWorldComponentContentPaths.en;
  const table = async (tableName, cacheFile) => {
    if (process.env.D2_CACHE) {
      const f = path.join(process.env.D2_CACHE, cacheFile);
      if (fs.existsSync(f)) { console.log('cache:', cacheFile); return JSON.parse(fs.readFileSync(f, 'utf8')); }
    }
    console.log('downloading', tableName, '…');
    return fetchJson(BUNGIE + paths[tableName]);
  };
  const defs = await table('DestinyInventoryItemDefinition', 'defs.json');
  const plugSets = await table('DestinyPlugSetDefinition', 'plugsets.json');
  const sandbox = await table('DestinySandboxPerkDefinition', 'sandbox.json');
  const collectibles = await table('DestinyCollectibleDefinition', 'collectibles.json');

  const descOf = d =>
    (d.displayProperties.description ||
     sandbox[d.perks && d.perks[0] && d.perks[0].perkHash]?.displayProperties?.description || '')
    .trim();

  // 3. keep EVERY version of each weapon name (reissues, Pantheon/BRAVE-style
  // variants, craftables) — the app matches each sheet row to the right one
  const byName = new Map();
  for (const hash in defs) {
    const d = defs[hash];
    const name = d.displayProperties && d.displayProperties.name;
    if (!name || !d.displayProperties.icon || d.itemType !== 3) continue;
    const key = norm(name);
    if (!weaponNames.has(key)) continue;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(d);
  }
  for (const vs of byName.values()) vs.sort((a, b) => (b.index || 0) - (a.index || 0));

  // 4. perk dictionary + per-weapon pools
  const perkIdx = new Map();       // norm name -> id
  const poolNames = [];            // id -> [display name, icon, desc]
  const poolScore = new Map();     // id -> quality of the def backing it
  const scoreDef = d =>
    (descOf(d) ? 2 : 0) + (/enhanced/i.test(d.itemTypeDisplayName || '') ? 0 : 1);
  const addPerk = d => {
    const k = norm(d.displayProperties.name);
    if (perkIdx.has(k)) {
      const id = perkIdx.get(k);
      if (scoreDef(d) > poolScore.get(id)) {  // upgrade to base-tier / described def
        poolNames[id] = [d.displayProperties.name, d.displayProperties.icon || '', descOf(d)];
        poolScore.set(id, scoreDef(d));
      }
      return id;
    }
    const id = poolNames.length;
    perkIdx.set(k, id);
    poolScore.set(id, scoreDef(d));
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

  const colsFor = d => {
    if (!d.sockets) return null;
    const idxs = [];
    for (const c of d.sockets.socketCategories || []) {
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
    return cols.length ? cols : null;
  };

  // versions share identical pools constantly — dedupe into one list
  const poolsList = [], poolSeen = new Map();
  const poolRef = cols => {
    if (!cols) return -1;
    const k = JSON.stringify(cols);
    if (poolSeen.has(k)) return poolSeen.get(k);
    poolsList.push(cols);
    poolSeen.set(k, poolsList.length - 1);
    return poolsList.length - 1;
  };

  // 5. sheet-perk map (icon + description), including names not found via pools.
  // Several defs share a perk name (base + Enhanced tiers, reissues) — prefer
  // the base-tier def that actually has a description.
  const perkBest = new Map();
  const WEAPON_PLUG = /barrels|magazines|frames|origins|scopes|blades|guards|batteries|stocks|grips|arrows|bowstrings|tubes|hafts|intrinsics/;
  const perkScore = d =>
    (WEAPON_PLUG.test(d.plug.plugCategoryIdentifier || '') ? 4 : 0) +
    (descOf(d) ? 2 : 0) + (/enhanced/i.test(d.itemTypeDisplayName || '') ? 0 : 1);
  for (const hash in defs) {
    const d = defs[hash];
    const name = d.displayProperties && d.displayProperties.name;
    if (!name || !d.displayProperties.icon || !d.plug) continue;
    const key = norm(name);
    if (!sheetPerkNames.has(key)) continue;
    const cur = perkBest.get(key);
    if (!cur || perkScore(d) > perkScore(cur)) perkBest.set(key, d);
  }
  const perkOut = {};
  for (const [key, d] of perkBest) perkOut[key] = [d.displayProperties.icon, descOf(d)];

  // 6. emit versions: [icon, watermark, craftable, source words, pool index]
  const normSrc = s => s.toLowerCase().replace(/[^a-z0-9' ]/g, ' ').replace(/\s+/g, ' ').trim();
  const wOut = {};
  let multi = 0;
  for (const [key, vs] of byName) {
    wOut[key] = vs.map(d => {
      const src = (collectibles[d.collectibleHash]?.sourceString || '').replace(/^source:\s*/i, '');
      return [d.displayProperties.icon, d.iconWatermark || '',
              d.inventory && d.inventory.recipeItemHash ? 1 : 0,
              normSrc(src), poolRef(colsFor(d))];
    });
    if (vs.length > 1) multi++;
  }

  const missW = [...weaponNames].filter(n => !(n in wOut));
  const missP = [...sheetPerkNames].filter(n => !(n in perkOut));
  console.log(`matched ${Object.keys(wOut).length}/${weaponNames.size} weapons (${multi} with multiple versions), ${Object.keys(perkOut).length}/${sheetPerkNames.size} sheet perks`);
  console.log(`${poolsList.length} distinct pools, ${poolNames.length} distinct pool perks`);
  if (missW.length) console.log('unmatched weapons:', missW.join(' | '));
  if (missP.length) console.log('unmatched perks:', missP.join(' | '));
  const noDesc = poolNames.filter(p => !p[2]).length;
  console.log(`pool perks without description: ${noDesc}`);

  const out = { base: BUNGIE, weapons: wOut, perks: perkOut, poolNames, poolsList };
  fs.writeFileSync(path.join(__dirname, 'images.json'), JSON.stringify(out));
  console.log('wrote images.json', (fs.statSync(path.join(__dirname, 'images.json')).size / 1024).toFixed(0) + 'KB');
})();
