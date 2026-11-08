/* M7+ 地震マップ — app.js（依存: d3 v7, topojson-client v3, data/*.js） */
(() => {
  'use strict';

  const EMBEDDED = (() => { try { return window.self !== window.top; } catch { return true; } })();
  if (EMBEDDED) document.documentElement.classList.add('embedded');
  document.documentElement.lang = 'ja';
  const HOST_THEME = document.documentElement.dataset.theme || null;   // 埋め込み先が明示したライト/ダーク

  // ------------------------------------------------------------ data
  const QUAKES = (window.QUAKES || []).map((q, idx) => ({ ...q, idx }));
  const META = window.QUAKES_META || {};
  const PREFS = window.PREFS || [];
  const PREF = new Map(PREFS.map((p) => [p.c, p]));
  const NAME2CODE = new Map(PREFS.map((p) => [p.n, p.c]));
  const FC = window.FORECAST || null;
  const PLATES = window.PLATES || { lines: [], labels: [] };
  const PUBLIC_URL = 'https://chestnut8811-star.github.io/m7-jishin-map/';
  const YEAR_MIN = 599;
  const YEAR_MAX = 2026;
  const REGIONS = ['北海道', '東北', '関東', '中部', '近畿', '中国', '四国', '九州・沖縄'];
  const regionOf = (p) => (p.r === '中国' || p.r === '四国') ? p.r : p.r;

  // ------------------------------------------------------------ storage (per-viewer convenience only)
  const store = {
    get(k, d) { try { const v = localStorage.getItem('m7map.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('m7map.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };

  const state = {
    tab: 'map',
    fill: 'epi',
    minM: 7,
    minI: '',          // 最大震度の下限（'' すべて / A 5弱以上 / C 6弱以上 / D 6強以上 / 7）
    plates: true,
    yearTo: YEAR_MAX,
    period: 599,
    rankMetric: 'epi',
    listSort: 'new',
    listQuery: '',
    listPref: 0,
    palette: store.get('palette', 'blue'),
    mode: store.get('mode', 'auto'),
    myPref: store.get('myPref', 0),
    outlookPref: store.get('myPref', 0) || 22,
    selQuake: null,
    selPref: 0,
  };

  // ------------------------------------------------------------ helpers
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const prefName = (c) => (PREF.get(c) || {}).n || '';
  const prefShort = (c) => (PREF.get(c) || {}).s || '';
  const fmtM = (m) => 'M' + m.toFixed(1);
  const qTitle = (q) => q.n || q.a;
  const dateStr = (q) => `${q.y}年` + (q.mo ? `${q.mo}月` : '') + (q.d ? `${q.d}日` : '');
  const dateDot = (q) => String(q.y) + (q.mo ? '.' + String(q.mo).padStart(2, '0') : '') + (q.d ? '.' + String(q.d).padStart(2, '0') : '');
  const energyRatio = (m) => Math.pow(10, 1.5 * (m - 7));
  const influenceKm = (m) => 100 + 0.5 * Math.pow(10, 0.5 * m - 1.8);
  function fmtRatio(r) {
    if (r < 1.05) return '同じ';
    if (r < 10) return '約' + r.toFixed(1) + '倍';
    const p = Math.pow(10, Math.floor(Math.log10(r)) - 1);
    return '約' + (Math.round(r / p) * p).toLocaleString('ja-JP') + '倍';
  }
  const ERAS = [
    { from: 599, to: 1184, name: '古代', sub: '飛鳥〜平安' },
    { from: 1185, to: 1602, name: '中世', sub: '鎌倉〜安土桃山' },
    { from: 1603, to: 1867, name: '近世', sub: '江戸時代' },
    { from: 1868, to: 1945, name: '近代', sub: '明治〜昭和前期' },
    { from: 1946, to: 2026, name: '現代', sub: '戦後〜' },
  ];
  const eraOf = (y) => ERAS.find((e) => y >= e.from && y <= e.to) || ERAS[ERAS.length - 1];

  // 気象庁の震度階級（震度DBの記号 → 表示名, 色トークン, 文字色）
  const INT = {
    '1': ['震度1', '--i1', 'd'], '2': ['震度2', '--i2', 'd'], '3': ['震度3', '--i3', 'l'], '4': ['震度4', '--i4', 'd'],
    'A': ['震度5弱', '--i5m', 'd'], '5': ['震度5', '--i5m', 'd'], 'B': ['震度5強', '--i5p', 'd'], 'C': ['震度6弱', '--i6m', 'l'],
    '6': ['震度6', '--i6m', 'l'], 'D': ['震度6強', '--i6p', 'l'], '7': ['震度7', '--i7', 'l'],
  };
  const INT_ORDER = ['1', '2', '3', '4', 'A', '5', 'B', 'C', '6', 'D', '7'];
  const MAXI_CODE = { '1': '1', '2': '2', '3': '3', '4': '4', '5弱': 'A', '5': '5', '5強': 'B', '6弱': 'C', '6': '6', '6強': 'D', '7': '7' };
  function intBadge(code) {
    const it = INT[code];
    if (!it) return '';
    return `<span class="int-badge" style="background:var(${it[1]});color:${it[2] === 'l' ? '#fff' : '#1E1B3A'}">${it[0]}</span>`;
  }

  // ------------------------------------------------------------ colors (read from CSS tokens)
  let colors = {};
  function readColors() {
    colors = {
      sea: cssVar('--sea'), land0: cssVar('--land0'), ink: cssVar('--ink'), muted: cssVar('--muted'), surface: cssVar('--surface'),
      line: cssVar('--line'), surface2: cssVar('--surface-2'), dot: cssVar('--dot'),
      heat: ['--h1', '--h2', '--h3', '--h4', '--h5'].map(cssVar),      // 水色・青・黄・橙・赤
      mcls: ['--m1', '--m2', '--m3', '--m4'].map(cssVar),            // 黄・橙・赤・紫
      mon: ['--on-m1', '--on-m2', '--on-m3', '--on-m4'].map(cssVar),
      a1: cssVar('--a1'), a2: cssVar('--a2'), a3: cssVar('--a3'), a4: cssVar('--a4'), a5: cssVar('--a5'),
    };
  }
  const isDark = () => {
    const t = document.documentElement.dataset.theme;
    if (t === 'dark') return true;
    if (t === 'light') return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  };
  // マグニチュードの階級: 黄 7.0〜7.4／橙 7.5〜7.9／赤 8.0〜8.4／紫 8.5以上
  const M_LABELS = ['M7.0〜7.4', 'M7.5〜7.9', 'M8.0〜8.4', 'M8.5以上'];
  const mClass = (m) => (m >= 8.5 ? 3 : m >= 8 ? 2 : m >= 7.5 ? 1 : 0);
  const dotColor = (m) => colors.mcls[mClass(m)];
  const magStyle = (m) => `--mc:${colors.mcls[mClass(m)]};--mc-ink:${colors.mon[mClass(m)]}`;
  // 回数の段階色: 0 は塗らない。1以上を分位点で最大5段階（水色・青・黄・橙・赤）に分ける
  function makeHeat(values) {
    const nz = values.filter((v) => v > 0).sort(d3.ascending);
    const max = nz.length ? nz[nz.length - 1] : 0;
    const uppers = [];
    let prev = 0;
    for (const p of [0.2, 0.4, 0.6, 0.8]) {
      if (!nz.length) break;
      const v = Math.max(prev + 1, Math.round(d3.quantileSorted(nz, p)));
      if (v < max) { uppers.push(v); prev = v; }
    }
    const n = uppers.length + 1;
    const used = colors.heat.slice(5 - n);
    const cls = (v) => { const i = uppers.findIndex((u) => v <= u); return i < 0 ? uppers.length : i; };
    const labels = [];
    let lo = 1;
    for (const u of uppers) { labels.push(lo === u ? `${u}` : `${lo}〜${u}`); lo = u + 1; }
    labels.push(lo >= max ? `${max}` : `${lo}〜${max}`);
    return { color: (v) => (v > 0 ? used[cls(v)] : colors.land0), labels, used, max };
  }

  // ------------------------------------------------------------ filters / aggregation
  // 最大震度の絞り込み。旧震度階（1996年まで）の震度5は5弱以上に、震度6は6弱以上に含める（6強以上には含めない）
  const INT_FILTERS = [['', '震度：すべて'], ['A', '震度5弱以上'], ['C', '震度6弱以上'], ['D', '震度6強以上'], ['7', '震度7']];
  const intCode = (q) => (q.mi && MAXI_CODE[q.mi]) || null;
  const intIdx = (q) => (intCode(q) ? INT_ORDER.indexOf(intCode(q)) : -1);
  const passI = (q) => !state.minI || intIdx(q) >= INT_ORDER.indexOf(state.minI);
  const intLabel = () => (INT_FILTERS.find(([v]) => v === state.minI) || INT_FILTERS[0])[1];
  const mapList = () => QUAKES.filter((q) => q.m >= state.minM - 1e-9 && q.y <= state.yearTo && passI(q));
  const rankList = () => QUAKES.filter((q) => q.m >= state.minM - 1e-9 && q.y >= state.period && passI(q));
  function countBy(list, metric) {
    const c = new Map();
    for (const q of list) {
      if (metric === 'epi') c.set(q.p, (c.get(q.p) || 0) + 1);
      else for (const p of q.nr) c.set(p, (c.get(p) || 0) + 1);
    }
    return c;
  }
  function maxBy(list) {
    const best = new Map();
    for (const q of list) {
      const b = best.get(q.p);
      if (!b || q.m > b.m || (q.m === b.m && q.y > b.y)) best.set(q.p, q);
    }
    return best;
  }

  // ------------------------------------------------------------ theme
  const PALETTES = [
    { id: 'blue', name: 'ブルー', c: ['#1A5FE8', '#D91E2A', '#FFC400'] },
    { id: 'red', name: 'レッド', c: ['#D91E2A', '#1A5FE8', '#FFC400'] },
    { id: 'yellow', name: 'イエロー', c: ['#FFC400', '#D91E2A', '#1A5FE8'] },
    { id: 'green', name: 'グリーン', c: ['#0B7D3B', '#D91E2A', '#FFC400'] },
    { id: 'black', name: 'ブラック', c: ['#1C2333', '#D91E2A', '#FFC400'] },
  ];
  const OLD_PALETTE = { pop: 'blue', soda: 'green', sunset: 'red', ocean: 'blue', matcha: 'green' };
  function applyTheme() {
    const root = document.documentElement;
    if (!PALETTES.some((p) => p.id === state.palette)) state.palette = OLD_PALETTE[state.palette] || 'blue';
    root.dataset.palette = state.palette;
    if (state.mode !== 'auto') root.dataset.theme = state.mode;
    else if (HOST_THEME) root.dataset.theme = HOST_THEME;
    else delete root.dataset.theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    readColors();
    if (meta) meta.setAttribute('content', isDark() ? cssVar('--bg') : cssVar('--a1'));
  }

  // ------------------------------------------------------------ segmented controls
  function bindSegs() {
    document.querySelectorAll('.seg[data-bind]').forEach((seg) => {
      const key = seg.dataset.bind;
      seg.addEventListener('click', (ev) => {
        const b = ev.target.closest('button[data-val]');
        if (!b) return;
        const raw = b.dataset.val;
        const val = ['minM', 'period'].includes(key) ? Number(raw) : raw;
        if (state[key] === val) return;
        state[key] = val;
        if (key === 'mode') { store.set('mode', val); applyTheme(); renderAll(); }
        else renderAll();
      });
    });
  }
  function syncSegs() {
    document.querySelectorAll('.seg[data-bind]').forEach((seg) => {
      const v = String(state[seg.dataset.bind]);
      seg.querySelectorAll('button[data-val]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.val === v)));
    });
    document.querySelectorAll('select.int-select').forEach((sel) => {
      sel.value = state.minI;
      sel.closest('.chip-select')?.setAttribute('data-active', String(!!state.minI));
    });
  }
  function bindIntSelects() {
    document.querySelectorAll('select.int-select').forEach((sel) => {
      sel.innerHTML = INT_FILTERS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
      sel.addEventListener('change', () => { state.minI = sel.value; renderAll(); });
    });
  }

  // ------------------------------------------------------------ MAP
  const MAIN_BOX = [[128.6, 30.6], [146.4, 45.6]];
  const REGION_BOX = [
    ['全国', MAIN_BOX], ['北海道', [[139.3, 41.3], [149.0, 45.6]]], ['東北', [[139.2, 36.8], [142.3, 41.6]]],
    ['関東', [[138.3, 34.8], [141.0, 37.2]]], ['中部', [[135.9, 34.5], [139.9, 38.6]]], ['近畿', [[134.2, 33.4], [136.9, 35.8]]],
    ['中国・四国', [[130.8, 32.7], [134.8, 35.7]]], ['九州', [[128.6, 30.9], [132.2, 34.8]]],
    ['南西諸島', [[122.8, 24.0], [131.2, 29.0]]], ['伊豆・小笠原', [[138.6, 24.0], [143.2, 35.0]]],
  ];
  const map = { ready: false, k: 1, region: '全国' };

  function initMap() {
    const svg = d3.select('#mapSvg');
    map.svg = svg;
    const fc = topojson.feature(window.JAPAN_TOPO, window.JAPAN_TOPO.objects.pref);
    fc.features.forEach((f) => { f.properties.code = NAME2CODE.get(f.properties.N03_001); });
    map.features = fc.features;
    map.projection = d3.geoMercator();
    map.path = d3.geoPath(map.projection);
    map.g = svg.append('g').attr('class', 'zoomable');
    map.gPref = map.g.append('g');
    map.gPlate = map.g.append('g');
    map.gInfl = map.g.append('g');
    map.gLabel = map.g.append('g');
    map.gQuake = map.g.append('g');
    map.gPlateLabel = map.g.append('g').attr('class', 'plate-labels');
    map.gSel = map.g.append('g');

    map.zoom = d3.zoom().scaleExtent([0.7, 18]).on('zoom', (ev) => {
      map.g.attr('transform', ev.transform);
      if (Math.abs(ev.transform.k - map.k) > 1e-3) { map.k = ev.transform.k; scaleMarks(); }
      if (ev.sourceEvent) setRegionPressed(null);
    });
    svg.call(map.zoom).on('dblclick.zoom', null);
    svg.on('click', (ev) => {
      const [px, py] = d3.pointer(ev, map.g.node());
      const q = hitQuake(px, py);
      if (q) { openQuake(q, { fromMap: true }); return; }
      const pref = ev.target.closest ? ev.target.closest('path.pref') : null;
      if (pref) { openPref(d3.select(pref).datum().properties.code); return; }
      clearSelection();
    });

    $('#zoomIn').addEventListener('click', () => svg.transition().duration(300).call(map.zoom.scaleBy, 1.6));
    $('#zoomOut').addEventListener('click', () => svg.transition().duration(300).call(map.zoom.scaleBy, 1 / 1.6));
    $('#platesToggle').addEventListener('click', () => {
      state.plates = !state.plates;
      $('#platesToggle').setAttribute('aria-pressed', String(state.plates));
      drawPlates();
    });

    const row = $('#regionRow');
    row.insertAdjacentHTML('beforeend', REGION_BOX.map(([n]) => `<button type="button" data-region="${esc(n)}" aria-pressed="${n === '全国'}">${esc(n)}</button>`).join(''));
    row.addEventListener('click', (ev) => {
      const b = ev.target.closest('button[data-region]');
      if (b) zoomToRegion(b.dataset.region, true);
    });

    layoutMap();
    window.addEventListener('resize', debounce(() => { if (state.tab === 'map') layoutMap(); else map.needsLayout = true; }, 150));
    map.ready = true;
  }

  function layoutMap() {
    const stage = $('#mapStage');
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    if (!w || !h) return;
    map.w = w; map.h = h;
    map.svg.attr('viewBox', `0 0 ${w} ${h}`);
    const top = 112;
    const bottom = h - (64 + 10 + 128);
    const box = { type: 'MultiPoint', coordinates: MAIN_BOX };
    map.projection.fitExtent([[14, top], [w - 14, Math.max(top + 120, bottom)]], box);
    map.svg.call(map.zoom.transform, d3.zoomIdentity);
    map.k = 1;
    drawBase();
    updateMap(false);
    setRegionPressed('全国');
  }

  function drawBase() {
    map.gPref.selectAll('path').data(map.features, (d) => d.properties.code).join('path')
      .attr('class', 'pref').attr('d', map.path);
    // 県名ラベル（拡大時のみ）: 最大の陸地の重心
    map.labelPos = map.features.map((f) => {
      const g = f.geometry;
      let best = g;
      if (g.type === 'MultiPolygon') {
        let area = -1;
        for (const coords of g.coordinates) {
          const poly = { type: 'Polygon', coordinates: coords };
          const a = d3.geoArea(poly);
          if (a > area) { area = a; best = poly; }
        }
      }
      return { code: f.properties.code, xy: map.path.centroid(best) };
    });
    map.gLabel.selectAll('text').data(map.labelPos, (d) => d.code).join('text')
      .attr('class', 'pref-label').attr('x', (d) => d.xy[0]).attr('y', (d) => d.xy[1]).attr('dy', '0.35em')
      .text((d) => prefShort(d.code));
    drawPlates();
  }

  function drawPlates() {
    const lines = state.plates ? PLATES.lines : [];
    map.gPlate.selectAll('path').data(lines).join('path')
      .attr('class', (d) => 'plate' + (d.sub ? ' sub' : ''))
      .attr('d', (d) => map.path({ type: 'LineString', coordinates: d.c }));
    const labels = state.plates ? PLATES.labels : [];
    map.gPlateLabel.selectAll('text').data(labels, (d) => d.t).join('text')
      .attr('class', 'plate-label')
      .attr('x', (d) => map.projection([d.x, d.y])[0])
      .attr('y', (d) => map.projection([d.x, d.y])[1])
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'central')
      .attr('writing-mode', (d) => (d.v ? 'vertical-rl' : null))
      .style('text-orientation', (d) => (d.v ? 'upright' : null))
      .attr('transform', (d) => { const [x, y] = map.projection([d.x, d.y]); return d.r ? `rotate(${d.r},${x},${y})` : null; })
      .text((d) => d.t);
    scaleMarks();
  }

  const baseR = (m) => 2.4 + (m - 7) * 4.6;
  function scaleMarks() {
    const k = map.k;
    const f = Math.pow(k, -0.62);
    map.gQuake.selectAll('circle.q').attr('r', (d) => baseR(d.m) * f);
    map.gLabel.selectAll('text').style('font-size', `${10.5 / k}px`).style('stroke-width', `${3 / k}px`)
      .attr('opacity', k >= 2.2 ? 1 : 0);
    map.gPlateLabel.selectAll('text').style('font-size', `${11 / Math.pow(k, 0.85)}px`).style('stroke-width', `${3 / k}px`)
      .style('letter-spacing', `${0.06 / Math.pow(k, 0.15)}em`);
    if (state.selQuake) drawSelection(state.selQuake);
  }

  let prevVisible = new Set();
  function updateMap(animateNew) {
    if (!map.ready || !map.w) return;
    const list = mapList();
    const counts = countBy(list, state.fill);
    const heat = makeHeat([...counts.values()]);
    map.gPref.selectAll('path')
      .attr('fill', (d) => heat.color(counts.get(d.properties.code) || 0))
      .classed('is-sel', (d) => d.properties.code === state.selPref);

    const sorted = [...list].sort((a, b) => b.m - a.m);
    const dots = map.gQuake.selectAll('circle.q').data(sorted, (d) => d.idx).join('circle').attr('class', 'q');
    dots.order();
    dots.each((d) => { const [x, y] = map.projection([d.lo, d.la]); d.px = x; d.py = y; });
    dots.attr('cx', (d) => d.px).attr('cy', (d) => d.py).attr('fill', colors.dot)
      .classed('is-new', (d) => animateNew && !prevVisible.has(d.idx));
    map.visible = sorted;
    prevVisible = new Set(list.map((q) => q.idx));
    scaleMarks();
    $('#timeYear').textContent = state.yearTo;
    $('#timeCount').textContent = list.length;
    renderLegend(heat);
  }

  function renderLegend(heat) {
    const dots = [7, 8, 9].map((m) => {
      const r = baseR(m);
      const sz = Math.ceil(r * 2 + 3);
      return `<figure><svg width="${sz}" height="${sz}" viewBox="0 0 ${sz} ${sz}" aria-hidden="true"><circle cx="${sz / 2}" cy="${sz / 2}" r="${r}" fill="${colors.dot}" stroke="var(--dot-ring)" stroke-width="1.2"/></svg><figcaption>M${m}</figcaption></figure>`;
    }).join('');
    const label = state.fill === 'epi' ? '塗り＝震央の数' : '塗り＝影響圏の回数';
    const swatches = heat.labels.map((l, i) => `<span><i style="background:${heat.used[i]}"></i>${l}</span>`).join('');
    $('#mapLegend').innerHTML = `<div class="legend-dots"><span class="legend-key">円＝震央</span>${dots}</div>
      <div class="legend-key">${label}（回）</div>
      <div class="legend-heat">${heat.labels.length ? swatches : '<span>なし</span>'}</div>
      ${state.minI ? `<div class="legend-filter">${intLabel()}の地震だけ（震度の記録がある1919年以降）</div>` : ''}`;
  }

  function zoomToRegion(name, animate) {
    const entry = REGION_BOX.find(([n]) => n === name);
    if (!entry) return;
    const [[x0, y0], [x1, y1]] = entry[1].map((c) => map.projection(c));
    const bx0 = Math.min(x0, x1), bx1 = Math.max(x0, x1), by0 = Math.min(y0, y1), by1 = Math.max(y0, y1);
    const top = 104, bottom = map.h - 214;
    const availW = map.w - 28, availH = Math.max(120, bottom - top);
    const k = Math.min(18, Math.max(0.7, Math.min(availW / (bx1 - bx0), availH / (by1 - by0))));
    const cx = (bx0 + bx1) / 2, cy = (by0 + by1) / 2;
    const t = d3.zoomIdentity.translate(map.w / 2, top + availH / 2).scale(k).translate(-cx, -cy);
    (animate && !reducedMotion() ? map.svg.transition().duration(600) : map.svg).call(map.zoom.transform, t);
    setRegionPressed(name);
  }
  function setRegionPressed(name) {
    map.region = name;
    document.querySelectorAll('#regionRow button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.region === name)));
  }
  function zoomToQuake(q) {
    const [x, y] = map.projection([q.lo, q.la]);
    const k = Math.max(map.k, q.m >= 8.5 ? 2.2 : 3.2);
    const top = 104, bottom = map.h - 214;
    const t = d3.zoomIdentity.translate(map.w / 2, (top + bottom) / 2).scale(k).translate(-x, -y);
    (reducedMotion() ? map.svg : map.svg.transition().duration(650)).call(map.zoom.transform, t);
  }

  // 押した位置に最も「深く」入っている円を選ぶ（中心からの距離÷半径が最小のもの）
  function hitQuake(px, py) {
    const k = map.k;
    let best = null, bestScore = Infinity;
    for (const d of map.visible || []) {
      const r = baseR(d.m) * Math.pow(k, -0.62) * k;            // 画面上の半径(px)
      const dist = Math.hypot(d.px - px, d.py - py) * k;
      if (dist > r + 9) continue;
      const score = dist / Math.max(r, 5);
      if (score < bestScore) { bestScore = score; best = d; }
    }
    return best;
  }

  function drawSelection(q) {
    map.gInfl.selectAll('*').remove();
    map.gSel.selectAll('*').remove();
    if (!q) return;
    const circle = d3.geoCircle().center([q.lo, q.la]).radius(influenceKm(q.m) / 111.195).precision(2)();
    map.gInfl.append('path').attr('class', 'influence').attr('d', map.path(circle));
    const [x, y] = map.projection([q.lo, q.la]);
    const r = baseR(q.m) * Math.pow(map.k, -0.62);
    map.gSel.append('circle').attr('class', 'q-pulse').attr('cx', x).attr('cy', y).attr('r', r + 2 / map.k);
    map.gSel.append('circle').attr('class', 'q-sel').attr('cx', x).attr('cy', y).attr('r', r + 3 / map.k);
  }
  function clearSelection() {
    state.selQuake = null;
    state.selPref = 0;
    drawSelection(null);
    map.gPref && map.gPref.selectAll('path').classed('is-sel', false);
  }

  // time slider: 区分線形（古い時代を圧縮）
  const yearScale = d3.scaleLinear().domain([0, 180, 430, 640, 1000]).range([599, 1600, 1800, 1900, 2026]).clamp(true);
  function initTime() {
    const range = $('#timeRange');
    range.value = String(Math.round(yearScale.invert(state.yearTo)));
    const scaleEl = document.querySelector('.time-scale');
    scaleEl.innerHTML = '';
    scaleEl.style.position = 'relative';
    scaleEl.style.height = '14px';
    [599, 1600, 1800, 1900, 2026].forEach((y, i, arr) => {
      const s = document.createElement('span');
      s.textContent = y;
      s.style.position = 'absolute';
      const pct = yearScale.invert(y) / 10;
      s.style.left = pct + '%';
      s.style.transform = i === 0 ? 'none' : i === arr.length - 1 ? 'translateX(-100%)' : 'translateX(-50%)';
      scaleEl.appendChild(s);
    });
    range.addEventListener('input', () => {
      stopPlay();
      state.yearTo = Math.round(yearScale(Number(range.value)));
      updateMap(true);
    });
    $('#playBtn').addEventListener('click', () => (playing ? stopPlay() : startPlay()));
  }
  let playing = false, raf = 0;
  function startPlay() {
    playing = true;
    $('#playBtn').classList.add('is-playing');
    $('#playBtn').setAttribute('aria-label', '再生を止める');
    const range = $('#timeRange');
    let pos = Number(range.value);
    if (pos >= 1000) pos = 0;
    let last = performance.now();
    const step = (now) => {
      if (!playing) return;
      const dt = now - last; last = now;
      pos = Math.min(1000, pos + dt * 0.085);
      range.value = String(pos);
      const y = Math.round(yearScale(pos));
      if (y !== state.yearTo) { state.yearTo = y; updateMap(true); }
      if (pos >= 1000) { stopPlay(); return; }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }
  function stopPlay() {
    playing = false;
    cancelAnimationFrame(raf);
    $('#playBtn').classList.remove('is-playing');
    $('#playBtn').setAttribute('aria-label', '年代を再生');
  }

  // ------------------------------------------------------------ RANKING
  function rankRows() {
    const list = rankList();
    if (state.rankMetric === 'maxm') {
      const best = maxBy(list);
      return PREFS.map((p) => ({ c: p.c, v: best.get(p.c)?.m || 0, q: best.get(p.c) || null }));
    }
    const counts = countBy(list, state.rankMetric);
    return PREFS.map((p) => ({ c: p.c, v: counts.get(p.c) || 0 }));
  }
  function withRanks(rows) {
    rows.sort((a, b) => b.v - a.v || (b.q && a.q ? b.q.y - a.q.y : 0) || a.c - b.c);
    let rank = 0, prev = null;
    rows.forEach((r, i) => { if (r.v !== prev) { rank = i + 1; prev = r.v; } r.rank = r.v ? rank : null; });
    return rows;
  }
  function renderRanking() {
    const rows = withRanks(rankRows());
    const metric = state.rankMetric;
    const periodTxt = state.period === 599 ? '全期間（599年〜）' : `${state.period}年〜2026年`;
    const mTxt = `M${state.minM.toFixed(1)}以上`;
    const metricTxt = { epi: '震央の数', near: '影響圏に入った回数', maxm: '震央で起きた最大の地震' }[metric];
    $('#rankLead').textContent = `${periodTxt}・${mTxt}${state.minI ? '・' + intLabel() : ''}・${metricTxt}`;
    const unit = metric === 'maxm' ? '' : '回';
    const valTxt = (r) => (metric === 'maxm' ? (r.v ? fmtM(r.v) : '—') : String(r.v));
    const top = rows.slice(0, 3);
    const order = [1, 0, 2].map((i) => top[i]).filter(Boolean);
    const podColors = [['var(--p-mid)', 'var(--on-p-mid)', 118], ['var(--p-high)', 'var(--on-p-high)', 150], ['var(--p-low)', 'var(--on-p-low)', 96]];
    $('#podium').innerHTML = order.map((r) => {
      const place = top.indexOf(r);
      const [bg, on, h] = podColors[[1, 0, 2].indexOf(place)];
      const sub = metric === 'maxm' && r.q ? esc(qTitle(r.q)) : `${r.v}${unit}`;
      return `<div class="podium-col"><button type="button" data-pref="${r.c}">
        <span class="podium-name">${esc(prefName(r.c))}</span>
        <span class="podium-val">${metric === 'maxm' ? fmtM(r.v) + '・' + sub : sub}</span>
        <span class="podium-block" style="height:${h}px;background:${bg};--on:${on}"><span>${r.rank ?? '–'}</span></span>
      </button></div>`;
    }).join('');
    const vmax = Math.max(...rows.map((r) => r.v), 1);
    const vmin = metric === 'maxm' ? 6.8 : 0;
    const heat = makeHeat(rows.map((r) => r.v));
    const barColor = (r) => (metric === 'maxm' ? dotColor(r.v) : heat.color(r.v));
    $('#rankList').innerHTML = rows.slice(3).map((r) => {
      const w = r.v ? Math.max(2, ((r.v - vmin) / (vmax - vmin)) * 100) : 0;
      return `<li><button type="button" class="rank-row${r.v ? '' : ' is-zero'}${r.c === state.myPref ? ' is-mine' : ''}" data-pref="${r.c}">
        <span class="rank-no">${r.rank ?? '–'}</span>
        <span class="rank-name">${esc(prefName(r.c))}</span>
        <span class="rank-bar"><i style="width:${w}%;--bc:${barColor(r)}"></i></span>
        <span class="rank-val">${valTxt(r)}${r.v && unit ? `<small>${unit}</small>` : ''}</span>
      </button></li>`;
    }).join('');
    const notes = {
      epi: '震央がある都道府県（海の地震はいちばん近い陸地の都道府県）に1回と数えます。',
      near: '1919年以降は震度5弱以上（1996年までの旧震度階では震度5以上）を観測した都道府県、1918年以前は震央からの距離（100km＋推定した断層の長さの半分）で推定した都道府県に、それぞれ1回と数えます。',
      maxm: '震央がその都道府県（海の地震はいちばん近い陸地の都道府県）にある地震のうち、最も大きいもの。',
    };
    $('#rankNote').textContent = notes[metric] + (state.minI ? ' 最大震度で絞り込むと、震度の記録がある1919年以降の地震だけになります。' : (state.period < 1868 ? ' 古い時代は記録の残り方に地域差があります。' : ''));
  }

  // ------------------------------------------------------------ OUTLOOK
  // 30年確率のランクの色札: 高い＝赤／やや高い＝黄／Ⅰ・Zランク＝青／不明・ランクなし＝灰（必ず文言を添える）
  const CLS_KEYS = ['high', 'mid', 'low', 'unk', 'na'];
  const clsVars = (c) => { const k = CLS_KEYS.includes(c) ? c : 'unk'; return `--pc:var(--p-${k});--pc-on:var(--on-p-${k})`; };
  function probPill(src) {
    if (!src) return '';
    return `<span class="prob-pill" style="${clsVars(src.cls)}">${esc(src.p30 || '—')}<small>${esc(src.tag || '')}</small></span>`;
  }
  function renderOutlookPicker() {
    const cur = PREF.get(state.outlookPref);
    const region = cur ? cur.r : '中部';
    const regions = ['北海道', '東北', '関東', '中部', '近畿', '中国', '四国', '九州・沖縄'];
    const sel = state.outlookRegion || region;
    const chips = PREFS.filter((p) => p.r === sel).map((p) =>
      `<button type="button" data-pref="${p.c}" aria-pressed="${p.c === state.outlookPref}">${esc(p.s)}${p.c === state.myPref ? '<span class="star" aria-label="わたしの県">★</span>' : ''}</button>`).join('');
    $('#prefPicker').innerHTML = `
      <div class="region-tabs" role="toolbar" aria-label="地方">${regions.map((r) => `<button type="button" data-region="${r}" aria-pressed="${r === sel}">${r}</button>`).join('')}</div>
      <div class="pref-chips">${chips}</div>`;
  }
  // 記録の統計: 1919年以降、震度5弱以上になったM7以上。30日以内に続いたものは一連の地震として1回に数える
  function recordStats(code) {
    const list = QUAKES.filter((q) => q.nr.includes(code));
    const modern = list.filter((q) => q.y >= 1919).sort((a, b) => a.idx - b.idx);
    let seq = 0, prev = null;
    for (const q of modern) {
      const t = Date.UTC(q.y, (q.mo || 1) - 1, q.d || 1);
      if (prev === null || (t - prev) / 864e5 > 30) seq += 1;
      prev = t;
    }
    const years = (YEAR_MAX + (10 / 12)) - 1919; // 1919/01〜2026/11
    const rate = seq / years;
    const last = list.length ? list.reduce((a, b) => (b.idx > a.idx ? b : a)) : null;
    return {
      nAll: list.length, n1919: modern.length, seq, rate,
      mean: rate > 0 ? 1 / rate : null,
      p50: rate > 0 ? Math.LN2 / rate : null,
      p90: rate > 0 ? Math.LN10 / rate : null,
      last,
    };
  }
  const yrs = (v) => (v == null ? '—' : v < 1 ? '1年未満' : v < 10 ? `${v.toFixed(1)}年` : `${Math.round(v)}年`);
  // 評価名に想定Mが含まれていなければ添える（例: 南海トラフの地震（M8〜9クラス）は名前に含む）
  const srcTitle = (s) => (s.mag && !s.name.includes(s.mag.replace(/^M/, '')) ? `${s.name}・${s.mag}` : s.name);
  const leftText = (t) => String(t || '').replace(/（[^（）]*ランク[^（）]*）$/, '');
  function nextBlock(n, kind) {
    if (!n) return '';
    const src = FC.sources[n.src];
    const label = kind === 'b' ? '南海トラフの巨大地震（推進地域に含まれる）' : '県内・近海のM7以上の目安';
    return `<div class="${kind === 'b' ? 'next-sub' : 'next-main'}" style="${clsVars(src?.cls)}">
        <p class="next-label">${label}</p>
        ${src ? `<p class="next-src">${esc(srcTitle(src))}<span>${esc(src.tag)}</span></p>` : ''}
        <p class="next-when">${esc(n.when)}<small>${esc(leftText(n.left))}</small></p>
        <details class="next-basis"><summary>根拠を見る</summary><p>${esc(n.basis)}</p>${src && src.alt ? `<p>${esc(src.alt)}</p>` : ''}</details>
      </div>`;
  }
  function renderOutlookDetail() {
    const code = state.outlookPref;
    const p = PREF.get(code);
    if (!p) { $('#outlookDetail').innerHTML = ''; return; }
    const fc = FC && FC.prefs ? FC.prefs[code] : null;
    const st = recordStats(code);
    const all = (fc?.all || []).map((id) => [id, FC.sources[id]]).filter(([, s]) => s);
    const shown = all.slice(0, state.outlookAll ? all.length : 6);
    const regional = (fc?.c || []).map((id) => FC.sources[id]).filter(Boolean);
    const lastTxt = st.last ? `${st.last.y}年 ${esc(qTitle(st.last))}（${fmtM(st.last.m)}）` : '記録なし';
    const heroCls = fc?.a ? FC.sources[fc.a.src]?.cls : 'unk';
    const srcRow = (s) => `<div class="src-row"><span class="src-name">${esc(s.name)}</span>${probPill(s)}
          <span class="src-meta">${esc(s.meta)}${s.alt ? `<br>${esc(s.alt)}` : ''}</span></div>`;
    $('#outlookDetail').innerHTML = `
    <article class="outlook-card">
      <div class="outlook-hero" style="--hero:var(--p-${CLS_KEYS.includes(heroCls) ? heroCls : 'unk'})">
        <div class="outlook-title"><h3>${esc(p.n)}</h3>
          <button type="button" class="mine-btn" data-mine="${code}" aria-pressed="${state.myPref === code}">${state.myPref === code ? '★ わたしの県' : '☆ わたしの県にする'}</button></div>
        ${fc?.a ? nextBlock(fc.a, 'a') : '<p class="note">この都道府県に関係するM7以上の長期評価は見つかりませんでした。</p>'}
        ${fc?.b ? nextBlock(fc.b, 'b') : ''}
        <p class="note">確率は地震本部の${esc(FC?.asOf || '')}の値。予知ではありません。</p>
      </div>
      ${regional.length ? `<section class="outlook-sec">
        <h4>地域評価（M6.8以上の地震が30年以内に起きる確率）</h4>
        ${regional.map(srcRow).join('')}
      </section>` : ''}
      <section class="outlook-sec">
        <h4>関係する長期評価（30年以内の確率が高い順）</h4>
        ${shown.length ? shown.map(([, s]) => srcRow(s)).join('') : '<p class="note">見つかりませんでした。</p>'}
        ${all.length > 6 ? `<button type="button" class="btn-soft" data-allsrc="1">${state.outlookAll ? '主なものだけ表示' : `ほか${all.length - 6}件の評価も見る`}</button>` : ''}
        ${(fc?.notes || []).map((t) => `<p class="note">${esc(t)}</p>`).join('')}
        ${fc?.jshis ? `<p class="note">参考：${esc(fc.jshis)}</p>` : ''}
      </section>
      <section class="outlook-sec">
        <h4>このアプリの記録から（参考）</h4>
        <div class="stat-grid">
          <div class="stat"><b>${st.n1919}<small style="font-size:12px">回</small></b><span>1919年以降、震度5弱以上になったM7以上</span></div>
          <div class="stat"><b>${st.mean ? yrs(st.mean) : '—'}</b><span>一連の地震（${st.seq}回）を1回として、平均何年に1回か</span></div>
          <div class="stat"><b>${st.p50 != null ? `${yrs(st.p50)}〜${yrs(st.p90)}` : '—'}</b><span>同じ頻度が続くとして、次の1回が50%〜90%に達する年数</span></div>
          <div class="stat"><b>${st.nAll}<small style="font-size:12px">回</small></b><span>全期間（599年〜）の記録</span></div>
        </div>
        <p class="note">直近：${lastTxt}${st.last ? `、${YEAR_MAX - st.last.y}年前` : ''}。記録の頻度は公的な評価ではなく、30日以内に続いた地震は一連のものとして1回に数えています。</p>
      </section>
    </article>`;
  }
  function renderOutlookList() {
    if (!FC || !FC.prefs) { $('#outlookList').innerHTML = '<li class="empty">長期評価のデータを読み込めませんでした。</li>'; return; }
    let html = '';
    let region = '';
    for (const p of PREFS) {
      const fc = FC.prefs[p.c];
      const a = fc?.a, b = fc?.b;
      const sa = a ? FC.sources[a.src] : null;
      const sb = b ? FC.sources[b.src] : null;
      if (p.r !== region) { region = p.r; html += `<li class="ol-region">${esc(region)}</li>`; }
      html += `<li><button type="button" class="outlook-row" data-pref="${p.c}" style="${clsVars(sa?.cls)}">
        <span class="o-name">${esc(p.s)}${p.c === state.myPref ? ' <span class="o-star" aria-label="わたしの県">★</span>' : ''}</span>
        <span class="o-body">
          <span class="o-when">${esc(a ? a.when : '—')}</span>
          <span class="o-src">${esc(sa ? srcTitle(sa) : '関係する評価なし')}${sa ? ` <b>${esc(sa.p30)}</b>` : ''}</span>
          ${b && sb ? `<span class="o-src o-src2" style="${clsVars(sb.cls)}">南海トラフ（推進地域）<b>${esc(sb.p30)}</b> ${esc(b.when)}</span>` : ''}
        </span></button></li>`;
    }
    $('#outlookList').innerHTML = html;
  }
  function renderOutlook() { renderOutlookPicker(); renderOutlookDetail(); renderOutlookList(); }

  // ------------------------------------------------------------ LIST (年表)
  function renderTimeline() {
    const svg = d3.select('#tlChart');
    const node = svg.node();
    const w = node.clientWidth || 340;
    const h = 210;
    svg.attr('viewBox', `0 0 ${w} ${h}`);
    svg.selectAll('*').remove();
    const m = { l: 30, r: 10, t: 22, b: 22 };
    const xr = (t) => m.l + t * (w - m.l - m.r);
    const x = d3.scaleLinear().domain([599, 1600, 1800, 1900, 2026]).range([0, 0.18, 0.43, 0.64, 1].map(xr));
    const y = d3.scaleLinear().domain([6.9, 9.2]).range([h - m.b, m.t]);
    const bands = svg.append('g');
    ERAS.forEach((e, i) => {
      const x0 = x(e.from), x1 = x(Math.min(e.to + 1, 2026));
      if (i % 2 === 0) {
        bands.append('rect').attr('x', x0).attr('y', m.t - 14).attr('width', Math.max(0, x1 - x0)).attr('height', h - m.b - m.t + 14)
          .attr('fill', colors.surface2).attr('rx', 6);
      }
      bands.append('text').attr('class', 'era-label').attr('x', (x0 + x1) / 2).attr('y', m.t - 4).attr('text-anchor', 'middle').text(e.name);
    });
    svg.append('g').attr('class', 'grid').selectAll('line').data([7, 8, 9]).join('line')
      .attr('x1', m.l).attr('x2', w - m.r).attr('y1', y).attr('y2', y);
    svg.append('g').attr('class', 'axis').attr('transform', `translate(0,${h - m.b})`)
      .call(d3.axisBottom(x).tickValues([600, 1600, 1700, 1800, 1900, 1950, 2000]).tickFormat(d3.format('d')).tickSizeOuter(0))
      .call((g) => g.selectAll('.tick text').attr('dy', '1em'));
    svg.append('g').attr('class', 'axis').attr('transform', `translate(${m.l},0)`)
      .call(d3.axisLeft(y).tickValues([7, 7.5, 8, 8.5, 9]).tickFormat((v) => 'M' + v).tickSize(0))
      .call((g) => g.select('.domain').remove());
    const pts = QUAKES.filter(passI).sort((a, b) => a.m - b.m);
    svg.append('g').selectAll('circle').data(pts).join('circle')
      .attr('class', 'dot').attr('cx', (q) => x(q.y)).attr('cy', (q) => y(q.m)).attr('r', (q) => 2.6 + (q.m - 7) * 1.6)
      .attr('fill', (q) => dotColor(q.m))
      .on('click', (ev, q) => openQuake(q))
      .append('title').text((q) => `${dateStr(q)} ${qTitle(q)} ${fmtM(q.m)}`);
  }
  function renderList() {
    const qtxt = state.listQuery.trim();
    let list = QUAKES.filter((q) => {
      if (!passI(q)) return false;
      if (state.listPref && !(q.p === state.listPref || q.nr.includes(state.listPref))) return false;
      if (!qtxt) return true;
      const hay = `${q.n} ${q.a} ${q.e} ${prefName(q.p)} ${q.y}`;
      return hay.includes(qtxt);
    });
    if (state.listSort === 'new') list.sort((a, b) => b.idx - a.idx);
    else if (state.listSort === 'old') list.sort((a, b) => a.idx - b.idx);
    else if (state.listSort === 'big') list.sort((a, b) => b.m - a.m || b.idx - a.idx);
    else list.sort((a, b) => intIdx(b) - intIdx(a) || b.m - a.m || b.idx - a.idx);   // 震度順（記録なしは最後）
    $('#listLead').textContent = `${QUAKES.length}件のうち${list.length}件を表示。` +
      (state.minI ? `${intLabel()}で絞り込み中（震度の記録がある1919年以降の地震だけ）。` : '円をタップすると詳しく見られます。');
    if (!list.length) { $('#quakeList').innerHTML = '<p class="empty">条件に合う地震はありません。検索語・都道府県・最大震度を変えてください。</p>'; return; }
    let html = '';
    let curEra = null;
    let curInt;
    const intHead = (code) => (code ? INT[code][0] + (code === '5' || code === '6' ? '（1996年までの旧震度階）' : '') : '震度の記録なし（1918年以前など）');
    for (const q of list) {
      if (state.listSort === 'int') {
        const code = intCode(q);
        if (code !== curInt) {
          curInt = code;
          const n = list.filter((x) => intCode(x) === code).length;
          html += `<div class="era-head">${intHead(code)}<span>${n}件</span></div>`;
        }
      } else if (state.listSort !== 'big') {
        const era = eraOf(q.y);
        if (era !== curEra) {
          curEra = era;
          const n = list.filter((x) => eraOf(x.y) === era).length;
          html += `<div class="era-head">${era.name}<span>${era.sub}・${n}件</span></div>`;
        }
      }
      const tags = [];
      if (q.mi && MAXI_CODE[q.mi]) tags.push(`<span class="tag tag-i" style="background:var(${INT[MAXI_CODE[q.mi]][1]});color:${INT[MAXI_CODE[q.mi]][2] === 'l' ? '#fff' : '#1E1B3A'}">${INT[MAXI_CODE[q.mi]][0]}</span>`);
      if (q.ts) tags.push('<span class="tag">津波</span>');
      html += `<button type="button" class="q-row" data-q="${q.idx}">
        <span class="q-mag" style="${magStyle(q.m)}">${q.m.toFixed(1)}</span>
        <span class="q-main"><span class="q-name">${esc(qTitle(q))}</span>
        <span class="q-sub">${dateDot(q)}・${esc(prefName(q.p))}${q.n ? '・' + esc(q.a) : ''}</span></span>
        <span class="q-tags">${tags.join('')}</span></button>`;
    }
    $('#quakeList').innerHTML = html;
  }
  function initList() {
    const sel = $('#listPref');
    sel.innerHTML = '<option value="0">すべての都道府県</option>' + PREFS.map((p) => `<option value="${p.c}">${esc(p.n)}</option>`).join('');
    sel.addEventListener('change', () => { state.listPref = Number(sel.value); renderList(); });
    $('#listSearch').addEventListener('input', debounce((ev) => { state.listQuery = ev.target.value; renderList(); }, 120));
    $('#quakeList').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-q]');
      if (b) openQuake(QUAKES[Number(b.dataset.q)]);
    });
  }

  // ------------------------------------------------------------ INFO
  function renderInfo() {
    $('#paletteGrid').innerHTML = PALETTES.map((p) => `<button type="button" class="swatch" role="radio" data-palette="${p.id}" aria-checked="${p.id === state.palette}">
      <i style="background:conic-gradient(${p.c[0]} 0 50%, ${p.c[1]} 50% 80%, ${p.c[2]} 80%)"></i>${p.name}</button>`).join('');
    const utsu = QUAKES.filter((q) => q.s === 'u').length;
    const jma = QUAKES.length - utsu;
    const big = QUAKES.filter((q) => q.m >= 8).length;
    const first = QUAKES[0];
    const last = QUAKES[QUAKES.length - 1];
    $('#dataFacts').innerHTML = [
      [QUAKES.length + '件', 'M7以上の地震'],
      [first ? first.y + '年' : '—', 'いちばん古い記録（' + esc(first ? qTitle(first).replace(/\(.*\)/, '') : '') + '）'],
      [utsu + '件', '599〜1918年（宇津カタログ）'],
      [jma + '件', '1919年〜（気象庁）'],
      [big + '件', 'M8以上'],
      [last ? dateDot(last) : '—', 'いちばん新しい記録'],
    ].map(([v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join('');
    const src = [
      ['宇津徳治「世界の被害地震の表」', '599〜1918年の地震（建築研究所 国際地震工学センター公開版）。西暦の日付は同表の表記（1582年以前はユリウス暦）。', 'https://iisee.kenken.go.jp/utsu/'],
      ['気象庁 震度データベース', '1919年1月〜' + (META.jma_until || '2026-11-06') + 'の震源・マグニチュード・各地の震度。', 'https://www.data.jma.go.jp/eqdb/data/shindo/'],
      ['気象庁「気象庁が名称を定めた現象の一覧」', '1960年以降の地震の名称。', 'https://www.jma.go.jp/jma/kishou/know/meishou/meishou_ichiran.html'],
      ['気象庁「明治以降1995年までに、我が国で100人以上の死者・行方不明者を出した地震・津波」', '地震の名称と死者・行方不明者数（1995年まで）。', 'https://www.data.jma.go.jp/eqev/data/higai/higai-1995.html'],
      ['気象庁「平成8年以降の期間に日本付近で発生した、人的被害を伴った地震」', '地震の名称と死者・行方不明者数（1996年以降）。', 'https://www.data.jma.go.jp/eqev/data/higai/higai1996-new.html'],
      ['地震調査研究推進本部 長期評価', '海溝型地震・活断層・地域評価の発生確率。' + (FC && FC.asOf ? FC.asOf : ''), 'https://www.jishin.go.jp/evaluation/long_term_evaluation/'],
      ...(FC && FC.extraSources ? FC.extraSources.map((s) => [s.title, s.note || '', s.url]) : []),
      ['国土数値情報（行政区域データ）国土交通省', 'スマートニュース メディア研究所が簡略化したデータをさらに加工して都道府県の境界に使用。', 'https://nlftp.mlit.go.jp/ksj/'],
      ['Bird (2003) PB2002 プレート境界モデル', 'fraxen/tectonicplates（Hugo Ahlenius, Nordpil and Peter Bird, ODC-By 1.0）。', 'https://github.com/fraxen/tectonicplates'],
    ];
    $('#sourceList').innerHTML = src.map(([t, d, u]) => `<li><b>${esc(t)}</b><br>${esc(d)}<br><a href="${esc(u)}" target="_blank" rel="noopener">${esc(u.replace(/^https?:\/\//, ''))}</a></li>`).join('');
    $('#versionText').textContent = `データの締め日：${META.jma_until || '2026-11-06'}（気象庁 震度データベースの収録日まで）／作成：${META.generated || ''}`;
    updateInstallUI();
  }

  // ------------------------------------------------------------ SHEET
  const sheet = $('#sheet');
  const backdrop = $('#sheetBackdrop');
  let lastFocus = null;
  function openSheet(html, label) {
    lastFocus = document.activeElement;
    $('#sheetBody').innerHTML = html;
    sheet.setAttribute('aria-label', label || '詳細');
    sheet.hidden = false;
    backdrop.hidden = false;
    $('#sheetBody').scrollTop = 0;
    sheet.style.transform = '';
    $('#sheetClose').focus({ preventScroll: true });
  }
  function closeSheet() {
    if (sheet.hidden) return;
    sheet.hidden = true;
    backdrop.hidden = true;
    if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
    if (state.tab === 'map') clearSelection();
  }
  $('#sheetClose').addEventListener('click', closeSheet);
  backdrop.addEventListener('click', closeSheet);
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { if (!$('#installModal').hidden) closeInstall(); else closeSheet(); }
  });
  (() => { // 下にスワイプで閉じる
    const grip = $('#sheetGrip');
    let y0 = null, dy = 0;
    grip.addEventListener('pointerdown', (e) => { y0 = e.clientY; dy = 0; grip.setPointerCapture(e.pointerId); });
    grip.addEventListener('pointermove', (e) => { if (y0 == null) return; dy = Math.max(0, e.clientY - y0); sheet.style.transform = `translateY(${dy}px)`; });
    const end = () => { if (y0 == null) return; y0 = null; if (dy > 90) closeSheet(); else sheet.style.transform = ''; };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  })();

  function openQuake(q, opts = {}) {
    if (!q) return;
    state.selQuake = q;
    if (state.tab === 'map' && map.ready) drawSelection(q);
    const era = eraOf(q.y);
    const kick = [
      `<span class="tag">${q.s === 'u' ? '宇津カタログ' : '気象庁'}</span>`,
      `<span class="tag">${era.name}・${era.sub}</span>`,
      q.ts ? `<span class="tag">${esc(q.ts)}</span>` : '',
    ].join('');
    const eraTxt = q.e ? (q.s === 'u' ? `（${esc(q.e)}・旧暦）` : `（${esc(q.e)}）`) : '';
    const ratio = energyRatio(q.m);
    const depth = q.dp != null ? (q.dp === 0 && q.s === 'j' ? '0 km<small style="display:block;font-size:11px;font-weight:700;color:var(--muted)">気象庁データベースの表記どおり</small>' : `${q.dp} km`) : q.dl ? esc(q.dl) : '不明';
    const kv = [
      ['震源の深さ', depth],
      ['最大震度', q.mi ? (MAXI_CODE[q.mi] ? intBadge(MAXI_CODE[q.mi]) : esc(q.mi)) : (q.s === 'u' ? '記録なし' : '—')],
      ['死者', q.dd ? esc(q.dd) : (q.s === 'u' ? '記載なし' : '出典の一覧に記載なし')],
      ['被害の程度', q.dm ? esc(q.dm) : '—'],
    ];
    const near = q.nr.filter((c) => c !== q.p);   // 震央県以外の影響圏
    const pi = q.pi ? Object.entries(q.pi).map(([c, ch]) => ({ c: Number(c), ch })).sort((a, b) => INT_ORDER.indexOf(b.ch) - INT_ORDER.indexOf(a.ch) || a.c - b.c) : [];
    const strong = pi.filter((r) => INT_ORDER.indexOf(r.ch) >= INT_ORDER.indexOf('4'));
    const piHtml = pi.length ? `<section class="sheet-sec"><h4>各地の最大震度（震度4以上の都道府県）</h4>
      <div class="int-list">${(strong.length ? strong : pi.slice(0, 5)).map((r) => {
        const w = (INT_ORDER.indexOf(r.ch) + 1) / INT_ORDER.length * 100;
        return `<div class="int-row"><span>${esc(prefName(r.c))}</span><span class="bar" style="width:${w}%;background:var(${INT[r.ch][1]})"></span>${intBadge(r.ch)}</div>`;
      }).join('')}</div>
      <p class="sheet-note">震度を観測した都道府県 ${pi.length}。観測点の数は年代によって大きく異なります。</p></section>` : '';
    openSheet(`
      <div class="eq-head">
        <div class="eq-kicker">${kick}</div>
        <h2 class="eq-title" id="sheetTitle">${esc(qTitle(q))}</h2>
        <p class="eq-date">${dateStr(q)}${q.t ? ' ' + esc(q.t) : ''}${eraTxt}${q.n ? '　' + esc(q.a) : ''}</p>
        ${q.rm && q.rm !== q.a ? `<p class="eq-remark">宇津カタログの摘要：${esc(q.rm)}</p>` : ''}
      </div>
      <div class="eq-mag-row">
        <div class="eq-mag" style="${magStyle(q.m)}"><span>マグニチュード</span><b>${q.m.toFixed(1)}</b></div>
        <p class="eq-energy">地震のエネルギーは<b>${ratio < 1.05 ? 'M7.0と同じ' : 'M7.0の' + fmtRatio(ratio)}</b>${q.s === 'u' ? '史料の被害の広がりから推定したMで、計器で観測した値より不確かです。' : (q.y === 2011 && q.m === 9 ? 'M9.0はモーメントマグニチュード（気象庁）。' : 'Mは気象庁マグニチュード。')}${q.s === 'j' && q.y >= 2025 ? '最近の地震の値は、後日改訂されることがあります。' : ''}</p>
      </div>
      <dl class="kv">${kv.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
      <section class="sheet-sec"><h4>都道府県</h4>
        <div class="chips"><button type="button" class="chip is-epi" data-pref="${q.p}">震央 ${esc(prefName(q.p))}${q.ld ? '' : '（沖合）'}</button>
        ${near.map((c) => `<button type="button" class="chip" data-pref="${c}">${esc(prefShort(c))}</button>`).join('')}</div>
        <p class="sheet-note">震央は、震央がある（海の地震はいちばん近い陸地の）都道府県です${q.ld ? '' : `（いちばん近い陸地まで約${Math.round(q.ds)}km。気象庁の震央地名と県が異なることがあります）`}。ほかのチップは影響圏で、${q.s === 'j' ? '震度5弱以上（1996年までの旧震度階では震度5以上）を観測した都道府県です' : `震央から約${Math.round(influenceKm(q.m))}km以内に陸地がある都道府県として推定しています`}${q.nr.length ? '' : '（該当なし）'}。</p>
      </section>
      ${piHtml}
      <div class="btn-row">${opts.fromMap ? '' : `<button type="button" class="btn-accent" data-showmap="${q.idx}">地図で見る</button>`}</div>`, qTitle(q));
  }

  function prefSummary(code) {
    const all = QUAKES.filter((q) => q.m >= state.minM - 1e-9 && passI(q));
    const epi = all.filter((q) => q.p === code);
    const near = all.filter((q) => q.nr.includes(code));
    const rankOf = (metric) => {
      const rows = withRanks(PREFS.map((p) => ({ c: p.c, v: countBy(all, metric).get(p.c) || 0 })));
      return rows.find((r) => r.c === code)?.rank;
    };
    const biggest = epi.reduce((a, b) => (!a || b.m > a.m ? b : a), null);
    return { epi, near, rEpi: rankOf('epi'), rNear: rankOf('near'), biggest };
  }
  function openPref(code) {
    const p = PREF.get(code);
    if (!p) return;
    state.selPref = code;
    if (map.ready) map.gPref.selectAll('path').classed('is-sel', (d) => d.properties.code === code);
    const s = prefSummary(code);
    const fc = FC && FC.prefs ? FC.prefs[code] : null;
    const top = fc && fc.a ? FC.sources[fc.a.src] : null;
    const rows = [...s.near].sort((a, b) => b.idx - a.idx).slice(0, 40).map((q) => `<button type="button" class="q-row" data-q="${q.idx}">
        <span class="q-mag" style="${magStyle(q.m)}">${q.m.toFixed(1)}</span>
        <span class="q-main"><span class="q-name">${esc(qTitle(q))}</span><span class="q-sub">${dateDot(q)}${q.p === code ? '・震央' : ''}</span></span><span></span></button>`).join('');
    openSheet(`
      <div class="eq-head"><div class="eq-kicker"><span class="tag">${esc(p.r)}</span><span class="tag">M${state.minM.toFixed(1)}以上・全期間${state.minI ? '・' + intLabel() : ''}</span></div>
        <h2 class="eq-title" id="sheetTitle">${esc(p.n)}</h2></div>
      <div class="stat-grid">
        <div class="stat"><b>${s.epi.length}<small style="font-size:12px">回</small></b><span>震央の数（全国${s.rEpi ?? '–'}位）</span></div>
        <div class="stat"><b>${s.near.length}<small style="font-size:12px">回</small></b><span>影響圏に入った回数（${s.rNear ?? '–'}位）</span></div>
        <div class="stat"><b>${s.biggest ? fmtM(s.biggest.m) : '—'}</b><span>震央で最大：${s.biggest ? esc(qTitle(s.biggest)) + '（' + s.biggest.y + '年）' : '記録なし'}</span></div>
        <div class="stat"><b>${top ? esc(top.p30) : '—'}</b><span>${top ? esc(top.name) + '（30年以内）' : '関係する長期評価なし'}</span></div>
      </div>
      <div class="btn-row"><button type="button" class="btn-accent" data-outlook="${code}">この県の見通しを見る</button></div>
      <section class="sheet-sec"><h4>影響圏に入った地震（新しい順）</h4><div class="quake-list">${rows || '<p class="empty">記録がありません。</p>'}</div>
      ${s.near.length > 40 ? `<p class="sheet-note">ほか${s.near.length - 40}件は「年表」で都道府県を選ぶと見られます。</p>` : ''}</section>`, p.n);
  }
  $('#sheetBody').addEventListener('click', (ev) => {
    const qb = ev.target.closest('[data-q]');
    if (qb) { openQuake(QUAKES[Number(qb.dataset.q)]); return; }
    const pb = ev.target.closest('[data-pref]');
    if (pb) { openPref(Number(pb.dataset.pref)); return; }
    const ob = ev.target.closest('[data-outlook]');
    if (ob) { state.outlookPref = Number(ob.dataset.outlook); state.outlookRegion = null; closeSheet(); go('outlook'); return; }
    const mb = ev.target.closest('[data-showmap]');
    if (mb) {
      const q = QUAKES[Number(mb.dataset.showmap)];
      closeSheet();
      if (q.m < state.minM) state.minM = 7;
      if (q.y > state.yearTo) { state.yearTo = YEAR_MAX; $('#timeRange').value = '1000'; }
      go('map');
      requestAnimationFrame(() => { updateMap(false); syncSegs(); zoomToQuake(q); state.selQuake = q; drawSelection(q); openQuake(q, { fromMap: true }); });
    }
  });

  // ------------------------------------------------------------ install (ホーム画面に追加)
  let deferredPrompt = null;
  const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = () => /android/i.test(navigator.userAgent);
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; updateInstallUI(); });
  window.addEventListener('appinstalled', () => { deferredPrompt = null; toast('ホーム画面に追加しました'); updateInstallUI(); });
  function updateInstallUI() {
    const installed = isStandalone();
    $('#installBtn').hidden = installed;
    const card = $('#installCard');
    if (card) card.hidden = installed;
  }
  async function onInstall() {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      try {
        const { outcome } = await deferredPrompt.userChoice;
        if (outcome === 'accepted') toast('ホーム画面に追加しています');
      } catch { /* ignore */ }
      deferredPrompt = null;
      updateInstallUI();
      return;
    }
    openInstall();
  }
  const ICON_SHARE = '<svg class="ic" viewBox="0 0 24 24"><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5"/><path d="M5 11v8.5h14V11"/></svg>';
  const ICON_PLUS = '<svg class="ic" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8.5v7M8.5 12h7"/></svg>';
  const ICON_MENU = '<svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="5.5" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="12" cy="18.5" r="1.2"/></svg>';
  function openInstall() {
    let html;
    if (EMBEDDED) {
      html = `<p>いまはプレビュー画面の中で開いています。ホーム画面に追加するには、下の公開URLをスマホの Safari（iPhone）または Chrome（Android）で開き、もう一度「ホームに追加」を押してください。</p>
        <p class="modal-url"><a href="${PUBLIC_URL}" target="_blank" rel="noopener">${PUBLIC_URL}</a></p>
        <button type="button" class="btn-soft" id="copyUrl">URLをコピー</button>
        <p class="modal-note">公開URLで開くと、Androidは確認画面が出て、iPhoneは共有ボタンから追加できます。</p>`;
    } else if (isIOS()) {
      html = `<ol class="steps"><li><span>画面下（iPadは右上）の ${ICON_SHARE} 共有ボタンを押す</span></li>
        <li><span>メニューを下へスクロールして ${ICON_PLUS}「ホーム画面に追加」を選ぶ</span></li>
        <li><span>右上の「追加」を押す</span></li></ol>
        <p class="modal-note">Safari 以外（アプリ内ブラウザなど）では表示されないことがあります。そのときは Safari で開き直してください。</p>`;
    } else if (isAndroid()) {
      html = `<ol class="steps"><li><span>右上の ${ICON_MENU} メニューを押す</span></li>
        <li><span>「アプリをインストール」または「ホーム画面に追加」を選ぶ</span></li>
        <li><span>確認の画面で「インストール」（または「追加」）を押す</span></li></ol>
        <p class="modal-note">Chrome で開くといちばん確実です。</p>`;
    } else {
      html = `<ol class="steps"><li><span>アドレスバー右端のインストール ${ICON_PLUS} ボタン、またはメニューの「インストール」を選ぶ</span></li>
        <li><span>スマホで使うときは、同じURLをスマホのブラウザで開いてください</span></li></ol>`;
    }
    $('#installSteps').innerHTML = html;
    $('#installModal').hidden = false;
    $('#installClose').focus({ preventScroll: true });
  }
  function closeInstall() { $('#installModal').hidden = true; }
  $('#installBtn').addEventListener('click', onInstall);
  $('#installBtn2').addEventListener('click', onInstall);
  $('#installClose').addEventListener('click', closeInstall);
  $('#installModal').addEventListener('click', (ev) => {
    if (ev.target.id === 'installModal') { closeInstall(); return; }
    if (ev.target.id === 'copyUrl') {
      const done = () => toast('URLをコピーしました');
      const fallback = () => {
        const a = document.querySelector('.modal-url a');
        if (!a) return;
        const r = document.createRange(); r.selectNodeContents(a);
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
        toast('URLを選択しました。長押しでコピーしてください');
      };
      try { navigator.clipboard.writeText(PUBLIC_URL).then(done, fallback); } catch { fallback(); }
    }
  });

  // ------------------------------------------------------------ toast
  let toastTimer = 0;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  // ------------------------------------------------------------ routing
  const TABS = ['map', 'rank', 'outlook', 'list', 'info'];
  function go(tab, fromHash) {
    if (!TABS.includes(tab)) tab = 'map';
    if (tab !== 'map') stopPlay();
    state.tab = tab;
    document.querySelectorAll('.view').forEach((v) => { v.hidden = v.dataset.view !== tab; });
    document.querySelectorAll('.tab').forEach((b) => {
      const on = b.dataset.tab === tab;
      b.setAttribute('aria-selected', String(on));
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    if (!fromHash && location.hash !== '#' + tab) {
      try { history.replaceState(null, '', '#' + tab); } catch { location.hash = tab; }
    }
    if (tab === 'map' && (map.needsLayout || !map.w)) { map.needsLayout = false; requestAnimationFrame(layoutMap); }
    renderTab(tab);
  }
  function renderTab(tab) {
    syncSegs();
    if (tab === 'map') updateMap(false);
    if (tab === 'rank') renderRanking();
    if (tab === 'outlook') renderOutlook();
    if (tab === 'list') { renderTimeline(); renderList(); }
    if (tab === 'info') renderInfo();
  }
  function renderAll() { renderTab(state.tab); }

  // ------------------------------------------------------------ events (delegated)
  document.querySelector('.tabbar').addEventListener('click', (ev) => {
    const b = ev.target.closest('.tab');
    if (b) go(b.dataset.tab);
  });
  window.addEventListener('hashchange', () => go(location.hash.slice(1), true));
  $('#view-rank').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-pref]');
    if (b) openPref(Number(b.dataset.pref));
  });
  $('#view-outlook').addEventListener('click', (ev) => {
    const r = ev.target.closest('[data-region]');
    if (r) { state.outlookRegion = r.dataset.region; renderOutlookPicker(); return; }
    const allb = ev.target.closest('[data-allsrc]');
    if (allb) { state.outlookAll = !state.outlookAll; renderOutlookDetail(); return; }
    const mine = ev.target.closest('[data-mine]');
    if (mine) {
      const c = Number(mine.dataset.mine);
      state.myPref = state.myPref === c ? 0 : c;
      store.set('myPref', state.myPref);
      renderOutlook();
      toast(state.myPref ? `${prefName(c)}を「わたしの県」にしました` : '「わたしの県」を解除しました');
      return;
    }
    const p = ev.target.closest('[data-pref]');
    if (p) {
      state.outlookPref = Number(p.dataset.pref);
      const inList = p.classList.contains('outlook-row');
      state.outlookRegion = null;
      renderOutlook();
      if (inList) $('#outlookDetail').scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
    }
  });
  $('#view-info').addEventListener('click', (ev) => {
    const s = ev.target.closest('[data-palette]');
    if (s) { state.palette = s.dataset.palette; store.set('palette', state.palette); applyTheme(); renderAll(); }
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (state.mode === 'auto') { applyTheme(); renderAll(); } });

  function debounce(fn, ms) { let t = 0; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
  function reducedMotion() { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }

  // ------------------------------------------------------------ boot
  function boot() {
    applyTheme();
    bindSegs();
    bindIntSelects();
    initList();
    initTime();
    const sub = `${QUAKES[0]?.y ?? 599}年〜${YEAR_MAX}年・${QUAKES.length}件`;
    $('#brandSub').textContent = sub;
    updateInstallUI();
    const start = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'map';
    initMap();
    go(start, true);
    if (start === 'map' && !reducedMotion()) {
      // 起動時に一度だけ：震央が年代順に現れる
      map.gQuake.selectAll('circle.q').classed('is-new', true)
        .style('animation-delay', (d) => `${Math.round(((d.y - YEAR_MIN) / (YEAR_MAX - YEAR_MIN)) * 900)}ms`);
      setTimeout(() => map.gQuake.selectAll('circle.q').classed('is-new', false).style('animation-delay', null), 1600);
    }
    const devHost = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
    if ('serviceWorker' in navigator && !EMBEDDED && /^https?:$/.test(location.protocol) && (!devHost || /[?&]sw=1/.test(location.search))) {
      const hadController = !!navigator.serviceWorker.controller;
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        // 新しい版が届いたら1回だけ読み込み直す（初回のインストール時は読み込み直さない）
        if (!hadController || reloaded) return;
        reloaded = true;
        location.reload();
      });
      navigator.serviceWorker.register('sw.js').then((reg) => reg.update()).catch(() => { /* offline cache unavailable */ });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
