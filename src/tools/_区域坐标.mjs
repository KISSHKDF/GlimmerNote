/* 拾光小册 · 区域坐标换算（**唯一实现**：像素 ↔ 归一化 0~1）
 *
 * 为什么要有这个文件（2026-11-03 · 批次 2 / P2-2「统一坐标系」）：
 *   仓库里一直并存两套框：
 *     · `_原卷台账.json` 的 `box` = **归一化 0~1**（相对整页原图自身像素）
 *     · `_待确认.json`    的 `box` = **源图像素** `[x,y,w,h]`
 *   没有任何一处说明它们怎么互换，于是实测出事：T187~T192 把 0~1 的值按像素用，
 *   灯箱红框缩成左上角 1 像素点（`_待确认.mjs::boxProblem()` 至今在点这类数据）。
 *   现在换算只有这一份，`_待确认.mjs`（读取侧附加 `boxNorm/imgW/imgH`）与
 *   `_服务端.mjs`（`GET /api/state` 的 pending 条目附加同样三个字段）都 import 它。
 *
 * 为什么是**独立模块**而不是挂在 `_待确认.mjs` 上导出（口径修正，实测依据）：
 *   `_待确认.mjs` 是纯 CLI 脚本：`:64` 导入期就 `libraryRoot()`、`:69` 导入期就 `acquireLibLock()`
 *   抢跨进程库锁，文件末尾一整条 `if (action === …)` 分发到 `process.exit`。
 *   服务端 import 它 = 启动那一刻抢库锁 + 跑一遍 CLI 动作；而服务端本来要靠 **spawn** 它的子命令
 *   干活，主进程自己持锁是等着来自死锁。与 `_配方.mjs:46-52` 记的教训同族：
 *   **任何在导入期求值库根/抢锁的模块，都不能被别人 import 复用。**
 *
 * 纪律（改之前先读）：
 *   ① **零导入期副作用**：不 import `_库根.mjs`、不求值库根、不抢锁、不读写用户库。
 *      本文件只按**传入的绝对路径** `fs` 读文件头，`root` 一律由调用方给。
 *   ② **只读文件头**：尺寸走 `_图尺寸.mjs::displaySize()`（PNG/JPEG/GIF/BMP/WebP，JPEG 应用 EXIF 方向），
 *      不做完整解码、不写任何缓存。`imgW/imgH` 的语义是**显示**宽高（横拍照片交换过宽高），
 *      否则带 EXIF orientation 的卷面照画出来的框会整体错位 90°。
 *   ③ **量不出就给原因，绝不当 0**（教训 L-530：缺失字段不许当值）。
 *      本文件的失败形态统一是 `{ ok:false, why }`，调用方必须把 `why` 原样带给用户/前端。
 *   ④ 坐标一律 5 位小数（`round5`），与 `_待确认.mjs::parseNormBox()` 同口径 ——
 *      同一个框不许存成两种字面。
 *
 * 契约文档：`docs\区域契约.md`（口径真源）；回归：`tests\neg-region-contract.cjs`
 */
import fs from 'node:fs';
import path from 'node:path';
import { displaySize } from './_图尺寸.mjs';

/** 像素框越界容差（px）：与 `_待确认.mjs::boxProblem()` 的 `+2` 同口径（拍照/手点框的整数舍入余量） */
export const BOX_PX_TOLERANCE = 2;

/* 归一化一律 5 位小数（与 `_待确认.mjs::parseNormBox()` 同口径：同一个框不许存成两种字面） */
const round5 = n => Math.round(n * 1e5) / 1e5;
const isPosInt = n => Number.isInteger(n) && n > 0;
const finite4 = b => Array.isArray(b) && b.length === 4 && b.every(n => typeof n === 'number' && Number.isFinite(n));

/** 证据图相对路径 → 绝对路径（`root` = 库根，必须由调用方给）。
 *
 *  `null` 表示"给不出绝对路径"（没给 root / 没给路径），调用方据此给"没有证据图路径"的原因。
 *  ⚠ 刻意**不做**库根包含性判断：本函数的前身是 `_待确认.mjs` 的 `evAbs`（`path.join(ROOT, normEv(ev))`），
 *    库外路径在那里由 `证据`/`对位` 门禁点名，不在这一层拦。改这里会连带改掉那两条门禁的行为。 */
export function evidenceAbs(rel, root) {
  const base = String(root == null ? '' : root).trim();
  if (!base) return null;
  const s = String(rel == null ? '' : rel).trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/{2,}/g, '/');
  if (!s) return null;
  return path.join(path.resolve(base), s.replace(/\//g, path.sep));
}

/** 像素框 → 归一化框。`imgW/imgH` 必须是**正整数**（显示宽高）。
 *
 *  → `{ ok:true, boxNorm:[x,y,w,h] }` | `{ ok:false, why }`
 *
 *  越界判据（±`BOX_PX_TOLERANCE` px）：`x<0` / `y<0` / `x+w>imgW+2` / `y+h>imgH+2` / `w<=0` / `h<=0`。
 *  为什么越界要判红而不是夹到 0~1：夹边会把"框到别人页上/框算错了"伪装成一个合法框，
 *  与"量不出当 0"是同一类事故。 */
export function boxNormOf(boxPx, imgW, imgH) {
  if (!isPosInt(imgW) || !isPosInt(imgH)) {
    return { ok: false, why: 'imgW/imgH 不是正整数：' + JSON.stringify([imgW, imgH]) + '（显示宽高必需，缺了坐标不可复算）' };
  }
  if (!finite4(boxPx)) {
    return { ok: false, why: 'boxPx 不是 4 个有限数字：' + JSON.stringify(boxPx) };
  }
  const [x, y, w, h] = boxPx;
  if (w <= 0 || h <= 0) {
    return { ok: false, why: '红框宽或高 ≤ 0：' + JSON.stringify(boxPx) };
  }
  if (x < 0 || y < 0 || x + w > imgW + BOX_PX_TOLERANCE || y + h > imgH + BOX_PX_TOLERANCE) {
    return { ok: false, why: '红框超出图片范围（图 ' + imgW + 'x' + imgH + '，框 ' + boxPx.join(',') + '）' };
  }
  return { ok: true, boxNorm: [round5(x / imgW), round5(y / imgH), round5(w / imgW), round5(h / imgH)] };
}

/** 量证据图显示宽高 + 把像素框归一化（服务端/工具共用的唯一入口）。
 *
 *  → `{ ok:true, boxNorm:[x,y,w,h], imgW, imgH }` | `{ ok:false, why }`
 *
 *  `imgAbs` 量不出尺寸时 `ok:false` 且 `why` 带**图路径与具体原因**（文件不在 / 读不出文件头）。
 *  **绝不**返回 `imgW:0` —— 那等于把一个错误坐标伪装成合法坐标。 */
export function normEvidenceBox({ boxPx, imgAbs } = {}) {
  const p = String(imgAbs == null ? '' : imgAbs).trim();
  if (!p) return { ok: false, why: '没有证据图路径，量不出显示宽高' };
  const abs = path.resolve(p);
  let st = null;
  try { st = fs.statSync(abs); } catch (e) {
    return { ok: false, why: '证据图不在盘：' + abs };
  }
  if (!st.isFile()) return { ok: false, why: '证据图不是文件：' + abs };
  let size = null;
  try { size = displaySize(abs); } catch (e) { size = null; }
  if (!size) {
    return { ok: false, why: '读不出文件头（格式不支持或文件损坏）：' + abs };
  }
  const r = boxNormOf(boxPx, size.w, size.h);
  if (!r.ok) return { ok: false, why: r.why };
  return { ok: true, boxNorm: r.boxNorm, imgW: size.w, imgH: size.h };
}