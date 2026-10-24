#!/usr/bin/env node
/**
 * 错题本·配图门禁工具（v2.2）—— 「题图不许漏」的唯一执行入口
 *
 * 背景（2026-10-07 用户指出）：「很多题目是有图的，你把图漏了，比如学生A的 P0001」。
 * 根因：组卷/单题打印版的题干渲染优先级是
 *       题干.html（印刷版文字）> 题干.jpg（旧式"整题自足截图"）> 索引 question（摘要）
 *       —— 物理/化学/学生A数学一大批卡这三样都没有图，于是卷面印出"如图…"却没图。
 * 本工具把「哪些题必须有图」变成**显式台账 + 机器门禁**，不再依赖任何人记得。
 *
 * 三个文件：
 *   _配图台账.json  唯一真源：{ cards: { "学生|编号": { need, kind, ref, note, by, date } } }
 *                   need: true=必须有图 / false=确认无需图
 *                   kind: 图的形态 svg（题干.html 内联矢量）| jpg（题图.jpg）| none
 *   （图资产本身仍放在各卡目录：题图.jpg（纯图）/ 题干.jpg（旧式自足）/ 题干.html 内联 svg|img|table）
 *   首页.html        看板：卡片带「缺图」徽章，组卷/答案册硬拦截
 *
 * 用法（node _配图门禁.mjs <动作>）：
 *   扫描                      只读：列出「题干提到图/表」的卡，标注已登记/未登记/有无图资产
 *   登记 --card 学生A|P0001 [--need true|false] [--kind svg|jpg|none] [--ref "..."] [--note "..."]
 *                            按卡登记判定（按卡目录定位，--card 用 学生|编号；也接受 编号 唯一时简写）
 *   批量 --file <figure-ledger.json>   从 JSON 批量登记（[{"card":"学生A|P0001","need":true,...}]）
 *   清单 [--json]             只读：逐题配图状态（首页生成器调用 --json）
 *   门禁 [--json]             在册题里 need=true 却拿不出图 → 退出码 1；有"提到图但未登记"的卡 → 退出码 1
 *                             输出 { ok, problems:[键[原因]], archivedSkipped:[...], cards:{...} }
 *                             人类模式与 --json **同一次判定、同一退出码**（2026-10-09 修：原先 --json
 *                             在判定之前 break，机器通道永远 exit 0，调用方拿到的是假绿灯）
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { libraryRoot, toolPath } from './_库根.mjs';
import { readJsonStrict, writeJsonAtomic } from './_安全写.mjs';

/* ★ 2026-10-23 程序与数据分家：ROOT 现在是**用户库根**，不再是"本脚本所在目录"。
   兄弟工具一律用 toolPath(...)，见 _库根.mjs。 */
const ROOT = libraryRoot();
const LEDGER = path.join(ROOT, '_配图台账.json');
const FIG_ASSETS = ['题图.jpg', '题干.jpg'];          // 卡目录里的图资产
const STEM_HTML = '题干.html';

const argv = process.argv.slice(2);
const action = argv[0];
const opt = {};
for (let i = 1; i < argv.length; i++) {
  const t = argv[i];
  if (!t.startsWith('--')) continue;
  const k = t.slice(2);
  if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { opt[k] = argv[++i]; }
  else { opt[k] = true; }
}
const dstr = x => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
const today = () => dstr(new Date());
const readJson = p => readJsonStrict(p, { label: path.basename(p) });
const writeJson = (p, o) => writeJsonAtomic(p, o, { backup: true });
const fail = m => { console.error('✖ ' + m); process.exit(2); };

/* ---------- 题库发现（与 _盲解复核.mjs / _标记复习.mjs 同规则） ---------- */
function indexFiles(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) { if (e.name === '_索引.json') acc.push(path.join(dir, e.name)); continue; }
    if (e.name.startsWith('_') || e.name.startsWith('.')) continue;
    if (/(作业|假期)/.test(e.name)) continue;
    indexFiles(path.join(dir, e.name), acc);
  }
  return acc;
}
function itemsOfJson(j, base) {
  const out = [];
  if (Array.isArray(j.items)) for (const it of j.items) out.push({ item: it, subject: j.subject || '', student: j.student, dirAbs: path.join(base, it.dir) });
  if (j.subjects) for (const [name, v] of Object.entries(j.subjects)) for (const it of (v.items || [])) out.push({ item: it, subject: name, student: j.student, dirAbs: path.join(base, name, it.dir) });
  return out;
}
function allCards() {
  const out = [];
  for (const f of indexFiles(ROOT)) for (const x of itemsOfJson(readJson(f), path.dirname(f))) out.push({ ...x, key: x.student + '|' + x.item.id });
  return out;
}

/* ---------- 题干文本（与打印口径一致） ---------- */
function stripHtml(html) {
  if (!html) return '';
  let s = String(html);
  s = s.replace(/<svg[\s\S]*?<\/svg>/g, ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}
function originalFromRecord(dirAbs) {
  const p = path.join(dirAbs, '错题记录.md');
  if (!fs.existsSync(p)) return '';
  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
  const i = lines.findIndex(l => /^\*\*原题\*\*/.test(l.trim()));
  if (i < 0) return '';
  const out = [lines[i].trim().replace(/^\*\*原题\*\*[：:]\s*/, '')];
  for (let k = i + 1; k < lines.length; k++) {
    const l = lines[k].trim();
    if (l === '' || /^#/.test(l) || /^\*\*/.test(l)) break;
    out.push(l);
  }
  return out.join(' ').trim();
}
/** 打印时实际会用到的题干文字 + 它的来源（决定"图必须存在"的判断依据） */
function printStem(x) {
  const stemPath = path.join(x.dirAbs, STEM_HTML);
  if (fs.existsSync(stemPath)) {
    const raw = fs.readFileSync(stemPath, 'utf8');
    return { text: stripHtml(raw), raw, hasStemHtml: true, hasInlineFig: /<svg|<img|<table/i.test(raw) };
  }
  const rec = originalFromRecord(x.dirAbs);
  if (rec) return { text: rec, raw: '', hasStemHtml: false, hasInlineFig: false };
  return { text: String(x.item.question || ''), raw: '', hasStemHtml: false, hasInlineFig: false };
}
/** 图/表关键词：只用来"发现疑似必须有图但没登记的卡"，判定权仍归台账 */
const FIGWORDS = /如图|如下图|见图|图 ?[一二三四1234]|图象|图像|数轴|月历|统计图|示意图|曲线|表格|下表|如下表|装置|情景|矩形纸板|滑轮组|杠杆|玻璃管/;
function assets(x) {
  const present = FIG_ASSETS.filter(f => fs.existsSync(path.join(x.dirAbs, f)));
  const st = printStem(x);
  return { files: present, hasInlineFig: st.hasInlineFig, hasStemHtml: st.hasStemHtml, stem: st };
}
/** 结论：图资产是否齐 */
function figState(x, entry) {
  const a = assets(x);
  const hasAsset = a.files.length > 0 || a.hasInlineFig;
  if (!entry) return { state: '未登记', hasAsset, a, need: null };
  const need = entry.need === true;
  if (!need) return { state: '无需图', hasAsset, a, need: false };
  if (!hasAsset) return { state: '缺图', hasAsset, a, need: true };
  return { state: '有图', hasAsset, a, need: true };
}

/* ---------- 台账读写 ---------- */
function loadLedger() {
  if (!fs.existsSync(LEDGER)) return { note: '哪些题必须有图：显式登记，机器门禁据此拦截组卷。need=true 必须有图资产。', cards: {} };
  /* 形状异常必须响亮拒绝（BUG-02）：旧写法把坏的 cards 换成 {} 再写回 = 167 条配图判定一次清空 */
  return readJsonStrict(LEDGER, { shape: j => !!j.cards && typeof j.cards === 'object' && !Array.isArray(j.cards), what: 'cards 对象', label: '_配图台账.json' });
}
function saveLedger(j) { writeJson(LEDGER, j); }

function resolveCard(token) {
  const cards = allCards();
  const t = String(token).trim();
  if (t.includes('|')) {
    const hit = cards.filter(c => c.key === t);
    if (hit.length === 1) return hit[0];
    if (hit.length > 1) fail('卡片键重复：' + t);
    fail('台账里找不到卡片：' + t);
  }
  const id = t.toUpperCase();
  const hit = cards.filter(c => c.item.id === id);
  if (hit.length === 1) return hit[0];
  if (hit.length > 1) fail('编号 ' + id + ' 在多个库中出现，请用 学生|编号：' + hit.map(c => c.key).join(' '));
  fail('找不到卡片：' + t);
}

switch (action) {

  case '扫描': {
    const led = loadLedger();
    const cards = allCards();
    let suspicious = 0, unreg = 0, hasKw = 0;
    for (const x of cards) {
      const e = led.cards[x.key];
      const st = printStem(x);
      const kw = FIGWORDS.test(st.text);
      const fs_ = figState(x, e);
      if (kw) hasKw++;
      /* ⚠ 2026-10-12 修（审计 BUG-03）：原实现是
           if (!kw && !e) continue;      ← 先跳过"没关键词且没台账条目"的卡
           if (!e) unreg++;              ← 于是永远数不到（走到这行时 e 必存在）
         实测脚本报"未登记 0 张"，而真实是 35 张（台账 167 / 索引 202）——
         近 17% 的卡从未进台账、从未受门禁保护，而汇总数字说一切正常。
         现在：先把"未登记"数清楚，再决定要不要打印明细。 */
      if (!e) unreg++;
      if (!kw && !e) continue;          // 无关键词且未登记：不必逐条刷屏，但仍计入 unreg
      if (kw && !e) suspicious++;
      const flag = e ? (e.need ? (fs_.state === '有图' ? '✓' : '⛔') : '·无需图') : (kw ? '⚠未登记(题干提到图/表)' : '·未登记');
      console.log(`${x.key.padEnd(10)} ${String(x.item.id).padEnd(6)} ${(x.subject || '').padEnd(3)} ${flag.padEnd(22)} 资产=[${fs_.a.files.join(',') || '-'}]${fs_.a.hasInlineFig ? '+题干内联图' : ''}${fs_.a.hasStemHtml ? '' : ' ⚠无题干.html(组卷退回摘要)'}`);
      if (e && e.note) console.log(`             ↳ ${e.note}`);
    }
    /* 孤儿检查（补 `_原卷台账.mjs:601-602` 已有的那一条）：台账里有、索引里没有 */
    const idxKeys = new Set(cards.map(x => x.key));
    const orphan = Object.keys(led.cards).filter(k => !idxKeys.has(k));
    console.log(`\n合计 ${cards.length} 张卡：台账已登记 ${cards.length - unreg} 张，未登记 ${unreg} 张` +
      `（其中题干提到图/表但未登记 ${suspicious} 张；全库题干提到图/表共 ${hasKw} 张）`);
    if (unreg) console.log(`  ⚠ ${unreg} 张卡从未登记配图台账 ⇒ 不受配图门禁保护。补：node _配图门禁.mjs 登记 --card 学生|编号 --need true|false` +
      `${unreg <= 12 ? '\n     ' + cards.filter(x => !led.cards[x.key]).map(x => x.key).join('  ') : ''}`);
    if (orphan.length) console.log(`  ⚠ 台账里有索引已无的孤儿条目 ${orphan.length} 条（撤卡后未清理）：${orphan.slice(0, 12).join(' ')}${orphan.length > 12 ? ' …' : ''}`);
    break;
  }

  case '登记': {
    if (!opt.card) fail('登记需要 --card 学生|编号');
    const x = resolveCard(opt.card);
    const led = loadLedger();
    const prev = led.cards[x.key] || {};
    /* --need 只认 true/false 字面量：写 1/yes/TRUE 旧代码会静默落成 false（=「确认无需图」），
       把一张必须有图的卡悄悄移出门禁保护范围（2026-10-09 补）。 */
    let need;
    if (opt.need === undefined) need = prev.need === undefined ? true : prev.need;
    else {
      const raw = String(opt.need).toLowerCase();
      if (raw !== 'true' && raw !== 'false') fail(`--need 只接受 true/false，收到 ${JSON.stringify(opt.need)}`);
      need = raw === 'true';
    }
    const entry = {
      need,
      kind: opt.kind || prev.kind || (need ? (assets(x).hasInlineFig ? 'svg' : (fs.existsSync(path.join(x.dirAbs, '题图.jpg')) ? 'jpg' : 'none')) : 'none'),
      ref: opt.ref || prev.ref || '',
      note: opt.note || prev.note || '',
      by: opt.by || 'agent',
      date: opt.date || today()
    };
    led.cards[x.key] = entry;
    saveLedger(led);
    const fs_ = figState(x, entry);
    console.log(`${x.key} 已登记：need=${entry.need} kind=${entry.kind} 当前状态=${fs_.state}`);
    if (entry.need && fs_.state === '缺图') console.log('   ⛔ 该卡必须有图但目录里还没有图资产（题图.jpg / 题干.jpg / 题干.html 内联图）——组卷会被拦截。');
    break;
  }

  case '批量': {
    if (!opt.file) fail('批量需要 --file <json>');
    if (!fs.existsSync(opt.file)) fail('文件不存在：' + opt.file);
    const list = readJson(opt.file);
    if (!Array.isArray(list)) fail('文件内容应为数组：[{card,need,kind,ref,note}]');
    const led = loadLedger();
    let n = 0;
    for (const row of list) {
      const x = resolveCard(row.card);
      /* 写入端同一条 schema 校验：need 必须是布尔。字符串 "true"/1 旧代码静默写成 false，
         等于把「必须配图」悄悄改成「无需图」——门禁从此不管这张卡（2026-10-09 补）。 */
      if (typeof row.need !== 'boolean') fail(`批量登记 ${row.card}：need 必须是布尔 true/false，收到 ${JSON.stringify(row.need)}`);
      led.cards[x.key] = {
        need: row.need, kind: row.kind || (row.need ? 'jpg' : 'none'),
        ref: row.ref || '', note: row.note || '', by: row.by || 'agent', date: row.date || today()
      };
      n++;
    }
    saveLedger(led);
    console.log(`已批量登记 ${n} 张卡 → ${LEDGER}`);
    break;
  }

  case '清单':
  case '门禁': {
    const led = loadLedger();
    const cards = allCards();
    const map = {}, problems = [], archived = [];
    for (const x of cards) {
      const e = led.cards[x.key];
      const r = figState(x, e);
      map[x.key] = { state: r.state, ok: r.state !== '缺图', hasAsset: r.hasAsset, hasStemHtml: r.a.hasStemHtml, inline: r.a.hasInlineFig, files: r.a.files, need: r.need };
      /* 台账字段类型校验（2026-10-09）：need 必须是布尔。写成 "true"/1 时旧代码 `entry.need === true`
         判定为 false —— 静默降级成「无需图」，门禁就再也不管这张卡了。 */
      if (e && typeof e.need !== 'boolean') problems.push(`${x.key}[need 字段非法：${JSON.stringify(e.need)}，应为 true/false]`);
      if (x.item.status === '已归档') {           // 归档卡不阻断组卷，但必须**可见**，不许静默跳过
        if (r.state === '缺图' || (!e && FIGWORDS.test(r.a.stem.text))) archived.push(`${x.key}[${r.state === '缺图' ? '缺图' : '提到图/表但未登记'}]`);
        continue;
      }
      if (r.state === '缺图') problems.push(`${x.key}[缺图]`);
      else if (!e && FIGWORDS.test(r.a.stem.text)) problems.push(`${x.key}[提到图/表但未登记]`);
    }
    // L1+L2 单一判定、同码同判：judge 只算一次；人类模式与 --json 用同一份 problems、同一个退出码
    if (opt.json) {
      /* ⚠ 形状分两种，别混（2026-10-09 实测踩过）：`清单 --json` 是**纯 map**，首页生成器靠它的
         属性个数报「N 张卡已扫描」；`门禁 --json` 才带判定信封。把两者合一 = 页面把 ok/problems
         当成两张卡数。 */
      console.log(JSON.stringify(action === '清单' ? map : {
        ok: problems.length === 0, action, problems, archivedSkipped: archived, cards: map,
      }));
      if (action === '门禁' && problems.length) process.exitCode = 1;
      break;
    }
    const g = {};
    for (const k of Object.keys(map)) g[map[k].state] = (g[map[k].state] || 0) + 1;
    console.log('配图状态：' + Object.entries(g).map(([k, v]) => `${k} ${v}`).join(' ｜ '));
    const needN = Object.values(map).filter(v => v.need === true).length;
    const haveN = Object.values(map).filter(v => v.need === true && v.ok).length;
    console.log(`必须配图的卡：${haveN}/${needN} 已就位`);
    if (archived.length) console.log(`（已归档卡另有 ${archived.length} 张问题，只记录不阻断：${archived.join(' ')}）`);
    if (action === '门禁') {
      if (problems.length) { console.log('⛔ 配图门禁未通过：\n   ' + problems.join('\n   ')); process.exitCode = 1; }
      else console.log('配图门禁通过：已登记必须有图的题全部有图，且没有"提到图却没登记"的漏网卡。');
    } else {
      Object.keys(map).sort().forEach(k => {
        const v = map[k];
        console.log(`${k.padEnd(10)} ${v.state.padEnd(5)} 资产=[${(v.files || []).join(',') || '-'}]${v.inline ? '+内联图' : ''}${v.hasStemHtml ? '' : ' ⚠无题干.html'}`);
      });
    }
    break;
  }

  default:
    console.log('未知动作：' + action + '\n可用：扫描 / 登记 / 批量 / 清单 / 门禁');
    process.exitCode = 2;
}
