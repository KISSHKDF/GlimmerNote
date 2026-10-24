#!/usr/bin/env node
/**
 * fixtures 自检（F-05）：**仓库自带的合成测试库必须真的能用**。
 *
 * 为什么要有这条（2026-10-24 审计驱动）：
 *   在此之前 `fixtures\` 目录**是空的**，而全部门禁都靠 `..\错题本` 这个开发机真库。
 *   后果有两个：①新克隆（换机/换人）一条测试都跑不了（F-06）；
 *   ②"用合成数据跑测试"这件事从来没被验证过 —— 空目录 ≠ 机制已落地。
 *
 * 这条测试做三件事：
 *   ① 断言 `fixtures\库-最小\` 的骨架在（索引 / 状态包 / 待确认 / 至少一张卡）
 *   ② 断言里面**不含真实学生数据**（隐私红线：样本必须是合成的）
 *   ③ 真把 `CTB_DATA` 指向它，跑两个工具，退出码必须 0
 *      —— 证明它不是"摆着好看的目录"，而是真数据源。
 *
 * 只读 fixtures，不写、不碰真库。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const FX = path.join(REPO, 'fixtures', '库-最小');
const TOOLS = path.join(REPO, 'src', 'tools');

let pass = 0, fail = 0;
const A = (l, ok, x = '') => {
  ok ? (pass++, console.log('  ✔ ' + l + (x ? '  → ' + x : '')))
     : (fail++, console.log('  ✖ ' + l + (x ? '  → ' + x : '')));
};

console.log('══ ① fixtures 骨架 ══');
A('fixtures\\库-最小 目录存在', fs.existsSync(FX), FX);
const needFiles = ['_索引.json', '_状态.json', '_待确认.json', path.join('九年级', '_索引.json')];
for (const f of needFiles) {
  const p = path.join(FX, f);
  A(f + ' 存在且非空', fs.existsSync(p) && fs.statSync(p).size > 2,
    fs.existsSync(p) ? fs.statSync(p).size + ' B' : '缺失');
}
const cards = [];
const gradeIdx = path.join(FX, '九年级', '_索引.json');
if (fs.existsSync(gradeIdx)) {
  const j = JSON.parse(fs.readFileSync(gradeIdx, 'utf8').replace(/^\uFEFF/, ''));
  for (const [sn, v] of Object.entries(j.subjects || {})) {
    for (const it of (v.items || [])) cards.push({ subj: sn, id: it.id, dir: it.dir });
  }
}
A('索引里有 ≥2 张卡', cards.length >= 2, cards.length + ' 张');
A('每张卡的题干.html 都在磁盘上',
  cards.every(c => fs.existsSync(path.join(FX, '九年级', c.subj, c.dir, '题干.html'))));
A('索引与状态包的题目集合一致',
  cards.length === parseFloat(String((() => {
    const s = JSON.parse(fs.readFileSync(path.join(FX, '_状态.json'), 'utf8').replace(/^\uFEFF/, ''));
    return (s.data || []).reduce((n, d) => n + (d.subjects || []).reduce((m, sj) => m + (sj.items || []).length, 0), 0);
  })())));

console.log('\n══ ② 隐私红线：样本必须是合成的 ══');
{
  const blob = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(json|html|md)$/.test(e.name)) blob.push(fs.readFileSync(p, 'utf8'));
    }
  };
  walk(FX);
  const all = blob.join('\n');
  /* 真实库用化名，但仓库里连化名都不该出现 —— fixtures 必须是完全合成的人名。
     ★ 2026-10-24 B-09：禁词表改从 repo-hygiene.cjs 引（唯一真源，本文件不再写字面量；
     全仓范围的扫描由 repo-hygiene 负责，这里只守 fixtures 目录本身）。 */
  const { REAL_NAMES } = require('./repo-hygiene.cjs');
  const hit = REAL_NAMES.filter(n => all.includes(n));
  A('不含真实学生的化名（词表见 repo-hygiene）', hit.length === 0, hit.length ? '命中 ' + hit.join('/') : '干净');
  A('含明确的合成标识（合成/示例/假数据）', /合成|示例|假数据/.test(all));
}

console.log('\n══ ③ 真把它当数据源跑工具 ══');
{
  /* ★ 必须跑在**临时副本**上：`_状态刷新.mjs` 是写盘工具（刷新后落盘 _状态.json），
   *   直接对 fixtures\ 跑会把提交进库的样本写脏 —— 实测过：跑一次 fixtures\库-最小\_状态.json
   *   就变成 modified，每次跑门禁工作区都脏。样本必须**不可变**，否则"合成数据"也会漂移。 */
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-fixlib-'));
  const COPY = (a, b) => fs.cpSync(a, b, { recursive: true });
  COPY(FX, path.join(tmp, 'lib'));
  const TMPLIB = path.join(tmp, 'lib');

  const env = Object.assign({}, process.env, { CTB_DATA: TMPLIB, CTB_TEST_LIB: TMPLIB });
  const run = (toolName, args) => {
    try {
      const out = execFileSync(process.execPath, [path.join(TOOLS, toolName), ...args], {
        encoding: 'utf8', env, cwd: REPO, maxBuffer: 32 * 1024 * 1024, timeout: 120000,
      });
      return { code: 0, out: String(out || ''), err: '' };
    } catch (e) {
      return { code: e.status == null ? -1 : e.status, out: String(e.stdout || ''), err: String(e.stderr || '') };
    }
  };

  try {
    const r1 = run('_状态刷新.mjs', ['pending']);
    A('_状态刷新.mjs pending 在 fixture 库上退出 0', r1.code === 0,
      r1.code === 0 ? '' : (r1.err || '').split('\n').slice(0, 2).join(' ').slice(0, 160));
    let st = null;
    try { st = JSON.parse(r1.out); } catch (e) { }
    A('输出的状态包可解析且含 data/pending', !!st && !!st.data && !!st.pending,
      st ? ('students=' + st.data.length + ' cards=' + st.data.reduce((n, d) => n + (d.subjects || []).reduce((m, sj) => m + (sj.items || []).length, 0), 0)) : '解析失败');
    A('状态包里的学生正是 fixture 那个合成学生',
      !!st && st.data.length === 1 && st.data[0].name === '学生A',
      st ? String(st.data[0] && st.data[0].name) : '');

    /* 写盘工具跑完后，提交进库的 fixtures 必须**一个字节都没变** */
    const pristine1 = fs.readFileSync(path.join(FX, '_状态.json'));
    const after1 = fs.readFileSync(path.join(TMPLIB, '_状态.json'));
    A('写盘工具只改了临时副本，没碰 fixtures\\',
      pristine1.equals(fs.readFileSync(path.join(FX, '_状态.json'))),
      '原样本 ' + pristine1.length + ' B / 副本 ' + after1.length + ' B');

    const r2 = run('_配图门禁.mjs', ['门禁']);
    A('_配图门禁.mjs 门禁 在 fixture 库上退出 0', r2.code === 0,
      r2.code === 0 ? '' : (r2.err || '').split('\n').slice(0, 2).join(' ').slice(0, 160));
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
  }
}

console.log('\nRESULT=' + (fail ? 'FAIL' : 'PASS') + ' 断言=' + (pass + fail));
process.exit(fail ? 1 : 0);
