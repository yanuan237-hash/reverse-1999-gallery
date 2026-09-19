/**
 * 纯 JavaScript 的 JPEG 缩略图引擎（零依赖）
 *
 * 核心技巧：JPEG 每个 8x8 数据块的 **DC 系数就是该块的平均色**。
 * 只解 DC、跳过 AC，可以不做 IDCT 就拿到 1/8 尺寸的缩略图 —— 又快又够用。
 *
 * - 支持基线 JPEG（SOF0/SOF1）与 16x16 量化表、4:2:0 / 4:2:2 / 4:4:4 采样
 * - 渐进式 JPEG（SOF2）不走此路径，调用方回退为浏览器原生解码
 * - 输出：4:4:4 基线 JPEG（标准霍夫曼表）
 */

const ZIGZAG = new Uint8Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47,
  55, 62, 63,
]);

const IDCT_COS = new Float64Array(64);
for (let u = 0; u < 8; u++) {
  for (let x = 0; x < 8; x++) {
    IDCT_COS[u * 8 + x] = Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  }
}

/* ------------------------------------------------------------- 霍夫曼查表 */

/** 由规范霍夫曼表构建 16 位 LUT 解码器（O(1) 解码） */
function buildLut(bits, values) {
  const code = new Int32Array(17);
  const mincode = new Int32Array(17);
  const maxcode = new Int32Array(18).fill(-1);
  const valptr = new Int32Array(17);
  let c = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    valptr[len] = k;
    mincode[len] = c;
    c += bits[len] ?? 0;
    k += bits[len] ?? 0;
    maxcode[len] = (bits[len] ?? 0) === 0 ? -1 : c - 1;
    c <<= 1;
  }
  const lut = new Int32Array(65536).fill(-1);
  c = 0;
  k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < (bits[len] ?? 0); i++) {
      const value = values[k++];
      const start = c << (16 - len);
      const count = 1 << (16 - len);
      lut.fill((len << 8) | value, start, start + count);
      c++;
    }
    c <<= 1;
  }
  return { lut, mincode, maxcode, valptr, values };
}

/** 熵编码流中遇到重启标记（RSTn）时抛出，由 MCU 层对齐后继续 */
const RST = Symbol("RST");

class BitReader {
  constructor(data, pos) {
    this.d = data;
    this.p = pos;
    this.b = 0;
    this.n = 0;
  }
  fill() {
    while (this.n <= 16) {
      if (this.p >= this.d.length) {
        this.b = (this.b << 8) & 0xffffff;
        this.n += 8;
        continue;
      }
      let byte = this.d[this.p++];
      if (byte === 0xff) {
        const next = this.d[this.p];
        if (next === 0x00) {
          this.p++; // 0xFF00 是数据字节 0xFF
        } else if (next >= 0xd0 && next <= 0xd7) {
          // 真·重启标记：交给上层在 MCU 边界处理，绝不当作数据
          this.p--;
          throw RST;
        } else if (next === 0xff) {
          this.p++; // 填充用的 0xFF
          continue;
        } else {
          this.p--;
          throw RST;
        }
      }
      this.b = ((this.b << 8) | byte) & 0xffffff;
      this.n += 8;
    }
  }
  bits(n) {
    if (n === 0) return 0;
    this.fill();
    this.n -= n;
    return (this.b >>> this.n) & ((1 << n) - 1);
  }
  receive(s) {
    if (s === 0) return 0;
    const v = this.bits(s);
    return v < 1 << (s - 1) ? v - (1 << s) + 1 : v;
  }
  decode(dec) {
    if (this.n < 16) this.fill();
    const idx = (this.b >>> (this.n - 16)) & 0xffff;
    const e = dec.lut[idx];
    if (e >= 0) {
      const len = e >> 8;
      this.n -= len;
      return e & 0xff;
    }
    // 超长码（极少见）：逐位下降
    let code = 0;
    for (let len = 1; len <= 16; len++) {
      code = (code << 1) | this.bits(1);
      if (dec.maxcode[len] >= code && code >= dec.mincode[len]) {
        return dec.values[dec.valptr[len] + code - dec.mincode[len]];
      }
    }
    throw new Error("霍夫曼解码失败");
  }
}

/* ------------------------------------------------------------- 头部解析 */

function parseHeader(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error("不是 JPEG");
  const qt = new Map();
  const huff = { 0: new Map(), 1: new Map() };
  let frame = null;
  let restartInterval = 0;
  let p = 2;

  while (p < buf.length) {
    if (buf[p] !== 0xff) {
      p++;
      continue;
    }
    let m = buf[p + 1];
    while (m === 0xff) {
      p++;
      m = buf[p + 1];
    }
    p += 2;
    if (m === 0xd9 || m === 0xda) break; // EOI / SOS
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue;
    const len = (buf[p] << 8) | buf[p + 1];
    const s = p + 2;
    const e = p + len;

    if (m === 0xdb) {
      let q = s;
      while (q < e) {
        const pq = buf[q] >> 4;
        const tq = buf[q] & 15;
        q++;
        const t = new Int32Array(64);
        for (let i = 0; i < 64; i++) {
          t[i] = pq === 1 ? ((buf[q] << 8) | buf[q + 1]) : buf[q];
          q += pq === 1 ? 2 : 1;
        }
        qt.set(tq, t);
      }
    } else if (m === 0xc4) {
      let q = s;
      while (q < e) {
        const tc = buf[q] >> 4;
        const th = buf[q] & 15;
        q++;
        const bits = new Int32Array(17);
        let total = 0;
        for (let i = 1; i <= 16; i++) {
          bits[i] = buf[q++];
          total += bits[i];
        }
        const vals = buf.subarray(q, q + total);
        q += total;
        huff[tc].set(th, buildLut(bits, vals));
      }
    } else if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) {
      const precision = buf[s];
      const height = (buf[s + 1] << 8) | buf[s + 2];
      const width = (buf[s + 3] << 8) | buf[s + 4];
      const n = buf[s + 5];
      const comps = [];
      let q = s + 6;
      for (let i = 0; i < n; i++) {
        comps.push({ id: buf[q], h: buf[q + 1] >> 4, v: buf[q + 1] & 15, tq: buf[q + 2] });
        q += 3;
      }
      frame = { progressive: m === 0xc2, precision, width, height, comps };
      if (frame.progressive) return { frame, progressive: true };
    } else if (m === 0xdd) {
      restartInterval = (buf[s] << 8) | buf[s + 1];
    }
    p = e;
  }

  const sosStart = p; // 指向 SOS 段长度字段
  if (buf[p - 2] !== 0xff || buf[p - 1] !== 0xda) throw new Error("未找到 SOS");

  const nComp = buf[p + 2];
  const scan = [];
  let q = p + 3;
  for (let i = 0; i < nComp; i++) {
    const cs = buf[q];
    const comp = frame.comps.find((c) => c.id === cs);
    scan.push({ comp, td: buf[q + 1] >> 4, ta: buf[q + 1] & 15 });
    q += 2;
  }
  const ss = buf[q];
  const se = buf[q + 1];
  const a = buf[q + 2];

  return {
    frame,
    progressive: false,
    restartInterval,
    quant: qt,
    huff,
    scan: { comps: scan, ss, se, ah: a >> 4, al: a & 15 },
    dataStart: q + 3,
  };
}

/* ------------------------------------------------- DC 缩放的解码（主路径） */

/**
 * DC 缩放解码：只取每个 8x8 块的 DC 系数（= 块平均色），得到 1/8 缩略图。
 * 不做 IDCT，速度远快于完整解码。渐进式 JPEG 会抛 code === "PROGRESSIVE"。
 * @returns {{ frame, comps, mcux, mcuy, width, height, truncated }}
 */
function decodeScaled(buf) {
  const hdr = parseHeader(buf);
  if (hdr.progressive) {
    const err = new Error("progressive");
    err.code = "PROGRESSIVE";
    throw err;
  }

  const { frame, quant, huff, scan, restartInterval, dataStart } = hdr;
  const { width, height, comps } = frame;
  if (comps.length !== 1 && comps.length !== 3) throw new Error("暂不支持的通道数: " + comps.length);
  if (frame.precision !== 8) throw new Error("暂不支持 " + frame.precision + " 位精度");

  const maxH = Math.max(...comps.map((c) => c.h));
  const maxV = Math.max(...comps.map((c) => c.v));
  const mcux = Math.ceil(width / (8 * maxH));
  const mcuy = Math.ceil(height / (8 * maxV));

  for (const c of comps) {
    c.bw = mcux * c.h;
    c.bh = mcuy * c.v;
    c.plane = new Float32Array(c.bw * c.bh);
    c.pred = 0;
    const s = scan.comps.find((x) => x.comp === c);
    c.dcTbl = huff[0].get(s?.td ?? 0) ?? huff[0].get(0);
    c.acTbl = huff[1].get(s?.ta ?? 0) ?? huff[1].get(0);
  }

  const reader = new BitReader(buf, dataStart);

  /** 解码一个 MCU，返回实际写入的块数（抛 RST 时由调用方重试，靠 set 变量保证幂等） */
  function decodeMcu(mx, my) {
    let written = 0;
    for (const c of comps) {
      const q = quant.get(c.tq);
      for (let by = 0; by < c.v; by++) {
        for (let bx = 0; bx < c.h; bx++) {
          const t = reader.decode(c.dcTbl);
          const diff = t === 0 ? 0 : reader.receive(t);
          c.pred += diff;
          const dc = c.pred * q[0];
          // 跳过 AC，但必须把码流完整消耗掉
          for (let kk = 1; kk <= scan.se; kk++) {
            const rs = reader.decode(c.acTbl);
            const s = rs & 15;
            const r = rs >> 4;
            if (s === 0) {
              if (r === 15) {
                kk += 15;
                continue;
              }
              break; // EOB
            }
            kk += r;
            if (kk > 63) break;
            reader.receive(s);
          }

          const px = mx * c.h + bx;
          const py = my * c.v + by;
          if (px < c.bw && py < c.bh) {
            c.plane[py * c.bw + px] = dc / 8 + 128;
            written++;
          }
        }
      }
    }
    return written;
  }

  /** 从指定位置向前找下一个 RSTn 标记，对齐到它之后 */
  function syncToRestart(from) {
    let p = Math.max(0, from);
    while (p + 1 < buf.length) {
      if (buf[p] === 0xff && buf[p + 1] >= 0xd0 && buf[p + 1] <= 0xd7) {
        reader.p = p + 2;
        reader.b = 0;
        reader.n = 0;
        return true;
      }
      p++;
    }
    return false;
  }

  let mcu = 0;
  for (let my = 0; my < mcuy; my++) {
    for (let mx = 0; mx < mcux; mx++) {
      if (restartInterval && mcu > 0 && mcu % restartInterval === 0) {
        // 上一个 MCU 组结束时，RSTn 肯定还在读取位置之后（它是字节流里的标记）
        if (!syncToRestart(reader.p)) {
          return { frame, comps, mcux, mcuy, width, height, truncated: true }; // 数据提前结束
        }
        for (const c of comps) c.pred = 0;
      }
      mcu++;

      // 记录本 MCU 的起始位置：解码时若撞上 RST，从这里向前重新对齐
      const startByte = reader.p;
      const startBits = reader.n;
      let attempt = 0;
      while (true) {
        try {
          decodeMcu(mx, my);
          break;
        } catch (e) {
          // 撞上 RST 或码流异常：对齐到 RSTn 后重试本 MCU
          if (e !== RST && !(e instanceof Error && e.message.includes("霍夫曼"))) throw e;
          if (++attempt > 3 || !syncToRestart(startByte)) {
            return { frame, comps, mcux, mcuy, width, height, truncated: true };
          }
          for (const c of comps) c.pred = 0;
        }
      }
    }
  }

  return { frame, comps, mcux, mcuy, width, height, truncated: false };
}

/** 取亮度/色度平面并做 4:4:4 合并（在 1/8 尺度上，直接按比例取样） */
function toRgbAtScale(decoded) {
  const { comps, mcux, mcuy } = decoded;
  const outW = mcux;
  const outH = mcuy;
  const rgb = new Uint8ClampedArray(outW * outH * 3);
  const maxH = Math.max(...comps.map((c) => c.h));
  const maxV = Math.max(...comps.map((c) => c.v));
  const Y = comps[0].plane;
  const hasC = comps.length === 3;
  const Cb = hasC ? comps[1].plane : null;
  const Cr = hasC ? comps[2].plane : null;

  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const sy = Math.min(comps[0].bh - 1, Math.floor((y * comps[0].v) / maxV));
      const sx = Math.min(comps[0].bw - 1, Math.floor((x * comps[0].h) / maxH));
      // plane 里存的是 dc/8 + 128（反量化后的电平搬移值），
      // 三个分量都要撤销这个 +128 才能代标准 YCbCr->RGB 公式。
      const yv = Y[sy * comps[0].bw + sx] - 128;
      let r, g, b;
      if (hasC) {
        const cy = Math.min(comps[1].bh - 1, Math.floor((y * comps[1].v) / maxV));
        const cx = Math.min(comps[1].bw - 1, Math.floor((x * comps[1].h) / maxH));
        const cb = Cb[cy * comps[1].bw + cx] - 128;
        const cr = Cr[cy * comps[1].bw + cx] - 128;
        r = yv + 1.402 * cr;
        g = yv - 0.344136 * cb - 0.714136 * cr;
        b = yv + 1.772 * cb;
      } else {
        r = g = b = yv;
      }
      const o = (y * outW + x) * 3;
      rgb[o] = r < 0 ? 0 : r > 255 ? 255 : r;
      rgb[o + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
      rgb[o + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
    }
  }
  return { width: outW, height: outH, rgb };
}

/* ------------------------------------------------------------------ 编码 */

const STD_LUM = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51,
  87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
];
const STD_CHROM = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99,
];
const DC_LUM_BITS = [0, 0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_LUM_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const DC_CHROM_BITS = [0, 0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const DC_CHROM_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_LUM_BITS = [0, 0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_LUM_VALS = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14,
  0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09,
  0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a,
  0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65,
  0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88,
  0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9,
  0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca,
  0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea,
  0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
];
const AC_CHROM_BITS = [0, 0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
const AC_CHROM_VALS = [
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32,
  0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16,
  0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39,
  0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64,
  0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86,
  0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8,
  0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9,
  0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
];

function buildEncTable(bits, vals) {
  const t = new Map();
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < bits[len]; i++) t.set(vals[k++], { code: code++, len });
    code <<= 1;
  }
  return t;
}
const ENC_DC_L = buildEncTable(DC_LUM_BITS, DC_LUM_VALS);
const ENC_AC_L = buildEncTable(AC_LUM_BITS, AC_LUM_VALS);
const ENC_DC_C = buildEncTable(DC_CHROM_BITS, DC_CHROM_VALS);
const ENC_AC_C = buildEncTable(AC_CHROM_BITS, AC_CHROM_VALS);

function scaleTable(base, quality) {
  const q = Math.min(100, Math.max(1, quality));
  const s = q < 50 ? Math.floor(5000 / q) : 200 - q * 2;
  const out = new Int32Array(64);
  for (let i = 0; i < 64; i++) out[i] = Math.min(255, Math.max(1, Math.floor((base[i] * s + 50) / 100)));
  return out;
}

/** 编码 4:4:4 基线 JPEG（输入 RGB，尺寸需为 8 的倍数或用边缘像素补齐） */
export function encodeJpeg(rgb, width, height, quality = 82) {
  const lq = scaleTable(STD_LUM, quality);
  const cq = scaleTable(STD_CHROM, quality);
  const chunks = [];
  let cur = Buffer.alloc(1 << 16);
  let curLen = 0;
  const push = (b) => {
    if (curLen >= cur.length) {
      chunks.push(cur.subarray(0, curLen));
      cur = Buffer.alloc(1 << 16);
      curLen = 0;
    }
    cur[curLen++] = b & 0xff;
  };
  const word = (w) => {
    push(w >> 8);
    push(w);
  };

  word(0xffd8);
  // JFIF APP0：部分解码器（libvips 等）缺少它时会拒绝读取
  word(0xffe0);
  word(16);
  push(0x4a); // 'J'
  push(0x46); // 'F'
  push(0x49); // 'I'
  push(0x46); // 'F'
  push(0x00);
  push(1);
  push(1); // 版本 1.1
  push(0); // 密度单位
  word(1); // X 密度
  word(1); // Y 密度
  push(0);
  push(0);
  word(0xffdb);
  word(2 + 65 * 2);
  push(0x00);
  for (let i = 0; i < 64; i++) push(lq[ZIGZAG[i]]);
  push(0x01);
  for (let i = 0; i < 64; i++) push(cq[ZIGZAG[i]]);

  word(0xffc0);
  word(8 + 9);
  push(8);
  word(height);
  word(width);
  push(3);
  push(1);
  push(0x11);
  push(0);
  push(2);
  push(0x11);
  push(1);
  push(3);
  push(0x11);
  push(1);

  const huffTable = (cls, id, bits, vals) => {
    word(0xffc4);
    word(2 + 1 + 16 + vals.length);
    push((cls << 4) | id);
    for (let i = 1; i <= 16; i++) push(bits[i]);
    for (const v of vals) push(v);
  };
  huffTable(0, 0, DC_LUM_BITS, DC_LUM_VALS);
  huffTable(1, 0, AC_LUM_BITS, AC_LUM_VALS);
  huffTable(0, 1, DC_CHROM_BITS, DC_CHROM_VALS);
  huffTable(1, 1, AC_CHROM_BITS, AC_CHROM_VALS);

  word(0xffda);
  word(6 + 6);
  push(3);
  push(1);
  push(0x00);
  push(2);
  push(0x11);
  push(3);
  push(0x11);
  push(0);
  push(63);
  push(0);

  let bitBuf = 0;
  let bitCount = 0;
  const putBits = (code, len) => {
    bitBuf = ((bitBuf << len) | code) >>> 0;
    bitCount += len;
    while (bitCount >= 8) {
      bitCount -= 8;
      const b = (bitBuf >>> bitCount) & 0xff;
      push(b);
      if (b === 0xff) push(0x00);
    }
    bitBuf &= (1 << bitCount) - 1;
  };

  const bw = Math.ceil(width / 8);
  const bh = Math.ceil(height / 8);
  const block = new Float64Array(64);
  const zz = new Int32Array(64);

  const fdct = (plane, shift) => {
    const tmp = new Float64Array(64);
    for (let y = 0; y < 8; y++) {
      for (let u = 0; u < 8; u++) {
        let s = 0;
        for (let x = 0; x < 8; x++) s += (plane[y * 8 + x] - shift) * IDCT_COS[u * 8 + x];
        tmp[y * 8 + u] = s * (u === 0 ? Math.SQRT1_2 : 1);
      }
    }
    for (let u = 0; u < 8; u++) {
      for (let v = 0; v < 8; v++) {
        let s = 0;
        for (let y = 0; y < 8; y++) s += tmp[y * 8 + u] * IDCT_COS[v * 8 + y];
        block[v * 8 + u] = 0.25 * s * (v === 0 ? Math.SQRT1_2 : 1);
      }
    }
  };

  const emit = (qt, pred, dcT, acT) => {
    for (let i = 0; i < 64; i++) zz[i] = Math.round(block[ZIGZAG[i]] / qt[ZIGZAG[i]]);
    const diff = zz[0] - pred;
    const sizeBits = (v) => (v === 0 ? 0 : Math.floor(Math.log2(Math.abs(v))) + 1);
    const s0 = sizeBits(diff);
    const e0 = dcT.get(s0);
    putBits(e0.code, e0.len);
    if (s0 > 0) putBits(diff > 0 ? diff : diff + (1 << s0) - 1, s0);

    let run = 0;
    for (let k = 1; k < 64; k++) {
      const v = zz[k];
      if (v === 0) {
        run++;
        continue;
      }
      while (run > 15) {
        const z = acT.get(0xf0);
        putBits(z.code, z.len);
        run -= 16;
      }
      const s = sizeBits(v);
      const e = acT.get((run << 4) | s);
      putBits(e.code, e.len);
      putBits(v > 0 ? v : v + (1 << s) - 1, s);
      run = 0;
    }
    if (run > 0) {
      const eob = acT.get(0x00);
      putBits(eob.code, eob.len);
    }
    return zz[0];
  };

  // 只对 Y 做电平搬移（-128），Cb/Cr 保持原样：解码端会自行减 128，
  // 若这里也加 128 会导致色度整体偏移 128（画面泛绿）。
  const yPlane = new Float64Array(64);
  const cbPlane = new Float64Array(64);
  const crPlane = new Float64Array(64);
  let predY = 0;
  let predCb = 0;
  let predCr = 0;

  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      for (let y = 0; y < 8; y++) {
        const py = Math.min(height - 1, by * 8 + y);
        for (let x = 0; x < 8; x++) {
          const px = Math.min(width - 1, bx * 8 + x);
          const o = (py * width + px) * 3;
          const r = rgb[o];
          const g = rgb[o + 1];
          const b = rgb[o + 2];
          const i = y * 8 + x;
          yPlane[i] = 0.299 * r + 0.587 * g + 0.114 * b;
          cbPlane[i] = -0.168736 * r - 0.331264 * g + 0.5 * b;
          crPlane[i] = 0.5 * r - 0.418688 * g - 0.081312 * b;
        }
      }
      fdct(yPlane, 128); // 亮度：电平搬移
      predY = emit(lq, predY, ENC_DC_L, ENC_AC_L);
      fdct(cbPlane, 0); // 色度：不做搬移
      predCb = emit(cq, predCb, ENC_DC_C, ENC_AC_C);
      fdct(crPlane, 0);
      predCr = emit(cq, predCr, ENC_DC_C, ENC_AC_C);
    }
  }

  if (bitCount > 0) putBits((1 << (8 - bitCount)) - 1, 8 - bitCount);
  word(0xffd9);

  chunks.push(cur.subarray(0, curLen));
  return Buffer.concat(chunks);
}

/* --------------------------------------------------------------- 对外接口 */

/** 双线性缩放 RGB */
export function resizeRgb(rgb, width, height, maxSize) {
  const scale = Math.min(1, maxSize / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  if (w === width && h === height) return { width, height, rgb };
  const out = new Uint8ClampedArray(w * h * 3);
  const xr = width / w;
  const yr = height / h;
  for (let y = 0; y < h; y++) {
    const sy = Math.min(height - 1, (y + 0.5) * yr - 0.5);
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(height - 1, y0 + 1);
    const wy = sy - y0;
    for (let x = 0; x < w; x++) {
      const sx = Math.min(width - 1, (x + 0.5) * xr - 0.5);
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(width - 1, x0 + 1);
      const wx = sx - x0;
      const o = (y * w + x) * 3;
      for (let c = 0; c < 3; c++) {
        const a = rgb[(y0 * width + x0) * 3 + c];
        const b = rgb[(y0 * width + x1) * 3 + c];
        const cc = rgb[(y1 * width + x0) * 3 + c];
        const d = rgb[(y1 * width + x1) * 3 + c];
        out[o + c] = (a * (1 - wx) + b * wx) * (1 - wy) + (cc * (1 - wx) + d * wx) * wy;
      }
    }
  }
  return { width: w, height: h, rgb: out };
}

/**
 * 生成缩略图 JPEG（1/8 DC 快速路径，无需完整 IDCT）。
 * 渐进式 JPEG 会抛出 code === "PROGRESSIVE" 的错误，调用方回退为浏览器原生解码。
 * @returns {{ buf: Buffer, width: number, height: number }}
 */
export function makeThumbnail(buf, maxSize = 480, quality = 80) {
  const decoded = decodeScaled(buf);
  const scaled = toRgbAtScale(decoded);
  const resized = resizeRgb(scaled.rgb, scaled.width, scaled.height, maxSize);
  const out = encodeJpeg(resized.rgb, resized.width, resized.height, quality);
  return { buf: out, width: resized.width, height: resized.height };
}

/** 只读图片尺寸（不解码像素） */
export function jpegSize(buf) {
  const hdr = parseHeader(buf);
  return { width: hdr.frame.width, height: hdr.frame.height, progressive: hdr.progressive };
}

/** 解码为 1/8 尺寸的 RGB（供测试/预览用） */
export function decodeJpegRgb(buf) {
  const decoded = decodeScaled(buf);
  return toRgbAtScale(decoded);
}

export function isProgressive(buf) {
  try {
    return parseHeader(buf).progressive === true;
  } catch {
    return false;
  }
}
