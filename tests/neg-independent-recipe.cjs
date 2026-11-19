#!/usr/bin/env node
/**
 * 独立判卷口径门禁（2026-11-18 建）
 *
 * 事故/缺口形态（真实发生的场景，见 `data\batch补录` 那类批次的汇总报告）：
 *   用户把一份**尚未批改**的整卷 6 页丢进收件箱，用 `ingest-page` 跑完整条 AGENT 流水线，
 *   结果 **6 张照片 → 0 张卡**。按配方口径这不算错（`cards` = 确认做错**且有红笔标出**的题），
 *   但对用户来说这次自动化的产出是零 —— 孩子真正的错题一道都没进来。
 *   根因不是 AI，是**口径缺口**：内置配方只有"红笔口径"，没有"独立判卷口径"。
 *
 * 本用例守三件事：
 *   ① **口径在场**：`ingest-independent` 五件套齐全，且它表达的是"判错即收、不以红笔为前提"。
 *   ② **契约有牙齿**：用**真校验器**（`_配方.mjs 校验`）证明 ——
 *      `judgedWrong` 必填、`markedWrong` 不许混进来、两套口径互不冒名通过、`skipped` 不许空数组。
 *   ③ **推断不静默**：不指定 `--recipe` 时，两个整页配方必须按 `pageSummary` 的键分派，
 *      并把依据打印出来（否则一份独立判卷结果会被红笔口径的 schema 拒，反之亦然）。
 *   另加：**阴性自证** —— 把 `ingest-independent/schema.json` 的 `judgedWrong` 从 required 里
 *   摘掉，本用例的对应断言必须红（证明断言不是恒定绿）。
 *
 * 用法：node tests\neg-independent-recipe.cjs
 * 退出码：0=全绿；1=有断言失败
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ENGINE = path.join(ROOT, 'src', 'tools', '_配方.mjs');
const RECIPES = path.join(ROOT, 'src', 'recipes');
const ID = 'ingest-independent';

let pass = 0, fail = 0;
const A = (name, ok, detail) => {
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${name}${detail ? '  → ' + detail : ''}`);
  ok ? pass++ : fail++;
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-indep-neg-'));
const writeJson = (name, obj) => {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
  return p;
};
const SHA = 'b'.repeat(64);
const read = (p) => fs.readFileSync(path.join(RECIPES, p), 'utf8');

/** 跑引擎，返回 {code, out, err} */
function engine(args, cwd) {
  const r = spawnSync(process.execPath, [ENGINE, ...args], {
    cwd: cwd || ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

/** 一条结构合规的卡；over 里给 '<<DEL>>' 表示删掉该字段 */
function card(over = {}) {
  const c = {
    subject: '数学', title: '移项错', source: '期中卷 · 第3题', sourceDate: '2026-11-17',
    questionText: '解方程 2x+1=7', studentAnswer: 'x=4', answer: 'x=3',
    answerSource: '独立判卷', answerSourceNote: '移项得 2x=6，故 x=3；孩子写成 4，错在移项不变号',
    causeCode: 'S1', causeNote: '移项没有变号', causeStage: '求解',
    kpoints: ['一元一次方程'], difficulty: '易', hasFigure: false,
    confidence: 'high', sourceImageSha256: SHA, notes: '', teacherAnswer: '',
  };
  for (const k of Object.keys(over)) {
    if (over[k] === '<<DEL>>') delete c[k]; else c[k] = over[k];
  }
  return c;
}

/** 合规的独立判卷整页结果 */
function page(over = {}, cardOver = {}) {
  const base = {
    pageSummary: { totalQuestions: 8, judgedWrong: 1, judgedRight: 7 },
    cards: [card(cardOver)],
    skipped: [{ what: '第8题', reason: '整题未作答，无法判断是否算错' }],
  };
  for (const k of Object.keys(over)) base[k] = over[k];
  return base;
}

console.log('══ ① 口径在场：五件套 + 表达的是「判错即收」══');
{
  const dir = path.join(RECIPES, ID);
  A('配方目录存在', fs.existsSync(dir), path.relative(ROOT, dir));
  const REQUIRED = ['meta.json', 'prompt.md', 'schema.json', 'checklist.md', 'anti-patterns.md'];
  const missing = REQUIRED.filter((f) => !fs.existsSync(path.join(dir, f)));
  A('五件套齐全', missing.length === 0, missing.length ? '缺 ' + missing.join(', ') : '');

  let meta = null;
  try { meta = JSON.parse(read(ID + '/meta.json')); } catch { }
  A('meta.id 与目录名一致', !!meta && meta.id === ID, meta ? `meta.id=${meta.id}` : '解析失败');
  A('meta.changelog 非空（有来路）', !!meta && Array.isArray(meta.changelog) && meta.changelog.length > 0);

  const prompt = read(ID + '/prompt.md');
  /* 判据必须**同时**钉住"收什么"与"不以红笔为前提" —— 少一半就是口径讲不清。 */
  A('★ prompt 写明收录口径 = 独立判卷判错', /独立判卷判(孩子)?做错|判错/i.test(prompt) && /cards/.test(prompt), '');
  A('★ prompt 写明「不要求卷面有红笔」', /不要求[^\n]{0,12}红笔|不以[^\n]{0,12}红笔为前提|卷面有没有红笔，都不影响/.test(prompt), '');
  A('★ prompt 写明红笔只进 teacherAnswer、不参与判错', /红笔[^\n]{0,30}不参与判错|不决定[^\n]{0,20}(算不算错|收不收)/.test(prompt), '');
  A('★ prompt 保留了「老师定案已废除」的红字纪律', /没有「老师定案」/.test(prompt), '');
  A('★ prompt 要求判错必须写判据（关键步骤）', /判据|关键步骤/.test(prompt), '');
  A('★ prompt 自检项含「判对的题一条都没出现」', /判对的题一条都没出现在/.test(prompt), '');
  A('★ prompt 含题库检索流程（与另两个配方同底线）', /菁优网/.test(prompt) && /作业帮/.test(prompt), '');

  const ap = read(ID + '/anti-patterns.md');
  A('★ 反例库有「把红笔当判错依据」一条', /红笔当判错依据|把红笔当判错/.test(ap), '');
  A('★ 反例库有「判错没有判据」一条', /判错没有判据|只有结论/.test(ap), '');
  A('★ 反例库有「判对的题也收进来」一条', /判对的题也收进来/.test(ap), '');

  const ck = read(ID + '/checklist.md');
  A('★ 验收清单要求核对 judgedWrong 与条数', /judgedWrong/.test(ck), '');
  A('★ 验收清单把「判错没有判据」列为高危信号', /判错没有判据/.test(ck), '');

  const exDir = path.join(dir, 'examples');
  const cases = fs.existsSync(exDir) ? fs.readdirSync(exDir).filter((n) => fs.statSync(path.join(exDir, n)).isDirectory()) : [];
  A('黄金样本 ≥1 个（0 卡也是合法结果，故要两个）', cases.length >= 2, cases.join(', '));
  const exp0 = path.join(exDir, '02-unmarked-all-right', 'expected.json');
  A('★ 0 卡样本存在且声明 judgedWrong=0 / cards=[]',
    fs.existsSync(exp0) && (() => { const j = JSON.parse(fs.readFileSync(exp0, 'utf8')); return j && j.expect && j.expect.pageSummary.judgedWrong === 0 && Array.isArray(j.expect.cards) && j.expect.cards.length === 0; })(), '');
}

console.log('\n══ ② 契约有牙齿：真校验器的行为（不是只断言 schema 里写了字段）══');
{
  const ok = engine(['校验', '--in', writeJson('ok.json', page()), '--recipe', ID]);
  A('合规样本通过（exit 0）', ok.code === 0, 'code=' + ok.code + ' ' + (ok.out.match(/✖[^\n]*/) || [''])[0]);

  /* 0 卡页是**合法**结果：这条必须成立，否则"整页无判错"又要靠伪造才能通过。 */
  const zero = engine(['校验', '--recipe', ID, '--in', writeJson('zero.json', page({
    pageSummary: { totalQuestions: 8, judgedWrong: 0, judgedRight: 8 },
    cards: [],
    skipped: [{ what: '全页', reason: '全部清晰可判，无跳过项' }],
  }))]);
  A('★ 0 卡页是合法结果（exit 0）——不许把"整页无判错"当失败', zero.code === 0, 'code=' + zero.code);

  /* 红笔口径的必填键混进来 ⇒ 必须是"契约外字段"，不能被悄悄放过。 */
  const mixed = engine(['校验', '--recipe', ID, '--in', writeJson('mixed.json', page({
    pageSummary: { totalQuestions: 8, judgedWrong: 1, markedWrong: 1, judgedRight: 7 },
  }))]);
  A('★ 拒收：pageSummary 混进红笔口径的 markedWrong（口径不许叠加）', mixed.code === 1, 'code=' + mixed.code);

  /* 独立判卷结果拿去走红笔口径的 schema ⇒ 必须拒（两套口径互不冒名）。 */
  const asPage = engine(['校验', '--recipe', 'ingest-page', '--in', writeJson('as-page.json', page())]);
  A('★ 拒收：独立判卷结果按 ingest-page 校验（judgedWrong 是契约外字段）', asPage.code === 1, 'code=' + asPage.code);

  /* skipped 空数组 = 装懂，整页族铁律，两个配方同口径。 */
  const noSkip = engine(['校验', '--recipe', ID, '--in', writeJson('noskip.json', page({ skipped: [] }))]);
  A('★ 拒收：skipped 为空数组（装懂）', noSkip.code === 1, 'code=' + noSkip.code);

  const REJECT = [
    ['缺 judgedWrong（判错数没交代）', page({ pageSummary: { totalQuestions: 8 } })],
    ['缺 pageSummary（分不清整页/单题）', page({ pageSummary: '<<DEL>>' })],
    ['judgedWrong 是字符串', page({ pageSummary: { totalQuestions: 8, judgedWrong: '1' } })],
    ['卡少必填 teacherAnswer（红字纪律失明）', page({}, { teacherAnswer: '<<DEL>>' })],
    ['卡用已废除的来源「老师定案」', page({}, { answerSource: '老师定案' })],
    ['卡多写契约外字段', page({}, { studentAnswerX: '多余' })],
  ];
  for (const [name, obj] of REJECT) {
    const f = writeJson('rej-' + Math.random().toString(36).slice(2) + '.json', obj);
    const r = engine(['校验', '--recipe', ID, '--in', f]);
    A('拒收：' + name, r.code === 1, 'code=' + r.code);
  }
}

console.log('\n══ ③ 推断不静默：两个整页配方按 pageSummary 的键分派 ══');
{
  const jPage = (() => { const r = engine(['校验', '--in', writeJson('inf-page.json', {
    pageSummary: { totalQuestions: 13, markedWrong: 1 }, cards: [], skipped: [{ what: '全页', reason: 'x' }],
  }), '--json']); try { return JSON.parse(r.out); } catch { return null; } })();
  A('★ markedWrong ⇒ 推断 ingest-page', !!jPage && jPage.recipe === 'ingest-page' && jPage.inferred === true, JSON.stringify(jPage && { recipe: jPage.recipe, from: jPage.inferredFrom }));

  const jInd = (() => { const r = engine(['校验', '--in', writeJson('inf-ind.json', page()), '--json']); try { return JSON.parse(r.out); } catch { return null; } })();
  /* ★ 2026-11-19（零选择）：`ingest-auto` 是唯一入口配方，pageSummary 键与 ingest-independent
     相同（judgedWrong）⇒ 推断分派给 ingest-auto（新入口优先）。ingest-independent 仍可显式 --recipe 校验（老任务重放）。 */
  A('★ judgedWrong ⇒ 推断 ingest-auto（零选择后的唯一入口）', !!jInd && jInd.recipe === 'ingest-auto' && jInd.inferred === true, JSON.stringify(jInd && { recipe: jInd.recipe, from: jInd.inferredFrom }));
  A('★ 推断依据随 --json 一并给出（inferredFrom 非空）', !!jInd && typeof jInd.inferredFrom === 'string' && jInd.inferredFrom.length > 0, jInd && jInd.inferredFrom);

  const jSingle = (() => { const r = engine(['校验', '--in', writeJson('inf-single.json', { cards: [card()] }), '--json']); try { return JSON.parse(r.out); } catch { return null; } })();
  /* ★ 2026-11-19（零选择）：无 pageSummary 也推断 ingest-auto —— 单题与整页同契约（auto 的
     pageSummary 必填；单题特写 totalQuestions=1）。老 ingest-single 只在显式 --recipe 时走。 */
  A('★ 无 pageSummary ⇒ 推断 ingest-auto（单题/整页同契约）', !!jSingle && jSingle.recipe === 'ingest-auto', jSingle && jSingle.recipe);

  /* 人读输出也要说出口（不许只有 --json 才看得见）。 */
  const human = engine(['校验', '--in', writeJson('inf-human.json', page())]);
  A('★ 人读输出写明推断依据', /推断/.test(human.out) && /judgedWrong/.test(human.out), (human.out.split('\n').filter(l => /推断/.test(l))[0] || '').slice(0, 90));
}

console.log('\n══ ④ 整页族铁律按族生效（不许只钉死单个配方名）══');
{
  /* 判据在 `tests\neg-recipe-contract.cjs` 里按 PAGE_RECIPES 判；这里从**行为**侧再钉一遍：
     新配方必须和 ingest-page 一样受"skipped 不许空"约束，且它的自检也认这条。 */
  const src = fs.readFileSync(ENGINE, 'utf8');
  A('★ 引擎里整页族是**集合**判据（PAGE_RECIPES），不是写死单个配方名',
    /const PAGE_RECIPES = new Set\(\[[^\]]*'ingest-page'[^\]]*'ingest-independent'/.test(src), '');
  A('★ 引擎自检用 PAGE_RECIPES 判 skipped（改回 `=== \'ingest-page\'` 即红）',
    /if \(PAGE_RECIPES\.has\(recipeId\)\)/.test(src) && !/if \(recipeId === 'ingest-page'\) \{\s*\n\s*const sk/.test(src), '');

  /* 自检：用 0 卡样本跑一遍自检通道，确认它不会把"0 卡"判成失败之外的红。 */
  const self = engine(['自检', '--recipe', ID, '--in', writeJson('self.json', page({
    pageSummary: { totalQuestions: 8, judgedWrong: 0, judgedRight: 8 },
    cards: [], skipped: [{ what: '全页', reason: '全部清晰可判，无跳过项' }],
  })), '--json']);
  let sj = null; try { sj = JSON.parse(self.out); } catch { }
  A('★ 自检通道能跑（有 samples、有 expected）', self.code === 0 && !!sj && Array.isArray(sj.results) && sj.results.length >= 2,
    self.code + ' cases=' + (sj && sj.results ? sj.results.length : '?'));
}

console.log('\n══ ⑤ 阴性自证：把 judgedWrong 从 required 摘掉，②的断言必须红 ══');
{
  /* 变异体：复制整棵 src 树到临时目录，只动 ingest-independent/schema.json。
     ⚠ **不许写死"要复制哪几个兄弟模块"**：本仓已为此踩过两次
     （`_配方.mjs` 加 `_录题任务.mjs`、再加 `_安全写` 都会让变异体 import 失败）——
     整目录复制，依赖闭包自动跟上。 */
  const MUT = path.join(TMP, 'mut');
  fs.cpSync(path.join(ROOT, 'src'), path.join(MUT, 'src'), { recursive: true });
  const schP = path.join(MUT, 'src', 'recipes', ID, 'schema.json');
  const sch = JSON.parse(fs.readFileSync(schP, 'utf8'));
  sch.properties.pageSummary.required = ['totalQuestions'];       // 摘掉 judgedWrong
  fs.writeFileSync(schP, JSON.stringify(sch, null, 2), 'utf8');

  /* 引擎直接跑变异树里的那个文件（它按自身位置找 recipes 根）。 */
  const MUT_ENGINE = path.join(MUT, 'src', 'tools', '_配方.mjs');
  const runMut = (args) => spawnSync(process.execPath, [MUT_ENGINE, ...args], { cwd: MUT, encoding: 'utf8', maxBuffer: 64e6 });

  const f = path.join(MUT, 'no-judged.json');
  fs.writeFileSync(f, JSON.stringify(page({ pageSummary: { totalQuestions: 8 } })), 'utf8');
  const r = runMut(['校验', '--recipe', ID, '--in', f]);
  A('★ 变异后"缺 judgedWrong"不再被拒（证明 ② 那条断言打的是 schema，不是恒定绿）',
    r.status === 0, 'exit=' + r.status);
}

console.log('\n════════════════════════════════════');
console.log(`RESULT=${fail === 0 ? 'PASS' : 'FAIL'} 断言=${pass + fail} 通过=${pass} 失败=${fail}`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }
process.exit(fail === 0 ? 0 : 1);
