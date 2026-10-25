#!/usr/bin/env node
/**
 * 错题本 · 原卷台账（卡片 → 原卷整页 的唯一真源）
 *
 * 为什么存在（2026-10-09）：索引里每张卡只有 `img`（从整页上裁下来的题图），
 * 从来没有记过「这一刀是从哪一页、哪个位置裁的」。于是灯箱上写着
 * 「🗂 用系统程序打开原图」的按钮只能打开裁图——用户点开看到的永远是题目特写，
 * 看不到他当初导进电脑的整页卷面。本工具把这条溯源链补回来并**机械化**：
 *
 *   _收件箱\<批次>\整页原图  →  年级/原卷 或 批次目录的整页  →  卡片/原卷截图.jpg
 *        (import)                    (page)                        (img)
 *
 * 台账条目（键 = `学生|卡号`，**卡号跨学生会撞号**，见教训 L-334/L-339）：
 *   page   相对库根的整页原卷路径（'/' 分隔）——🗂 按钮打开它
 *   box    [x,y,w,h] 归一化 0~1（相对 page 自身像素），null = 未定位（只开整页、不画红框）
 *   import 相对库根的导入原件路径（sha256 与 page 相同才算，不猜名字）
 *   by     规则标识（审计留痕）：sidecar / task.json / 批次表 / 建卡清单 / 单页批次 / 视觉定位 / 手工
 *   note   人话说明（含证据）
 *
 * 用法：
 *   node _原卷台账.mjs 生成 [--dry] [--force]   # 跑规则回填（手工/视觉条目默认保留，--force 才覆盖）
 *   node _原卷台账.mjs 采集                     # 折入卡目录里的 _裁图记录.json（新卡天生带溯源）
 *   node _原卷台账.mjs 覆盖 [--verbose]         # 覆盖率报告（按学生/学科/规则）
 *   node _原卷台账.mjs 定位单 [--per N]         # 给未定位的卡生成「带网格候选页 + 任务单」
 *   node _原卷台账.mjs 回填 --key "学生A|P0001" --page "…" [--box x,y,w,h] [--note "…"] [--by 视觉定位]
 *   node _原卷台账.mjs 门禁                     # 未定位>0 / 路径失效 / box 越界 → exit 1
 *
 * 铁律：--dry 必须真的不写盘（用文件哈希自证，教训 L-312）；写盘前把旧台账复制到 _备份-原卷台账-*。
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { readJsonStrict, writeJsonAtomic } from './_安全写.mjs';
import { libraryRoot, toolPath } from './_库根.mjs';
/* ⚠ 2026-10-15 修（F-P0 治本）：库根包含性判据。**刻意复用** _路径护栏.mjs 的纯判据，
   而不是在本文件手写 `rel.startsWith('..')` —— 护栏是"不查 exists、只做归一化前缀比较"的写法，
   天然不做 IO，因此不会像旧判据那样被"相对路径拼回原绝对路径"的把戏绕过去（详见 ruleTaskJson 注释）。 */
import { isInsideRoot } from './_路径护栏.mjs';

/* ★ 2026-10-23 程序与数据分家：ROOT = **用户库根**（不是本脚本所在目录）。 */
const ROOT = libraryRoot();
const LEDGER = path.join(ROOT, '_原卷台账.json');
const SHA_CACHE = path.join(ROOT, '_probe', '_sha256缓存.json');
const BY = 'agent-原卷台账-20261009';

/* ---------- 小工具 ---------- */
const norm = p => String(p).replace(/\\/g, '/').replace(/^\.?\//, '');
const relOf = abs => norm(path.relative(ROOT, abs));
const toAbs = rel => path.join(ROOT, norm(rel));
const exists = rel => { try { return fs.statSync(toAbs(rel)).isFile(); } catch { return false; } };
const readJson = f => readJsonStrict(f, { label: path.basename(f) });
const sha256 = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').toUpperCase();
function shaCached(f, cache) {
  const key = norm(f);
  if (!cache[key]) cache[key] = sha256(toAbs(key));
  return cache[key];
}
function boxOk(b) {
  return Array.isArray(b) && b.length === 4 && b.every(n => Number.isFinite(n)) &&
    b[0] >= -0.001 && b[1] >= -0.001 && b[2] > 0 && b[3] > 0 && b[0] + b[2] <= 1.02 && b[1] + b[3] <= 1.02;
}

/* ---------- 卡清单：直接扫 _索引.json（与生成器同源，不依赖 _状态.json 新鲜度） ---------- */
function loadCards() {
  const out = [];
  const idxFiles = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('_') || /^(docs|tests|v2|z z znew|zzznew)$/.test(e.name)) continue;
      const full = path.join(d, e.name);
      if (fs.existsSync(path.join(full, '_索引.json'))) idxFiles.push(path.join(full, '_索引.json'));
      walk(full);
    }
  })(ROOT);
  for (const f of idxFiles) {
    const j = readJson(f);
    const baseRel = relOf(path.dirname(f));
    const student = j.student || path.basename(path.dirname(f));
    const subs = [];
    if (j.items) subs.push({ subject: j.subject || path.basename(baseRel), dir: baseRel, items: j.items });
    else if (j.subjects) for (const k of Object.keys(j.subjects))
      subs.push({ subject: k, dir: baseRel + '/' + k, items: (j.subjects[k].items || []) });
    for (const s of subs) for (const it of s.items) {
      out.push({
        key: student + '|' + it.id, student, subject: s.subject, id: it.id,
        cardDir: norm(s.dir + '/' + it.dir), source: it.source || '', dirName: it.dir,
      });
    }
  }
  out.sort((a, b) => a.key.localeCompare(b.key, 'zh'));
  return out;
}

/* ---------- 批次表：source 文本 → 整页候选（每条都写清证据从哪来） ---------- */
/* 通用题号→页判据：文件名里能解析出「第A-B题 / 默写(A)(B) / 选择-第N题」这类区间，
   卡片 source 的 `· 题号` 段能解析出 (label, qno)，两边对上就定页；对不上交视觉定位。 */
function parseQRange(name) {
  let m = name.match(/(选择|填空|解答)[^第]{0,6}第(\d+)(?:续)?(?:-(\d+))?题/);
  if (m) return { label: m[1], lo: +m[2], hi: +(m[3] || m[2]) };
  m = name.match(/第(\d+)(?:-(\d+))?题/);
  if (m) return { label: null, lo: +m[1], hi: +(m[2] || m[1]) };
  m = name.match(/默写\((\d+)\)\((\d+)\)/);
  if (m) return { label: '默写', lo: +m[1], hi: +m[2] };
  m = name.match(/默写\((\d+)\)-\((\d+)\)/);
  if (m) return { label: '默写', lo: +m[1], hi: +m[2] };
  return null;
}
function cardQ(source) {
  const tail = (String(source).split('·').slice(1).join('·') || String(source)).trim();
  const label = (tail.match(/(选择|填空|解答|默写)/) || [])[1] || null;
  let m = tail.match(/默写\s*[（(](\d+)/);
  if (!m) m = tail.match(/第\s*(\d+)\s*题/);
  if (!m) m = tail.match(/(\d+)/);
  return m ? { label, qno: +m[1] } : null;
}
/* 卷次 token：只看「·」之前的卷名（后面的 (2) 是子题号，不是卷次） */
function parseVol(name) { const m = name.match(/[（(](\d)[)）]/); return m ? +m[1] : null; }
function cardVol(source) { const head = String(source).split('·')[0]; const m = head.match(/[（(](\d)[)）]/); return m ? +m[1] : null; }

/* pages 用 glob 式枚举：dir + 正则；single=true 表示该批次只有 1 页，页号无歧义 */
/* ★ 2026-10-24 B-09 整改：这张表原先登记的是本机真实库的历史批次（含真实学生名与真实
   收件箱文件名），公开仓库不得出现真实个人信息，已全部移除。现换成 4 条**合成样例**，
   每条演示一种定页机制（ruleBatch 的机制代码原样保留）：pages 直列 / 题号区间 / (第N页)
   对账 / pickBySource 按卡号拼名。要给真实库登记批次，照这里的字段结构加条目即可。 */
const BATCHES = [
  {
    id: '学生A/合成单页卷', match: c => c.student === '学生A' && /合成样例·单元测/.test(c.source),
    pages: [{ rel: '合成样例-原卷/单元测-整页.jpg', tag: '整页' }],
    note: '单页批次：一张整页直接定页',
  },
  {
    id: '学生A/合成物理卷', match: c => c.student === '学生A' && /物理《合成样例卷》/.test(c.source),
    dir: '合成样例-物理卷', pattern: /^原卷-(选择|填空|解答)-第(\d+)(?:-(\d+))?题(第(\d+)页)?\.jpg$/,
    note: '文件名按题型+题号区间命名（原卷-选择-第5-7题(第2页).jpg…），供 card.json「第N页」对账',
  },
  {
    id: '学生A/合成双页卷', match: c => c.student === '学生A' && /数学《合成双页样例》/.test(c.source),
    dir: '合成样例-双页卷', pattern: /^原卷-p(\d+)p(\d+)-已转正\.jpg$/, spreadPages: { lo: 1, hi: 2 },
    note: '一张照片=两页并排（p1p2/p3p4）',
  },
  {
    id: '学生B/合成练习卡', match: c => c.student === '学生B' && /合成练习卡(\d)/.test(c.source),
    pickBySource: m => `_收件箱/合成练习卡${m[1]}-Q${Q_RANGES[m[1]]}.jpg`,
    note: '卡1/卡2/卡3 各一张整页，题号写在文件名里',
  },
];
const Q_RANGES = { 1: '1Q2', 2: '3Q4', 3: '5Q6' };   /* pickBySource 模板会补前缀 Q */

/* ---------- 规则实现 ---------- */
function listDir(rel) { try { return fs.readdirSync(toAbs(rel)); } catch { return []; } }

/** R1 卡目录 sidecar（新卡天生带溯源）：_裁图记录.json 由 _工具\裁图.ps1 自动写 */
function ruleSidecar(c) {
  const f = path.join(toAbs(c.cardDir), '_裁图记录.json');
  if (!fs.existsSync(f)) return null;
  let r; try { r = readJson(f); } catch { return null; }
  /* 一张卡可能裁过多张图（原卷截图/题图/题干），只有「原卷截图」那条才是本题证据图的出处 */
  const recs = [...(Array.isArray(r.crops) ? r.crops : []), r].filter(x => x && x.src);
  const rec = recs.find(x => /原卷截图/.test(String(x.out || ''))) || (recs.length === 1 ? recs[0] : null);
  if (!rec) return null;
  const srcAbs = path.isAbsolute(rec.src) ? rec.src : path.join(ROOT, rec.src);
  const rel = relOf(srcAbs);
  if (rel.startsWith('_work') || rel.startsWith('..') || !exists(rel)) return null;
  const box = boxOk(rec.normBox) ? rec.normBox : null;
  return {
    page: rel, box, by: 'sidecar',
    note: `_裁图记录.json：cropPx=${JSON.stringify(rec.cropPx)} srcPx=${rec.srcPx || '?'} scale=${rec.scale}${box ? '' : '（无归一化框' + (rec.rotate ? '，旋转过' : '') + '）'}`,
  };
}

/** R2 卡目录 _task.json 的绝对 img（物理批次 66 张，逐张验盘） */
function ruleTaskJson(c) {
  const f = path.join(toAbs(c.cardDir), '_task.json');
  if (!fs.existsSync(f)) return null;
  let t; try { t = readJson(f); } catch { return null; }
  if (!t.img) return null;
  const rel = relOf(t.img);
  /* ⚠ 2026-10-15 修（F-P0 治本 · 静默穿透）：
     原先此处是 `if (rel.startsWith('_work') || !exists(rel)) return null;`
     —— 与 :210（ruleSidecar）**同一位置判据不一致**：少了库根包含性判据。后果是"静默穿透"：

       relOf(abs) = norm(path.relative(ROOT, abs))            // 库外老库文件 → '../../<老库>/...'
       exists(rel) = statSync(path.join(ROOT, norm(rel)))      // 又把它拼回**原绝对路径** → true

     即 `exists()` 在这里**完全没有校验能力**：它是"这个路径在盘上存在吗"，
     不是"这个路径在库内吗"。对老库这种"确实存在、但不在库根之下"的路径，它恒真。
     实测存量：九年级\物理\ 下 63 个 _task.json 的 img 与 dir 双字段均指向老库，
     63/63 被本规则当成合法 page 静默写进台账（加重情节：两边 p01.jpg SHA256 完全相同，
     所以任何"文件内容不同"的检查也发现不了走错库）。

     修法：在 exists() 之前先做**库根包含性**判断，且复用护栏的纯判据
     `isInsideRoot(abs)`（_工具\_路径护栏.mjs）：它 path.normalize 后比较"带尾分隔符的库根前缀"，
     不做任何 IO，对 `..\..\` 穿越 / 老库 / 同前缀兄弟目录（错题本-备份）一并拒绝。
     这里必须把**绝对路径**交给它（护栏只接受绝对路径；内部不再 resolve，
     因为 Windows 上 resolve(ROOT,'/x') 会变成 D:\x 把正常路径误判为越界）。
     `rel.startsWith('_work')` 保留原样：那是"工作区不进台账"的业务约束，与包含性是两件事。
     与 :210 的关系：:210 的 `startsWith('..')` 是等价判据的**弱化版**（能挡穿越、挡不住
     "库里指到库外又在盘"的绝对路径写入）；:224 这条更强，且是包含性唯一权威。 */
  if (rel.startsWith('_work') || !isInsideRoot(path.resolve(ROOT, rel)) || !exists(rel)) return null;
  return { page: rel, box: null, by: 'task.json', note: `_task.json.img 且在盘（page=${t.page || ''}）` };
}

/** R3 card.json 的「第N页」→ 批次表里带 (第N页) 文件名的整页（合成样例：学生A/合成物理卷） */
function ruleCardPage(c) {
  const f = path.join(toAbs(c.cardDir), 'card.json');
  if (!fs.existsSync(f)) return null;
  let cd; try { cd = readJson(f); } catch { return null; }
  if (!cd.page) return null;
  const m = String(cd.page).match(/第\s*(\d+)\s*页/);
  if (!m) return null;
  const b = BATCHES.find(x => x.id === '学生A/合成物理卷');
  const hit = pageFiles(b).find(x => { const d = path.posix.basename(x.rel).match(/[（(]第(\d+)页[)）]/); return d && +d[1] === +m[1]; });
  if (!hit) return null;
  return { page: hit.rel, box: null, by: 'card.json第N页', note: `card.json page=${cd.page} → ${hit.rel}` };
}

/** R4 建卡清单：pageFile + 归一化 bbox（优先指向永久副本）
 *  ★ 2026-10-24 B-09 整改：原实现绑定某次真实建卡的工作目录（含真实学生名/真实收件箱名）。
 *    机制保留、数据脱敏：按**通用约定**找清单——库根下以「_work-建卡清单」开头的目录里的
 *    `cards-g*.json`（元素含 {id, pageFile, bbox?, inbox?}）。真实库要复用某个具体清单，
 *    把目录改成这个命名即可，规则代码不再认识任何具体学生。 */
let _buildList = null;
function ruleBuildList(c, shaCache) {
  if (!_buildList) {
    _buildList = new Map();
    for (const d of listDir('.').filter(x => /^_work-建卡清单/.test(x))) {
      for (const f of listDir(d).filter(x => /^cards-g.*\.json$/.test(x))) {
        let t; try { t = readJson(toAbs(d + '/' + f)); } catch { continue; }
        for (const card of (t.cards || [])) if (card.id) _buildList.set(card.id, { card, dir: d });
      }
    }
  }
  const hit = _buildList.get(c.id);
  if (!hit) return null;
  const k = hit.card;
  if (!k.pageFile) return null;
  const work = hit.dir + '/pages/' + k.pageFile;
  const perm = k.inbox || null;
  let page = null;
  if (perm && exists(perm) && exists(work) && shaCached(work, shaCache) === shaCached(perm, shaCache)) page = perm;
  else if (exists(work)) page = work;
  else if (perm && exists(perm)) page = perm;
  if (!page) return null;
  const b = k.bbox;
  const box = b && boxOk([b.x, b.y, b.w, b.h]) ? [b.x, b.y, b.w, b.h] : null;
  return { page, box, by: '建卡清单', note: `${hit.dir}/cards-g* pageFile=${k.pageFile}${box ? ' +归一化bbox' : '（无bbox）'}` };
}

/** 批次表列页 */
function pageFiles(b) {
  if (b.pages) return b.pages.filter(p => exists(p.rel)).map(p => ({ rel: p.rel, tag: p.tag || path.posix.basename(p.rel) }));
  if (!b.dir || !b.pattern) return [];
  return listDir(b.dir).filter(f => b.pattern.test(f)).map(f => {
    const m = f.match(b.pattern);
    return { rel: b.dir + '/' + f, tag: f, m };
  });
}

/** 找 _带网格.ps1：库根任一 _work-*\ 或 _工具\ 下的第一个副本（B-09：不再写死真实工作目录） */
function findGridPs1() {
  const cands = [];
  for (const d of listDir('.').sort()) if (/^_work-/.test(d)) cands.push(path.join(ROOT, d, '_带网格.ps1'));
  cands.push(path.join(ROOT, '_工具', '_带网格.ps1'));
  return cands.find(p => fs.existsSync(p)) || null;
}

/** R5 批次表：单页批次直接定页；文件名含题号区间/卷次的按题号定页 */
function ruleBatch(c) {
  const b = BATCHES.find(x => x.match(c));
  if (!b) return null;
  if (b.pickBySource) {
    const m = String(c.source).match(/卡(\d)/);
    if (m) {
      const rel = b.pickBySource(m);
      if (exists(rel)) return { page: rel, box: null, by: '批次表按卡号', note: `批次 ${b.id}：${rel}` };
    }
  }
  const cands = pageFiles(b);
  if (!cands.length) return null;
  if (cands.length === 1) return { page: cands[0].rel, box: null, by: '单页批次', note: `批次 ${b.id} 只有一张整页` };
  /* 题号区间匹配 */
  const cq = cardQ(c.source);
  if (cq) {
    const hits = cands.map(x => ({ x, r: parseQRange(path.posix.basename(x.rel)) }))
      .filter(o => o.r && cq.qno >= o.r.lo && cq.qno <= o.r.hi)
      .filter(o => !cq.label || !o.r.label || o.r.label === cq.label);
    if (hits.length === 1) return { page: hits[0].x.rel, box: null, by: '批次表题号区间', note: `批次 ${b.id}：题号 ${cq.label || ''}${cq.qno} 命中文件名区间 第${hits[0].r.lo}-${hits[0].r.hi}题` };
    if (hits.length > 1) return { page: null, box: null, by: '待定位', need: true, note: `批次 ${b.id}：题号 ${cq.qno} 命中 ${hits.length} 张候选页（${hits.map(h => path.posix.basename(h.x.rel)).join(' | ')}），需视觉定位` };
  }
  /* 卷次 token 匹配（仅显式声明的批次，防与子题号混淆） */
  if (b.volMatch) {
    const cv = cardVol(c.source);
    if (cv != null) {
      const hits = cands.filter(x => parseVol(path.posix.basename(x.rel)) === cv);
      if (hits.length === 1) return { page: hits[0].rel, box: null, by: '批次表卷次', note: `批次 ${b.id}：卷次(${cv}) 与文件名对上` };
    }
  }
  /* 文件名题号区间（p1(1-17) 这类） */
  if (b.qnoFromName && cq) {
    for (const x of cands) {
      const m = path.posix.basename(x.rel).match(b.pattern);
      if (!m) continue;
      const lo = +m[b.qnoFromName.lo], hi = +m[b.qnoFromName.hi];
      if (cq.qno >= lo && cq.qno <= hi) return { page: x.rel, box: null, by: '批次表题号区间', note: `批次 ${b.id}：题号 ${cq.qno} 落在文件名区间 ${lo}-${hi}` };
    }
  }
  return { page: null, box: null, by: '待定位', need: true, note: `批次 ${b.id} 有 ${cands.length} 张整页，题号→页需视觉定位：${cands.map(x => path.posix.basename(x.rel)).join(' | ')}` };
}

/** R6 card.json「第N页」与批次表「题号区间」两条独立证据对账：一致才采信，冲突交视觉定位 */
function reconcilePage(c) {
  const a = ruleCardPage(c), b = ruleBatch(c);
  if (a && b && b.page && a.page !== b.page)
    return { page: null, box: null, by: '证据冲突', need: true, note: `card.json第N页→${a.page}，题号区间→${b.page}，两条证据不一致，需回原卷定页` };
  return a || b;
}

/* ---------- 像素尺寸（System.Drawing 取，缓存到 _probe/_图尺寸.json）：红框换算与长宽比体检都要用 ---------- */
const PX_CACHE = path.join(ROOT, '_probe', '_图尺寸.json');
function sizesOf(rels) {
  const cache = fs.existsSync(PX_CACHE) ? readJson(PX_CACHE) : {};
  const uniq = [...new Set(rels.filter(Boolean).map(norm))].filter(r => !cache[r] && exists(r));
  /* ⚠ 2026-10-12 修（审计 BUG-08·中）：原先无论 uniq 是否为空都 `writeJsonAtomic(PX_CACHE, cache)`
     ⇒ 号称"只读报告"的 `覆盖` 动作其实**无条件改写缓存文件**（内容常不变、但 mtime 变，
     属"只读"承诺的破口）。上一次的修复只给 `门禁` 加了 `--px-cache` 开关，`覆盖` 走的
     `report()→aspectAudit()→sizesOf()` 没跟上。现在：没量到新东西就不写。 */
  if (!uniq.length) return cache;
  for (let i = 0; i < uniq.length; i += 30) {
    const chunk = uniq.slice(i, i + 30);
    let out = '';
    try {
      out = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        path.join(ROOT, '_工具', '图尺寸.ps1'), '-Paths', chunk.map(r => toAbs(r)).join(';')], { encoding: 'utf8' });
    } catch (e) { console.log('图尺寸.ps1 失败：' + e.message); break; }
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^(.*?)\|(\d+)x(\d+)$/);
      if (m) cache[norm(relOf(m[1].trim()))] = [+m[2], +m[3]];
    }
  }
  fs.mkdirSync(path.dirname(PX_CACHE), { recursive: true });
  writeJsonAtomic(PX_CACHE, cache);
  return cache;
}
/** 长宽比体检：卡片裁图与「整页×归一化红框」的宽高比应当同量级，差太多说明页或框错了 */
function aspectAudit(cards) {
  const rels = [];
  for (const e of Object.values(cards)) { if (e.page) rels.push(e.page); if (e.cardDir) rels.push(e.cardDir + '/原卷截图.jpg'); }
  const px = sizesOf(rels);
  const bad = [];
  for (const e of Object.values(cards)) {
    const pg = e.page && px[norm(e.page)], cp = e.cardDir && px[norm(e.cardDir + '/原卷截图.jpg')];
    if (!e.box || !pg || !cp) continue;
    const boxAR = (e.box[2] * pg[0]) / (e.box[3] * pg[1]);
    const cropAR = cp[0] / cp[1];
    const r = cropAR / boxAR;
    if (r < 0.45 || r > 2.2) bad.push({ key: e.key, r: +r.toFixed(2), boxAR: +boxAR.toFixed(2), cropAR: +cropAR.toFixed(2), page: e.page });
  }
  return { px, bad };
}

/* ---------- 导入原件：sha256 相同才算，绝不靠猜名字 ---------- */
function resolveImport(pageRel, shaCache) {
  if (!pageRel) return null;
  const h = shaCached(pageRel, shaCache);
  for (const f of inboxImages()) if (shaCached(f, shaCache) === h) return f;
  return null;
}

/* ---------- 生成 ---------- */
function build({ dry, force }) {
  /* ⚠ 2026-10-12 修（审计 BUG-07·中）：原先是 `readJson(LEDGER).cards || {}`，**没有形状守卫**。
     若 cards 变成数组（PowerShell 的 ConvertFrom/To-Json 往返就会造成这种形状），
     `old[c.key]` 恒为 undefined ⇒ 下面三处"保留人工成果"的兜底
     （:385 手工/视觉定位、:388 旧红框、:393 旧 import）**全部失效**，
     40 条人工视觉定位成果会被当成没有、**覆盖写回**。
     `_配图门禁.mjs:133`、`_待确认.mjs:147` 都已加守卫，只有本文件漏了。 */
  const old = (fs.existsSync(LEDGER) && !force)
    ? (readJsonStrict(LEDGER, { shape: j => !!j.cards && typeof j.cards === 'object' && !Array.isArray(j.cards), what: 'cards 对象', label: '_原卷台账.json' }).cards || {})
    : {};
  const shaCache = fs.existsSync(SHA_CACHE) ? readJson(SHA_CACHE) : {};
  const cards = loadCards();
  const out = {};
  let n = 0;
  for (const c of cards) {
    n++;
    const prev = old[c.key];
    if (prev && /手工|视觉定位/.test(prev.by || '') && !force) { out[c.key] = prev; continue; }
    let r = ruleSidecar(c) || ruleTaskJson(c) || ruleBuildList(c, shaCache) || reconcilePage(c);
    if (!r) r = { page: null, box: null, by: '待定位', need: true, note: '无任何清单线索，需按批次人工登记' };
    if (r.page && !r.box) r.box = (prev && boxOk(prev.box)) ? prev.box : null;
    if (r.page && !exists(r.page)) { r = { page: null, box: null, by: '待定位', need: true, note: '规则给出的页文件不在盘：' + r.page }; }
    out[c.key] = {
      key: c.key, student: c.student, subject: c.subject, cardDir: c.cardDir, source: c.source,
      page: r.page || null, box: r.box || null, by: r.by, need: !!r.need, note: r.note || '',
      import: r.page ? (resolveImport(r.page, shaCache) || (prev && prev.import) || null) : null,
    };
  }
  writeJsonAtomic(SHA_CACHE, shaCache);
  /* 补像素尺寸（红框换算 + 长宽比体检用） */
  const rels = [];
  for (const e of Object.values(out)) { if (e.page) rels.push(e.page); rels.push(e.cardDir + '/原卷截图.jpg'); }
  const px = sizesOf(rels);
  for (const e of Object.values(out)) {
    e.pagePx = e.page ? (px[norm(e.page)] || null) : null;
    e.cropPx = px[norm(e.cardDir + '/原卷截图.jpg')] || null;
  }
  const doc = {
    version: 1, generatedAt: new Date().toISOString(), note:
      '错题卡→原卷整页 溯源台账（唯一真源）。page=🗂 打开的整页；box=归一化红框；import=sha256 一致的导入原件。生成器 _生成首页.ps1 读本文件输出 origPage/origBox/origImport。',
    cards: out,
  };
  const before = fs.existsSync(LEDGER) ? sha256(LEDGER) : '(无)';
  if (dry) {
    const tmp = path.join(ROOT, '_probe', '_原卷台账.dry.json');
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 1), 'utf8');
    console.log(`[dry] 未写 ${LEDGER}（旧文件哈希 ${before}）；预览 → ${tmp}`);
  } else {
    /* 原子写 + 统一备份到 _备份-真源\（旧的 _备份-原卷台账-* 只到分钟，同一分钟两次生成会互相覆盖；见 BUG-01） */
    writeJsonAtomic(LEDGER, doc, { backup: true, indent: 1 });
    console.log(`写 ${LEDGER}（${cards.length} 条）；旧哈希 ${before} → 新哈希 ${sha256(LEDGER)}`);
  }
  report(doc.cards);
}
function report(cards) {
  const keys = Object.keys(cards);
  const withPage = keys.filter(k => cards[k].page);
  const withBox = withPage.filter(k => boxOk(cards[k].box));
  const withImp = withPage.filter(k => cards[k].import);
  const byRule = {};
  for (const k of keys) byRule[cards[k].by] = (byRule[cards[k].by] || 0) + 1;
  console.log(`\n覆盖率：卡 ${keys.length} ｜ 有整页 ${withPage.length} ｜ 有红框 ${withBox.length} ｜ 有导入原件 ${withImp.length}`);
  for (const [r, n] of Object.entries(byRule).sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(3)}  ${r}`);
  const need = keys.filter(k => !cards[k].page);
  if (need.length) {
    const g = {};
    for (const k of need) (g[cards[k].note] = g[cards[k].note] || []).push(k);
    console.log(`\n未定位 ${need.length} 张（按批次）：`);
    for (const [note, ks] of Object.entries(g)) console.log(`   ${String(ks.length).padStart(3)}  ${note.slice(0, 130)}\n         ${ks.slice(0, 8).join(', ')}`);
  }
  const { bad } = aspectAudit(cards);
  if (bad.length) {
    console.log(`\n长宽比可疑（裁图与红框比例差 >2.2 倍，页或框可能错）：${bad.length} 张`);
    for (const b of bad.slice(0, 20)) console.log(`   ${b.key}  r=${b.r} 红框AR=${b.boxAR} 裁图AR=${b.cropAR}  ${b.page}`);
  } else console.log('\n长宽比体检：全部通过（红框与裁图比例同量级）');
}

/* ---------- 定位单：给未定位的卡产出「带网格候选页 + 任务单」 ---------- */
function locateSheet({ per }) {
  const doc = fs.existsSync(LEDGER) ? readJson(LEDGER) : { cards: {} };
  const cards = loadCards();
  const need = cards.filter(c => !doc.cards[c.key] || !doc.cards[c.key].page);
  if (!need.length) { console.log('全部卡片都已定位到整页，无需生成定位单'); return; }
  const outDir = path.join(ROOT, '_probe', '定位单');
  fs.mkdirSync(outDir, { recursive: true });
  const groups = {};
  for (const c of need) {
    const b = BATCHES.find(x => x.match(c));
    const gk = b ? b.id : (c.student + '/' + c.subject);
    (groups[gk] = groups[gk] || { student: c.student, cards: [], pages: [] }).cards.push(c);
  }
  const tasks = [];
  for (const [gk, g] of Object.entries(groups)) {
    const b = BATCHES.find(x => x.id === gk);
    let pages = b ? pageFiles(b) : [];
    if (!pages.length) {
      const dirGuess = g.cards[0].cardDir.split('/').slice(0, 1)[0];
      pages = [];
      for (const f of listDir(dirGuess + '/原卷')) if (/\.(jpg|jpeg|png)$/i.test(f)) pages.push({ rel: dirGuess + '/原卷/' + f, tag: f });
    }
    const grid = [];
    for (const p of pages) {
      const out = path.join(outDir, `${gk.replace(/[^\w\u4e00-\u9fa5.-]/g, '_')}__${path.posix.basename(p.rel)}`.replace(/\.jpg$/, '') + '-网格.jpg');
      if (!fs.existsSync(out)) {
        try {
          /* ★ 2026-10-24 B-09：_带网格.ps1 原先写死在某个真实工作目录里；改为在库根的
             _work-* 目录与 _工具\ 里找第一个存在的副本（找不到则跳过网格图并提示）。 */
          const gridPs1 = findGridPs1();
          if (!gridPs1) { console.log('（未找到 _带网格.ps1：放到库根 _工具\\ 或任一 _work-*\\ 目录即可生成网格图；本页跳过）', p.rel); continue; }
          execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
            gridPs1, '-Src', toAbs(p.rel), '-Out', out,
            '-X', '0', '-Y', '0', '-W', '1', '-H', '1', '-Scale', '0.55', '-Step', '0.05'], { encoding: 'utf8' });
        } catch (e) { console.log('网格图生成失败：', p.rel, e.message); continue; }
      }
      grid.push({ page: p.rel, grid: relOf(out) });
    }
    for (let i = 0; i < g.cards.length; i += (per || 10)) {
      const chunk = g.cards.slice(i, i + (per || 10));
      tasks.push({
        group: gk, student: g.student, note: b ? (b.note || '') : '',
        pages: grid, cards: chunk.map(c => ({
          key: c.key, source: c.source, crop: c.cardDir + '/原卷截图.jpg',
          question: (c.source || '').slice(0, 60),
        })),
      });
    }
  }
  const tf = path.join(outDir, '任务单.json');
  writeJsonAtomic(tf, tasks, { indent: 1 });
  console.log(`未定位 ${need.length} 张 → ${tasks.length} 个定位任务，网格图与任务单在 ${outDir}`);
  for (const t of tasks) console.log(`   ${t.group}: ${t.cards.length} 张卡 / ${t.pages.length} 张候选页`);
}

/* ---------- 回填 ---------- */
function backfill(argv) {
  const get = (k) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : null; };
  const key = get('key');
  if (!key) { console.error('回填需要 --key "学生|卡号"'); process.exit(2); }
  const doc = fs.existsSync(LEDGER) ? readJson(LEDGER) : { version: 1, cards: {} };
  const cur = doc.cards[key] || {};
  const page = get('page'), box = get('box'), note = get('note'), by = get('by') || '手工';
  const next = { ...cur, key };
  if (page) {
    const rel = norm(page);
    /* ⚠ 2026-10-15 修（G-P0续 · S3 入口）：回填原先只有 `!exists(rel)`，**没有库根包含性判据**。
       这是与 :250（ruleTaskJson）**同族的第二个入口**，但形态更危险：它是**人工/子代理直接写台账真源**的口子。

       为什么 `!exists` 挡不住（lead 实测 + 本文件旁 G-S3机理复现 复现）：
         rel = norm(page)；exists(rel) = statSync(path.join(ROOT, rel))
         四种输入（目标文件在老库真实存在）：
           `D:\老库\...\x.jpg`   → join 后成 `<库根>\D:\老库\...`（**拼坏**）→ exists=false → 被拒（**靠巧合**）
           `D:/老库/.../x.jpg`   → 同上（拼坏）                                  → exists=false → 被拒（**靠巧合**）
           `..\..\老库\...\x.jpg`→ **正确解析回老库绝对路径**                  → exists=**true** → **写入成功** ❌
           `../../老库/.../x.jpg`→ 同上                                          → exists=**true** → **写入成功** ❌
         ⇒ 真正的越狱形态是「**上跳相对路径**」；绝对路径的"被拒"只是被 path.join 拼坏的**巧合，不是判据**。
         ⇒ 即：`exists()` 判的是"这个路径在盘上存在吗"，不是"这个路径在库内吗"。

       ⚠ 判据必须作用于 **resolve 之后的绝对路径**，不能只看字符串前缀：
         形态 A/B（绝对路径）字符串 `startsWith('..')` = **false**（看不出越界），
         只有 `path.resolve`/包含性判据才能同时拦住 A/B/C/D 四种形态。
         用护栏的 `isInsideRoot`（_工具\_路径护栏.mjs，纯判据、零 IO、path.normalize 后带尾分隔符前缀比较），
         与 :250 的 P0 修法**同一判据、同一实现**。

       顺序：**先包含性准入，再 exists 存在性**（两条都要）。 */
    const abs = path.resolve(ROOT, rel);
    if (!isInsideRoot(abs)) {
      console.error(
        `[回填] 拦下：--page 指向**库根之外**。\n` +
        `  你要写：${abs}\n` +
        `  正确应在：${ROOT} 之下（例：九年级/原卷/xxx.jpg）\n` +
        `  怎么办：page 必须是**库内相对路径**。常见原因——\n` +
        `          ① 上跳相对路径 ../.. 逃出库根（实测可解析回老库并被 exists 放行）；\n` +
        `          ② 直接给了库外绝对路径；\n` +
        `          ③ 同前缀兄弟目录（${path.basename(ROOT)}-备份 / ${path.basename(ROOT)}-old）。\n` +
        `          原老库已于 2026-10-12 废弃，现主库是 ${ROOT}。`);
      process.exit(2);
    }
    if (!exists(rel)) { console.error('页文件不在盘：' + rel); process.exit(1); }
    next.page = rel; next.need = false;
  }
  if (box) {
    const b = box.split(',').map(Number);
    if (!boxOk(b)) { console.error('box 需是归一化 x,y,w,h 且 0~1 内、不越界：' + box); process.exit(1); }
    next.box = b;
  }
  if (note) next.note = note;
  /* ⚠ 2026-10-12 修（审计 BUG-10·低）：原先 `const … by = get('by') || '手工'` + 无条件 `next.by = by`
     ⇒ **不带 --by 回填**（文档用法示例 :25 就省了 --by）会把已有的「视觉定位」来源覆盖成「手工」，
     抹掉"这条是人看原卷定的"这条线索。而同一处的 note 在上面**有**存在性判断 —— 判据不一致。
     现在：没给 --by 就保留原值；给了才写。 */
  if (get('by')) next.by = get('by');
  else if (!next.by) next.by = '手工';       // 新条目且没给来源时才落默认值
  if (next.page && !next.import) {
    const shaCache = fs.existsSync(SHA_CACHE) ? readJson(SHA_CACHE) : {};
    next.import = resolveImport(next.page, shaCache);
    writeJsonAtomic(SHA_CACHE, shaCache);
  }
  doc.cards[key] = next;
  doc.generatedAt = new Date().toISOString();
  writeJsonAtomic(LEDGER, doc, { backup: true, indent: 1 });
  console.log('已回填', key, JSON.stringify({ page: next.page, box: next.box, import: next.import, by: next.by }));
}

/* ---------- 合并视觉定位结果：_probe/定位单/结果-*.json ---------- */
function mergeLocated() {
  const dir = path.join(ROOT, '_probe', '定位单');
  const sheet = readJson(path.join(dir, '任务单.json'));
  const allowed = {};                       /* key → 该任务允许的候选页集合 */
  for (const t of sheet) for (const c of t.cards) allowed[c.key] = t.pages.map(p => norm(p.page));
  const doc = readJson(LEDGER);
  const files = fs.readdirSync(dir).filter(f => /^结果-.*\.json$/.test(f));
  if (!files.length) { console.log('没有结果文件（先跑视觉定位子代理）'); return; }
  const shaCache = fs.existsSync(SHA_CACHE) ? readJson(SHA_CACHE) : {};
  let ok = 0; const rej = [];
  for (const f of files) {
    let rows; try { rows = readJson(path.join(dir, f)); } catch (e) { rej.push(f + ' 解析失败：' + e.message); continue; }
    if (!Array.isArray(rows)) { rej.push(f + ' 不是数组'); continue; }
    for (const r of rows) {
      const e = doc.cards[r.key];
      if (!e) { rej.push(`${r.key}：台账里没有`); continue; }
      const page = r.page ? norm(r.page) : null;
      if (!page || !exists(page)) { rej.push(`${r.key}：页不在盘 ${r.page}`); continue; }
      if (!(allowed[r.key] || []).includes(page)) { rej.push(`${r.key}：页 ${page} 不在该批候选（${(allowed[r.key] || []).join('|')}）`); continue; }
      let box = null;
      if (r.box) { const b = Array.isArray(r.box) ? r.box.map(Number) : null; if (b && boxOk(b)) box = b; else { rej.push(`${r.key}：box 非法 ${JSON.stringify(r.box)}`); continue; } }
      e.page = page; e.need = false; e.by = '视觉定位';
      /* ⚠ 2026-10-12 修（审计 BUG-09·低）：原先无条件 `e.box = box`（本次没给框就把旧框清 null）、
         `e.import = shaCached(...) ? … : null`（查不到就清空）—— 两处都会**静默丢掉**已有人工成果
         （实测 40 条视觉定位里 11 条 import 为空）。而 `build()` 对这两处都有兜底（`|| prev.box`、
         `|| prev.import`），只有 merge 没有 ⇒ 同一份数据两条路径两种命运。
         现在：本次没给出的字段一律**保留旧值**，只在明确给了新值时覆盖。 */
      if (box) e.box = box;
      e.note = `视觉定位（${f}）：${r.evidence || r.note || ''}`.slice(0, 300);
      e.locFile = f;
      if (!e.import) {                      // 只补，不清空
        const h = shaCached(page, shaCache);
        if (h) { const all = inboxImages(); const hit = all.find(p => shaCached(p, shaCache) === h); if (hit) e.import = hit; }
      }
      ok++;
    }
  }
  writeJsonAtomic(SHA_CACHE, shaCache);
  const rels = Object.values(doc.cards).flatMap(e => [e.page, e.cardDir + '/原卷截图.jpg'].filter(Boolean));
  const px = sizesOf(rels);
  for (const e of Object.values(doc.cards)) { e.pagePx = e.page ? (px[norm(e.page)] || null) : null; e.cropPx = px[norm(e.cardDir + '/原卷截图.jpg')] || null; }
  doc.generatedAt = new Date().toISOString();
  writeJsonAtomic(LEDGER, doc, { backup: true, indent: 1 });
  console.log(`合并视觉定位：采纳 ${ok} ｜ 拒绝 ${rej.length}`);
  for (const r of rej) console.log('  ✗ ' + r);
  report(doc.cards);
}
function inboxImages() {
  const out = [];
  (function w(d) {
    for (const f of listDir(d)) {
      const p = d + '/' + f;
      let st = null; try { st = fs.statSync(toAbs(p)); } catch { continue; }
      if (st.isDirectory()) w(p); else if (/\.(jpg|jpeg|png|webp)$/i.test(f)) out.push(norm(p));
    }
  })('_收件箱');
  return out;
}

/* ---------- 页面方向体检（2026-10-16，T097 实测新增）----------
 * 起因：物理 10 月阶段练习 6 张整页照**内容横排**（手机把纸横过来拍的，存储时头朝右），
 * 界面/台账/门禁全都不检查方向 ⇒ 用户点「原图」看到的是横躺的卷面，还得歪头看。
 * 两条判据（都只读，不写盘）：
 *   ① EXIF orientation：值 ∉ {1, 空} 的直接报错——这是相机自己声明"我转过了"；
 *   ② 素材长宽比 + 红框长宽比交叉：横置页面的内容框会呈"竖高条"，与"横页"自相矛盾。
 *     （判据②弱于①：有些卷面本来就横排版，所以②只对**竖版卷面**warning。
 *      主判据是①；补拍/重拍时按"文字正立可读"为准。）
 * 修复方式：把页面照转正（内容正立、无 EXIF 标记）后重算该页上所有归一化框。 */
function jpegOrientation(abs) {
  const b = fs.readFileSync(abs);
  if (b[0] !== 0xFF || b[1] !== 0xD8) return null;   // 非 JPEG（png 等）不检查
  let o = 2;
  while (o < b.length - 4) {
    if (b[o] !== 0xFF) { o++; continue; }
    const m = b[o + 1];
    if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { o += 2; continue; }
    if (m === 0xDA) break;                            // 扫描数据开始，EXIF 在前面
    const len = (b[o + 2] << 8) | b[o + 3];
    if (m === 0xE1 && b[o + 4] === 0x45 && b[o + 5] === 0x78 && b[o + 6] === 0x69 && b[o + 7] === 0x66) {
      const tiff = o + 10, le = b[tiff] === 0x49 && b[tiff + 1] === 0x49;
      const rd16 = p => le ? (b[p] | b[p + 1] << 8) : (b[p] << 8 | b[p + 1]);
      const rd32 = p => le ? (b[p] | b[p + 1] << 8 | b[p + 2] << 16 | b[p + 3] << 24 >>> 0) : ((b[p] << 24 | b[p + 1] << 16 | b[p + 2] << 8 | b[p + 3]) >>> 0);
      const ifd = tiff + rd32(tiff + 4), n = rd16(ifd);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        if (rd16(e) === 0x0112) return rd16(e + 8);
      }
      return null;                                    // 有 EXIF 无方向标记
    }
    o += 2 + len;
  }
  return null;
}

/* ---------- 门禁（**真只读**）----------
 *   把像素尺寸缓存写进 `_probe/_图尺寸.json`。于是"挂在 tests\run.mjs 最前面的只读门禁"
 *   其实会写盘——既让人误判它的副作用，也在多个门禁并发时引入无谓的写竞争。
 *   现在门禁默认只用**已有的**缓存：缺尺寸就跳过那条长宽比体检（并在输出里说明），
 *   需要补缓存就显式加 `--px-cache`。 */
function gate(allowPxWrite = false) {
  if (!fs.existsSync(LEDGER)) { console.error('缺 _原卷台账.json（先跑 生成）'); process.exit(1); }
  const doc = readJson(LEDGER);
  const cards = loadCards();
  const errs = [], warns = [];
  /* ⚠ 2026-10-15 修（I · 门禁检出盲区）：`未定位` 原先直接打印 `errs.length`，
     而 errs 里混了「未定位」「不在盘」「box 非法」「指向自身」等多种错因——
     数字名不副实；本次再往 errs 加「越出库根」会让这个数更失真。
     故新增 `nUnlocated` 单独计数，报表里「未定位」只报真正的未定位条数。 */
  let nUnlocated = 0;
  /* 2026-10-16（P0076–P0085 实测）：「素材灭失」显式豁免态 —— 整页母本真的不存在了
     （当年只拍了裁图/母本已删且未入离机镜像），穷尽检索后永久无法定位。
     诚实原则：假 page（拿裁图冒充整页）比「承认灭失」危害大得多（e2e badTarget 抓的就是它）。
     lost:true 的条目不进 errs（不阻断门禁），但每次运行都显式报告条数与清单——
     它永远可见，直到用户补拍母本回填为止。 */
  let nLost = 0;
  for (const c of cards) {
    const e = doc.cards[c.key];
    if (!e) { errs.push(`${c.key} 台账里没有条目`); continue; }
    if (!e.page) {
      if (e.lost) { nLost++; continue; }        // 素材灭失：不阻断，但下面显式报告
      nUnlocated++; errs.push(`${c.key} 未定位到整页（${(e.note || '').slice(0, 60)}）`); continue;
    }
    /* ⚠ 2026-10-15 修（I · 最高优先）：原先这里**只有** `!exists(e.page)`。
       后果：`exists()` 判的是"这个路径在盘上存在吗"，**不是"这个路径在库内吗"**；
       库外路径只要文件真在盘（老库原卷/收件箱里大量真实文件），就被**静默放过** ⇒
       这正是九年级\物理\ 那 63 条库外 page 长期潜伏、门禁 8 次跑过都没吭声的根因。
       实测：page=`../../<老库>/.../_收件箱/....jpg`（老库真实存在）时 exists=true → 告警 0。

       修法：**先包含性准入，后 exists 存在性**（两条都要）。
       判据作用于 `path.resolve(ROOT, e.page)` 之后的**绝对路径**（关键：
       `../../` 的字符串前缀看不出越界，只有 resolve 后才暴露；且字符串
       `startsWith('..')` 对绝对路径形态返回 false，会漏）。复用护栏纯判据
       `isInsideRoot`（零 IO），与 :250（ruleTaskJson）、回填 同一条判据同一实现。
       进 **errs（错误级）**，不是 warning —— 库外 page 是数据污染，必须让门禁失败。 */
    const pageAbs = path.resolve(ROOT, e.page);
    if (!isInsideRoot(pageAbs)) {
      errs.push(
        `${c.key} 整页**越出库根**（库外路径，属数据污染）：${e.page}\n` +
        `      → 解析为：${pageAbs}\n` +
        `      → 应指向：${ROOT} 之下的库内相对路径（例：九年级/原卷/xxx.jpg）\n` +
        `      → 怎么办：原老库已于 2026-10-12 废弃，现主库是 ${ROOT}；\n` +
        `        常见原因是 _task.json/卡目录里硬编码了老库绝对路径或 ../.. 上跳路径。`);
    }
    if (!exists(e.page)) errs.push(`${c.key} 整页不在盘：${e.page}`);
    if (e.box && !boxOk(e.box)) errs.push(`${c.key} box 非法：${JSON.stringify(e.box)}`);
    /* e.import 同源风险：也补包含性判据（评估见报告 §4；import 指向库外同属污染）。
       仍保留在 warns（导入原件失效属降级告警，不阻断门禁）——与原语义一致，只加"越界"这一因。 */
    if (e.import) {
      const impAbs = path.resolve(ROOT, e.import);
      if (!isInsideRoot(impAbs)) warns.push(`${c.key} 导入原件**越出库根**（库外路径）：${e.import}（解析为 ${impAbs}）`);
      if (!exists(e.import)) warns.push(`${c.key} 导入原件失效：${e.import}`);
    }
    if (e.page && e.cardDir && norm(e.page) === e.cardDir) errs.push(`${c.key} 整页指向卡片目录自身`);
    /* 方向体检（2026-10-16）：EXIF orientation ≠ 1 ⇒ 渲染层要么不转（横躺）要么转错（红框全歪）。
       只读解析文件头，判据硬（相机声明），进 errs。 */
    if (e.page) {
      const abs = path.resolve(ROOT, e.page);
      if (exists(e.page) && isInsideRoot(abs)) {
        const ori = jpegOrientation(abs);
        if (ori != null && ori !== 1) errs.push(`${c.key} 整页带 EXIF 方向标记 orientation=${ori}（渲染必歪/横躺，先把照片转正为无标记的正立图，再回填 --box）：${e.page}`);
      }
    }
  }
  const orphan = Object.keys(doc.cards).filter(k => !cards.some(c => c.key === k));
  if (orphan.length) warns.push('台账里有索引已无的卡：' + orphan.join(', '));
  const noBox = Object.values(doc.cards).filter(e => e.page && !boxOk(e.box)).length;
  if (allowPxWrite) {
    for (const b of aspectAudit(doc.cards).bad) warns.push(`${b.key} 长宽比可疑 r=${b.r}（${b.page}）`);
  } else {
    const px = fs.existsSync(PX_CACHE) ? readJson(PX_CACHE) : {};
    const stale = Object.values(doc.cards).filter(e => e.box && e.page && !px[norm(e.page)]).length;
    if (stale) console.log(`（只读模式：${stale} 张缺像素尺寸缓存，已跳过长宽比体检；要补缓存跑 \`node _原卷台账.mjs 门禁 --px-cache\`）`);
  }
  console.log(`门禁：卡 ${cards.length} ｜ 未定位 ${nUnlocated} ｜ 有整页无红框 ${noBox} ｜ 告警 ${warns.length}`);
  for (const w of warns) console.log('  ⚠ ' + w);
  /* ⚠ 2026-10-15 修（I · 输出截断遮蔽高严重级错误）：
     原先 `errs.slice(0, 40)` + "另有 N 条" —— 在**已有一批低严重级错误**
     （本项目实测：59 条「未定位」）时，新加进来的**高严重级**错误（越出库根/数据污染）
     会被挤到 40 行之后**完全不打印**，只剩一个总数。
     实测：注入一条越界 page 后 errs 59→60（判据**确实检测到了**），
     但输出里 "越出库根" 出现 0 次 ⇒ 人/CI 从输出上根本看不出问题在哪。
     "检测到却不显示"等价于**仍然失明**，所以必须让包含性错误**无条件打印**。
     做法：把「越出库根」类错误单独收集并**优先、全量**输出，其余错误仍按 40 行截断。 */
  const outOfRootErrs = errs.filter(e => e.includes('越出库根'));
  const otherErrs = errs.filter(e => !e.includes('越出库根'));
  if (outOfRootErrs.length) {
    console.log(`  ── 库根包含性错误（共 ${outOfRootErrs.length} 条，**全量打印，不参与截断**）──`);
    for (const e of outOfRootErrs) console.log('  ✗ ' + e);
  }
  const CAP = 40;
  for (const e of otherErrs.slice(0, CAP)) console.log('  ✗ ' + e);
  if (otherErrs.length > CAP) console.log(`  … 另有 ${otherErrs.length - CAP} 条（其余类别错误已截断；当前共 ${errs.length} 条错误）`);
  if (nLost) {
    /* ⚠ 2026-10-25（合成形状库验收时暴露）：原先 `Object.values(doc.cards).map(c => c.key)`
       ——key 是字典的键，不在条目对象里 ⇒ 打印出 10 个空名（", , , …"），"永久可见"落空。
       合成库 11 卡里 10 张 lost，一眼就能看出这行从没打对过。改为 Object.entries 取真键。 */
    const lostKeys = Object.entries(doc.cards).filter(([, c]) => c.lost && !c.page).map(([k]) => k);
    console.log(`  ── 素材灭失豁免（${nLost} 张，永久可见直到补拍回填）──`);
    console.log('    ' + lostKeys.join(', '));
    console.log('    这些卡的整页母本已灭失（当批只留了裁图）；回填新影像后 lost 自动解除。');
  }
  process.exit(errs.length ? 1 : 0);
}

/* ---------- 试算：对任意目录跑一遍规则链（诊断/自测用，绝不写盘） ---------- */
function trial(argv) {
  const i = argv.indexOf('--dir');
  if (i < 0 || !argv[i + 1]) { console.error('试算需要 --dir <卡目录>'); process.exit(2); }
  const cardDir = norm(argv[i + 1]);
  const shaCache = fs.existsSync(SHA_CACHE) ? readJson(SHA_CACHE) : {};
  const c = { key: '试算|' + path.posix.basename(cardDir), student: '试算', subject: '', id: path.posix.basename(cardDir), cardDir, source: '', dirName: '' };
  const chain = [
    ['sidecar', () => ruleSidecar(c)],
    ['task.json', () => ruleTaskJson(c)],
    ['建卡清单', () => ruleBuildList(c, shaCache)],
    ['批次对账', () => reconcilePage(c)],
  ];
  for (const [name, fn] of chain) {
    let r = null;
    try { r = fn(); } catch (e) { console.log(`  ${name}: 抛错 ${e.message}`); continue; }
    if (!r) { console.log(`  ${name}: 未命中`); continue; }
    console.log(`  ${name}: 命中 → page=${r.page} box=${JSON.stringify(r.box)} by=${r.by}\n     ${r.note}`);
    if (r.page) console.log('  导入原件 → ' + (resolveImport(r.page, shaCache) || '（_收件箱 里没有 sha256 同源的件）'));
    return;
  }
  console.log('  全部规则未命中');
}

/* ---------- 入口 ---------- */
const argv = process.argv.slice(2);
const cmd = argv[0] || '覆盖';
try {
  if (cmd === '生成') build({ dry: argv.includes('--dry'), force: argv.includes('--force') });
  else if (cmd === '采集') build({ dry: argv.includes('--dry'), force: true });
  else if (cmd === '覆盖') { if (!fs.existsSync(LEDGER)) { console.log('还没有台账，先跑 生成'); process.exit(1); } report(readJson(LEDGER).cards); }
  else if (cmd === '定位单') { const i = argv.indexOf('--per'); locateSheet({ per: i >= 0 ? +argv[i + 1] : 10 }); }
  else if (cmd === '回填') backfill(argv);
  else if (cmd === '试算') trial(argv);
  else if (cmd === '合并') mergeLocated();
  else if (cmd === '门禁') gate(argv.includes('--px-cache'));
  else { console.log('未知命令：' + cmd + '（可用 生成|采集|覆盖|定位单|回填|门禁）'); process.exit(2); }
} catch (e) { console.error('失败：' + e.message); process.exit(1); }
