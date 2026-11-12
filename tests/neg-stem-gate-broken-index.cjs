#!/usr/bin/env node
/**
 * neg-stem-gate-broken-index.cjs —— 题干门禁「索引读不出 ⇒ 不许报绿」（2026-11-12 建）
 *
 * 事故：`_题干门禁.mjs` 的 `allCards()` 里是 `try { … } catch { continue; }` ——
 *   `_索引.json` 读不出时收集到的卡为 0，`judgeLibrary` 于是 `rows=[]` / `blocked=[]`
 *   ⇒ **ok: true**，而 `_体检.mjs` 会把它当**硬门禁**汇报为
 *   「题干门禁（可读性）✔ 扫描 0 张，阻断 0」—— 一份全绿但什么都没查的报告。
 *   兄弟门禁 `_作答门禁.mjs` 用的是会响亮抛错的 `readJsonStrict`，两处口径不一致；
 *   CHANGELOG 也早就为同类事故定过规矩：**一份都没扫到不得当作通过**。
 *
 * 本用例四条判据（全部在 %TEMP% 合成库里跑，零库依赖、不碰真源）：
 *   ① 合法库（1 张卡）⇒ ok:true（修完不许把好库判红）；
 *   ② 合法库 + 一份**坏 JSON** 的 `_索引.json` ⇒ ok:false、indexErrors=1、problems 点名该文件；
 *   ③ 索引能解析但**没有任何 items/subjects** ⇒ ok:false（空真即缺陷）；
 *   ④ 空库（压根没有索引）⇒ ok:true（不许误伤"还没建库"）。
 *   阴性自证：把 catch 改回 `continue`（变异副本）⇒ ② 必须变回 ok:true（证明判据有牙齿）。
 * 退出码 0=PASS / 1=FAIL。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const E = require('./_测试环境.cjs');

let worst = 0, passed = 0;
function A(name, ok, detail) {
  if (ok) { passed++; console.log('[OK]   ' + name + (detail ? '  → ' + detail : '')); }
  else { worst++; console.log('[FAIL] ' + name + (detail ? '  → ' + detail : '')); }
}

/* ⚠ 依赖要跟住：`_题干门禁.mjs` 从 2026-11-12 起还 import `_划线.mjs`（零副作用共享判据）——
   副本目录缺它会在 `ModuleJob.link` 阶段直接失败（本次实测踩到）。 */
const TOOL_FILES = ['_题干门禁.mjs', '_库根.mjs', '_参数.mjs', '_划线.mjs'];
const MUTATE_FROM = "catch (e) { indexErrors.push({ file: f, error: String((e && e.message) || e) }); continue; }";
const MUTATE_TO = 'catch { continue; }';

/** 造一份合成库 + 一份（可选变异的）工具副本；返回 { mini, importTool } */
function setup(tag, opts) {
  const o = opts || {};
  const mini = E.allocTempDir('gn-stem-idx-' + tag + '-');
  const toolsDir = path.join(mini, '_tools');
  fs.mkdirSync(toolsDir, { recursive: true });
  let hit = 0;
  for (const f of TOOL_FILES) {
    let src = fs.readFileSync(path.join(E.TOOLS, f), 'utf8');
    if (f === '_题干门禁.mjs' && o.mutate) { const b = src; src = o.mutate(src); if (src !== b) hit++; }
    fs.writeFileSync(path.join(toolsDir, f), src, 'utf8');
  }
  const libDir = path.join(mini, '库');
  fs.mkdirSync(libDir, { recursive: true });
  if (!o.noIndex) {
    const cardDir = path.join(libDir, '学生甲', '数学', 'M0001-测试');
    fs.mkdirSync(cardDir, { recursive: true });
    fs.writeFileSync(path.join(cardDir, '题干.html'), '<div class="stem">计算 1+1。</div>\n', 'utf8');
    const idx = {
      student: '学生甲',
      subjects: { '数学': { items: [{ id: 'M0001', dir: 'M0001-测试', question: '计算 1+1。' }] } },
    };
    fs.writeFileSync(path.join(libDir, '学生甲', '数学', '_索引.json'), JSON.stringify(idx, null, 1), 'utf8');
  }
  if (o.brokenIndex) {
    const d = path.join(libDir, '学生乙', '英语');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, '_索引.json'), '{"student":"学生乙","subjects":{  <<< 这不是 JSON\n', 'utf8');
  }
  if (o.emptyIndex) {
    const d = path.join(libDir, '学生丙', '语文');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, '_索引.json'), JSON.stringify({ student: '学生丙', subjects: {} }), 'utf8');
  }
  return {
    mini, libDir, hit,
    /* 每次用**独立 URL** 导入（模块缓存按 URL 走；不同副本目录 ⇒ 不同 URL ⇒ 不吃缓存） */
    importTool: () => {
      process.env.CTB_DATA = libDir;
      return import(pathToFileURL(path.join(toolsDir, '_题干门禁.mjs')).href);
    },
  };
}

(async () => {
  console.log('测试环境：' + E.describe());

  console.log('\n══ ① 合法库：不许把好库判红 ══');
  {
    const t = setup('ok');
    const G = await t.importTool();
    const lib = G.judgeLibrary(t.libDir);
    A('合法库 ok:true', lib.ok === true, 'ok=' + lib.ok + ' total=' + lib.stats.total);
    A('扫到 1 张卡、索引文件 1 份、0 读失败',
      lib.stats.total === 1 && lib.stats.indexFiles === 1 && lib.stats.indexErrors === 0,
      JSON.stringify(lib.stats));
  }

  console.log('\n══ ② 坏 JSON 索引：必须判红并点名 ══');
  {
    const t = setup('broken', { brokenIndex: true });
    const G = await t.importTool();
    const lib = G.judgeLibrary(t.libDir);
    A('★ ok:false（修前是 true —— 门禁静默失效）', lib.ok === false, 'ok=' + lib.ok);
    A('★ indexErrors 记到 1 条且带文件名', lib.stats.indexErrors === 1 &&
      String(lib.indexErrors[0].file).includes('_索引.json'), JSON.stringify(lib.indexErrors.map(e => e.file)));
    A('  好卡仍被扫到（不是"整库变 0 张"）', lib.stats.total === 1, 'total=' + lib.stats.total);
  }

  console.log('\n══ ③ 空真：能解析但一张卡都没有 ══');
  {
    /* 夹具要"只有空索引、没有好卡"，否则 total>0 就触发不到空真判据（第一版就是这么写错的） */
    const t = setup('empty', { emptyIndex: true, noIndex: true });
    const G = await t.importTool();
    const lib = G.judgeLibrary(t.libDir);
    A('★ 有索引却 0 张卡 ⇒ ok:false（空真不得当作通过）',
      lib.stats.total === 0 && lib.stats.indexFiles >= 1 && lib.ok === false,
      JSON.stringify({ ok: lib.ok, total: lib.stats.total, indexFiles: lib.stats.indexFiles }));
  }

  console.log('\n══ ④ 空库：不许误伤"还没建库" ══');
  {
    const t = setup('noidx', { noIndex: true });
    const G = await t.importTool();
    const lib = G.judgeLibrary(t.libDir);
    A('无索引文件 ⇒ ok:true、indexFiles=0', lib.ok === true && lib.stats.indexFiles === 0,
      JSON.stringify({ ok: lib.ok, indexFiles: lib.stats.indexFiles }));
  }

  console.log('\n══ ⑤ 阴性自证：把 catch 改回 continue，② 必须变回绿 ══');
  {
    const t = setup('mut', { brokenIndex: true, mutate: s => s.replace(MUTATE_FROM, MUTATE_TO) });
    A('变异点命中恰好 1 处', t.hit === 1, 'hit=' + t.hit);
    const G = await t.importTool();
    const lib = G.judgeLibrary(t.libDir);
    A('★ 掏掉修复后同一个坏库变回 ok:true（判据确实有牙齿）', lib.ok === true && lib.stats.indexErrors === 0,
      JSON.stringify({ ok: lib.ok, indexErrors: lib.stats.indexErrors }));
  }

  console.log(`\n[neg-stem-gate-broken-index] 断言=${passed} 失败=${worst}`);
  process.exit(worst ? 1 : 0);
})().catch(e => { console.error('用例自身异常：' + (e && e.stack || e)); process.exit(1); });
