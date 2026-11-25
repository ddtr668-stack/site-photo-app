// 도면 해석 워커: DWG/DXF → 화면에 그리기 쉬운 형태(선·면·글자·스냅점)로 바꾼다.
// LibreDWG(WebAssembly)로 파일을 읽고, 블록·치수·해치까지 펼쳐서 넘긴다.
import { LibreDwg, Dwg_File_Type } from './vendor/libredwg/dist/libredwg-web.js';

let libPromise = null;
function getLib() {
  if (!libPromise) libPromise = LibreDwg.create(new URL('./vendor/libredwg/wasm', import.meta.url).href);
  return libPromise;
}

self.onmessage = async (ev) => {
  const { id, buf } = ev.data;
  const say = (t) => self.postMessage({ id, progress: t });
  try {
    say('엔진 준비 중…');
    const lib = await getLib();
    const bytes = new Uint8Array(buf);
    const kind = sniff(bytes);
    if (kind === 'unknown') throw userError('DWG·DXF 파일이 아니에요.');
    if (kind === 'old') throw userError('너무 오래된 DWG 형식(R11 이전)이라 열 수 없어요. 캐드에서 2000 이상 버전으로 저장해 주세요.');
    say('도면 읽는 중…');
    let data;
    const warn = console.warn;
    console.warn = () => {};
    try {
      data = lib.dwg_read_data(bytes, kind === 'dxf' ? Dwg_File_Type.DXF : Dwg_File_Type.DWG);
    } finally { console.warn = warn; }
    if (!data) throw userError('도면을 읽지 못했어요. 파일이 손상됐거나 지원하지 않는 형식일 수 있어요.');
    let db;
    try { db = lib.convert(data); } finally { try { lib.dwg_free(data); } catch (e) {} }
    say('도면 정리 중…');
    const model = build(db);
    model.version = kind === 'dxf' ? 'DXF' : String.fromCharCode(...bytes.subarray(0, 6));
    if (!model.count) throw userError('도면에 표시할 내용이 없어요. (모형 공간이 비어 있음)');
    self.postMessage({ id, ok: true, model }, model.transfer);
  } catch (e) {
    self.postMessage({ id, ok: false, error: e && e.user ? e.message : '도면을 열지 못했어요. (' + (e && e.message || e) + ')' });
  }
};

function userError(m) { const e = new Error(m); e.user = true; return e; }

function sniff(b) {
  const head = String.fromCharCode(...b.subarray(0, 32));
  if (/^AC10\d\d/.test(head)) {
    const v = parseInt(head.slice(4, 6), 10);
    return v < 9 ? 'old' : 'dwg';
  }
  if (head.startsWith('AutoCAD Binary DXF')) return 'dxf';
  const t = head.replace(/^﻿/, '').trimStart();
  if (/^0\s*[\r\n]+\s*(SECTION|SECTION)/i.test(t) || /^999/.test(t) || /^0\s*$/m.test(t.slice(0, 4))) return 'dxf';
  return 'unknown';
}

// ---------- 색 ----------
// ACI(캐드 색 번호) → RGB. 7번(흰/검)은 배경에 따라 바뀌므로 -1로 둔다.
const ACI = (() => {
  const t = new Array(256).fill(0);
  const base = [0, 0xFF0000, 0xFFFF00, 0x00FF00, 0x00FFFF, 0x0000FF, 0xFF00FF, -1, 0x808080, 0xC0C0C0];
  for (let i = 0; i < 10; i++) t[i] = base[i];
  const vals = [255, 204, 153, 127, 76];
  for (let i = 10; i < 250; i++) {
    const hue = Math.floor((i - 10) / 10) * 15;
    const j = i % 10;
    const v = vals[Math.floor(j / 2)] / 255;
    const s = j % 2 === 0 ? 1 : 0.5;
    t[i] = hsvToRgb(hue, s, v);
  }
  const grays = [0x33, 0x50, 0x69, 0x82, 0xBE, 0xFF];
  for (let i = 0; i < 6; i++) t[250 + i] = grays[i] * 0x10101;
  return t;
})();
function hsvToRgb(h, s, v) {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0]; else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x]; else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x];
  return (Math.round((r + m) * 255) << 16) | (Math.round((g + m) * 255) << 8) | Math.round((b + m) * 255);
}
const FG = -1, BG = -2;

// ---------- 늘어나는 배열 ----------
class F64 {
  constructor(n = 4096) { this.a = new Float64Array(n); this.n = 0; }
  push(v) { if (this.n >= this.a.length) this.grow(1); this.a[this.n++] = v; }
  grow(k) { let m = this.a.length * 2; while (m < this.n + k) m *= 2; const b = new Float64Array(m); b.set(this.a.subarray(0, this.n)); this.a = b; }
  pushArr(arr) { if (this.n + arr.length > this.a.length) this.grow(arr.length); for (let i = 0; i < arr.length; i++) this.a[this.n++] = arr[i]; }
  out() { return this.a.slice(0, this.n); }
}

// ---------- 행렬 [a,b,c,d,e,f]: x' = a x + c y + e, y' = b x + d y + f ----------
const I = [1, 0, 0, 1, 0, 0];
function mul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
const T = (x, y) => [1, 0, 0, 1, x, y];
const R = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, s, -s, c, 0, 0]; };
const S = (x, y) => [x, 0, 0, y, 0, 0];
function ocs(e) {
  const n = e.extrusionDirection || e.normal;
  return n && n.z < -0.5 ? [-1, 0, 0, 1, 0, 0] : I;
}
function scaleOf(m) { return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1; }

// ---------- 곡선을 점으로 ----------
const TAU = Math.PI * 2;
function arcPts(cx, cy, r, a0, a1, out) {
  let sw = a1 - a0;
  while (sw <= 0) sw += TAU;
  while (sw > TAU + 1e-9) sw -= TAU;
  const n = Math.max(4, Math.ceil(sw / TAU * 96));
  for (let i = 0; i <= n; i++) {
    const a = a0 + sw * i / n;
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  return out;
}
function bulgePts(x1, y1, x2, y2, b, out) {
  // 시작점은 이미 들어가 있다고 보고 이후 점만 추가
  if (!b || Math.abs(b) < 1e-9) { out.push(x2, y2); return; }
  const dx = x2 - x1, dy = y2 - y1, chord = Math.hypot(dx, dy);
  if (chord < 1e-12) { out.push(x2, y2); return; }
  const theta = 4 * Math.atan(b);
  const r = chord / (2 * Math.sin(theta / 2));
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  const h = r * Math.cos(theta / 2); // 중심까지 거리(부호 포함)
  const nx = -dy / chord, ny = dx / chord;
  const cx = mx + nx * h, cy = my + ny * h;
  const a0 = Math.atan2(y1 - cy, x1 - cx);
  const n = Math.max(2, Math.ceil(Math.abs(theta) / TAU * 96));
  const rr = Math.abs(r);
  for (let i = 1; i <= n; i++) {
    const a = a0 + theta * i / n;
    out.push(cx + rr * Math.cos(a), cy + rr * Math.sin(a));
  }
}
function polyPts(verts, closed) {
  const out = [];
  const n = verts.length;
  if (!n) return out;
  out.push(verts[0].x, verts[0].y);
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = verts[i], b = verts[(i + 1) % n];
    bulgePts(a.x, a.y, b.x, b.y, a.bulge || 0, out);
  }
  return out;
}
function ellipsePts(cx, cy, mx, my, ratio, t0, t1, flip, out) {
  // 단축 방향: 법선이 +Z면 (-my, mx), -Z면 (my, -mx)
  const nx = flip ? my : -my, ny = flip ? -mx : mx;
  let sw = t1 - t0;
  while (sw <= 0) sw += TAU;
  if (sw > TAU + 1e-9) sw = TAU;
  const n = Math.max(8, Math.ceil(sw / TAU * 120));
  for (let i = 0; i <= n; i++) {
    const t = t0 + sw * i / n, c = Math.cos(t), s = Math.sin(t);
    out.push(cx + mx * c + nx * ratio * s, cy + my * c + ny * ratio * s);
  }
  return out;
}
function bspline(ctrl, degree, knots, weights, out) {
  const n = ctrl.length;
  if (n < 2) return out;
  let p = Math.min(degree || 3, n - 1);
  let k = knots && knots.length === n + p + 1 ? knots : null;
  if (!k) { // 균일 clamped 매듭 만들기
    k = [];
    for (let i = 0; i <= p; i++) k.push(0);
    for (let i = 1; i < n - p; i++) k.push(i / (n - p));
    for (let i = 0; i <= p; i++) k.push(1);
  }
  const w = weights && weights.length === n ? weights : null;
  const lo = k[p], hi = k[n];
  const steps = Math.min(2000, Math.max(16, (n - p) * 16));
  for (let s = 0; s <= steps; s++) {
    let u = lo + (hi - lo) * s / steps;
    if (s === steps) u = hi - 1e-10 * (hi - lo || 1);
    let span = p;
    while (span < n - 1 && u >= k[span + 1]) span++;
    const d = [];
    for (let j = 0; j <= p; j++) {
      const c = ctrl[span - p + j], ww = w ? w[span - p + j] : 1;
      d.push([c.x * ww, c.y * ww, ww]);
    }
    for (let r = 1; r <= p; r++) {
      for (let j = p; j >= r; j--) {
        const i = span - p + j;
        const den = k[i + p - r + 1] - k[i];
        const a = den ? (u - k[i]) / den : 0;
        d[j] = [(1 - a) * d[j - 1][0] + a * d[j][0], (1 - a) * d[j - 1][1] + a * d[j][1], (1 - a) * d[j - 1][2] + a * d[j][2]];
      }
    }
    const q = d[p];
    out.push(q[0] / q[2], q[1] / q[2]);
  }
  return out;
}
function catmull(pts, closed, out) {
  const n = pts.length;
  if (n < 2) return out;
  if (n === 2) { out.push(pts[0].x, pts[0].y, pts[1].x, pts[1].y); return out; }
  const get = (i) => closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))];
  const segs = closed ? n : n - 1;
  out.push(pts[0].x, pts[0].y);
  for (let i = 0; i < segs; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    for (let s = 1; s <= 12; s++) {
      const t = s / 12, t2 = t * t, t3 = t2 * t;
      out.push(
        0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3));
    }
  }
  return out;
}
function xf(m, pts) {
  const out = new Array(pts.length);
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i], y = pts[i + 1];
    out[i] = m[0] * x + m[2] * y + m[4];
    out[i + 1] = m[1] * x + m[3] * y + m[5];
  }
  return out;
}

// ---------- 글자 특수 코드 ----------
function plainText(s) {
  if (!s) return '';
  return String(s)
    .replace(/%%[cC]/g, 'Ø').replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±')
    .replace(/%%[uUoOkK]/g, '').replace(/%%(\d{3})/g, (_, d) => String.fromCharCode(+d)).replace(/%%%/g, '%');
}
function mtextLines(s) {
  if (!s) return [];
  let t = String(s)
    .replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\M\+[0-9A-Fa-f](..)(..)/g, '')
    .replace(/\\\\/g, '\u0001')
    .replace(/\\[{}]/g, (m) => m === '\\{' ? '\u0002' : '\u0003')
    .replace(/\\P/g, '\n')
    .replace(/\\S([^;]*?)[\^#/]([^;]*?);/g, '$1/$2')
    .replace(/\\[Ff][^;]*;/g, '')
    .replace(/\\[HhWwQqTtAaCcp][^;\\]*;/g, '')
    .replace(/\\c\d+;/g, '')
    .replace(/\\[LlOoKk]/g, '')
    .replace(/\\~/g, ' ')
    .replace(/\\X/g, '\n')
    .replace(/\\N/g, '\n')
    .replace(/[{}]/g, '')
    .replace(/\u0001/g, '\\').replace(/\u0002/g, '{').replace(/\u0003/g, '}');
  t = plainText(t);
  return t.split('\n').map((x) => x.replace(/\s+$/, ''));
}

// ---------- 본 작업 ----------
function build(db) {
  const H = db.header || {};
  const tables = db.tables || {};
  const layers = new Map();
  for (const l of (tables.LAYER && tables.LAYER.entries) || []) {
    let ci = l.colorIndex;
    let color;
    if (ci != null && Math.abs(ci) >= 1 && Math.abs(ci) <= 255) color = ACI[Math.abs(ci)];
    else if (l.color != null && l.color !== 0xffffff) color = l.color;
    else color = FG;
    const off = !!l.off || (ci != null && ci < 0) || !!l.frozen;
    layers.set(l.name, { color, ltype: l.lineType || 'Continuous', off });
  }
  const ltypes = new Map();
  for (const lt of (tables.LTYPE && tables.LTYPE.entries) || []) ltypes.set(String(lt.name).toUpperCase(), lt);
  const blocksByName = new Map(), blocksByHandle = new Map();
  let model = null;
  for (const b of (tables.BLOCK_RECORD && tables.BLOCK_RECORD.entries) || []) {
    blocksByName.set(b.name, b);
    blocksByName.set(String(b.name).toUpperCase(), b);
    blocksByHandle.set(String(b.handle).toUpperCase(), b);
    if (/^\*model_space$/i.test(b.name)) model = b;
  }
  const LTSCALE = H.LTSCALE > 0 ? H.LTSCALE : 1;
  const dimScale = H.DIMSCALE > 0 ? H.DIMSCALE : 1;
  const arrowSize = (H.DIMASZ > 0 ? H.DIMASZ : 2.5) * dimScale;

  const colors = [], colorIdx = new Map();
  const cidx = (c) => { let i = colorIdx.get(c); if (i == null) { i = colors.length; colors.push(c); colorIdx.set(c, i); } return i; };
  const styles = [], styleIdx = new Map();
  const sidx = (c, dash, w) => {
    const key = c + '|' + (dash ? dash.map((v) => +v.toPrecision(5)).join(',') : '') + '|' + (w ? +w.toPrecision(5) : 0);
    let i = styleIdx.get(key);
    if (i == null) { i = styles.length; styles.push({ c: cidx(c), dash, w: w || 0 }); styleIdx.set(key, i); }
    return i;
  };

  const pl = new F64(1 << 16), fill = new F64(1 << 12), snaps = new F64(1 << 14);
  const snapKinds = [];
  const texts = [], patterns = [], xlines = [];
  let count = 0;
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  const samples = [];
  const addBox = (x, y) => { if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; };
  const MAX_SNAPS = 1500000;
  const snap = (x, y, k) => { if (snapKinds.length < MAX_SNAPS && isFinite(x) && isFinite(y)) { snaps.push(x); snaps.push(y); snapKinds.push(k); } };

  function emitLine(pts, closed, style) {
    const n = pts.length / 2;
    if (n < 2) return;
    let ok = true;
    for (let i = 0; i < pts.length; i++) if (!isFinite(pts[i])) { ok = false; break; }
    if (!ok) return;
    pl.push(style); pl.push(n); pl.push(closed ? 1 : 0);
    pl.pushArr(pts);
    for (let i = 0; i < pts.length; i += 2) addBox(pts[i], pts[i + 1]);
    if (samples.length < 400000) { const step = Math.max(2, Math.floor(pts.length / 16) * 2); for (let i = 0; i < pts.length; i += step) samples.push(pts[i], pts[i + 1]); samples.push(pts[pts.length - 2], pts[pts.length - 1]); }
    count++;
  }
  function emitFill(rings, c) {
    rings = rings.filter((r) => r.length >= 6 && r.every(isFinite));
    if (!rings.length) return;
    fill.push(cidx(c)); fill.push(rings.length);
    for (const r of rings) { fill.push(r.length / 2); fill.pushArr(r); for (let i = 0; i < r.length; i += 2) addBox(r[i], r[i + 1]); }
    count++;
  }
  function snapPts(pts, closed, mids) {
    for (let i = 0; i < pts.length; i += 2) snap(pts[i], pts[i + 1], 0);
    if (mids) {
      const n = pts.length / 2, segs = closed ? n : n - 1;
      for (let i = 0; i < segs; i++) {
        const j = ((i + 1) % n) * 2;
        snap((pts[i * 2] + pts[j]) / 2, (pts[i * 2 + 1] + pts[j + 1]) / 2, 1);
      }
    }
  }

  function decodeRaw(raw) { // MLEADER 색
    if (raw == null) return null;
    const m = (raw >>> 24) & 0xff;
    if (m === 0xc2) return { rgb: raw & 0xffffff };
    if (m === 0xc3) return { aci: raw & 0xff };
    if (m === 0xc1) return { aci: 0 };
    return { aci: 256 };
  }
  function resolve(e, ctx) {
    let layerName = e.layer || '0';
    if (layerName === '0' && ctx.layer) layerName = ctx.layer;
    const L = layers.get(layerName);
    if (L && L.off) return null;
    let c;
    if (e.color != null && e.color >= 0 && e.color <= 0xffffff) c = e.color;
    if (c == null) {
      const ci = e.colorIndex == null ? 256 : e.colorIndex;
      if (ci === 0) c = ctx.color;
      else if (ci >= 1 && ci <= 255) c = ACI[ci];
      else c = L ? L.color : FG;
    }
    // 선 종류
    let lt = e.lineType || '';
    if (!lt || /^bylayer$/i.test(lt)) lt = L ? L.ltype : 'Continuous';
    else if (/^byblock$/i.test(lt)) lt = ctx.ltype || 'Continuous';
    return { c, layer: layerName, lt, lts: (e.lineTypeScale > 0 ? e.lineTypeScale : 1) };
  }
  function dashFor(r, ctx) {
    if (!r.lt || /^continuous$/i.test(r.lt)) return null;
    const def = ltypes.get(String(r.lt).toUpperCase());
    if (!def || !def.pattern || !def.pattern.length) return null;
    const k = LTSCALE * r.lts * ctx.ls;
    // 캔버스 점선 배열: [선, 틈, 선, 틈 …]. 길이 0인 선은 '점'.
    const out = [];
    let lead = 0;
    for (const p of def.pattern) {
      const v = p.elementLength || 0;
      const len = Math.abs(v) * k;
      const on = v >= 0;
      if (out.length % 2 === 0) { // 선을 기다리는 중
        if (on) out.push(len);
        else if (!out.length) lead += len;
        else out[out.length - 1] += len;
      } else { // 틈을 기다리는 중
        if (!on) out.push(len);
        else out[out.length - 1] += len;
      }
    }
    if (!out.length) return null;
    if (lead) { if (out.length % 2) out.push(lead); else out[out.length - 1] += lead; }
    if (out.length % 2) out.push(0);
    const total = out.reduce((a, b) => a + b, 0);
    if (!(total > 0)) return null;
    let gaps = 0;
    for (let i = 1; i < out.length; i += 2) gaps += out[i];
    if (!(gaps > 0)) return null;
    return out;
  }

  function line(pts, closed, r, ctx, w, mids = true) {
    const st = sidx(r.c, dashFor(r, ctx), w);
    emitLine(pts, closed, st);
    snapPts(pts, closed, mids);
  }

  function textItem(e, base, m, r, kind) {
    // m: 글자 로컬(높이 1 단위) → 월드
    texts.push({ m, s: kind, c: cidx(r.c), ...base });
    count++;
    // 대략적인 글자 영역을 범위에 넣기
    const lines = Array.isArray(base.t) ? base.t : [base.t];
    const len = lines.reduce((a, l) => Math.max(a, [...l].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e80 ? 1.25 : 0.75), 0)), 0);
    const wdt = base.fitW || (base.wrap ? Math.min(base.wrap, len) : len);
    const hgt = kind === 'm' ? 1 + (lines.length - 1) * 1.667 * (base.ls || 1) : 1;
    const x0 = -base.fx * wdt, x1 = x0 + wdt;
    const y1 = base.vy === 'top' ? 0 : base.vy === 'mid' ? hgt / 2 : base.vy === 'bottom' ? hgt : 1;
    const y0 = y1 - hgt - 0.3;
    const c = xf(m, [x0, y0, x1, y0, x1, y1, x0, y1]);
    for (let i = 0; i < 8; i += 2) addBox(c[i], c[i + 1]);
    if (samples.length < 400000) samples.push(m[4], m[5]);
  }

  function doText(e, tb, ctx) {
    const r = resolve(e, ctx);
    if (!r) return;
    const str = plainText(tb.text);
    if (!str.trim()) return;
    const h = tb.textHeight > 0 ? tb.textHeight : 1;
    const style = styleOf(tb.styleName);
    const wf = (tb.xScale > 0 ? tb.xScale : (style ? style.widthFactor : 1)) || 1;
    const obl = tb.obliqueAngle || 0;
    const ha = tb.halign || 0, va = tb.valign || 0;
    const useAlign = (ha !== 0 || va !== 0) && tb.endPoint && (tb.endPoint.x !== 0 || tb.endPoint.y !== 0 || ha === 3 || ha === 5);
    let px = tb.startPoint.x, py = tb.startPoint.y, rot = tb.rotation || 0, fitW = 0;
    let fx = 0, vy = 'base';
    if (ha === 3 || ha === 5) {
      const ex = tb.endPoint.x, ey = tb.endPoint.y;
      const d = Math.hypot(ex - px, ey - py);
      if (d > 1e-9) { rot = Math.atan2(ey - py, ex - px); fitW = d / h; }
    } else if (useAlign) {
      px = tb.endPoint.x; py = tb.endPoint.y;
      fx = ha === 1 || ha === 4 ? 0.5 : ha === 2 ? 1 : 0;
      vy = ha === 4 ? 'mid' : va === 1 ? 'bottom' : va === 2 ? 'mid' : va === 3 ? 'top' : 'base';
    }
    let lm = mul(T(px, py), mul(R(rot), mul([1, 0, Math.tan(obl), 1, 0, 0], S(h * wf, h))));
    const gf = tb.generationFlag || 0;
    if (gf & 2) lm = mul(lm, S(-1, 1));
    if (gf & 4) lm = mul(lm, S(1, -1));
    const m = mul(mul(ctx.m, ocs(tb.extrusionDirection ? tb : e)), lm);
    textItem(e, { t: str, fx, vy, fitW: fitW ? fitW / wf : 0, w: wf }, m, r, 't');
    snap(m[4], m[5], 3);
  }
  const stylesTbl = new Map();
  for (const s of (tables.STYLE && tables.STYLE.entries) || []) stylesTbl.set(String(s.name).toUpperCase(), s);
  function styleOf(n) { return n ? stylesTbl.get(String(n).toUpperCase()) : null; }

  function doMText(e, ctx, opt) {
    const r = resolve(e, ctx);
    if (!r) return;
    const lines = mtextLines(opt ? opt.text : e.text);
    if (!lines.some((l) => l.trim())) return;
    const h = (opt ? opt.h : e.textHeight) || 1;
    const ip = opt ? opt.p : e.insertionPoint;
    let rot;
    const dir = opt ? opt.dir : e.direction;
    if (dir && (Math.abs(dir.x) > 1e-9 || Math.abs(dir.y) > 1e-9)) rot = Math.atan2(dir.y, dir.x);
    else rot = (opt ? opt.rot : e.rotation) || 0;
    const ap = (opt ? opt.ap : e.attachmentPoint) || 1;
    const fx = [0, 0, 0.5, 1][((ap - 1) % 3) + 1];
    const vy = ap <= 3 ? 'top' : ap <= 6 ? 'mid' : 'bottom';
    const style = styleOf(opt ? null : e.styleName);
    const wf = style && style.widthFactor > 0 ? style.widthFactor : 1;
    const ww = opt ? opt.w : e.rectWidth;
    const lm = mul(T(ip.x, ip.y), mul(R(rot), S(h * wf, h)));
    const m = mul(ctx.m, lm);
    const ls = (opt ? opt.ls : e.lineSpacing) || 1;
    textItem(e, { t: lines, fx, vy, wrap: ww > 0 ? ww / (h * wf) : 0, ls: ls > 0 && ls < 10 ? ls : 1, w: wf }, m, r, 'm');
    snap(m[4], m[5], 3);
  }

  function arrow(x0, y0, x1, y1, size, c) {
    const d = Math.hypot(x1 - x0, y1 - y0);
    if (d < 1e-12 || !(size > 0)) return;
    const ux = (x1 - x0) / d, uy = (y1 - y0) / d;
    const bx = x0 + ux * size, by = y0 + uy * size, w = size / 6;
    emitFill([[x0, y0, bx - uy * w, by + ux * w, bx + uy * w, by - ux * w]], c);
  }

  function hatchRings(e) {
    const rings = [];
    for (const bp of e.boundaryPaths || []) {
      let pts = [];
      if (bp.vertices) {
        pts = polyPts(bp.vertices.map((v) => ({ x: v.x, y: v.y, bulge: bp.hasBulge ? v.bulge : 0 })), true);
      } else if (bp.edges) {
        for (const ed of bp.edges) {
          const seg = [];
          if (ed.type === 1) seg.push(ed.start.x, ed.start.y, ed.end.x, ed.end.y);
          else if (ed.type === 2) {
            if (ed.isCCW === false || ed.isCCW === 0) {
              const tmp = [];
              arcPts(ed.center.x, ed.center.y, ed.radius, -ed.endAngle, -ed.startAngle, tmp);
              for (let i = tmp.length - 2; i >= 0; i -= 2) seg.push(tmp[i], tmp[i + 1]);
            } else arcPts(ed.center.x, ed.center.y, ed.radius, ed.startAngle, ed.endAngle, seg);
          } else if (ed.type === 3) {
            const ratio = ed.lengthOfMinorAxis > 0 && ed.lengthOfMinorAxis <= 1 ? ed.lengthOfMinorAxis : (ed.lengthOfMinorAxis > 1 ? ed.lengthOfMinorAxis / Math.hypot(ed.end.x, ed.end.y) : 1);
            if (ed.isCCW === false || ed.isCCW === 0) {
              const tmp = [];
              ellipsePts(ed.center.x, ed.center.y, ed.end.x, ed.end.y, ratio, -ed.endAngle, -ed.startAngle, false, tmp);
              for (let i = tmp.length - 2; i >= 0; i -= 2) seg.push(tmp[i], tmp[i + 1]);
            } else ellipsePts(ed.center.x, ed.center.y, ed.end.x, ed.end.y, ratio, ed.startAngle, ed.endAngle, false, seg);
          } else if (ed.type === 4) {
            if (ed.controlPoints && ed.controlPoints.length >= 2) {
              const w = ed.controlPoints.some((p) => p.weight != null && p.weight !== 1) ? ed.controlPoints.map((p) => p.weight || 1) : null;
              bspline(ed.controlPoints, ed.degree, ed.knots, w, seg);
            } else if (ed.fitDatum && ed.fitDatum.length) catmull(ed.fitDatum, false, seg);
          }
          if (!seg.length) continue;
          // 이어 붙이기 (뒤집힌 조각이면 뒤집기)
          if (pts.length) {
            const lx = pts[pts.length - 2], ly = pts[pts.length - 1];
            const dStart = Math.hypot(seg[0] - lx, seg[1] - ly);
            const dEnd = Math.hypot(seg[seg.length - 2] - lx, seg[seg.length - 1] - ly);
            if (dEnd < dStart * 0.5) {
              const rev = [];
              for (let i = seg.length - 2; i >= 0; i -= 2) rev.push(seg[i], seg[i + 1]);
              seg.splice(0, seg.length, ...rev);
            }
            const tol = 1e-9 * (Math.abs(lx) + Math.abs(ly) + 1);
            if (Math.hypot(seg[0] - lx, seg[1] - ly) <= tol) seg.splice(0, 2);
          }
          for (const v of seg) pts.push(v);
        }
      }
      if (pts.length >= 6) rings.push(pts);
    }
    return rings;
  }

  function doHatch(e, ctx) {
    const r = resolve(e, ctx);
    if (!r) return;
    const rings = hatchRings(e);
    if (!rings.length) return;
    const m = mul(ctx.m, ocs(e));
    const solid = e.solidFill === 1 || /^solid$/i.test(e.patternName || '') || e.gradientFlag === 1;
    let c = r.c;
    if (e.gradientFlag === 1 && e.gradientColors && e.gradientColors.length) {
      const g = e.gradientColors[0];
      if (g.rgb != null) c = g.rgb & 0xffffff;
    }
    if (solid) { emitFill(rings.map((p) => xf(m, p)), c); return; }
    const defs = (e.definitionLines || []).filter((d) => d && d.offset && (Math.abs(d.offset.x) + Math.abs(d.offset.y)) > 1e-12);
    if (!defs.length) return;
    // 로컬(OCS) 좌표 그대로 두고 행렬을 같이 넘긴다. 원점은 경계 중심.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of rings) for (let i = 0; i < p.length; i += 2) { x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); y0 = Math.min(y0, p[i + 1]); y1 = Math.max(y1, p[i + 1]); }
    const ox = (x0 + x1) / 2, oy = (y0 + y1) / 2;
    const local = rings.map((p) => { const q = new Float64Array(p.length); for (let i = 0; i < p.length; i += 2) { q[i] = p[i] - ox; q[i + 1] = p[i + 1] - oy; } return q; });
    const wm = mul(m, T(ox, oy));
    const world = rings.map((p) => xf(m, p));
    let wx0 = Infinity, wy0 = Infinity, wx1 = -Infinity, wy1 = -Infinity;
    for (const p of world) for (let i = 0; i < p.length; i += 2) { wx0 = Math.min(wx0, p[i]); wx1 = Math.max(wx1, p[i]); wy0 = Math.min(wy0, p[i + 1]); wy1 = Math.max(wy1, p[i + 1]); addBox(p[i], p[i + 1]); }
    patterns.push({
      c: cidx(r.c), m: wm, rings: local, box: [wx0, wy0, wx1, wy1], lb: [x0 - ox, y0 - oy, x1 - ox, y1 - oy],
      defs: defs.map((d) => ({ a: d.angle || 0, bx: (d.base ? d.base.x : 0) - ox, by: (d.base ? d.base.y : 0) - oy, ox: d.offset.x, oy: d.offset.y, dash: d.dashLengths || [] })),
    });
    count++;
  }

  function doEntity(e, ctx) {
    if (!e || e.isVisible === false) return;
    const t = e.type;
    switch (t) {
      case 'LINE': {
        const r = resolve(e, ctx); if (!r) return;
        line(xf(ctx.m, [e.startPoint.x, e.startPoint.y, e.endPoint.x, e.endPoint.y]), false, r, ctx);
        return;
      }
      case 'XLINE': case 'RAY': {
        const r = resolve(e, ctx); if (!r) return;
        const p = xf(ctx.m, [e.firstPoint.x, e.firstPoint.y, e.firstPoint.x + e.unitDirection.x, e.firstPoint.y + e.unitDirection.y]);
        xlines.push({ x: p[0], y: p[1], dx: p[2] - p[0], dy: p[3] - p[1], both: t === 'XLINE', st: sidx(r.c, dashFor(r, ctx), 0) });
        return;
      }
      case 'CIRCLE': {
        const r = resolve(e, ctx); if (!r) return;
        const m = mul(ctx.m, ocs(e));
        const pts = arcPts(e.center.x, e.center.y, e.radius, 0, TAU, []);
        line(xf(m, pts), true, r, ctx, 0, false);
        const c = xf(m, [e.center.x, e.center.y, e.center.x + e.radius, e.center.y, e.center.x, e.center.y + e.radius, e.center.x - e.radius, e.center.y, e.center.x, e.center.y - e.radius]);
        snap(c[0], c[1], 2);
        for (let i = 2; i < 10; i += 2) snap(c[i], c[i + 1], 4);
        return;
      }
      case 'ARC': {
        const r = resolve(e, ctx); if (!r) return;
        const m = mul(ctx.m, ocs(e));
        const pts = xf(m, arcPts(e.center.x, e.center.y, e.radius, e.startAngle, e.endAngle, []));
        const st = sidx(r.c, dashFor(r, ctx), 0);
        emitLine(pts, false, st);
        snap(pts[0], pts[1], 0); snap(pts[pts.length - 2], pts[pts.length - 1], 0);
        const mid = (pts.length / 2) >> 1;
        snap(pts[mid * 2], pts[mid * 2 + 1], 1);
        const c = xf(m, [e.center.x, e.center.y]); snap(c[0], c[1], 2);
        return;
      }
      case 'ELLIPSE': {
        const r = resolve(e, ctx); if (!r) return;
        const flip = e.extrusionDirection && e.extrusionDirection.z < -0.5;
        const pts = ellipsePts(e.center.x, e.center.y, e.majorAxisEndPoint.x, e.majorAxisEndPoint.y, e.axisRatio || 1, e.startAngle || 0, e.endAngle == null ? TAU : e.endAngle, flip, []);
        const full = Math.abs(((e.endAngle == null ? TAU : e.endAngle) - (e.startAngle || 0)) - TAU) < 1e-6;
        const w = xf(ctx.m, pts);
        const st = sidx(r.c, dashFor(r, ctx), 0);
        emitLine(w, full, st);
        const c = xf(ctx.m, [e.center.x, e.center.y]); snap(c[0], c[1], 2);
        if (!full) { snap(w[0], w[1], 0); snap(w[w.length - 2], w[w.length - 1], 0); }
        return;
      }
      case 'LWPOLYLINE': {
        const r = resolve(e, ctx); if (!r) return;
        const closed = !!(e.flag & 512);
        const vs = e.vertices || [];
        if (vs.length < 2) return;
        const m = mul(ctx.m, ocs(e));
        const pts = xf(m, polyPts(vs, closed));
        const w = (e.constantWidth || 0) * scaleOf(m);
        const st = sidx(r.c, dashFor(r, ctx), w);
        emitLine(pts, closed, st);
        const vp = xf(m, vs.flatMap((v) => [v.x, v.y]));
        snapPts(vp, closed, true);
        return;
      }
      case 'POLYLINE2D': case 'POLYLINE3D': case 'POLYLINE_2D': case 'POLYLINE_3D': case 'POLYLINE': {
        const r = resolve(e, ctx); if (!r) return;
        const flag = e.flag || 0;
        let vs = (e.vertices || []).filter(Boolean);
        const m = t.includes('3D') ? ctx.m : mul(ctx.m, ocs(e));
        if (flag & 64) { // 폴리페이스 메쉬
          const pts = vs.filter((v) => !(v.flag & 128) || (v.flag & 64));
          const faces = vs.filter((v) => (v.flag & 128) && !(v.flag & 64));
          for (const f of faces) {
            const idx = [f.polyfaceIndex0, f.polyfaceIndex1, f.polyfaceIndex2, f.polyfaceIndex3].filter((i) => i);
            for (let i = 0; i < idx.length; i++) {
              const a = idx[i], b = idx[(i + 1) % idx.length];
              if (a < 0) continue;
              const pa = pts[Math.abs(a) - 1], pb = pts[Math.abs(b) - 1];
              if (pa && pb) line(xf(m, [pa.x, pa.y, pb.x, pb.y]), false, r, ctx, 0, false);
            }
          }
          return;
        }
        if (flag & 16) { // 3D 메쉬: 점만 이어서
          line(xf(m, vs.flatMap((v) => [v.x, v.y])), false, r, ctx, 0, false);
          return;
        }
        if (flag & 4) vs = vs.filter((v) => !(v.flag & 16)); // 스플라인 맞춤: 제어점 빼기
        const closed = !!(flag & 1);
        if (vs.length < 2) return;
        const pts = xf(m, polyPts(vs.map((v) => ({ x: v.x, y: v.y, bulge: v.bulge || 0 })), closed));
        const w = ((e.startWidth || 0) === (e.endWidth || 0) ? (e.startWidth || 0) : 0) * scaleOf(m);
        emitLine(pts, closed, sidx(r.c, dashFor(r, ctx), w));
        snapPts(xf(m, vs.flatMap((v) => [v.x, v.y])), closed, true);
        return;
      }
      case 'SPLINE': {
        const r = resolve(e, ctx); if (!r) return;
        let pts = [];
        const cp = e.controlPoints || [];
        if (cp.length >= 2) bspline(cp, e.degree, e.knots, e.weights, pts);
        else if (e.fitPoints && e.fitPoints.length >= 2) catmull(e.fitPoints, !!(e.flag & 1), pts);
        if (pts.length < 4) return;
        const w = xf(ctx.m, pts);
        emitLine(w, false, sidx(r.c, dashFor(r, ctx), 0));
        snap(w[0], w[1], 0); snap(w[w.length - 2], w[w.length - 1], 0);
        return;
      }
      case 'SOLID': case 'TRACE': {
        const r = resolve(e, ctx); if (!r) return;
        const m = mul(ctx.m, ocs(e));
        const c1 = e.corner1, c2 = e.corner2, c3 = e.corner3, c4 = e.corner4 || e.corner3;
        const pts = [c1.x, c1.y, c2.x, c2.y, c4.x, c4.y, c3.x, c3.y];
        const w = xf(m, pts);
        emitFill([w], r.c);
        snapPts(w, true, false);
        return;
      }
      case '3DFACE': {
        const r = resolve(e, ctx); if (!r) return;
        const cs = [e.corner1, e.corner2, e.corner3, e.corner4 || e.corner3];
        const pts = [];
        for (const c of cs) pts.push(c.x, c.y);
        line(xf(ctx.m, pts), true, r, ctx, 0, false);
        return;
      }
      case 'WIPEOUT': {
        const b = e.clippingBoundaryPath || [];
        if (!e.uPixel || !e.vPixel || !e.position) return;
        let pts = b;
        if (e.clippingBoundaryType === 1 && b.length === 2) pts = [b[0], { x: b[1].x, y: b[0].y }, b[1], { x: b[0].x, y: b[1].y }];
        if (pts.length < 3) return;
        const W = [];
        const sx = e.imageSize ? e.imageSize.x || 1 : 1, sy = e.imageSize ? e.imageSize.y || 1 : 1;
        for (const p of pts) {
          const u = p.x + 0.5 * sx, v = (sy - 0.5 * sy) - p.y;
          const x = e.position.x + e.uPixel.x * u + e.vPixel.x * v;
          const y = e.position.y + e.uPixel.y * u + e.vPixel.y * v;
          W.push(x, y);
        }
        emitFill([xf(ctx.m, W)], BG);
        return;
      }
      case 'TEXT': doText(e, e, ctx); return;
      case 'ATTRIB': {
        if (e.flags & 1) return;
        if (e.text && typeof e.text === 'object') doText(e, e.text, ctx);
        return;
      }
      case 'MTEXT': {
        const ins = e.insertionPoint;
        if (!ins) return;
        doMText(e, ctx);
        return;
      }
      case 'INSERT': {
        if (ctx.depth > 16) return;
        const r = resolve(e, ctx); if (!r) return;
        const b = blocksByName.get(e.name) || blocksByName.get(String(e.name).toUpperCase());
        if (b && b.entities && b.entities.length) {
          const base = b.basePoint || { x: 0, y: 0 };
          const om = mul(ctx.m, ocs(e));
          const sx = e.xScale || 1, sy = e.yScale || 1;
          const rows = Math.max(1, Math.min(e.rowCount || 1, 200)), cols = Math.max(1, Math.min(e.columnCount || 1, 200));
          for (let ri = 0; ri < rows; ri++) {
            for (let ci = 0; ci < cols; ci++) {
              let bm = mul(om, mul(T(e.insertionPoint.x, e.insertionPoint.y), R(e.rotation || 0)));
              if (ri || ci) bm = mul(bm, T(ci * (e.columnSpacing || 0), ri * (e.rowSpacing || 0)));
              bm = mul(bm, mul(S(sx, sy), T(-base.x, -base.y)));
              const sub = { m: bm, layer: r.layer, color: r.c, ltype: r.lt, ls: ctx.ls * Math.sqrt(Math.abs(sx * sy)), depth: ctx.depth + 1 };
              for (const ce of b.entities) if (ce.type !== 'ATTDEF') doEntity(ce, sub);
            }
          }
          const ip = xf(om, [e.insertionPoint.x, e.insertionPoint.y]);
          snap(ip[0], ip[1], 3);
        }
        for (const a of e.attribs || []) doEntity(a, ctx);
        return;
      }
      case 'DIMENSION': {
        if (ctx.depth > 16) return;
        const r = resolve(e, ctx); if (!r) return;
        const b = e.name && (blocksByName.get(e.name) || blocksByName.get(String(e.name).toUpperCase()));
        if (b && b.entities) {
          const sub = { m: ctx.m, layer: r.layer, color: r.c, ltype: r.lt, ls: ctx.ls, depth: ctx.depth + 1 };
          for (const ce of b.entities) doEntity(ce, sub);
        }
        return;
      }
      case 'ACAD_TABLE': case 'TABLE': {
        if (ctx.depth > 16) return;
        const r = resolve(e, ctx); if (!r) return;
        const b = e.blockRecordHandle && blocksByHandle.get(String(e.blockRecordHandle).toUpperCase());
        if (b && b.entities) {
          const sub = { m: ctx.m, layer: r.layer, color: r.c, ltype: r.lt, ls: ctx.ls, depth: ctx.depth + 1 };
          for (const ce of b.entities) doEntity(ce, sub);
        }
        return;
      }
      case 'LEADER': {
        const r = resolve(e, ctx); if (!r) return;
        const vs = e.vertices || [];
        if (vs.length < 2) return;
        const pts = xf(ctx.m, vs.flatMap((v) => [v.x, v.y]));
        line(pts, false, r, ctx, 0, false);
        if (e.isArrowheadEnabled !== false) arrow(pts[0], pts[1], pts[2], pts[3], arrowSize * scaleOf(ctx.m), r.c);
        return;
      }
      case 'MULTILEADER': {
        const r = resolve(e, ctx); if (!r) return;
        const asz = (e.arrowheadSize > 0 ? e.arrowheadSize : arrowSize) * (e.contentScale > 0 ? e.contentScale : 1);
        const lc = decodeRaw(e.leaderLineColor);
        const lr = { ...r, c: colorOf(lc, r.c, ctx) };
        for (const sec of e.leaderSections || []) {
          for (const ll of sec.leaderLines || []) {
            const vs = (ll.vertices || []).slice();
            if (sec.lastLeaderLinePoint) vs.push(sec.lastLeaderLinePoint);
            if (vs.length < 2) continue;
            const pts = xf(ctx.m, vs.flatMap((v) => [v.x, v.y]));
            line(pts, false, lr, ctx, 0, false);
            arrow(pts[0], pts[1], pts[2], pts[3], asz * scaleOf(ctx.m), lr.c);
          }
          if (e.doglegEnabled && sec.lastLeaderLinePoint && sec.doglegVector && sec.doglegLength) {
            const p = sec.lastLeaderLinePoint, d = sec.doglegVector;
            line(xf(ctx.m, [p.x, p.y, p.x + d.x * sec.doglegLength, p.y + d.y * sec.doglegLength]), false, lr, ctx, 0, false);
          }
        }
        if (e.hasMText && e.textContent && e.textAnchor) {
          const tc = decodeRaw(e.textColor);
          const ap = e.textAttachmentPoint || 1;
          doMText({ ...e, colorIndex: 0, color: undefined },{ ...ctx, color: colorOf(tc, r.c, ctx), layer: r.layer }, {
            text: e.textContent, h: e.textHeight || 2.5, p: e.textAnchor, dir: e.textDirection, rot: e.textRotation,
            ap: ap >= 1 && ap <= 3 ? ap : 1, w: e.textWidth || 0, ls: e.textLineSpacingFactor || 1,
          });
        }
        if (e.hasBlock && e.blockContent && e.blockContent.blockContentId && ctx.depth < 16) {
          const b = blocksByHandle.get(String(e.blockContent.blockContentId).toUpperCase());
          const tm = e.blockContent.transformationMatrix;
          if (b && b.entities && tm && tm.length >= 12) {
            const bm = mul(ctx.m, [tm[0], tm[4], tm[1], tm[5], tm[3], tm[7]]);
            const sub = { m: bm, layer: r.layer, color: r.c, ltype: r.lt, ls: ctx.ls, depth: ctx.depth + 1 };
            for (const ce of b.entities) if (ce.type !== 'ATTDEF') doEntity(ce, sub);
          }
        }
        return;
      }
      case 'MLINE': {
        const r = resolve(e, ctx); if (!r) return;
        const vs = e.vertices || [];
        const nl = e.numberOfLines || (vs[0] && vs[0].lines ? vs[0].lines.length : 0);
        const closed = !!(e.flags & 2);
        for (let j = 0; j < nl; j++) {
          const pts = [];
          for (const v of vs) {
            const off = v.lines && v.lines[j] && v.lines[j].segmentParams ? v.lines[j].segmentParams[0] || 0 : 0;
            pts.push(v.vertex.x + v.miterDirection.x * off, v.vertex.y + v.miterDirection.y * off);
          }
          if (pts.length >= 4) line(xf(ctx.m, pts), closed, r, ctx, 0, true);
        }
        return;
      }
      case 'HATCH': doHatch(e, ctx); return;
      case 'POINT': {
        const r = resolve(e, ctx); if (!r) return;
        const p = xf(ctx.m, [e.position.x, e.position.y]);
        snap(p[0], p[1], 0);
        return;
      }
      default: return;
    }
  }
  function colorOf(dc, fallback, ctx) {
    if (!dc) return fallback;
    if (dc.rgb != null) return dc.rgb;
    if (dc.aci === 0) return fallback;
    if (dc.aci >= 1 && dc.aci <= 255) return ACI[dc.aci];
    return fallback;
  }

  let ents = model && model.entities && model.entities.length ? model.entities : null;
  if (!ents) {
    const mh = model ? String(model.handle) : null;
    ents = (db.entities || []).filter((e) => !e.isInPaperSpace && (!mh || e.ownerBlockRecordSoftId === mh));
  }
  const root = { m: I, layer: null, color: FG, ltype: 'Continuous', ls: 1, depth: 0 };
  for (const e of ents) {
    try { doEntity(e, root); } catch (err) { /* 개별 객체 오류는 건너뛴다 */ }
  }

  // 범위: 전체 + 극단값을 뺀 범위
  let full = [bx0, by0, bx1, by1];
  if (!isFinite(bx0)) full = [-100, -100, 100, 100];
  let fit = full;
  if (samples.length > 40) {
    const xs = [], ys = [];
    for (let i = 0; i < samples.length; i += 2) { xs.push(samples[i]); ys.push(samples[i + 1]); }
    xs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
    const q = (arr, p) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(arr.length * p)))];
    const rx0 = q(xs, 0.02), rx1 = q(xs, 0.98), ry0 = q(ys, 0.02), ry1 = q(ys, 0.98);
    const rw = Math.max(rx1 - rx0, 1e-9), rh = Math.max(ry1 - ry0, 1e-9);
    const fw = full[2] - full[0], fh = full[3] - full[1];
    if (fw * fh > 50 * rw * rh || fw > 20 * rw || fh > 20 * rh) fit = [rx0 - rw * 0.08, ry0 - rh * 0.08, rx1 + rw * 0.08, ry1 + rh * 0.08];
  }
  // 무한선(XLINE/RAY)은 범위를 알고 나서 길이를 정해 그린다
  const diag = Math.hypot(full[2] - full[0], full[3] - full[1]) || 1000;
  for (const x of xlines) {
    const L = diag * 20, d = Math.hypot(x.dx, x.dy) || 1;
    const ux = x.dx / d, uy = x.dy / d;
    emitLine(x.both ? [x.x - ux * L, x.y - uy * L, x.x + ux * L, x.y + uy * L] : [x.x, x.y, x.x + ux * L, x.y + uy * L], false, x.st);
  }
  if (xlines.length) full = [bx0, by0, bx1, by1];

  const plA = pl.out(), fillA = fill.out(), snapA = snaps.out(), kindA = Uint8Array.from(snapKinds);
  const transfer = [plA.buffer, fillA.buffer, snapA.buffer, kindA.buffer];
  for (const p of patterns) for (const r of p.rings) transfer.push(r.buffer);
  return {
    count,
    units: H.INSUNITS || 0,
    colors, styles, pl: plA, fill: fillA, texts, patterns,
    snaps: snapA, snapKinds: kindA,
    full, fit,
    transfer,
  };
}
