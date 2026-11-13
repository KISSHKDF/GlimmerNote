#!/usr/bin/env node
/**
 * neg-readme-structure.cjs —— README 的**用户视角结构**与链接完整性（2026-11-12 立，批次 3）
 *
 * 事故形态（改前）：README 400 行 / 22 节，但顺序是"作者的顺序"——
 *   · 用户最需要的一节「录题四步」被挂在 `## 常用命令`（打包/部署/配方）**下面**；
 *   · 「我的数据在哪、怎么备份」根本没有独立章节（散在开发者视角的"三区模型"里）；
 *   · 开发者命令夹在用户内容中间，家长打开就被 `release\*.zip` 之类的名词劝退。
 *
 * 本用例守四件事（零依赖：只读 README）：
 *   ① 一级标题只有 1 个（分区不许用 `#`；改前那次重排就一度插进第二个一级标题）；
 *   ② README 里每个 `](#锚点)` 都能在**同文件**找到对应标题——锚点规则照 GitHub
 *      （转小写、去标点、空格转连字符）。断链的目录链接等于把人送到 404；
 *   ③ 用户区在开发者区之前：`三分钟上手` / `录题四步` / `我的数据在哪、怎么备份`
 *      的出现行号必须小于 `## 给开发者`；
 *   ④ `## 新克隆自检（拿到源码后按这个顺序）` 还在（`tests\run.mjs` 的输出文案按这个名字指路）。
 * 退出码 0=PASS / 1=FAIL。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const E = require('./_测试环境.cjs');

let worst = 0, passed = 0;
function A(name, ok, detail) {
  if (ok) { passed++; console.log('[OK]   ' + name + (detail ? '  → ' + detail : '')); }
  else { worst++; console.log('[FAIL] ' + name + (detail ? '  → ' + detail : '')); }
}

const P = path.join(E.REPO, 'README.md');
const lines = fs.readFileSync(P, 'utf8').split('\n');

/* 去掉 fenced code block 里的内容（README 的代码块里有大量以 `#` 开头的 shell 注释，
   不跳过会把它们当成标题 —— 这正是"朴素正则被骗"的同族，见 L-869）。 */
const prose = [];
let inFence = false;
for (const l of lines) {
  if (/^\s*```/.test(l)) { inFence = !inFence; prose.push(''); continue; }
  prose.push(inFence ? '' : l);
}

/** GitHub 风格锚点（中文保留、标点去掉、空格转连字符、转小写） */
const anchorOf = t => t.trim()
  .replace(/[（）()【】「」《》〈〉:：，,。.！!？?、；;“”"'`]/g, '')
  .replace(/\s+/g, '-')
  .toLowerCase();

console.log('测试环境：' + E.describe());

console.log('\n══ ① 一级标题唯一 ══');
{
  const h1 = prose.map((l, i) => [l, i]).filter(([l]) => /^# /.test(l));
  A('★ README 只有一个一级标题（文档标题本身）', h1.length === 1,
    h1.map(([l, i]) => 'L' + (i + 1) + ':' + l.trim()).join(' | '));
}

console.log('\n══ ② 内部锚点链接都能落地 ══');
{
  const heads = new Set();
  const hs = prose.filter(l => /^#{1,6} /.test(l));
  for (const l of hs) heads.add(anchorOf(l.replace(/^#{1,6} /, '')));
  const links = [...new Set((prose.join('\n').match(/\]\(#([^)]+)\)/g) || []).map(s => s.replace(/^\]\(#/, '').replace(/\)$/, '')))];
  A('抽到内部锚点链接（判据没抽空）', links.length >= 3, links.length + ' 条：' + links.join(' | '));
  const dead = links.filter(a => !heads.has(decodeURIComponent(a)));
  A('★ 每条 `](#锚点)` 都有对应标题（断链会把读者送到 404）', dead.length === 0, dead.join(' | '));
}

console.log('\n══ ③ 用户区在开发者区之前 ══');
{
  const at = s => prose.findIndex(l => l.trim() === s);
  const iDev = at('## 给开发者');
  A('有 `## 给开发者` 分界', iDev > 0, 'L' + (iDev + 1));
  for (const s of ['## 三分钟上手', '## 录题四步（界面上怎么走）', '## 我的数据在哪、怎么备份', '## 界面']) {
    const i = at(s);
    A(`  ${s} 在分界之前（用户先看到它）`, i > 0 && i < iDev, 'L' + (i + 1) + (i < iDev ? '' : ' ✖ 在分界之后或缺失'));
  }
  A('  用户核心流程不再挂在 `## 常用命令` 之下（改前 `### 录题四步` 是它的子节）',
    prose.some(l => l.trim() === '## 录题四步（界面上怎么走）') && !prose.some(l => l.trim() === '### 录题四步（界面上怎么走）'), '');
}

console.log('\n══ ④ 被代码引用的章节名还在 ══');
{
  const src = fs.readFileSync(path.join(E.REPO, 'tests', 'run.mjs'), 'utf8');
  const need = /README「([^」]+)」/.exec(src);
  A('从 run.mjs 里取到它引用的 README 章节名', !!need, need ? need[1] : '（没找到引用文案，跳过后面的断言）');
  if (need) A(`★ README 里仍有「${need[1]}」这一节`, prose.some(l => l.includes(need[1])), '');
}

console.log(`\n[neg-readme-structure] 断言=${passed} 失败=${worst}`);
process.exit(worst ? 1 : 0);
