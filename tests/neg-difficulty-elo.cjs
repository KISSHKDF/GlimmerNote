#!/usr/bin/env node
/**
 * neg-difficulty-elo.cjs —— 难度在线估计（Elo 式）（2026-11-13 立，批次 4「后接 Elo」）
 *
 * 背景：卡上的 `difficulty` 是**人工三档**（易/中/难，录入时凭手感填、之后再没人动过）——
 * 它不知道"这道题对**这个孩子**到底难不难"，也不随孩子进步而变。外部调研把
 * "Elo 式在线更新"列为最推荐的算法改动。本用例守：
 *   ① **方向不许搞反**（这是最容易写错的地方）：答对 ⇒ 孩子能力**升**、**题目难度估计降**；
 *   ② 数学性质：`elo == ability` ⇒ 期望得分 0.5；`applyElo` 确定性（同输入同输出）；
 *      连续答对 ⇒ 能力单调升且增速递减（趋近收敛）；
 *   ③ **不碰人工档位**：`difficulty` 是人工标注，算法只加 `it.elo` / `json.ability`，不改它；
 *   ④ 契约仍在：配方 schema 的 `difficulty` 枚举**只有** 易/中/难/空（真库那 4 张 `中偏难` 是契约外取值，
 *      已单独记录，不在这里放宽）。
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

const SIM = path.join(E.REPO, 'src', 'tools', '_难度.mjs');
const MARK = fs.readFileSync(path.join(E.REPO, 'src', 'tools', '_标记复习.mjs'), 'utf8');
const simSrc = fs.readFileSync(SIM, 'utf8');

console.log('测试环境：' + E.describe());

(async () => {
  const M = await import(pathToFileURL(SIM).href);

  console.log('\n══ ① 方向（最容易搞反的地方）══');
  {
    const right = M.applyElo({ elo: 1500, ability: 1500, result: '对' });
    const wrong = M.applyElo({ elo: 1500, ability: 1500, result: '错' });
    A('★★ 答对 ⇒ 孩子能力**升**', right.ability > 1500, '1500→' + right.ability);
    A('★★ 答对 ⇒ **题目难度估计降**（题目是"对手"，孩子赢 ⇒ 对手显得弱）',
      right.elo < 1500, '1500→' + right.elo);
    A('★ 答错 ⇒ 能力降、题目升（反向对称）',
      wrong.ability < 1500 && wrong.elo > 1500, '能力→' + wrong.ability + ' 题目→' + wrong.elo);
    A('半对 ⇒ 期望 0.5 时算"表现略好"（1600 的题被 1500 的孩子半对）⇒ 能力微升',
      M.applyElo({ elo: 1600, ability: 1500, result: '半对' }).ability > 1500, '');
  }

  console.log('\n══ ② 数学性质 ══');
  A('★ `elo == ability` ⇒ 期望得分恰为 0.5',
    Math.abs(M.expectedScore(1500, 1500) - 0.5) < 1e-12, String(M.expectedScore(1500, 1500)));
  A('★ 题比孩子强（elo 更高）⇒ 期望得分 < 0.5', M.expectedScore(1700, 1500) < 0.5, '');
  A('★ 确定性：同输入两次结果逐字段相同',
    JSON.stringify(M.applyElo({ elo: 1523, ability: 1477, result: '半对' })) ===
    JSON.stringify(M.applyElo({ elo: 1523, ability: 1477, result: '半对' })), '');
  {
    let ab = 1500, prev = 0, deltas = [];
    for (let i = 0; i < 12; i++) { const u = M.applyElo({ elo: 1500, ability: ab, result: '对' }); deltas.push(u.ability - ab); ab = u.ability; }
    A('★ 连续答对 ⇒ 能力单调上升', ab > 1500 && deltas.every(d => d > 0), '1500→' + ab);
    A('★ 且增速递减（趋近收敛，不会线性飙到天上）',
      deltas[0] > deltas[deltas.length - 1], '首 ' + deltas[0] + ' 末 ' + deltas[deltas.length - 1]);
  }
  A('未知结果按 0 分处理（调用方本来就只允许 对/半对/错）', M.scoreOf('???') === 0, '');

  console.log('\n══ ③ 人工档位只做先验，算法不碰它 ══');
  A('★ 先验：难 > 中 > 易（用录入时的人工判断做起点，比一律 1500 收敛快）',
    M.initialEloOf('难') > M.initialEloOf('中') && M.initialEloOf('中') > M.initialEloOf('易'),
    '易=' + M.initialEloOf('易') + ' 中=' + M.initialEloOf('中') + ' 难=' + M.initialEloOf('难'));
  A('没填档位（空串/缺字段）⇒ 回落到中位 1500',
    M.initialEloOf('') === 1500 && M.initialEloOf(undefined) === 1500, '');
  A('★★ `_标记复习.mjs` **没有**写 `it.difficulty`（人工标注不许被算法改）',
    !/it\.difficulty\s*=/.test(MARK), '');
  A('★ 落库时只加两个字段：`it.elo` 与 `json.ability`',
    /it\.elo = upd\.elo;/.test(MARK) && /json\.ability = upd\.ability;/.test(MARK), '');
  A('★ 更新点在判分落库处（errorCount 之后），既有判据一行未动',
    /it\.errorCount = Math\.max\(1, num\(it\.errorCount\) - 1\);\s*\n[\s\S]{0,900}applyElo\(/.test(MARK), '');
  A('`_难度.mjs` 是零副作用模块（不解析 argv、不读库根）', (() => {
    const c = simSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    return !/process\.argv/.test(c) && !/libraryRoot\s*\(/.test(c);
  })(), '');

  console.log('\n══ ④ 契约：难度仍是三档（不因引入 Elo 而放宽）══');
  {
    const s = JSON.parse(fs.readFileSync(path.join(E.REPO, 'src', 'recipes', 'ingest-single', 'schema.json'), 'utf8'));
    const en = s.properties.cards.items.properties.difficulty.enum;
    A('★ 配方 schema 的 difficulty 枚举 = 易/中/难/空（没有"中偏难"这类第四档）',
      JSON.stringify(en) === JSON.stringify(['易', '中', '难', '']), JSON.stringify(en));
  }

  console.log('\n══ ⑤ 阴性自证：把题目方向写成跟学生一样 ⇒ ① 必须红 ══');
  {
    const broken = simSrc.replace('elo: Math.round(elo0 - kCard * delta),', 'elo: Math.round(elo0 + kCard * delta),');
    A('变异点命中', broken !== simSrc, '');
    const tmp = path.join(E.allocTempDir('gn-elo-mut-'), 'm.mjs');
    fs.writeFileSync(tmp, broken, 'utf8');
    const M2 = await import(pathToFileURL(tmp).href);
    A('★ 掏反方向后，答对不再让题目变简单（这条判据确实有牙齿）',
      !(M2.applyElo({ elo: 1500, ability: 1500, result: '对' }).elo < 1500), '');
  }

  console.log(`\n[neg-difficulty-elo] 断言=${passed} 失败=${worst}`);
  process.exit(worst ? 1 : 0);
})().catch(e => { console.error('用例自身异常：' + (e && e.stack || e)); process.exit(1); });
