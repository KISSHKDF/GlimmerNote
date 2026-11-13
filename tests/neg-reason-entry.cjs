#!/usr/bin/env node
/* 阴性对照（2026-11-03 · 批次 3 / T2）：家长纠正「记录原因」入口
 *
 * 守四件事，每件都配「掏掉判据必须红」的阴性对照（**真跑变异体**，不是嘴上说）：
 *   ① 两份 KINDS 逐字相等：`src\tools\_待确认.mjs` 的 `KINDS` 与 `src\app\js\model.js` 的 `M.KINDS`
 *      是**同一事实的两份拷贝**。只改一份的后果是「界面选得到的类型，提交时被工具拒」——
 *      典型静默失效（本轮实测：全仓 0 处一致性断言）。阴性对照 M6：只去掉一份的新增项 ⇒ 必须不等。
 *   ② `纠因` 的写入契约：append-only 写 `corrections[]`（元素恒为 {at,why,scope,target}）、
 *      旧字段一字未动、同 why 幂等且**不写盘**、条目不存在 / --why 空 ⇒ exit 2 且原因可归因、
 *      `corrections` 形状异常时**响亮拒绝**（不许"当成空表"覆盖历史留痕 —— BUG-02 那一族）。
 *   ③ 既有全部子命令**对拍**：用 `git show <基线>:src/tools/_待确认.mjs` 取真旧实现放临时树，
 *      与工作区新实现跑**同一串输入**，逐步比 退出码 + stdout + stderr，收尾比 `_待确认.json` 字节。
 *   ④ 界面提示（pending.js 的 paD 上方那行）在不在、在不在**上方**。
 *
 * 数据纪律：全程只写 `%TEMP%\gn-testlib-*`（`_测试环境.cjs` 已登记前缀 ⇒ 退出即清、被杀后下轮清扫），
 *   `--data`/`CTB_DATA` 一律显式指向自建临时库；**不碰用户真库**，也不改仓库里任何文件。
 * 运行：node tests\neg-reason-entry.cjs        （不进 run.mjs；由 Lead 统一登记）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, execFileSync } = require('child_process');
const E = require('./_测试环境.cjs');

const REPO = E.REPO;
const TOOL_REL = 'src/tools/_待确认.mjs';
const MODEL_REL = 'src/app/js/model.js';
const PENDING_REL = 'src/app/js/views/pending.js';
const NEW_TOOL = E.tool('_待确认.mjs');

/* 对拍基线：本批（2026.11.09.02 变式 Phase 1）开工时的 HEAD。用**指纹钉住**取回来的旧实现——
   否则「git 里那个对象换了/取错了」会让对拍变成"对着别的东西比"，而屏幕上看不出。
   ★ 基线推进史：d5e9aef（批次 3 开工）→ 069e5a2（.01「应做动作唯一真源 + 处置准入闸」落地后）。
     .01 对 _待确认.mjs 的有意变更没有推进基线，基线红 7 条欠账（2026-11-09 发版门禁实跑发现）；
     本批开工一并清账，对拍从此钉在 .01 后的既定行为上。 */
const OLD_COMMIT = '069e5a2';
const OLD_SHA256 = 'a0f7cafc8deae6fdca2dcc85ab63e75d57c0565af0370ed4dc6e7b4874be1d26';

/* 夹具根：前缀 gn-testlib- 已在 `_测试环境.cjs` 的 TMP_PREFIXES 里登记（不新增前缀 = 不新增清扫面）。 */
const BASE = E.allocTempDir('gn-testlib-');
const MUT_DIR = path.join(BASE, 'mut-tools');
const OLD_DIR = path.join(BASE, 'old-tools');

let pass = 0, fail = 0, skips = 0;
const A = (label, ok, detail) => {
  if (ok) { pass++; console.log('  [OK]   ' + label + (detail ? '  → ' + detail : '')); }
  else { fail++; console.log('  [FAIL] ' + label + (detail ? '  → ' + detail : '')); }
};
const firstLine = s => String(s || '').split(/\r?\n/).filter(Boolean)[0] || '';
const rd = rel => fs.readFileSync(path.join(REPO, rel), 'utf8');
const read = p => fs.readFileSync(p, 'utf8');

/* ══════════════════════════════════════════════════════════════════════
   跑工具：一律显式 CTB_DATA（否则工具会去猜库根 → 在开发区里硬失败，或更糟）
   CTB_TXN_DIR：把跨进程写锁/事务留档收进本次夹具根（默认落在 %TEMP% 根下，会留下每库一个空目录）
   ══════════════════════════════════════════════════════════════════════ */
function runTool(toolAbs, libDir, args) {
  const env = Object.assign({}, process.env, { CTB_DATA: libDir, CTB_TXN_DIR: path.join(BASE, 'txn') });
  delete env.CTB_LOCK_TOKEN;                 // 子进程各自取锁（同一库不会被并发写）
  const r = spawnSync(process.execPath, [toolAbs, ...args], {
    encoding: 'utf8', maxBuffer: 64e6, env, cwd: REPO, windowsHide: true,
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}
/* 已知环境差异只归一化两处：① 两边各自的临时库根路径；② 行尾。其余一律逐字节比。 */
function norm(t, libDir) {
  let s = String(t || '').replace(/\r\n/g, '\n');
  for (const v of [libDir, libDir.replace(/\\/g, '/'), libDir.replace(/\//g, '\\')]) {
    if (v) s = s.split(v).join('<LIB>');
  }
  /* 已知差异④（2026-11-09 有意变更）：清单「系统维护」行的生成器指令从已退役的
     `_生成首页.ps1` 改为 `node 生成状态.mjs` —— 两边归一成 <GENCMD>，专断言见下方④。
     连带：「已刷新 N 字符」的计数随该行长度变化，一并归一。 */
  s = s.split('`node _生成队列.mjs` + `_生成首页.ps1`').join('<GENCMD>');
  s = s.split('`node _生成队列.mjs` + `node 生成状态.mjs`').join('<GENCMD>');
  s = s.replace(/_待确认清单\.md 已刷新：\d+ 字符/g, '_待确认清单.md 已刷新：<N> 字符');
  return s;
}
function firstDiff(a, b) {
  const la = a.split('\n'), lb = b.split('\n');
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) return '第' + (i + 1) + '行 旧=' + JSON.stringify(String(la[i]).slice(0, 80)) + ' 新=' + JSON.stringify(String(lb[i]).slice(0, 80));
  }
  return '';
}

/* ── 造一份"够用"的台账：每条都踩一个分支（黑话/未确认/已办结/已作废/无卡）── */
function seedDoc() {
  const item = o => Object.assign({
    id: 'T000', student: '学生A', subject: '数学', cardId: 'p42-10', source: '第3次作业',
    qRef: '第 10 题（p42）', box: null, kind: '笔迹归属', askWho: '孩子',
    question: '第42页第10题，「3x+1」这个答案是你自己写的吗？', detail: '',
    raisedAt: '2026-10-01', status: '未确认', answer: '', resolvedAt: '', evidence: '',
  }, o);
  return {
    note: '待确认台账',
    seq: 5,
    items: [
      /* T001 故意带内部黑话（答案键/判卷）⇒ `措辞` 门禁走"未确认命中 ⇒ 退出码 1"分支 */
      item({ id: 'T001', detail: '放大原卷看像后改（判卷口径见答案键）' }),
      item({ id: 'T002', kind: '错因口述', question: '第42页第11题，你当时是因为什么选的「B」？', detail: '孩子说记不清了' }),
      item({ id: 'T003', kind: '系统维护', askWho: '系统', cardId: '（未入卡）', qRef: '', question: '生成队列里有一条重复条目。' }),
      item({ id: 'T004', status: '已确认', answer: '孩子答：是我自己写的', resolvedAt: '2026-10-02', verdict: '错', verdictNote: '回原卷放大看笔形一致', disposition: '无需处置' }),
      item({ id: 'T005', status: '已作废', answer: '题目已撤', resolvedAt: '2026-10-03' }),
    ],
  };
}
function seedLib(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '_待确认.json'), JSON.stringify(seedDoc(), null, 2) + '\n', 'utf8');
  return dir;
}
const ledgerPath = dir => path.join(dir, '_待确认.json');
const rawLedger = dir => fs.readFileSync(ledgerPath(dir));
const jsonLedger = dir => JSON.parse(read(ledgerPath(dir)).replace(/^\uFEFF/, ''));
const itemOf = (dir, id) => (jsonLedger(dir).items || []).find(x => x.id === id);
/* 摘掉 corrections 后的字节（用来证明"旧字段一字未动"：其余部分必须与改前**逐字节**相同） */
function stripCorrections(buf) {
  const j = JSON.parse(buf.toString('utf8').replace(/^\uFEFF/, ''));
  for (const it of (j.items || [])) delete it.corrections;
  return Buffer.from(JSON.stringify(j, null, 2) + '\n', 'utf8');
}

const TOOL_SRC = rd(TOOL_REL);
const MODEL_SRC = rd(MODEL_REL);
const PENDING_SRC = rd(PENDING_REL);

/* ══════════════════════════════════════════════════════════════════════
   §0 两份 KINDS 逐字相等（机读断言）
   ══════════════════════════════════════════════════════════════════════ */
function extractKinds(src, re, label) {
  const hits = src.match(new RegExp(re.source, 'g')) || [];
  if (hits.length !== 1) return { ok: false, why: `${label} 里 KINDS 字面量命中 ${hits.length} 处（期望 1）—— 检索根失效，判据等于没生效` };
  const raw = re.exec(src)[1];
  let arr;
  try { arr = JSON.parse(raw.replace(/'/g, '"')); }
  catch (e) { return { ok: false, why: `${label} 里的 KINDS 字面量不是可解析的字符串数组：${e.message}` }; }
  if (!Array.isArray(arr) || !arr.length || arr.some(x => typeof x !== 'string')) return { ok: false, why: `${label} 里解析出的不是非空字符串数组` };
  return { ok: true, raw, arr };
}
const TOOL_KINDS_RE = /const KINDS\s*=\s*(\[[^\]\n]*\]);/;
const MODEL_KINDS_RE = /M\.KINDS\s*=\s*(\[[^\]\n]*\]);/;

console.log('═══ §0 两份 KINDS 逐字相等（工具侧 vs 界面侧）═══');
const kt = extractKinds(TOOL_SRC, TOOL_KINDS_RE, TOOL_REL);
const km = extractKinds(MODEL_SRC, MODEL_KINDS_RE, MODEL_REL);
A('两份 KINDS 都能被机读到（检索根有效）', kt.ok && km.ok, kt.ok ? '' : kt.why + ' / ' + (km.ok ? '' : km.why));
A('★ 两份 KINDS 字面量逐字相等', !!(kt.ok && km.ok && kt.raw === km.raw), kt.raw + '  ||  ' + km.raw);
A('两份都含本批新增项「经验线索」', !!(kt.ok && km.ok && kt.arr.includes('经验线索') && km.arr.includes('经验线索')));
A('列表非退化（≥7 项、无重复项）', !!(kt.ok && kt.arr.length >= 7 && new Set(kt.arr).size === kt.arr.length), kt.ok ? kt.arr.length + ' 项' : '');

/* ══════════════════════════════════════════════════════════════════════
   §1 界面提示：paD（说明）输入框**上方**那一行
   ══════════════════════════════════════════════════════════════════════ */
console.log('\n═══ §1 pending.js：「为什么纠正」提示行在 paD 上方 ═══');
const HINT_KEY = '如果是你对某道题';
const HINT_NEEDLES = ['如果是你对某道题', '某条方法的纠正', '<b>为什么</b>', '类型选「经验线索」', '公开草稿'];
const paQIdx = PENDING_SRC.indexOf('id="paQ"');
const hintIdx = PENDING_SRC.indexOf(HINT_KEY);
const paDIdx = PENDING_SRC.indexOf('id="paD"');
A('提示行存在', hintIdx >= 0);
for (const n of HINT_NEEDLES) A('  提示含「' + n + '」', PENDING_SRC.includes(n));
A('★ 提示在 paD 输入框**上方**（且在同一张表单里，paQ 与 paD 之间）',
  paQIdx >= 0 && paDIdx > paQIdx && hintIdx > paQIdx && hintIdx < paDIdx,
  'paQ@' + paQIdx + ' hint@' + hintIdx + ' paD@' + paDIdx);

/* 阴性对照：掏掉那行提示 ⇒ 上面两条判据必须红（判据有牙齿） */
const HINT_LINE_RE = /^[ \t]*'<div class="small muted">如果是你对某道题[^\n]*\n/m;
const pendingNoHint = PENDING_SRC.replace(HINT_LINE_RE, '');
A('★ §1 阴性对照：掏掉提示行后，"提示存在 + 在 paD 上方"两条判据都会红',
  pendingNoHint !== PENDING_SRC && pendingNoHint.indexOf(HINT_KEY) < 0
  && !(pendingNoHint.indexOf(HINT_KEY) >= 0 && pendingNoHint.indexOf(HINT_KEY) < pendingNoHint.indexOf('id="paD"')));

/* ══════════════════════════════════════════════════════════════════════
   §2 `纠因` 的写入契约（真跑 CLI + 真读 JSON）
   ══════════════════════════════════════════════════════════════════════ */
console.log('\n═══ §2 `纠因`：append-only / 幂等 / exit 2 / 形状守卫 ═══');
const LJ = path.join(BASE, 'lib-reason');
const W1 = '第11题的标准答案印错了，孩子没错';
const W2 = '这条方法在我们家不适用：他还没学负数';

/* 2.0 §2.1-3 的既定入口：加 --kind 经验线索（不新增 flag） */
seedLib(LJ);
let r = runTool(NEW_TOOL, LJ, ['加', '--student', '学生A', '--subject', '数学', '--card', 'p07-3',
  '--kind', '经验线索', '--ask', '孩子', '--q', '第7页第3题，「A」是你自己选的吗？',
  '--detail', '这条是方法纠正的原话', '--qref', '第 3 题（p07）', '--date', '2026-11-03']);
A('§2.1-3 既定入口：加 --kind 经验线索 被写入校验接受（exit 0）', r.code === 0, 'exit=' + r.code + ' ' + firstLine(r.err));
const addedIt = (jsonLedger(LJ).items || []).find(x => x.kind === '经验线索');
A('  落库条目 kind=经验线索、原话在 detail', !!addedIt && addedIt.detail === '这条是方法纠正的原话',
  addedIt ? addedIt.kind + ' / ' + addedIt.detail : 'missing');

/* 2.1 追加一条：字段形状 + 旧字段一字未动 */
seedLib(LJ);
const before1 = rawLedger(LJ);
r = runTool(NEW_TOOL, LJ, ['纠因', '--id', 'T002', '--why', W1, '--scope', '卡', '--target', 'p42-11', '--date', '2026-11-03']);
A('纠因 exit 0', r.code === 0, 'exit=' + r.code + ' ' + firstLine(r.err));
const c1 = (itemOf(LJ, 'T002') || {}).corrections;
A('★ corrections 元素字段形状逐字为 {at, why, scope, target}',
  Array.isArray(c1) && c1.length === 1 && JSON.stringify(Object.keys(c1[0])) === JSON.stringify(['at', 'why', 'scope', 'target']),
  JSON.stringify(c1));
A('  at=--date 落的值、why=原话、scope/target 原样',
  !!c1 && c1[0].at === '2026-11-03' && c1[0].why === W1 && c1[0].scope === '卡' && c1[0].target === 'p42-11',
  c1 ? JSON.stringify(c1[0]) : 'missing');
A('★ 旧字段一字未动（摘掉 corrections 后与改前逐字节相同）', stripCorrections(rawLedger(LJ)).equals(before1),
  stripCorrections(rawLedger(LJ)).length + 'B vs ' + before1.length + 'B');
A('  写盘留有备份（_备份-真源\_待确认-*.json）',
  (() => { const d = path.join(LJ, '_备份-真源'); try { return fs.readdirSync(d).some(n => /^_待确认-.*\.json$/.test(n)); } catch { return false; } })(),
  (() => { try { return fs.readdirSync(path.join(LJ, '_备份-真源')).join(','); } catch { return '(无备份目录)'; } })());

/* 2.2 同 why 幂等：条数不变 + **一个字节都不写** */
const before2 = rawLedger(LJ);
r = runTool(NEW_TOOL, LJ, ['纠因', '--id', 'T002', '--why', W1, '--scope', '卡', '--target', 'p42-11', '--date', '2026-11-03']);
A('同 why 重复提交 exit 0', r.code === 0, 'exit=' + r.code);
A('★ 幂等：corrections 仍是 1 条', ((itemOf(LJ, 'T002') || {}).corrections || []).length === 1,
  JSON.stringify((itemOf(LJ, 'T002') || {}).corrections));
A('★ 幂等路径不写盘（台账逐字节未变）', rawLedger(LJ).equals(before2), rawLedger(LJ).length + 'B');
A('  stdout 明说"未重复追加"（不静默）', /未重复追加/.test(r.out), firstLine(r.out));

/* 2.3 append-only：换一条 why 再追加，顺序与内容都对；省略 --scope 时默认「卡」、target 空串 */
r = runTool(NEW_TOOL, LJ, ['纠因', '--id', 'T002', '--why', W2, '--date', '2026-11-03']);
const c2 = (itemOf(LJ, 'T002') || {}).corrections || [];
A('★ append-only：两条且顺序为 [先, 后]（不是覆盖）',
  c2.length === 2 && c2[0].why === W1 && c2[1].why === W2, JSON.stringify(c2.map(x => x.why)));
A('  省略 --scope/--target 时的默认形状：scope=卡、target=""',
  c2.length === 2 && c2[1].scope === '卡' && c2[1].target === '' && JSON.stringify(Object.keys(c2[1])) === JSON.stringify(['at', 'why', 'scope', 'target']),
  c2.length === 2 ? JSON.stringify(c2[1]) : 'missing');
A('  第一条仍在册（旧留痕没被顶掉）', c2.length === 2 && JSON.stringify(c2[0]) === JSON.stringify({ at: '2026-11-03', why: W1, scope: '卡', target: 'p42-11' }));

/* 2.4 已办结条目也能记（纠正是对"那道题/那条方法"，与办结状态无关） */
r = runTool(NEW_TOOL, LJ, ['纠因', '--id', 'T005', '--why', '这道题其实孩子做对了', '--date', '2026-11-03']);
A('已作废条目上同样可记（exit 0）', r.code === 0 && ((itemOf(LJ, 'T005') || {}).corrections || []).length === 1, 'exit=' + r.code);

/* 2.5 拒绝路径：条目不存在 / --why 空 / 缺 --id / scope 非法 —— 全部 exit 2 且不写盘 */
const cases = [
  { label: '条目不存在', args: ['纠因', '--id', 'T999', '--why', 'x'], need: /找不到 T999/ },
  { label: '--why 空串', args: ['纠因', '--id', 'T002', '--why', ''], need: /--why/ },
  { label: '--why 全空白', args: ['纠因', '--id', 'T002', '--why', '   '], need: /--why/ },
  { label: '缺 --why', args: ['纠因', '--id', 'T002'], need: /--why/ },
  { label: '缺 --id', args: ['纠因', '--why', 'x'], need: /--id/ },
  { label: 'scope 非法', args: ['纠因', '--id', 'T002', '--why', 'x', '--scope', '随便'], need: /scope/ },
];
for (const c of cases) {
  const b = rawLedger(LJ);
  const rr = runTool(NEW_TOOL, LJ, c.args);
  A(`拒绝路径：${c.label} ⇒ exit 2`, rr.code === 2, 'exit=' + rr.code + ' ' + firstLine(rr.err));
  A(`  原因可归因（stderr 点到关键参数）${c.label}`, c.need.test(rr.err), firstLine(rr.err).slice(0, 90));
  A(`  拒收路径不写盘：${c.label}`, rawLedger(LJ).equals(b), rawLedger(LJ).length + 'B');
}

/* 2.6 形状守卫：corrections 读不懂 ⇒ 响亮拒绝，绝不"当成空表"覆盖（BUG-02 那一族） */
seedLib(LJ);
{
  const j = jsonLedger(LJ);
  j.items.find(x => x.id === 'T002').corrections = { value: [] };      // PowerShell 往返的产物形态
  fs.writeFileSync(ledgerPath(LJ), JSON.stringify(j, null, 2) + '\n', 'utf8');
}
const beforeWeird = rawLedger(LJ);
r = runTool(NEW_TOOL, LJ, ['纠因', '--id', 'T002', '--why', '形状异常时的新理由']);
A('★ corrections 不是数组 ⇒ exit 2（响亮拒绝）', r.code === 2, 'exit=' + r.code + ' ' + firstLine(r.err));
A('  点名了原因（corrections 不是数组）', /corrections 不是数组/.test(r.err), firstLine(r.err).slice(0, 90));
A('★ 形状异常时台账逐字节未动（没有把留痕当空表覆盖）', rawLedger(LJ).equals(beforeWeird), rawLedger(LJ).length + 'B');

/* 2.7 好数据不受影响：改前能读的条目，形状守卫不许误伤 */
seedLib(LJ);
r = runTool(NEW_TOOL, LJ, ['纠因', '--id', 'T002', '--why', '正常理由', '--scope', '流程', '--date', '2026-11-03']);
A('反向：正常条目不被形状守卫误伤（exit 0、scope=流程）',
  r.code === 0 && JSON.stringify(((itemOf(LJ, 'T002') || {}).corrections || [])[0]) ===
  JSON.stringify({ at: '2026-11-03', why: '正常理由', scope: '流程', target: '' }),
  'exit=' + r.code + ' ' + JSON.stringify(((itemOf(LJ, 'T002') || {}).corrections || [])[0]));

/* ══════════════════════════════════════════════════════════════════════
   §3 既有子命令对拍：真旧实现（git show 基线） vs 工作区新实现
   ══════════════════════════════════════════════════════════════════════ */
console.log('\n═══ §3 既有子命令对拍（旧实现 vs 新实现，同输入同输出）═══');
let OLD_SRC = null, oldSkip = '', oldHard = '';
try {
  const buf = execFileSync('git', ['show', OLD_COMMIT + ':' + TOOL_REL], { cwd: REPO, maxBuffer: 64e6, stdio: ['ignore', 'pipe', 'pipe'] });
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  if (sha !== OLD_SHA256) {
    oldHard = `git 里 ${OLD_COMMIT}:${TOOL_REL} 的 sha256 = ${sha}，与钉住的 ${OLD_SHA256} 不符 —— 对拍基线漂了，拒绝"对着别的东西比"`;
  } else OLD_SRC = buf.toString('utf8');
} catch (e) {
  oldSkip = '取不到对拍基线（git 不可用 / 无该提交）：' + firstLine(e.message);
}
if (oldHard) A('对拍基线指纹（必须与开工时 HEAD 的字节一致）', false, oldHard);
if (!OLD_SRC) {
  console.log('  [SKIP] §3 既有子命令对拍 —— ' + (oldSkip || oldHard));
  skips++;
} else {
  /* 旧实现放临时树：连同**相对 import 的传递闭包**一起搬（唯一实现见 _测试环境.cjs 的 copyToolDeps） */
  E.copyToolDeps(['_待确认.mjs'], OLD_DIR);
  fs.writeFileSync(path.join(OLD_DIR, '_待确认.mjs'), OLD_SRC, 'utf8');
  const OLD_TOOL = path.join(OLD_DIR, '_待确认.mjs');
  const OLD_LIB = seedLib(path.join(BASE, 'lib-old'));
  const NEW_LIB = seedLib(path.join(BASE, 'lib-new'));
  /* 同步包（两边共用同一份只读输入）：一条已办结 ⇒ 走"跳过"分支，一条不存在 ⇒ 走"未找到"分支 */
  const PKG = path.join(BASE, 'ctb-pending-neg.json');
  fs.writeFileSync(PKG, JSON.stringify({
    exportedAt: '2026-11-03T10:00:00+08:00', tool: 'ctb-homepage-pending',
    resolves: [{ id: 'T004', action: '答', answer: '再来一条' }, { id: 'T999', action: '作废', answer: '不存在' }],
  }), 'utf8');

  const parity = (label, args) => {
    const a = runTool(OLD_TOOL, OLD_LIB, args);
    const b = runTool(NEW_TOOL, NEW_LIB, args);
    const ao = norm(a.out, OLD_LIB), bo = norm(b.out, NEW_LIB);
    const ae = norm(a.err, OLD_LIB), be = norm(b.err, NEW_LIB);
    const ok = a.code === b.code && ao === bo && ae === be;
    A('对拍 ' + label + '（退出码 + stdout + stderr 逐字节）', ok,
      ok ? 'exit=' + a.code : ('exit ' + a.code + '≠' + b.code + ' | ' + firstDiff(ao, bo) + ' | stderr: ' + firstDiff(ae, be)));
    return ok;
  };

  /* 一遍走完整条命令链（含会写盘的），逐步对拍；两个库都真的被同样地改。 */
  parity('状态', ['状态']);
  parity('状态 --student', ['状态', '--student', '学生A']);
  parity('门禁 --json', ['门禁', '--json']);
  parity('门禁（人类模式，应为 exit 1）', ['门禁']);
  parity('措辞 --json', ['措辞', '--json']);
  parity('措辞（未确认含黑话，应为 exit 1）', ['措辞']);
  parity('问法 --json', ['问法', '--json']);
  parity('问法', ['问法']);
  parity('定位（覆盖率）', ['定位']);
  parity('清单（渲染 _待确认清单.md）', ['清单']);
  parity('对位', ['对位']);
  parity('证据', ['证据']);
  parity('证据 --json', ['证据', '--json']);
  parity('加（含题号自动推导与缺图/缺框喊话）', ['加', '--student', '学生B', '--subject', '化学', '--card', 'p07-3',
    '--kind', '错因口述', '--ask', '孩子', '--q', '第7页第3题，「A」是你自己选的吗？',
    '--detail', '卷面看不出', '--qref', '第 3 题（p07）', '--date', '2026-11-03']);
  parity('定位 --id --qref', ['定位', '--id', 'T004', '--qref', '第 8 题（p42）']);
  parity('定位 --auto --dry', ['定位', '--auto', '--dry']);
  parity('答', ['答', '--id', 'T001', '--answer', '孩子答：是我自己写的', '--date', '2026-11-03']);
  parity('判定', ['判定', '--id', 'T001', '--verdict', '错', '--note', '回原卷放大看：笔形与上一题一致', '--date', '2026-11-03']);
  parity('处置', ['处置', '--id', 'T001', '--as', '无需处置', '--note', '确认在册库无该卡', '--date', '2026-11-03']);
  parity('撤回', ['撤回', '--id', 'T001']);
  parity('作废', ['作废', '--id', 'T002', '--answer', '题目已被撤走', '--date', '2026-11-03']);
  parity('删（未确认且无答案）', ['删', '--id', 'T003']);
  parity('改问题', ['改问题', '--id', 'T005', '--q', '第42页第10题，「3x+1」这个答案是你自己写的吗？', '--note', '补全问句']);
  parity('改详情', ['改详情', '--id', 'T005', '--detail', '放大原卷后确认是后改的', '--note', '换成人话']);
  parity('去黑话 --dry（不写盘）', ['去黑话', '--dry']);
  parity('同步（跳过 + 未找到两条分支）', ['同步', '--file', PKG, '--date', '2026-11-03']);
  parity('门禁 --json（收尾态）', ['门禁', '--json']);
  parity('清单（收尾态）', ['清单']);

  /* 收尾判据：两个库的**台账字节完全相同** —— 比"每步 stdout 相同"更硬（数据效果也一致） */
  A('★ 对拍收尾：两库 _待确认.json 逐字节相同',
    rawLedger(OLD_LIB).equals(rawLedger(NEW_LIB)),
    rawLedger(OLD_LIB).length + 'B vs ' + rawLedger(NEW_LIB).length + 'B');
  const mdNorm = p => {
    try {
      return read(p).replace(/_更新于 \d{4}-\d{2}-\d{2}_/g, '_更新于 <DATE>_')
        /* 已知差异④ 同款归一（见 norm 内注） */
        .split('`node _生成队列.mjs` + `_生成首页.ps1`').join('<GENCMD>')
        .split('`node _生成队列.mjs` + `node 生成状态.mjs`').join('<GENCMD>')
        .replace(/\r\n/g, '\n');
    }
    catch (e) { return '(读不出：' + e.message + ')'; }
  };
  A('★ 对拍收尾：两库 _待确认清单.md 除「_更新于 <日期>」外逐字节相同',
    mdNorm(path.join(OLD_LIB, '_待确认清单.md')) === mdNorm(path.join(NEW_LIB, '_待确认清单.md')),
    firstDiff(mdNorm(path.join(OLD_LIB, '_待确认清单.md')), mdNorm(path.join(NEW_LIB, '_待确认清单.md'))));

  /* ── 原先这里的"已知差异①②③"是批次 3→4 时代的增量（经验线索 尚不在旧基线 KINDS 里）。
     2026-11-09 基线推进到 069e5a2（.01 落地后）：「经验线索」两侧都在，那三处差异不复存在——
     原断言集体改写为"两侧逐字一致"的同强度判据（宁可对拍变严，不许对着历史差异放水）。
     唯一保留的有意差异 = 已知差异④（系统维护行的生成器指令，见下方专断言）。 ── */
  const badArgs = ['加', '--student', '学生D', '--q', '第1页第1题，「A」是你自己选的吗？', '--kind', '不存在的类型'];
  const ba = runTool(OLD_TOOL, OLD_LIB, badArgs), bb = runTool(NEW_TOOL, NEW_LIB, badArgs);
  const bea = norm(ba.err, OLD_LIB), beb = norm(bb.err, NEW_LIB);
  A('加 --kind 非法：两边都 exit 2（行为不变）', ba.code === 2 && bb.code === 2, ba.code + '/' + bb.code);
  A('★ 逐字节相同（基线推进后「经验线索」已在两侧 KINDS 里）', bea === beb,
    '旧=' + firstLine(bea) + ' ｜ 新=' + firstLine(beb));

  const ua = runTool(OLD_TOOL, OLD_LIB, ['不存在的动作']), ub = runTool(NEW_TOOL, NEW_LIB, ['不存在的动作']);
  const uea = norm(ua.err, OLD_LIB), ueb = norm(ub.err, NEW_LIB);
  /* ★ 2026-11-03（批次 4 集成时修正）：这条判据原先写死"只多出 `纠因` 一个成员 + 一行用法提示"
     （`uebCleaned === uea`）。批次 4 往同一份"可用列表"里又加了 `候选/修订/采用/作废候选`，
     于是**逐字节相等**这条就假红了 —— 而它真正要守的是另一件事：
       "**除帮助列表与用法提示之外**，输出一字不差；且列表只增不减"。
     改成结构判据（对**后续批次继续加子命令**免疫，但对"删掉老命令"和"改到别的行"仍然有牙齿）：
       ⓐ 只允许差异出现在「可用：…」那一行与 "  <命令> …" 的用法提示行；
       ⓑ 可用列表里旧的那串必须**逐个**在新列表里（只增不减）；
       ⓒ 旧实现里根本没有这些新命令名（证明"新增"是真的新增，不是改口径）。 */
  const availLine = (t) => (t.split('\n').find(l => /可用：/.test(l)) || '');
  const namesIn = (t) => availLine(t).replace(/^.*可用：/, '').split('/').map(s => s.trim()).filter(Boolean);
  const usageLines = (t) => t.split('\n').filter(l => /^\s{2,}\S+\s+--/.test(l));
  const restSame = (a, b) => {
    const strip = (t) => t.split('\n').filter(l => !/可用：/.test(l) && !/^\s{2,}\S+\s+--/.test(l)).join('\n');
    const kept = usageLines(a).every(l => usageLines(b).some(x => x.replace(/\s+/g, ' ') === l.replace(/\s+/g, ' ')));
    return kept && strip(a) === strip(b);
  };
  const oldNames = namesIn(uea), newNames = namesIn(ueb);
  A('未知动作：两边都 exit 2（行为不变）', ua.code === 2 && ub.code === 2, ua.code + '/' + ub.code);
  A('★ 可用列表与用法提示两侧一致（"只增不减"口径保留，此刻应零差异）',
    oldNames.filter(n => !newNames.includes(n)).length === 0 &&
    restSame(uea, ueb),
    '旧 ' + oldNames.length + ' 项 → 新 ' + newNames.length + ' 项　缺失=[' +
      oldNames.filter(n => !newNames.includes(n)).join(',') + ']　其余行差异=' + (restSame(uea, ueb) ? '无' : firstDiff(uea, ueb)));

  /* ── 原"已知差异③"的退役声明：批次 4 把「经验线索」加进 KINDS，基线推进到 069e5a2 后
     它两侧都在 ⇒ 不再是差异。反向钉住：两侧对它的接受行为一致（都 exit 0 且各 +1 条）；
     收尾的"两库 _待确认.json 逐字节相同"兜住写入内容。哪天一侧开始拒收
     （KINDS 被改回 / 基线取错），这里先红。 ── */
  const reasonAddArgs = ['加', '--student', '学生C', '--card', 'p09-1', '--kind', '经验线索', '--ask', '孩子',
    '--q', '第9页第1题，「C」是你自己选的吗？', '--date', '2026-11-03'];
  const cntOf = dir => (jsonLedger(dir).items || []).length;
  const kOld0 = cntOf(OLD_LIB), kNew0 = cntOf(NEW_LIB);
  A('  两库条数相同（入场前）', kOld0 === kNew0, '旧 ' + kOld0 + ' / 新 ' + kNew0);
  const ka = runTool(OLD_TOOL, OLD_LIB, reasonAddArgs), kb = runTool(NEW_TOOL, NEW_LIB, reasonAddArgs);
  A('加 --kind 经验线索：两侧一致接受（都 exit 0 且各 +1 条）',
    ka.code === 0 && kb.code === 0 && cntOf(OLD_LIB) === kOld0 + 1 && cntOf(NEW_LIB) === kNew0 + 1,
    'exit ' + ka.code + '/' + kb.code + '　条数 ' + kOld0 + '→' + cntOf(OLD_LIB) + ' / ' + kNew0 + '→' + cntOf(NEW_LIB));

  /* ── 已知差异④（2026-11-09）：清单「系统维护」行的生成器指令 —— 有意变更，只许差这一行 ──
     `_生成首页.ps1`（PowerShell 生成器）已退役删除，继续指示"重跑它"会指路指到不存在的文件；
     新实现改指 `node 生成状态.mjs`。stdout/stderr 与收尾 mdNorm 已把两边归一成 <GENCMD>；
     这里反向钉住"差异确实存在且只在这一行"——归一若把别的差异也吞掉，这条就是唯一的实锤。 */
  {
    const oldMd = read(path.join(OLD_LIB, '_待确认清单.md'));
    const newMd = read(path.join(NEW_LIB, '_待确认清单.md'));
    const lineOf = (t, re) => (t.split(/\r?\n/).find(l => re.test(l)) || '');
    const ol = lineOf(oldMd, /系统维护/), nl = lineOf(newMd, /系统维护/);
    A('已知差异④（清单系统维护行）：旧=已退役 _生成首页.ps1、新=node 生成状态.mjs',
      /_生成首页\.ps1/.test(ol) && /node 生成状态\.mjs/.test(nl),
      '旧=' + ol.slice(0, 60) + ' ｜ 新=' + nl.slice(0, 60));
  }
}

/* ══════════════════════════════════════════════════════════════════════
   §4 变异体阴性对照（掏掉判据必须红 —— 真跑，不是嘴上说）
   ══════════════════════════════════════════════════════════════════════ */
console.log('\n═══ §4 变异体阴性对照（掏掉判据必须红）═══');
E.copyToolDeps(['_待确认.mjs'], MUT_DIR);
const MUT_TOOL = path.join(MUT_DIR, '_待确认.mjs');
function mkMutant(from, to) {
  const n = TOOL_SRC.split(from).length - 1;
  if (n !== 1) return { ok: false, why: `变异锚点命中 ${n} 处（期望 1）—— 变异体没生成，判据会假绿` };
  fs.writeFileSync(MUT_TOOL, TOOL_SRC.replace(from, to), 'utf8');
  return { ok: true, why: '' };
}
const mutLib = name => seedLib(path.join(BASE, name));
const reasonsOf = (dir, id) => (((itemOf(dir, id) || {}).corrections) || []).map(c => c.why);

/* M1：掏掉"同 why 幂等"判据 */
{
  const q = mkMutant('  const dup = list.find(c => c && String(c.why) === why);', '  const dup = null;   /* 变异体 M1：掏掉同 why 幂等判据 */');
  A('M1 变异生效（锚点唯一命中）', q.ok, q.why);
  if (q.ok) {
    const lib = mutLib('mut-lib-1');
    runTool(MUT_TOOL, lib, ['纠因', '--id', 'T002', '--why', '同一条理由', '--date', '2026-11-03']);
    runTool(MUT_TOOL, lib, ['纠因', '--id', 'T002', '--why', '同一条理由', '--date', '2026-11-03']);
    const n = reasonsOf(lib, 'T002').length;
    A('★ M1 阴性对照：掏掉幂等判据后同 why 变成 2 条 ⇒ §2.2「仍是 1 条」这条判据有牙齿', n === 2, '变异体实测 ' + n + ' 条');
  }
}
/* M2：把"追加"改成"整份替换" */
{
  const q = mkMutant('  list.push({ at: opt.date || today(), why, scope, target });',
    '  it.corrections = [{ at: opt.date || today(), why, scope, target }];   /* 变异体 M2：整份替换而非追加 */');
  A('M2 变异生效（锚点唯一命中）', q.ok, q.why);
  if (q.ok) {
    const lib = mutLib('mut-lib-2');
    runTool(MUT_TOOL, lib, ['纠因', '--id', 'T002', '--why', '第一条理由', '--date', '2026-11-03']);
    runTool(MUT_TOOL, lib, ['纠因', '--id', 'T002', '--why', '第二条理由', '--date', '2026-11-03']);
    const ws = reasonsOf(lib, 'T002');
    A('★ M2 阴性对照：整份替换后只剩最后一条 ⇒ §2.3「两条且顺序正确」这条判据有牙齿',
      ws.length === 1 && ws[0] === '第二条理由', '变异体实测 ' + JSON.stringify(ws));
  }
}
/* M3：掏掉"--why 空 ⇒ 拒绝" */
{
  const q = mkMutant("  if (!why) { console.error('缺参数：--why 必填（把家长/用户的原话写进来，不要空着）'); process.exit(2); }",
    "  if (false && !why) { console.error('变异体 M3：掏掉空 why 拒绝'); }");
  A('M3 变异生效（锚点唯一命中）', q.ok, q.why);
  if (q.ok) {
    const lib = mutLib('mut-lib-3');
    const rr = runTool(MUT_TOOL, lib, ['纠因', '--id', 'T002', '--why', '']);
    A('★ M3 阴性对照：掏掉空 why 拒绝后 exit 0 且记进空理由 ⇒ §2.5「空 why ⇒ exit 2」有牙齿',
      rr.code === 0 && reasonsOf(lib, 'T002').join('') === '', '变异体 exit=' + rr.code + ' corrections=' + JSON.stringify(reasonsOf(lib, 'T002')));
  }
}
/* M4：掏掉"条目不存在 ⇒ 拒绝" */
{
  const q = mkMutant('（纠正原因要挂在已存在的待办上：先「加」一条，再「纠因」）`); process.exit(2);',
    '（变异体 M4：掏掉条目存在性拒绝）`); /* exit 掏掉 */');
  A('M4 变异生效（锚点唯一命中）', q.ok, q.why);
  if (q.ok) {
    const lib = mutLib('mut-lib-4');
    const rr = runTool(MUT_TOOL, lib, ['纠因', '--id', 'T999', '--why', 'x']);
    A('★ M4 阴性对照：掏掉存在性拒绝后不是 exit 2（直接崩） ⇒ §2.5「不存在 ⇒ exit 2」有牙齿',
      rr.code !== 2, '变异体 exit=' + rr.code + ' ' + firstLine(rr.err).slice(0, 70));
  }
}
/* M5：让 纠因 顺手改旧字段 */
{
  const anchor = "  const why = String(opt.why == null ? '' : opt.why).trim();";
  const q = mkMutant(anchor, "  it.question = String(it.question || '') + '（变异体 M5 改写的旧字段）';\n" + anchor);
  A('M5 变异生效（锚点唯一命中）', q.ok, q.why);
  if (q.ok) {
    const lib = mutLib('mut-lib-5');
    const before = (itemOf(lib, 'T002') || {}).question;
    runTool(MUT_TOOL, lib, ['纠因', '--id', 'T002', '--why', '随便一条理由', '--date', '2026-11-03']);
    const after = (itemOf(lib, 'T002') || {}).question;
    A('★ M5 阴性对照：变异体会改到旧字段 ⇒ §2.1「旧字段一字未动」这条判据有牙齿',
      after !== before && /变异体 M5/.test(String(after)), '改前=' + String(before).slice(0, 30) + ' 改后=' + String(after).slice(0, 40));
  }
}
/* M6：两份 KINDS 只改一份 */
{
  const TOOL_MUT = TOOL_SRC.replace(", '经验线索'", '');
  const MODEL_MUT = MODEL_SRC.replace(", '经验线索'", '');
  A('M6 变异生效（两份源码里 `, \'经验线索\'` 各恰好一处）',
    TOOL_SRC.split(", '经验线索'").length - 1 === 1 && MODEL_SRC.split(", '经验线索'").length - 1 === 1
    && TOOL_MUT !== TOOL_SRC && MODEL_MUT !== MODEL_SRC);
  const a1 = extractKinds(TOOL_MUT, TOOL_KINDS_RE, TOOL_REL + '（变异体）');
  const b1 = extractKinds(MODEL_SRC, MODEL_KINDS_RE, MODEL_REL);
  A('★ M6 阴性对照：只去掉工具侧的新增项 ⇒ 两份不相等（§0 判据有牙齿）',
    a1.ok && b1.ok && a1.raw !== b1.raw, (a1.raw || '') + '  ||  ' + (b1.raw || ''));
  const a2 = extractKinds(TOOL_SRC, TOOL_KINDS_RE, TOOL_REL);
  const b2 = extractKinds(MODEL_MUT, MODEL_KINDS_RE, MODEL_REL + '（变异体）');
  A('★ M6 反向：只去掉界面侧的新增项 ⇒ 两份也不相等',
    a2.ok && b2.ok && a2.raw !== b2.raw, (a2.raw || '') + '  ||  ' + (b2.raw || ''));
}

console.log('\nRESULT=' + (fail ? 'FAIL(' + fail + ')' : 'PASS') + ' 断言=' + (pass + fail) + (skips ? ' SKIP=' + skips : ''));
process.exit(fail ? 1 : 0);
