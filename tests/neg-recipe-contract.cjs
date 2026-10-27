#!/usr/bin/env node
/**
 * 配方层契约门禁（2026-10-27 建）
 *
 * 守什么：`src\recipes\` 这一层是 AI 方法层，它不像数据层那样有硬门禁兜底，
 *   一旦悄悄退化成"只有目录没有内容"或"schema 写了但不校验"，没人会发现——
 *   这正是原型（work\github-publish\proto）踩过的坑：schema.json 写得漂亮，
 *   运行时零校验，真正的闸只有 3 条手写规则。
 *
 * 因此本文件守两类事：
 *   ① **结构完整性**：每个配方必须有 meta / prompt / schema / checklist / anti-patterns / examples，
 *      meta 的 layers 指向的文件都必须真实存在。
 *   ② **判据有牙齿**（本仓纪律：能绿却没人跑的断言 = 没门禁）：
 *      逐条构造**必须被拒**的阴性样本，断言引擎真的拒；再构造合规样本，断言引擎真的过。
 *
 * 为什么把这些写成测试而不是"开发时手动看一眼"：
 *   配方会被人不断追加反例、改 schema。改坏一次的表现不是报错，而是**AI 输出变得略微变差**，
 *   这种退化肉眼看不出来。只有断言能挡住。
 *
 * 用法：node tests\neg-recipe-contract.cjs
 * 退出码：0=全绿；1=有断言失败
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ENGINE = path.join(ROOT, 'src', 'tools', '_配方.mjs');
const RECIPES = path.join(ROOT, 'src', 'recipes');

let pass = 0, fail = 0;
const A = (name, ok, detail) => {
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${name}${detail ? '  → ' + detail : ''}`);
  ok ? pass++ : fail++;
};

/** 跑引擎，返回 {code, out, err} */
function engine(args, cwd) {
  const r = spawnSync(process.execPath, [ENGINE, ...args], {
    cwd: cwd || ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

/* 临时目录：所有输入样本写在这里，绝不往仓库里丢文件 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-recipe-neg-'));
const writeJson = (name, obj) => {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
  return p;
};
const SHA = 'a'.repeat(64);

/** 造一条结构合规的卡片；over 里给 '<<DEL>>' 表示删掉该字段 */
function card(over = {}) {
  const c = {
    subject: '数学', title: '符号错', source: '作业1 · 第3题', sourceDate: '2026-10-27',
    questionText: '计算 (−16)−3', studentAnswer: '−13', answer: '−19',
    answerSource: '独立判卷', answerSourceNote: '竖式重算',
    causeCode: 'S1', causeNote: '把两个负数相加当成减法',
    kpoints: ['有理数加法'], difficulty: '易', hasFigure: false,
    confidence: 'high', sourceImageSha256: SHA, notes: '',
  };
  for (const k of Object.keys(over)) {
    if (over[k] === '<<DEL>>') delete c[k]; else c[k] = over[k];
  }
  return c;
}

console.log('══ 一、结构完整性（配方目录不许"只有壳"）══');

const recipeDirs = fs.existsSync(RECIPES)
  ? fs.readdirSync(RECIPES).filter((n) => !n.startsWith('_') && !n.startsWith('.')
    && fs.statSync(path.join(RECIPES, n)).isDirectory())
  : [];
A('配方根存在', fs.existsSync(RECIPES), path.relative(ROOT, RECIPES));
A('至少 2 个配方', recipeDirs.length >= 2, recipeDirs.join(', '));

const REQUIRED_FILES = ['meta.json', 'prompt.md', 'schema.json', 'checklist.md', 'anti-patterns.md'];
const coreFiles = ['_core/base.md', '_core/cause.md', '_core/provenance.md', '_subject/通用.md'];
for (const f of coreFiles) {
  A('核心层存在 ' + f, fs.existsSync(path.join(RECIPES, f)));
}

for (const id of recipeDirs) {
  const dir = path.join(RECIPES, id);
  const missing = REQUIRED_FILES.filter((f) => !fs.existsSync(path.join(dir, f)));
  A(`配方 ${id} 五件套齐全`, missing.length === 0, missing.length ? '缺 ' + missing.join(', ') : '');

  /* meta 自洽：id 与目录名一致（指纹与引用都靠它） */
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); } catch { }
  A(`配方 ${id} meta.id 与目录名一致`, !!meta && meta.id === id, meta ? `meta.id=${meta.id}` : 'meta 解析失败');
  A(`配方 ${id} meta.version 形如 x.y.z`, !!meta && /^\d+\.\d+\.\d+$/.test(String(meta.version || '')), meta && meta.version);
  A(`配方 ${id} meta.changelog 非空`, !!meta && Array.isArray(meta.changelog) && meta.changelog.length > 0);

  /* layers 里每个非占位符层都必须真实存在 */
  const layers = (meta && Array.isArray(meta.layers)) ? meta.layers : [];
  const concrete = layers.filter((l) => !l.includes('${'));
  const badLayer = concrete.filter((l) => !fs.existsSync(path.join(RECIPES, l)));
  A(`配方 ${id} layers 指向的文件都存在`, badLayer.length === 0, badLayer.join(', '));

  /* 占位符层必须能被兜底解析（否则换个没写过的学科就炸） */
  const hasSubjVar = layers.some((l) => l.includes('${subject}'));
  A(`配方 ${id} 用 \${subject} 占位（学科分派）`, hasSubjVar, hasSubjVar ? '' : '仍写死学科 → 会三科混拼');

  /* examples 至少一个样本，否则无法自检 */
  const exDir = path.join(dir, 'examples');
  const exCount = fs.existsSync(exDir) ? fs.readdirSync(exDir).filter((n) => fs.statSync(path.join(exDir, n)).isDirectory()).length : 0;
  A(`配方 ${id} 有黄金样本`, exCount >= 1, exCount + ' 个');
}

console.log('\n══ 二、学科分派（物理题不许带英语规则）══');
{
  const r = engine(['组装', '--recipe', 'ingest-single', '--subject', '物理']);
  A('组装物理：退出码 0', r.code === 0, 'code=' + r.code);
  /* 判据要用**该学科文件独有**的句子。注意不能用「词形变化漏写」这类词——
     那些是 16 类错因编码，属于 _core/cause.md，所有学科都该有。 */
  A('物理提示词含物理学科特征', r.out.includes('滑动变阻器') || r.out.includes('ρ=m/V'), '');
  A('物理提示词**不含**英语学科特征', !r.out.includes('大小写是信息') && !r.out.includes('完形/阅读'), '');
  A('物理提示词**不含**语文学科特征', !r.out.includes('默写题逐字照抄') && !r.out.includes('加点字'), '');
  A('物理提示词**不含**化学学科特征', !r.out.includes('化学式与上下标'), '');
  /* 16 类错因是跨学科核心层，必须**在**（不能因为按科分派就把核心层丢掉） */
  A('物理提示词仍含 16 类错因核心层', r.out.includes('K1') && r.out.includes('S5'), '');
  A('物理提示词仍含溯源铁律', r.out.includes('sourceImageSha256'), '');
}
{
  const r = engine(['组装', '--recipe', 'ingest-single', '--subject', '生物']);
  A('未收录学科：回落通用并**响亮警告**', r.code === 0 && /回落|通用\.md/.test(r.err), r.err.split('\n')[0] || '（无警告 = 静默降级）');
}
{
  const r = engine(['组装', '--recipe', 'ingest-single']);
  A('不给 --subject 必须报错（不许猜学科）', r.code === 2, 'code=' + r.code);
}

console.log('\n══ 三、schema 真校验（阴性样本必须被拒）══');
{
  const ok = writeJson('ok.json', { cards: [card()] });
  const r = engine(['校验', '--in', ok]);
  A('合规样本通过', r.code === 0, 'code=' + r.code);
}
const REJECT = [
  ['缺 confidence（原型老 bug：单题永远进不了 trusted）', { confidence: '<<DEL>>' }],
  ['confidence 填中文「高」', { confidence: '高' }],
  ['缺 sourceImageSha256（溯源锚）', { sourceImageSha256: '<<DEL>>' }],
  ['sourceImageSha256 长度不对', { sourceImageSha256: 'abc' }],
  ['causeCode 填中文「粗心大意」', { causeCode: '粗心大意' }],
  ['causeCode 不在 16 类里', { causeCode: 'S9' }],
  ['answerSource 用了原型旧词表「独立求解」', { answerSource: '独立求解' }],
  ['缺 studentAnswer', { studentAnswer: '<<DEL>>' }],
  ['causeNote 为空串（没写错在哪一步）', { causeNote: '' }],
  ['title 超过 24 字', { title: '很'.repeat(25) }],
  ['kpoints 超过 5 个', { kpoints: ['a', 'b', 'c', 'd', 'e', 'f'] }],
  ['多写契约外字段', { studentAnswerX: '多余' }],
];
for (const [name, over] of REJECT) {
  const f = writeJson('rej-' + Math.random().toString(36).slice(2) + '.json', { cards: [card(over)] });
  const r = engine(['校验', '--in', f]);
  A('拒收：' + name, r.code === 1, 'code=' + r.code);
}
{
  const f = writeJson('bad-json.json', '{ this is not json }');
  const r = engine(['校验', '--in', f]);
  A('拒收：输入不是合法 JSON', r.code === 1, 'code=' + r.code);
}
{
  const bad = path.join(TMP, 'nope.json');
  const r = engine(['校验', '--in', bad]);
  A('输入文件不存在 → 参数错误码 2（不是 1）', r.code === 2, 'code=' + r.code);
}

console.log('\n══ 四、整页配方的专属铁律 ══');
{
  const f = writeJson('page-empty-skip.json', {
    pageSummary: { totalQuestions: 13, markedWrong: 3, unmarked: 10 }, cards: [], skipped: [],
  });
  const r = engine(['校验', '--in', f]);
  A('拒收：skipped 为空数组（装懂）', r.code === 1, 'code=' + r.code);

  const good = writeJson('page-good.json', {
    pageSummary: { totalQuestions: 13, markedWrong: 1, unmarked: 12 },
    cards: [card({ causeCode: 'L2' })],
    skipped: [{ what: '第13题', reason: '整题未作答，无法判断' }],
  });
  const r2 = engine(['校验', '--in', good]);
  A('整页合规样本通过', r2.code === 0, 'code=' + r2.code);

  const noSum = writeJson('page-nosummary.json', {
    cards: [card()], skipped: [{ what: 'x', reason: 'y' }],
  });
  /* ⚠ 必须显式 --recipe：不指定时引擎会按"有无 pageSummary"推断，
     这份输入没有 pageSummary ⇒ 会被推断成 ingest-single 而通过。
     这正是"推断必须说出口"的原因（引擎现在会打印推断依据）。 */
  const r3 = engine(['校验', '--in', noSum, '--recipe', 'ingest-page']);
  A('拒收：整页配方缺 pageSummary（显式指定配方）', r3.code === 1, 'code=' + r3.code);

  const r4 = engine(['校验', '--in', noSum]);
  A('推断时会把依据打印出来（不静默）', r4.out.includes('推断') || JSON.parse(engine(['校验', '--in', noSum, '--json']).out).inferred === true, r4.out.split('\n')[0]);
}

console.log('\n══ 五、组装：原图路径按库根解析（用户实测「生成不了任务单」的回归）══');
{
  /* 2026-10-27 事故：界面传的是**库内相对路径**（`_收件箱/x.jpg`），而工具用 `path.resolve()`
     按**进程 cwd** 解析 ⇒ 落到程序目录 ⇒ 文件不存在 ⇒ exit 2 ⇒ 界面拿到空 stdout，
     还显示"已生成（0 字符 / 1 行）"。两处都修了，这里把两处都钉住。 */
  const LIB = path.join(TMP, 'lib-inbox');
  fs.mkdirSync(path.join(LIB, '_收件箱', '批次甲'), { recursive: true });
  /* 造一张最小的"图片"：内容无所谓，工具只算 sha256 与存在性 */
  fs.writeFileSync(path.join(LIB, '_收件箱', '批次甲', 'p01.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47, 0, 0, 0, 0]));

  const run2 = (args) => spawnSync(process.execPath, [ENGINE, ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

  const okAbs = run2(['组装', '--recipe', 'ingest-single', '--subject', '数学',
    '--image', path.join(LIB, '_收件箱', '批次甲', 'p01.png'), '--data', LIB]);
  A('绝对路径原图 → 组装成功且 stdout 非空', okAbs.status === 0 && (okAbs.stdout || '').trim().length > 500,
    'exit=' + okAbs.status + ' chars=' + (okAbs.stdout || '').trim().length);

  const okRelSlash = run2(['组装', '--recipe', 'ingest-single', '--subject', '数学',
    '--image', '_收件箱/批次甲/p01.png', '--data', LIB]);
  A('★ 相对路径（正斜杠，界面传法）→ 按库根解析成功', okRelSlash.status === 0 && (okRelSlash.stdout || '').trim().length > 500,
    'exit=' + okRelSlash.status + ' chars=' + (okRelSlash.stdout || '').trim().length);

  const okRelBack = run2(['组装', '--recipe', 'ingest-single', '--subject', '数学',
    '--image', '_收件箱\\批次甲\\p01.png', '--data', LIB]);
  A('★ 相对路径（反斜杠）→ 也按库根解析', okRelBack.status === 0 && (okRelBack.stdout || '').trim().length > 500,
    'exit=' + okRelBack.status);

  const missRel = run2(['组装', '--recipe', 'ingest-single', '--subject', '数学',
    '--image', '_收件箱/批次甲/不存在.png', '--data', LIB]);
  A('不存在的相对路径 → exit 2（不许静默成功）', missRel.status === 2, 'exit=' + missRel.status);
  A('不存在的相对路径 → stderr 说明按库根解析', /库根/.test(missRel.stderr || ''), (missRel.stderr || '').split('\n')[0]);

  /* 指纹里必须含 sha256（溯源锚），且两次一致 */
  A('组装产物带 sourceImageSha256', /[0-9a-f]{64}/.test(okRelSlash.stdout || ''), '');
}

console.log('\n══ 六、指纹（改了内容必须变，否则无法追版本）══');{
  const r1 = engine(['指纹', '--recipe', 'ingest-single', '--json']);
  const r2 = engine(['指纹', '--recipe', 'ingest-single', '--json']);
  const f1 = r1.code === 0 ? JSON.parse(r1.out).fingerprint : '';
  const f2 = r2.code === 0 ? JSON.parse(r2.out).fingerprint : '';
  A('同内容两次指纹相同', !!f1 && f1 === f2, f1);

  const r3 = engine(['指纹', '--recipe', 'ingest-single', '--subject', '物理', '--json']);
  const r4 = engine(['指纹', '--recipe', 'ingest-single', '--subject', '英语', '--json']);
  const a = r3.code === 0 ? JSON.parse(r3.out).fingerprint : 'x';
  const b = r4.code === 0 ? JSON.parse(r4.out).fingerprint : 'y';
  A('换学科 → 指纹必须变（层内容不同）', a !== b, a + ' vs ' + b);

  const rl = engine(['指纹', '--json']);
  A('全部配方指纹可算（清单命令）', rl.code === 0 && Array.isArray(JSON.parse(rl.out).recipes), '');
}

console.log('\n══ 七、自检能真的判 FAIL（不能"永远 PASS"）══');
{
  const f1 = writeJson('st-good.json', { cards: [card({ studentAnswer: '−13', answerSource: '独立判卷' })] });
  const r1 = engine(['自检', '--recipe', 'ingest-single', '--in', f1, '--json']);
  const v1 = r1.code === 0 ? JSON.parse(r1.out).results[0].verdict : 'ERR';
  A('合规输出 → 自检 PASS', v1 === 'PASS', v1);

  const f2 = writeJson('st-bad.json', {
    cards: [card({ causeCode: 'K4', studentAnswer: '完全不同的作答内容' })],
  });
  const r2 = engine(['自检', '--recipe', 'ingest-single', '--in', f2, '--json']);
  const v2 = r2.code === 0 ? JSON.parse(r2.out).results[0].verdict : 'ERR';
  A('错误输出 → 自检必须 FAIL/ MOSTLY（判据有牙齿）', v2 === 'FAIL' || v2 === 'MOSTLY', v2);
}

console.log('\n══ 八、安全边界 ══');
{
  const r = engine(['组装', '--recipe', '../../etc', '--subject', '数学']);
  A('骗不过目录穿越（配方 id 只在配方根下找）', r.code === 2, 'code=' + r.code);
}
{
  const r = engine(['未知命令']);
  A('未知命令 → exit 2（不许猜一个分支跑）', r.code === 2, 'code=' + r.code);
}
{
  /* 任务单会整段粘给 AI。写进本机绝对路径 = 把目录结构（含孩子化名/年级/学科）
     一起交给对方会话，直接违反隐私红线。溯源靠 sha256，不靠路径。 */
  const img = path.join(ROOT, 'README.md');
  const r = engine(['组装', '--recipe', 'ingest-single', '--subject', '数学', '--image', img]);
  A('任务单不写本机绝对路径（隐私红线）', r.code === 0 && !/[A-Za-z]:\\/.test(r.out), r.code === 0 ? '扫描 ' + r.out.length + ' 字符，无盘符路径' : 'code=' + r.code);
  A('任务单仍带 sha256 溯源锚', r.out.includes('sourceImageSha256') && /[0-9a-f]{64}/.test(r.out), '');
  A('任务单带配方指纹', /指纹/.test(r.out) && /[0-9a-f]{12}/.test(r.out), '');
}

/* 清场 */
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }

console.log(`\nRESULT=${fail ? 'FAIL(' + fail + ')' : 'PASS'}  断言=${pass + fail}  通过=${pass}  失败=${fail}`);
process.exit(fail ? 1 : 0);
