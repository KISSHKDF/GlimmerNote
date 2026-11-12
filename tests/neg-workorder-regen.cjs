#!/usr/bin/env node
/**
 * neg-workorder-regen.cjs —— 定位工单必须是**可重算的派生物**（2026-11-13 立，批次 4 收尾）
 *
 * 事故形态（改前）：库根的 `_原卷待定位-按批次.md`（404 条 / 130+ KB）是一次性脚本的产物。
 * 它**没有生成器** ⇒ 定位进展一变它就悄悄过期，而"派生物可随时重算、不是真源"是本仓数据区纪律（规范 F4）。
 * 更坏的形态是：没有生成器 ⇒ 下次想刷新只能再写一个一次性脚本 ⇒ 每人各写一份、结构各不同。
 *
 * 现在：`node src\tools\_原卷台账.mjs 工单` 生成它，走 `writeTextAtomic`（原子写）+ 工具已持库锁。
 * 本用例**真跑**（临时库上），守：
 *   ① 产出落在**库根**、含三大区块（批次总览 / 分学科统计 / 明细）；
 *   ② 明细条数与工具自报的"未定位 N 条"**一致**（数字与正文不许各说各话）；
 *   ③ **可重算**：连跑两次都成功、条数不变（幂等；只有"生成时间"那一行会变）；
 *   ④ 没有未定位时不硬造文件（说"无需生成"）。
 * 另守接线（case / 帮助 / writeTextAtomic import）与阴性自证。
 * 退出码 0=PASS / 1=FAIL。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const E = require('./_测试环境.cjs');

let fails = 0, total = 0;
const A = (n, ok, d) => { total++; console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d !== undefined ? '  → ' + d : ''}`); if (!ok) fails++; };

const LIB = E.makeTempLib(null, { copyCardFiles: true });
const lib = (...p) => path.join(LIB, ...p);
const TOOL = E.tool('_原卷台账.mjs');
const run = () => {
  try {
    const out = execFileSync(process.execPath, [TOOL, '工单'],
      { encoding: 'utf8', maxBuffer: 64e6, env: Object.assign({}, process.env, { CTB_DATA: LIB }), stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out: String(out) };
  } catch (e) { return { code: e.status == null ? 1 : e.status, out: String((e.stdout || '') + (e.stderr || '')) }; }
};

console.log('测试环境：' + E.describe());

/* 制造"有未定位"的局面：临时库若已有 `_原卷台账.json`，就把其中一条的 page 抹掉；
   没有这个文件时，工具本身会把所有卡当未定位（等价于"全新库"）——两种都算有效前置。 */
const ledgerFile = lib('_原卷台账.json');
let seeded = '(无台账文件 ⇒ 全部视为未定位)';
if (fs.existsSync(ledgerFile)) {
  const doc = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  const keys = Object.keys(doc.cards || {});
  if (keys.length) { delete doc.cards[keys[0]].page; fs.writeFileSync(ledgerFile, JSON.stringify(doc, null, 1), 'utf8'); seeded = '抹掉 ' + keys[0] + ' 的 page'; }
} else { seeded = '(无台账文件 ⇒ 全部视为未定位)'; }
console.log('前置：' + seeded);

const OUT = lib('_原卷待定位-按批次.md');
if (fs.existsSync(OUT)) fs.unlinkSync(OUT);   // 干净起点

console.log('\n══ ① 真跑：产出落在库根、含三大区块 ══');
const r1 = run();
A('★ 命令成功', r1.code === 0, 'exit=' + r1.code + ' ' + r1.out.trim().split('\n').slice(-1)[0]);
A('★ 产出落在**库根**（不是过程目录）', fs.existsSync(OUT), OUT.replace(LIB, '<库根>'));
const md = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
A('★ 有「一、批次总览」', /## 一、批次总览/.test(md), '');
A('★ 有「二、分学科统计」', /## 二、分学科统计/.test(md), '');
A('★ 有「三、明细（按批次）」', /## 三、明细（按批次）/.test(md), '');
A('★ 头部自称条数与工具输出的条数一致（数字与正文不许各说各话）',
  (() => {
    const m = r1.out.match(/未定位\s+(\d+)\s+条/);
    const h = md.match(/未定位条目（\*\*(\d+) 条\*\*）/);
    return !!m && !!h && m[1] === h[1];
  })(), (r1.out.match(/未定位\s+\d+\s+条/) || [''])[0]);
A('★ 写了"怎么看图定位"的指路（光有清单不够，得知道去哪找页）',
  /定位单 --per \d+/.test(md) && /带网格/.test(md), '');
A('★ 写了回填命令与验收方式（照着就能干活）',
  /回填 --key/.test(md) && /门禁/.test(md), '');

console.log('\n══ ② 明细条数 == 自报条数 ══');
{
  const m = r1.out.match(/未定位\s+(\d+)\s+条/);
  const declared = m ? +m[1] : -1;
  const lines = (md.match(/^- \*\*[^*]+\*\* ｜/gm) || []).length;
  A('★ 明细行数 == 未定位条数', declared > 0 && lines === declared, '自报 ' + declared + ' / 明细 ' + lines);
}

console.log('\n══ ③ 可重算（幂等；只有生成时间那行会变）══');
{
  const before = fs.readFileSync(OUT, 'utf8');
  const r2 = run();
  A('★ 第二次跑仍成功', r2.code === 0, 'exit=' + r2.code);
  const after = fs.readFileSync(OUT, 'utf8');
  const strip = s => s.replace(/> 生成：[^\n]*\n/, '> 生成：<时间>\n');
  A('★ 除「生成：」那一行外**逐字节相同**（重算不会漂内容）', strip(before) === strip(after), '');
  A('★ 明细条数不变', (before.match(/^- \*\*[^*]+\*\* ｜/gm) || []).length === (after.match(/^- \*\*[^*]+\*\* ｜/gm) || []).length, '');
}

console.log('\n══ ④ 接线与负边界 ══');
{
  const src = fs.readFileSync(TOOL, 'utf8');
  A('★ 动作已挂（case 工单）', /cmd === '工单'\)\s*workOrder\(\)/.test(src), '');
  A('★ 帮助里有这一行', /_原卷台账\.mjs 工单/.test(src), '');
  A('★ 走 `writeTextAtomic`（原子写，不是裸 writeFileSync）', /writeTextAtomic\(out,/.test(src), '');
  A('★ 且已 import writeTextAtomic（漏 import 会在运行时才炸 —— 语法检查抓不到）',
    /import \{[^}]*writeTextAtomic[^}]*\} from '\.\/_安全写\.mjs'/.test(src), '');
  A('★ 未定位为 0 时"说无需生成"而不是造一个空文件',
    /全部卡片都已定位到整页，无需生成工单/.test(src), '');
  A('★ 批次名解析不出时不编名字（写「(无批次名)」）', /\(无批次名\)/.test(src), '');
}

console.log('\n══ ⑤ 阴性自证：掏掉明细区块 ⇒ ① 必须红 ══');
{
  const src = fs.readFileSync(TOOL, 'utf8');
  const broken = src.replace("L.push('## 三、明细（按批次）', '');", "L.push('## 三、(区块被掏掉)', '');");
  A('变异点命中', broken !== src, '');
  A('★ 掏掉后「三、明细（按批次）」不再出现（这条判据确实有牙齿）', !/## 三、明细（按批次）/.test(broken), '');
}

console.log(`\nRESULT=${fails ? 'FAIL(' + fails + ')' : 'PASS'}  断言=${total}  通过=${total - fails}  失败=${fails}`);
process.exit(fails ? 1 : 0);
