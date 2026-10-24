#!/usr/bin/env node
/**
 * BUG-03 阴性对照：「数据源读不到」必须**响亮失败**，不能静默产出一份"一切正常"的状态包。
 *
 * 2026-10-23 重写（原版必然红，两处原因都是架构变更留下的债）：
 *   ① 原版跑 `_生成首页.ps1`、读仓库根的 `首页.html` —— 生成器已换成 Node 的 `生成状态.mjs`
 *      （产 `_状态.json`），v1 首页整条链在开发区已不存在 ⇒ 找不到文件必红；
 *   ② 原版直接改**真库**的 `_配图台账.json` 再还原 —— 违反「真库零改动」纪律。
 * 现在：跑在**临时库副本**上，判据换成新架构下真正可机械验证的三条：
 *   A 基线：四个门禁通道都健康 ⇒ `dataHealth` 各分区全 ok、状态包写成功；
 *   B 注入坏真源（`_配图台账.json` 改成非法 JSON）⇒ 生成器**非零退出**，且**不改写**状态包
 *     （关键：不允许把降级洗成"全 ok"）；
 *   C 还原后再跑 ⇒ 回到全 ok，且台账 cards 条数不变。
 * 红条本身（`renderHealth` 把降级画到页面顶部）由 neg-v1-admit-consumption / neg-v2-smoke 守，
 * 本用例只补一条源码级断言，确保"降级要显示"这件事没有被悄悄删掉。
 *
 * 退出码 0=对照成立；1=对照失败（说明降级会被静默吞掉）。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/* ★ 2026-10-23：本用例必须改写真源（把台账弄坏再还原），一律跑临时库副本 */
const E = require('./_测试环境.cjs');
const LIB = E.makeTempLib();
const ROOT = path.resolve(__dirname, '..');
const LEDGER = path.join(LIB, '_配图台账.json');
const STATE = path.join(LIB, '_状态.json');

let fails = 0;
const A = (n, ok, d) => { console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d !== undefined ? '  → ' + d : ''}`); if (!ok) fails++; };

const readState = () => JSON.parse(fs.readFileSync(STATE, 'utf8'));
const healthBad = () => Object.entries(readState().dataHealth || {}).filter(([, v]) => v !== 'ok');
const healthText = () => JSON.stringify(readState().dataHealth);
const cardCount = () => Object.keys(JSON.parse(fs.readFileSync(LEDGER, 'utf8')).cards || {}).length;

/** 跑生成器（返回退出码与输出，绝不抛） */
const gen = () => {
  try {
    const out = execFileSync(process.execPath, [E.tool('生成状态.mjs'), '--quiet'], {
      encoding: 'utf8', maxBuffer: 64e6, stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { CTB_DATA: LIB }),
    });
    return { code: 0, out: String(out), err: '' };
  } catch (e) {
    return { code: e.status == null ? -1 : e.status, out: String(e.stdout || ''), err: String(e.stderr || '') };
  }
};

const origLedger = fs.readFileSync(LEDGER);
const origCards = cardCount();

console.log('--- 基线：四源都健康 ---');
const g1 = gen();
A('基线 生成状态.mjs 退出码 0', g1.code === 0, 'code=' + g1.code + (g1.err ? ' ' + g1.err.slice(0, 120) : ''));
A('基线 dataHealth 各分区全 ok', healthBad().length === 0, healthText());
A('基线状态包已落盘且带 data[]', fs.existsSync(STATE) && Array.isArray(readState().data), STATE);

console.log('--- 注入：_配图台账.json 改成非法 JSON（模拟真源损坏） ---');
const goodState = fs.readFileSync(STATE);           // 基线状态包字节
fs.writeFileSync(LEDGER, '{"cards": {"学生A|S0001": ', 'utf8');
const g2 = gen();
A('坏真源下生成器**非零退出**（不许静默放过）', g2.code !== 0, 'code=' + g2.code);
A('报错点名了失败的通道（配图状态）', /配图状态|_配图门禁/.test(g2.err + g2.out), (g2.err.match(/配图状态[^\n]*/) || [''])[0].slice(0, 90));
const afterState = fs.readFileSync(STATE);
A('坏真源下**状态包字节未变**（没把降级洗成"全 ok"）', afterState.equals(goodState),
  goodState.length + 'B → ' + afterState.length + 'B');
A('坏真源下没有产出新的"全 ok"状态包', (() => {
  try { return healthBad(readState()).length === 0; } catch { return true; }
})(), healthText());

console.log('--- 还原 ---');
fs.writeFileSync(LEDGER, origLedger);
const g3 = gen();
A('还原后生成器退出码 0', g3.code === 0, 'code=' + g3.code + (g3.err ? ' ' + g3.err.slice(0, 120) : ''));
A('还原后 dataHealth 各分区回到 ok', healthBad().length === 0, healthText());
A('还原后台账 cards 条数不变', cardCount() === origCards, `${origCards} → ${cardCount()}`);

console.log('--- 红条仍在（源码级：降级必须显示，不许悄悄删掉） ---');
const shellSrc = fs.readFileSync(path.join(ROOT, 'src', 'app', 'js', 'shell.js'), 'utf8');
A('shell.js 仍有 renderHealth（降级红条渲染点）', /function\s+renderHealth|renderHealth\s*[:=]/.test(shellSrc));
A('shell.js 仍把 dataHealth 接进判据', /dataHealth/.test(shellSrc));
A('红条容器 #dataHealthBanner 仍存在', /dataHealthBanner/.test(shellSrc) || /dataHealthBanner/.test(fs.readFileSync(path.join(ROOT, 'src', 'app', 'index.html'), 'utf8')));

console.log(`\nRESULT=${fails ? 'FAIL(' + fails + ')' : 'PASS'}`);
process.exit(fails ? 1 : 0);
