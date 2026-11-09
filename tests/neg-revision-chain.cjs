#!/usr/bin/env node
/* 阴性对照（2026-11-03 · 批次 4 / W-A）：候选修订 + 正式写入入口 + 修订链（`_待确认.mjs`）
 *
 * 守六件事，每件都配「掏掉判据必须红」的阴性对照（**真跑变异体**，不是嘴上说）：
 *   ① 候选：稳定 ID（c-<sha256(kind|target|payloadDigest) 前12位>）与**幂等**（同内容复用、不新增、不写盘）；
 *   ② 修订：**只读**（一个字节都不写）+ `--json` 形状（候选/修订链/现值 presence）；
 *   ③ 采用：`--dry` 一个字节都不写；成功 ⇒ `_修订\…\<candId>.md` + 追加 `revisions[]` + 候选状态翻转，
 *      且**旧字段一字未动**；重复采用幂等；候选不存在/状态不对 ⇒ exit 3；越界坐标 / 缺页 / 重复导入 ⇒ exit 1 且原因具体；
 *   ④ 事务：**中途失败 ⇒ 库逐字节不变**（构造法：把落点目录 `_修订` 变成一个文件 ⇒ 事务第二个写失败）；
 *   ⑤ 兼容：既有全部子命令与**真旧实现（不可变提交 6df511a）逐字节对拍**（只归一化临时库路径与行尾）；
 *   ⑥ 文档两处都提（`docs\录题任务契约.md` 的行为契约 + `docs\过程文件规范.md` 的字段/目录枚举）——
 *      只写一处 ⇒ 本用例判红。
 *
 * 数据纪律：全程只写 `%TEMP%\gn-testlib-*`（前缀已在 `tests\_测试环境.cjs` 的 `TMP_PREFIXES` 里登记
 *   ⇒ 退出即清、被杀后下轮清扫；**不新增前缀 = 不新增清扫面**）；库一律显式 `CTB_DATA` 指向自建临时库；
 *   跨进程写锁/事务留档用 `CTB_TXN_DIR` 收进本次夹具根；**不碰用户真库**，也不改仓库里任何文件。
 * 运行：node tests\neg-revision-chain.cjs        （不进 run.mjs；由 Lead 统一登记）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, execFileSync } = require('child_process');
const E = require('./_测试环境.cjs');

const REPO = E.REPO;
const TOOL_REL = 'src/tools/_待确认.mjs';
const NEW_TOOL = E.tool('_待确认.mjs');

/* 对拍基线：批次 4 开工时的 HEAD（不可变提交）。用**指纹钉住**取回来的旧实现——
   否则「git 里那个对象换了/取错了」会让对拍变成"对着别的东西比"，而屏幕上看不出。 */
const OLD_COMMIT = '069e5a2';
const OLD_SHA256 = 'a0f7cafc8deae6fdca2dcc85ab63e75d57c0565af0370ed4dc6e7b4874be1d26';

const BASE = E.allocTempDir('gn-testlib-');
const MUT_DIR = path.join(BASE, 'mut-tools');
const OLD_DIR = path.join(BASE, 'old-tools');
const TXN_DIR = path.join(BASE, 'txn');

let pass = 0, fail = 0, skips = 0;
const A = (label, ok, detail) => {
  if (ok) { pass++; console.log('  [OK]   ' + label + (detail ? '  → ' + detail : '')); }
  else { fail++; console.log('  [FAIL] ' + label + (detail ? '  → ' + detail : '')); }
};
const firstLine = s => String(s || '').split(/\r?\n/).filter(Boolean)[0] || '';
/* 证据要能看：从 stderr 里挑出**命中那条判据**的那一行（不是只回显第一行） */
const lineWith = (s, re) => (String(s || '').split(/\r?\n/).find(l => re.test(l)) || firstLine(s)).trim();
const rd = rel => fs.readFileSync(path.join(REPO, rel), 'utf8');
const read = p => fs.readFileSync(p, 'utf8');
const sha256 = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const lfOf = s => String(s == null ? '' : s).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');

function runTool(toolAbs, libDir, args) {
  const env = Object.assign({}, process.env, { CTB_DATA: libDir, CTB_TXN_DIR: TXN_DIR });
  delete env.CTB_LOCK_TOKEN;                 // 子进程各自取锁（同一库不会被并发写）
  const r = spawnSync(process.execPath, [toolAbs, ...args], {
    encoding: 'utf8', maxBuffer: 64e6, env, cwd: REPO, windowsHide: true,
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}
/* 已知环境差异只归一化两处：① 两边各自的临时库根路径；② 行尾。其余一律逐字节比。
   ★ 2026-11-09 增补（已知差异·清单系统维护行）：`_生成首页.ps1`（PowerShell 生成器）已退役删除，
   「系统维护」行的生成器指令有意改指 `node 生成状态.mjs`（连带"已刷新 N 字符"计数）——
   两边归一成 <GENCMD>/<N>，专断言见对拍收尾后。 */
function norm(t, libDir) {
  let s = String(t || '').replace(/\r\n/g, '\n');
  for (const v of [libDir, libDir.replace(/\\/g, '/'), libDir.replace(/\//g, '\\')]) if (v) s = s.split(v).join('<LIB>');
  s = s.split('`node _生成队列.mjs` + `_生成首页.ps1`').join('<GENCMD>');
  s = s.split('`node _生成队列.mjs` + `node 生成状态.mjs`').join('<GENCMD>');
  s = s.replace(/_待确认清单\.md 已刷新：\d+ 字符/g, '_待确认清单.md 已刷新：<N> 字符');
  return s;
}
function firstDiff(a, b) {
  const la = a.split('\n'), lb = b.split('\n');
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) return '第' + (i + 1) + '行 旧=' + JSON.stringify(String(la[i]).slice(0, 90)) + ' 新=' + JSON.stringify(String(lb[i]).slice(0, 90));
  }
  return '';
}

/* ══════════════════════════════════════════════════════════════════════
   夹具：一份"够用"的库（卡目录 + 页码映射 + 原图对象 + 五种状态的条目）
   ══════════════════════════════════════════════════════════════════════ */
const PAGESHA = 'b'.repeat(64);
const SCAN = '九年级-学生甲/数学/原卷/整页.jpg';
const SCAN_UNMAPPED = '九年级-学生甲/数学/原卷/未登记页.jpg';

function seedDoc() {
  const item = o => Object.assign({
    id: 'T000', student: '学生甲', subject: '数学', cardId: 'P0012', source: '第3次作业',
    qRef: '第 3 题（p42）', box: null, kind: '口径确认', askWho: '孩子',
    question: '第42页第3题，「A」是你自己选的吗？', detail: '', raisedAt: '2026-11-01',
    status: '未确认', answer: '', resolvedAt: '', evidence: '',
  }, o);
  return {
    note: '待确认台账', seq: 5,
    items: [
      item({ id: 'T001' }),
      item({ id: 'T002', kind: '错因口述', cardId: '（未入卡）', qRef: '' }),
      item({ id: 'T003', kind: '系统维护', askWho: '系统', cardId: '（未入卡）', qRef: '', question: '库里有一条重复条目。' }),
      item({ id: 'T004', status: '已确认', answer: '孩子答：是我自己写的', resolvedAt: '2026-11-02', verdict: '错', verdictNote: '回原卷放大看笔形一致', disposition: '无需处置' }),
      item({ id: 'T005', status: '已作废', answer: '题目已撤', resolvedAt: '2026-11-03' }),
    ],
  };
}
function seedLib(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, '九年级-学生甲', '数学', 'P0012-示例卡'), { recursive: true });
  fs.mkdirSync(path.join(dir, '九年级-学生甲', '数学', '原卷'), { recursive: true });
  fs.mkdirSync(path.join(dir, '_原图', PAGESHA.slice(0, 2)), { recursive: true });
  fs.writeFileSync(path.join(dir, '_原图', PAGESHA.slice(0, 2), PAGESHA + '.jpg'), 'fake-jpeg-bytes');
  fs.writeFileSync(path.join(dir, '九年级-学生甲', '数学', '原卷', '整页.jpg'), 'fake-page-bytes');
  fs.writeFileSync(path.join(dir, '九年级-学生甲', '数学', '原卷', '未登记页.jpg'), 'fake-page-bytes-2');
  fs.writeFileSync(path.join(dir, '_页码映射.json'), JSON.stringify({ en: { [SCAN]: 42 }, chem: {} }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, '九年级-学生甲', '数学', '_索引.json'), JSON.stringify({
    student: '学生甲', grade: '九年级', subject: '数学',
    items: [{ id: 'P0012', dir: 'P0012-示例卡', question: '合成题' }],
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, '九年级-学生甲', '数学', 'P0012-示例卡', '错题记录.md'),
    '# 现值（卡正文）\n\n这是家长自己写的内容：第3题按苏科版判。\n');
  fs.writeFileSync(path.join(dir, '_待确认.json'), JSON.stringify(seedDoc(), null, 2) + '\n', 'utf8');
  return dir;
}
const ledgerPath = dir => path.join(dir, '_待确认.json');
const rawLedger = dir => fs.readFileSync(ledgerPath(dir));
const jsonLedger = dir => JSON.parse(read(ledgerPath(dir)).replace(/^\uFEFF/, ''));
const itemOf = (dir, id) => (jsonLedger(dir).items || []).find(x => x.id === id);
const candsOf = (dir, id) => ((itemOf(dir, id) || {}).candidates) || [];
const revsOf = (dir, id) => ((itemOf(dir, id) || {}).revisions) || [];
const candByNeedle = (dir, id, needle) => candsOf(dir, id).find(c => typeof c.payload === 'string' && c.payload.includes(needle)) || null;
const revFile = (dir, rel) => path.join(dir, ...String(rel).split('/'));

/* 库内文件树快照（相对路径 → sha256）。skipBak：跳过 `_备份-真源\`（② 显式备份，
   由 `_安全写.mjs` 在**写前**留档、按既有语义不参与回滚——口径写在下面的断言说明里）。 */
function treeSnap(dir, skipBak) {
  const out = new Map();
  const walk = (p, rel) => {
    let ents = [];
    try { ents = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (skipBak && r === '_备份-真源') continue;
      const abs = path.join(p, e.name);
      if (e.isDirectory()) walk(abs, r);
      else out.set(r, sha256(fs.readFileSync(abs)));
    }
  };
  walk(dir, '');
  return out;
}
function diffSnap(a, b) {
  const keys = new Set([...a.keys(), ...b.keys()]);
  const d = [];
  for (const k of keys) if (a.get(k) !== b.get(k)) d.push(k + (a.has(k) ? (b.has(k) ? '(内容变了)' : '(被删)') : '(新增)'));
  return d;
}

const TOOL_SRC = rd(TOOL_REL);

console.log('测试环境：' + E.describe());
console.log('夹具根：' + BASE);

/* ══════════════════════════════════════════════════════════════════════
   §0 文档两处都提（行为契约 + 字段/目录枚举）—— 只写一处必须红
   ══════════════════════════════════════════════════════════════════════ */
console.log('\n═══ §0 文档：候选与修订链在两处都提到 ═══');
const DOC_A_REL = 'docs/录题任务契约.md';       // 行为契约（子命令/退出码/判据/形状）
const DOC_B_REL = 'docs/过程文件规范.md';       // 字段与目录枚举（真源）
const DOC_A = rd(DOC_A_REL), DOC_B = rd(DOC_B_REL);
const DOC_TOKENS = ['candidates', 'revisions', '_修订'];
const bothDocsMention = (a, b) => DOC_TOKENS.every(t => a.includes(t) && b.includes(t));
A('★ 两处都提到 ' + DOC_TOKENS.join(' / '), bothDocsMention(DOC_A, DOC_B),
  DOC_TOKENS.map(t => t + ':' + (DOC_A.includes(t) ? 'A' : '-') + (DOC_B.includes(t) ? 'B' : '-')).join(' '));
A('  ' + DOC_A_REL + ' 有「候选与修订链」一节（行为契约）', /^## 八、候选与修订链/m.test(DOC_A));
A('  该节含子命令表与退出码（3 / exit 1 / exit 3）', /`作废候选/.test(DOC_A) && /退出码/.test(DOC_A) && /exit 1/.test(DOC_A) && /exit 3/.test(DOC_A));
A('  ' + DOC_B_REL + ' 有字段枚举（candidates[]/revisions[] 行）', /`candidates\[\]`/.test(DOC_B) && /`revisions\[\]`/.test(DOC_B));
A('  ' + DOC_B_REL + ' 把 `_修订\\` 登记进 ① 真源（表格行 + 专节）', /`_修订\\`/.test(DOC_B) && /## 七、`_修订\\`/.test(DOC_B));
/* 阴性对照（内存里掏掉整段，再喂给同一个判据函数——同 neg-contrib-templates.cjs 的口径）：
   只写一处 ⇒ `bothDocsMention` 必须为假，证明上面这条判据有牙齿。 */
const cutA = s => s.replace(/^## 八、候选与修订链[\s\S]*$/m, '');
const cutB = s => s.replace(/^## 六、`_待确认\.json`[\s\S]*$/m, '');
A('★ M7 阴性对照：只写「录题任务契约」一处（掏掉 §八 整段）⇒ 判据为假',
  cutA(DOC_A) !== DOC_A && !bothDocsMention(cutA(DOC_A), DOC_B));
A('★ M7 反向：只写「过程文件规范」一处（掏掉 §六/§七 整段）⇒ 判据为假',
  cutB(DOC_B) !== DOC_B && !bothDocsMention(DOC_A, cutB(DOC_B)));
A('  两处的新增段确实都是**可整段掏掉**的（锚点没漂）', cutA(DOC_A).length < DOC_A.length && cutB(DOC_B).length < DOC_B.length,
  'A ' + DOC_A.length + '→' + cutA(DOC_A).length + '　B ' + DOC_B.length + '→' + cutB(DOC_B).length);

/* ══════════════════════════════════════════════════════════════════════
   §1 `候选`：稳定 ID / 幂等 / 形状 / 拒绝路径
   ══════════════════════════════════════════════════════════════════════ */
console.log('\n═══ §1 `候选`：稳定 ID 与幂等 ═══');
const L1 = seedLib(path.join(BASE, 'lib-cand'));
const P_TEXT = '把第42页第3题的判罚口径改成「按苏科版」';
let r = runTool(NEW_TOOL, L1, ['候选', '--id', 'T001', '--kind', '卡', '--target', 'P0012', '--payload', P_TEXT, '--date', '2026-11-03']);
A('候选 exit 0', r.code === 0, 'exit=' + r.code + ' ' + firstLine(r.err));
const rec1 = candsOf(L1, 'T001')[0];
A('★ 元素字段形状逐字为 {candId, at, kind, target, payload, payloadDigest, status, adoptedAt}',
  !!rec1 && JSON.stringify(Object.keys(rec1)) === JSON.stringify(['candId', 'at', 'kind', 'target', 'payload', 'payloadDigest', 'status', 'adoptedAt']),
  rec1 ? JSON.stringify(Object.keys(rec1)) : 'missing');
A('  值：payload 原文入库、status=待采用、adoptedAt=null、at=--date',
  !!rec1 && rec1.payload === P_TEXT && rec1.status === '待采用' && rec1.adoptedAt === null && rec1.at === '2026-11-03');
/* 稳定 ID 公式：不在工具里"导出"一份，而是按契约**独立复算**（判据与实现分开算） */
const expectCandId = 'c-' + sha256('卡|P0012|' + sha256(lfOf(P_TEXT))).slice(0, 12);
A('★ candId = c-<sha256(kind|target|payloadDigest) 前12位>（独立复算）', rec1 && rec1.candId === expectCandId,
  (rec1 ? rec1.candId : '') + ' vs ' + expectCandId);
A('★ payloadDigest = sha256(正文按 LF 归一)', rec1 && rec1.payloadDigest === sha256(lfOf(P_TEXT)),
  rec1 ? rec1.payloadDigest.slice(0, 16) + '…' : '');
A('  candId 形状 c- + 12 位小写 hex', !!rec1 && /^c-[0-9a-f]{12}$/.test(rec1.candId));

/* 幂等：同 kind+target+正文（换入口：字符串 ↔ 文件、LF ↔ CRLF）⇒ 复用、不新增、**不写盘** */
const b1 = rawLedger(L1);
r = runTool(NEW_TOOL, L1, ['候选', '--id', 'T001', '--kind', '卡', '--target', 'P0012', '--payload', P_TEXT]);
A('同内容重复提交 exit 0 且明说"已存在，复用"', r.code === 0 && /已存在，复用/.test(r.out), firstLine(r.out));
A('★ 幂等：candidates 仍是 1 条（没新增第二条）', candsOf(L1, 'T001').length === 1, '条数=' + candsOf(L1, 'T001').length);
A('★ 幂等路径不写盘（台账逐字节未变）', rawLedger(L1).equals(b1), rawLedger(L1).length + 'B');
const PFILE = path.join(BASE, 'payload-crlf.txt');
fs.writeFileSync(PFILE, P_TEXT.replace(/\n/g, '\r\n'), 'utf8');       // 同一正文、Windows 行尾
r = runTool(NEW_TOOL, L1, ['候选', '--id', 'T001', '--kind', '卡', '--target', 'P0012', '--payload-file', PFILE]);
A('★ 换入口（--payload-file + CRLF）⇒ 仍是同一条候选（行尾归一进摘要）',
  r.code === 0 && /已存在，复用/.test(r.out) && candsOf(L1, 'T001').length === 1, firstLine(r.out));
A('  --payload-file 路径上的正文能读进来（换 target 立刻建新的）', (() => {
  const rr = runTool(NEW_TOOL, L1, ['候选', '--id', 'T001', '--kind', '流程', '--target', '整页拆分', '--payload-file', PFILE, '--json']);
  if (rr.code !== 0) return false;
  const o = JSON.parse(rr.out.trim().split('\n').pop());
  return o.ok === true && o.candId === 'c-' + sha256('流程|整页拆分|' + sha256(lfOf(P_TEXT))).slice(0, 12);
})(), '');
A('  不同 kind/target ⇒ 不同 candId（同正文不再复用）', candsOf(L1, 'T001').length === 2, '条数=' + candsOf(L1, 'T001').length);

/* 拒绝路径：全部 exit 2 且不写盘 */
const rejCand = [
  { label: '缺 --id', args: ['候选', '--kind', '卡', '--target', 'P0012', '--payload', 'x'], need: /--id/ },
  { label: '条目不存在', args: ['候选', '--id', 'T999', '--kind', '卡', '--target', 'P0012', '--payload', 'x'], need: /找不到 T999/ },
  { label: '缺 --kind', args: ['候选', '--id', 'T001', '--target', 'P0012', '--payload', 'x'], need: /--kind/ },
  { label: 'kind 非法', args: ['候选', '--id', 'T001', '--kind', '题', '--target', 'P0012', '--payload', 'x'], need: /kind 必须是/ },
  { label: '缺 --target', args: ['候选', '--id', 'T001', '--kind', '卡', '--payload', 'x'], need: /--target/ },
  { label: 'target 是路径形态', args: ['候选', '--id', 'T001', '--kind', '卡', '--target', '九年级/数学/P0012', '--payload', 'x'], need: /路径分隔符/ },
  { label: '两个正文入口都不给', args: ['候选', '--id', 'T001', '--kind', '卡', '--target', 'P0012'], need: /--payload/ },
  { label: '两个正文入口都给（互斥）', args: ['候选', '--id', 'T001', '--kind', '卡', '--target', 'P0012', '--payload', 'x', '--payload-file', PFILE], need: /互斥/ },
  { label: '正文全是空白', args: ['候选', '--id', 'T001', '--kind', '卡', '--target', 'P0012', '--payload', '   '], need: /正文是空的/ },
  { label: '--payload-file 不是文件', args: ['候选', '--id', 'T001', '--kind', '卡', '--target', 'P0012', '--payload-file', path.join(L1, '没有这个文件.txt')], need: /不是文件|不是一个文件/ },
];
for (const c of rejCand) {
  const b = rawLedger(L1);
  const rr = runTool(NEW_TOOL, L1, c.args);
  A(`拒绝路径：${c.label} ⇒ exit 2`, rr.code === 2, 'exit=' + rr.code + ' ' + firstLine(rr.err));
  A(`  原因可归因（stderr 点到关键参数）${c.label}`, c.need.test(rr.err), firstLine(rr.err).slice(0, 90));
  A(`  拒收路径不写盘：${c.label}`, rawLedger(L1).equals(b), rawLedger(L1).length + 'B');
}
/* 形状守卫：candidates / revisions 读不懂 ⇒ exit 2 且台账一字不动（BUG-02 那一族） */
for (const f of ['candidates', 'revisions']) {
  const L = seedLib(path.join(BASE, 'lib-shape-' + f));
  const j = jsonLedger(L);
  j.items.find(x => x.id === 'T001')[f] = { value: [] };        // PowerShell 往返的产物形态
  fs.writeFileSync(ledgerPath(L), JSON.stringify(j, null, 2) + '\n', 'utf8');
  const before = rawLedger(L);
  const rr = runTool(NEW_TOOL, L, ['候选', '--id', 'T001', '--kind', '卡', '--target', 'P0012', '--payload', '正常正文']);
  A(`★ ${f} 不是数组 ⇒ 候选 exit 2（响亮拒绝）`, rr.code === 2, 'exit=' + rr.code + ' ' + firstLine(rr.err));
  A(`  点名了原因（${f} 不是数组）`, new RegExp(f + ' 不是数组').test(rr.err), firstLine(rr.err).slice(0, 90));
  A(`★ 形状异常时台账逐字节未动`, rawLedger(L).equals(before), rawLedger(L).length + 'B');
}

/* ══════════════════════════════════════════════════════════════════════
   §2 `修订`：只读 + --json 形状（候选 / 修订链 / 现值 presence）
   ══════════════════════════════════════════════════════════════════════ */
console.log('\n═══ §2 `修订`：只读 + 形状 ═══');
const L2 = seedLib(path.join(BASE, 'lib-list'));
runTool(NEW_TOOL, L2, ['候选', '--id', 'T001', '--kind', '卡', '--target', 'P0012', '--payload', P_TEXT, '--date', '2026-11-03']);
runTool(NEW_TOOL, L2, ['候选', '--id', 'T001', '--kind', '配方', '--target', 'ingest-page', '--payload', '把「先判错再拆题」改成「先拆题再判错」', '--date', '2026-11-03']);
runTool(NEW_TOOL, L2, ['候选', '--id', 'T001', '--kind', '流程', '--target', '整页拆分', '--payload', '整页拆分时先圈公共题干', '--date', '2026-11-03']);
const bL = rawLedger(L2), snapL = treeSnap(L2);
r = runTool(NEW_TOOL, L2, ['修订', '--id', 'T001', '--json']);
A('修订 --json exit 0', r.code === 0, 'exit=' + r.code + ' ' + firstLine(r.err));
const J = JSON.parse(r.out.trim().split('\n').pop());
A('★ 只读：`修订` 前后台账 + 全库文件树都逐字节未变',
  rawLedger(L2).equals(bL) && diffSnap(snapL, treeSnap(L2)).length === 0,
  '树差异=' + JSON.stringify(diffSnap(snapL, treeSnap(L2))));
A('★ 顶层形状 {ok, id, candidates, revisions, counts, targets}',
  JSON.stringify(Object.keys(J)) === JSON.stringify(['ok', 'id', 'candidates', 'revisions', 'counts', 'targets']), JSON.stringify(Object.keys(J)));
A('  counts = {candidates, pending, adopted, void, revisions}',
  JSON.stringify(Object.keys(J.counts)) === JSON.stringify(['candidates', 'pending', 'adopted', 'void', 'revisions']) && J.counts.candidates === 3 && J.counts.pending === 3 && J.counts.revisions === 0,
  JSON.stringify(J.counts));
A('★ 候选元素形状（界面消费的逐字字段）',
  JSON.stringify(Object.keys(J.candidates[0])) === JSON.stringify(['candId', 'at', 'kind', 'target', 'status', 'adoptedAt', 'payloadDigest', 'payloadLen', 'payload', 'summary', 'current', 'currentPresence', 'currentWhy', 'currentFrom', 'reason']),
  JSON.stringify(Object.keys(J.candidates[0])));
A('  payload 全文与 summary 都在（界面右栏要显示全文）',
  J.candidates[0].payload === P_TEXT && J.candidates[0].payloadLen === lfOf(P_TEXT).length && J.candidates[0].summary.length > 0,
  'len=' + J.candidates[0].payloadLen);
/* 现值：三种 kind 各自的真源与 presence */
const cCard = J.candidates.find(c => c.kind === '卡');
const cRecipe = J.candidates.find(c => c.kind === '配方');
const cFlow = J.candidates.find(c => c.kind === '流程');
A('★ kind=卡 现值 = 卡目录里的 错题记录.md 当前全文（presence=read）',
  cCard.currentPresence === 'read' && cCard.current === read(path.join(L2, '九年级-学生甲', '数学', 'P0012-示例卡', '错题记录.md')) && cCard.currentWhy === '',
  cCard.currentFrom + ' ｜ ' + String(cCard.current).length + ' 字');
A('★ kind=配方 现值 = <AppRoot>\\recipes\\<id>\\prompt.md 当前全文（presence=read）',
  cRecipe.currentPresence === 'read' && cRecipe.current === rd('src/recipes/ingest-page/prompt.md') && /recipes\/ingest-page\/prompt\.md$/.test(cRecipe.currentFrom),
  cRecipe.currentFrom + ' ｜ ' + String(cRecipe.current).length + ' 字');
A('★ kind=流程 ⇒ presence=missing + 具体原因（没有机器可读现值）',
  cFlow.currentPresence === 'missing' && cFlow.current === null && /流程类目标没有机器可读的现值/.test(cFlow.currentWhy), cFlow.currentWhy);
A('  targets 是去重后的现值表（3 个目标各一条）', J.targets.length === 3 && JSON.stringify(Object.keys(J.targets[0])) === JSON.stringify(['kind', 'target', 'currentPresence', 'currentWhy', 'currentFrom', 'current', 'adoptedCandId', 'adoptedAt']), JSON.stringify(J.targets.map(t => t.kind + '/' + t.target)));
/* 现值定位不到时必须给原因（不许静默空串）—— 用不存在的卡号造 */
const L2b = seedLib(path.join(BASE, 'lib-list-miss'));
runTool(NEW_TOOL, L2b, ['候选', '--id', 'T002', '--kind', '卡', '--target', 'P9999', '--payload', '不存在的卡也允许先提草案']);
runTool(NEW_TOOL, L2b, ['候选', '--id', 'T002', '--kind', '配方', '--target', 'no-such-recipe', '--payload', '不存在的配方']);
const Jb = JSON.parse(runTool(NEW_TOOL, L2b, ['修订', '--id', 'T002', '--json']).out.trim().split('\n').pop());
A('★ 卡定位不到 ⇒ presence=missing + 原因（current 为 null，不是空串）',
  Jb.candidates[0].currentPresence === 'missing' && Jb.candidates[0].current === null && /定位不到卡目录/.test(Jb.candidates[0].currentWhy),
  Jb.candidates[0].currentWhy);
A('★ 配方不在程序包 ⇒ presence=missing + 原因',
  Jb.candidates[1].currentPresence === 'missing' && Jb.candidates[1].current === null && /不在程序包里/.test(Jb.candidates[1].currentWhy),
  Jb.candidates[1].currentWhy);
/* 拒绝路径 */
A('修订：条目不存在 ⇒ exit 2', (() => { const rr = runTool(NEW_TOOL, L2, ['修订', '--id', 'T999']); return rr.code === 2 && /找不到 T999/.test(rr.err); })());
A('修订：缺 --id ⇒ exit 2', (() => { const rr = runTool(NEW_TOOL, L2, ['修订']); return rr.code === 2 && /--id/.test(rr.err); })());
A('修订：形状异常 ⇒ exit 2（同一守卫）', (() => {
  const L = seedLib(path.join(BASE, 'lib-list-shape'));
  const j = jsonLedger(L); j.items[0].candidates = { value: [] };
  fs.writeFileSync(ledgerPath(L), JSON.stringify(j, null, 2) + '\n');
  const before = rawLedger(L);
  const rr = runTool(NEW_TOOL, L, ['修订', '--id', 'T001', '--json']);
  return rr.code === 2 && /candidates 不是数组/.test(rr.err) && rawLedger(L).equals(before);
})());
A('人读形态也列出现值与修订链（不是只有 --json 才有）', /现值/.test(runTool(NEW_TOOL, L2, ['修订', '--id', 'T001']).out));

/* ══════════════════════════════════════════════════════════════════════
   §3 `采用`：--dry / 成功 / 幂等 / exit 3 / 三类错误
   ══════════════════════════════════════════════════════════════════════ */
console.log('\n═══ §3 `采用`：正式写入入口 ═══');
const L3 = seedLib(path.join(BASE, 'lib-adopt'));
runTool(NEW_TOOL, L3, ['候选', '--id', 'T001', '--kind', '卡', '--target', 'P0012', '--payload', P_TEXT, '--date', '2026-11-03']);
const CID = candsOf(L3, 'T001')[0].candId;
const REL = '_修订/卡/P0012/' + CID + '.md';

/* 3.1 --dry：一个字节都不写 */
const bDry = rawLedger(L3), sDry = treeSnap(L3);
r = runTool(NEW_TOOL, L3, ['采用', '--id', 'T001', '--candidate', CID, '--dry']);
A('--dry exit 0', r.code === 0, 'exit=' + r.code + ' ' + firstLine(r.err));
A('★ --dry 一个字节都不写（台账 + 全库文件树逐字节未变）',
  rawLedger(L3).equals(bDry) && diffSnap(sDry, treeSnap(L3)).length === 0, '树差异=' + JSON.stringify(diffSnap(sDry, treeSnap(L3))));
A('★ --dry 明说"一个字节都不写"并列出将写的路径', /一个字节都不写/.test(r.out) && r.out.includes(REL), firstLine(r.out));
A('  --dry 不改候选状态', candsOf(L3, 'T001')[0].status === '待采用');
A('  --dry --json 形状 {ok,id,candId,dry,idempotent,written,status,wouldSetStatus,relPath,bytes}',
  (() => {
    const rr = runTool(NEW_TOOL, L3, ['采用', '--id', 'T001', '--candidate', CID, '--dry', '--json']);
    const o = JSON.parse(rr.out.trim().split('\n').pop());
    return rr.code === 0 && JSON.stringify(Object.keys(o)) === JSON.stringify(['ok', 'id', 'candId', 'dry', 'idempotent', 'written', 'status', 'wouldSetStatus', 'relPath', 'bytes'])
      && o.dry === true && o.relPath === REL && JSON.stringify(o.written) === JSON.stringify([REL, '_待确认.json']);
  })());

/* 3.2 真写：落点 + revisions[] 追加 + 状态翻转 + 旧字段一字未动 */
const beforeFields = JSON.stringify(Object.assign({}, itemOf(L3, 'T001'), { candidates: null, revisions: null }));
const IDX = path.join(L3, '九年级-学生甲', '数学', '_索引.json');
const idxBefore = sha256(fs.readFileSync(IDX));
r = runTool(NEW_TOOL, L3, ['采用', '--id', 'T001', '--candidate', CID]);
A('采用 exit 0', r.code === 0, 'exit=' + r.code + ' ' + firstLine(r.err));
A('★ 落点已写：' + REL, fs.existsSync(revFile(L3, REL)), fs.existsSync(revFile(L3, REL)) ? fs.statSync(revFile(L3, REL)).size + 'B' : 'missing');
const revBody = fs.existsSync(revFile(L3, REL)) ? read(revFile(L3, REL)) : '';
A('  修订对象含头部元信息 + 正文原文（只增不改的留痕）',
  /^# 人工修订 c-[0-9a-f]{12}/.test(revBody) && revBody.includes('- 待办：T001') && revBody.trimEnd().endsWith(P_TEXT), firstLine(revBody));
A('★ 追加 1 条 revisions[]，形状 {at, by, candId, kind, target, written, note}',
  revsOf(L3, 'T001').length === 1 && JSON.stringify(Object.keys(revsOf(L3, 'T001')[0])) === JSON.stringify(['at', 'by', 'candId', 'kind', 'target', 'written', 'note']),
  JSON.stringify(revsOf(L3, 'T001')[0]));
const REV = revsOf(L3, 'T001')[0];
A('  revision.at 是带时区偏移的本地时间，by=人', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(REV.at) && REV.by === '人', REV.at);
A('★ revision.written = 落点 + 台账（库内相对路径）', JSON.stringify(REV.written) === JSON.stringify([REL, '_待确认.json']), JSON.stringify(REV.written));
A('★ 候选状态翻转 → 已采用，adoptedAt 落值', candsOf(L3, 'T001')[0].status === '已采用' && String(candsOf(L3, 'T001')[0].adoptedAt || '').length >= 19,
  candsOf(L3, 'T001')[0].status + ' / ' + candsOf(L3, 'T001')[0].adoptedAt);
A('★ 旧字段一字未动（候选/修订链之外的条目字段与采用前逐字相同）',
  JSON.stringify(Object.assign({}, itemOf(L3, 'T001'), { candidates: null, revisions: null })) === beforeFields);
A('★ 采用不碰 _索引.json（红线 3：answerSlots/answerMode 只能由 _作答门禁.mjs 写 —— 本命令逐字节没动索引）',
  sha256(fs.readFileSync(IDX)) === idxBefore, idxBefore.slice(0, 16) + '… → ' + sha256(fs.readFileSync(IDX)).slice(0, 16) + '…');
A('  写盘留有备份（_备份-真源\\_待确认-*.json）', (() => {
  try { return fs.readdirSync(path.join(L3, '_备份-真源')).some(n => /^_待确认-.*\.json$/.test(n)); } catch { return false; }
})());

/* 3.3 幂等：同一 candId 重复采用 ⇒ 不重复写、不重复追加 */
const bIdem = rawLedger(L3), sIdem = treeSnap(L3);
r = runTool(NEW_TOOL, L3, ['采用', '--id', 'T001', '--candidate', CID]);
A('★ 重复采用 exit 0 且明说"已采用（幂等）"', r.code === 0 && /已采用（幂等）/.test(r.out), firstLine(r.out));
A('★ 幂等：revisions 仍是 1 条、台账与落点文件逐字节未变',
  revsOf(L3, 'T001').length === 1 && rawLedger(L3).equals(bIdem) && diffSnap(sIdem, treeSnap(L3)).length === 0,
  '条数=' + revsOf(L3, 'T001').length + ' 树差异=' + JSON.stringify(diffSnap(sIdem, treeSnap(L3))));
A('  幂等 --json 带 idempotent=true',
  (() => { const rr = runTool(NEW_TOOL, L3, ['采用', '--id', 'T001', '--candidate', CID, '--json']); const o = JSON.parse(rr.out.trim().split('\n').pop()); return o.idempotent === true && o.written.length === 2; })());

/* 3.3b revisions[] 是 **append-only**：再采纳第二条 ⇒ 追加成 2 条，第一条一字未动 */
runTool(NEW_TOOL, L3, ['候选', '--id', 'T001', '--kind', '流程', '--target', '整页拆分', '--payload', '第二条修订：整页拆分时先圈公共题干']);
const CID2 = candsOf(L3, 'T001').find(c => c.kind === '流程').candId;
const rev1Before = JSON.stringify(revsOf(L3, 'T001')[0]);
r = runTool(NEW_TOOL, L3, ['采用', '--id', 'T001', '--candidate', CID2]);
A('★ 第二条候选采纳成功（append）', r.code === 0 && revsOf(L3, 'T001').length === 2, 'exit=' + r.code + ' 条数=' + revsOf(L3, 'T001').length);
A('★ revisions[] 追加式：第一条**逐字**未被改写，第二条接在后面',
  JSON.stringify(revsOf(L3, 'T001')[0]) === rev1Before && revsOf(L3, 'T001')[1].candId === CID2,
  JSON.stringify(revsOf(L3, 'T001').map(x => x.candId)));
A('  两条各自的落点文件都在（一条修订一个对象）',
  fs.existsSync(revFile(L3, REL)) && fs.existsSync(revFile(L3, '_修订/流程/整页拆分/' + CID2 + '.md')),
  REL + ' / ' + '_修订/流程/整页拆分/' + CID2 + '.md');
A('  counts：同一条目上 adopted=2（修订链按条数长）',
  (() => { const o = JSON.parse(runTool(NEW_TOOL, L3, ['修订', '--id', 'T001', '--json']).out.trim().split('\n').pop()); return o.counts.revisions === 2 && o.counts.adopted === 2; })());

/* 3.3c 台账被手改过的候选：摘要不符 / kind 非法 / target 空 ⇒ exit 1（拒绝采信，不猜） */
{
  const tamper = (mut) => {
    /* 每个变体都从**干净种子**重来：手改是就地改台账，前一个变体会污染后一个（本用例实测踩过） */
    const L = seedLib(path.join(BASE, 'lib-tamper'));
    runTool(NEW_TOOL, L, ['候选', '--id', 'T001', '--kind', '卡', '--target', 'P0012', '--payload', '原始正文']);
    const cid = candsOf(L, 'T001')[0].candId;
    const j = jsonLedger(L);
    mut(j.items.find(x => x.id === 'T001').candidates[0]);
    fs.writeFileSync(ledgerPath(L), JSON.stringify(j, null, 2) + '\n', 'utf8');
    const b = rawLedger(L), s = treeSnap(L);
    const rr = runTool(NEW_TOOL, L, ['采用', '--id', 'T001', '--candidate', cid]);
    return { rr, untouched: rawLedger(L).equals(b) && diffSnap(s, treeSnap(L)).length === 0 };
  };
  const t1 = tamper(c => { c.payload = '被手改过的正文'; });
  A('★ 手改候选正文（与记录摘要不符）⇒ exit 1 且原因可归因',
    t1.rr.code === 1 && /正文与记录里的摘要不符/.test(t1.rr.err), firstLine(t1.rr.err).slice(0, 100));
  A('  拒绝采信时库一字未动', t1.untouched);
  const t2 = tamper(c => { c.kind = '题'; });
  A('★ 手改候选 kind 为非法值 ⇒ exit 1（拒绝采信，不猜目标类型）',
    t2.rr.code === 1 && /kind 不合法/.test(t2.rr.err), firstLine(t2.rr.err).slice(0, 100));
  A('  拒绝采信时库一字未动', t2.untouched);
  const t3 = tamper(c => { c.target = ''; });
  A('★ 手改候选 target 为空 ⇒ exit 1（没有目标就没有落点）',
    t3.rr.code === 1 && /没有 target/.test(t3.rr.err), firstLine(t3.rr.err).slice(0, 100));
  A('  拒绝采信时库一字未动', t3.untouched);
  const t4 = tamper(c => { c.payload = 12345; });
  A('★ 手改候选 payload 不是字符串 ⇒ exit 1（拒绝采信）',
    t4.rr.code === 1 && /payload 不是字符串/.test(t4.rr.err), firstLine(t4.rr.err).slice(0, 100));
}

/* 3.4 候选不存在 / 状态不对 ⇒ exit 3 */const b3 = rawLedger(L3);
r = runTool(NEW_TOOL, L3, ['采用', '--id', 'T001', '--candidate', 'c-0123456789ab']);
A('★ 候选不存在 ⇒ exit 3', r.code === 3, 'exit=' + r.code + ' ' + firstLine(r.err));
A('  原因可归因（点名"候选不存在"+ 在册号码怎么看）', /候选不存在/.test(r.err) && /修订 --id/.test(r.err), firstLine(r.err).slice(0, 90));
A('  拒收路径不写盘', rawLedger(L3).equals(b3));
r = runTool(NEW_TOOL, L3, ['采用', '--id', 'T001', '--candidate', 'not-a-cand-id']);
A('★ 候选号形状不对 ⇒ exit 2（用法错，未进到查表）', r.code === 2 && /形状不对/.test(r.err), 'exit=' + r.code);
r = runTool(NEW_TOOL, L3, ['采用', '--id', 'T999', '--candidate', CID]);
A('★ 条目不存在 ⇒ exit 2', r.code === 2 && /找不到 T999/.test(r.err), 'exit=' + r.code);
r = runTool(NEW_TOOL, L3, ['采用', '--id', 'T001']);
A('★ 缺 --candidate ⇒ exit 2', r.code === 2 && /--candidate/.test(r.err), 'exit=' + r.code);

/* 3.5 已作废的候选：作废候选 exit 0；再采用 ⇒ exit 3；重复作废 ⇒ exit 3 */
const L3v = seedLib(path.join(BASE, 'lib-void'));
runTool(NEW_TOOL, L3v, ['候选', '--id', 'T001', '--kind', '卡', '--target', 'P0012', '--payload', '这条会被作废']);
const CVID = candsOf(L3v, 'T001')[0].candId;
const bv = rawLedger(L3v);
A('作废候选 exit 0 且只改 status', (() => {
  const rr = runTool(NEW_TOOL, L3v, ['作废候选', '--id', 'T001', '--candidate', CVID]);
  return rr.code === 0 && candsOf(L3v, 'T001')[0].status === '已作废';
})());
A('  作废只改 status：其余字段与作废前逐字相同（payload/candId/at 一字未动）',
  (() => {
    const now = Object.assign({}, candsOf(L3v, 'T001')[0], { status: null });
    const old = JSON.parse(bv.toString('utf8')).items[0].candidates[0];
    return JSON.stringify(now) === JSON.stringify(Object.assign({}, old, { status: null }));
  })());
A('★ 已作废的候选再「采用」⇒ exit 3（状态不对）',
  (() => { const rr = runTool(NEW_TOOL, L3v, ['采用', '--id', 'T001', '--candidate', CVID]); return rr.code === 3 && /已作废/.test(rr.err); })());
A('★ 已作废的候选再「作废候选」⇒ exit 3', (() => { const rr = runTool(NEW_TOOL, L3v, ['作废候选', '--id', 'T001', '--candidate', CVID]); return rr.code === 3; })());
A('★ 同内容重新「候选」⇒ 不新增、不改状态（候选号由内容决定）', (() => {
  const rr = runTool(NEW_TOOL, L3v, ['候选', '--id', 'T001', '--kind', '卡', '--target', 'P0012', '--payload', '这条会被作废']);
  return rr.code === 0 && candsOf(L3v, 'T001').length === 1 && candsOf(L3v, 'T001')[0].status === '已作废' && /已作废/.test(rr.out);
})());
A('★ 已采用的候选再「作废候选」⇒ exit 3（已进库的改状态撤不掉）',
  (() => { const rr = runTool(NEW_TOOL, L3, ['作废候选', '--id', 'T001', '--candidate', CID]); return rr.code === 3 && /已采用/.test(rr.err); })());

/* 3.5b 「缺页」的库内一侧：卡/配方目标定位不到 ⇒ 必须喊出来（给原因），但不阻断采纳 */
{
  const L = seedLib(path.join(BASE, 'lib-misstarget'));
  runTool(NEW_TOOL, L, ['候选', '--id', 'T002', '--kind', '卡', '--target', 'P9999', '--payload', '给一张还没建的卡先记个修订想法']);
  const cid = candsOf(L, 'T002')[0].candId;
  const rr = runTool(NEW_TOOL, L, ['采用', '--id', 'T002', '--candidate', cid, '--dry']);
  A('★ 目标卡在当前库里定位不到 ⇒ 采用**喊出**现值缺失的具体原因（缺页的库内一侧）',
    rr.code === 0 && /现值定位不到（仍按草案写入）/.test(rr.out) && /定位不到卡目录/.test(rr.out),
    lineWith(rr.out, /现值定位不到/).slice(0, 120));
  const rr2 = runTool(NEW_TOOL, L, ['采用', '--id', 'T002', '--candidate', cid]);
  A('  非阻断：仍能写入（草案可以指向还没建的目标）', rr2.code === 0 && revsOf(L, 'T002').length === 1, 'exit=' + rr2.code);
  A('  流程类目标不算异常（没有机器可读现值，本就不喊）',
    (() => {
      runTool(NEW_TOOL, L, ['候选', '--id', 'T002', '--kind', '流程', '--target', '整页拆分', '--payload', '流程类草案']);
      const rr3 = runTool(NEW_TOOL, L, ['采用', '--id', 'T002', '--candidate', candsOf(L, 'T002').slice(-1)[0].candId, '--dry']);
      return rr3.code === 0 && !/现值定位不到/.test(rr3.out);
    })());
}

/* 3.6 三类错误：越界坐标 / 缺页 / 重复导入 */
console.log('\n─── 3.6 越界坐标 / 缺页 / 重复导入 ───');
const PACKS = [
  { label: '越界坐标：regions 的 x+w>1', pack: { regions: [{ role: '错误位置', x: 0.1, y: 0.2, w: 0.95, h: 0.3 }] }, need: /越界坐标：regions\[0\]（错误位置） 超出 0~1（x=0\.1 y=0\.2 x\+w=1\.05/ },
  { label: '越界坐标：origBox 的 y+h>1', pack: { origBox: [0.1, 0.5, 0.2, 0.7] }, need: /越界坐标：origBox 超出 0~1/ },
  { label: '越界坐标：像素 box 超图（缺 imgW/imgH 不猜）', pack: { box: [10, 20, 30, 40] }, need: /越界坐标：像素 box 必须同时给 imgW\/imgH/ },
  { label: '越界坐标：像素 box 超图（给了尺寸才判）', pack: { box: [10, 20, 3000, 40], imgW: 1600, imgH: 1200 }, need: /越界坐标：像素框 10,20,3000,40 超出图 1600x1200/ },
  { label: '越界坐标：宽高 ≤ 0', pack: { origBox: [0.1, 0.1, 0, 0.2] }, need: /宽或高 ≤ 0/ },
  { label: '缺页：origPage 文件不在库里', pack: { page: 42, origPage: '九年级-学生甲/数学/原卷/没有这页.jpg' }, need: /缺页：origPage 指向的文件不在库里/ },
  { label: '缺页：origPage 没在 _页码映射.json 登记', pack: { page: 42, origPage: SCAN_UNMAPPED }, need: /缺页：.*没有登记（无法证明它是第几页）/ },
  { label: '缺页：page 与 origPage 的印刷页对不上', pack: { page: 7, origPage: SCAN }, need: /缺页：origPage 是第 42 页，但正文里写的 page=7/ },
  { label: '缺页：pageSha 不在 _原图', pack: { pageSha: 'c'.repeat(64) }, need: /缺页：原图对象 cccccccccccc… 不在 _原图\\cc\\ 下/ },
  { label: '缺页：pageSha 形状不对', pack: { pageSha: 'XYZ' }, need: /缺页：pageSha 不是 64 位小写 hex/ },
  { label: '缺页：page 不是正整数', pack: { page: 0 }, need: /缺页：page 不是正整数/ },
];
const L3p = seedLib(path.join(BASE, 'lib-pack'));
for (const c of PACKS) {
  const rr0 = runTool(NEW_TOOL, L3p, ['候选', '--id', 'T001', '--kind', '卡', '--target', 'P0012', '--payload', JSON.stringify(c.pack)]);
  const cid = (candsOf(L3p, 'T001').slice(-1)[0] || {}).candId;
  const b = rawLedger(L3p), s = treeSnap(L3p);
  const rr = runTool(NEW_TOOL, L3p, ['采用', '--id', 'T001', '--candidate', cid]);
  A(`★ ${c.label} ⇒ exit 1`, rr0.code === 0 && rr.code === 1, 'exit=' + rr.code + ' ' + firstLine(rr.err));
  A(`  原因具体（数值/期望都在 stderr 里）：${c.label}`, c.need.test(rr.err), lineWith(rr.err, c.need).slice(0, 150));
  A(`  库一字未动：${c.label}`, rawLedger(L3p).equals(b) && diffSnap(s, treeSnap(L3p)).length === 0);
}
/* 正例：修订包全绿 ⇒ 采用成功（证明这套校验不是"一律拒收"） */
const GOOD = { note: '按原卷重定位', page: 42, origPage: SCAN, pageSha: PAGESHA, origBox: [0.1, 0.2, 0.3, 0.2], regions: [{ role: '配图', x: 0.5, y: 0.5, w: 0.2, h: 0.2 }], imgW: 1600, imgH: 1200, box: [10, 20, 30, 40], text: '整段替换正文' };
runTool(NEW_TOOL, L3p, ['候选', '--id', 'T001', '--kind', '卡', '--target', 'P0012', '--payload', JSON.stringify(GOOD)]);
const cidGood = candsOf(L3p, 'T001').slice(-1)[0].candId;
r = runTool(NEW_TOOL, L3p, ['采用', '--id', 'T001', '--candidate', cidGood]);
A('★ 反向正例：修订包坐标/页引用全合法 ⇒ 采用 exit 0（校验不是一律拒收）',
  r.code === 0 && fs.existsSync(revFile(L3p, '_修订/卡/P0012/' + cidGood + '.md')), 'exit=' + r.code + ' ' + firstLine(r.err));
A('  正例里 revision.note 取自修订包的 note（可选字段有去处）', revsOf(L3p, 'T001').slice(-1)[0].note === '按原卷重定位', JSON.stringify(revsOf(L3p, 'T001').slice(-1)[0].note));
/* 纯文本正文必须**明说**"没有坐标/页引用可校验"（不许静默通过）—— 真跑一次 --dry 看输出 */
const L3t = seedLib(path.join(BASE, 'lib-text'));
runTool(NEW_TOOL, L3t, ['候选', '--id', 'T001', '--kind', '卡', '--target', 'P0012', '--payload', '纯文本补丁：把第42页第3题的判罚口径改成按苏科版']);
const rTxt = runTool(NEW_TOOL, L3t, ['采用', '--id', 'T001', '--candidate', candsOf(L3t, 'T001')[0].candId, '--dry']);
A('★ 纯文本正文会明说"没有坐标/页引用可校验"（不许静默通过）',
  /正文是纯文本修订/.test(rTxt.out) && /没有坐标\/页引用可校验/.test(rTxt.out), lineWith(rTxt.out, /纯文本修订/).slice(0, 120));
const L3q = seedLib(path.join(BASE, 'lib-pack-dry'));
runTool(NEW_TOOL, L3q, ['候选', '--id', 'T001', '--kind', '卡', '--target', 'P0012', '--payload', JSON.stringify(GOOD)]);
const rJson = runTool(NEW_TOOL, L3q, ['采用', '--id', 'T001', '--candidate', candsOf(L3q, 'T001')[0].candId, '--dry']);
A('  反向：修订包正文会明说"校验通过"并列出身位字段（两态都说出口）',
  /正文是修订包：坐标与页引用校验通过/.test(rJson.out) && /regions\/origBox\/box\/page\/origPage\/pageSha/.test(rJson.out),
  lineWith(rJson.out, /修订包/).slice(0, 120));

/* 重复导入：落点已存在且内容不同 ⇒ 拒绝覆盖（exit 1） */
const L3d = seedLib(path.join(BASE, 'lib-dup'));
runTool(NEW_TOOL, L3d, ['候选', '--id', 'T001', '--kind', '卡', '--target', 'P0012', '--payload', '第一版正文']);
const CD = candsOf(L3d, 'T001')[0].candId;
const RELD = '_修订/卡/P0012/' + CD + '.md';
runTool(NEW_TOOL, L3d, ['采用', '--id', 'T001', '--candidate', CD]);
/* 人为把落点改成"人工改过"的样子（含候选记录一起回退：模拟"文件留下了、台账没记上"） */
const doctored = read(revFile(L3d, RELD)) + '\n（人工补的一句）\n';
fs.writeFileSync(revFile(L3d, RELD), doctored, 'utf8');
(() => {                                    // 把候选状态与 revisions 退回"待采用/未记录"，制造半截现场
  const j = jsonLedger(L3d);
  j.items[0].candidates[0].status = '待采用';
  j.items[0].candidates[0].adoptedAt = null;
  delete j.items[0].revisions;
  fs.writeFileSync(ledgerPath(L3d), JSON.stringify(j, null, 2) + '\n', 'utf8');
})();
const bDup = rawLedger(L3d), sDup = treeSnap(L3d);
r = runTool(NEW_TOOL, L3d, ['采用', '--id', 'T001', '--candidate', CD]);
A('★ 重复导入：落点已存在且内容不同 ⇒ exit 1（拒绝覆盖）', r.code === 1, 'exit=' + r.code + ' ' + firstLine(r.err));
A('  原因写清两种可能（手工改过 / 候选号串号）', /手工改过/.test(r.err) && /串号/.test(r.err), firstLine(r.err).slice(0, 100));
A('  被改过的那份内容没被覆盖（人手写的东西还在）', read(revFile(L3d, RELD)) === doctored);
A('  库一字未动（台账 + 落点）', rawLedger(L3d).equals(bDup) && diffSnap(sDup, treeSnap(L3d)).length === 0);
/* 反向：落点已存在但内容一致 ⇒ 幂等跳过（半截失败后重跑的恢复路），只补台账 */
(() => {
  fs.writeFileSync(revFile(L3d, RELD), read(revFile(L3d, RELD)).replace('\n（人工补的一句）\n', ''), 'utf8');
})();
r = runTool(NEW_TOOL, L3d, ['采用', '--id', 'T001', '--candidate', CD]);
A('★ 反向：落点内容一致 ⇒ 幂等跳过并明说（半截失败后重跑能补上留痕）',
  r.code === 0 && /落点已存在且内容一致/.test(r.out) && revsOf(L3d, 'T001').length === 1 && candsOf(L3d, 'T001')[0].status === '已采用',
  'exit=' + r.code + ' ｜ ' + firstLine(r.out));

/* ══════════════════════════════════════════════════════════════════════
   §4 事务：中途失败 ⇒ 库逐字节不变
   ══════════════════════════════════════════════════════════════════════ */
console.log('\n═══ §4 事务中途失败 ⇒ 库逐字节不变 ═══');
const L4 = seedLib(path.join(BASE, 'lib-txn'));
runTool(NEW_TOOL, L4, ['候选', '--id', 'T001', '--kind', '卡', '--target', 'P0012', '--payload', '事务构造用正文']);
const C4 = candsOf(L4, 'T001')[0].candId;
/* 构造：把落点目录 `_修订` 变成一个**文件** ⇒ 事务第二个写（正文）必然 ENOTDIR 失败。
   顺序有意为之：先写台账、后落正文（见 `采用` 里的注释），所以回滚必须把台账恢复成原样。 */
fs.writeFileSync(path.join(L4, '_修订'), 'not-a-directory');
const b4 = rawLedger(L4), s4 = treeSnap(L4, true), s4all = treeSnap(L4, false);
r = runTool(NEW_TOOL, L4, ['采用', '--id', 'T001', '--candidate', C4]);
A('★ 中途失败 ⇒ exit 2（不静默成功）', r.code === 2, 'exit=' + r.code + ' ' + firstLine(r.err));
A('★ 明说"事务已整体回滚"', /事务已整体回滚/.test(r.err), firstLine(r.err).slice(0, 100));
A('★ 台账逐字节不变（没有"台账记了修订、正文没落盘"的半截）', rawLedger(L4).equals(b4), rawLedger(L4).length + 'B');
A('★ 库内文件树（除 `_备份-真源\\`）逐字节不变', diffSnap(s4, treeSnap(L4, true)).length === 0,
  '树差异=' + JSON.stringify(diffSnap(s4, treeSnap(L4, true))));
A('★ 候选状态没被写脏（仍是 待采用）、revisions 一条都没多',
  candsOf(L4, 'T001')[0].status === '待采用' && revsOf(L4, 'T001').length === 0,
  candsOf(L4, 'T001')[0].status + '/' + revsOf(L4, 'T001').length);
/* 含备份的**全树**差异必须恰好是"多了一份写前留档"：口径写死在断言里，别让"逐字节不变"含糊过去 */
const dAll = diffSnap(s4all, treeSnap(L4, false));
A('★ 含 `_备份-真源\\` 的全树差异 = 恰好新增 1 份 `_待确认-*.json` 写前留档（别无其它）',
  dAll.length === 1 && /^_备份-真源\/_待确认-.*\.json\(新增\)$/.test(dAll[0]), JSON.stringify(dAll));
A('  口径说明：`writeJsonAtomic({backup:true})` 的写前留档发生在 rename 之前，按 `_安全写.mjs` 既有语义' +
  '回滚不回收备份（那是 ② 显式备份，本就只增不减）——所以"库逐字节不变"这条判据的口径是"除备份目录"',
  !fs.existsSync(path.join(L4, '_修订', '卡')) && fs.statSync(path.join(L4, '_修订')).isFile());
/* 阴性对照（真跑变异体）：不清理失败现场 ⇒ 下一次重跑会不会被误导？—— 清掉文件型 `_修订` 后重跑必须成功 */
fs.rmSync(path.join(L4, '_修订'));
r = runTool(NEW_TOOL, L4, ['采用', '--id', 'T001', '--candidate', C4]);
A('  修好落点后重跑 ⇒ 成功（回滚没在库里留下拦住重跑的残渣）', r.code === 0 && revsOf(L4, 'T001').length === 1, 'exit=' + r.code + ' ' + firstLine(r.err));

/* ══════════════════════════════════════════════════════════════════════
   §5 兼容：既有子命令与真旧实现（6df511a）逐字节对拍
   ══════════════════════════════════════════════════════════════════════ */
console.log('\n═══ §5 既有子命令对拍（真旧实现 vs 工作区新实现）═══');
let OLD_SRC = null, oldSkip = '', oldHard = '';
try {
  const buf = execFileSync('git', ['show', OLD_COMMIT + ':' + TOOL_REL], { cwd: REPO, maxBuffer: 64e6, stdio: ['ignore', 'pipe', 'pipe'] });
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  if (sha !== OLD_SHA256) oldHard = `git 里 ${OLD_COMMIT}:${TOOL_REL} 的 sha256 = ${sha}，与钉住的 ${OLD_SHA256} 不符 —— 对拍基线漂了，拒绝"对着别的东西比"`;
  else OLD_SRC = buf.toString('utf8');
} catch (e) { oldSkip = '取不到对拍基线（git 不可用 / 无该提交）：' + firstLine(e.message); }
if (oldHard) A('对拍基线指纹（必须与开工时 HEAD 的字节一致）', false, oldHard);
if (!OLD_SRC) {
  console.log('  [SKIP] §5 既有子命令对拍 —— ' + (oldSkip || oldHard));
  skips++;
} else {
  E.copyToolDeps(['_待确认.mjs'], OLD_DIR);
  fs.writeFileSync(path.join(OLD_DIR, '_待确认.mjs'), OLD_SRC, 'utf8');
  const OLD_TOOL = path.join(OLD_DIR, '_待确认.mjs');
  const OLD_LIB = seedLib(path.join(BASE, 'lib-old'));
  const NEW_LIB = seedLib(path.join(BASE, 'lib-new'));
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
  parity('状态 --student', ['状态', '--student', '学生甲']);
  parity('门禁 --json', ['门禁', '--json']);
  parity('门禁（人类模式，应为 exit 1）', ['门禁']);
  parity('措辞 --json', ['措辞', '--json']);
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
  parity('纠因（批次 3 的写入路径，本批不动它）', ['纠因', '--id', 'T002', '--why', '这道题其实孩子做对了', '--scope', '卡', '--date', '2026-11-03']);
  parity('纠因 幂等（同 why 再来一次）', ['纠因', '--id', 'T002', '--why', '这道题其实孩子做对了', '--scope', '卡', '--date', '2026-11-03']);
  parity('作废', ['作废', '--id', 'T002', '--answer', '题目已被撤走', '--date', '2026-11-03']);
  parity('删（未确认且无答案）', ['删', '--id', 'T003']);
  parity('改问题', ['改问题', '--id', 'T005', '--q', '第42页第3题，「3x+1」这个答案是你自己写的吗？', '--note', '补全问句']);
  parity('改详情', ['改详情', '--id', 'T005', '--detail', '放大原卷后确认是后改的', '--note', '换成人话']);
  parity('去黑话 --dry（不写盘）', ['去黑话', '--dry']);
  parity('同步（跳过 + 未找到两条分支）', ['同步', '--file', PKG, '--date', '2026-11-03']);
  parity('门禁 --json（收尾态）', ['门禁', '--json']);
  parity('清单（收尾态）', ['清单']);

  /* 收尾判据：两个库的**台账字节完全相同** —— 比"每步 stdout 相同"更硬（数据效果也一致） */
  A('★ 对拍收尾：两库 _待确认.json 逐字节相同',
    rawLedger(OLD_LIB).equals(rawLedger(NEW_LIB)), rawLedger(OLD_LIB).length + 'B vs ' + rawLedger(NEW_LIB).length + 'B');
  const mdNorm = p => {
    try {
      return read(p).replace(/_更新于 \d{4}-\d{2}-\d{2}_/g, '_更新于 <DATE>_')
        /* 已知差异·清单系统维护行 同款归一（见 norm 内注，2026-11-09） */
        .split('`node _生成队列.mjs` + `_生成首页.ps1`').join('<GENCMD>')
        .split('`node _生成队列.mjs` + `node 生成状态.mjs`').join('<GENCMD>')
        .replace(/\r\n/g, '\n');
    }
    catch (e) { return '(读不出：' + e.message + ')'; }
  };
  A('★ 对拍收尾：两库 _待确认清单.md 除「_更新于 <日期>」外逐字节相同',
    mdNorm(path.join(OLD_LIB, '_待确认清单.md')) === mdNorm(path.join(NEW_LIB, '_待确认清单.md')),
    firstDiff(mdNorm(path.join(OLD_LIB, '_待确认清单.md')), mdNorm(path.join(NEW_LIB, '_待确认清单.md'))));

  /* ── 原已知差异（批次 4 新增 候选/修订/采用/作废候选 出现在"可用列表"里）随基线推进退役：
     2026-11-09 基线从 6df511a（批次 3 开工）推进到 069e5a2（.01 落地后，含批次 4 全部子命令），
     那批增量已两侧都在 ⇒ 改写为"两侧逐字一致"的同强度判据（宁可对拍变严，不放水历史差异）。
     结构判据保留（对后续继续加子命令免疫，但对删老命令/改别的行仍有牙齿）。批次 3 在这里
     吃过 14 条连锁红的亏（把"新增能力本身的差异"当成回归）——这次的教训是**基线推进要随版走**。 */
  const ua = runTool(OLD_TOOL, OLD_LIB, ['不存在的动作']), ub = runTool(NEW_TOOL, NEW_LIB, ['不存在的动作']);
  const uea = norm(ua.err, OLD_LIB), ueb = norm(ub.err, NEW_LIB);
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

  /* ── 原已知差异（旧实现不认识 候选）随基线推进退役：069e5a2 里 候选 已存在 ⇒ 进对拍。── */
  const cntOf = dir => (jsonLedger(dir).items || []).length;
  const kOld0 = cntOf(OLD_LIB), kNew0 = cntOf(NEW_LIB);
  const candArgs = ['候选', '--id', 'T004', '--kind', '卡', '--target', 'P0012', '--payload', '两侧同构写入的候选'];
  const ka = runTool(OLD_TOOL, OLD_LIB, candArgs);
  const kb = runTool(NEW_TOOL, NEW_LIB, candArgs);
  A('候选 --kind 卡：两侧一致接受（都 exit 0 且各加 1 条 candidates）',
    ka.code === 0 && kb.code === 0 && candsOf(OLD_LIB, 'T004').length === 1 && candsOf(NEW_LIB, 'T004').length === 1,
    'exit ' + ka.code + '/' + kb.code);
  A('  两库台账仍然逐字节相同（两侧同构写入；哪天一侧不认 候选 = 基线取错，这里先红）',
    rawLedger(OLD_LIB).equals(rawLedger(NEW_LIB)),
    firstDiff(norm(rawLedger(OLD_LIB).toString('utf8'), OLD_LIB), norm(rawLedger(NEW_LIB).toString('utf8'), NEW_LIB)));
}

/* ══════════════════════════════════════════════════════════════════════
   §6 壳侧（Lead 的 C#）与工具侧的 argv / 形状门禁对齐
   —— Lead 的口径是"壳固定键名 → 固定 argv，无通用透传"，这三把 op 与本用例的期望值必须一致，
      否则界面按壳的裁剪发参数、工具按另一套收 ⇒ 用户点"采用"永远失败。
   ══════════════════════════════════════════════════════════════════════ */
console.log('\n═══ §6 壳侧 op 与工具侧对齐（源码级）═══');
const SHELL_REL = 'src/shell/CTBShellV2.cs';
let SHELL_SRC = null;
try { SHELL_SRC = rd(SHELL_REL); } catch (e) { SHELL_SRC = null; }
if (!SHELL_SRC) {
  console.log('  [SKIP] §6 壳侧对齐 —— 读不到 ' + SHELL_REL + '（C# 由 Lead 维护）');
  skips++;
} else {
  A('壳侧候选号形状门禁与工具一致：^c-[0-9a-f]{12}$', SHELL_SRC.includes('"^c-[0-9a-f]{12}$"'));
  A('壳侧待办编号形状：^T[0-9]{3,6}$（工具侧 findById 不设形状门，宽松侧由壳收紧）', SHELL_SRC.includes('"^T[0-9]{3,6}$"'));
  A('壳侧 reviewList → `修订 --id <T> --json`（只读）', SHELL_SRC.includes('"修订", "--id", id, "--json"'));
  A('壳侧 reviewCandidate → `候选 --id --kind --target --payload-file`（正文走临时文件，不塞 argv）',
    SHELL_SRC.includes('"候选", "--id", id, "--kind", kind, "--target", target') && SHELL_SRC.includes('"--payload-file"'));
  A('壳侧 reviewAdopt → `采用 --id <T> --candidate <candId>`（+ 可选 --dry）',
    SHELL_SRC.includes('"采用", "--id", id, "--candidate", candId') && SHELL_SRC.includes('"--dry"'));
  A('壳侧 kind 白名单 = 卡 / 配方 / 流程（与工具侧 CAND_KINDS 同集合）',
    /REVIEW_KINDS[\s\S]{0,120}"卡", "配方", "流程"/.test(SHELL_SRC));
  A('壳侧把库根显式注入子进程 CTB_DATA（`_待确认.mjs` 不认 --data）',
    /RunNodeRaw\(args\.ToArray\(\), \d+, out exit, out se, DataRoot\)/.test(SHELL_SRC));
}

/* ══════════════════════════════════════════════════════════════════════
   §7 变异体阴性对照（掏掉判据必须红 —— 真跑，不是嘴上说）
   ══════════════════════════════════════════════════════════════════════ */
console.log('\n═══ §7 变异体阴性对照（掏掉判据必须红）═══');
E.copyToolDeps(['_待确认.mjs'], MUT_DIR);
const MUT_TOOL = path.join(MUT_DIR, '_待确认.mjs');
function mkMutant(from, to) {
  const n = TOOL_SRC.split(from).length - 1;
  if (n !== 1) return { ok: false, why: `变异锚点命中 ${n} 处（期望 1）—— 变异体没生成，判据会假绿` };
  fs.writeFileSync(MUT_TOOL, TOOL_SRC.replace(from, to), 'utf8');
  return { ok: true, why: '' };
}
const mutLib = name => seedLib(path.join(BASE, name));

/* M1：掏掉"同内容复用"判据 ⇒ §1 的幂等必须变成"新增第二条" */
{
  const q = mkMutant('const dup = list.find(c => c && c.kind === kind && c.target === target && c.payloadDigest === payloadDigest);',
    'const dup = null;   /* 变异体 M1：掏掉同内容复用判据 */');
  A('M1 变异生效（锚点唯一命中）', q.ok, q.why);
  if (q.ok) {
    const lib = mutLib('mut-lib-1');
    runTool(MUT_TOOL, lib, ['候选', '--id', 'T001', '--kind', '卡', '--target', 'P0012', '--payload', '同一条草案']);
    runTool(MUT_TOOL, lib, ['候选', '--id', 'T001', '--kind', '卡', '--target', 'P0012', '--payload', '同一条草案']);
    const n = candsOf(lib, 'T001').length;
    const ids = candsOf(lib, 'T001').map(c => c.candId);
    A('★ M1 阴性对照：掏掉复用后同内容变 2 条（同 candId 出现两次）⇒ §1「仍是 1 条」有牙齿',
      n === 2 && ids[0] === ids[1], '变异体实测 ' + n + ' 条 ' + JSON.stringify(ids));
  }
}
/* M2：掏掉形状守卫 ⇒ §1/§2 的"非数组 ⇒ exit 2"必须变成 exit 0 */
{
  const q = mkMutant('    if (!Array.isArray(v)) {', '    if (false && !Array.isArray(v)) {   /* 变异体 M2：掏掉形状守卫 */');
  A('M2 变异生效（锚点唯一命中）', q.ok, q.why);
  if (q.ok) {
    const lib = mutLib('mut-lib-2');
    const j = jsonLedger(lib); j.items[0].candidates = { value: [] };
    fs.writeFileSync(ledgerPath(lib), JSON.stringify(j, null, 2) + '\n');
    const rr = runTool(MUT_TOOL, lib, ['修订', '--id', 'T001']);
    A('★ M2 阴性对照：掏掉形状守卫后 exit 0（把 {value:[]} 当空表）⇒ §1/§2「非数组 ⇒ exit 2」有牙齿',
      rr.code === 0, '变异体 exit=' + rr.code + ' ' + firstLine(rr.err).slice(0, 70));
  }
}
/* M3：掏掉 `--dry` 早退 ⇒ §3.1 的"一个字节都不写"必须变成真写盘 */
{
  const q = mkMutant('    if (opt.json) console.log(JSON.stringify({ ok: true, id: it.id, candId, dry: true, idempotent: false, written, status: \'待采用\', wouldSetStatus: \'已采用\', relPath, bytes: Buffer.byteLength(body, \'utf8\') }));\n    process.exit(0);',
    '    if (opt.json) console.log(JSON.stringify({ ok: true, id: it.id, candId, dry: true }));   /* 变异体 M3：掏掉 --dry 早退 */');
  A('M3 变异生效（锚点唯一命中）', q.ok, q.why);
  if (q.ok) {
    const lib = mutLib('mut-lib-3');
    runTool(MUT_TOOL, lib, ['候选', '--id', 'T001', '--kind', '卡', '--target', 'P0012', '--payload', 'dry 变体']);
    const cid = candsOf(lib, 'T001')[0].candId;
    const before = rawLedger(lib);
    const rr = runTool(MUT_TOOL, lib, ['采用', '--id', 'T001', '--candidate', cid, '--dry']);
    A('★ M3 阴性对照：掏掉 --dry 早退后台账被真写了 ⇒ §3.1「--dry 不写盘」有牙齿',
      rr.code === 0 && !rawLedger(lib).equals(before) && fs.existsSync(revFile(lib, '_修订/卡/P0012/' + cid + '.md')),
      '变异体 exit=' + rr.code + ' 台账变了=' + !rawLedger(lib).equals(before));
  }
}
/* M4：把"落点内容不同"误当成"内容一致" ⇒ §3.6 的重复导入拒绝必须失效 */
{
  const q = mkMutant('  if (fs.existsSync(absPath)) {\n    const cur = fs.readFileSync(absPath, \'utf8\');\n    if (cur === body) {',
    '  if (fs.existsSync(absPath)) {\n    const cur = fs.readFileSync(absPath, \'utf8\');\n    if (true) {   /* 变异体 M4：一律当成内容一致 */');
  A('M4 变异生效（锚点唯一命中）', q.ok, q.why);
  if (q.ok) {
    const lib = mutLib('mut-lib-4');
    runTool(MUT_TOOL, lib, ['候选', '--id', 'T001', '--kind', '卡', '--target', 'P0012', '--payload', '第一版']);
    const cid = candsOf(lib, 'T001')[0].candId;
    const rel = '_修订/卡/P0012/' + cid + '.md';
    runTool(MUT_TOOL, lib, ['采用', '--id', 'T001', '--candidate', cid]);
    fs.writeFileSync(revFile(lib, rel), read(revFile(lib, rel)) + '\n人工补的一句\n');
    const j = jsonLedger(lib); j.items[0].candidates[0].status = '待采用'; j.items[0].candidates[0].adoptedAt = null; delete j.items[0].revisions;
    fs.writeFileSync(ledgerPath(lib), JSON.stringify(j, null, 2) + '\n');
    const rr = runTool(MUT_TOOL, lib, ['采用', '--id', 'T001', '--candidate', cid]);
    A('★ M4 阴性对照：掏掉拒绝后 exit 0（把人工改过的落点当幂等跳过）⇒ §3.6「内容不同 ⇒ exit 1」有牙齿',
      rr.code === 0, '变异体 exit=' + rr.code + ' ' + firstLine(rr.err).slice(0, 70));
  }
}
/* M5：把"锁 + 事务"换成直接写 ⇒ §4 的"中途失败整体回滚"必须变成半截状态 */
{
  const q = mkMutant('    withLibWrite(ROOT, \'_待确认 采用 \' + candId, tx => {',
    '    ((fakeTx, fn) => fn(fakeTx))({ writeJson: (f, o, oo) => writeJsonAtomic(f, o, oo), writeText: (f, t) => writeTextAtomic(f, t) }, tx => {   /* 变异体 M5：绕开锁 + 事务 */');
  A('M5 变异生效（锚点唯一命中）', q.ok, q.why);
  if (q.ok) {
    const lib = mutLib('mut-lib-5');
    runTool(MUT_TOOL, lib, ['候选', '--id', 'T001', '--kind', '卡', '--target', 'P0012', '--payload', '事务变体']);
    const cid = candsOf(lib, 'T001')[0].candId;
    fs.writeFileSync(path.join(lib, '_修订'), 'not-a-directory');
    const before = rawLedger(lib);
    const rr = runTool(MUT_TOOL, lib, ['采用', '--id', 'T001', '--candidate', cid]);
    A('★ M5 阴性对照：绕开事务后台账留在盘上（半截状态）⇒ §4「库逐字节不变」有牙齿',
      rr.code === 2 && !rawLedger(lib).equals(before) && candsOf(lib, 'T001')[0].status === '已采用',
      '变异体 exit=' + rr.code + ' 台账变了=' + !rawLedger(lib).equals(before));
  }
}

/* M6：掏掉"目标定位不到要喊出来" ⇒ §3.5b 的缺页警告必须消失 */
{
  const q = mkMutant('  if (curWarn.presence === \'missing\' && kind !== \'流程\') {', '  if (false) {   /* 变异体 M6：掏掉缺页警告 */');
  A('M6 变异生效（锚点唯一命中）', q.ok, q.why);
  if (q.ok) {
    const lib = mutLib('mut-lib-6');
    runTool(MUT_TOOL, lib, ['候选', '--id', 'T002', '--kind', '卡', '--target', 'P9999', '--payload', '给不存在的卡记想法']);
    const cid = candsOf(lib, 'T002')[0].candId;
    const rr = runTool(MUT_TOOL, lib, ['采用', '--id', 'T002', '--candidate', cid, '--dry']);
    A('★ M6 阴性对照：掏掉警告后目标定位不到也一声不吭 ⇒ §3.5b「必须喊出来」有牙齿',
      rr.code === 0 && !/现值定位不到/.test(rr.out), '变异体 exit=' + rr.code);
  }
}

console.log('\nRESULT=' + (fail ? 'FAIL(' + fail + ')' : 'PASS') + ' 断言=' + (pass + fail) + (skips ? ' SKIP=' + skips : ''));
process.exit(fail ? 1 : 0);
