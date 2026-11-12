#!/usr/bin/env node
/* 拾光小册 · 经验包只读引擎（2026-11-03，批次 2）
 *
 * 为什么要有这一层（建议书 §5 / 施工方案 §6 批次 2）：
 *   内置配方只能随程序版本发布——它承诺"完全离线、程序不带大脑"。但**一条具体方法**的
 *   生命周期比程序短得多（题型变、遇到新坑、某个模型更容易听懂另一种说法）。若每条方法
 *   都靠发版，方法层就永远追不上现场。
 *   经验包 = 把"一条可公开的方法"装成独立文件夹：能安装、能选、能停、能回退，
 *   而且**坏包只影响自身**（清单照常列，内置配方照常可用）。
 *
 * 三条硬边界（违反即返工）：
 *   ① **只读**：本工具不写任何文件——不写用户库、不写经验包根。首版"安装"= 手工复制文件夹，
 *      "停用" = 包里放一个 `.停用` 文件（删掉即恢复回退）。刻意**不提供写子命令**：
 *      每多一条写路径就多一个"静默写错地方"的面（本仓 2026-10 两次事故的根因）。
 *   ② **不依赖库根**：`清单`/`校验`/`摘要` 在没有任何用户库的机器上也必须能用
 *      （所以本模块**不在导入期**求值 `libraryRoot()`，见 `_路径护栏.mjs` 文件头 ②）。
 *   ③ **不静默降级**：未知 formatVersion、越界路径、重解析点逃逸、超限、重复卡 ID、
 *      同版异内容 —— 一律给**具体原因**；坏包不能被当成"空包"或"好包"放过。
 *
 * 契约真源：`docs\经验包规范.md`（本工具每个子命令/字段都在那里登记）。
 *   ⚠ 一份事实一个家：包格式与判据规则写文档，代码只做校验与报告，不在两处各写一份。
 *
 * ── CLI ──────────────────────────────────────────────────────────────
 *   node src\tools\_经验包.mjs 清单   [--json] [--packs <dir>]
 *   node src\tools\_经验包.mjs 校验 <dir> [--json] [--packs <dir>]
 *   node src\tools\_经验包.mjs 摘要 <dir> [--json] [--packs <dir>]
 *
 *   退出码：0 = 通过/成功；1 = 内容不合法（包坏了）；2 = 参数或环境错（目录不存在、子命令不认识）。
 *     `清单` 是**报告**不是门禁：坏包只影响自身一行，整体仍 exit 0（不因为它红整个清单）。
 *     `摘要` 对不合法包给 exit 1（契约 §2.1 的表只写了 0/2；这里刻意加 1 ——
 *     否则"坏包"会被打印成一份看起来正常的摘要，正是本仓最忌的静默放过。已回报 Lead）。
 *
 * ── 库导出（供 `_配方.mjs` 用；形状已由契约 §2.2 冻结）───────────────
 *   PACK_FORMAT_VERSION / MAX_FILES / MAX_FILE_BYTES / MAX_PACK_BYTES
 *   packsRoot(explicit)   parseCardSel(s)   listPacks(explicitRoot)
 *   loadCard(sel, explicitRoot)   validatePack(dir, explicitRoot?)
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
/* ★ 2026-11-03：包含性判据**只有一份**（`_路径护栏.mjs` 的 isInside）。
   本模块静态导入它是安全的 —— 那个模块的库根已改成惰性求值，导入不再需要库。 */
import { isInside } from './_路径护栏.mjs';
/* ★ 2026-11-04（M1·实测）：参数解析改走**唯一实现** `_参数.mjs`。 */
import { parseArgs, COMMON_VALUE_FLAGS } from './_参数.mjs';

/* ══════════════════════ 常量（契约 §2.2：形状冻结，改值要同步文档）══════════════════════ */
export const PACK_FORMAT_VERSION = 1;
export const MAX_FILES = 64;
export const MAX_FILE_BYTES = 262144;
export const MAX_PACK_BYTES = 1048576;

/** 停用标记：包目录里存在它 ⇒ 已停用（内容随意，建议写停用原因）。删掉即恢复。 */
const DISABLED_MARK = '.停用';
/** 包清单文件名（固定）。 */
const PACK_FILE = 'pack.json';

/* 选卡串形状（**与 C# 壳 §4 是同一条判据，不是两套口径**）：
 *
 *   ^[A-Za-z0-9_\-][A-Za-z0-9._\-]*(/[A-Za-z0-9_\-][A-Za-z0-9._\-]*)+@[0-9]+\.[0-9]+\.[0-9]+$
 *
 * 为什么每段**首字符**不许是 `.`：首版写成 `[A-Za-z0-9._\-]+`，于是 `..` 段天然合法，
 *   `../evil/card@1.0.0` 能整条通过形状门禁（Lead 2026-11-03 在真 exe 反射测试里当场抓到）。
 *   形状判据是**第一道**；realpath 包含性是**第二道**，两道互不替代。
 * 为什么只允许 ASCII：壳层要按同一条正则逐项校验（固定映射、无通用透传），
 *   引擎若放行中文段，就会出现"CLI 能选、界面选不了"的口径漂移。
 * 为什么至少两段：`<packId 段…>/<cardId>` —— packId 至少一段，再没有卡就没有指向。 */
export const CARD_SEL_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)+@[0-9]+\.[0-9]+\.[0-9]+$/;
/** 单段（packId 的一段 / cardId）：与上面同一条字符类。 */
const SEG_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;
/** 外部 URL 判据（契约 §2.1 逐字给的正则：`^[a-zA-Z][a-zA-Z0-9+.\-]*:` 或 `//` 开头）。 */
const EXTERNAL_URL_RE = /^[a-zA-Z][a-zA-Z0-9+.\-]*:/;
/** 天真的 `开始遍历` 深度上限（防重解析点造的环；包 ID 正常 ≤3 段 + version）。 */
const WALK_MAX_DEPTH = 8;

/* ══════════════════════ 小工具 ══════════════════════ */
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const readText = (p) => fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const toPosix = (p) => String(p).split(path.sep).join('/');
const sha256Buf = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const short = (hex) => String(hex || '').slice(0, 12);
/** 两处路径是否指同一份东西（大小写不敏感；尽量用 realpath 比，拿不到就退回字符串比）。 */
function samePath(a, b) {
  const norm = (p) => {
    try { return fs.realpathSync(p).toLowerCase(); } catch { return path.normalize(p).toLowerCase(); }
  };
  return norm(a) === norm(b);
}

/* ══════════════════════ 经验包根（契约 §1，唯一实现）══════════════════════
 * 解析顺序（**改顺序要同步 docs\经验包规范.md**）：
 *   ① `--packs <dir>`（显式，最高优先；测试一律用它）
 *   ② 环境变量 `CTB_PACKS`
 *   ③ 默认 `%LOCALAPPDATA%\拾光小册\经验包\`
 *      （读不到 LOCALAPPDATA 时回落 `<用户主目录>\AppData\Local\拾光小册\经验包`）
 * 为什么放 LOCALAPPDATA 而不是仓库里：经验包是**用户装的东西**，不是程序资产；
 *   放进仓库会让"我装了什么"跟着 git 走、还会被发布包打包出去（施工方案 §6 已定）。
 * ⚠ 不做存在性检查：`清单` 在根不存在时要打印"没有安装任何经验包"并 exit 0，不是报错。 */
export function packsRoot(explicit) {
  const pick = (v) => (typeof v === 'string' && v.trim() ? path.resolve(v.trim()) : '');
  const ex = pick(explicit);
  if (ex) return ex;
  const env = pick(process.env.CTB_PACKS);
  if (env) return env;
  const lad = pick(process.env.LOCALAPPDATA);
  const base = lad || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, '拾光小册', '经验包');
}

/* ══════════════════════ 选卡串解析（契约 §1）══════════════════════
 * 形状：`<packId>/<cardId>@<version>`，例 `family-a/shared-stem/shared-stem@1.0.0`。
 * 解析规则：按**最后一个** `@` 切 version；剩下按 `/` 切，**最后一段 = cardId**，前面全部 = packId。
 * 于是两条约束必须由形状判据保证：cardId 不含 `/` 与 `@`；packId 至少一段。
 * 为什么用最后一个 `@` 而不是唯一一个：与壳层同口径，且卡正文里出现 `@` 也不会歧义到这里
 *   （形状判据已经把段内 `@` 拒掉，这只是纵深）。 */
export function parseCardSel(sel) {
  const raw = typeof sel === 'string' ? sel.trim() : '';
  const bad = (why) => ({ ok: false, packId: '', cardId: '', version: '', why });
  if (!raw) return bad('选卡串为空：期望 <packId>/<cardId>@<version>，例 family-a/shared-stem/shared-stem@1.0.0');
  if (!CARD_SEL_RE.test(raw)) return bad('选卡串形状不合法：' + JSON.stringify(raw) + ' —— ' + selWhy(raw));
  const at = raw.lastIndexOf('@');
  const rest = raw.slice(0, at);
  const version = raw.slice(at + 1);
  const segs = rest.split('/');
  const cardId = segs.pop();
  const packId = segs.join('/');
  /* 纵深：正则已经挡住以下形状，这里再判一次并把话说清楚（判据不只靠一处）。 */
  if (!packId || !cardId) return bad('选卡串形状不合法：' + JSON.stringify(raw) + ' —— packId 至少一段、cardId 必须一段');
  if (segs.some((s) => s === '.' || s === '..') || cardId === '.' || cardId === '..') {
    return bad('选卡串形状不合法：' + JSON.stringify(raw) + ' —— 不接受 . 或 .. 段（路径穿越）');
  }
  if (segs.some((s) => !SEG_RE.test(s)) || !SEG_RE.test(cardId) || !VERSION_RE.test(version)) {
    return bad('选卡串形状不合法：' + JSON.stringify(raw) + ' —— 段只允许 [A-Za-z0-9._-] 且首字符不许是 .；版本号必须是 数字.数字.数字');
  }
  return { ok: true, packId, cardId, version, why: '' };
}

/** 给"形状不合法"一句可照做的原因（不是一句"格式错"）。 */
function selWhy(raw) {
  const at = raw.lastIndexOf('@');
  if (at < 0) return '缺 @ 与版本号：期望 <packId>/<cardId>@<version>';
  const rest = raw.slice(0, at);
  const ver = raw.slice(at + 1);
  if (!VERSION_RE.test(ver)) return '版本号必须是 数字.数字.数字（例 1.0.0），收到 ' + JSON.stringify(ver);
  if (rest.includes('\\')) return '不接受反斜杠（段用 / 分隔），收到 ' + JSON.stringify(rest);
  if (/^[\\/]/.test(rest)) return '不接受绝对路径（以分隔符开头），收到 ' + JSON.stringify(rest);
  if (/^[A-Za-z]:/.test(rest)) return '不接受盘符绝对路径，收到 ' + JSON.stringify(rest);
  const segs = rest.split('/');
  if (segs.length < 2) return '至少两段：<packId 段…>/<cardId>，收到 ' + segs.length + ' 段';
  const dot = segs.find((s) => s === '.' || s === '..');
  if (dot) return '不接受 . 或 .. 段（路径穿越），收到 ' + JSON.stringify(dot);
  const badSeg = segs.find((s) => !SEG_RE.test(s));
  return '每段只允许 [A-Za-z0-9._-] 且首字符不许是 .，非法段：' + JSON.stringify(badSeg === '' ? '(空段)' : badSeg);
}

/** packId / cardId 的单段形状（包内部对 id 的判据与选卡串同一条字符类）。 */
function idOk(id) {
  return typeof id === 'string' && id.length > 0 && id.split('/').every((s) => SEG_RE.test(s));
}

/* ══════════════════════ 目录遍历（只读、不跟随重解析点）══════════════════════
 * 为什么不用 `fs.glob`/递归 readdir 简单版：
 *   ① 重解析点（junction/symlink）会造环 ⇒ 必须设深度上限并**不跟随**；
 *   ② 限值判据要"包内数据文件数/单文件大小/整包合计"，必须拿到一份确定的文件清单；
 *   ③ 摘要要对同一份清单算（计数与摘要用同一口径，否则"文件数够了但摘要漏文件"）。
 * 口径：跳过**隐藏**（`.` 开头）文件与目录 —— `.停用` 是标记不是内容，不进摘要也不计入限值。 */
function collectDataFiles(packDir) {
  const out = [];
  const walk = (dir, relBase, depth) => {
    if (depth > WALK_MAX_DEPTH) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      const rel = relBase ? relBase + '/' + e.name : e.name;
      let st;
      try { st = fs.lstatSync(full); } catch { continue; }
      if (st.isSymbolicLink()) continue;          // 不跟随：重解析点由"引用路径"那条判据单独查
      if (st.isDirectory()) { walk(full, rel, depth + 1); continue; }
      if (st.isFile()) out.push({ rel, abs: full, size: st.size });
    }
  };
  walk(packDir, '', 0);
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

/** 内容摘要：包内**非隐藏**文件按相对路径排序后逐条 `rel\0sha256(字节)\0` 再 sha256。
 *  用途只有一个：判断"同一个 id@version 的内容是不是变了"（同版异内容判据）。
 *  为什么按**字节**而不是文本：包的正文是给 AI 看的文本，但案例里可能有 SVG/图片；
 *  用字节口径对全部文件一视同仁，且不依赖编码假设。 */
export function packDigest(dir) {
  const h = crypto.createHash('sha256');
  for (const f of collectDataFiles(dir)) {
    h.update(f.rel);
    h.update('\u0000');
    h.update(sha256Buf(fs.readFileSync(f.abs)));
    h.update('\u0000');
  }
  return h.digest('hex');
}

/* ══════════════════════ 校验（契约 §2.1 的错误分类）══════════════════════
 * 返回 `{ ok, dir, id, version, formatVersion, cards, errors, notes }`；
 * `errors[]` 每项 `{ code, what, why }`：code 是分类（结构/重复/缺文件/越界/限值/同版异内容/未知版本/参数），
 * what 指向具体位置（`cards[1].body`），why 是**具体原因**（带实际数字/路径），不是一句"校验失败"。
 * notes[] 是"不是错但要说出口"的东西（停用、缺可选元数据、不在包根下的候选目录…）。
 *
 * ⚠ 坏包审计纪律：一次收集**尽可能多**的错误再返回，而不是遇到第一条就停 ——
 *   "改一条、再跑、又红一条"的体验会让人放弃修包；但**每条都必须具体**。
 */
export function validatePack(dir, explicitRoot) {
  const errors = [];
  const notes = [];
  const E = (code, what, why) => { errors.push({ code, what, why }); };
  const N = (msg) => { notes.push(msg); };
  const packDir = path.normalize(String(dir || ''));
  const out = { ok: false, dir: packDir, id: '', version: '', formatVersion: null, cards: [], errors, notes };
  const finish = () => { out.ok = errors.length === 0; return out; };

  if (!packDir || !isDir(packDir)) {
    E('参数', '包目录', packDir ? '不存在或不是目录：' + packDir : '未给出目录');
    return finish();
  }
  let realPack;
  try { realPack = fs.realpathSync(packDir); } catch (e) {
    E('参数', '包目录', '无法解析真实路径：' + packDir + '（' + e.message + '）');
    return finish();
  }

  /* ── ① 结构：pack.json 必须在、必须是合法 JSON 对象 ── */
  const packFile = path.join(packDir, PACK_FILE);
  if (!isFile(packFile)) {
    E('结构', PACK_FILE, '缺 ' + PACK_FILE + '：' + packFile +
      '（经验包根目录固定是 <经验包根>/<packId>/<version>/pack.json）');
    return finish();
  }
  let doc;
  try { doc = JSON.parse(readText(packFile)); } catch (e) {
    E('结构', PACK_FILE, '不是合法 JSON：' + e.message);
    return finish();
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    E('结构', PACK_FILE, '顶层必须是对象，实际 ' + (Array.isArray(doc) ? 'array' : typeof doc));
    return finish();
  }

  /* ── ② formatVersion：只认 1，未知版本**一律拒**（不猜、不降级）── */
  out.formatVersion = doc.formatVersion === undefined ? null : doc.formatVersion;
  if (doc.formatVersion !== PACK_FORMAT_VERSION) {
    E('未知版本', 'formatVersion',
      '只认 ' + PACK_FORMAT_VERSION + '，收到 ' + JSON.stringify(doc.formatVersion) +
      ' —— 未知格式版本一律拒（不同版本字段语义可能不同，猜着读=静默降级）');
  }

  /* ── ③ id / version ── */
  out.id = str(doc.id);
  out.version = str(doc.version);
  if (!out.id) E('结构', 'id', '缺 id（字符串，段用 / 分隔，例 family-a/shared-stem）');
  else if (!idOk(out.id)) {
    E('结构', 'id', 'id 形状非法：' + JSON.stringify(doc.id) +
      '（每段只允许 [A-Za-z0-9._-] 且首字符不许是 .，不许 . / .. 段、反斜杠、@）');
  }
  if (!out.version) E('结构', 'version', '缺 version（形如 1.0.0）');
  else if (!VERSION_RE.test(out.version)) {
    E('结构', 'version', '版本号必须是 数字.数字.数字，收到 ' + JSON.stringify(doc.version));
  }

  /* ── ④ 目录名与 pack.json 对账（只对"已安装"的包有意义）──
   * 目录名的最后一段就是 version、前面就是 packId（契约 §1）。两者不一致 ⇒ 同一个包会有
   * 两个身份（清单按目录名报、选卡串按目录名找、pack.json 又写着另一个），这是最难查的一类错。 */
  const root = packsRoot(explicitRoot);
  if (isInside(root, packDir) && !samePath(root, packDir)) {
    const rel = path.relative(root, packDir).split(path.sep).filter(Boolean);
    const dirVersion = rel.length >= 2 ? rel[rel.length - 1] : '';
    const dirId = rel.length >= 2 ? rel.slice(0, -1).join('/') : '';
    if (!dirVersion || !dirId) {
      E('结构', '目录布局', '包目录必须是 <经验包根>/<packId>/<version>，实际只差 ' + rel.length + ' 层：' +
        toPosix(path.relative(root, packDir)));
    } else {
      if (out.version && dirVersion !== out.version) {
        E('结构', '目录/版本', '包目录最后一段（version）是 ' + JSON.stringify(dirVersion) +
          '，pack.json 的 version 是 ' + JSON.stringify(out.version) +
          ' —— 二者必须一致（版本永久保留：改内容=新版本目录并列，不覆盖旧版本）');
      }
      if (out.id && dirId !== out.id) {
        E('结构', '目录/id', '由目录推出的 packId 是 ' + JSON.stringify(dirId) +
          '，pack.json 的 id 是 ' + JSON.stringify(out.id) + ' —— 二者必须一致');
      }
    }
  } else {
    N('包目录不在经验包根（' + root + '）之下 ⇒ 按"尚未安装的候选目录"校验：id/version 不按目录名对账');
  }

  /* ── ⑤ cards ── */
  const cardsRaw = doc.cards;
  if (cardsRaw === undefined) {
    E('结构', 'cards', '缺 cards 数组');
  } else if (!Array.isArray(cardsRaw)) {
    E('结构', 'cards', 'cards 必须是数组，实际 ' + (Array.isArray(cardsRaw) ? 'array' : typeof cardsRaw));
  } else if (cardsRaw.length === 0) {
    E('结构', 'cards', 'cards 是空数组 —— 没有卡的经验包没有任何作用（拒收，不做"空包"放行）');
  }

  const seenIds = new Map();
  const cardList = Array.isArray(cardsRaw) ? cardsRaw : [];
  cardList.forEach((c, i) => {
    const at = 'cards[' + i + ']';
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      E('结构', at, '必须是对象（{ id, body, steps?, cases? }）');
      return;
    }
    const cid = str(c.id);
    if (!cid) E('结构', at + '.id', '缺 id');
    else if (!SEG_RE.test(cid)) {
      E('结构', at + '.id', '卡 id 形状非法：' + JSON.stringify(c.id) +
        '（单段 [A-Za-z0-9._-] 且首字符不许是 .，不含 / 与 @ —— 选卡串靠这两条才不歧义）');
    } else if (seenIds.has(cid)) {
      E('重复', at + '.id', '卡 id 重复：' + JSON.stringify(cid) + '（首次出现在 cards[' + seenIds.get(cid) +
        ']）—— 同包内 id 必须唯一，否则选卡串指代不明');
    } else {
      seenIds.set(cid, i);
    }

    const steps = c.steps === undefined ? [] : c.steps;
    if (!Array.isArray(steps) || steps.some((s) => typeof s !== 'string' || !s.trim())) {
      E('结构', at + '.steps', 'steps 必须是字符串数组（每项是一项被覆盖的配方步骤名，例 ["整页拆分"]）');
    }
    const casesRaw = c.cases === undefined ? [] : c.cases;
    if (!Array.isArray(casesRaw) || casesRaw.some((s) => typeof s !== 'string')) {
      E('结构', at + '.cases', 'cases 必须是字符串数组（每项是包内相对目录，例 ["cases/shared-stem"]）');
    }

    /* body：包内相对路径 + 存在 + 不逃逸（两道判据：字符串包含性 + realpath）*/
    const bodyRel = str(c.body);
    let bodyAbs = null;
    if (!c.body && c.body !== '') {
      E('结构', at + '.body', '缺 body（包内相对路径，例 cards/shared-stem.md）');
    } else {
      bodyAbs = resolveInner(packDir, realPack, bodyRel, at + '.body', E);
      if (bodyAbs) {
        if (!isFile(bodyAbs)) E('缺文件', at + '.body', 'body 指向的文件不存在：' + bodyRel + '（解析为 ' + bodyAbs + '）');
        else if (!realInside(packDir, realPack, bodyAbs, at + '.body', E)) bodyAbs = null;
      }
    }
    let bodySha256 = null;
    if (bodyAbs && isFile(bodyAbs)) {
      try { bodySha256 = sha256Buf(fs.readFileSync(bodyAbs)); } catch (e) {
        E('缺文件', at + '.body', 'body 读不出来：' + bodyRel + '（' + e.message + '）');
      }
    }

    /* cases：每个案例目录必须有 input.svg + expected.json（缺任一都报；expected.json 必须能解析）*/
    const caseList = [];
    if (Array.isArray(casesRaw)) {
      casesRaw.forEach((caseRelRaw, j) => {
        const what = at + '.cases[' + j + ']';
        const caseRel = str(caseRelRaw);
        const caseAbs = resolveInner(packDir, realPack, caseRel, what, E);
        if (!caseAbs) return;
        if (!isDir(caseAbs)) {
          E('缺文件', what, '案例目录不存在：' + caseRel + '（解析为 ' + caseAbs + '）');
          return;
        }
        if (!realInside(packDir, realPack, caseAbs, what, E)) return;
        caseList.push(caseRel);
        for (const fname of ['input.svg', 'expected.json']) {
          const fAbs = path.join(caseAbs, fname);
          if (!isFile(fAbs)) {
            E('缺文件', what + '/' + fname, '案例缺 ' + fname + '：' + toPosix(path.relative(packDir, fAbs)));
            continue;
          }
          if (!realInside(packDir, realPack, fAbs, what + '/' + fname, E)) continue;
          if (fname === 'expected.json') {
            try { JSON.parse(readText(fAbs)); } catch (e) {
              E('结构', what + '/expected.json', '不是合法 JSON：' + e.message);
            }
          }
        }
      });
    }

    out.cards.push({
      id: cid,
      title: str(c.title) || null,
      body: bodyRel,
      bodySha256,
      steps: Array.isArray(steps) ? steps.filter((s) => typeof s === 'string') : [],
      cases: caseList,
    });
  });

  /* ── ⑥·补 学科/接口**扩展声明**（批次 5，「按实际贡献扩展」的机检落点）──
   * 施工方案 §9.1 批次 5 的验收原文就一句：「**逐条扩展各自附反例**」。口号不是门禁 —— 所以把
   * "每条扩展必须有：适用条件、能发现误伤的反例、维护者"变成这一段的判据。
   *
   * 三条设计口径（都不许放宽）：
   *   ① **不声明就完全不受影响**：`extensions` 缺省 ⇔ 老包一字不改照样通过（向后兼容是硬要求）。
   *   ② **声明了就必须四项齐全且非空**：`学科 / 适用条件 / 维护者` 是字符串，`反例` 是**非空数组**；
   *      占位词（TODO/待补/TBD/…）一律拒 —— "写了但等于没写"比没写更坏（它占着"有反例"的位置）。
   *   ③ **反例必须可跑**：每条反例要指到**包内真实存在的案例** + 该案例 `expected.json` 的
   *      `controls[]` 里**真有一条**能发现误伤的对照（按 id 或场景关键词匹配）。
   *      指向不存在的案例、或案例里没有那条对照 ⇒ 判红。**"能发现误伤"是判据，不是形容词。**
   */
  const extRaw = doc.extensions;
  const extList = [];
  if (extRaw !== undefined) {
    if (!Array.isArray(extRaw)) {
      E('扩展', 'extensions', '要声明扩展就得是数组（每个学科/接口一项），实际 ' +
        (extRaw === null ? 'null' : typeof extRaw));
    } else if (extRaw.length === 0) {
      E('扩展', 'extensions', 'extensions 是空数组 —— 要么整条删掉（不声明扩展），要么写全一项；空壳不算扩展');
    } else {
      const PLACEHOLDER = /^(todo|tbd|fixme|待补|待填|待定|略|无|n\/a|na|-+)$/i;
      const nonEmpty = (v, what, why) => {
        if (typeof v !== 'string' || !v.trim()) { E('扩展', what, why + '（必须是非空字符串）'); return null; }
        const t = v.trim();
        if (PLACEHOLDER.test(t)) { E('扩展', what, why + '是占位词 ' + JSON.stringify(t) + ' —— 写了等于没写'); return null; }
        return t;
      };
      extRaw.forEach((ex, i) => {
        const at = 'extensions[' + i + ']';
        if (!ex || typeof ex !== 'object' || Array.isArray(ex)) {
          E('扩展', at, '必须是对象（{ 学科, 适用条件, 反例: [...], 维护者 }）');
          return;
        }
        const subject = nonEmpty(ex['学科'], at + '.学科', '缺「学科」（或接口名），例如 "化学"');
        const applies = nonEmpty(ex['适用条件'], at + '.适用条件', '缺「适用条件」—— 要说清什么题、什么前提下才该用这条扩展');
        const who = nonEmpty(ex['维护者'], at + '.维护者', '缺「维护者」—— 没人认领的扩展坏掉时无人可问');
        const ctr = ex['反例'];
        if (!Array.isArray(ctr) || ctr.length === 0) {
          E('扩展', at + '.反例', '缺「反例」（非空数组）—— 没有反例的扩展无法证明它只在适用条件下生效；' +
            '「能发现误伤的反例」是本批的验收原文');
        } else {
          const seen = [];
          ctr.forEach((c, j) => {
            const wat = at + '.反例[' + j + ']';
            if (!c || typeof c !== 'object' || Array.isArray(c)) {
              E('扩展', wat, '必须是对象（{ 案例, 对照 }）');
              return;
            }
            const caseRel = str(c['案例']);
            const ctrlRef = str(c['对照']);
            if (!caseRel) { E('扩展', wat + '.案例', '缺「案例」（包内相对目录，例 cases/periodic-symbols）'); return; }
            if (!ctrlRef) {
              E('扩展', wat + '.对照', '缺「对照」（该案例 expected.json 里 controls[] 的 id 或场景关键词）');
              return;
            }
            const caseAbs = resolveInner(packDir, realPack, caseRel, wat + '.案例', E);
            if (!caseAbs) return;
            if (!isDir(caseAbs)) { E('扩展', wat + '.案例', '案例目录不存在：' + caseRel); return; }
            const expFile = path.join(caseAbs, 'expected.json');
            if (!isFile(expFile)) { E('扩展', wat + '.案例', '案例里没有 expected.json，反例无从核对：' + caseRel); return; }
            let exp = null;
            try { exp = JSON.parse(readText(expFile)); } catch (e) { E('扩展', wat + '.案例', 'expected.json 不是合法 JSON：' + e.message); return; }
            const controls = Array.isArray(exp && exp.controls) ? exp.controls : [];
            const hit = controls.some((k) => k && (String(k.id) === ctrlRef ||
              String(k.scene || '').includes(ctrlRef) || String(k.expect || '').includes(ctrlRef)));
            if (!hit) {
              E('扩展', wat + '.对照', '案例 ' + caseRel + ' 的 controls[] 里找不到对照 ' + JSON.stringify(ctrlRef) +
                '（现有：' + (controls.map((k) => k && k.id).filter(Boolean).join('、') || '（无）') + '）' +
                ' —— 「能发现误伤的反例」必须真在案例里，不能只是嘴上说');
              return;
            }
            seen.push(caseRel + '#' + ctrlRef);
          });
          if (subject && applies && who && seen.length) {
            extList.push({ 学科: subject, 适用条件: applies, 反例: seen, 维护者: who });
          }
        }
      });
    }
  }
  out.extensions = extList;

  /* ── ⑥ 限值（给**实际数字**，不写"过大"）── */
  const files = collectDataFiles(packDir);
  if (files.length > MAX_FILES) {
    E('限值', '包内文件数', '包内数据文件 ' + files.length + ' 个 > 上限 ' + MAX_FILES + ' 个（MAX_FILES）');
  }
  let totalBytes = 0;
  for (const f of files) {
    totalBytes += f.size;
    if (f.size > MAX_FILE_BYTES) {
      E('限值', '单文件体积', f.rel + ' 是 ' + f.size + ' 字节 > 上限 ' + MAX_FILE_BYTES + ' 字节（MAX_FILE_BYTES）');
    }
  }
  if (totalBytes > MAX_PACK_BYTES) {
    E('限值', '整包体积', '整包合计 ' + totalBytes + ' 字节 > 上限 ' + MAX_PACK_BYTES + ' 字节（MAX_PACK_BYTES）');
  }

  /* ── ⑦ 同版异内容（契约 §2.1 最后一条）──
   * 真正要防的是"改了内容却沿用同一版本号"：装的人以为拿到的是同一份，实际两份不同；
   * 回退时也说不清退的是哪一份。⇒ 给两侧摘要前 12 位并指名修法（新版本号并列留存）。 */
  if (out.id && out.version && idOk(out.id) && VERSION_RE.test(out.version)) {
    const installed = path.join(root, ...out.id.split('/'), out.version);
    if (isDir(installed) && !samePath(installed, packDir)) {
      try {
        const mine = packDigest(packDir);
        const theirs = packDigest(installed);
        if (mine !== theirs) {
          E('同版异内容', out.id + '@' + out.version,
            '同一 ' + out.id + '@' + out.version + ' 已安装在 ' + installed + '，但内容摘要不同：' +
            '本目录 ' + short(mine) + ' ≠ 已安装 ' + short(theirs) +
            ' —— 版本号是内容的身份：应改用**新版本号**并列留存（旧版本不覆盖，否则回退说不出退到哪一份）');
        }
      } catch (e) {
        E('同版异内容', out.id + '@' + out.version,
          '已安装的那份（' + installed + '）读不出来，无法比对内容摘要：' + e.message);
      }
    }
  }

  /* ── ⑧ notes：不是错，但要说出口 ── */
  if (fs.existsSync(path.join(packDir, DISABLED_MARK))) {
    N('包已停用（存在 ' + DISABLED_MARK + '）：内容仍可校验，但 --card 选它会 exit 2；删掉该文件即恢复');
  }
  for (const k of ['title', 'author', 'license']) {
    if (!str(doc[k])) N('缺可选元数据 ' + k + '（清单里该列会空着；不影响校验结论）');
  }
  if (!isFile(path.join(packDir, 'README.md'))) {
    N('缺 README.md（建议写清用途/安装/停用/许可——别人拿到这个包只能靠它）');
  }
  return finish();
}

/* ══════════════════════ 路径判据（包内相对路径）══════════════════════
 * 四道各自的用途（**互不替代**，全都要过）：
 *   ① 形状：外部 URL / 绝对路径 —— 直接拒（绝对路径会让只读工具碰到包外文件）
 *   ② 字符串包含性：`path.resolve` 后必须仍在包根内（消解 `..`）
 *   ③ realpath 包含性：解析后的真实路径仍须在包根的真实路径内（挡 junction/symlink 逃逸）
 * 返回绝对路径（不管存在性）；形状非法返回 null 并记账。 */
function resolveInner(packDir, realPack, rawRel, what, E) {
  if (typeof rawRel !== 'string' || !rawRel.trim()) {
    E('结构', what, '缺路径（字符串，包内相对路径）');
    return null;
  }
  const s = rawRel.trim();
  /* 判据顺序是刻意的（三类各自给**正确**的归类，而不是"反正被拒了"）：
     ① `//` 开头 = 外部引用（契约 §2.1 把 `//` 与 URL 归为同一类）；
     ② 盘符 / 绝对路径（`Q:/x` 会被 URL 正则误当成 scheme `q:`，所以必须先判它）；
     ③ 其余 scheme（`https:`、`file:`…）。 */
  if (s.startsWith('//')) {
    E('越界', what, '外部 URL 一律拒（经验包必须完全离线）：' + s);
    return null;
  }
  if (/^[A-Za-z]:/.test(s) || path.isAbsolute(s) || /^[\\/]/.test(s)) {
    E('越界', what, '绝对路径一律拒（只接受包内相对路径）：' + s);
    return null;
  }
  if (EXTERNAL_URL_RE.test(s)) {
    E('越界', what, '外部 URL 一律拒（经验包必须完全离线）：' + s);
    return null;
  }
  const abs = path.resolve(packDir, s.replace(/[\\/]+/g, path.sep));
  if (!isInside(packDir, abs)) {
    E('越界', what, '越出包根：' + s + '（解析为 ' + abs + '，包根 ' + packDir + '）');
    return null;
  }
  if (abs === packDir) {
    E('越界', what, '指向包根本身（应指向包内的文件/目录）：' + s);
    return null;
  }
  return abs;
}

/** realpath 包含性：目标（若存在）真实路径必须仍在包根真实路径内。 */
function realInside(packDir, realPack, abs, what, E) {
  let real;
  try { real = fs.realpathSync(abs); } catch (e) {
    E('缺文件', what, '路径存在但真实路径解析失败：' + abs + '（' + e.message + '）');
    return false;
  }
  if (!isInside(realPack, real)) {
    E('越界', what, '重解析点逃逸（junction/symlink 指向包根之外）：' + abs +
      ' → 真实路径 ' + real + '，而包根真实路径是 ' + realPack);
    return false;
  }
  return true;
}

/* ══════════════════════ 清单（契约 §2.1）══════════════════════
 * 报告不是门禁：**坏包只影响自身** —— 每个包一行，坏的那行给原因，整体照常。
 * 为什么要这样：经验包根是用户手放文件的地方，坏一个包不该让"我装了哪些包"看不见。
 * 返回 `[{ id, version, dir, enabled, verdict:{ok,errors[]}, title, author, license, notes }]`。 */
export function listPacks(explicitRoot) {
  const root = packsRoot(explicitRoot);
  const out = [];
  for (const dir of findPackDirs(root)) {
    const rel = path.relative(root, dir).split(path.sep).filter(Boolean);
    const version = rel.length ? rel[rel.length - 1] : '';
    const id = rel.slice(0, -1).join('/');
    const enabled = !fs.existsSync(path.join(dir, DISABLED_MARK));
    let meta = {};
    try { meta = JSON.parse(readText(path.join(dir, PACK_FILE))); } catch { meta = {}; }
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) meta = {};
    let verdict;
    try {
      const v = validatePack(dir, explicitRoot);
      verdict = { ok: v.ok, errors: v.errors };
    } catch (e) {
      /* 校验器自己炸了也不能让整份清单崩：这一行判红并说清楚是哪一行 */
      verdict = { ok: false, errors: [{ code: '异常', what: '校验', why: '校验过程抛错：' + String(e && e.message || e) }] };
    }
    out.push({
      id, version, dir, enabled, verdict,
      title: str(meta.title), author: str(meta.author), license: str(meta.license),
    });
  }
  out.sort((a, b) => {
    const ka = a.id + '@' + a.version, kb = b.id + '@' + b.version;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return out;
}

/** 找出经验包根下所有"版本目录"（`<…>/<version>/`）。
 *
 * 判据 = **目录名形如版本号** 或 **目录里有 pack.json**（命中即停，不再往下走）。
 * 为什么不能只认"有 pack.json 的目录"：那样"缺 pack.json"的坏包会整份**从清单里消失**——
 *   用户明明复制进来了，清单却说"没有安装任何经验包"，这是最难查的静默降级（契约要求
 *   缺 pack.json 属于**结构性错误**，必须是"列出来 + 说它错"，不是"看不见"）。
 * 不跟随重解析点（`readdirSync(withFileTypes)` 的 isDirectory 对 symlink 为 false）——
 *   逃逸由 loadCard/validate 的 realpath 判据负责报红，不在遍历处静默跟随。
 *   ★ 但**发现了就要列出来**：若某个 `<packId>`/`<version>` 是 junction，这里照样把它当候选
 *   （`fs.statSync` 跟随一次），交给 `validatePack` 的 realpath 判据判红 ——
 *   否则"用户明明挂进来了、清单里什么都没有"又是一次静默放过。环由 realpath 去重 + 深度上限挡住。 */
function findPackDirs(root) {
  const out = [];
  const seen = new Set();
  const walk = (dir, depth, isRoot) => {
    if (depth > WALK_MAX_DEPTH) return;
    let real;
    try { real = fs.realpathSync(dir).toLowerCase(); } catch { return; }
    if (seen.has(real)) return;                       // 环 / 重复（junction 指回祖先等）
    seen.add(real);
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const hasPackFile = isFile(path.join(dir, PACK_FILE));
    if (!isRoot && (hasPackFile || VERSION_RE.test(path.basename(dir)))) { out.push(dir); return; }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (!isDir(full)) continue;
      walk(full, depth + 1, false);
    }
  };
  if (isDir(root)) walk(root, 0, true);
  return out.sort();
}

/* ══════════════════════ 选卡（契约 §2.2）══════════════════════
 * 失败原因必须**可归因**：未知包 / 未知卡 / 未知版本 / 包已停用 / 包损坏 / 选卡串格式错。
 * `code` 一律 2（契约冻结）；`reason` 是机器可读的短码（额外字段，便于调用方分别处置）。 */
export function loadCard(sel, explicitRoot) {
  const p = parseCardSel(sel);
  if (!p.ok) return { ok: false, code: 2, reason: 'sel-format', why: p.why };

  const root = packsRoot(explicitRoot);
  if (!isDir(root)) {
    return {
      ok: false, code: 2, reason: 'packs-root-missing',
      why: '经验包根不存在：' + root + '\n  安装=把包文件夹**手工复制**成 <经验包根>/<packId>/<version>/（见 仓库文档 docs\\经验包规范.md）',
    };
  }
  const packDir = path.join(root, ...p.packId.split('/'), p.version);
  if (!isDir(packDir)) {
    const packBase = path.join(root, ...p.packId.split('/'));
    if (isDir(packBase)) {
      let vers = [];
      try { vers = fs.readdirSync(packBase).filter((n) => isDir(path.join(packBase, n)) && VERSION_RE.test(n)); } catch { }
      return {
        ok: false, code: 2, reason: 'version-unknown',
        why: '经验包 ' + p.packId + ' 没有版本 ' + p.version + '（' + packBase + ' 下已安装版本：' +
          (vers.length ? vers.join('、') : '（无）') + '）',
      };
    }
    return {
      ok: false, code: 2, reason: 'pack-unknown',
      why: '没有安装经验包 ' + p.packId + '（' + packBase + ' 不存在）—— 安装=手工复制文件夹，停用=包内放 .停用',
    };
  }

  /* 停用判据放在"形状/存在"之后、"内容校验"之前：用户最先要知道的是"这个包被我停用了"，
     而不是一堆内容错。停用原因（文件内容第一行）一并带出，才可归因。 */
  const mark = path.join(packDir, DISABLED_MARK);
  if (fs.existsSync(mark)) {
    let why = '';
    try { why = readText(mark).split(/\r?\n/).map((s) => s.trim()).find(Boolean) || ''; } catch { }
    return {
      ok: false, code: 2, reason: 'pack-disabled',
      why: '经验包 ' + p.packId + '@' + p.version + ' 已停用（' + packDir + ' 下有 ' + DISABLED_MARK + '）' +
        (why ? '，停用原因：' + why : '') + '\n  恢复=删掉这个文件（停用即回退，不需要别的动作）',
    };
  }

  const v = validatePack(packDir, explicitRoot);
  if (!v.ok) {
    const lines = v.errors.slice(0, 6).map((e) => '  - [' + e.code + '] ' + e.what + '：' + e.why);
    if (v.errors.length > 6) lines.push('  …另有 ' + (v.errors.length - 6) + ' 条（跑 校验 ' + packDir + ' 看全部）');
    return {
      ok: false, code: 2, reason: 'pack-broken',
      why: '经验包 ' + p.packId + '@' + p.version + ' 内容不合法（' + v.errors.length + ' 条）：\n' + lines.join('\n'),
    };
  }

  const card = v.cards.find((c) => c.id === p.cardId);
  if (!card) {
    return {
      ok: false, code: 2, reason: 'card-unknown',
      why: '经验包 ' + p.packId + '@' + p.version + ' 里没有卡 ' + JSON.stringify(p.cardId) +
        '（这个包有：' + (v.cards.map((c) => c.id).join('、') || '（无）') + '）',
    };
  }
  let body;
  try { body = readText(path.join(packDir, card.body)); } catch (e) {
    return {
      ok: false, code: 2, reason: 'pack-broken',
      why: '卡正文读不出来：' + card.body + '（' + e.message + '）—— 校验通过后仍读不出，说明文件在两次读之间被改动过',
    };
  }
  let packTitle = '';
  try { packTitle = str(JSON.parse(readText(path.join(packDir, PACK_FILE))).title); } catch { }
  return {
    ok: true,
    card: {
      packId: p.packId,
      cardId: p.cardId,
      version: p.version,
      body,
      bodySha256: card.bodySha256,
      dir: packDir,
      steps: card.steps,
      cases: card.cases,
      title: card.title || packTitle,
    },
  };
}

/* ══════════════════════ CLI ══════════════════════ */
const argv = process.argv.slice(2);
/* ★ 2026-11-04（M1·实测）：参数解析改走**唯一实现** `_参数.mjs`。
   已知带值 flag **无条件消费下一个参数**（哪怕它长得像 flag）。
   ⚠ `--packs` 显式给就要**给值**（少一个参数是用法错，不许静默回落到默认根）——
     parseArgs 在"给了 flag 但没给值"时回落 `true`，故这里显式判它并报用法错。 */
const { action: _cmd, opt, positional } = parseArgs(argv, {
  valueFlags: [
    ...COMMON_VALUE_FLAGS,
    // 本工具专属的带值 flag（**布尔开关不要列进来**：json/help 是开关）
    'packs',
  ],
});
const JSON_OUT = !!opt.json;
const has = (k) => argv.includes(k);
/** `--packs` 的值：显式给就要**给值**（少一个参数是用法错，不许静默回落到默认根）。 */
let PACKS_ARG = '';
let PACKS_BAD = '';
if (opt.packs !== undefined) {
  if (opt.packs === true || !String(opt.packs).trim()) PACKS_BAD = '--packs 需要一个目录参数：--packs <dir>';
  else PACKS_ARG = String(opt.packs);
}
/* 位置参数：动作名 + 目标目录（`校验 <dir>` / `摘要 <dir>`）。 */
const posArgs = [_cmd, ...positional].filter(x => x !== undefined && x !== '');
const cmd = posArgs[0] || '';

function usage() {
  console.log([
    '拾光小册 · 经验包（只读）',
    '  经验包根 = ' + packsRoot(PACKS_ARG) + (PACKS_ARG ? '（来自 --packs）' : process.env.CTB_PACKS ? '（来自 CTB_PACKS）' : '（默认 %LOCALAPPDATA%）'),
    '',
    '用法：',
    '  node src\\tools\\_经验包.mjs 清单   [--json] [--packs <dir>]',
    '  node src\\tools\\_经验包.mjs 校验 <dir> [--json] [--packs <dir>]',
    '  node src\\tools\\_经验包.mjs 摘要 <dir> [--json] [--packs <dir>]',
    '',
    '退出码：0 = 通过；1 = 包内容不合法；2 = 参数或环境错。',
    '  ⚠ 本工具只读：安装=手工复制文件夹；停用=包内放 .停用 文件；恢复=删掉它。',
  ].join('\n'));
}

function printErrors(errs) {
  for (const e of errs) console.log('   - [' + e.code + '] ' + e.what + '：' + e.why);
}

function cmdList() {
  const root = packsRoot(PACKS_ARG);
  const packs = listPacks(PACKS_ARG);
  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({ ok: true, root, packs }, null, 2) + '\n');
    return 0;
  }
  if (!isDir(root)) {
    console.log('没有安装任何经验包（经验包根不存在：' + root + '）');
    console.log('  怎么装：把包文件夹手工复制成 <经验包根>/<packId>/<version>/（里面有 pack.json）');
    return 0;
  }
  if (!packs.length) {
    console.log('没有安装任何经验包（经验包根：' + root + '）');
    console.log('  怎么装：把包文件夹手工复制成 <经验包根>/<packId>/<version>/（里面有 pack.json）');
    return 0;
  }
  console.log('经验包根：' + root);
  console.log('共 ' + packs.length + ' 个：\n');
  for (const p of packs) {
    const health = p.verdict.ok ? '校验通过' : '校验不通过（' + p.verdict.errors.length + ' 条）';
    console.log('  ' + p.id + '@' + p.version + '　[' + (p.enabled ? '已启用' : '已停用') + ']　' + (p.title || '（无标题）'));
    console.log('     来源：' + toPosix(path.relative(root, p.dir)) + '　卡数：' + cardCountOf(p) +
      '　作者：' + (p.author || '（未填）') + '　许可：' + (p.license || '（未填）'));
    console.log('     ' + health);
    if (!p.verdict.ok) printErrors(p.verdict.errors);
    console.log('');
  }
  return 0;
}

/** 清单里的"卡数"：从校验结果里读（校验失败也尽量给出已经读到的卡）——
 *  单独再读一次 pack.json 等于给卡数造第二份口径。 */
function cardCountOf(p) {
  try {
    const v = validatePack(p.dir, PACKS_ARG);
    return v.cards.length;
  } catch { return 0; }
}

function cmdValidate(dir) {
  if (!dir) { console.error('用法：校验 <包目录> [--json] [--packs <dir>]'); return 2; }
  const abs = path.resolve(dir);
  if (!isDir(abs)) {
    console.error('包目录不存在或不是目录：' + abs);
    console.error('  （这是**用法/环境错**（exit 2），不是"包内容不合法"；后者是 exit 1）');
    return 2;
  }
  const v = validatePack(abs, PACKS_ARG);
  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({
      ok: v.ok, dir: v.dir, id: v.id, version: v.version, formatVersion: v.formatVersion,
      cards: v.cards.map((c) => ({ id: c.id, body: c.body, bodySha256: c.bodySha256, steps: c.steps, cases: c.cases })),
      /* ★ 2026-11-03（批次 5）：扩展声明要出现在**机读输出**里 —— 否则机检只能"看有没有报错"，
         没法回答"这条扩展声明的四项分别是什么"（人读行里印了一份、JSON 里没有，两边必然漂移）。 */
      extensions: v.extensions,
      errors: v.errors, notes: v.notes,
    }, null, 2) + '\n');
    return v.ok ? 0 : 1;
  }
  console.log('校验包目录：' + v.dir);
  console.log('  id=' + (v.id || '（缺失）') + '  version=' + (v.version || '（缺失）') +
    '  formatVersion=' + (v.formatVersion === null ? '（缺失）' : v.formatVersion) +
    '  卡数=' + v.cards.length);
  for (const n of v.notes) console.log('  注：' + n);
  if (v.ok) { console.log('结论：通过（0 条错误）'); return 0; }
  console.log('结论：不通过（' + v.errors.length + ' 条错误）');
  printErrors(v.errors);
  return 1;
}

function cmdSummary(dir) {
  if (!dir) { console.error('用法：摘要 <包目录> [--json] [--packs <dir>]'); return 2; }
  const abs = path.resolve(dir);
  if (!isDir(abs)) {
    console.error('包目录不存在或不是目录：' + abs);
    return 2;
  }
  const v = validatePack(abs, PACKS_ARG);
  /* 契约 §2.1 的 `摘要` 行只写了 0/2；这里加 1 是刻意的（已回报 Lead）：
     对坏包打印一份"看起来正常"的摘要＝把坏包当好的，正是本仓最忌的静默放过。 */
  if (!v.ok) {
    console.error('摘要拒绝输出：包不合法（' + v.errors.length + ' 条错误）—— 先跑 `校验 ' + abs + '` 看全部原因');
    for (const e of v.errors.slice(0, 6)) console.error('   - [' + e.code + '] ' + e.what + '：' + e.why);
    return 1;
  }
  let digest = '';
  try { digest = packDigest(abs); } catch (e) {
    console.error('摘要算不出来：读包内文件失败（' + e.message + '）');
    return 1;
  }
  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({
      ok: true, dir: v.dir, id: v.id, version: v.version, formatVersion: v.formatVersion,
      digest, digestShort: short(digest),
      cards: v.cards.map((c) => ({
        id: c.id, body: c.body, bodySha256: c.bodySha256,
        bodySha256Short: short(c.bodySha256), steps: c.steps, cases: c.cases,
      })),
      errors: [], notes: v.notes,
    }, null, 2) + '\n');
    return 0;
  }
  console.log('经验包：' + v.id + '@' + v.version + '（formatVersion=' + v.formatVersion + '）');
  console.log('  目录：' + v.dir);
  console.log('  整包摘要：' + short(digest) + '（内容摘要前 12 位）');
  for (const n of v.notes) console.log('  注：' + n);
  console.log('  卡 ' + v.cards.length + ' 张：');
  for (const c of v.cards) {
    console.log('    ' + c.id + '　正文 ' + c.body + '　sha256 ' + short(c.bodySha256));
    console.log('      覆盖步骤：' + (c.steps.length ? c.steps.join('、') : '（未声明）') +
      '　案例：' + (c.cases.length ? c.cases.join('、') : '（无）'));
  }
  return 0;
}

function main() {
  if (has('--help') || has('-h') || !argv.length) {
    usage();
    return argv.length ? 0 : 2;
  }
  if (PACKS_BAD) { console.error(PACKS_BAD); return 2; }
  switch (cmd) {
    case '清单': return cmdList();
    case '校验': return cmdValidate(posArgs[1] || '');
    case '摘要': return cmdSummary(posArgs[1] || '');
    default:
      console.error('未知子命令：' + JSON.stringify(cmd) + '　可用：清单 / 校验 <dir> / 摘要 <dir>');
      return 2;
  }
}

/* 仅在被直接执行时跑 CLI；import 时不产生副作用（`_配方.mjs` 会 import 本模块）。 */
const SELF = fileURLToPath(import.meta.url);
if (process.argv[1] && (() => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(SELF); } catch { return false; } })()) {
  process.exit(main());
}