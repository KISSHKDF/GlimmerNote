#!/usr/bin/env node
/**
 * 错题本 · 一键体检（v1，2026-10-10 建）
 *
 * 解决什么：「铁律写进文档了」不等于「铁律在跑」。2026-10-10 实测抓到两条**静默失效**：
 *   ① `_盲解复核.mjs 门禁 --json` 的信封里卡片字典在 .cards，而两个消费方（_标记复习.mjs 组卷口、
 *      _生成首页.ps1）都按「顶层就是字典」取值 ⇒ 「题干改过没重盲解」的题能一路进组卷池；
 *   ② `_快照.mjs` 从建库起**一次都没跑过**（`git log --grep='^data:'` = 0 条），而 DEVELOPMENT §2
 *      规定「每录完一份卷 / 办结一批待办后跑一次」——28 个数据真源改动全裸在工作区，
 *      「git 可回滚」这句承诺实际是零。
 *   两条的共同根因：**没有人/程序定期回头看**。本工具就是那个"定期回头看"。
 *
 * 与 tests\run.mjs 的分工：
 *   run.mjs   = 改代码后的回归门禁（会起壳、会写路径、必须全绿才发版）
 *   本工具    = 平时/收工前的**只读体检**（不起壳、不写任何文件），把"硬门禁"和"进度指标"分开报
 *
 * 用法：node _体检.mjs [--json] [--quiet]
 * 退出码：硬门禁任一红 → 1；只有进度项不达标 → 0（进度是工作量，不是故障）
 */
import fs from 'fs';
import path from 'path';
import { spawnSync, execFileSync } from 'child_process';
import { readJsonStrict } from './_安全写.mjs';   // 2026-10-12：裸 JSON.parse 不剥 BOM（审计 BUG-15 同族）
import { libraryRoot, toolPath, TOOL_DIR, APP_ROOT } from './_库根.mjs';

/* ★ 2026-10-23 程序与数据分家：本工具原来只有一个 ROOT（= 脚本所在目录），既拿它跑兄弟工具、
   又拿它读数据。工具搬进 <AppRoot>\tools\ 之后这两个用途**必须分开**，否则：
     · 跑兄弟工具会去找 <AppRoot>\tools\_原卷台账.mjs —— 这个还对；
     · 读数据会去读 <AppRoot>\_状态.json / <AppRoot>\九年级\ —— 全都不存在，
       于是体检会对着"空库"报出一堆假红（实测不带 CTB_DATA 跑 `_体检.mjs --json` 即如此）。
   现在：ROOT=库根（数据），工具走 toolPath()，测试走 TESTS_DIR。 */
const ROOT = libraryRoot();

/* tests\ 只在开发区存在（<仓库>\tests）；发布包里不带测试。找不到就显式跳过，不假装跑过。 */
const TESTS_DIR = (() => {
  for (const c of [
    path.resolve(TOOL_DIR, '..', '..', 'tests'),   // 开发区：<仓库>\src\tools → <仓库>\tests
    path.join(APP_ROOT, 'tests'),                   // 发布包：<AppRoot>\tests（若有）
    path.resolve(APP_ROOT, '..', 'tests'),
  ]) { try { if (fs.statSync(c).isDirectory()) return c; } catch { } }
  return null;
})();
const JSON_OUT = process.argv.includes('--json');
const QUIET = process.argv.includes('--quiet');

/* ---------- 收集器 ---------- */
const hard = [];      // 必须绿：红了就是系统有病
const progress = [];  // 进度：红了是"还有活没干完"，不是故障
const info = [];
let STATE_OBJ = null; // _状态.json 解析结果（供后面的 dataHealth / 分区计数用）

const H = (name, ok, detail) => hard.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
const P = (name, ok, detail) => progress.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
const I = (name, detail) => info.push({ name, detail: detail === undefined ? '' : String(detail) });

function runTool(script, args = []) {
  /* script 可以是兄弟工具名（走 toolPath）或绝对路径（测试脚本）；数据根靠 CTB_DATA 传给子进程 */
  const abs = path.isAbsolute(script) ? script : toolPath(script);
  const r = spawnSync(process.execPath, [abs, ...args], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: Object.assign({}, process.env, { CTB_DATA: ROOT }),
  });
  return { code: r.status === null ? -1 : r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
function tryJson(script, args) {
  const r = runTool(script, args);
  const t = r.out.trim();
  if (!t) return { code: r.code, json: null, out: r.out, err: r.err };
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  try { return { code: r.code, json: JSON.parse(a >= 0 && b > a ? t.slice(a, b + 1) : t), out: r.out, err: r.err }; }
  catch (e) { return { code: r.code, json: null, out: r.out, err: r.err, parseError: String(e.message) }; }
}
const lastLine = s => String(s || '').trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || '';

/* ============ A. 硬门禁（各工具的唯一裁判权，本工具只汇总，不重算） ============ */
const ledger = runTool('_原卷台账.mjs', ['门禁']);
H('原卷台账门禁', ledger.code === 0, lastLine(ledger.out));

const fig = runTool('_配图门禁.mjs', ['门禁']);
H('配图门禁', fig.code === 0, lastLine(fig.out));

/* 作答契约门禁（2026-10-25 建）：用户同一天三条报障——答案册答案不全 / 图里作答的题白留答题区 /
   下横线写不下答案。判据＝题干空位数（客观可数）× 卡片逐空答案登记 + answerMode。
   与前两道数据门禁同一地位：红了就是"印出来会出丑"，不是进度欠账。 */
const ansGate = tryJson('_作答门禁.mjs', ['门禁', '--json']);
H('作答契约门禁', ansGate.code === 0,
  ansGate.json ? `契约通过 ${(ansGate.json.stats || {}).pass || 0}/${(ansGate.json.stats || {}).total || 0}，阻断 ${(ansGate.json.stats || {}).block || 0}` : lastLine(ansGate.out));

/* 着重号门禁（2026-10-25 晚建）：用户指着印出来的 Y0001 说「打点能力很差，全库都是这样」。
   根因＝`.rd` 加点标记在 app.css 里从来没有样式 ⇒ 加点字当普通字印出来。
   和上面三道同一地位：红了就是"印出来会出丑"（卷面缺「加点」这个条件，题就做不了）。 */
const dotGate = tryJson('_着重号门禁.mjs', ['门禁', '--json']);
H('着重号门禁', dotGate.code === 0,
  dotGate.json ? `带标记 ${(dotGate.json.stats || {}).withMarks || 0} 张，阻断 ${(dotGate.json.stats || {}).block || 0}${(dotGate.json.style || {}).ok ? '' : '，样式缺失'}` : lastLine(dotGate.out));

const ev = tryJson('_待确认.mjs', ['证据', '--json']);
H('待办证据图门禁', ev.code === 0, ev.json ? `未确认 ${ev.json.open || 0} 条｜缺图 ${(ev.json.missing || []).length} / 通配符 ${(ev.json.wildcard || []).length} / 失效 ${(ev.json.broken || []).length}` : lastLine(ev.out));

const wording = tryJson('_待确认.mjs', ['措辞', '--json']);
H('待办措辞门禁（人话）', wording.code === 0, wording.json ? `命中黑话的未确认项 ${(wording.json.dirty || []).length} 条（词表 ${Object.keys(wording.json.terms || {}).length} 条）` : lastLine(wording.out));

const pen = tryJson('_笔形.mjs', ['门禁', '--json']);
H('笔形库门禁', pen.code === 0, pen.json ? `样本缺失 ${(pen.json.noSample || []).length}（有知识无图，非故障）` : lastLine(pen.out));

/* 契约门禁：各 --json 的外部形状（防"信封被当字典"类静默失效复发）
   ★ 2026-10-23：测试在 <仓库>\tests，不在工具目录。找不到就显式跳过（跳过必须可见），
   绝不用"路径不存在"冒充"跑过了"。 */
const contract = TESTS_DIR
  ? runTool(path.join(TESTS_DIR, 'gates-contract.mjs'), ['--selftest'])
  : { code: 0, out: '（发布包不含 tests\\，本项跳过）', err: '' };
H('门禁契约（--json 形状）', contract.code === 0, lastLine(contract.out));

/* 安全写底座自检：原子写 + 拒绝"形状不对当空库" + 写前备份（BUG-01/02 的防复发） */
const safe = TESTS_DIR
  ? runTool(path.join(TESTS_DIR, 'safe-write.test.mjs'))
  : { code: 0, out: '（发布包不含 tests\\，本项跳过）', err: '' };
H('安全写底座自检', safe.code === 0, lastLine(safe.out));

/* 首页/状态包产物健康：占位符零残留 + 新鲜度 */
const HOME = path.join(ROOT, '首页.html');
const STATE = path.join(ROOT, '_状态.json');
if (fs.existsSync(HOME)) {
  const h = fs.readFileSync(HOME, 'utf8');
  const leftover = (h.match(/__[A-Z][A-Z0-9_]*__/g) || []);
  /* ⚠ 报**字节数**（文件大小），与生成器那行 "generated: … NNNN bytes" 同口径。
     别用 h.length——那是 UTF-16 码元数，中文页面比字节数小 ~16%（我 2026-10-10 因此误判成
     "有人用降级版重生成了一份更小的首页"，白查一轮）。 */
  H('首页占位符零残留', leftover.length === 0, leftover.length ? '残留 ' + [...new Set(leftover)].slice(0, 5).join(',') + '（前端会 JS 报错→白屏）' : `${fs.statSync(HOME).size} 字节`);
} else H('首页.html 存在', false, '还没有生成过');

let stateAge = null;
if (fs.existsSync(STATE)) {
  let st = null;
  try { st = readJsonStrict(STATE, { label: '_状态.json' }); } catch (e) { H('_状态.json 合法 JSON', false, e.message); }
  if (st) {
    STATE_OBJ = st;
    H('_状态.json 合法 JSON', true);
    stateAge = Date.now() - fs.statSync(STATE).mtimeMs;
    P('_状态.json 新鲜度 < 24h', stateAge < 24 * 3600 * 1000, (stateAge / 3600000).toFixed(1) + ' 小时前');
  }
} else H('_状态.json 存在', false, '还没有生成过');

/* 数据源健康：_生成首页.ps1 写进 _状态.json 的 dataHealth（BUG-03）——
   非 ok = 某个门禁现在处于"读不到就放行"的状态，等于瞎了，必须硬红。
   ⚠ 2026-10-12 修（审计 BUG-01）：本块原先写在**解析 _状态.json 之前**，
      而它读的是 `STATE_OBJ`（当时仍为 null）⇒ 两个分支都不进、**一次都不调用 H()**，
      即"数据源健康"这项硬门禁从建成那天起就没有存在过（实测输出里根本没有这一项）。
      教训同 I-011 记的那类：判据引用了一个"还没被赋值"的变量，看起来在把关、实际是空跑。
      现在挪到解析之后，并给"状态包压根没读到"补一条显式硬红。 */
if (STATE_OBJ) {
  if (STATE_OBJ.dataHealth) {
    const bad = Object.entries(STATE_OBJ.dataHealth).filter(([, v]) => v !== 'ok');
    H('数据源健康（dataHealth）', bad.length === 0, bad.length ? bad.map(([k, v]) => `${k}: ${v}`).join(' ｜ ') : JSON.stringify(STATE_OBJ.dataHealth));
  } else H('数据源健康（dataHealth）', false, '状态包缺 dataHealth 字段——生成器没带健康台账（重跑 node _生成首页.ps1）');
} else H('数据源健康（dataHealth）', false, '读不到 _状态.json（缺失或不是合法 JSON）——本项判定不了，按红处理');

/* 方案文档完整性：U+FFFD 是**真腐损**（读坏了才出现），必须为 0 */
const PLAN = path.join(ROOT, '错题本系统方案.md');
if (fs.existsSync(PLAN)) {
  const t = fs.readFileSync(PLAN, 'utf8');
  const n = (t.match(/\uFFFD/g) || []).length;
  H('方案文档无 U+FFFD 腐损', n === 0, n ? `${n} 处（读坏了，需按上下文补回）` : '0 处');
}

/* ============ B. 进度门禁（可为红，属工作量） ============ */
const blind = tryJson('_盲解复核.mjs', ['门禁', '--json']);
if (blind.json) {
  const cards = blind.json.cards || {};
  const vals = Object.values(cards);
  const okN = vals.filter(v => v === '有效').length;
  const stale = vals.filter(v => v === '待重盲解').length;
  const other = vals.length - okN - stale;
  P('盲解准入（在册全过）', blind.code === 0, `门禁 exit ${blind.code}｜有效 ${okN} / 共 ${vals.length}` + (stale ? ` ⚠ 题干改过待重盲解 ${stale}` : '') + (other ? ` ｜未过 ${other}` : ''));
  if (stale) { /* 待重盲解是最该马上处理的一类：结论已失效却被当成"已通过" */ I('待重盲解（题干改过没重做）', cards ? Object.entries(cards).filter(([, v]) => v === '待重盲解').map(([k]) => k).slice(0, 8).join(',') : ''); }
  if (blind.json.problems && blind.json.problems.length) I('盲解门禁点名', blind.json.problems.slice(0, 6).join(' | '));
} else P('盲解准入 100%', false, '取不到 --json：' + (blind.parseError || lastLine(blind.out)));

const pending = tryJson('_待确认.mjs', ['门禁', '--json']);
if (pending.json) {
  P('待确认台账清空', (pending.json.open || 0) === 0, `未确认 ${pending.json.open || 0} 条（问孩子 ${(pending.json.byAsk || {}).孩子 || 0} / 问老师 ${(pending.json.byAsk || {}).老师 || 0} / 回原卷 ${(pending.json.byAsk || {}).原卷 || 0} / 系统 ${(pending.json.byAsk || {}).系统 || 0}）`);
  const q = pending.json.noQref, b = pending.json.noBox;
  P('待办题号/红框齐备', !q && !b, `缺题号 ${q ?? '?'} / 缺红框 ${b ?? '?'}`);
}

const close = tryJson('_闭环稽核.mjs', ['--json']);
if (close.json && close.json.summary) {
  const s = close.json.summary;
  P('待办五段闭环无 RED', (s.red || 0) === 0, `共 ${s.total} 条：闭环 ${s.green || 0} / RED ${s.red || 0} / 待外部 ${s.blocked || 0}`);
}

/* ============ D. 空真检查（2026-10-11 新增，审计点名的口径问题） ============
   一道门禁"没有发现违反"有两种截然不同的原因：①真检查了、没问题；②**根本没有被检查的对象**。
   后者报"通过"是在制造虚假的安心感（审计原话：空真不得报通过）。
   本仓实测：复习记录 0 条、组卷批次 0 批 ⇒ 所有"复习/到期/掌握/反复错"类指标全是空真。 */
try {
  const idxAll = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (/^(_|\.)/.test(e.name)) continue; walk(p); }
      else if (e.name === '_索引.json') idxAll.push(p);
    }
  })(ROOT);
  let cardsN = 0, withRev = 0, dueN = 0, masteredN = 0;
  for (const f of idxAll) {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const rows = [];
    if (Array.isArray(j.items)) rows.push(...j.items);
    if (j.subjects) for (const v of Object.values(j.subjects)) rows.push(...(v.items || []));
    for (const it of rows) {
      cardsN++;
      if (Array.isArray(it.reviews) && it.reviews.length) withRev++;
      if (it.nextDue) dueN++;
      if (it.reviewStatus === '已掌握' || (it.passStreak | 0) >= 2) masteredN++;
    }
  }
  const led = JSON.parse(fs.readFileSync(path.join(ROOT, '_组卷台账.json'), 'utf8'));
  const batches = (led.batches || []).length;
  I('空真检查（有对象才算"通过"）', `卡片 ${cardsN} 张｜有复习记录 ${withRev} 张｜有到期日 ${dueN} 张｜已掌握 ${masteredN} 张｜组卷批次 ${batches} 批`);
  if (withRev === 0 && batches === 0 && cardsN > 0) {
    P('复习闭环已跑过（有对象）', false,
      `${cardsN} 张卡一次都没被重做过（复习记录 0、组卷批次 0）⇒ 所有"复习/到期/掌握/反复错"类指标都是**空真**；`
      + `它们显示的任何"通过 / 100% / 全绿"都不代表健康，只代表没数据。下一步：先真正做一次「组卷 → 打印 → 做 → 回录」。`);
  } else {
    P('复习闭环已跑过（有对象）', true, `复习记录 ${withRev} 张 / 组卷批次 ${batches} 批`);
  }
} catch (e) { I('空真检查', '读不到：' + e.message); }

/* ============ C. 台账健康（孤儿 / 覆盖率 / 快照债务） ============ */
try {
  const lanes = JSON.parse(fs.readFileSync(path.join(ROOT, '_盲解双路.json'), 'utf8')).lanes || {};
  const idxKeys = new Set();
  const idxFiles = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (/^(_|\.)/.test(e.name)) continue; walk(p); }
      else if (e.name === '_索引.json') idxFiles.push(p);
    }
  })(ROOT);
  for (const f of idxFiles) {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (Array.isArray(j.items)) for (const it of j.items) idxKeys.add(j.student + '|' + it.id);
    if (j.subjects) for (const v of Object.values(j.subjects)) for (const it of (v.items || [])) idxKeys.add(j.student + '|' + it.id);
  }
  const orphan = Object.keys(lanes).filter(k => !idxKeys.has(k));
  I('盲解台账', `${Object.keys(lanes).length} 键 / 索引在册 ${idxKeys.size} 张` + (orphan.length ? `；孤儿 ${orphan.length}：${orphan.slice(0, 6).join(',')}（撤卡后未清理，只增不删属预期，量大了要归档）` : ''));
  const overruled = Object.values(lanes).filter(l => ['lane1', 'lane2'].some(n => l[n] && l[n].overruled)).length;
  const conflictLanes = Object.values(lanes).flatMap(l => ['lane1', 'lane2'].filter(n => l[n] && l[n].verdict === '不一致').map(n => l[n]));
  if (conflictLanes.length) {
    I('双路互证质量', `判「不一致」的路线 ${conflictLanes.length} 条，其中被 Lead 裁定为解题者自误(overruled) ${conflictLanes.filter(x => x.overruled).length} 条` +
      (conflictLanes.filter(x => x.overruled).length / conflictLanes.length > 0.5 ? ' ⚠ overrule 占比过半：双路互证有退化成"单路+可无限否决"的嫌疑，裁定依据要留可复算证据' : ''));
  }
} catch (e) { I('盲解台账', '读不到：' + e.message); }

try {
  const lg = JSON.parse(fs.readFileSync(path.join(ROOT, '_原卷台账.json'), 'utf8'));
  const cs = Object.values(lg.cards || {});
  const located = cs.filter(c => c.page).length;
  const boxed = cs.filter(c => c.box).length;
  P('红框覆盖率（111 张历史欠账）', boxed >= located, `整页 ${located} 张 / 有红框 ${boxed} 张 / 待补 ${located - boxed} 张`);
} catch (e) { I('原卷台账', '读不到：' + e.message); }

/* 数据快照债务：DEVELOPMENT §2 的规矩有没有在跑 */
try {
  const DATA = ['*_索引.json', '_待确认.json', '_组卷台账.json', '_配图台账.json', '_原卷台账.json', '_盲解双路.json', '_笔形台账.json', '*错题记录.md', '*题干.html'];
  const st = execFileSync('git', ['-C', ROOT, 'status', '--porcelain', '--', ...DATA], { encoding: 'utf8', maxBuffer: 64e6 });
  const dirty = st.split(/\r?\n/).filter(Boolean).length;
  const log = execFileSync('git', ['-C', ROOT, 'log', '--format=%h %ad %s', '--date=short', '--grep=^data:'], { encoding: 'utf8', maxBuffer: 64e6 }).trim();
  const n = log ? log.split(/\r?\n/).length : 0;
  P('数据快照在跑（_快照.mjs）', n > 0 && dirty === 0, `历史 data: 提交 ${n} 条；当前未快照的数据文件 ${dirty} 个` + (n === 0 ? ' ← 规矩（DEVELOPMENT §2）从未真正执行过，跑 node _快照.mjs "事由" 补上' : ''));
} catch (e) { I('数据快照', 'git 不可用：' + e.message); }

/* ============ 输出 ============ */
const hardBad = hard.filter(x => !x.ok);
const result = { ok: hardBad.length === 0, hard, progress, info, hardBad: hardBad.length, progressBad: progress.filter(x => !x.ok).length };
if (JSON_OUT) { console.log(JSON.stringify(result, null, 1)); process.exit(hardBad.length ? 1 : 0); }

if (!QUIET) {
  console.log('══════ 错题本体检（只读）══════\n');
  console.log('【硬门禁】红了就是系统有病');
  for (const x of hard) console.log(`  ${x.ok ? '✔' : '✖'} ${x.name.padEnd(22)} ${x.detail}`);
  console.log('\n【进度】红了是还有活没干完，不是故障');
  for (const x of progress) console.log(`  ${x.ok ? '✔' : '○'} ${x.name.padEnd(22)} ${x.detail}`);
  if (info.length) { console.log('\n【台账】'); for (const x of info) console.log(`  · ${x.name}：${x.detail}`); }
  console.log('\n──────────────────────────────');
  console.log(hardBad.length ? `✖ 硬门禁 ${hardBad.length} 项未过：${hardBad.map(x => x.name).join('、')}` : `✔ 硬门禁全绿（进度未达标 ${result.progressBad} 项，属工作量）`);
}
process.exit(hardBad.length ? 1 : 0);
