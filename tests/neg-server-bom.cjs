#!/usr/bin/env node
/**
 * BUG-15 断言（2026-10-11）：BOM 剥离必须一致 —— 「构造带 BOM 的文件 → 读取必须成功」。
 *
 * 审计：`_状态刷新.mjs:25`、`_闭环稽核.mjs:53/138`、`_生成队列.mjs:13` 用
 *   `JSON.parse(fs.readFileSync(p,'utf8'))`，**不剥 BOM**；而 `_待确认.mjs`/`_标记复习.mjs`/
 *   `_盲解复核.mjs`/`_配图门禁.mjs`/`_笔形.mjs` 都剥。`_状态刷新.mjs` 是运行中服务端
 *   **每次 `GET /api/state`** 的必经路径 ⇒ `_状态.json` 被带 BOM 的通道改写一次就 500。
 *
 * 断言分三层（缺一层就等于只测了"我以为"）：
 *   ① 阴性自证：**旧写法**对带 BOM 文本必须抛错（证明这条断言有牙齿，不是恒真）；
 *   ② 单元：共享读底座 `_安全写.mjs readJsonStrict` 对带 BOM 文件必须成功；
 *   ③ 端到端（真实路径）：把 BOM 注进真 `_状态.json` → 跑 `node _状态刷新.mjs pending` 必须
 *      **成功退出且 stdout 是完整状态包**（改前这里必抛 → 服务端 500）。跑完按字节还原。
 *      另加源码级断言：这 4 个文件里不得再出现裸 `JSON.parse(fs.readFileSync(`。
 *
 * 只碰 `_状态.json`（生成物、可再生 + 逐字节还原）与 `_probe\` 下的临时文件；
 * **不碰任何真源**（`_待确认.json`/`_索引.json`/各台账）。
 * 退出码 0=全绿。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { ROOT, counter, stripComments, fileUrl } = require('./neg-server-lib.cjs');

/* ★ 2026-10-23 程序与数据分家：工具在 src\tools\，数据在库根（见 tests\_测试环境.cjs） */
const E = require('./_测试环境.cjs');
const { A, end } = counter();
const STATE = E.lib('_状态.json');
/* ★ 2026-10-23：中转目录放**库内**（工具按库根读写），别放仓库根 —— 那儿已经没有数据了。 */
const PROBE = E.lib('_probe');
const TOOL = E.tool('_状态刷新.mjs');
const BOM = '\uFEFF';

fs.mkdirSync(PROBE, { recursive: true });
const tmpBom = path.join(PROBE, 'neg-server-bom-probe.json');

/* ---------- ① 阴性自证：旧写法必须失败（否则本断言没有牙齿） ---------- */
console.log('══ ① 阴性自证：裸 JSON.parse 不容忍 BOM ══');
{
  fs.writeFileSync(tmpBom, BOM + '{"items":[],"open":0}', 'utf8');
  const raw = fs.readFileSync(tmpBom, 'utf8');
  A('构造出的探针文件头 1 字符确实是 U+FEFF', raw.charCodeAt(0) === 0xFEFF, '0x' + raw.charCodeAt(0).toString(16));
  let oldThrew = false, oldMsg = '';
  try { JSON.parse(fs.readFileSync(tmpBom, 'utf8')); } catch (e) { oldThrew = true; oldMsg = e.message; }
  A('改前写法（裸 JSON.parse）在该文件上抛错（自证断言有牙齿）', oldThrew, oldMsg.slice(0, 90));
  const stripped = raw.replace(/^\uFEFF/, '');
  A('剥 BOM 后同一内容可解析', (() => { try { JSON.parse(stripped); return true; } catch (e) { return false; } })());
}

/* ---------- ② 单元：共享读底座（各工具现在的唯一读法） ---------- */
console.log('\n══ ② 共享读底座 _安全写.mjs readJsonStrict ══');
{
  const script = [
    "import { readJsonStrict } from " + JSON.stringify(fileUrl(E.tool('_安全写.mjs'))) + ";",
    "const j = readJsonStrict(" + JSON.stringify(tmpBom) + ", { label: '探针' });",
    "console.log(JSON.stringify({ ok: true, open: j.open }));",
  ].join('\n');
  let out = '', code = 0;
  try {
    out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  } catch (e) { code = e.status; out = String(e.stderr || e.message); }
  A('readJsonStrict 读带 BOM 文件成功', code === 0 && /"ok":true/.test(out), (out || '').trim().slice(0, 120));
  A('读出的内容正确（open=0）', /"open":0/.test(out));
}

/* ---------- ③ 端到端：临时库里的 _状态.json 注 BOM → `_状态刷新.mjs pending` 必须成功 ----------
 * ★ 2026-10-24 审计修正（这条门禁此前**永久红**，见 DEFECT-REGISTRY D-045）：
 *   原实现有两个毛病：
 *     ① 调工具时**没传 CTB_DATA**。程序与数据分家后 `_状态刷新.mjs` 的库根由
 *        `libraryRoot()` 决定，不传 CTB_DATA 就落到工具自身目录 ⇒ 恒报
 *        「[安全读] 读不到 _状态.json」⇒ 断言①永久 FAIL，整条 quick 门禁永久红。
 *     ② 它把 BOM 注进**真库**的 `_状态.json`（虽然 finally 还原）。项目自己的
 *        `assertWritableLib()` 就是禁止这么干的，测试却绕过了它。
 *   现在改为：先把库复制到临时目录（makeTempLib 只取数据文件），在临时库上注 BOM、
 *   跑工具、断言，全程不碰真库。既修了假红，也让这条测试在新克隆上能跑。
 */
console.log('\n══ ③ 端到端：临时库 _状态.json 带 BOM 时 _状态刷新.mjs 仍能跑通 ══');
{
  const tmp = E.makeTempLib([], {});
  const tmpState = path.join(tmp, '_状态.json');
  let runErr = '', runOut = '';
  let injected = false;
  try {
    const exists = fs.existsSync(tmpState);
    A('临时库里有 _状态.json（前置）', exists, exists ? (fs.statSync(tmpState).size + ' B') : '⚠ 真库里没有 _状态.json');
    if (exists) {
      const orig = fs.readFileSync(tmpState);
      A('复制过来的 _状态.json 无 BOM（前置）', orig[0] !== 0xEF, '首字节 0x' + orig[0].toString(16));
      fs.writeFileSync(tmpState, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), orig]));
      injected = true;
      const onDisk = fs.readFileSync(tmpState);
      A('已注入 UTF-8 BOM（EF BB BF）', onDisk[0] === 0xEF && onDisk[1] === 0xBB && onDisk[2] === 0xBF);

      const r = E.runToolSync('_状态刷新.mjs', ['pending'], { data: tmp });
      runOut = r.out; runErr = r.err;

      A('`node _状态刷新.mjs pending` 在带 BOM 的 _状态.json 上成功退出',
        r.code === 0, (runErr || '').split('\n').slice(0, 2).join(' ').slice(0, 160) || ('exit=' + r.code));

      let parsed = null;
      try { parsed = JSON.parse(runOut); } catch (e) { }
      A('stdout 是完整状态包（可解析且含 pending/data）',
        !!parsed && !!parsed.pending && !!parsed.data,
        parsed ? ('pending.open=' + parsed.pending.open + ' students=' + parsed.data.length) : ('前 80 字:' + String(runOut).slice(0, 80)));

      A('刷新后落盘的 _状态.json 不再带 BOM（剥 BOM 生效的副产品）',
        fs.existsSync(tmpState) && fs.readFileSync(tmpState)[0] !== 0xEF);
    }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
  }
  A('临时库已清理（真库全程未触碰）', !fs.existsSync(tmp));
  try { fs.unlinkSync(tmpBom); } catch (e) { }
}

/* ---------- ④ 源码级：4 个读取点不得再有裸 JSON.parse(fs.readFileSync( ---------- */
console.log('\n══ ④ 源码级：裸 JSON.parse(fs.readFileSync( 必须清零 ══');
{
  const files = ['_状态刷新.mjs', '_闭环稽核.mjs', '_生成队列.mjs', '_服务端.mjs'];
  for (const f of files) {
    const src = stripComments(fs.readFileSync(E.tool(f), 'utf8'));
    const hits = (src.match(/JSON\.parse\(\s*fs\.readFileSync\(/g) || []).length;
    A(f + ' 去注释后无裸 JSON.parse(fs.readFileSync(', hits === 0, '命中 ' + hits + ' 处');
  }
  const ref = fs.readFileSync(E.tool('_状态刷新.mjs'), 'utf8');
  A('_状态刷新.mjs 走 readJsonStrict（共享底座）', /readJsonStrict/.test(ref));
  const close = fs.readFileSync(E.tool('_闭环稽核.mjs'), 'utf8');
  A('_闭环稽核.mjs 走 readJsonStrict（共享底座）', /readJsonStrict/.test(close));
}

process.exit(end('BUG-15 BOM 一致性'));
