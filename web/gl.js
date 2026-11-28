// gl.js — 도면의 선·면을 GPU(WebGL2)로 그린다.
// 글자·해치 무늬·메모·측정은 위의 2D 캔버스(#cv)가 그대로 그린다.
// 선은 점을 한 번만 올리고(점 하나 16바이트), 이웃한 두 점으로 사각형을 만들어 굵기·점선·부드러운 가장자리를 낸다.
// 좌표는 셀(구역)마다 원점을 따로 둬서 큰 좌표에서도 흔들리지 않게 한다.
'use strict';
const GLR = (() => {
  const S = {
    gl: null, canvas: null, active: false, lost: false,
    lineProg: null, fillProg: null, quad: null,
    cells: [], palTex: null, styleTex: null, dashTex: null,
    nColors: 0, palKey: '', maxTex: 4096,
  };

  const LINE_VS = `#version 300 es
precision highp float;
precision highp sampler2D;
layout(location=0) in vec2 corner;
layout(location=1) in vec4 A;
layout(location=2) in vec4 B;
uniform vec2 uScale;
uniform vec2 uOff;
uniform vec2 uRes;
uniform float uLw;
uniform float uS;
uniform sampler2D uStyle;
uniform sampler2D uPal;
out vec4 vColor;
out float vSide;
out float vDist;
flat out float vHalf;
flat out vec4 vDash;
void main() {
  if (A.w < 0.0 || B.w < 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vColor = vec4(0.0); vSide = 0.0; vDist = 0.0; vHalf = 0.0; vDash = vec4(0.0); return; }
  int si = int(A.w + 0.5);
  vec4 st = texelFetch(uStyle, ivec2(si, 0), 0);
  vec4 st2 = texelFetch(uStyle, ivec2(si, 1), 0);
  vColor = texelFetch(uPal, ivec2(int(st.x + 0.5), 0), 0);
  vec2 pa = A.xy * uScale + uOff;
  vec2 pb = B.xy * uScale + uOff;
  vec2 d = pb - pa;
  float L = length(d);
  vec2 t = L > 1e-6 ? d / L : vec2(1.0, 0.0);
  vec2 n = vec2(-t.y, t.x);
  float w = max(st.y * uS, uLw);
  float h = max(w, 1.0) * 0.5 + 1.0;
  float ext = st.z > 0.0 ? 0.0 : w * 0.5;
  vec2 pos = (corner.x < 0.5 ? pa - t * ext : pb + t * ext) + n * corner.y * h;
  vSide = corner.y * h;
  vHalf = w * 0.5;
  vDist = corner.x < 0.5 ? A.z - ext / uS : B.z + ext / uS;
  vDash = vec4(st.z, st.w, st2.x, st.z > 0.0 ? 1.0 : 0.0);
  gl_Position = vec4(pos.x / uRes.x * 2.0 - 1.0, 1.0 - pos.y / uRes.y * 2.0, 0.0, 1.0);
}`;

  const LINE_FS = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec4 vColor;
in float vSide;
in float vDist;
flat in float vHalf;
flat in vec4 vDash;
uniform sampler2D uDash;
uniform float uS;
uniform float uLw;
uniform float uPx;
out vec4 o;
void main() {
  float hw = max(vHalf, 0.5);
  float a = clamp(hw + 0.5 - abs(vSide), 0.0, 1.0);
  if (vHalf < 0.5) a *= vHalf * 2.0;
  if (vDash.w > 0.5 && vDash.x * uS >= 4.0 * uPx) {
    int start = int(vDash.y + 0.5);
    int cnt = int(vDash.z + 0.5);
    float minOn = uLw / uS;
    float tot = 0.0;
    for (int i = 0; i < 24; i++) {
      if (i >= cnt) break;
      int k = start + i;
      float v = texelFetch(uDash, ivec2(k % 4096, k / 4096), 0).r;
      if (i % 2 == 0 && v < minOn) v = minOn;
      tot += v;
    }
    if (tot > 0.0) {
      float m = mod(vDist, tot);
      float acc = 0.0;
      bool on = true;
      for (int i = 0; i < 24; i++) {
        if (i >= cnt) break;
        int k = start + i;
        float v = texelFetch(uDash, ivec2(k % 4096, k / 4096), 0).r;
        if (i % 2 == 0 && v < minOn) v = minOn;
        acc += v;
        if (m < acc) { on = (i % 2 == 0); break; }
      }
      if (!on) discard;
    }
  }
  if (a <= 0.0) discard;
  o = vec4(vColor.rgb * vColor.a * a, vColor.a * a);
}`;

  const FILL_VS = `#version 300 es
precision highp float;
precision highp sampler2D;
layout(location=0) in vec3 P;
uniform vec2 uScale;
uniform vec2 uOff;
uniform vec2 uRes;
uniform sampler2D uPal;
out vec4 vColor;
void main() {
  vColor = texelFetch(uPal, ivec2(int(P.z + 0.5), 0), 0);
  vec2 p = P.xy * uScale + uOff;
  gl_Position = vec4(p.x / uRes.x * 2.0 - 1.0, 1.0 - p.y / uRes.y * 2.0, 0.0, 1.0);
}`;
  const FILL_FS = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 o;
void main() { o = vec4(vColor.rgb * vColor.a, vColor.a); }`;

  function compile(gl, vs, fs) {
    const mk = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }
    return { p, u };
  }

  function init(canvas) {
    S.canvas = canvas;
    let gl = null;
    try {
      gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    } catch (e) { gl = null; }
    if (!gl) return false;
    try {
      S.lineProg = compile(gl, LINE_VS, LINE_FS);
      S.fillProg = compile(gl, FILL_VS, FILL_FS);
    } catch (e) {
      console.warn('GL 셰이더', e.message);
      return false;
    }
    S.gl = gl;
    S.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096;
    S.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, S.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 1, -1, 0, 1, 1, 1]), gl.STATIC_DRAW);
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); S.lost = true; S.active = false; S.cells = []; });
    canvas.addEventListener('webglcontextrestored', () => {
      S.lost = false;
      try {
        S.lineProg = compile(gl, LINE_VS, LINE_FS);
        S.fillProg = compile(gl, FILL_VS, FILL_FS);
        S.quad = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, S.quad);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 1, -1, 0, 1, 1, 1]), gl.STATIC_DRAW);
        if (S.onRestore) S.onRestore();
      } catch (e) { }
    });
    return true;
  }

  function tex(gl, old, w, h, ifmt, fmt, type, data) {
    if (old) gl.deleteTexture(old);
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, fmt, type, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  function freeCells() {
    const gl = S.gl;
    if (!gl) return;
    for (const c of S.cells) {
      if (c.lineBuf) gl.deleteBuffer(c.lineBuf);
      if (c.fillBuf) gl.deleteBuffer(c.fillBuf);
      if (c.lineVao) gl.deleteVertexArray(c.lineVao);
      if (c.fillVao) gl.deleteVertexArray(c.fillVao);
    }
    S.cells = [];
  }

  // data: { styles:[{c,dash,w}], nColors, cells:[{ox,oy,box,lines:Float32Array,fills:Float32Array}] }
  function upload(data) {
    const gl = S.gl;
    if (!gl || S.lost) return false;
    freeCells();
    // 스타일 표: 0줄 (색번호, 굵기, 점선합, 점선시작), 1줄 (점선개수)
    const ns = Math.max(1, data.styles.length);
    if (ns > S.maxTex || data.nColors > S.maxTex) return false;
    const st = new Float32Array(ns * 2 * 4);
    const dashes = [];
    data.styles.forEach((s, i) => {
      st[i * 4] = s.c;
      st[i * 4 + 1] = s.w || 0;
      if (s.dash && s.dash.length) {
        let tot = 0;
        for (const v of s.dash) tot += v;
        st[i * 4 + 2] = tot;
        st[i * 4 + 3] = dashes.length;
        st[(ns + i) * 4] = Math.min(s.dash.length, 24);
        for (const v of s.dash.slice(0, 24)) dashes.push(v);
      }
    });
    S.styleTex = tex(gl, S.styleTex, ns, 2, gl.RGBA32F, gl.RGBA, gl.FLOAT, st);
    const dw = 4096, dh = Math.max(1, Math.ceil(dashes.length / dw));
    const dd = new Float32Array(dw * dh);
    dd.set(dashes);
    S.dashTex = tex(gl, S.dashTex, dw, dh, gl.R32F, gl.RED, gl.FLOAT, dd);
    S.nColors = data.nColors;
    S.palKey = '';
    for (const c of data.cells) {
      const g = { ox: c.ox, oy: c.oy, box: c.box, nLine: 0, nFill: 0 };
      if (c.lines && c.lines.length >= 8) {
        g.lineBuf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, g.lineBuf);
        gl.bufferData(gl.ARRAY_BUFFER, c.lines, gl.STATIC_DRAW);
        g.nLine = c.lines.length / 4 - 1;
        g.lineVao = gl.createVertexArray();
        gl.bindVertexArray(g.lineVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, S.quad);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, g.lineBuf);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 16, 0);
        gl.vertexAttribDivisor(1, 1);
        gl.enableVertexAttribArray(2);
        gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 16, 16);
        gl.vertexAttribDivisor(2, 1);
        gl.bindVertexArray(null);
      }
      if (c.fills && c.fills.length >= 9) {
        g.fillBuf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, g.fillBuf);
        gl.bufferData(gl.ARRAY_BUFFER, c.fills, gl.STATIC_DRAW);
        g.nFill = c.fills.length / 3;
        g.fillVao = gl.createVertexArray();
        gl.bindVertexArray(g.fillVao);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
        gl.bindVertexArray(null);
      }
      S.cells.push(g);
    }
    S.active = !gl.isContextLost();
    return S.active;
  }

  // rgba: Uint8Array(4 * 색 수), key: 배경 등 바뀌면 다시 올리기
  function palette(rgba, key) {
    const gl = S.gl;
    if (!gl || key === S.palKey) return;
    S.palTex = tex(gl, S.palTex, Math.max(1, rgba.length / 4), 1, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    S.palKey = key;
  }

  function resize(w, h) {
    if (S.canvas.width !== w || S.canvas.height !== h) { S.canvas.width = w; S.canvas.height = h; }
  }

  // view: { s, cx, cy }, W·H 장치 px, bg [r,g,b] 0~1, o: { lw, px }
  function render(view, W, H, bg, o) {
    const gl = S.gl;
    if (!gl || !S.active) return false;
    gl.viewport(0, 0, W, H);
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const s = view.s;
    const vx0 = view.cx - W / 2 / s, vx1 = view.cx + W / 2 / s, vy0 = view.cy - H / 2 / s, vy1 = view.cy + H / 2 / s;
    const vis = (b) => b[2] >= vx0 && b[0] <= vx1 && b[3] >= vy0 && b[1] <= vy1;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    // 면
    let p = S.fillProg;
    gl.useProgram(p.p);
    gl.uniform2f(p.u.uRes, W, H);
    gl.uniform2f(p.u.uScale, s, -s);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, S.palTex);
    gl.uniform1i(p.u.uPal, 0);
    for (const c of S.cells) {
      if (!c.nFill || !vis(c.box)) continue;
      gl.uniform2f(p.u.uOff, (c.ox - view.cx) * s + W / 2, (view.cy - c.oy) * s + H / 2);
      gl.bindVertexArray(c.fillVao);
      gl.drawArrays(gl.TRIANGLES, 0, c.nFill);
    }
    // 선
    p = S.lineProg;
    gl.useProgram(p.p);
    gl.uniform2f(p.u.uRes, W, H);
    gl.uniform2f(p.u.uScale, s, -s);
    gl.uniform1f(p.u.uLw, o.lw);
    gl.uniform1f(p.u.uS, s);
    gl.uniform1f(p.u.uPx, o.px);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, S.styleTex);
    gl.uniform1i(p.u.uStyle, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, S.palTex);
    gl.uniform1i(p.u.uPal, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, S.dashTex);
    gl.uniform1i(p.u.uDash, 2);
    for (const c of S.cells) {
      if (!c.nLine || !vis(c.box)) continue;
      gl.uniform2f(p.u.uOff, (c.ox - view.cx) * s + W / 2, (view.cy - c.oy) * s + H / 2);
      gl.bindVertexArray(c.lineVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, c.nLine);
    }
    gl.bindVertexArray(null);
    return true;
  }

  function clear() { freeCells(); S.active = false; }

  return {
    init, upload, palette, render, resize, clear,
    get active() { return S.active && !S.lost; },
    get ok() { return !!S.gl; },
    set onRestore(f) { S.onRestore = f; },
    get canvas() { return S.canvas; },
  };
})();
