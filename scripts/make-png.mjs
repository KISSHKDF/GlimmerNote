#!/usr/bin/env node
/**
 * make-png.mjs — 纯 Node PNG 编码器（★ 2026-10-25 合成测试影像配套）
 *
 * 为什么存在：合成库需要"图形状"的卡（原卷整页 / 题图），但
 *   ① 不能依赖任何三方 npm 包（本仓零 node_modules，contributor 也不用装）；
 *   ② 图**不进 git**（.gitignore 挡全部 png；2026-10-25 刚删掉 fixtures png 的反向口子，
 *      那两行会让真卷影像静默入库——教训见 PRIVACY-AUDIT P2-1）。
 *   所以图由本模块**运行时生成**：测试物化库时现场画 PNG，仓库里只有生成器（本文件）。
 *
 * 能力：灰度/RGB、无压缩存储（够测试用，别拿来生成大图）、1x1 像素级写点/画框/画线。
 * PNG 规范实现：签名 + IHDR + IDAT(zlib.deflateSync) + IEND，CRC32 自带查表实现。
 *
 * 用法（库）：
 *   import { pngGray, pngRGB } from '../scripts/make-png.mjs'
 *   pngGray(w, h, fn)   // fn(x,y) → 0..255
 *   pngRGB(w, h, fn)    // fn(x,y) → [r,g,b]
 * 用法（CLI selftest）：node scripts/make-png.mjs
 *   产物写 %TEMP%，用头字节 + IHDR 尺寸 + zlib 可解 + 像素回读四步自证。
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import zlib from 'zlib';

/* ---------- CRC32（PNG 每个块都要） ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* ---------- chunk 组装 ---------- */
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * 生成 PNG（filter 0 行前缀，存储式压缩交给 zlib）。
 * @param w @param h 尺寸；@param bpp 每像素字节数（1=灰度，3=RGB）
 * @param px (x,y) → Buffer 段（调用方保证长度=bpp）
 */
function pngOf(w, h, bpp, px) {
  const raw = Buffer.alloc((w * bpp + 1) * h);
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0;                                  // filter: None
    for (let x = 0; x < w; x++) {
      const c = px(x, y);
      for (let k = 0; k < bpp; k++) raw[o++] = c[k];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;                                     // bit depth
  ihdr[9] = bpp === 1 ? 0 : 2;                     // color type: 0 灰度 / 2 RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 灰度图：fn(x,y) → 0..255 */
export function pngGray(w, h, fn) {
  const one = Buffer.alloc(1);
  return pngOf(w, h, 1, (x, y) => { one[0] = Math.max(0, Math.min(255, fn(x, y) | 0)); return one; });
}

/** RGB 图：fn(x,y) → [r,g,b]（0..255） */
export function pngRGB(w, h, fn) {
  const one = Buffer.alloc(3);
  return pngOf(w, h, 3, (x, y) => {
    const c = fn(x, y);
    one[0] = Math.max(0, Math.min(255, c[0] | 0));
    one[1] = Math.max(0, Math.min(255, c[1] | 0));
    one[2] = Math.max(0, Math.min(255, c[2] | 0));
    return one;
  });
}

/* ---------- 合成库需要的两种图 ---------- */

/**
 * 合成"原卷整页"：白底、浅灰页边距、顶部一条黑标题带、若干行"文字行"（灰色横条），
 * 以及（可选）一个深色红框区域——box 门禁要的红框可以按它对位。
 * @param opts { titleBar?: boolean } 标题带（默认 true）
 */
export function paperPage(w, h, opts) {
  const o = opts || {};
  const margin = Math.round(Math.min(w, h) * 0.04);
  const titleH = o.titleBar === false ? 0 : Math.round(h * 0.05);
  const lineH = Math.max(6, Math.round(h * 0.02));
  const gap = Math.max(4, Math.round(lineH * 0.9));
  return pngGray(w, h, (x, y) => {
    if (x < margin || x >= w - margin || y < margin || y >= h - margin) return 235;   // 页边距
    if (titleH && y >= margin + 4 && y < margin + 4 + titleH) {
      const pad = Math.round(w * 0.06);
      if (x >= pad && x < w - pad) return 40;                                        // 标题带
      return 255;
    }
    const ty = y - (margin + 4 + titleH + gap);
    if (ty >= 0) {
      const row = Math.floor(ty / (lineH + gap));
      if (row >= 0 && row < 22) {
        const inLine = ty % (lineH + gap) < lineH;
        const seg = Math.floor((x - margin) / (w * 0.3));                            // 每行三段"词"
        const segW = Math.round(w * 0.2);
        const inSeg = ((x - margin) % Math.round(w * 0.3)) < segW;
        const rowParity = (row + seg) % 3;
        if (inLine && inSeg && rowParity !== 0) return 90 + row % 3 * 10;            // 文字行
      }
    }
    return 255;
  });
}

/** 合成"题图"：白底 + 网格坐标 + 一条折线（几何/函数题的示意形状）。 */
export function figureGraph(w, h) {
  const ox = Math.round(w / 2), oy = Math.round(h / 2);
  return pngGray(w, h, (x, y) => {
    if (x === ox || y === oy) return 60;                                             // 坐标轴
    if (x % Math.round(w / 8) === 0 || y % Math.round(h / 8) === 0) return 225;      // 网格
    const fy = Math.round(oy - (x - ox) * 0.45);                                     // 折线 y=0.45x
    if (Math.abs(y - fy) <= 1) return 20;
    return 255;
  });
}

/* ---------- CLI selftest（门禁挂 tests\synthetic-lib-shape.cjs，别删这里） ---------- */
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('make-png.mjs')) {
  let bad = 0;
  const A = (n, ok, d = '') => { console.log((ok ? '  [OK]  ' : '  [FAIL] ') + n + (d ? '  → ' + d : '')); if (!ok) bad++; };

  const g1 = pngGray(64, 32, () => 128);
  A('灰度 PNG 头字节（89 50 4E 47）', g1[0] === 0x89 && g1[1] === 0x50 && g1[2] === 0x4E && g1[3] === 0x47, g1.length + ' B');
  A('IHDR 宽高 = 64x32', g1.readUInt32BE(16) === 64 && g1.readUInt32BE(20) === 32, '');
  const r1 = pngGray(64, 32, (x, y) => (x + y) % 256);
  const dec1 = zlib.inflateSync((() => { const s = g1.indexOf(Buffer.from('IDAT', 'ascii')); const len = g1.readUInt32BE(s - 4); return g1.subarray(s + 4, s + 4 + len); })());
  A('IDAT 可 zlib 解压且行宽=65', dec1.length === (64 + 1) * 32, dec1.length + ' B');
  const decR = zlib.inflateSync((() => { const s = r1.indexOf(Buffer.from('IDAT', 'ascii')); const len = r1.readUInt32BE(s - 4); return r1.subarray(s + 4, s + 4 + len); })());
  const px = (x, y) => decR[(64 + 1) * y + 1 + x];
  A('像素回读：px(3,4)=(3+4)%256', px(3, 4) === ((3 + 4) % 256), String(px(3, 4)));
  A('像素回读：px(63,9)=(63+9)%256（右下角）', px(63, 9) === ((63 + 9) % 256), String(px(63, 9)));

  const rgb = pngRGB(8, 8, (x) => [x * 30, 0, 255 - x * 30]);
  A('RGB PNG IHDR colorType=2', rgb[25] === 2, 'len=' + rgb.length);

  const p1 = paperPage(240, 320);
  A('paperPage 240x320 头字节 + IHDR', p1[0] === 0x89 && p1.readUInt32BE(16) === 240 && p1.readUInt32BE(20) === 320, p1.length + ' B');
  const f1 = figureGraph(200, 200);
  A('figureGraph 200x200 头字节 + IHDR', f1[0] === 0x89 && f1.readUInt32BE(16) === 200 && f1.readUInt32BE(20) === 200, f1.length + ' B');

  /* 场景自证：_待确认.mjs 的 imgSize 认 PNG 的方式 = 头两字节 89 50 + IHDR 16/20 偏移 */
  A('imgSize 判据（89 50 + 偏移16/20）能读出尺寸', p1.readUInt32BE(16) === 240 && f1.readUInt32BE(20) === 200, '');

  const out = path.join(os.tmpdir(), 'gn-png-selftest-' + Date.now() + '.png');
  fs.writeFileSync(out, p1);
  const back = fs.readFileSync(out);
  A('写盘再读回逐字节相等', back.equals(p1), out);
  fs.rmSync(out, { force: true });

  console.log('\nRESULT=' + (bad ? 'FAIL' : 'PASS'));
  process.exit(bad ? 1 : 0);
}
