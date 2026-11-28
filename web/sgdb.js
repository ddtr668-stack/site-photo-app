// 네이티브 엔진(sgdb.c)이 만든 바이너리를 worker.js build()가 쓰는 객체 모양으로 되돌린다.
// 값 표기는 sgdb.c 머리말 참고.
const td = new TextDecoder('utf-8');

export function readSGDB(buf) {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  let p = 0;
  if (u8[0] !== 0x53 || u8[1] !== 0x47 || u8[2] !== 0x44 || u8[3] !== 0x42) throw new Error('SGDB 형식이 아니에요');
  p = 4;
  const ver = dv.getUint32(p, true); p += 4;
  if (ver !== 1) throw new Error('SGDB 판번호가 맞지 않아요: ' + ver);
  const nk = dv.getUint32(p, true); p += 4;
  const keys = new Array(nk);
  for (let i = 0; i < nk; i++) {
    const n = dv.getUint16(p, true); p += 2;
    keys[i] = str(p, n); p += n;
  }
  const names = [];

  function str(at, n) {
    // 짧은 ASCII는 바로, 나머지는 TextDecoder
    if (n < 64) {
      let ascii = true;
      for (let i = 0; i < n; i++) if (u8[at + i] > 0x7f) { ascii = false; break; }
      if (ascii) {
        let s = '';
        for (let i = 0; i < n; i++) s += String.fromCharCode(u8[at + i]);
        return s;
      }
    }
    return td.decode(u8.subarray(at, at + n));
  }

  function val() {
    const t = u8[p++];
    switch (t) {
      case 0: return null;
      case 1: return false;
      case 2: return true;
      case 3: { const v = dv.getFloat64(p, true); p += 8; return v; }
      case 4: { const v = dv.getInt32(p, true); p += 4; return v; }
      case 5: { const n = dv.getUint32(p, true); p += 4; const s = str(p, n); p += n; return s; }
      case 6: {
        const a = [];
        while (u8[p] !== 8) a.push(val());
        p++;
        return a;
      }
      case 7: {
        const o = {};
        for (;;) {
          const k = dv.getUint16(p, true); p += 2;
          if (k === 0xffff) break;
          o[keys[k]] = val();
        }
        return o;
      }
      case 9: { const x = dv.getFloat64(p, true), y = dv.getFloat64(p + 8, true); p += 16; return { x, y }; }
      case 10: { const x = dv.getFloat64(p, true), y = dv.getFloat64(p + 8, true), z = dv.getFloat64(p + 16, true); p += 24; return { x, y, z }; }
      case 11: {
        const n = dv.getUint32(p, true); p += 4;
        const a = new Array(n);
        for (let i = 0; i < n; i++) { a[i] = dv.getFloat64(p, true); p += 8; }
        return a;
      }
      case 12: { const id = dv.getUint32(p, true); p += 4; return names[id]; }
      case 13: { const n = dv.getUint32(p, true); p += 4; const s = str(p, n); p += n; names.push(s); return s; }
      default: throw new Error('SGDB 값 표기 오류 ' + t + ' @' + (p - 1));
    }
  }
  return val();
}
