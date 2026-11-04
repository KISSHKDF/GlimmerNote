/* 拾光小册 · 批次 5「扩展」的机检判据：`pack.json` 的 `extensions[]`（学科/接口扩展声明）
 *
 * 施工方案 §6 批次 5 的验收原文只有一句：「**逐条扩展各自附反例**」；§9.1 批次 5 行写「逐条扩展各自附反例」。
 * 口号不是门禁 —— 本用例证明这三条**真的会红**：
 *   ① 不声明 `extensions` ⇒ 完全不受影响（老包一字不改照样通过，向后兼容）
 *   ② 声明了就必须四项齐全且非空（学科 / 适用条件 / 反例 / 维护者），占位词（TODO/待补/略…）一样判红
 *   ③ 「能发现误伤的反例」必须**可跑**：反例要指到包内真实案例，且该案例 `expected.json → controls[]`
 *      里真有一条能对应上；指向不存在的案例 / 案例里没有那条对照 ⇒ 判红
 *
 * 手法：把真包复制到 %TEMP%，逐项做**变异**（每项都先断言"锚点真的改到了"），再真跑 `_经验包.mjs 校验`。
 * 只读仓库里的样本包、只写 %TEMP% 夹具；真库零写入。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const E = require('./_测试环境.cjs');
const ROOT = E.REPO;
const TOOL = E.tool('_经验包.mjs');
const SAMPLE = path.join(ROOT, 'src', 'packs', 'family-b', 'periodic-symbols', '1.0.0');

let pass = 0, fail = 0;
const A = (name, ok, detail) => {
  console.log((ok ? '[OK]  ' : '[FAIL]') + ' ' + name + (detail ? '  → ' + detail : ''));
  ok ? pass++ : fail++;
};
const BASE = E.allocTempDir('gn-ext-');
/* 变异副本放在 BASE，而 `--packs` 指向**另一个空包根**（PACKROOT）：
   ⚠ 若把变异副本放在包根**之下**，`校验` 会按"已安装包"口径对账目录名与 id/version
   （目录名是变异名 `e2-…` ≠ `family-b/periodic-symbols`）⇒ 每条变异都多一条【目录/id】错误，
   判据就分不清"我要测的那条错"和"夹具自己引入的错"。分开两个根最干净。 */
const PACKROOT = E.allocTempDir('gn-ext-root-');

/* ⚠ 解析口径（本轮实测撞出来的坑）：`--json` 的输出是**多行美化 JSON**，
   所以"取最后一个以 `{` 开头的行"会取到 `}` 那一行、解析失败 —— 而失败是**静默**的
   （`r.json` 为 null ⇒ `(r.json && r.json.errors) || []` 变成空数组 ⇒ "没有扩展类错误"恒真）。
   第一版就是这样把 ①a 判成绿的（假绿）。正确做法：先整体 parse，再退化成"首个 { 到末个 }"。
   教训：**判据的解析器坏掉时，断言会变成恒真** —— 解析失败必须能被看出来（下面 `parsed` 字段自证）。 */
function parseJsonLoose(out) {
  const s = String(out || '');
  try { return JSON.parse(s); } catch { /* 下面退化 */ }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch { /* 放弃 */ } }
  return null;
}
function check(dir) {
  /* ⚠ 必须带 `--packs BASE`（临时根）：不给的话 `_经验包.mjs` 会用**默认包根**（用户机器上真装着的包），
     于是"同版异内容"判据会拿本机已安装的 family-b@1.0.0 跟这里的变异副本比 ⇒ 每条变异都多一条
     【同版异内容】错误（本轮实测：装机之后 ③6 就假红了）。用例要在**自带的包根**里自洽。 */
  const r = spawnSync(process.execPath, [TOOL, '校验', dir, '--packs', PACKROOT, '--json'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  const j = parseJsonLoose(r.stdout);
  return { code: r.status == null ? -1 : r.status, json: j, parsed: !!j, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
/** 造一份"改了某处"的包副本；返回目录。mut 必须真的改到东西（否则断言会空转）。 */
function variant(name, mut) {
  const dir = path.join(BASE, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(SAMPLE, dir, { recursive: true });
  const pf = path.join(dir, 'pack.json');
  const before = fs.readFileSync(pf, 'utf8');
  const doc = JSON.parse(before);
  mut(doc, dir);
  const after = JSON.stringify(doc, null, 2);
  if (after === before) throw new Error('变异没改到东西：' + name);
  fs.writeFileSync(pf, after, 'utf8');
  return dir;
}
const extErrors = (r) => ((r.json && r.json.errors) || []).filter((e) => e.code === '扩展');
const msgOf = (errs) => errs.map((e) => (e.why || '') + ' ' + (e.what || '')).join(' ');

/* ═══ ① 正向：两个真包（带声明 / 不带声明）都必须通过 ═══ */
console.log('═══ ① 正向 ═══');
{
  const r = check(SAMPLE);
  A('①a 带 extensions 的真扩展包（化学）校验通过 exit 0', r.code === 0 && r.parsed && extErrors(r).length === 0,
    'exit=' + r.code + ' 解析成功=' + r.parsed + ' 扩展错误=' + extErrors(r).length);
  A('①b JSON 里能读到声明（学科/适用条件/反例/维护者四项都在）',
    !!(r.json && Array.isArray(r.json.extensions) && r.json.extensions[0] &&
      r.json.extensions[0]['学科'] && r.json.extensions[0]['适用条件'] &&
      r.json.extensions[0]['维护者'] && r.json.extensions[0]['反例'].length >= 1),
    JSON.stringify((r.json && r.json.extensions && r.json.extensions[0]) || null).slice(0, 200));
  const pilot = path.join(ROOT, 'src', 'packs', 'family-a', 'shared-stem', '1.0.2');
  const r2 = check(pilot);
  A('①c ★向后兼容：**不声明** extensions 的老包（试点包）一字不改照样通过',
    r2.code === 0 && extErrors(r2).length === 0, 'exit=' + r2.code);
  A('①d 老包的 extensions 字段是空数组（不是 undefined 造成的"看不出有没有声明"）',
    !!(r2.json && Array.isArray(r2.json.extensions) && r2.json.extensions.length === 0),
    JSON.stringify(r2.json && r2.json.extensions));
}

/* ═══ ② 声明了就必须四项齐全且非空（每条变异都必须真红） ═══ */
console.log('\n═══ ② 四项缺一 / 空值 / 占位词 ═══');
const cases2 = [
  ['缺学科', (d) => { delete d.extensions[0]['学科']; }, /学科/],
  ['缺适用条件', (d) => { delete d.extensions[0]['适用条件']; }, /适用条件/],
  ['缺维护者', (d) => { delete d.extensions[0]['维护者']; }, /维护者/],
  ['缺反例（整项删掉）', (d) => { delete d.extensions[0]['反例']; }, /反例/],
  ['反例是空数组', (d) => { d.extensions[0]['反例'] = []; }, /反例/],
  ['适用条件是空白串', (d) => { d.extensions[0]['适用条件'] = '   '; }, /适用条件/],
  ['维护者写占位词「待补」', (d) => { d.extensions[0]['维护者'] = '待补'; }, /占位/],
  ['学科写占位词「TODO」', (d) => { d.extensions[0]['学科'] = 'TODO'; }, /占位/],
  ['extensions 是空数组（空壳）', (d) => { d.extensions = []; }, /空数组|空壳/],
  ['extensions 写成对象（不是数组）', (d) => { d.extensions = { 学科: '化学' }; }, /数组/],
];
for (const [name, mut, re] of cases2) {
  const dir = variant('e2-' + name.replace(/[^\w\u4e00-\u9fa5]/g, ''), mut);
  const r = check(dir);
  const errs = extErrors(r);
  A('②' + (cases2.findIndex((c) => c[0] === name) + 1) + ' ' + name + ' ⇒ 判红且原因点名',
    r.code !== 0 && errs.length > 0 && re.test(msgOf(errs)),
    'exit=' + r.code + ' ｜ ' + (errs.map((e) => e.code + '/' + e.what).join('、') || '（没有扩展类错误）'));
}

/* ═══ ③ 「能发现误伤的反例」必须可跑 ═══ */
console.log('\n═══ ③ 反例可跑性 ═══');
const cases3 = [
  ['反例指向不存在的案例目录', (d) => { d.extensions[0]['反例'][0]['案例'] = 'cases/不存在的案例'; }, /案例目录不存在/],
  ['反例的「对照」在案例 controls 里查不到', (d) => { d.extensions[0]['反例'][0]['对照'] = 'no-such-control'; }, /找不到对照/],
  ['反例缺「对照」字段', (d) => { delete d.extensions[0]['反例'][1]['对照']; }, /缺「对照」/],
  ['反例缺「案例」字段', (d) => { delete d.extensions[0]['反例'][2]['案例']; }, /缺「案例」/],
];
for (const [name, mut, re] of cases3) {
  const dir = variant('e3-' + cases3.findIndex((c) => c[0] === name), mut);
  const r = check(dir);
  const errs = extErrors(r);
  A('③' + (cases3.findIndex((c) => c[0] === name) + 1) + ' ' + name + ' ⇒ 判红且原因点名',
    r.code !== 0 && errs.length > 0 && re.test(msgOf(errs)),
    'exit=' + r.code + ' ｜ ' + (msgOf(errs).slice(0, 160) || '（没有扩展类错误）'));
}
/* 案例里把那条对照删掉 ⇒ 声明就失去支撑，必须红（证明判据真的去读了案例，不是只看声明自洽） */
{
  const dir = variant('e3-control-removed', (d) => { /* 只改案例文件，见下 */ });
  const ef = path.join(dir, 'cases', 'periodic-symbols', 'expected.json');
  const exp = JSON.parse(fs.readFileSync(ef, 'utf8'));
  const n0 = exp.controls.length;
  exp.controls = exp.controls.filter((c) => c.id !== 'public-condition-marked-as-error');
  if (exp.controls.length === n0) throw new Error('变异没改到案例：没找到 public-condition-marked-as-error');
  fs.writeFileSync(ef, JSON.stringify(exp, null, 1) + '\n', 'utf8');
  const r = check(dir);
  const errs = extErrors(r);
  A('③5 ★把案例里那条"能发现误伤"的对照删掉 ⇒ 声明当场失去支撑、判红（判据真的读了案例）',
    r.code !== 0 && errs.some((e) => /找不到对照/.test(e.why || '')),
    'exit=' + r.code + ' ｜ ' + (msgOf(errs).slice(0, 160) || '（没有扩展类错误）'));
}
/* 对照也支持按"场景关键词"命中（id 是首选，但关键词也算数）—— 这条证明匹配口径不是只有 id */
{
  const dir = variant('e3-scene-keyword', (d) => { d.extensions[0]['反例'] = [{ 案例: 'cases/periodic-symbols', 对照: '误伤对照' }]; });
  const r = check(dir);
  A('③6 反例的「对照」写场景关键词（"误伤对照"）也能命中（匹配口径 = id 或场景/期望文本包含）',
    r.code === 0, 'exit=' + r.code + ' ｜ ' + extErrors(r).map((e) => e.msg).join(' ').slice(0, 140));
}

/* ═══ ④ 真扩展能"装、选、停、退"（与批次 2 同口径，抽查本包） ═══ */
console.log('\n═══ ④ 装机路径（临时根，不碰用户库） ═══');
{
  const packs = E.allocTempDir('gn-ext-packs-');
  fs.cpSync(path.join(ROOT, 'src', 'packs', 'family-b'), path.join(packs, 'family-b'), { recursive: true });
  const list = spawnSync(process.execPath, [TOOL, '清单', '--packs', packs, '--json'], { cwd: ROOT, encoding: 'utf8' });
  const lj = parseJsonLoose(list.stdout);
  const pk = lj && (lj.packs || []).find((p) => p.id === 'family-b/periodic-symbols');
  A('④a 装到临时包根后 `清单` 能看到它、且 enabled=true', !!pk && pk.enabled === true,
    pk ? pk.id + '@' + pk.version + ' enabled=' + pk.enabled
      : '（没看到）解析=' + !!lj + ' 包根存在=' + fs.existsSync(packs) +
        ' 版本目录存在=' + fs.existsSync(path.join(packs, 'family-b', 'periodic-symbols', '1.0.0')) +
        ' stderr=' + String(list.stderr || '').slice(0, 120));
  fs.writeFileSync(path.join(packs, 'family-b', 'periodic-symbols', '1.0.0', '.停用'), '', 'utf8');
  const list2 = spawnSync(process.execPath, [TOOL, '清单', '--packs', packs, '--json'], { cwd: ROOT, encoding: 'utf8' });
  const lj2 = parseJsonLoose(list2.stdout);
  const pk2 = lj2 && (lj2.packs || []).find((p) => p.id === 'family-b/periodic-symbols');
  A('④b 放 `.停用` 后 enabled 翻成 false（"能停"）', !!pk2 && pk2.enabled === false,
    pk2 ? 'enabled=' + pk2.enabled : '（没看到）解析=' + !!lj2);
}

console.log('\nRESULT=' + (fail ? 'FAIL(' + fail + ')' : 'PASS') + ' 断言=' + (pass + fail) + ' 通过=' + pass + ' 失败=' + fail);
process.exit(fail ? 1 : 0);
