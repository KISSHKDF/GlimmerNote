#!/usr/bin/env node
/**
 * 错题本 · 门禁「机器通道契约」回归（2026-10-10 建）
 *
 * 为什么需要它（根因）：
 *   2026-10-10 实测发现，`_盲解复核.mjs 门禁 --json` 的信封是
 *     { ok, action, checked, liveCount, okCount, problems, cards }
 *   —— 卡片字典在 **.cards** 里；但两个消费方都按「顶层就是字典」取值：
 *     · `_标记复习.mjs` 组卷口   → fresh['学生|编号'] 恒 undefined ⇒ 指纹新鲜度门禁从来没拦过
 *     · `_生成首页.ps1`         → BLINDFRESH 里装的是 ok/action/checked… ⇒ v1 首页 blindOk() 恒 true
 *   两处都是**静默降级**：门禁看着在，实际永远放行。这类「信封 vs 字典」形变没有任何测试兜底，
 *   上一个同类漏洞（门禁 --json 在判定前 break，机器通道永远 exit 0）也是同一家族（rc.10 修过）。
 *
 * 本文件的职责：把「各工具 --json 的**外部形状**」变成断言。形状变了就红，不管是谁改的。
 *   1. `_盲解复核.mjs 门禁 --json`   → 信封，且 .cards 是 键=学生|编号 的字典，条数=checked
 *   2. `_待确认.mjs   门禁 --json`   → 信封，且 .items 是数组、.open 是数字
 *   3. `_配图门禁.mjs 清单 --json`   → **扁平字典**（不是信封）——首页生成器直接当字典注入
 *   4. `_状态.json`                  → .blindFresh/.figState 都是「学生|编号」扁平字典，
 *                                      且 **不含 ok/action/checked/cards 这类信封字段**
 *                                      （含了就说明生成器又把信封灌进前端，等于 v1 首页门禁再次失效）
 *   5. 正/反证：把 .cards 剥掉后本脚本必须能报红（阴性对照见 --selftest）
 *
 * 退出码 0=契约成立；1=形状漂移（有消费方会静默失效，必须先修再跑界面回归）。
 *
 * 用法：node tests\gates-contract.mjs [--json] [--selftest]
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
/* ★ 2026-10-23：测试环境收进 tests\_测试环境.cjs —— 工具在 src\tools\，数据在库根。 */
const E = require('./_测试环境.cjs');
const ROOT = E.REPO;
const JSON_OUT = process.argv.includes('--json');
const SELFTEST = process.argv.includes('--selftest');
const problems = [];
const notes = [];

const CARDKEY = /^[^|]+\|[A-Za-z]+\d+$/;          // 学生|编号：如 学生A|S0001、学生B|P0039
const ENVELOPE_FIELDS = ['ok', 'action', 'checked', 'liveCount', 'okCount', 'cards'];

function bad(msg) { problems.push(msg); }

function runJson(script, args) {
  /* 工具在 src\tools\；显式传 CTB_DATA=LIB，保证测试与被测工具读同一份库 */
  const r = spawnSync(process.execPath, [E.tool(script), ...args], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: Object.assign({}, process.env, { CTB_DATA: E.LIB }),
  });
  if (r.error) { bad(`${script} ${args.join(' ')} 跑不起来：${r.error.message}`); return null; }
  const txt = String(r.stdout || '').trim();
  if (!txt) { bad(`${script} ${args.join(' ')} 的 --json 通道没有 stdout（退出码 ${r.status}）`); return null; }
  try { return JSON.parse(txt); }
  catch (e) { bad(`${script} ${args.join(' ')} 的 --json 输出不是纯 JSON：${txt.slice(0, 160)}`); return null; }
}

/* ---------- 1. _盲解复核.mjs 门禁 --json ---------- */
const blind = runJson('_盲解复核.mjs', ['门禁', '--json']);
if (blind) {
  for (const f of ['ok', 'checked', 'cards', 'problems']) if (!(f in blind)) bad(`_盲解复核 门禁 --json 少了信封字段 ${f}（消费方形状契约变了）`);
  if (!blind.cards || typeof blind.cards !== 'object' || Array.isArray(blind.cards)) {
    bad('_盲解复核 门禁 --json 的 .cards 不是字典 —— _标记复习.mjs 与 _生成首页.ps1 都要靠它');
  } else {
    const ks = Object.keys(blind.cards);
    if (typeof blind.checked === 'number' && blind.checked > 0 && ks.length !== blind.checked) {
      bad(`_盲解复核 门禁 --json：.cards 条数 ${ks.length} ≠ checked ${blind.checked}（有消费方会以为"没有这张卡"而放行）`);
    }
    const badKey = ks.filter(k => !CARDKEY.test(k));
    if (badKey.length) bad(`_盲解复核 门禁 --json 的 .cards 里有非「学生|编号」键：${badKey.slice(0, 5).join(',')}`);
    const badVal = ks.filter(k => typeof blind.cards[k] !== 'string');
    if (badVal.length) bad(`_盲解复核 门禁 --json 的 .cards 里 ${badVal.length} 条不是字符串新鲜度态`);
    notes.push(`盲解门禁：checked=${blind.checked} cards=${ks.length} 例=${ks.slice(0, 2).map(k => k + '=' + blind.cards[k]).join(' ')}`);
  }
}

/* ---------- 2. _待确认.mjs 门禁 --json ---------- */
const pend = runJson('_待确认.mjs', ['门禁', '--json']);
if (pend) {
  if (!Array.isArray(pend.items)) bad('_待确认 门禁 --json 的 .items 不是数组（_状态刷新.mjs 直接把它塞进状态包给前端）');
  if (typeof pend.open !== 'number') bad('_待确认 门禁 --json 的 .open 不是数字（首页待办计数会显示 undefined）');
  if (Array.isArray(pend.items) && pend.items.length && !('evidenceOk' in pend.items[0])) {
    bad('_待确认 门禁 --json 的每条缺 evidenceOk（v2.5 起前端靠它渲染红块，缺了就回到"静默破图"）');
  }
  /* v2.8（2026-10-21）：重号字段必须在。它是"办完不消失"事故的可观测出口——
     没有它，重号只能靠人肉发现（用户就是这么报障的）。 */
  if (!Array.isArray(pend.dupId)) {
    bad('_待确认 门禁 --json 缺 .dupId 数组（编号重号时前端无法显式报红，"办完不消失"会再次静默发生）');
  } else if (pend.dupId.length) {
    notes.push(`⚠ 待确认台账存在编号重号：${pend.dupId.map(d => d.id + '×' + d.count).join(',')}（按编号取条目会取错，办结落不了库）`);
  }
  notes.push(`待确认门禁：open=${pend.open} items=${Array.isArray(pend.items) ? pend.items.length : '?'} dup=${Array.isArray(pend.dupId) ? pend.dupId.length : '?'}`);
}

/* ---------- 2b. PowerShell 生成器必须是 UTF-8 with BOM ----------
 * 2026-10-21 事故：`_生成首页.ps1` 被存成 **无 BOM 的 UTF-8**，而 PowerShell 5.1 在无 BOM 时按
 * 系统 ANSI（本机 936/GBK）解码脚本 ⇒ 中文注释被解成乱码，`ParseFile` 直接报语法错误，
 * 生成器整体跑不起来（首页与状态包都不再更新）。
 * ★ 2026-10-23：生成器已迁到 Node（`src\tools\生成状态.mjs`，PowerShell 版退役），
 *   所以这里改为**守新生成器**：① 文件在；② `node --check` 语法通过；③ 能真跑出合法状态包。
 *   BOM 那条检查的对象已经不存在了 —— 但同类地雷（编码坏了没人发现）现在落在 .mjs 上，
 *   而 .mjs 的等价物就是"语法能不能解析"。 */
const GEN = E.tool('生成状态.mjs');
if (!fs.existsSync(GEN)) {
  bad('生成状态.mjs 不存在（状态生成器是产物链的起点）');
} else {
  const chk = spawnSync(process.execPath, ['--check', GEN], { encoding: 'utf8' });
  if (chk.status !== 0) bad('生成状态.mjs 语法解析失败：' + String(chk.stderr || '').trim().slice(0, 160));
  else notes.push('生成状态.mjs：语法解析 ✓');
}

/* ---------- 3. _配图门禁.mjs 清单 --json（必须是扁平字典，不是信封） ---------- */
const fig = runJson('_配图门禁.mjs', ['清单', '--json']);
if (fig) {
  const ks = Object.keys(fig);
  if (ks.some(k => ENVELOPE_FIELDS.includes(k))) bad(`_配图门禁 清单 --json 变成了信封（含 ${ks.filter(k => ENVELOPE_FIELDS.includes(k)).join(',')}）—— _生成首页.ps1 把它当字典注入 FIGSTATE，前端会查不到任何卡`);
  else if (ks.length && !ks.every(k => CARDKEY.test(k))) bad(`_配图门禁 清单 --json 的键不是「学生|编号」：${ks.filter(k => !CARDKEY.test(k)).slice(0, 5).join(',')}`);
  notes.push(`配图清单：${ks.length} 张卡（扁平字典形态 ok）`);
}

/* ---------- 4. _状态.json 的两个注入字典（前端实际吃到的形状） ---------- */
const STATE = E.lib('_状态.json');
if (!fs.existsSync(STATE)) {
  notes.push('_状态.json 不存在（跳过；生成器还没跑过）');
} else {
  let st = null;
  try { st = JSON.parse(fs.readFileSync(STATE, 'utf8')); }
  catch (e) { bad('_状态.json 不是合法 JSON（壳/前端会白屏）：' + e.message); }
  if (st) {
    for (const [sec, what] of [['blindFresh', 'v1 首页/shell 的 blindOk()'], ['figState', '配图缺图徽章/硬拦截'], ['admit', 'v2 界面"能不能进篮子"（canGroup）']]) {
      const v = st[sec];
      if (!v || typeof v !== 'object' || Array.isArray(v)) { bad(`_状态.json.${sec} 不是字典（${what} 会静默失效）`); continue; }
      const ks = Object.keys(v);
      const env = ks.filter(k => ENVELOPE_FIELDS.includes(k));
      if (env.length) {
        bad(`_状态.json.${sec} 里出现信封字段 ${env.join(',')} —— 生成器又把"门禁信封"灌进前端了（2026-10-10 修过一次的同一个 bug），${what} 会退化成"全部放行"`);
      }
      const badKey = ks.filter(k => !CARDKEY.test(k));
      if (badKey.length && !env.length) bad(`_状态.json.${sec} 有非「学生|编号」键：${badKey.slice(0, 5).join(',')}`);
      notes.push(`${sec}：${ks.length} 条${ks.length ? ' 例=' + ks[0] + '=' + JSON.stringify(v[ks[0]]).slice(0, 40) : ''}`);
    }
    if (st.blindFresh && st.blindFresh['学生A|S0001'] === undefined && Object.keys(st.blindFresh).length > 0) {
      notes.push('（提示）blindFresh 里没有 学生A|S0001 —— 若该卡不在册可忽略');
    }
    /* ---------- 5. dataHealth：数据源降级必须是"显式可见"的 ---------- */
    /* 2026-10-10（BUG-03）：三处数据源读取原先都「读不到就用一个一切正常的默认值」兜底
       ⇒ 待办看起来已清空、配图/盲解门禁整体放行，而界面与"真没问题"长得一模一样。
       现在生成器会把降级事实写进 _状态.json.dataHealth 并在页面挂红条；
       这里把它变成断言：字段必须在，且非 ok 时必须伴随红条（否则等于白写）。 */
    if (!('dataHealth' in st)) {
      bad('_状态.json 缺 dataHealth 字段（数据源读取失败将无法与"正常"区分，BUG-03 会复发）');
    } else {
      const dh = st.dataHealth || {};
      const keys = ['blindFresh', 'pending', 'figState'];
      const miss = keys.filter(k => !(k in dh));
      if (miss.length) bad(`_状态.json.dataHealth 缺分区：${miss.join(',')}`);
      const badSrc = keys.filter(k => dh[k] && dh[k] !== 'ok');
      /* 2026-10-23：v1 的 `首页.html` 已退役（界面改由 app\index.html 直接读状态包），
         所以"降级时首页有没有红条"这条判据改由 **v2 界面源码**承担：
         shell.js 必须存在 dataHealthBanner 渲染点。找不到就是降级无人可见。 */
      const shellSrc = fs.existsSync(path.join(ROOT, 'src', 'app', 'js', 'shell.js'))
        ? fs.readFileSync(path.join(ROOT, 'src', 'app', 'js', 'shell.js'), 'utf8') : '';
      if (badSrc.length && !/renderHealth|dataHealth/i.test(shellSrc)) {
        bad(`dataHealth 报 ${badSrc.join(',')} 异常，但界面没有降级红条渲染点 —— 降级又被静默了`);
      }
      notes.push(`dataHealth：${JSON.stringify(dh)}${badSrc.length ? ' ← 有源降级（红条应已出现）' : ''}`);
    }
  }
}

/* ---------- 5. 阴性对照：证明本脚本真的会红 ---------- */
if (SELFTEST) {
  const good = { ok: true, action: '门禁', checked: 2, liveCount: 2, okCount: 2, problems: [], cards: { '学生A|S0001': '有效', '学生B|P0039': '有效' } };
  const brokenMissingCards = { ok: true, action: '门禁', checked: 202, cards: undefined };
  const brokenEnvelope = { ok: true, action: '门禁', checked: 202, cards: { ok: true, action: '门禁', checked: 202 } };  // 信封又套进字典
  const probe = env => {
    const p = [];
    if (!env.cards || typeof env.cards !== 'object') p.push('cards 缺失');
    else {
      const ks = Object.keys(env.cards);
      if (ks.length !== env.checked) p.push('条数不符');
      if (ks.some(k => !CARDKEY.test(k))) p.push('键形态不符');
    }
    return p;
  };
  const rGood = probe(good), rMiss = probe(brokenMissingCards), rEnv = probe(brokenEnvelope);
  const pass = rGood.length === 0 && rMiss.length > 0 && rEnv.length > 0;
  notes.push('阴性对照：' + (pass
    ? '通过（缺 cards / 信封套字典 两种漂移都被抓住）'
    : `❌ 失败 good=${JSON.stringify(rGood)} miss=${JSON.stringify(rMiss)} env=${JSON.stringify(rEnv)}`));
  if (!pass) bad('阴性对照失败：本脚本抓不住"信封被当字典"的漂移');
}

/* ---------- 输出 ---------- */
const result = { ok: problems.length === 0, checked: notes.length, problems, notes };
if (JSON_OUT) console.log(JSON.stringify(result, null, 1));
else {
  for (const n of notes) console.log('  · ' + n);
  if (problems.length) {
    console.log('\n✖ 门禁契约漂移（有消费方会静默失效，先修再跑界面回归）：');
    for (const p of problems) console.log('  - ' + p);
  } else console.log('\n门禁契约通过：各工具 --json 的外部形状与消费方一致。');
}
process.exit(problems.length ? 1 : 0);
