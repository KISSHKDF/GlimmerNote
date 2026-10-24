#!/usr/bin/env node
/* ★ 门禁（2026-10-16）：复习字段形状——reviews 数组元素必须全为对象，复习字段不得整体缺失。
 *
 * 事故锚点（P20261016 启动崩溃）：化学批次 37 张新卡（C0016-C0053）入库时没带 reviews/reviewCount/
 * passStreak 等复习字段，_生成首页.ps1 的 `@($it.reviews)` 把缺失字段序列化成 "reviews":[null]，
 * v2 启动 M.heatValues() 读 null.date 即崩 → 「错题本启动不了」（用户实测三次，全局错误日志留痕）。
 *
 * 防线分层（本测试守数据层这一层）：
 *   ① 入库：卡片必须带全复习字段（本测试断言 2）；
 *   ② 生成器：_生成首页.ps1 对缺失字段给默认值（已修，Where-Object 剔 null）；
 *   ③ 消费端：v2 model.js/bank.js 对 reviews 元素判空（已修，兜底）。
 *
 * 阴性自证：检测器必须对合成坏卡报警、对好卡放行——证明它不是空转的检查。
 */
const fs = require('fs');
const path = require('path');
/* ★ 2026-10-23 程序与数据分家：工具在 src\tools\，数据在库根（见 tests\_测试环境.cjs） */
const E = require('./_测试环境.cjs');
const ROOT = path.resolve(__dirname, '..');

const FILES = [
  { file: E.lib('_状态.json'), kind: 'state' },
  /* ★ 2026-10-24 B-09：索引动态发现（原写死真实库的两个索引路径） */
  ...E.findIndexes().map(f => ({ file: E.lib(f), kind: 'index' })),
];
const NEED = ['reviews', 'reviewCount', 'passStreak'];   // 缺任何一个都是生成器 null 放大的弹药

function* walkIndex(j) {
  for (const [name, sub] of Object.entries(j.subjects || {})) for (const it of (sub && sub.items) || []) yield ['索引/' + name, it];
}
function* walkState(j) {
  for (const kid of j.data || []) for (const sub of (kid.subjects || [])) for (const it of (sub.items || [])) yield ['状态/' + kid.name + '/' + sub.name, it];
}
/* 检测器（纯函数，供阴性自证与实扫共用）：返回问题列表 */
function detect(it) {
  const bad = [];
  if (Array.isArray(it.reviews)) {
    const n = it.reviews.filter(r => r && typeof r === 'object').length;
    if (n !== it.reviews.length) bad.push(`reviews 含 ${it.reviews.length - n} 个 null/非对象元素`);
  }
  for (const k of NEED) if (it[k] === undefined) bad.push('缺字段 ' + k);
  return bad;
}

function A(cond, msg) { if (!cond) { console.log('FAIL ' + msg); process.exit(1); } }

/* ---------- 阴性自证：检测器必须能抓坏卡、放好卡 ---------- */
A(detect({ id: 'X', reviews: [null, { date: '2026-10-16', result: '对' }], reviewCount: 0, passStreak: 0 }).length === 1, '自证：合成坏卡（reviews 含 null）必须被抓到');
A(detect({ id: 'X', reviews: [], reviewCount: 0, passStreak: 0 }).length === 0, '自证：好卡必须放行');
A(detect({ id: 'X' }).length === NEED.length, '自证：全字段缺失必须逐项报警');
console.log('PASS 阴性自证（检测器抓坏/放好各就位）');

/* ---------- 实扫三个真源 ---------- */
let problems = 0, cards = 0;
for (const { file, kind } of FILES) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  for (const [where, it] of (kind === 'state' ? walkState(j) : walkIndex(j))) {
    if (!it || typeof it !== 'object' || !it.id) continue;
    cards++;
    const bad = detect(it);
    if (bad.length) { problems++; if (problems <= 20) console.log('FAIL ' + where + ' · ' + it.id + '：' + bad.join('；')); }
  }
}
A(problems === 0, '数据真源存在 ' + problems + ' 张复习字段形状不合规的卡（上方明细）——入库/生成器修好前 v2 随时可能再崩');
console.log('PASS 复习字段形状：' + FILES.length + ' 个真源、' + cards + ' 张卡、0 违规');
process.exit(0);
