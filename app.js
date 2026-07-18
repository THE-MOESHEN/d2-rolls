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

  /* ---------- icons ---------- */
  function weaponIcon(w, size) {
    if (!images) return '';
    const key = norm(w.name);
    const hit = images.weapons[key] || images.weapons[key.replace(/\s*\(.*\)$/, '')];
    if (!hit) return '';
    const wm = hit[1] ? `<img class="wm" src="${images.base}${esc(hit[1])}" alt="" loading="lazy">` : '';
    return `<span class="wicon" style="--s:${size}px"><img src="${images.base}${esc(hit[0])}" alt="" loading="lazy">${wm}</span>`;
  }
  function perkIcon(name) {
    if (!images || /^none$/i.test(name)) return '';
    const p = images.perks[norm(name)];
    return p ? `<img class="picon" src="${images.base}${esc(p)}" alt="" loading="lazy">` : '';
  }

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
    chipsEl.innerHTML =
      `<button data-bis class="bis ${bisOnly ? 'active' : ''}" title="Only weapons on the BiS lists">★ BiS</button>` +
      tabOrder.map(t =>
        `<button data-tab="${esc(t)}" class="${t === activeTab ? 'active' : ''}">${esc(t)}</button>`).join('');
  }
  const star = w => w.bis ? '<span class="star" title="On the BiS list">★</span>' : '';

  function hitRow(w) {
    const meta = [w.exotic ? 'Exotic' : w.tab, w.info.find(i => i.label === 'Frame')?.value, w.info.find(i => i.label === 'Energy')?.value]
      .filter(Boolean).join(' · ');
    return `<button class="hit" data-w="${esc(w.tab)}|${esc(w.name)}">
      ${weaponIcon(w, 38)}${tierBadge(w)}
      <span class="nm">${esc(w.name)}${star(w)}${w.variant ? `<small>${esc(w.variant)}</small>` : ''}</span>
      <span class="meta">${esc(meta)}</span>
    </button>`;
  }

  function card(w) {
    const infoBadges = w.info.map(i =>
      `<span class="badge${i.label === 'Energy' ? ' energy-' + esc(i.value) : ''}">${esc(i.label)} <b>${esc(i.value)}</b></span>`).join('');
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
        ${legend.length ? `<p class="legend">${legend.map(l => `<span><b class="${symCls(l.symbol)}">${esc(l.symbol)}</b> ${esc(l.meaning)}</span>`).join('')}</p>` : ''}`;
    } else {
      body = `<div class="perks">${w.perks.map(p => `
        <div class="perkcol"><h3>${esc(p.label)}</h3><ol>
          ${p.options.map(o => `<li>${perkIcon(o)}<span>${esc(o)}</span></li>`).join('')}
        </ol></div>`).join('')}</div>`;
    }
    const upd = updatedByTab[w.tab];
    return `<div class="card sel">
      <div class="head">
        ${weaponIcon(w, 58)}
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
      <button class="ac-row${i === acIndex ? ' active' : ''}" data-w="${esc(w.tab)}|${esc(w.name)}">
        ${weaponIcon(w, 30)}<span class="nm">${esc(w.name)}${star(w)}</span>
        <span class="meta">${esc(w.exotic ? 'Exotic' : w.tab)}</span>${tierBadge(w)}
      </button>`).join('');
  }
  function closeAC() { acItems = []; acIndex = -1; renderAC(); }

  function select(w, fromHash) {
    selected = w;
    closeAC();
    if (!fromHash) history.replaceState(null, '', '#w=' + encodeURIComponent(w.tab + '|' + w.name));
    render();
    window.scrollTo({ top: 0 });
  }
  function findByKey(key) {
    const [tab, name] = key.split('|');
    return weapons.find(w => w.tab === tab && w.name === name) || weapons.find(w => w.name === name);
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
    if (e.target.closest('[data-bis]')) {
      bisOnly = !bisOnly;
      selected = null;
      render();
    }
  });
  $('refreshBtn').addEventListener('click', () => { statusEl.classList.remove('err'); statusEl.textContent = 'Refreshing…'; boot(true); });
  window.addEventListener('hashchange', () => { applyHash(); render(); });

  setInterval(() => {
    if (chipEl.classList.contains('on')) {
      try { const c = JSON.parse(localStorage.getItem(CACHE_KEY)); if (c) chipState.textContent = agoLabel(c.ts); } catch {}
    }
  }, 60000);

  boot(false);
})();
