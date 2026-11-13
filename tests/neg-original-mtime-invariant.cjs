#!/usr/bin/env node
/**
 * 2-1 阴性自证（方案批次 2-1）：保全库 mtime 单向不变式必须真的会红。
 * 临时假库 + 真台账形状：登记一个对象（addedAt=现在），然后把盘上文件 utimes 碰新到
 * addedAt + 1 小时 ⇒ 体检 --json 必须把该对象点名（hard 红且 detail 提到它）。
 * 反向臂：mtime 早于 addedAt（先有文件后登记）⇒ 必须放行（这是合法历史）。
 * 用完即删，不碰真库。用法：node tests\neg-original-mtime-invariant.cjs
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const E = require('./_测试环境.cjs');

const REPO = path.resolve(__dirname, '..');
const TIJIAN = path.join(REPO, 'src', 'tools', '_体检.mjs');

let fails = 0, asserts = 0;
const A = (n, ok, d) => { asserts++; console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d !== undefined ? '  → ' + String(d).slice(0, 240) : ''}`); if (!ok) fails++; };

const lib = E.allocTempDir('gn-mtime-inv-');
const sha = 'ab'.repeat(32);
const bucket = path.join(lib, '_原图', sha.slice(0, 2));
fs.mkdirSync(bucket, { recursive: true });
const obj = path.join(bucket, sha + '.jpg');
fs.writeFileSync(obj, 'fake-jpeg-bytes');
/* 台账用真库同款形状（objects 字典、大写 sha、addedAt ISO） */
const now = new Date();
const addedAt = new Date(now.getTime() - 60 * 60 * 1000);   // 1 小时前登记
fs.writeFileSync(path.join(lib, '_原图台账.json'), JSON.stringify({
  version: 1,
  note: '阴性对照夹具台账',
  objects: { [sha.toUpperCase()]: { bytes: 16, ext: 'jpg', addedAt: addedAt.toISOString(), sources: ['夹具'], names: ['x.jpg'] } },
}, null, 1) + '\n', 'utf8');
/* 盘上 mtime 也设为登记时刻（对齐态）——随后两臂分别从它出发 */
fs.utimesSync(obj, addedAt, addedAt);

function runHealth() {
  let out = '', code = 0;
  try { out = execFileSync(process.execPath, [TIJIAN, '--json'], { encoding: 'utf8', env: Object.assign({}, process.env, { CTB_DATA: lib }), timeout: 120000, maxBuffer: 64 * 1024 * 1024 }); }
  catch (e) { code = e.status == null ? -1 : e.status; out = String(e.stdout || ''); }
  const i = out.indexOf('{');
  return { code, json: i >= 0 ? JSON.parse(out.slice(i)) : null, out };
}

/* 臂1（对齐）：mtime == addedAt ⇒ 不变式绿 */
{
  const r = runHealth();
  const h = r.json && r.json.hard.find(x => /mtime 不变式/.test(x.name));
  A('臂1 mtime==addedAt ⇒ 不变式绿（对齐态放行）', h && h.ok === true, h && h.detail);
}
/* 臂2（危险向）：mtime 碰新到 addedAt+1h ⇒ 必须红并点名该对象 */
{
  const future = new Date(addedAt.getTime() + 60 * 60 * 1000);
  fs.utimesSync(obj, future, future);
  const r = runHealth();
  const h = r.json && r.json.hard.find(x => /mtime 不变式/.test(x.name));
  A('臂2 mtime 晚于 addedAt（登记后又被写盘）⇒ 不变式红', h && h.ok === false, h && String(h.detail).slice(0, 120));
  A('臂2b 红的 detail 点名了被碰新的对象', h && String(h.detail).includes(sha.slice(0, 12)), h && String(h.detail).slice(0, 80));
}
/* 臂3（合法历史）：mtime 早于 addedAt（先有文件后登记）⇒ 放行 */
{
  const past = new Date(addedAt.getTime() - 5 * 24 * 3600 * 1000);   // 早 5 天
  fs.utimesSync(obj, past, past);
  const r = runHealth();
  const h = r.json && r.json.hard.find(x => /mtime 不变式/.test(x.name));
  A('臂3 mtime 早于 addedAt（先有文件后登记）⇒ 放行（迁移初始化是合法历史）', h && h.ok === true, h && h.detail);
}

console.log('\nRESULT=' + (fails ? 'FAIL(' + fails + ')' : 'PASS') + '  断言=' + asserts + (fails ? ' 失败=' + fails : ''));
process.exit(fails ? 1 : 0);
