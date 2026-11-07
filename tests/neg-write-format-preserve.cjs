#!/usr/bin/env node
/**
 * 拾光小册 · 写入器不许改盘上格式（规范 W6「改盘别改格式」的护栏）
 *
 * 守什么（本轮真实事故）：
 *   `src\tools\_安全写.mjs` 的 `writeJsonAtomic` 过去把缩进**写死默认 2**，而台账的缩进是
 *   **每一份文件自己定的**（`_原卷台账.json` / `_录题任务.json` 刻意用 1 空格）。
 *   后果实测：一次纯路径改写让 `_原卷台账.json` 从 410,280 B 涨到 451,899 B（+41.6 KB）——
 *   内容上只动了几个路径字符串，整篇却被重排，把"我改了什么"淹进 4 万行噪声里。
 *
 * 机制（本轮修法）：`indent` / `newline` **不传**时，`writeJsonAtomic` 沿用**盘上这份文件自己的**格式；
 *   显式传了才按传的来；文件不存在（新文件）时用历史默认（2 空格 + 收尾换行）。
 *
 * 阴性自证（必须有，否则只是"能绿"）：
 *   · 显式传 `indent: 2` 时必须**仍然重排** —— 证明这条判据不是"永远保持格式"的恒真式；
 *   · 把**旧行为**（一律默认 2）在本用例里实际跑一遍，断言它确实会把缩进 1 的文件改成 2。
 *
 * 本用例全部在临时目录里跑，**不碰任何真库**。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const REPO = path.resolve(__dirname, '..');
const SAFE = path.join(REPO, 'src', 'tools', '_安全写.mjs');
const V = require('./_测试环境.cjs');

let worst = 0, passed = 0;
function A(name, ok, detail) {
  if (ok) { passed++; console.log('[OK]   ' + name + (detail ? '  → ' + detail : '')); }
  else { worst++; console.log('[FAIL] ' + name + (detail ? '  → ' + detail : '')); }
}

const INDENT_RE = /\n([ \t]+)"/;
const sample = { a: 1, nested: { b: [1, 2], c: { d: 'x' } } };

(async () => {
  console.log('测试环境：' + V.describe());
  const M = await import(pathToFileURL(SAFE).href);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-fmt-'));
  const at = n => path.join(root, n);

  /* ---------- 1) detectJsonFormat 的基本行为 ---------- */
  A('detectJsonFormat：文件不存在 ⇒ null', M.detectJsonFormat(at('nope.json')) === null);
  fs.writeFileSync(at('empty.json'), '');
  A('detectJsonFormat：空文件 ⇒ null', M.detectJsonFormat(at('empty.json')) === null);
  fs.writeFileSync(at('i1.json'), JSON.stringify(sample, null, 1) + '\n');
  A('detectJsonFormat：量得出缩进 1', M.detectJsonFormat(at('i1.json')).indent === 1);
  fs.writeFileSync(at('tab.json'), JSON.stringify(sample, null, '\t') + '\n');
  A('detectJsonFormat：量得出 tab 缩进', M.detectJsonFormat(at('tab.json')).indent === '\t');
  fs.writeFileSync(at('compact.json'), JSON.stringify(sample));
  A('detectJsonFormat：紧凑文件 ⇒ 缩进 0', M.detectJsonFormat(at('compact.json')).indent === 0);
  A('detectJsonFormat：紧凑文件无收尾换行 ⇒ newline=false', M.detectJsonFormat(at('compact.json')).newline === false);

  /* ---------- 2) ★ 核心：不传 indent 时沿用盘上格式 ---------- */
  const cases = [
    ['缩进 1', 1, JSON.stringify(sample, null, 1) + '\n'],
    ['缩进 4', 4, JSON.stringify(sample, null, 4) + '\n'],
    ['tab 缩进', '\t', JSON.stringify(sample, null, '\t') + '\n'],
    ['紧凑（无缩进）', 0, JSON.stringify(sample)],
  ];
  for (const [idx, [label, want, seeded]] of cases.entries()) {
    const f = at('keep-' + idx + '.json');
    fs.writeFileSync(f, seeded);
    M.writeJsonAtomic(f, { ...sample, touched: true });        // 不传 indent
    const after = M.detectJsonFormat(f);
    A(`★ 不传 indent：盘上是「${label}」⇒ 写回仍是「${label}」`,
      after.indent === want, `写成 ${JSON.stringify(after.indent)}`);
    A(`   同一份文件的内容确实被写进去了（不是"没写"）`,
      JSON.parse(fs.readFileSync(f, 'utf8')).touched === true);
  }

  /* ---------- 3) 收尾换行也沿用 ---------- */
  const fNoNl = at('nonl.json');
  fs.writeFileSync(fNoNl, JSON.stringify(sample, null, 2));   // 无收尾换行
  M.writeJsonAtomic(fNoNl, { ...sample, touched: true });
  A('★ 盘上无收尾换行 ⇒ 写回仍不加换行', !fs.readFileSync(fNoNl, 'utf8').endsWith('\n'));
  const fNl = at('nl.json');
  fs.writeFileSync(fNl, JSON.stringify(sample, null, 2) + '\n');
  M.writeJsonAtomic(fNl, { ...sample, touched: true });
  A('盘上有收尾换行 ⇒ 写回仍带换行', fs.readFileSync(fNl, 'utf8').endsWith('\n'));

  /* ---------- 4) 新文件用历史默认 ---------- */
  const fNew = at('brand-new.json');
  M.writeJsonAtomic(fNew, sample);
  A('新文件 ⇒ 默认缩进 2', M.detectJsonFormat(fNew).indent === 2);
  A('新文件 ⇒ 带收尾换行', fs.readFileSync(fNew, 'utf8').endsWith('\n'));

  /* ---------- 5) 阴性自证 ①：显式传 indent 必须仍然生效（判据不是恒真） ---------- */
  const fForce = at('force.json');
  fs.writeFileSync(fForce, JSON.stringify(sample, null, 1) + '\n');
  M.writeJsonAtomic(fForce, { ...sample, touched: true }, { indent: 2 });
  A('★ 阴性自证：显式 indent:2 ⇒ 确实被重排成 2（判据不是"永远保持"）',
    M.detectJsonFormat(fForce).indent === 2);

  /* ---------- 6) 阴性自证 ②：旧行为确实会改格式（这条判据抓的是真病） ---------- */
  const fOld = at('old-behavior.json');
  fs.writeFileSync(fOld, JSON.stringify(sample, null, 1) + '\n');
  const legacy = JSON.stringify({ ...sample, touched: true }, null, 2) + '\n';   // 旧写法：写死 2
  fs.writeFileSync(fOld, legacy);
  A('★ 阴性自证：把"写死 2"的旧行为跑一遍 ⇒ 缩进 1 的文件确实变成 2（病根是真的）',
    M.detectJsonFormat(fOld).indent === 2 && M.detectJsonFormat(fOld).indent !== 1);

  /* ---------- 7) 格式变化不改内容 ---------- */
  const fEq = at('eq.json');
  const doc = { z: 1, a: { b: '中文字符串', c: [1, { d: null }] } };
  fs.writeFileSync(fEq, JSON.stringify(doc, null, 1) + '\n');
  M.writeJsonAtomic(fEq, doc);
  A('格式沿用也不改内容（JSON.parse 深等）',
    JSON.stringify(JSON.parse(fs.readFileSync(fEq, 'utf8'))) === JSON.stringify(doc));
  A('且键序未被改动（不是"重排键"）',
    fs.readFileSync(fEq, 'utf8').indexOf('"z"') < fs.readFileSync(fEq, 'utf8').indexOf('"a"'));

  /* ---------- 8) 与 backup 共存（别为了保格式把备份弄丢） ---------- */
  const fBk = at('with-backup.json');
  fs.writeFileSync(fBk, JSON.stringify(sample, null, 1) + '\n');
  M.writeJsonAtomic(fBk, { ...sample, touched: true }, { backup: true });
  const baks = fs.readdirSync(path.join(root, '_备份-真源')).filter(n => /^with-backup-\d{8}-\d+\.json$/.test(n));
  A('开了 backup 也不影响保格式', M.detectJsonFormat(fBk).indent === 1);
  A('开了 backup 确实留了底（落在 _备份-真源\\）', baks.length >= 1, baks.join(','));

  fs.rmSync(root, { recursive: true, force: true });
  console.log('\n──────────────────────────────');
  console.log(worst === 0 ? 'RESULT=PASS 断言=' + passed : 'RESULT=FAIL 断言=' + passed + ' 失败=' + worst);
  process.exit(worst === 0 ? 0 : 1);
})().catch(e => {
  console.error('✖ 用例自身异常：' + (e && e.stack || e));
  process.exit(1);
});
