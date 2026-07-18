/* global SKIP_TABS, INDEX_GID, csvUrl, parseIndexTab, parseWeaponTab, BIS_TABS, bisCsvUrl, parseBiSTab */
(() => {
  const $ = id => document.getElementById(id);
  const chipEl = $('chip'), chipState = $('chipState'), statusEl = $('status'),
        resultsEl = $('results'), chipsEl = $('chips'), qEl = $('q'), sbEl = $('searchbox');

  const CACHE_KEY = 'd2rolls:v2';
  const TTL = 15 * 60 * 1000;

  let weapons = [];          // all parsed weapons
  let tabOrder = [];         // weapon tab names in sheet order
  let updatedByTab = {};     // tab -> UPDATED date from the index
  let images = null;         // images.json (may fail; icons just won't show)
  let activeTab = '';        // chip filter
  let bisOnly = false;       // ★ BiS list filter
  let selected = null;       // weapon shown as full card
  let acItems = [], acIndex = -1;

  const norm = s => s.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
  const esc = s => s.replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

  /* ---------- icons & version matching ---------- */
  function versionsFor(w) {
    if (!images) return null;
    const key = norm(w.name);
    return images.weapons[key] || images.weapons[key.replace(/\s*\(.*\)$/, '')] || null;
  }
  // a version is [icon, watermark, craftable, source words, pool index]
  let poolSets = null;
  function poolSet(i) {
    if (i < 0 || !images.poolsList) return null;
    if (!poolSets) poolSets = new Map();
    if (!poolSets.has(i)) {
      const s = new Set();
      for (const [, ids] of images.poolsList[i]) for (const id of ids) s.add(norm(images.poolNames[id][0]));
      poolSets.set(i, s);
    }
    return poolSets.get(i);
  }
  // pick the manifest version this sheet row is talking about: the one whose
  // perk pool contains the row's recommended perks; ties broken by source
  // text ("Pantheon" vs "King's Fall"), then craftability, then recency
  function matchVersion(w) {
    const vs = versionsFor(w);
    if (!vs || !vs.length) return null;
    if (vs.length === 1) return vs[0];
    const recs = (w.perks || []).flatMap(p => p.options).map(norm).filter(n => n !== 'none');
    const srcW = norm(((w.info.find(i => i.label === 'Source') || {}).value || '') + ' ' + (w.variant || ''))
      .replace(/[^a-z0-9' ]/g, ' ').split(/\s+/)
      .filter(t => t.length > 2 && t !== 'the' && t !== 'version');
    const lexGt = (a, b) => {
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
      return false;
    };
    let best = null, bs = null;
    vs.forEach((v, pos) => {
      const set = poolSet(v[4]);
      const score = [
        set ? recs.filter(r => set.has(r)).length : 0,
        v[3] ? srcW.filter(t => v[3].includes(t)).length : 0,
        v[3] ? 1 : 0,  // canonical releases (with a collections entry) beat limited variants
        v[2], -pos,
      ];
      if (!bs || lexGt(score, bs)) { bs = score; best = v; }
    });
    return best;
  }
  // for Pantheon rows, show the shiny variant art where one exists: the
  // collectible-less sibling def sharing the exact same perk pool
  function displayVersion(w) {
    const v = matchVersion(w);
    if (!v) return null;
    const rowText = norm(((w.info.find(i => i.label === 'Source') || {}).value || '') + ' ' + (w.variant || ''));
    if (/pantheon/.test(rowText)) {
      const vs = versionsFor(w);
      const shiny = vs && vs.find(s => s !== v && !s[3] && s[4] === v[4] && s[0] !== v[0]);
      if (shiny) return shiny;
    }
    return v;
  }
  function weaponIcon(w, size) {
    const v = displayVersion(w);
    if (!v) return '';
    const wm = v[1] ? `<img class="wm" src="${images.base}${esc(v[1])}" alt="" loading="lazy">` : '';
    return `<span class="wicon" style="--s:${size}px"><img src="${images.base}${esc(v[0])}" alt="" loading="lazy">${wm}</span>`;
  }
  function perkIcon(name) {
    if (!images || /^none$/i.test(name)) return '';
    const p = images.perks[norm(name)];
    return p ? `<img class="picon" src="${images.base}${esc(p[0])}" alt="" loading="lazy">` : '';
  }
  // pool perk descriptions, indexed lazily from images.poolNames
  let poolDescMap = null;
  function descFor(name) {
    if (!images) return '';
    const k = norm(name);
    if (!poolDescMap && images.poolNames) {
      poolDescMap = new Map(images.poolNames.map(p => [norm(p[0]), p[2]]));
    }
    // pool text first: it comes from real weapon sockets (base tier, no
    // name collisions with armor/exotic intrinsics); sheet map is fallback
    const pool = poolDescMap && poolDescMap.get(k);
    if (pool) return pool;
    const sheet = images.perks[k];
    return (sheet && sheet[1]) || '';
  }
  function poolFor(w) {
    const v = matchVersion(w);
    return v && v[4] >= 0 && images.poolsList ? images.poolsList[v[4]] : null;
  }
  const cleanDesc = s => s.replace(/\[[^\]]+\]\s*/g, '');
  const ttAttr = name => descFor(name) ? ` data-pn="${esc(name)}" tabindex="0"` : '';

  /* ---------- data loading ---------- */
  function setChip(state, label) {
    chipEl.className = 'chip ' + state;
    chipState.textContent = label;
  }

  async function loadData(force) {
    if (!force) {
      try {
        const c = JSON.parse(localStorage.getItem(CACHE_KEY));
        if (c && Date.now() - c.ts < TTL) return c;
      } catch {}
    }
    setChip('connecting', 'syncing');
    const [idxText, bisSlotText, bisActText] = await Promise.all([
      fetch(csvUrl(`gid=${INDEX_GID}`)).then(r => r.text()),
      fetch(bisCsvUrl(BIS_TABS[0].gid)).then(r => r.text()).catch(() => ''),
      fetch(bisCsvUrl(BIS_TABS[1].gid)).then(r => r.text()).catch(() => ''),
    ]);
    const index = parseIndexTab(idxText);
    const tabs = index.filter(t => !SKIP_TABS.has(t.tab));
    let done = 0;
    const perTab = await Promise.all(tabs.map(async t => {
      const text = await (await fetch(csvUrl(`sheet=${encodeURIComponent(t.tab)}`))).text();
      statusEl.textContent = `Loading the sheet… ${++done}/${tabs.length}`;
      return parseWeaponTab(t.tab, text);
    }));
    const data = {
      ts: Date.now(),
      weapons: perTab.flat(),
      tabOrder: tabs.map(t => t.tab),
      updatedByTab: Object.fromEntries(index.map(t => [t.tab, t.updated])),
      bis: {
        slot: bisSlotText ? parseBiSTab(bisSlotText, 'slot') : [],
        activity: bisActText ? parseBiSTab(bisActText, 'activity') : [],
      },
    };
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch {}
    return data;
  }

  function agoLabel(ts) {
    const m = Math.round((Date.now() - ts) / 60000);
    return m < 1 ? 'synced just now' : `synced ${m}m ago`;
  }

  async function boot(force) {
    try {
      const data = await loadData(force);
      weapons = data.weapons; tabOrder = data.tabOrder; updatedByTab = data.updatedByTab;
      applyOverlay(weapons, data.bis);
      setChip('on', agoLabel(data.ts));
      statusEl.textContent = '';
      renderChips();
      applyHash();
      render();
    } catch (e) {
      console.error(e);
      setChip('err', 'offline');
      statusEl.textContent = 'Could not reach the spreadsheet. Check your connection and hit refresh.';
      statusEl.classList.add('err');
    }
  }

  fetch('images.json').then(r => r.ok ? r.json() : null).then(j => { images = j; render(); }).catch(() => {});

  /* ---------- BiS overlay ---------- */
  function applyOverlay(ws, bis) {
    if (!bis) return;
    const entries = [
      ...bis.slot.map(e => ({ ...e, type: 'slot' })),
      ...bis.activity.map(e => ({ ...e, type: 'activity' })),
    ];
    const byKey = new Map();
    for (const e of entries) {
      const k = norm(e.name);
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(e);
    }
    const keys = [...byKey.keys()];
    for (const w of ws) {
      const wk = norm(w.name);
      let list = byKey.get(wk);
      if (!list) {
        // sheet cells are sometimes truncated ("The Time-Worn Sp") — prefix match
        const pk = keys.find(k => k.length >= 6 && wk.startsWith(k));
        if (pk) list = byKey.get(pk);
      }
      if (!list) continue;
      w.bis = {
        groups: [...new Set(list.filter(e => e.type === 'slot').map(e => e.group))],
        activities: [...new Set(list.filter(e => e.type === 'activity').map(e => e.group))],
        craft: list.some(e => e.craft),
      };
    }
  }

  /* ---------- search ---------- */
  function score(w, q) {
    const n = norm(w.name);
    if (n === q) return 0;
    if (n.startsWith(q)) return 1;
    if (n.split(/[^a-z0-9']+/).some(word => word.startsWith(q))) return 2;
    if (n.includes(q)) return 3;
    return -1;
  }
  function search(q) {
    q = norm(q);
    if (!q) return [];
    return weapons
      .map(w => ({ w, s: score(w, q) }))
      .filter(x => x.s >= 0)
      .sort((a, b) => a.s - b.s || a.w.name.localeCompare(b.w.name))
      .map(x => x.w);
  }

  /* ---------- rendering ---------- */
  function tierBadge(w, big) {
    const t = (w.tier || '?').trim().charAt(0).toUpperCase();
    return `<span class="tier${big ? ' big' : ''}" data-t="${esc(t)}">${esc(t || '?')}</span>`;
  }

  function renderChips() {
    chipsEl.innerHTML = tabOrder.map(t =>
      `<button data-tab="${esc(t)}" class="${t === activeTab ? 'active' : ''}">${esc(t)}</button>`).join('');
    const b = $('bisBtn');
    b.classList.toggle('active', bisOnly);
    b.setAttribute('aria-pressed', String(bisOnly));
    $('bisHint').classList.toggle('show', bisOnly);
  }
  const star = w => w.bis ? '<span class="star" title="On the BiS list">★</span>' : '';

  function hitRow(w) {
    const meta = [w.exotic ? 'Exotic' : w.tab, w.info.find(i => i.label === 'Frame')?.value, w.info.find(i => i.label === 'Energy')?.value]
      .filter(Boolean).join(' · ');
    return `<button class="hit" data-w="${esc(w.tab)}|${esc(w.name)}|${esc(w.rank)}">
      ${weaponIcon(w, 44)}${tierBadge(w)}
      <span class="nm">${esc(w.name)}${star(w)}${w.variant ? `<small>${esc(w.variant)}</small>` : ''}</span>
      <span class="meta">${esc(meta)}</span>
    </button>`;
  }

  function poolRows(ids, exclude) {
    return ids
      .map(id => images.poolNames[id])
      .filter(p => !exclude.has(norm(p[0])))
      .map(p => `<span class="pl"${ttAttr(p[0])}>${p[1] ? `<img class="picon" src="${images.base}${esc(p[1])}" alt="" loading="lazy">` : ''}<span>${esc(p[0])}</span></span>`)
      .join('');
  }

  function card(w) {
    const pool = poolFor(w);
    const poolCols = pool || [];
    const intrinsic = poolCols.find(c => c[0] === 'Intrinsic');
    const intrinsicName = intrinsic && images.poolNames[intrinsic[1][0]] ? images.poolNames[intrinsic[1][0]][0] : '';
    let infoBadges = w.info.map(i => {
      const tt = i.label === 'Frame' && intrinsicName ? ttAttr(intrinsicName) : '';
      return `<span class="badge${i.label === 'Energy' ? ' energy-' + esc(i.value) : ''}${tt ? ' hasinfo' : ''}"${tt}>${esc(i.label)} <b>${esc(i.value)}</b></span>`;
    }).join('');
    // craftability of THIS version, from the manifest (recipe present or not)
    const allVs = versionsFor(w), mv = matchVersion(w);
    if (mv && allVs && allVs.some(v => v[2])) {
      infoBadges += `<span class="badge">Craftable <b>${mv[2] ? 'Yes' : 'No — other version is'}</b></span>`;
    }
    let body = '';
    if (w.exotic) {
      const legend = (w.legend || []);
      const symCls = s => ({'✔':'sym-good','▲':'sym-ok','!':'sym-meh','✖':'sym-bad'}[s] || '');
      body = `
        ${w.description ? `<p class="desc">${esc(w.description)}</p>` : ''}
        <div class="ratings">${w.ratings.map(r => `
          <span class="rating"><span class="sym ${symCls(r.value)}">${esc(r.value || '—')}</span>
          <span class="lbl">${esc(r.label)}</span></span>`).join('')}
        </div>
        ${legend.length ? `<p class="legend">${legend.map(l => `<span><b class="${symCls(l.symbol)}">${esc(l.symbol)}</b> ${esc(l.meaning)}</span>`).join('')}</p>` : ''}
        ${poolCols.length ? `<div class="perks">${poolCols.map(c => `
          <div class="perkcol"><h3>${esc(c[0])}</h3><div class="pool">${poolRows(c[1], new Set())}</div></div>`).join('')}</div>` : ''}`;
    } else {
      // merge sheet recommendations with the weapon's full pool, slot by slot
      const nonOrigin = poolCols.filter(c => c[0] !== 'Intrinsic' && c[0] !== 'Origin Trait');
      const SLOTS = ['Barrel', 'Mag', 'Perk 1', 'Perk 2', 'Origin Trait'];
      const cols = SLOTS.map((slot, i) => {
        const rec = w.perks.find(p => p.label === slot);
        const pc = slot === 'Origin Trait' ? poolCols.find(c => c[0] === 'Origin Trait') : nonOrigin[i];
        if (!rec && !pc) return '';
        // pool label is more specific for non-standard archetypes (Blade, String, …)
        const label = pc && !['Perk', 'Trait'].includes(pc[0]) && slot !== 'Perk 1' && slot !== 'Perk 2' ? pc[0] : slot;
        const recNames = new Set((rec ? rec.options : []).map(norm));
        const rest = pc ? poolRows(pc[1], recNames) : '';
        return `<div class="perkcol"><h3>${esc(label)}</h3>
          ${rec ? `<ol>${rec.options.map(o => `<li${ttAttr(o)}>${perkIcon(o)}<span>${esc(o)}</span></li>`).join('')}</ol>` : ''}
          ${rest ? `<div class="pool">${rec ? '<span class="pool-h">Full pool</span>' : ''}${rest}</div>` : ''}
        </div>`;
      }).filter(Boolean);
      body = `<div class="perks">${cols.join('')}</div>`;
    }
    const upd = updatedByTab[w.tab];
    return `<div class="card sel">
      <div class="head">
        ${weaponIcon(w, 72)}
        <div class="ttl"><h2>${esc(w.name)}</h2>${w.variant ? `<div class="variant">${esc(w.variant)}</div>` : ''}</div>
        ${tierBadge(w, true)}
        <button class="close" data-close title="Close">✕</button>
      </div>
      <div class="badges">
        <span class="badge">${esc(w.exotic ? 'Exotic' : w.tab)}${w.rank ? ` <b>#${esc(w.rank)}</b>` : ''}</span>
        ${infoBadges}
      </div>
      ${w.bis ? `<div class="bisbox">★ BiS pick${
        w.bis.groups.length ? ` — <b>${esc(w.bis.groups.join(' · '))}</b>` : ''}${
        w.bis.activities.length ? ` · best choice in: ${esc(w.bis.activities.join(', '))}` : ''}${
        w.bis.craft ? ' · craftable' : ''}</div>` : ''}
      ${body}
      ${w.notes ? `<p class="notes">“${esc(w.notes)}”</p>` : ''}
      <div class="links">
        <a href="https://www.light.gg/db/search?q=${encodeURIComponent(w.name)}" target="_blank" rel="noopener">light.gg ↗</a>
        ${upd ? `<span class="upd">${esc(w.tab)} tab updated ${esc(upd)}</span>` : ''}
      </div>
    </div>`;
  }

  function render() {
    renderChips();
    const q = qEl.value.trim();
    if (selected) {
      resultsEl.innerHTML = `<button class="back" data-back>← back to results</button>` + card(selected);
      return;
    }
    const vis = w => !bisOnly || w.bis;
    if (q) {
      const hits = search(q).filter(vis).slice(0, 40);
      resultsEl.innerHTML = hits.length
        ? hits.map(hitRow).join('')
        : `<div class="status">No ${bisOnly ? 'BiS ' : ''}weapon matching “${esc(q)}” — try fewer letters.</div>`;
      return;
    }
    if (activeTab) {
      const list = weapons.filter(w => w.tab === activeTab).filter(vis);
      resultsEl.innerHTML = list.length ? list.map(hitRow).join('')
        : `<div class="status">No BiS picks in ${esc(activeTab)}.</div>`;
      return;
    }
    if (bisOnly) {
      resultsEl.innerHTML = weapons.filter(w => w.bis).map(hitRow).join('');
      return;
    }
    if (weapons.length) {
      resultsEl.innerHTML = `<div class="status">${weapons.length} weapons loaded · search above, pick a weapon type, or hit ★ BiS.</div>`;
    }
  }

  /* ---------- autocomplete ---------- */
  const acEl = document.createElement('div');
  acEl.className = 'ac';
  sbEl.appendChild(acEl);

  function renderAC() {
    if (!acItems.length) { acEl.innerHTML = ''; acEl.classList.remove('open'); return; }
    acEl.classList.add('open');
    acEl.innerHTML = acItems.map((w, i) => `
      <button class="ac-row${i === acIndex ? ' active' : ''}" data-w="${esc(w.tab)}|${esc(w.name)}|${esc(w.rank)}">
        ${weaponIcon(w, 34)}<span class="nm">${esc(w.name)}${star(w)}</span>
        <span class="meta">${esc(w.exotic ? 'Exotic' : w.tab)}</span>${tierBadge(w)}
      </button>`).join('');
  }
  function closeAC() { acItems = []; acIndex = -1; renderAC(); }

  function select(w, fromHash) {
    selected = w;
    closeAC();
    if (!fromHash) history.replaceState(null, '', '#w=' + encodeURIComponent(w.tab + '|' + w.name + '|' + w.rank));
    render();
    window.scrollTo({ top: 0 });
  }
  function findByKey(key) {
    const [tab, name, rank] = key.split('|');
    // rank disambiguates same-named rows (e.g. raid vs Pantheon versions)
    return (rank !== undefined && weapons.find(w => w.tab === tab && w.name === name && w.rank === rank))
      || weapons.find(w => w.tab === tab && w.name === name)
      || weapons.find(w => w.name === name);
  }
  function applyHash() {
    const m = location.hash.match(/^#w=(.+)$/);
    if (m) {
      const w = findByKey(decodeURIComponent(m[1]));
      if (w) { selected = w; }
    }
  }

  /* ---------- events ---------- */
  qEl.addEventListener('input', () => {
    selected = null;
    history.replaceState(null, '', location.pathname + location.search);
    acItems = search(qEl.value).slice(0, 8);
    acIndex = acItems.length ? 0 : -1;
    renderAC();
    render();
  });
  qEl.addEventListener('keydown', e => {
    if (!acItems.length) return;
    if (e.key === 'ArrowDown') { acIndex = (acIndex + 1) % acItems.length; renderAC(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { acIndex = (acIndex - 1 + acItems.length) % acItems.length; renderAC(); e.preventDefault(); }
    else if (e.key === 'Enter' && acIndex >= 0) { select(acItems[acIndex]); e.preventDefault(); }
    else if (e.key === 'Escape') closeAC();
  });
  document.addEventListener('click', e => {
    if (!sbEl.contains(e.target)) closeAC();
    const row = e.target.closest('[data-w]');
    if (row) { const w = findByKey(row.dataset.w); if (w) select(w); }
    if (e.target.closest('[data-back]') || e.target.closest('[data-close]')) {
      selected = null;
      history.replaceState(null, '', location.pathname + location.search);
      render();
      qEl.focus();
    }
    const chip = e.target.closest('[data-tab]');
    if (chip) {
      activeTab = activeTab === chip.dataset.tab ? '' : chip.dataset.tab;
      selected = null; qEl.value = '';
      render();
    }
    if (e.target.closest('#bisBtn')) {
      bisOnly = !bisOnly;
      selected = null;
      render();
    }
  });
  $('refreshBtn').addEventListener('click', () => { statusEl.classList.remove('err'); statusEl.textContent = 'Refreshing…'; boot(true); });
  window.addEventListener('hashchange', () => { applyHash(); render(); });

  /* ---------- perk tooltip ---------- */
  const tipEl = document.createElement('div');
  tipEl.className = 'tip';
  document.body.appendChild(tipEl);
  let tipFor = null;

  function showTip(el) {
    const name = el.dataset.pn;
    const desc = descFor(name);
    if (!desc) return;
    tipFor = el;
    tipEl.innerHTML = `<b>${esc(name)}</b>${esc(cleanDesc(desc))}`;
    tipEl.style.display = 'block';
    const r = el.getBoundingClientRect(), t = tipEl.getBoundingClientRect();
    let x = Math.min(Math.max(8, r.left), innerWidth - t.width - 8);
    let y = r.bottom + 8;
    if (y + t.height > innerHeight - 8) y = r.top - t.height - 8;
    tipEl.style.left = x + 'px';
    tipEl.style.top = Math.max(8, y) + 'px';
  }
  function hideTip() { tipFor = null; tipEl.style.display = 'none'; }

  document.addEventListener('mouseover', e => {
    const el = e.target.closest('[data-pn]');
    if (el) showTip(el); else if (tipFor) hideTip();
  });
  document.addEventListener('focusin', e => {
    const el = e.target.closest('[data-pn]');
    if (el) showTip(el); else hideTip();
  });
  document.addEventListener('touchstart', e => {
    const el = e.target.closest('[data-pn]');
    if (el && tipFor !== el) { showTip(el); }
    else if (!e.target.closest('.tip')) hideTip();
  }, { passive: true });
  window.addEventListener('scroll', hideTip, { passive: true });

  setInterval(() => {
    if (chipEl.classList.contains('on')) {
      try { const c = JSON.parse(localStorage.getItem(CACHE_KEY)); if (c) chipState.textContent = agoLabel(c.ts); } catch {}
    }
  }, 60000);

  boot(false);
})();
