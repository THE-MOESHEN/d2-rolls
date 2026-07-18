// Data layer: fetch + parse the Aegis "Destiny 2 Shopping List" Google Sheet.
// Shared between the browser app and the node smoke test.

const SHEET_ID = '1JM-0SlxVDAi-C6rGVlLxa-J1WGewEeL8Qvq4htWZHhY';
const INDEX_GID = '346832350';

// Tabs on the sheet that are not per-weapon lists.
const SKIP_TABS = new Set([
  'Shopping List', 'Archetypes', 'Experimental', 'Exotic Armor', 'Builds',
  'Perks', 'Origin Traits', 'Set Bonuses', 'Artifact Mods', 'Fragments',
  'Aspects', 'Subclasses', 'Encounters', 'Transitions', 'Raid Mods',
]);

function csvUrl(params) {
  return `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&${params}`;
}

// RFC-4180-ish CSV parser: handles quoted fields, escaped quotes, newlines inside quotes.
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// "INFO Season" -> "Season" (gviz flattens merged group headers into the first column of each group)
function cleanHeader(h) {
  return h.replace(/^(WEAPON|INFO|PERKS|ANALYSIS|KEY)\s*/,'').trim();
}

const PERK_COLS = ['Barrel', 'Mag', 'Perk 1', 'Perk 2', 'Origin Trait'];
const META_COLS = new Set(['Notes', 'Rank', 'Tier', 'Name', '🖼️', '']);

// Parse the index tab -> [{tab, updated, status}]
function parseIndexTab(text) {
  const rows = parseCSV(text);
  const out = [];
  for (const r of rows.slice(1)) {
    const [tab, updated, status] = r;
    if (!tab || !status) continue; // footer notes have empty STATUS
    out.push({ tab: tab.trim(), updated: (updated || '').trim(), status: (status || '').trim() });
  }
  return out;
}

// Parse a weapon tab's CSV into weapon objects. Returns [] if the tab
// doesn't look like a weapon list (so unknown tabs are skipped safely).
function parseWeaponTab(tabName, text) {
  const rows = parseCSV(text);
  if (!rows.length) return [];
  const headers = rows[0].map(cleanHeader);
  const col = name => headers.indexOf(name);
  if (col('Name') === -1) return [];

  const isExotic = col('Description') !== -1;
  if (!isExotic && col('Perk 1') === -1) return [];

  const weapons = [];
  const legend = []; // exotic tab symbol key, e.g. ✔ = Optimal

  for (const r of rows.slice(1)) {
    const get = name => { const i = col(name); return i === -1 ? '' : (r[i] || '').trim(); };
    const rawName = get('Name');

    if (isExotic) {
      // The KEY legend lives in trailing columns of the first few rows.
      const ki = headers.lastIndexOf('');
      if (ki > 0 && r[ki - 1] && r[ki]) legend.push({ symbol: r[ki - 1].trim(), meaning: r[ki].trim() });
    }
    if (!rawName) continue;

    const nameLines = rawName.split('\n').map(s => s.trim()).filter(Boolean);
    const w = {
      name: nameLines[0],
      variant: nameLines.slice(1).join(' · '),
      tab: tabName,
      tier: get('Tier'),
      rank: get('Rank'),
      notes: get('Notes'),
      exotic: isExotic,
      info: [],
      perks: [],
    };

    if (isExotic) {
      w.description = get('Description');
      w.ratings = ['Roam', 'DPS', 'Day 1', 'Chall', 'Speed']
        .filter(k => col(k) !== -1)
        .map(k => ({ label: k, value: get(k) }));
      for (const k of ['Season', 'Ammo', 'Type', 'Tags', 'Stun']) {
        const v = get(k);
        if (v) w.info.push({ label: k, value: v });
      }
    } else {
      for (let i = col('Name') + 1; i < headers.length; i++) {
        const h = headers[i];
        const v = (r[i] || '').trim();
        if (!v || PERK_COLS.includes(h) || META_COLS.has(h)) continue;
        w.info.push({ label: h === '⬆️' ? 'Enhance' : h, value: v });
      }
      for (const p of PERK_COLS) {
        const v = get(p);
        if (v) w.perks.push({ label: p, options: v.split('\n').map(s => s.trim()).filter(Boolean) });
      }
    }
    weapons.push(w);
  }

  if (isExotic && legend.length) {
    const seen = new Set();
    const dedup = legend.filter(l => !seen.has(l.symbol) && seen.add(l.symbol));
    for (const w of weapons) w.legend = dedup;
  }
  return weapons;
}

if (typeof module !== 'undefined') {
  module.exports = { SHEET_ID, INDEX_GID, SKIP_TABS, csvUrl, parseCSV, parseIndexTab, parseWeaponTab };
}
