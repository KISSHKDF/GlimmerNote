#!/usr/bin/env node
/**
 * neg-libfind-convergence.cjs —— 「题库发现」必须是**单一真源**（2026-11-12 立，审计 F05）
 *
 * 事故形态：`function indexFiles`（递归收集 `_索引.json`）原先在 **8 个工具里各抄一份**。
 * 2026-11-12 按归一化哈希实测是 **3 种实现**：6 处逐字一致、一份**漏了「作业/假期」跳过行**
 *   （`_录题入库.mjs` ⇒ **入库会往"其余门禁扫不到"的目录里写卡**）、一份只是排版不同。
 * 两边的自测都绿——与判据⑦那次（F03）同一族：**同一规则多处实现，改一处漏一处**。
 *
 * 本用例守四件事（全部零依赖：只读本仓源码 + 自建 %TEMP% 夹具）：
 *   ① 8 个工具都从 `_题库发现.mjs` import，且**都不再有**本地 `function indexFiles`；
 *   ② 共享模块含「作业/假期」跳过判据（口径统一后不能把这行丢掉）；
 *   ③ 共享模块**零副作用**（不解析 argv、不读库根）—— 它被 8 个 CLI import，带副作用会传染（L-729）；
 *   ④ 行为：对含「作业」子目录的合成库，`indexFiles` 必须跳过它、又能找到正常索引（正反对照）。
 * 退出码 0=PASS / 1=FAIL。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const E = require('./_测试环境.cjs');

let worst = 0, passed = 0;
function A(name, ok, detail) {
  if (ok) { passed++; console.log('[OK]   ' + name + (detail ? '  → ' + detail : '')); }
  else { worst++; console.log('[FAIL] ' + name + (detail ? '  → ' + detail : '')); }
}

const TOOLS = ['_录题入库.mjs', '_作答门禁.mjs', '_配图门禁.mjs', '_着重号门禁.mjs',
  '_变式.mjs', '_题干门禁.mjs', '_盲解复核.mjs', '_标记复习.mjs'];

console.log('测试环境：' + E.describe());

console.log('\n══ ① 8 个工具都已收敛（import 共享模块、无本地副本）══');
for (const f of TOOLS) {
  const s = fs.readFileSync(path.join(E.TOOLS, f), 'utf8');
  const imports = /import\s*\{[^}]*\bindexFiles\b[^}]*\}\s*from\s*'\.\/_题库发现\.mjs'/.test(s);
  const local = /^\s*function indexFiles\s*\(/m.test(s);
  A(f, imports && !local, 'import=' + imports + ' 本地副本=' + local);
}

console.log('\n══ ② 共享模块口径与零副作用 ══');
const gsrc = fs.readFileSync(path.join(E.TOOLS, '_题库发现.mjs'), 'utf8');
A('含「作业/假期」跳过判据（F05 之前入库侧漏的就是这一行）', /作业\|假期/.test(gsrc), '');
A('零副作用（剥注释后判：不解析 argv、不读库根）', (() => {
  const c = gsrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return !/process\.argv/.test(c) && !/libraryRoot\s*\(/.test(c);
})(), '');

console.log('\n══ ③ 行为：跳过「作业」目录、认到正常索引（正反对照）══');
(async () => {
  const mini = E.allocTempDir('gn-libfind-');
  const mk = rel => { const d = path.join(mini, rel); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, '_索引.json'), '{"student":"学生甲","subjects":{}}', 'utf8'); };
  mk(path.join('学生甲', '数学'));
  mk(path.join('学生甲', '国庆假期作业1'));      // 应被跳过
  mk(path.join('_收件箱', '批次'));               // 下划线目录，应被跳过
  const M = await import(pathToFileURL(path.join(E.TOOLS, '_题库发现.mjs')).href);
  const found = M.indexFiles(mini);
  const rel = found.map(f => path.relative(mini, f).split(path.sep).join('/'));
  A('★ 认到正常索引', rel.includes('学生甲/数学/_索引.json'), JSON.stringify(rel));
  A('★ 跳过「作业/假期」目录', !rel.some(r => /假期|作业/.test(r)), JSON.stringify(rel));
  A('★ 跳过 `_` 前缀目录（`_索引.json` 文件本身仍要认）', !rel.some(r => r.startsWith('_收件箱')), JSON.stringify(rel));

  console.log(`\n[neg-libfind-convergence] 断言=${passed} 失败=${worst}`);
  process.exit(worst ? 1 : 0);
})().catch(e => { console.error('用例自身异常：' + (e && e.stack || e)); process.exit(1); });
