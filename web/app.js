'use strict';
/* 상규 도면뷰어 — 화면 · 측정 · 내보내기 · 최근 파일 */

const $ = (s) => document.querySelector(s);
const NATIVE = window.DwgNative && typeof window.DwgNative.isApp === 'function' ? window.DwgNative : null;
const FONT = '"Noto Sans KR","Noto Sans CJK KR","Malgun Gothic","Apple SD Gothic Neo",system-ui,sans-serif';
const EM = 80; // 글자 높이 1(로컬) = 80px (100px 글꼴 크기의 대문자 높이쯤)

const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
};
const state = {
  scene: null, file: null,
  view: { s: 1, cx: 0, cy: 0 },
  bg: store.get('bg') || 'dark',
  mode: 'pan',
  meas: { pts: [], done: [], cursor: null, snap: true },
  unit: 'mm',
  marks: [], history: [], fileId: null,
  mk: { tool: 'pen', color: '#E03131', width: 2.5 },
};
const isMeasure = () => state.mode === 'dist' || state.mode === 'area';

// ---------------- 공통 ----------------
let toastTimer = 0;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
function busy(on, text) {
  $('#busy').hidden = !on;
  if (text) $('#busyText').textContent = text;
}
const fmtNum = (v, d = 0) => v.toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d });
function fmtSize(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(n / 1024)) + 'KB'; }
function fmtDate(t) {
  const d = new Date(t), now = new Date();
  const p = (x) => String(x).padStart(2, '0');
  const hm = p(d.getHours()) + ':' + p(d.getMinutes());
  if (d.toDateString() === now.toDateString()) return '오늘 ' + hm;
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
}

// ---------------- 최근 파일 (IndexedDB) ----------------
const DB = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      const r = indexedDB.open('sanggyu-dwg', 2);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('data')) d.createObjectStore('data');
        if (!d.objectStoreNames.contains('notes')) d.createObjectStore('notes');
      };
      r.onsuccess = () => { this.db = r.result; res(this.db); };
      r.onerror = () => rej(r.error);
    });
  },
  async tx(stores, mode, fn) {
    const d = await this.open();
    return new Promise((res, rej) => {
      const t = d.transaction(stores, mode);
      let out;
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
      out = fn(t);
    });
  },
  async list() {
    const d = await this.open();
    return new Promise((res) => {
      const r = d.transaction('meta').objectStore('meta').getAll();
      r.onsuccess = () => res((r.result || []).sort((a, b) => b.time - a.time));
      r.onerror = () => res([]);
    });
  },
  async get(id) {
    const d = await this.open();
    return new Promise((res) => {
      const r = d.transaction('data').objectStore('data').get(id);
      r.onsuccess = () => res(r.result || null);
      r.onerror = () => res(null);
    });
  },
  async save(name, buf) {
    const all = await this.list();
    const same = all.find((m) => m.name === name && m.size === buf.byteLength);
    const id = same ? same.id : Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const old = all.filter((m) => m.id !== id).slice(14);
    await this.tx(['meta', 'data'], 'readwrite', (t) => {
      t.objectStore('meta').put({ id, name, size: buf.byteLength, time: Date.now() });
      t.objectStore('data').put(buf, id);
      for (const o of old) { t.objectStore('meta').delete(o.id); t.objectStore('data').delete(o.id); t.objectStore('notes').delete(o.id); }
    });
    return id;
  },
  async getNotes(id) {
    const d = await this.open();
    return new Promise((res) => {
      const r = d.transaction('notes').objectStore('notes').get(id);
      r.onsuccess = () => res(r.result || null);
      r.onerror = () => res(null);
    });
  },
  async putNotes(id, v) {
    await this.tx(['notes'], 'readwrite', (t) => t.objectStore('notes').put(v, id));
  },
  async touch(id) {
    const all = await this.list();
    const m = all.find((x) => x.id === id);
    if (!m) return;
    m.time = Date.now();
    await this.tx(['meta'], 'readwrite', (t) => t.objectStore('meta').put(m));
  },
  async del(id) {
    await this.tx(['meta', 'data', 'notes'], 'readwrite', (t) => { t.objectStore('meta').delete(id); t.objectStore('data').delete(id); t.objectStore('notes').delete(id); });
  },
};

async function showRecent() {
  let list = [];
  try { list = await DB.list(); } catch (e) {}
  const ul = $('#recent');
  ul.innerHTML = '';
  $('#recentEmpty').hidden = list.length > 0;
  for (const m of list) {
    const li = document.createElement('li');
    const ext = (m.name.match(/\.(\w+)$/) || [, 'DWG'])[1].toUpperCase().slice(0, 4);
    li.innerHTML = `<div class="ftype">${ext}</div><div class="meta"><div class="nm"></div><div class="dt"></div></div>
      <button class="del" aria-label="목록에서 지우기"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></button>`;
    li.querySelector('.nm').textContent = m.name;
    li.querySelector('.dt').textContent = fmtDate(m.time) + ' · ' + fmtSize(m.size);
    li.addEventListener('click', async (ev) => {
      if (ev.target.closest('.del')) {
        ev.stopPropagation();
        await DB.del(m.id); showRecent();
        return;
      }
      const buf = await DB.get(m.id);
      if (!buf) { toast('파일을 찾을 수 없어요.'); return; }
      DB.touch(m.id).catch(() => {});
      openBytes(buf, m.name, m.id);
    });
    ul.appendChild(li);
  }
}

// ---------------- 파일 열기 ----------------
let worker = null, jobId = 0;
function getWorker() {
  if (!worker) worker = new Worker('worker.js', { type: 'module' });
  return worker;
}
function parse(buf) {
  return new Promise((resolve, reject) => {
    const id = ++jobId;
    const w = getWorker();
    const onMsg = (ev) => {
      const d = ev.data;
      if (d.id !== id) return;
      if (d.progress) { busy(true, d.progress); return; }
      w.removeEventListener('message', onMsg);
      w.removeEventListener('error', onErr);
      if (d.ok) resolve(d.model); else reject(new Error(d.error));
    };
    const onErr = (e) => {
      w.removeEventListener('message', onMsg); w.removeEventListener('error', onErr);
      worker.terminate(); worker = null;
      reject(new Error('도면을 여는 중 문제가 생겼어요. 파일이 너무 크거나 손상됐을 수 있어요.'));
    };
    w.addEventListener('message', onMsg);
    w.addEventListener('error', onErr);
    w.postMessage({ id, buf }, [buf]);
  });
}

async function openBytes(buf, name, recentId = null) {
  busy(true, '도면 여는 중…');
  const size = buf.byteLength;
  try {
    let fileId = recentId;
    if (!fileId) { try { fileId = await DB.save(name, buf.slice(0)); } catch (e) {} }
    const t0 = performance.now();
    const model = await parse(buf);
    busy(true, '화면 준비 중…');
    await new Promise((r) => setTimeout(r, 0));
    const scene = buildScene(model);
    state.scene = scene;
    state.file = { name, size };
    state.meas.pts = []; state.meas.done = []; state.meas.cursor = null;
    state.marks = []; state.history = []; state.fileId = fileId || null;
    if (fileId) {
      try {
        const n = await DB.getNotes(fileId);
        if (n) { state.marks = n.marks || []; state.meas.done = n.meas || []; }
      } catch (e) {}
    }
    const u = { 1: 'in', 2: 'ft', 4: 'mm', 5: 'cm', 6: 'm' }[model.units];
    state.unit = u || 'mm';
    $('#unit').value = state.unit;
    $('#fname').textContent = name;
    $('#finfo').textContent = [model.version ? verName(model.version) : '', fmtNum(model.count) + '개 객체', u ? '단위 ' + state.unit : '단위 미지정(mm로 계산)'].filter(Boolean).join(' · ');
    showViewer(true);
    setMode('pan');
    resize();
    fitView();
    console.log('open ms', Math.round(performance.now() - t0));
  } catch (e) {
    toast(e.message || String(e), 4500);
    if (!state.scene) showViewer(false);
  } finally {
    busy(false);
    showRecent();
  }
}
const VER = { AC1012: 'R13', AC1014: 'R14', AC1015: '2000', AC1018: '2004', AC1021: '2007', AC1024: '2010', AC1027: '2013', AC1032: '2018' };
function verName(v) { return v === 'DXF' ? 'DXF' : VER[v] ? 'DWG ' + VER[v] : ''; }

$('#btnOpen').addEventListener('click', () => $('#file').click());
$('#file').addEventListener('change', async (ev) => {
  const f = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (!f) return;
  busy(true, '파일 읽는 중…');
  try {
    const buf = await f.arrayBuffer();
    openBytes(buf, f.name || '도면.dwg');
  } catch (e) { busy(false); toast('파일을 읽지 못했어요.'); }
});

// 다른 앱(카톡·파일관리자)에서 넘어온 파일
window.__toast = (m) => toast(m, 4000);
window.__openUrl = async (url, name) => {
  busy(true, '파일 받는 중…');
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(r.status);
    const buf = await r.arrayBuffer();
    openBytes(buf, name || '도면.dwg');
  } catch (e) { busy(false); toast('받은 파일을 읽지 못했어요.'); }
};

function showViewer(on) {
  $('#viewer').hidden = !on;
  $('#home').hidden = on;
  if (!on) { closeSheet(); setMode('pan'); }
}
$('#btnHome').addEventListener('click', () => { showViewer(false); });

// ---------------- 장면 만들기 ----------------
function buildScene(md) {
  const fit = md.fit, full = md.full;
  const W = Math.max(fit[2] - fit[0], 1e-9), H = Math.max(fit[3] - fit[1], 1e-9);
  const pl = md.pl, nRec = md.count;
  const G = Math.max(1, Math.min(24, Math.ceil(Math.sqrt(nRec / 1500))));
  const cw = W / G, ch = H / G;
  const cells = [];
  const cellAt = (x, y) => {
    let gx = Math.floor((x - fit[0]) / cw), gy = Math.floor((y - fit[1]) / ch);
    gx = gx < 0 ? 0 : gx >= G ? G - 1 : gx; gy = gy < 0 ? 0 : gy >= G ? G - 1 : gy;
    let c = cells[gy * G + gx];
    if (!c) {
      c = cells[gy * G + gx] = { ox: fit[0] + (gx + 0.5) * cw, oy: fit[1] + (gy + 0.5) * ch, box: [Infinity, Infinity, -Infinity, -Infinity], strokes: new Map(), fills: new Map(), fillsEO: [] };
    }
    return c;
  };
  const grow = (c, x0, y0, x1, y1) => { const b = c.box; if (x0 < b[0]) b[0] = x0; if (y0 < b[1]) b[1] = y0; if (x1 > b[2]) b[2] = x1; if (y1 > b[3]) b[3] = y1; };

  // 선
  for (let i = 0; i < pl.length;) {
    const st = pl[i], n = pl[i + 1], closed = pl[i + 2];
    i += 3;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k < n; k++) { const x = pl[i + k * 2], y = pl[i + k * 2 + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const c = cellAt((x0 + x1) / 2, (y0 + y1) / 2);
    grow(c, x0, y0, x1, y1);
    let p = c.strokes.get(st);
    if (!p) { p = new Path2D(); c.strokes.set(st, p); }
    p.moveTo(pl[i] - c.ox, pl[i + 1] - c.oy);
    for (let k = 1; k < n; k++) p.lineTo(pl[i + k * 2] - c.ox, pl[i + k * 2 + 1] - c.oy);
    if (closed) p.closePath();
    i += n * 2;
  }
  // 면
  const fl = md.fill;
  for (let i = 0; i < fl.length;) {
    const ci = fl[i], nr = fl[i + 1];
    i += 2;
    const rings = [];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let r = 0; r < nr; r++) {
      const n = fl[i]; i++;
      rings.push([i, n]);
      for (let k = 0; k < n; k++) { const x = fl[i + k * 2], y = fl[i + k * 2 + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      i += n * 2;
    }
    const c = cellAt((x0 + x1) / 2, (y0 + y1) / 2);
    grow(c, x0, y0, x1, y1);
    const addRing = (p, start, n, reverse) => {
      if (!reverse) {
        p.moveTo(fl[start] - c.ox, fl[start + 1] - c.oy);
        for (let k = 1; k < n; k++) p.lineTo(fl[start + k * 2] - c.ox, fl[start + k * 2 + 1] - c.oy);
      } else {
        p.moveTo(fl[start + (n - 1) * 2] - c.ox, fl[start + (n - 1) * 2 + 1] - c.oy);
        for (let k = n - 2; k >= 0; k--) p.lineTo(fl[start + k * 2] - c.ox, fl[start + k * 2 + 1] - c.oy);
      }
      p.closePath();
    };
    if (nr === 1) {
      const [s, n] = rings[0];
      let area = 0;
      for (let k = 0; k < n; k++) { const j = (k + 1) % n; area += fl[s + k * 2] * fl[s + j * 2 + 1] - fl[s + j * 2] * fl[s + k * 2 + 1]; }
      let p = c.fills.get(ci);
      if (!p) { p = new Path2D(); c.fills.set(ci, p); }
      addRing(p, s, n, area < 0);
    } else {
      const p = new Path2D();
      for (const [s, n] of rings) addRing(p, s, n, false);
      c.fillsEO.push({ ci, p });
    }
  }
  const cellList = cells.filter(Boolean);

  // 글자
  const texts = md.texts.map((t) => {
    const m = t.m;
    const ux = Math.hypot(m[0], m[1]), uy = Math.hypot(m[2], m[3]);
    const lines = Array.isArray(t.t) ? t.t : [t.t];
    const maxLen = lines.reduce((a, l) => Math.max(a, l.length), 0);
    const wlen = t.wrap ? Math.min(t.wrap, maxLen * 1.3) : maxLen * 1.3;
    const r = Math.hypot(wlen * ux, (lines.length * 1.8 + 1) * uy) * 1.2 + uy;
    return { ...t, lines, ux, uy, r };
  });

  // 해치 무늬
  const patterns = md.patterns.map((p) => {
    const path = new Path2D();
    for (const r of p.rings) {
      path.moveTo(r[0], r[1]);
      for (let k = 2; k < r.length; k += 2) path.lineTo(r[k], r[k + 1]);
      path.closePath();
    }
    return { ...p, path, sc: Math.sqrt(Math.abs(p.m[0] * p.m[3] - p.m[1] * p.m[2])) || 1 };
  });

  // 스냅 찾기용 격자
  const sn = md.snaps, nk = md.snapKinds.length;
  const SG = 256;
  const scw = W / SG, sch = H / SG;
  const keys = new Int32Array(nk);
  const counts = new Int32Array(SG * SG + 1);
  for (let i = 0; i < nk; i++) {
    let gx = Math.floor((sn[i * 2] - fit[0]) / scw), gy = Math.floor((sn[i * 2 + 1] - fit[1]) / sch);
    gx = gx < 0 ? 0 : gx >= SG ? SG - 1 : gx; gy = gy < 0 ? 0 : gy >= SG ? SG - 1 : gy;
    const k = gy * SG + gx; keys[i] = k; counts[k + 1]++;
  }
  for (let k = 0; k < SG * SG; k++) counts[k + 1] += counts[k];
  const order = new Int32Array(nk), fillPos = counts.slice(0, SG * SG);
  for (let i = 0; i < nk; i++) order[fillPos[keys[i]]++] = i;

  return {
    fit, full, cells: cellList, styles: md.styles, colors: md.colors, texts, patterns,
    snap: { pts: sn, kinds: md.snapKinds, start: counts, order, SG, x0: fit[0], y0: fit[1], cw: scw, ch: sch },
    colorCache: {},
  };
}

// ---------------- 색 ----------------
function cssColors(scene, bg) {
  if (scene.colorCache[bg]) return scene.colorCache[bg];
  const fg = bg === 'white' ? '#000000' : '#FFFFFF';
  const bgc = bg === 'white' ? '#FFFFFF' : '#1A1E21';
  const out = scene.colors.map((v) => {
    if (v === -1) return fg;
    if (v === -2) return bgc;
    let r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    if (bg === 'white' && lum > 0.55) { const k = 0.5 / lum; r *= k; g *= k; b *= k; }
    if (bg !== 'white' && lum < 0.18) { const k = 0.35; r += (255 - r) * k; g += (255 - g) * k; b += (255 - b) * k; }
    return 'rgb(' + Math.round(r) + ',' + Math.round(g) + ',' + Math.round(b) + ')';
  });
  out.bg = bgc; out.fg = fg;
  scene.colorCache[bg] = out;
  return out;
}

// ---------------- 그리기 ----------------
// view: s = 화면 px(장치) / 도면 단위, (cx, cy) = 화면 가운데의 도면 좌표
function drawScene(ctx, W, H, view, o) {
  const sc = state.scene;
  const cols = cssColors(sc, o.bg);
  const s = view.s;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = cols.bg;
  ctx.fillRect(0, 0, W, H);
  if (!sc) return;
  const vx0 = view.cx - W / 2 / s, vx1 = view.cx + W / 2 / s, vy0 = view.cy - H / 2 / s, vy1 = view.cy + H / 2 / s;
  const vis = (b) => b[2] >= vx0 && b[0] <= vx1 && b[3] >= vy0 && b[1] <= vy1;
  const setT = (ox, oy) => ctx.setTransform(s, 0, 0, -s, (ox - view.cx) * s + W / 2, (view.cy - oy) * s + H / 2);
  const lw = o.lw / s;
  const cells = sc.cells.filter((c) => vis(c.box));

  // 1) 채우기
  for (const c of cells) {
    if (!c.fills.size && !c.fillsEO.length) continue;
    setT(c.ox, c.oy);
    for (const [ci, p] of c.fills) { ctx.fillStyle = cols[ci]; ctx.fill(p, 'nonzero'); }
    for (const f of c.fillsEO) { ctx.fillStyle = cols[f.ci]; ctx.fill(f.p, 'evenodd'); }
  }
  // 2) 해치 무늬
  if (!o.fast) for (const p of sc.patterns) if (vis(p.box)) drawPattern(ctx, W, H, view, p, cols[p.c], o);
  // 3) 선
  ctx.lineJoin = 'miter';
  ctx.miterLimit = 4;
  ctx.lineCap = 'butt';
  for (const c of cells) {
    setT(c.ox, c.oy);
    for (const [si, p] of c.strokes) {
      const st = sc.styles[si];
      ctx.strokeStyle = cols[st.c];
      ctx.lineWidth = st.w > lw ? st.w : lw;
      if (st.dash && !o.fast) {
        let tot = 0;
        for (const v of st.dash) tot += v;
        if (tot * s >= 4 * o.px) ctx.setLineDash(st.dash.map((v, i) => (i % 2 === 0 && v < lw) ? lw : v));
        else ctx.setLineDash([]);
      } else ctx.setLineDash([]);
      ctx.stroke(p);
    }
  }
  ctx.setLineDash([]);
  // 4) 글자
  if (!o.noText) drawTexts(ctx, W, H, view, cols, o, vis);
}

function drawTexts(ctx, W, H, view, cols, o, vis) {
  const s = view.s;
  const minPx = o.fast ? 5 * o.px : 1.6 * o.px;
  ctx.font = '100px ' + FONT;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  const vx0 = view.cx - W / 2 / s, vx1 = view.cx + W / 2 / s, vy0 = view.cy - H / 2 / s, vy1 = view.cy + H / 2 / s;
  let drawn = 0;
  for (const t of state.scene.texts) {
    const hp = t.uy * s;
    if (hp < minPx) continue;
    const m = t.m;
    if (m[4] + t.r < vx0 || m[4] - t.r > vx1 || m[5] + t.r < vy0 || m[5] - t.r > vy1) continue;
    if (o.fast && ++drawn > 600) break;
    // 화면 행렬 = 보기 ∘ 글자 ∘ (1/EM, -1/EM)
    const a = s * m[0] / EM, b = -s * m[1] / EM, c = -s * m[2] / EM, d = s * m[3] / EM;
    const e = (m[4] - view.cx) * s + W / 2, f = (view.cy - m[5]) * s + H / 2;
    ctx.setTransform(a, b, c, d, e, f);
    ctx.fillStyle = cols[t.c];
    if (t.s === 't') {
      const str = t.lines[0];
      if (t.mw == null) t.mw = ctx.measureText(str).width;
      let x = -t.fx * t.mw;
      let y = t.vy === 'mid' ? 0.5 * EM : t.vy === 'top' ? EM : t.vy === 'bottom' ? -0.22 * EM : 0;
      if (t.fitW && t.mw > 0) {
        const k = t.fitW * EM / t.mw;
        ctx.transform(k, 0, 0, 1, 0, 0);
        x = 0;
      }
      ctx.fillText(str, x, y);
    } else {
      if (!t.wl) t.wl = wrapLines(ctx, t.lines, t.wrap * EM);
      const lh = 1.667 * (t.ls || 1) * EM;
      const n = t.wl.length;
      const total = EM + (n - 1) * lh;
      let y0 = t.vy === 'top' ? EM : t.vy === 'mid' ? EM - total / 2 : EM - total;
      for (let i = 0; i < n; i++) {
        const L = t.wl[i];
        if (!L.t) continue;
        ctx.fillText(L.t, -t.fx * L.w, y0 + i * lh);
      }
    }
  }
}
function wrapLines(ctx, lines, maxW) {
  const out = [];
  for (const line of lines) {
    if (!maxW || maxW <= 0) { out.push({ t: line, w: ctx.measureText(line).width }); continue; }
    const full = ctx.measureText(line).width;
    if (full <= maxW * 1.02) { out.push({ t: line, w: full }); continue; }
    // 단어(띄어쓰기) 단위, 너무 긴 단어는 글자 단위로 자르기
    const words = line.split(/(\s+)/);
    let cur = '';
    for (const w of words) {
      const test = cur + w;
      if (ctx.measureText(test).width <= maxW || !cur.trim()) {
        if (ctx.measureText(test).width > maxW && !cur.trim()) {
          // 단어 하나가 너무 긴 경우
          let piece = '';
          for (const ch of w) {
            if (ctx.measureText(piece + ch).width > maxW && piece) { out.push({ t: piece, w: ctx.measureText(piece).width }); piece = ch; }
            else piece += ch;
          }
          cur = piece;
        } else cur = test;
      } else {
        const t = cur.replace(/\s+$/, '');
        out.push({ t, w: ctx.measureText(t).width });
        cur = w.trim() ? w : '';
      }
    }
    if (cur) out.push({ t: cur, w: ctx.measureText(cur).width });
  }
  return out;
}

function hatchDash(dash, k) {
  // 해치 점선: 양수=선, 음수=틈, 0=점 → 캔버스 배열
  const out = [];
  let lead = 0;
  for (const v of dash) {
    const len = Math.abs(v), on = v >= 0;
    if (out.length % 2 === 0) { if (on) out.push(len); else if (!out.length) lead += len; else out[out.length - 1] += len; }
    else { if (!on) out.push(len); else out[out.length - 1] += len; }
  }
  if (!out.length) return null;
  if (lead) { if (out.length % 2) out.push(lead); else out[out.length - 1] += lead; }
  if (out.length % 2) out.push(0);
  return out.map((v, i) => (i % 2 === 0 && v < k) ? k : v);
}

function drawPattern(ctx, W, H, view, p, color, o) {
  const s = view.s, m = p.m;
  const ps = s * p.sc; // 로컬 1 단위 = ps px
  const lb = p.lb;
  // 너무 촘촘하면 옅게 칠하기
  let total = 0, dense = false;
  for (const d of p.defs) {
    const nx = -Math.sin(d.a), ny = Math.cos(d.a);
    const sp = Math.abs(d.ox * nx + d.oy * ny);
    if (!(sp > 0) || sp * ps < 2.5 * o.px) { dense = true; break; }
    total += Math.hypot(lb[2] - lb[0], lb[3] - lb[1]) / sp;
  }
  // 보이는 부분만 계산하도록 영역 줄이기
  const inv = invert(m);
  ctx.save();
  ctx.setTransform(s * m[0], -s * m[1], s * m[2], -s * m[3], (m[4] - view.cx) * s + W / 2, (view.cy - m[5]) * s + H / 2);
  if (dense || total > 6000) {
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = color;
    ctx.fill(p.path, 'evenodd');
    ctx.restore();
    return;
  }
  ctx.clip(p.path, 'evenodd');
  // 화면 네 모서리를 로컬 좌표로
  let bx0 = lb[0], by0 = lb[1], bx1 = lb[2], by1 = lb[3];
  if (inv) {
    const wx0 = view.cx - W / 2 / s, wx1 = view.cx + W / 2 / s, wy0 = view.cy - H / 2 / s, wy1 = view.cy + H / 2 / s;
    let qx0 = Infinity, qy0 = Infinity, qx1 = -Infinity, qy1 = -Infinity;
    for (const [x, y] of [[wx0, wy0], [wx1, wy0], [wx0, wy1], [wx1, wy1]]) {
      const lx = inv[0] * x + inv[2] * y + inv[4], ly = inv[1] * x + inv[3] * y + inv[5];
      qx0 = Math.min(qx0, lx); qx1 = Math.max(qx1, lx); qy0 = Math.min(qy0, ly); qy1 = Math.max(qy1, ly);
    }
    bx0 = Math.max(bx0, qx0); by0 = Math.max(by0, qy0); bx1 = Math.min(bx1, qx1); by1 = Math.min(by1, qy1);
    if (bx0 > bx1 || by0 > by1) { ctx.restore(); return; }
  }
  const corners = [[bx0, by0], [bx1, by0], [bx0, by1], [bx1, by1]];
  ctx.strokeStyle = color;
  ctx.lineWidth = o.lw / ps;
  for (const d of p.defs) {
    const ux = Math.cos(d.a), uy = Math.sin(d.a), nx = -uy, ny = ux;
    const spN = d.ox * nx + d.oy * ny, spU = d.ox * ux + d.oy * uy;
    if (Math.abs(spN) < 1e-12) continue;
    let nmin = Infinity, nmax = -Infinity, umin = Infinity, umax = -Infinity;
    for (const [x, y] of corners) {
      const pn = (x - d.bx) * nx + (y - d.by) * ny, pu = (x - d.bx) * ux + (y - d.by) * uy;
      nmin = Math.min(nmin, pn); nmax = Math.max(nmax, pn); umin = Math.min(umin, pu); umax = Math.max(umax, pu);
    }
    let k0 = Math.ceil(nmin / spN), k1 = Math.floor(nmax / spN);
    if (k0 > k1) [k0, k1] = [k1, k0];
    if (k1 - k0 > 6000) continue;
    const dash = d.dash && d.dash.length ? hatchDash(d.dash, 1 / ps) : null;
    let L = 0;
    if (dash) for (const v of dash) L += v;
    const useDash = dash && L * ps >= 3 * o.px;
    ctx.setLineDash(useDash ? dash : []);
    const path = new Path2D();
    for (let k = k0; k <= k1; k++) {
      const px = d.bx + k * d.ox, py = d.by + k * d.oy;
      const sh = k * spU; // 이 선의 기준점이 u 방향으로 밀린 정도
      let t0 = umin - sh - 1, t1 = umax - sh + 1;
      if (useDash) t0 = Math.floor(t0 / L) * L;
      path.moveTo(px + ux * t0 - 0, py + uy * t0);
      path.lineTo(px + ux * t1, py + uy * t1);
      void sh;
    }
    ctx.stroke(path);
  }
  ctx.setLineDash([]);
  ctx.restore();
}
function invert(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det) return null;
  const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

// ---------------- 화면 캔버스 ----------------
const cv = $('#cv');
const ctx = cv.getContext('2d', { alpha: false });
let DPR = 1, CW = 0, CH = 0;
let lastFullMs = 0, snapshot = null, snapView = null, needFull = false, rafId = 0, interacting = false, idleTimer = 0;

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2.5);
  const r = cv.getBoundingClientRect();
  CW = Math.max(1, Math.round(r.width * DPR)); CH = Math.max(1, Math.round(r.height * DPR));
  if (cv.width !== CW || cv.height !== CH) { cv.width = CW; cv.height = CH; }
  snapshot = null;
  requestDraw(true);
}
window.addEventListener('resize', () => { if (!$('#viewer').hidden) resize(); });

function fitView(box) {
  const sc = state.scene;
  if (!sc) return;
  const b = box || sc.fit;
  const topIn = 64 * DPR, botIn = 96 * DPR, side = 16 * DPR;
  const aw = CW - side * 2, ah = CH - topIn - botIn;
  const w = Math.max(b[2] - b[0], 1e-9), h = Math.max(b[3] - b[1], 1e-9);
  const s = Math.min(aw / w, ah / h);
  state.view.s = s;
  state.view.cx = (b[0] + b[2]) / 2;
  state.view.cy = (b[1] + b[3]) / 2 + (botIn - topIn) / 2 / s;
  requestDraw(true);
}
$('#btnFit').addEventListener('click', () => fitView());
$('#btnBg').addEventListener('click', () => {
  state.bg = state.bg === 'white' ? 'dark' : 'white';
  store.set('bg', state.bg);
  requestDraw(true);
});

function requestDraw(full) {
  if (full) needFull = true;
  if (!rafId) rafId = requestAnimationFrame(frame);
}
function frame() {
  rafId = 0;
  if (!state.scene || $('#viewer').hidden) return;
  const opts = { bg: state.bg, lw: 0.85 * DPR, px: DPR };
  const slow = lastFullMs > 28;
  if (interacting && slow && snapshot) {
    // 움직이는 중: 지난 그림을 늘리고 옮겨서 보여주기
    const v = state.view, k = v.s / snapView.s;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = cssColors(state.scene, state.bg).bg;
    ctx.fillRect(0, 0, CW, CH);
    const dx = (snapView.cx - v.cx) * v.s + CW / 2 - CW / 2 * k;
    const dy = (v.cy - snapView.cy) * v.s + CH / 2 - CH / 2 * k;
    ctx.drawImage(snapshot, dx, dy, CW * k, CH * k);
  } else if (interacting && slow) {
    drawScene(ctx, CW, CH, state.view, { ...opts, fast: true });
  } else {
    const t0 = performance.now();
    drawScene(ctx, CW, CH, state.view, opts);
    lastFullMs = performance.now() - t0;
    needFull = false;
    if (lastFullMs > 28) {
      if (!snapshot || snapshot.width !== CW || snapshot.height !== CH) { snapshot = document.createElement('canvas'); snapshot.width = CW; snapshot.height = CH; }
      snapshot.getContext('2d').drawImage(cv, 0, 0);
      snapView = { ...state.view };
    }
  }
  drawOverlay(ctx, CW, CH, state.view, { bg: state.bg, px: DPR, live: true });
  drawLoupe();
}
function interactStart() { interacting = true; clearTimeout(idleTimer); }
function interactEnd() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { interacting = false; requestDraw(true); }, 140);
}

// ---------------- 좌표 변환 ----------------
function toWorld(px, py) { // CSS 좌표 → 도면
  const v = state.view;
  return { x: v.cx + (px * DPR - CW / 2) / v.s, y: v.cy - (py * DPR - CH / 2) / v.s };
}
function toScreen(x, y, view = state.view, W = CW, H = CH) { // 도면 → 장치 px
  return { x: (x - view.cx) * view.s + W / 2, y: (view.cy - y) * view.s + H / 2 };
}
function zoomAt(px, py, k) {
  const v = state.view;
  const w = toWorld(px, py);
  const ns = Math.min(Math.max(v.s * k, 1e-9), 1e9);
  v.s = ns;
  v.cx = w.x - (px * DPR - CW / 2) / ns;
  v.cy = w.y + (py * DPR - CH / 2) / ns;
}

// ---------------- 손가락·마우스 ----------------
const ptrs = new Map();
let gest = null; // {type:'pan'|'pinch'|'aim', ...}
let lastTap = { t: 0, x: 0, y: 0 };

function cssPt(ev) { const r = cv.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; }

cv.addEventListener('pointerdown', (ev) => {
  if (!state.scene) return;
  try { cv.setPointerCapture(ev.pointerId); } catch (e) {}
  const p = cssPt(ev);
  ptrs.set(ev.pointerId, { ...p, type: ev.pointerType });
  interactStart();
  if (ptrs.size === 2) {
    const [a, b] = [...ptrs.values()];
    gest = { type: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, c0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, v0: { ...state.view } };
    state.meas.cursor = null; hideLoupe();
    if (state.draft) { state.draft = null; }
    return;
  }
  if (ptrs.size > 2) return;
  if (state.mode === 'mark' && (ev.pointerType !== 'mouse' || ev.button === 0)) {
    gest = { type: 'mark', start: p, t: performance.now() };
    markDown(p);
    return;
  }
  const measuring = isMeasure();
  if (measuring && ev.pointerType !== 'mouse') {
    gest = { type: 'aim', start: p, t: performance.now() };
    updateAim(p.x, p.y);
  } else {
    gest = { type: 'pan', start: p, last: p, moved: 0, t: performance.now(), mouseMeasure: measuring && ev.pointerType === 'mouse' };
  }
});
cv.addEventListener('pointermove', (ev) => {
  if (!state.scene) return;
  const p = cssPt(ev);
  if (!ptrs.has(ev.pointerId)) {
    // 마우스 오버: 측정 중이면 스냅 미리보기
    if (ev.pointerType === 'mouse' && isMeasure()) { updateAim(p.x, p.y, true); }
    return;
  }
  ptrs.get(ev.pointerId).x = p.x; ptrs.get(ev.pointerId).y = p.y;
  if (!gest) return;
  if (gest.type === 'pinch' && ptrs.size >= 2) {
    const [a, b] = [...ptrs.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const v0 = gest.v0;
    const ns = Math.min(Math.max(v0.s * d / gest.d0, 1e-9), 1e9);
    // 처음 두 손가락 가운데에 있던 도면 점이 지금 가운데로 오도록
    const wx = v0.cx + (gest.c0.x * DPR - CW / 2) / v0.s, wy = v0.cy - (gest.c0.y * DPR - CH / 2) / v0.s;
    state.view.s = ns;
    state.view.cx = wx - (c.x * DPR - CW / 2) / ns;
    state.view.cy = wy + (c.y * DPR - CH / 2) / ns;
    requestDraw();
  } else if (gest.type === 'pan') {
    const dx = p.x - gest.last.x, dy = p.y - gest.last.y;
    gest.moved += Math.abs(dx) + Math.abs(dy);
    gest.last = p;
    state.view.cx -= dx * DPR / state.view.s;
    state.view.cy += dy * DPR / state.view.s;
    if (gest.mouseMeasure) updateAim(p.x, p.y, true);
    requestDraw();
  } else if (gest.type === 'aim') {
    updateAim(p.x, p.y);
  } else if (gest.type === 'mark') {
    markMove(p);
  }
});
function endPtr(ev) {
  if (!ptrs.has(ev.pointerId)) return;
  const p = cssPt(ev);
  ptrs.delete(ev.pointerId);
  if (gest && gest.type === 'pinch') {
    if (ptrs.size === 1) {
      const [q] = [...ptrs.values()];
      gest = (state.mode === 'pan' || q.type === 'mouse') && state.mode !== 'mark' ? { type: 'pan', start: q, last: q, moved: 99, t: 0 } : null;
    } else if (!ptrs.size) gest = null;
    interactEnd();
    return;
  }
  if (gest && gest.type === 'mark') {
    if (ev.type === 'pointerup') markUp(p); else state.draft = null;
  } else if (gest && gest.type === 'aim' && ev.type === 'pointerup') {
    const c = state.meas.cursor;
    if (c) addMeasurePoint(c.x, c.y);
    state.meas.cursor = null;
    hideLoupe();
  } else if (gest && gest.type === 'pan' && ev.type === 'pointerup' && gest.moved < 8 && performance.now() - gest.t < 350) {
    if (gest.mouseMeasure) {
      const c = state.meas.cursor || toWorld(p.x, p.y);
      addMeasurePoint(c.x, c.y);
    } else if (state.mode === 'pan') {
      const now = performance.now();
      if (now - lastTap.t < 320 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 30) {
        zoomAt(p.x, p.y, 2.2); lastTap.t = 0;
      } else lastTap = { t: now, x: p.x, y: p.y };
    }
  }
  if (!ptrs.size) gest = null;
  interactEnd();
  requestDraw();
}
cv.addEventListener('pointerup', endPtr);
cv.addEventListener('pointercancel', endPtr);
cv.addEventListener('pointerleave', (ev) => {
  if (ev.pointerType === 'mouse' && !ptrs.size && isMeasure()) { state.meas.cursor = null; requestDraw(); }
});
cv.addEventListener('wheel', (ev) => {
  if (!state.scene) return;
  ev.preventDefault();
  const p = cssPt(ev);
  const k = Math.exp(-ev.deltaY * (ev.deltaMode === 1 ? 0.05 : 0.0018));
  zoomAt(p.x, p.y, k);
  interactStart(); interactEnd();
  if (isMeasure()) updateAim(p.x, p.y, true);
  requestDraw();
}, { passive: false });
cv.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------------- 스냅 ----------------
function findSnap(wx, wy, radiusWorld) {
  const S = state.scene.snap;
  const n = S.kinds.length;
  if (!n) return null;
  const gx0 = Math.floor((wx - radiusWorld - S.x0) / S.cw), gx1 = Math.floor((wx + radiusWorld - S.x0) / S.cw);
  const gy0 = Math.floor((wy - radiusWorld - S.y0) / S.ch), gy1 = Math.floor((wy + radiusWorld - S.y0) / S.ch);
  const cl = (v) => v < 0 ? 0 : v >= S.SG ? S.SG - 1 : v;
  const ax0 = cl(gx0), ax1 = cl(gx1), ay0 = cl(gy0), ay1 = cl(gy1);
  if ((ax1 - ax0 + 1) * (ay1 - ay0 + 1) > 2500) return null; // 너무 멀리서 보는 중
  let best = null, bd = Infinity;
  const pri = [0, 0.35, 0.1, 0.25, 0.3];
  for (let gy = ay0; gy <= ay1; gy++) {
    for (let gx = ax0; gx <= ax1; gx++) {
      const k = gy * S.SG + gx;
      for (let j = S.start[k]; j < S.start[k + 1]; j++) {
        const i = S.order[j];
        const x = S.pts[i * 2], y = S.pts[i * 2 + 1];
        const d = Math.hypot(x - wx, y - wy);
        if (d > radiusWorld) continue;
        const score = d + pri[S.kinds[i]] * radiusWorld;
        if (score < bd) { bd = score; best = { x, y, k: S.kinds[i] }; }
      }
    }
  }
  return best;
}

function updateAim(px, py, mouse) {
  const w = toWorld(px, py);
  let snap = null;
  if (state.meas.snap) snap = findSnap(w.x, w.y, (mouse ? 14 : 22) * DPR / state.view.s);
  state.meas.cursor = snap ? { x: snap.x, y: snap.y, snap: snap.k } : { x: w.x, y: w.y, snap: -1 };
  state.meas.aimPx = { x: px, y: py, mouse };
  if (!mouse) showLoupe(px, py);
  requestDraw();
}

// ---------------- 돋보기 ----------------
const loupe = $('#loupe');
const lctx = loupe.getContext('2d');
let loupeAt = null;
function showLoupe(px, py) { loupeAt = { x: px, y: py }; loupe.hidden = false; }
function hideLoupe() { loupeAt = null; loupe.hidden = true; }
function drawLoupe() {
  if (!loupeAt || loupe.hidden) return;
  const size = 132, z = 2.2;
  const ld = Math.round(size * DPR);
  if (loupe.width !== ld) { loupe.width = ld; loupe.height = ld; }
  // 손가락 반대편 위쪽 모서리에 둔다
  const r = cv.getBoundingClientRect();
  const left = loupeAt.x < r.width / 2 ? r.width - size - 14 : 14;
  loupe.style.left = left + 'px';
  loupe.style.top = (parseFloat(getComputedStyle(document.querySelector('.topbar')).height) + 12) + 'px';
  const src = (ld / z);
  const c = state.meas.cursor;
  const sp = c ? toScreen(c.x, c.y) : { x: loupeAt.x * DPR, y: loupeAt.y * DPR };
  lctx.setTransform(1, 0, 0, 1, 0, 0);
  lctx.fillStyle = cssColors(state.scene, state.bg).bg;
  lctx.fillRect(0, 0, ld, ld);
  lctx.drawImage(cv, sp.x - src / 2, sp.y - src / 2, src, src, 0, 0, ld, ld);
  lctx.strokeStyle = state.bg === 'white' ? '#D9480F' : '#F0B400';
  lctx.lineWidth = 1.5 * DPR;
  lctx.beginPath();
  lctx.moveTo(ld / 2, ld / 2 - 18 * DPR); lctx.lineTo(ld / 2, ld / 2 - 5 * DPR);
  lctx.moveTo(ld / 2, ld / 2 + 5 * DPR); lctx.lineTo(ld / 2, ld / 2 + 18 * DPR);
  lctx.moveTo(ld / 2 - 18 * DPR, ld / 2); lctx.lineTo(ld / 2 - 5 * DPR, ld / 2);
  lctx.moveTo(ld / 2 + 5 * DPR, ld / 2); lctx.lineTo(ld / 2 + 18 * DPR, ld / 2);
  lctx.stroke();
}

// ---------------- 측정 ----------------
const UNIT_M = { mm: 0.001, cm: 0.01, m: 1, in: 0.0254, ft: 0.3048 };
$('#unit').addEventListener('change', (e) => { state.unit = e.target.value; updatePanel(); requestDraw(); });

function setMode(m) {
  if (state.mode !== m && state.meas.pts.length) finishMeasure();
  state.mode = m;
  document.querySelectorAll('.tools [data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  $('#mpanel').hidden = !isMeasure();
  $('#kpanel').hidden = m !== 'mark';
  if (m === 'mark') markHint();
  state.draft = null;
  state.meas.cursor = null; hideLoupe();
  updatePanel();
  requestDraw();
}
document.querySelectorAll('.tools [data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

function addMeasurePoint(x, y) {
  const pts = state.meas.pts;
  const last = pts[pts.length - 1];
  if (last && Math.hypot(last.x - x, last.y - y) * state.view.s < 2) return;
  pts.push({ x, y });
  if (navigator.vibrate) try { navigator.vibrate(8); } catch (e) {}
  updatePanel();
  requestDraw();
}
function finishMeasure() {
  setTimeout(saveNotes, 0);
  const pts = state.meas.pts;
  const type = state.mode === 'area' ? 'area' : 'dist';
  if ((type === 'dist' && pts.length >= 2) || (type === 'area' && pts.length >= 3)) state.meas.done.push({ type, pts: pts.slice() });
  state.meas.pts = [];
  updatePanel();
  requestDraw();
}
$('#mUndo').addEventListener('click', () => {
  if (state.meas.pts.length) state.meas.pts.pop();
  else if (state.meas.done.length) { const d = state.meas.done.pop(); if (d.type === state.mode) state.meas.pts = d.pts; }
  updatePanel(); requestDraw();
});
$('#mDone').addEventListener('click', finishMeasure);
$('#mClear').addEventListener('click', () => {
  if (state.meas.done.length && !confirm('측정한 것을 모두 지울까요?')) return;
  state.meas.pts = []; state.meas.done = []; updatePanel(); requestDraw(); saveNotes();
});
$('#mSnap').addEventListener('click', (e) => {
  state.meas.snap = !state.meas.snap;
  e.currentTarget.classList.toggle('on', state.meas.snap);
  e.currentTarget.setAttribute('aria-pressed', state.meas.snap);
});

function polyLen(pts, closed) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  if (closed && pts.length > 2) L += Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y);
  return L;
}
function polyArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p.x * q.y - q.x * p.y; }
  return Math.abs(a) / 2;
}
function fmtLen(v) {
  const u = state.unit;
  const d = u === 'mm' ? (v >= 100 ? 0 : 1) : u === 'm' ? 3 : 2;
  let s = fmtNum(v, d) + ' ' + (u === 'in' ? 'in' : u === 'ft' ? 'ft' : u);
  return s;
}
function fmtLenSub(v) {
  const m = v * UNIT_M[state.unit];
  if (state.unit === 'm') return '';
  return fmtNum(m, m < 10 ? 3 : 2) + ' m';
}
function fmtArea(a) {
  const m2 = a * UNIT_M[state.unit] * UNIT_M[state.unit];
  return { main: fmtNum(m2, m2 < 100 ? 2 : 1) + ' ㎡', py: fmtNum(m2 / 3.305785, 2) + '평' };
}
function updatePanel() {
  if (!isMeasure()) return;
  const pts = state.meas.pts;
  $('#mlabel').textContent = state.mode === 'area' ? '면적 재기' : '거리 재기';
  let main, sub = '';
  if (state.mode === 'dist') {
    if (pts.length < 2) main = pts.length ? '다음 점을 찍어 주세요' : '첫 점을 찍어 주세요';
    else {
      const L = polyLen(pts, false);
      main = fmtLen(L);
      sub = [fmtLenSub(L), pts.length > 2 ? (pts.length - 1) + '구간 합계' : ''].filter(Boolean).join(' · ');
    }
  } else {
    if (pts.length < 3) main = ['첫 점을 찍어 주세요', '다음 점을 찍어 주세요', '점을 하나 더 찍어 주세요'][pts.length];
    else {
      const a = fmtArea(polyArea(pts));
      main = a.main + '  (' + a.py + ')';
      sub = '둘레 ' + fmtLen(polyLen(pts, true)) + ' · 점 ' + pts.length + '개';
    }
  }
  if (!pts.length && state.meas.done.length) sub = '저장된 측정 ' + state.meas.done.length + '개';
  $('#mmain').textContent = main;
  $('#msub').textContent = sub;
  const touch = matchMedia('(pointer: coarse)').matches;
  if (!pts.length && !state.meas.done.length) $('#msub').textContent = touch ? '누르고 움직이면 돋보기 · 손을 떼면 점 찍기' : '클릭해서 점을 찍어요';
}

// 측정 그리기 (화면·내보내기 공통)
function drawOverlay(c, W, H, view, o) {
  if (o.marks !== false) drawMarks(c, W, H, view, o);
  const items = (o.marks === false && !o.live ? [] : state.meas.done).map((d) => ({ ...d, live: false }));
  const cur = state.meas.pts.slice();
  if (o.live && isMeasure() && state.meas.cursor && cur.length) cur.push(state.meas.cursor);
  if (cur.length) items.push({ type: state.mode === 'area' ? 'area' : 'dist', pts: cur, live: true });
  const col = o.bg === 'white' ? '#D9480F' : '#FFC21A';
  const halo = o.bg === 'white' ? 'rgba(255,255,255,.92)' : 'rgba(10,12,14,.85)';
  const px = o.px;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.setLineDash([]);
  c.lineJoin = 'round'; c.lineCap = 'round';
  for (const it of items) {
    if (!it.pts.length) continue;
    const sp = it.pts.map((p) => toScreen(p.x, p.y, view, W, H));
    if (it.type === 'area' && sp.length >= 3) {
      c.beginPath(); sp.forEach((p, i) => i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)); c.closePath();
      c.fillStyle = o.bg === 'white' ? 'rgba(217,72,15,.13)' : 'rgba(255,194,26,.16)';
      c.fill();
    }
    c.beginPath(); sp.forEach((p, i) => i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y));
    if (it.type === 'area' && sp.length >= 3) c.closePath();
    c.strokeStyle = halo; c.lineWidth = 4.5 * px; c.stroke();
    c.strokeStyle = col; c.lineWidth = 2 * px; c.stroke();
    for (const p of sp) {
      c.beginPath(); c.arc(p.x, p.y, 4 * px, 0, Math.PI * 2);
      c.fillStyle = col; c.fill(); c.lineWidth = 1.5 * px; c.strokeStyle = halo; c.stroke();
    }
    // 구간 길이 글씨
    c.font = '600 ' + Math.round(12 * px) + 'px ' + FONT;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    const segs = it.type === 'area' && it.pts.length >= 3 ? it.pts.length : it.pts.length - 1;
    for (let i = 0; i < segs; i++) {
      const a = it.pts[i], b = it.pts[(i + 1) % it.pts.length];
      const sa = sp[i], sb = sp[(i + 1) % sp.length];
      const pl = Math.hypot(sb.x - sa.x, sb.y - sa.y);
      if (pl < 60 * px) continue;
      let ang = Math.atan2(sb.y - sa.y, sb.x - sa.x);
      if (ang > Math.PI / 2) ang -= Math.PI; else if (ang < -Math.PI / 2) ang += Math.PI;
      c.save();
      c.translate((sa.x + sb.x) / 2, (sa.y + sb.y) / 2); c.rotate(ang); c.translate(0, -10 * px);
      label(c, fmtLen(Math.hypot(b.x - a.x, b.y - a.y)), 0, 0, col, halo, px);
      c.restore();
    }
    // 합계 / 면적
    if (it.type === 'dist' && it.pts.length > 2 && !it.live) {
      const e = sp[sp.length - 1];
      c.font = '700 ' + Math.round(13 * px) + 'px ' + FONT;
      label(c, '합 ' + fmtLen(polyLen(it.pts, false)), e.x, e.y - 18 * px, col, halo, px);
    }
    if (it.type === 'area' && it.pts.length >= 3) {
      let cx = 0, cy = 0;
      for (const p of sp) { cx += p.x; cy += p.y; }
      cx /= sp.length; cy /= sp.length;
      const a = fmtArea(polyArea(it.pts));
      c.font = '700 ' + Math.round(14 * px) + 'px ' + FONT;
      label(c, a.main, cx, cy - 9 * px, col, halo, px);
      c.font = '600 ' + Math.round(12 * px) + 'px ' + FONT;
      label(c, a.py, cx, cy + 9 * px, col, halo, px);
    }
  }
  // 커서와 스냅 표시
  const cr = state.meas.cursor;
  if (o.live && isMeasure() && cr) {
    const p = toScreen(cr.x, cr.y, view, W, H);
    const r = 7 * px;
    c.lineWidth = 2 * px;
    c.strokeStyle = halo; c.lineWidth = 4 * px; snapMark(c, p.x, p.y, r, cr.snap);
    c.strokeStyle = cr.snap >= 0 ? '#2BD576' : col; c.lineWidth = 2 * px; snapMark(c, p.x, p.y, r, cr.snap);
  }
}
function snapMark(c, x, y, r, k) {
  c.beginPath();
  if (k === 0) c.rect(x - r, y - r, r * 2, r * 2);
  else if (k === 1) { c.moveTo(x, y - r * 1.1); c.lineTo(x + r, y + r * 0.8); c.lineTo(x - r, y + r * 0.8); c.closePath(); }
  else if (k === 2) c.arc(x, y, r, 0, Math.PI * 2);
  else if (k === 4) { c.moveTo(x, y - r); c.lineTo(x + r, y); c.lineTo(x, y + r); c.lineTo(x - r, y); c.closePath(); }
  else if (k === 3) { c.moveTo(x - r, y - r); c.lineTo(x + r, y + r); c.moveTo(x + r, y - r); c.lineTo(x - r, y + r); }
  else { c.moveTo(x - r * 1.6, y); c.lineTo(x - r * 0.5, y); c.moveTo(x + r * 0.5, y); c.lineTo(x + r * 1.6, y); c.moveTo(x, y - r * 1.6); c.lineTo(x, y - r * 0.5); c.moveTo(x, y + r * 0.5); c.lineTo(x, y + r * 1.6); }
  c.stroke();
}
function label(c, text, x, y, col, halo, px) {
  c.lineWidth = 4 * px; c.strokeStyle = halo; c.lineJoin = 'round';
  c.strokeText(text, x, y);
  c.fillStyle = col; c.fillText(text, x, y);
}

// ---------------- 메모 (펜 · 구름 · 글자 · 지우개) ----------------
// 메모는 도면 좌표로 저장해서 확대/이동해도 그 자리에 붙어 있다.
function markColor(c, bg) { return c === 'fg' ? (bg === 'white' ? '#111111' : '#F2F4F5') : c; }
function wpt(p) { return toWorld(p.x, p.y); }

function markDown(p) {
  const mk = state.mk, w = wpt(p), s = state.view.s;
  state.eraseGroup = null;
  if (mk.tool === 'pen') state.draft = { k: 'pen', c: mk.color, w: mk.width * DPR / s, p: [w.x, w.y] };
  else if (mk.tool === 'cloud') state.draft = { k: 'cloud', c: mk.color, w: mk.width * DPR / s, b: [w.x, w.y, w.x, w.y], r: 11 * DPR / s };
  else if (mk.tool === 'erase') { state.eraseGroup = []; eraseAt(w); }
  requestDraw();
}
function markMove(p) {
  const d = state.draft, w = wpt(p);
  if (state.mk.tool === 'erase') { eraseAt(w); return; }
  if (!d) return;
  if (d.k === 'pen') {
    const lx = d.p[d.p.length - 2], ly = d.p[d.p.length - 1];
    if (Math.hypot(w.x - lx, w.y - ly) * state.view.s < 1.5 * DPR) return;
    d.p.push(w.x, w.y);
  } else if (d.k === 'cloud') { d.b[2] = w.x; d.b[3] = w.y; }
  requestDraw();
}
function markUp(p) {
  const d = state.draft, w = wpt(p);
  state.draft = null;
  const tool = state.mk.tool;
  if (tool === 'erase') {
    if (state.eraseGroup && state.eraseGroup.length) { state.history.push({ t: 'del', items: state.eraseGroup }); saveNotes(); }
    state.eraseGroup = null;
    requestDraw();
    return;
  }
  if (tool === 'text') {
    const moved = gest && Math.hypot(p.x - gest.start.x, p.y - gest.start.y);
    if (moved > 12) return;
    const hit = hitMark(w, (m) => m.k === 'text');
    openNote(hit ? { mark: hit } : { x: w.x, y: w.y });
    return;
  }
  if (!d) return;
  if (d.k === 'pen') {
    if (d.p.length === 2) d.p.push(d.p[0] + 0.01 / state.view.s, d.p[1]); // 점 하나
    addMark(d);
  } else if (d.k === 'cloud') {
    const b = d.b;
    b[2] = w.x; b[3] = w.y;
    if (Math.abs(b[2] - b[0]) * state.view.s < 10 * DPR || Math.abs(b[3] - b[1]) * state.view.s < 10 * DPR) { requestDraw(); return; }
    d.b = [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])];
    addMark(d);
  }
}
function addMark(m) {
  state.marks.push(m);
  state.history.push({ t: 'add', m });
  saveNotes();
  requestDraw();
}

function markBox(m) {
  if (m.k === 'pen') {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < m.p.length; i += 2) { x0 = Math.min(x0, m.p[i]); x1 = Math.max(x1, m.p[i]); y0 = Math.min(y0, m.p[i + 1]); y1 = Math.max(y1, m.p[i + 1]); }
    return [x0 - m.w, y0 - m.w, x1 + m.w, y1 + m.w];
  }
  if (m.k === 'cloud') return [m.b[0] - m.r, m.b[1] - m.r, m.b[2] + m.r, m.b[3] + m.r];
  const lines = m.t.split('\n');
  const len = lines.reduce((a, l) => Math.max(a, [...l].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e80 ? 1 : 0.6), 0)), 0);
  return [m.x - m.h * 0.3, m.y - lines.length * 1.3 * m.h - m.h * 0.3, m.x + len * m.h + m.h * 0.3, m.y + m.h * 0.3];
}
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  let t = L ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function markDist(m, w) {
  if (m.k === 'pen') {
    let d = Infinity;
    for (let i = 2; i < m.p.length; i += 2) d = Math.min(d, segDist(w.x, w.y, m.p[i - 2], m.p[i - 1], m.p[i], m.p[i + 1]));
    return d - m.w / 2;
  }
  if (m.k === 'cloud') {
    const [x0, y0, x1, y1] = m.b;
    return Math.min(segDist(w.x, w.y, x0, y0, x1, y0), segDist(w.x, w.y, x1, y0, x1, y1), segDist(w.x, w.y, x1, y1, x0, y1), segDist(w.x, w.y, x0, y1, x0, y0)) - m.r;
  }
  const b = markBox(m);
  return w.x >= b[0] && w.x <= b[2] && w.y >= b[1] && w.y <= b[3] ? 0 : Infinity;
}
function hitMark(w, filter) {
  const tol = 16 * DPR / state.view.s;
  let best = null, bd = tol;
  for (const m of state.marks) {
    if (filter && !filter(m)) continue;
    const d = markDist(m, w);
    if (d <= bd) { bd = d; best = m; }
  }
  return best;
}
function eraseAt(w) {
  const m = hitMark(w);
  if (!m) return;
  const i = state.marks.indexOf(m);
  state.marks.splice(i, 1);
  if (state.eraseGroup) state.eraseGroup.push([i, m]);
  requestDraw();
}

$('#kUndo').addEventListener('click', () => {
  const h = state.history.pop();
  if (!h) { toast('되돌릴 메모가 없어요.'); return; }
  if (h.t === 'add') { const i = state.marks.indexOf(h.m); if (i >= 0) state.marks.splice(i, 1); }
  else if (h.t === 'del') { for (const [i, m] of h.items.slice().reverse()) state.marks.splice(i, 0, m); }
  else if (h.t === 'clear') state.marks = h.marks;
  else if (h.t === 'edit') { h.m.t = h.old.t; h.m.c = h.old.c; }
  saveNotes(); requestDraw();
});
$('#kClear').addEventListener('click', () => {
  if (!state.marks.length) return;
  if (!confirm('메모를 모두 지울까요? (되돌리기로 살릴 수 있어요)')) return;
  state.history.push({ t: 'clear', marks: state.marks });
  state.marks = [];
  saveNotes(); requestDraw();
});
document.querySelectorAll('#kpanel .seg').forEach((seg) => {
  seg.addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    if (seg.dataset.k === 'tool') { state.mk.tool = b.dataset.v; markHint(); }
    else state.mk.width = parseFloat(b.dataset.v);
  });
});
document.querySelectorAll('#kpanel .colors button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('#kpanel .colors button').forEach((x) => x.classList.toggle('on', x === b));
  state.mk.color = b.dataset.c;
  if (state.mk.tool === 'erase') { state.mk.tool = 'pen'; document.querySelectorAll('#kpanel .ktools button').forEach((x) => x.classList.toggle('on', x.dataset.v === 'pen')); markHint(); }
}));
function markHint() {
  $('#khint').textContent = {
    pen: '한 손가락으로 그리기 · 두 손가락으로 옮기기/확대',
    cloud: '끌어서 수정 구름 표시를 그려요',
    text: '글자를 넣을 곳을 누르세요 · 써 둔 글자를 누르면 고쳐요',
    erase: '지울 메모를 문지르세요',
  }[state.mk.tool];
}

// 글자 메모 입력창
let noteCtx = null;
function openNote(o) {
  noteCtx = o;
  $('#noteTitle').textContent = o.mark ? '글자 메모 고치기' : '글자 메모';
  $('#noteText').value = o.mark ? o.mark.t : '';
  $('#noteDel').hidden = !o.mark;
  $('#note .actions').classList.toggle('three', !!o.mark);
  $('#note').hidden = false; $('#noteBack').hidden = false;
  setTimeout(() => $('#noteText').focus(), 50);
}
function closeNote() { $('#note').hidden = true; $('#noteBack').hidden = true; noteCtx = null; $('#noteText').blur(); }
$('#noteBack').addEventListener('click', closeNote);
$('#noteCancel').addEventListener('click', closeNote);
$('#noteOk').addEventListener('click', () => {
  const t = $('#noteText').value.replace(/\s+$/, '');
  const o = noteCtx;
  closeNote();
  if (!o) return;
  if (o.mark) {
    if (!t) { delMark(o.mark); return; }
    state.history.push({ t: 'edit', m: o.mark, old: { t: o.mark.t, c: o.mark.c } });
    o.mark.t = t; o.mark.c = state.mk.color;
    saveNotes(); requestDraw();
  } else if (t) {
    addMark({ k: 'text', c: state.mk.color, h: 16 * DPR / state.view.s, x: o.x, y: o.y, t });
  }
});
$('#noteDel').addEventListener('click', () => { const o = noteCtx; closeNote(); if (o && o.mark) delMark(o.mark); });
function delMark(m) {
  const i = state.marks.indexOf(m);
  if (i < 0) return;
  state.marks.splice(i, 1);
  state.history.push({ t: 'del', items: [[i, m]] });
  saveNotes(); requestDraw();
}

let saveTimer = 0;
function saveNotes() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!state.fileId) return;
    DB.putNotes(state.fileId, { marks: state.marks, meas: state.meas.done }).catch(() => {});
  }, 400);
}

function drawMarks(c, W, H, view, o) {
  const list = state.draft && o.live ? state.marks.concat([state.draft]) : state.marks;
  if (!list.length) return;
  const px = o.px, s = view.s;
  const halo = o.bg === 'white' ? 'rgba(255,255,255,.9)' : 'rgba(10,12,14,.85)';
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.setLineDash([]);
  c.lineCap = 'round'; c.lineJoin = 'round';
  const vx0 = view.cx - W / 2 / s, vx1 = view.cx + W / 2 / s, vy0 = view.cy - H / 2 / s, vy1 = view.cy + H / 2 / s;
  for (const m of list) {
    const b = markBox(m);
    if (b[2] < vx0 || b[0] > vx1 || b[3] < vy0 || b[1] > vy1) continue;
    const col = markColor(m.c, o.bg);
    if (m.k === 'pen') {
      c.beginPath();
      for (let i = 0; i < m.p.length; i += 2) {
        const q = toScreen(m.p[i], m.p[i + 1], view, W, H);
        if (i) c.lineTo(q.x, q.y); else c.moveTo(q.x, q.y);
      }
      c.strokeStyle = col; c.lineWidth = Math.max(m.w * s, 1.3 * px);
      c.stroke();
    } else if (m.k === 'cloud') {
      const a = toScreen(Math.min(m.b[0], m.b[2]), Math.max(m.b[1], m.b[3]), view, W, H); // 화면 왼쪽 위
      const z = toScreen(Math.max(m.b[0], m.b[2]), Math.min(m.b[1], m.b[3]), view, W, H); // 화면 오른쪽 아래
      const w = z.x - a.x, h = z.y - a.y;
      if (w < 1 || h < 1) continue;
      const r = Math.min(Math.max(m.r * s, 5 * px), Math.min(w, h) / 2);
      const pts = [[a.x, a.y], [z.x, a.y], [z.x, z.y], [a.x, z.y]];
      c.beginPath();
      for (let e = 0; e < 4; e++) {
        const [px0, py0] = pts[e], [px1, py1] = pts[(e + 1) % 4];
        const L = Math.hypot(px1 - px0, py1 - py0), n = Math.max(1, Math.round(L / (2 * r)));
        for (let k = 0; k < n; k++) {
          const ax = px0 + (px1 - px0) * k / n, ay = py0 + (py1 - py0) * k / n;
          const bx = px0 + (px1 - px0) * (k + 1) / n, by = py0 + (py1 - py0) * (k + 1) / n;
          const mx = (ax + bx) / 2, my = (ay + by) / 2, rr = Math.hypot(bx - ax, by - ay) / 2;
          c.arc(mx, my, rr, Math.atan2(ay - my, ax - mx), Math.atan2(by - my, bx - mx), false);
        }
      }
      c.closePath();
      c.strokeStyle = col; c.lineWidth = Math.max(m.w * s, 1.3 * px);
      c.stroke();
    } else if (m.k === 'text') {
      const q = toScreen(m.x, m.y, view, W, H);
      const fs = Math.max(m.h * s, 10 * px);
      c.font = '700 ' + fs.toFixed(1) + 'px ' + FONT;
      c.textBaseline = 'top'; c.textAlign = 'left';
      const lines = m.t.split('\n');
      lines.forEach((l, i) => {
        c.lineWidth = Math.max(3 * px, fs * 0.22); c.strokeStyle = halo;
        c.strokeText(l, q.x, q.y + i * fs * 1.3);
        c.fillStyle = col; c.fillText(l, q.x, q.y + i * fs * 1.3);
      });
    }
  }
}

// ---------------- 내보내기 ----------------
const exOpt = { fmt: 'pdf', range: 'view', paper: 'a4', bg: 'white', meas: '1' };
function openSheet() { $('#sheet').hidden = false; $('#sheetBack').hidden = false; }
function closeSheet() { $('#sheet').hidden = true; $('#sheetBack').hidden = true; }
$('#btnExport').addEventListener('click', () => {
  if (state.meas.pts.length) finishMeasure();
  $('#optPaper').hidden = exOpt.fmt !== 'pdf';
  openSheet();
});
$('#sheetBack').addEventListener('click', closeSheet);
document.querySelectorAll('#sheet .seg').forEach((seg) => {
  seg.addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    exOpt[seg.dataset.k] = b.dataset.v;
    $('#optPaper').hidden = exOpt.fmt !== 'pdf';
  });
});

function baseName() { return (state.file ? state.file.name : '도면').replace(/\.(dwg|dxf)$/i, ''); }

async function makeExport() {
  const sc = state.scene;
  const bg = exOpt.bg === 'white' ? 'white' : state.bg;
  // 보여줄 도면 범위
  let box;
  if (exOpt.range === 'all') {
    const f = sc.fit, mw = (f[2] - f[0]) * 0.03, mh = (f[3] - f[1]) * 0.03;
    box = [f[0] - mw, f[1] - mh, f[2] + mw, f[3] + mh];
    if (exOpt.meas === '1') {
      for (const d of state.meas.done) for (const p of d.pts) { box[0] = Math.min(box[0], p.x); box[1] = Math.min(box[1], p.y); box[2] = Math.max(box[2], p.x); box[3] = Math.max(box[3], p.y); }
      for (const m of state.marks) { const b = markBox(m); box[0] = Math.min(box[0], b[0]); box[1] = Math.min(box[1], b[1]); box[2] = Math.max(box[2], b[2]); box[3] = Math.max(box[3], b[3]); }
    }
  } else {
    const v = state.view;
    box = [v.cx - CW / 2 / v.s, v.cy - CH / 2 / v.s, v.cx + CW / 2 / v.s, v.cy + CH / 2 / v.s];
  }
  const bw = box[2] - box[0], bh = box[3] - box[1];
  let W, H, footer;
  if (exOpt.fmt === 'pdf') {
    const land = bw >= bh;
    const [pw, ph] = exOpt.paper === 'a3' ? [420, 297] : [297, 210];
    const pageW = land ? pw : ph, pageH = land ? ph : pw;
    const dpmm = exOpt.paper === 'a3' ? 9.5 : 12; // 약 240~300dpi
    W = Math.round((pageW - 20) * dpmm); H = Math.round((pageH - 20) * dpmm);
    footer = Math.round(7 * dpmm);
    var page = { w: pageW, h: pageH, land };
  } else {
    const long = 3600;
    if (bw >= bh) { W = long; H = Math.max(600, Math.round(long * bh / bw)); } else { H = long; W = Math.max(600, Math.round(long * bw / bh)); }
    footer = Math.round(Math.max(W, H) * 0.022);
    H += footer;
  }
  const drawH = H - footer;
  const s = Math.min(W / bw, drawH / bh);
  const view = { s, cx: (box[0] + box[2]) / 2, cy: (box[1] + box[3]) / 2 };
  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const c = out.getContext('2d', { alpha: false });
  const px = Math.max(1, Math.max(W, H) / 1400);
  // 도면 영역
  c.save();
  c.beginPath(); c.rect(0, 0, W, drawH); c.clip();
  drawScene(c, W, drawH, view, { bg, lw: px * 0.9, px });
  if (exOpt.meas === '1') {
    const saved = state.meas.cursor; state.meas.cursor = null;
    drawOverlay(c, W, drawH, view, { bg, px: px * 1.7, live: false });
    state.meas.cursor = saved;
  }
  c.restore();
  // 아래 정보 줄
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.fillStyle = bg === 'white' ? '#FFFFFF' : '#1A1E21';
  c.fillRect(0, drawH, W, footer);
  c.fillStyle = bg === 'white' ? '#222' : '#ddd';
  c.fillRect(0, drawH, W, Math.max(1, px * 0.8));
  c.font = '600 ' + Math.round(footer * 0.42) + 'px ' + FONT;
  c.textBaseline = 'middle'; c.textAlign = 'left';
  c.fillText(state.file ? state.file.name : '', footer * 0.4, drawH + footer / 2);
  c.textAlign = 'right';
  const d = new Date();
  c.font = Math.round(footer * 0.36) + 'px ' + FONT;
  c.fillText('상규 도면뷰어 · ' + d.getFullYear() + '.' + (d.getMonth() + 1) + '.' + d.getDate() + ' · 축척 없음', W - footer * 0.4, drawH + footer / 2);

  if (exOpt.fmt === 'png') {
    const blob = await new Promise((r) => out.toBlob(r, 'image/png'));
    return { blob, name: baseName() + '.png', mime: 'image/png' };
  }
  await jspdfReady();
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: page.land ? 'l' : 'p', unit: 'mm', format: exOpt.paper });
  doc.addImage(out, 'PNG', 10, 10, page.w - 20, page.h - 20, undefined, 'FAST');
  const blob = doc.output('blob');
  return { blob, name: baseName() + '.pdf', mime: 'application/pdf' };
}
function jspdfReady() {
  return new Promise((res) => {
    const chk = () => (window.jspdf ? res() : setTimeout(chk, 50));
    chk();
  });
}

async function doExport(action) {
  closeSheet();
  busy(true, exOpt.fmt === 'pdf' ? 'PDF 만드는 중…' : '사진 만드는 중…');
  try {
    await new Promise((r) => setTimeout(r, 30));
    const f = await makeExport();
    if (NATIVE) {
      const res = await sendToNative(f, action);
      if (res === 'err') toast('저장하지 못했어요.');
      else if (action === 'save') toast('저장했어요: ' + (res.split(':')[1] || '다운로드'));
    } else if (action === 'share' && navigator.canShare && navigator.canShare({ files: [new File([f.blob], f.name, { type: f.mime })] })) {
      try { await navigator.share({ files: [new File([f.blob], f.name, { type: f.mime })], title: f.name }); } catch (e) {}
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(f.blob); a.download = f.name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 20000);
      toast('내려받기를 시작했어요.');
    }
  } catch (e) {
    console.error(e);
    toast('내보내기에 실패했어요: ' + (e.message || e));
  } finally { busy(false); }
}
$('#exSave').addEventListener('click', () => doExport('save'));
$('#exShare').addEventListener('click', () => doExport('share'));

async function sendToNative(f, action) {
  const id = NATIVE.begin(f.name, f.mime);
  if (!id) return 'err';
  const buf = new Uint8Array(await f.blob.arrayBuffer());
  const CH = 384 * 1024;
  for (let i = 0; i < buf.length; i += CH) {
    const part = buf.subarray(i, i + CH);
    let bin = '';
    for (let j = 0; j < part.length; j += 0x8000) bin += String.fromCharCode.apply(null, part.subarray(j, j + 0x8000));
    if (!NATIVE.append(id, btoa(bin))) return 'err';
  }
  return NATIVE.finish(id, action);
}

// ---------------- 뒤로 가기 (안드로이드) ----------------
window.__onBack = () => {
  if (!$('#note').hidden) { closeNote(); return true; }
  if (!$('#sheet').hidden) { closeSheet(); return true; }
  if (!$('#viewer').hidden) {
    if (state.mode !== 'pan') {
      if (state.meas.pts.length) { state.meas.pts = []; updatePanel(); requestDraw(); return true; }
      setMode('pan'); return true;
    }
    showViewer(false); return true;
  }
  return false;
};

// ---------------- 시작 ----------------
showRecent();
if (NATIVE && NATIVE.pending) {
  try {
    const p = NATIVE.pending();
    if (p) { const o = JSON.parse(p); window.__openUrl(o.url, o.name); }
  } catch (e) {}
}
// 테스트용: ?open=주소
(() => {
  const q = new URLSearchParams(location.search).get('open');
  if (q) window.__openUrl(q, decodeURIComponent(q.split('/').pop()));
})();
