#!/usr/bin/env node
/**
 * neg-similarity-dedupe.cjs —— 中文相似度判重（2026-11-13 立，批次 4）
 *
 * 事故形态（改前）：`_配方.mjs` 里有一份 `norm` + `dice`（bigram Dice），但它是 **CLI** ——
 * 别的工具想复用只能再抄一份（抄了就会漂，见 L-874/L-286）。而"录入时库里可能已经有这道题了"
 * 这件事**根本没人管**：同一道题拍两次、抄两遍，就会变成两张卡（复习池里最坏的一类错）。
 *
 * 本用例守四件事：
 *   ① **真跑**相似度函数（把 `_相似度.mjs` 直接 import 进来验，不是正则猜源码）：
 *      完全一致 = 1、全半角/标点/空白差异归一化后仍判"同一句"、无关句分数低、短文本不参与；
 *   ② 收敛：`_配方.mjs` 不再有本地实现，改为 import 零副作用模块；
 *   ③ 入库器**用它做提示**（且只在非 `--dry` 时），文案讲清"别新建、走改卡"；
 *   ④ **口径**：**不**照抄审计建议的"自动累加 `errorCount`"——本仓 `errorCount` 的语义是
 *      "这张卡在复习里重做错了几次"，拿它记"录入时见过几次"会搅乱语义。用断言把这个决定钉住。
 * 另含阴性自证：掏掉 `normText` 的"去空白" ⇒ 归一化断言必须红。
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

const SIM = path.join(E.REPO, 'src', 'tools', '_相似度.mjs');
const RECIPE = fs.readFileSync(path.join(E.REPO, 'src', 'tools', '_配方.mjs'), 'utf8');
const INGEST = fs.readFileSync(path.join(E.REPO, 'src', 'tools', '_录题入库.mjs'), 'utf8');
const simSrc = fs.readFileSync(SIM, 'utf8');

console.log('测试环境：' + E.describe());

(async () => {
  const M = await import(pathToFileURL(SIM).href);

  console.log('\n══ ① 真跑相似度函数 ══');
  A('★ 完全一致 ⇒ 1', M.dice('三角形面积怎么求', '三角形面积怎么求') === 1, '');
  A('★ 全半角/标点/空白差异 ⇒ 归一化后仍判"同一句"（≥0.9）',
    M.dice('计算：3+4=？', '计算: 3+4=?') >= 0.9,
    'dice=' + M.dice('计算：3+4=？', '计算: 3+4=?').toFixed(3));
  A('★ 无关句 ⇒ 分数低（<0.2）',
    M.dice('如图，求阴影部分面积', '辛亥革命的历史意义是什么') < 0.2,
    'dice=' + M.dice('如图，求阴影部分面积', '辛亥革命的历史意义是什么').toFixed(3));
  A('空串 ⇒ 0（不许把空当相同）', M.dice('', '随便') === 0 && M.dice('随便', '') === 0, '');
  A('归一化：全角字母数字转半角', M.normText('ＡＢＣ１２３') === 'abc123', M.normText('ＡＢＣ１２３'));
  A('归一化：中文标点转半角、去空白', M.normText('甲， 乙； 丙。') === '甲,乙;丙.', M.normText('甲， 乙； 丙。'));

  console.log('\n══ ② findSimilar：阈值 / 上限 / 短文本 ══');
  {
    const pool = [
      { id: 'M0001', text: '如图，求阴影部分的面积（单位：cm）' },
      { id: 'M0002', text: '求阴影部分的面积，单位 cm' },
      { id: 'M0003', text: '辛亥革命的历史意义' },
    ];
    const hits = M.findSimilar('如图，求阴影部分的面积（单位：cm）', pool);
    A('★ 命中完全一致那条，且分数为 1', hits.length >= 1 && hits[0].item.id === 'M0001' && hits[0].score === 1,
      hits.map(h => h.item.id + ':' + h.score.toFixed(2)).join(' '));
    A('★ 无关的那条不进结果', !hits.some(h => h.item.id === 'M0003'), '');
    A('★ 短文本（<8 字归一化后）不参与比对（"计算""填空"没有可比性）',
      M.findSimilar('计算', pool).length === 0, '');
    A('limit 生效（默认 3，传 1 就只回 1）',
      M.findSimilar('求阴影部分的面积，单位 cm', pool, { limit: 1 }).length <= 1, '');
    A('结果按相似度降序', (() => {
      const h = M.findSimilar('求阴影部分的面积，单位 cm', pool, { threshold: 0.3 });
      for (let i = 1; i < h.length; i++) if (h[i - 1].score < h[i].score) return false;
      return true;
    })(), '');
    A('阈值可调（调到 1.0 时只有完全相同才命中）',
      M.findSimilar('求阴影部分的面积，单位 cm', pool, { threshold: 1 }).every(h => h.score === 1), '');
  }

  console.log('\n══ ③ 收敛：配方工具改成 import，不再本地实现 ══');
  A('★ `_配方.mjs` import 了 `_相似度.mjs`', /from '\.\/_相似度\.mjs'/.test(RECIPE), '');
  A('★ `_配方.mjs` 里**不再有**本地 `function dice(`', !/function dice\(/.test(RECIPE), '');
  /* ⚠ 断言要指准：`_配方.mjs` 里另有**两个** `const norm =`，那是**路径**归一化
     （`replace(/\\/g,'/')`），与文本归一化同名不同义 —— 首版断言写宽了会误报。 */
  A('★ `_配方.mjs` 里**不再有**文本归一化的本地实现（`const norm = (s) =>`）',
    !/const norm = \(s\)/.test(RECIPE), '');
  A('`_相似度.mjs` 是零副作用模块（不解析 argv、不读库根）', (() => {
    const c = simSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    return !/process\.argv/.test(c) && !/libraryRoot\s*\(/.test(c);
  })(), '');

  console.log('\n══ ④ 入库器：用它做提示（只提示、不拦、不改 errorCount）══');
  A('★ 入库器 import 并调用 findSimilar', /import \{ findSimilar \}/.test(INGEST) && /findSimilar\(c\.questionText/.test(INGEST), '');
  A('★ 只在**非 dry** 时提示（预演不该刷屏）', /if \(!DRY\) \{\s*\n\s*const pool = allCardTexts\(\);/.test(INGEST), '');
  A('★ 提示文案讲清"别新建、走改卡"（否则用户不知道该干什么）',
    /别新建/.test(INGEST) && /改卡/.test(INGEST), '');
  A('★ 提示里**没有**把它算进 problems（那是"拦"，本判据只提示）',
    !/problems\.push\([^)]*相似/.test(INGEST), '');
  A('★★ **没有**自动累加 errorCount（口径决定：errorCount = 复习里重做错了几次）',
    !/errorCount\s*(\+\+|\+=|=[^=])/.test(INGEST), '');
  A('提示段里也没碰 errorCount', !/errorCount/.test(INGEST.slice(INGEST.indexOf('疑似重复') - 200, INGEST.indexOf('疑似重复') + 1500)), '');

  console.log('\n══ ⑤ 阴性自证：掏掉归一化的"去空白" ⇒ ① 必须红 ══');
  {
    const broken = simSrc.replace("    .replace(/\\s+/g, '')", "    .replace(/\\u0000/g, '')");
    A('变异点命中', broken !== simSrc, '');
    const tmp = path.join(E.allocTempDir('gn-sim-mut-'), 'm.mjs');
    fs.writeFileSync(tmp, broken, 'utf8');
    const M2 = await import(pathToFileURL(tmp).href);
    A('★ 掏掉后 `计算：3+4=？` 与 `计算: 3+4=?` 不再判同一句（这条判据确实有牙齿）',
      M2.dice('计算：3+4=？', '计算: 3+4=?') < 0.9,
      'dice=' + M2.dice('计算：3+4=？', '计算: 3+4=?').toFixed(3));
  }

  console.log(`\n[neg-similarity-dedupe] 断言=${passed} 失败=${worst}`);
  process.exit(worst ? 1 : 0);
})().catch(e => { console.error('用例自身异常：' + (e && e.stack || e)); process.exit(1); });
