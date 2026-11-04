/* 图像「显示尺寸」与方向：纯 Node 读文件头，零依赖、零子进程、不写盘。
 *
 * 为什么存在（2026-11-02）：`_原卷台账.mjs` 的长宽比体检需要每张图的像素宽高，
 * 旧实现去调 `<库根>\_工具\图尺寸.ps1` —— 那个脚本**仓库与运行区都不存在**（两树 0 命中），
 * 于是体检永远拿不到输入，却照样打印「长宽比体检：全部通过」＝假绿（用户 2026-11-02 质问的正是这条）。
 * 现在改为进程内读文件头：输入永远可得；读不出的格式明确返回 null，由调用方打印 SKIP，**不许静默**。
 *
 * 判据：只认「文件头里声明的尺寸」，不做完整解码（体检只需要宽高与方向）。
 *   PNG  : 8 字节签名 + IHDR
 *   JPEG : SOI 之后逐段扫到 SOF0/1/2/3/5/6/7/9/10/11/13/14/15（C0–CF 去掉 C4/C8/CC）
 *   GIF  : 逻辑屏尺寸
 *   BMP  : BITMAPINFOHEADER
 *   WebP : RIFF/WEBP，支持 VP8X（扩展）/ VP8（有损）/ VP8L（无损）
 * 方向：只解析 JPEG 的 EXIF orientation（1~8）。5~8 表示"存储是横的、显示要转 90°"，
 *   故 displaySize() 交换宽高，与渲染层看到的画面一致。
 *
 * 已知边界（诚实写明）：只读文件头前 512 KB。异常大的 EXIF/缩略图把 SOF 顶到 512 KB 之后时返回 null
 *   ⇒ 调用方打印 SKIP，不会变成"假通过"。
 */
import fs from 'node:fs';

const HEAD_BYTES = 512 * 1024;

/** 读文件头（最多 HEAD_BYTES）；读不到返回 null */
function head(abs) {
  let fd;
  try {
    fd = fs.openSync(abs, 'r');
    const size = fs.fstatSync(fd).size;
    const n = Math.min(size, HEAD_BYTES);
    if (n < 4) return null;
    const buf = Buffer.allocUnsafe(n);
    const got = fs.readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, got);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* 关不上也不掩盖上面的结果 */ } }
  }
}

/* ---------- JPEG：EXIF 方向 + SOF 尺寸（同一趟扫描，只扫一次） ---------- */
function jpegInfo(b) {
  let o = 2, orientation = null, w = null, h = null;
  while (o + 3 < b.length) {
    if (b[o] !== 0xFF) { o++; continue; }
    const m = b[o + 1];
    if (m === 0xFF) { o++; continue; }                       // 填充字节
    if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { o += 2; continue; }
    if (m === 0xDA) break;                                   // 扫描数据开始，元数据都在前面
    const len = (b[o + 2] << 8) | b[o + 3];
    if (len < 2) break;
    /* APP1 + "Exif\0\0" ⇒ 解 TIFF IFD，找 orientation(0x0112) */
    if (m === 0xE1 && orientation === null &&
        b[o + 4] === 0x45 && b[o + 5] === 0x78 && b[o + 6] === 0x69 && b[o + 7] === 0x66) {
      const tiff = o + 10;
      if (tiff + 8 <= b.length) {
        const le = b[tiff] === 0x49 && b[tiff + 1] === 0x49;
        const rd16 = p => (le ? (b[p] | (b[p + 1] << 8)) : ((b[p] << 8) | b[p + 1]));
        const rd32 = p => (le
          ? ((b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0)
          : (((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0));
        const ifd = tiff + rd32(tiff + 4);
        const n = (ifd + 2 <= b.length) ? rd16(ifd) : 0;
        for (let i = 0; i < n; i++) {
          const e = ifd + 2 + i * 12;
          if (e + 12 > b.length) break;
          if (rd16(e) === 0x0112) { orientation = rd16(e + 8); break; }
        }
      }
    }
    /* SOF：C0-CF 里排除 C4(DHT)/C8(JPG)/CC(DAC) ⇒ 段内 [len2][精度1][高2][宽2] */
    const isSof = m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC;
    if (isSof && o + 9 <= b.length) {
      h = (b[o + 5] << 8) | b[o + 6];
      w = (b[o + 7] << 8) | b[o + 8];
    }
    o += 2 + len;
  }
  if (w == null || h == null) return null;
  return { w, h, format: 'jpeg', orientation };
}

function pngInfo(b) {
  if (b.length < 24) return null;
  if (b.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), format: 'png', orientation: null };
}

function gifInfo(b) {
  if (b.length < 10) return null;
  return { w: b.readUInt16LE(6), h: b.readUInt16LE(8), format: 'gif', orientation: null };
}

function bmpInfo(b) {
  if (b.length < 26) return null;
  const w = b.readInt32LE(18), h = Math.abs(b.readInt32LE(22));
  return { w, h, format: 'bmp', orientation: null };
}

function webpInfo(b) {
  const four = b.toString('ascii', 12, 16);
  if (four === 'VP8X' && b.length >= 30) {
    const w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
    const h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
    return { w, h, format: 'webp', orientation: null };
  }
  if (four === 'VP8 ' && b.length >= 30) {
    /* 有损：帧头 0x9D 0x01 0x2A 之后是 14 位宽、14 位高（小端） */
    const p = 26;
    if (b[p] === 0x9D && b[p + 1] === 0x01 && b[p + 2] === 0x2A) {
      const w = (b[p + 3] | (b[p + 4] << 8)) & 0x3FFF;
      const h = (b[p + 5] | (b[p + 6] << 8)) & 0x3FFF;
      return { w, h, format: 'webp', orientation: null };
    }
  }
  if (four === 'VP8L' && b.length >= 25 && b[20] === 0x2F) {
    const bits = b.readUInt32LE(21);
    return { w: (bits & 0x3FFF) + 1, h: ((bits >> 14) & 0x3FFF) + 1, format: 'webp', orientation: null };
  }
  return null;
}

/** 图像尺寸与方向：{w,h,format,orientation}；不认识/读不出 ⇒ null（调用方必须报 SKIP，不许当"通过"） */
export function imageSize(abs) {
  const b = head(abs);
  if (!b || b.length < 16) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return pngInfo(b);
  if (b[0] === 0xFF && b[1] === 0xD8) return jpegInfo(b);
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return gifInfo(b);
  if (b[0] === 0x42 && b[1] === 0x4D) return bmpInfo(b);
  if (b.length >= 16 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return webpInfo(b);
  return null;
}

/** 显示尺寸（应用 EXIF 方向：5~8 交换宽高） */
export function displaySize(abs) {
  const s = imageSize(abs);
  if (!s) return null;
  const swap = s.orientation != null && s.orientation >= 5 && s.orientation <= 8;
  return { w: swap ? s.h : s.w, h: swap ? s.w : s.h, format: s.format, orientation: s.orientation };
}

/** JPEG 的 EXIF orientation（非 JPEG / 无标记 ⇒ null）。方向体检用，语义与原实现一致。 */
export function jpegOrientation(abs) {
  const b = head(abs);
  if (!b || b[0] !== 0xFF || b[1] !== 0xD8) return null;
  const s = jpegInfo(b);
  return s ? s.orientation : null;
}
