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
    confidence: 'high', sourceImageSha256: SHA, notes: '', teacherAnswer: '',
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

console.log('\n══ 二·补、公开题库比对流程（2026-11-05 家长定的规则；配方层必须在场）══');
/* 判据设计：规则必须同时钉在**核心层**（所有配方自动带上）与**两个配方 prompt**（照着做的正文）里，
   反例库各带"假装查过/盲从站点"两条。少一处就是静默退化（配方会被人不断追加反例）。 */
{
  const read = p => fs.readFileSync(path.join(RECIPES, p), 'utf8');
  const core = read('_core/base.md');
  A('★ 核心层（_core/base.md）有「先搜公开题库」流程', core.includes('先与公开题库比对') || core.includes('先搜再解'), '');
  A('★ 核心层把「官方答案」的 note 口径写清（站点 + 比对点）', core.includes('站点') && core.includes('answerSourceNote'), '');
  A('★ 核心层有检索词隐私红线（禁学生化名/班级/学校/路径）',
    core.includes('隐私红线') && core.includes('学生化名') && core.includes('某同学'), '');
  A('★ 核心层有"答案打架由独立解法仲裁"判据（不许盲从站点）', core.includes('仲裁') && core.includes('分歧'), '');
  A('★ 核心层有"不能上网要明说"判据（不许假装查过）', core.includes('不能上网') || core.includes('无网络'), '');
  for (const id of ['ingest-page', 'ingest-single']) {
    const p = read(id + '/prompt.md');
    A(`★ ${id}/prompt.md 有「先搜题库」正文（含站点清单）`,
      /先搜题库|先用题干原文检索|与公开题库比对/.test(p) && p.includes('菁优网') && p.includes('作业帮'), '');
    A(`★ ${id}/prompt.md 自检清单含题库检索项`, /题库检索做过了/.test(p), '');
    const ap = read(id + '/anti-patterns.md');
    A(`★ ${id}/anti-patterns.md 有「不搜题库」反例`, /不搜题库|闷头独立判卷/.test(ap), '');
    A(`★ ${id}/anti-patterns.md 有「盲从站点」反例`, /答案打架|照抄/.test(ap) && /仲裁/.test(ap), '');
  }
  const meta1 = JSON.parse(read('ingest-page/meta.json'));
  const meta2 = JSON.parse(read('ingest-single/meta.json'));
  /* 2026-11-05：原判据写死 `version === '2.2.0'` 且要求**顶条** changelog 提题库 ⇒ 任何后续升版都会误红
     （断言名写的是 ≥，判据却是 ===）。改成真正的 ≥ 比较 + "某一条 changelog 记了题库比对"。 */
  const semverGte = (v, min) => { const a = String(v).split('.').map(Number), b = min.split('.').map(Number); for (let k = 0; k < 3; k++) { if ((a[k] || 0) !== b[k]) return (a[k] || 0) > b[k]; } return true; };
  const logged = m => (m.changelog || []).some(e => /题库/.test(e.note || ''));
  A('ingest-page 升版 ≥2.2.0 且 changelog 记了题库比对', semverGte(meta1.version, '2.2.0') && logged(meta1), meta1.version);
  A('ingest-single 升版 ≥2.1.0 且 changelog 记了题库比对', semverGte(meta2.version, '2.1.0') && logged(meta2), meta2.version);
  /* ★ 2026-11-07（用户两次强调，最高权威）：**卷面红字绝大部分不是老师批的**，
     红字只能作普通参考、**不能作定案标准**（即使确认是老师写的也不行）。
     ⇒ 契约里不许再出现「老师定案」这个来源；答案只能来自独立判卷或官方答案页。 */
  A('★★ base.md 写明红字只作参考、不作定案标准', /红字[^\n]{0,40}不作定案标准|只作参考，不作定案标准/.test(read('_core/base.md')), '');
  A('★★ base.md 写明「老师定案」已废除', /老师定案[^\n]{0,30}废除|废除[^\n]{0,30}老师定案/.test(read('_core/base.md')), '');
  A('★★ base.md 写明卷面红字绝大部分不是老师批的', /绝大部分不是[^\n]{0,20}老师|红字[^\n]{0,30}孩子自己批/.test(read('_core/base.md')), '');
  A('★ base.md 写明试卷抬头信息不进检索词', /抬头/.test(read('_core/base.md')), '');
  for (const id of ['ingest-page', 'ingest-single']) {
    const sch = JSON.parse(read(id + '/schema.json'));
    const srcEnum = sch.properties.cards.items.properties.answerSource.enum;
    A(`★★ ${id}/schema.json 的 answerSource 枚举里没有「老师定案」`, !srcEnum.includes('老师定案'), srcEnum.join('/'));
    A(`★★ ${id}/schema.json 写明红字不作定案标准`, /[不不能]作定案标准/.test(sch.properties.cards.items.properties.answerSource.description || ''), '');
    A(`★★ ${id}/prompt.md 写明没有「老师定案」这个选项`, /没有「老师定案」/.test(read(id + '/prompt.md')), '');
    A(`★ ${id}/schema.json 有 teacherAnswer 字段`, !!sch.properties.cards.items.properties.teacherAnswer, '');
    A(`★ ${id}/schema.json 有 inkAttribution 字段`, !!sch.properties.cards.items.properties.inkAttribution, '');
  }
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
  A('任务单不出现库根绝对路径（数据目录隐私红线）', !(okRelSlash.stdout || '').includes(LIB), '');
  /* ★ 2026-11-12（批次 3 / UX-02）：任务单**不许**把用户指到 `docs\` ——
     发行包（`build-release.ps1` 的 stage）只拷 `app\` + `tools\*.mjs` + `recipes\`，**没有 `docs\`**；
     改前那句「按 `docs\作答契约.md` 建卡入库」等于把用户指到一个**不存在的文件**，
     而界面第 4 步**本来就有**一个「📥 建卡入库」按钮。 */
  A('★ 任务单不出现 `docs\\` 路径（发行包里没有 docs\\）',
    !/docs\\/.test(okRelSlash.stdout || ''), ((okRelSlash.stdout || '').match(/[^\n]*docs\\[^\n]*/) || [''])[0].slice(0, 120));
  A('★ 任务单指向界面可达的第 4 步按钮（不是指路到仓库文档）',
    (okRelSlash.stdout || '').includes('建卡入库'), '');
  /* ══ 任务单是「交给别人家 AI」的文档。2026-10-27 用户拿第一版去问 WorkBuddy，对方直接拒绝执行。
     三处缺陷逐条钉住 —— 这些断言比「能生成」重要：生成得出来但交不出去，等于没有。 ══ */
  const ticket = okRelSlash.stdout || '';
  const iAiSec = ticket.indexOf('## 二、任务指令');
  const iBack = ticket.indexOf('## 三、回来之后');
  A('任务单分「给 AI 的」与「给人/本机的」两段', iAiSec > 0 && iBack > iAiSec, 'AI段@' + iAiSec + ' 回来之后@' + iBack);

  /* 缺①：sha256 必须在「给 AI 的那一段」里 —— 否则用户只复制那一段，AI 拿不到值，只能编或拒 */
  const iShaInTicket = ticket.indexOf('sourceImageSha256');
  A('★ sha256 位于「任务指令」段内（AI 才拿得到）', iShaInTicket > iAiSec && iShaInTicket < iBack,
    'sha@' + iShaInTicket + ' 区间[' + iAiSec + ',' + iBack + ')');

  /* 缺②改（2026-11-01 第三次事故：10:25 文字发出去了、照片附件始终没进对端会话，整单空转）：
     接收方若是**本机代理**（有 shell/文件权限，如 ZCode），任务单必须给它一条**自取原图**的
     只读命令；除这条命令外仍然不许外派任何别的命令（校验/入库永远只在本机做）。 */
  A('★ 任务单含分支 A 自取命令（找图 --sha 前12位 --json）', /找图 --sha [0-9a-f]{12} --json/.test(ticket), '');
  A('★ 自取命令之外不许外派别的命令（校验/入库只在本机）', !/配方\.mjs"?\s+校验/.test(ticket), '');
  A('★ 自取命令说明从 matches[0].abs 拿绝对路径读文件', /matches\[0\]\.abs/.test(ticket), '');
  A('★ 分支 A 要求读到后自算 SHA256 并核对指纹前 12 位', /自算该文件的 SHA256/.test(ticket) && /确认以前 12 位/.test(ticket), '');

  /* 缺③改（2026-11-01）：附件不再是第一步——本机代理自己取图，附件降级为网页版分支 B。
     程序指认那一张、指纹对核、原图不缩略图、旧单子会失效，这些纪律保留在网页版分支里。
     2026-10-27 第二次事故的教训（不能叫人按名字翻文件夹）继续由下面几条钉住。 */
  A('★ 附件降级为网页版分支（本机代理不用发照片）', /网页版/.test(ticket) && /不用发照片/.test(ticket) &&
    !/先把这张照片作为附件发出去/.test(ticket), '');
  A('★ 任务单让程序指认那一张（定位这张图）', /定位这张图/.test(ticket), '');
  A('★ 任务单不再叫用户"照着文件名去找"', !/就能找到它/.test(ticket), '');
  A('★ 任务单给可对核的内容指纹前缀（名字会改，指纹不会）', /内容指纹前 12 位/.test(ticket), '');
  A('★ 任务单说明旧单子的文件名会失效', /改名/.test(ticket) && /别囤着用/.test(ticket), '');
  A('★ 任务单提醒要发原图不要发缩略图', /不要发微信\/相册里的缩略图/.test(ticket), '');
  /* 隐私：批次文件夹名 = 日期-化名-学科-书名，写进任务单等于把这些送进别人家云端会话。
     绝对路径已由第八节钉住，这里钉**相对路径**这一种泄漏形态。 */
  A('★ 任务单不含库内相对路径（_收件箱/… 会带出化名与学科）', !/_收件箱[\\/]/.test(ticket), '');
  A('★ 任务单不出现「数据」目录字样', !/数据[\\/]/.test(ticket), '');

  /* 止损：两个分支都拿不到图时 AI 应当停手，而不是编造 */
  A('★ 任务单含"没看到图片就停下"的止损指令（分支 B）', /我没有看到图片/.test(ticket) && /然后停下/.test(ticket), '');
  A('★ 任务单含"没拿到与指纹一致的原图就停"（分支 A）', /没有拿到与指纹一致的原图/.test(ticket), '');

  /* 第四次事故（2026-11-01，用户实测）：对端 AI 走完分支 A、按指纹取到了图、哈希也对得上，
     但它这个会话读不了图（topic 里回的是"画面为空"）。当时的任务单只列了三种止损
     ——取不到 / 多张 / 指纹不符——**没有"取到了但看不见"**，于是对端只能自己发明办法：
     转码成 PNG、把原图复制到临时目录、再造一张合成图做对照，空转一整个会话，
     还把别人的照片多复制了一份出去。
     根因是任务单自己写了"拿不到就停"，却漏了最常见的一种拿不到。下面四条钉住修法。 */
  A('★ 分支 A 含视觉自检：先复述图上标题，再谈录题', /视觉自检/.test(ticket) && /复述/.test(ticket), '');
  A('★ "取到但看不见"是一种止损项，且有固定回报语',
    /图取到了、指纹也一致，但你看不见画面/.test(ticket) && /看不到图像画面/.test(ticket), '');
  A('★ "取到但看不见"时不许反复换格式/换分辨率重试', /不要\*\*反复重试/.test(ticket) || /换格式、换分辨率/.test(ticket), '');
  A('★ 分支 A 禁止转码/复制原图落盘（含临时目录）',
    /不许写任何文件/.test(ticket) && /不需要保存文件/.test(ticket), '');
  A('★ 给用户的段落写明分支 A 前提是"能读图"', /前提是它得能/.test(ticket) && /读图/.test(ticket), '');

  /* 本机留痕段必须明确标注"不用发给 AI" */
  A('本机留痕段标注"不用发给 AI"', /本机留痕[\s\S]{0,60}不用发给 AI/.test(ticket), '');

  /* ══ 找图：照片被改名之后，唯一还能把它捞回来的标识是内容指纹 ══
     钉的是本次事故的**恢复路径**：旧任务单里的文件名失效了，但 sha256 一直有效。 */
  const inb = run2(['收件箱', '--json', '--data', LIB]);
  const inbJ = inb.status === 0 ? JSON.parse(inb.stdout) : { batches: [] };
  const flat = [];
  for (const b of (inbJ.batches || [])) for (const f of (b.files || [])) flat.push(f);
  const f01 = flat.find(f => f.name === 'p01.png');
  A('收件箱列表带出每张图的内容指纹（找图的依据）', !!f01 && /^[0-9a-f]{64}$/.test(f01.sha256 || ''), f01 ? f01.sha256.slice(0, 12) : '列表里没有 p01.png');
  if (f01) {
    const loc = run2(['找图', '--sha', f01.sha256, '--json', '--data', LIB]);
    const lj = loc.status === 0 ? JSON.parse(loc.stdout) : { total: -1 };
    A('★ 找图：按 64 位指纹定位到那一张', lj.total === 1 && lj.matches[0].rel === f01.rel, JSON.stringify(lj).slice(0, 150));

    const loc12 = run2(['找图', '--sha', f01.sha256.slice(0, 12), '--json', '--data', LIB]);
    A('★ 找图：前 12 位（任务单上给人看的那串）也定位得到', loc12.status === 0 && JSON.parse(loc12.stdout).total === 1, 'exit=' + loc12.status);

    /* 事故场景重放：文件被改名（sha 不变），旧名字已不可用 */
    fs.renameSync(path.join(LIB, '_收件箱', '批次甲', 'p01.png'), path.join(LIB, '_收件箱', '批次甲', 'p042.jpg'));
    const la0 = run2(['找图', '--sha', f01.sha256, '--json', '--data', LIB]);
    const la = la0.status === 0 ? JSON.parse(la0.stdout) : { total: -1 };
    A('★ 改名后按指纹仍能找回（名字会变，内容不会）', la.total === 1 && /p042\.jpg$/.test(la.matches[0].name || ''), JSON.stringify(la).slice(0, 150));

    const badArg = run2(['找图', '--sha', 'zz', '--data', LIB]);
    A('找图：指纹格式不对 → exit 2（不许混成"没找到"）', badArg.status === 2, 'exit=' + badArg.status);
    const miss = run2(['找图', '--sha', 'f'.repeat(64), '--json', '--data', LIB]);
    A('找图：库里确实没有 → exit 1（与参数错误分档）', miss.status === 1, 'exit=' + miss.status);
  }
}

console.log('\n══ 五·补、收件箱「已处理归档」（2026-10-30：不再把所有照片一股脑列出来）══');
/* 用户原话：「这个收件箱，把所有的照片都显示出来，又长又多，显示还慢…已处理过的照片全部归档，
   不要在这个窗口显示了」。现场 256 张里 184 张早就建过卡，列表却全列，还对每张算 sha256。
   这里钉的是**判据本身**与**退化方向**：判错成"藏起来"比判错成"多显示"严重得多，
   所以任何不确定（没有台账 / 台账坏了）都必须退回"全部待处理"，且原因要说出口。 */
{
  const run3 = (args) => spawnSync(process.execPath, [ENGINE, ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const L2 = path.join(TMP, 'lib-archive');
  const inb = path.join(L2, '_收件箱');
  fs.mkdirSync(path.join(inb, '批次乙'), { recursive: true });
  fs.mkdirSync(path.join(inb, '_已处理'), { recursive: true });
  /* 内容各不相同（否则 sha 撞车会让"同内容不同件"的判据失真） */
  const mk = (p, tag) => fs.writeFileSync(p, Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.from(tag, 'utf8')]));
  mk(path.join(inb, '待处理1.png'), 'A');
  mk(path.join(inb, '批次乙', '待处理2.png'), 'B');
  mk(path.join(inb, '批次乙', '已建卡-page.png'), 'C');
  mk(path.join(inb, '已建卡-import.png'), 'D');
  mk(path.join(inb, '_已处理', '老归档.png'), 'E');
  const LED = path.join(L2, '_原卷台账.json');
  fs.writeFileSync(LED, JSON.stringify({
    version: 1,
    cards: { '甲|K1': { page: '_收件箱/批次乙/已建卡-page.png', import: '_收件箱/已建卡-import.png' } },
  }, null, 1), 'utf8');

  const list = run3(['收件箱', '--json', '--data', L2]);
  const J = list.status === 0 ? JSON.parse(list.stdout) : { batches: [], archived: [], total: -1, archivedCount: -1 };
  const flat = [];
  for (const b of (J.batches || [])) for (const f of (b.files || [])) flat.push(f);
  const names = flat.map(f => f.name).sort();
  const archNames = (J.archived || []).map(f => f.name).sort();

  /* ⚠ 2026-10-31 更新（用户裁定「只要处理过，那当然不应该放在收件箱里了呀」）：
     判据新增**批次级**（同一批次里有一张被台账引用 ⇒ 整批都算处理过），
     所以 `批次乙/待处理2.png` 现在也归档 —— 同一份作业是**一次处理**的。
     因此本节期望值随之改变：待处理只剩 1 张（顶层那张，它没有同批次兄弟）。 */
  A('待处理清单只剩没建过卡的那张（批次级：同批次的也算处理过）', JSON.stringify(names) === JSON.stringify(['待处理1.png']), JSON.stringify(names));
  A('total 只数待处理（侧栏角标/标题都用它）', J.total === 1, 'total=' + J.total);
  A('archivedCount 数到台账引用的两张 + 同批次的那张（批次级）', J.archivedCount === 3, 'archivedCount=' + J.archivedCount);
  A('archived 带出这三张的名字（页面"显示已归档"要用）', JSON.stringify(archNames) === JSON.stringify(['已建卡-import.png', '已建卡-page.png', '待处理2.png']), JSON.stringify(archNames));
  A('★ 已归档件不再算哈希（"显示慢"的正面修法：IO 只花在真待办上）', (J.archived || []).length === 3 && (J.archived || []).every(f => f.sha256 === undefined), JSON.stringify((J.archived || [])[0] || null));
  A('待处理件仍有 64 位内容指纹（找图/任务单还要靠它）', flat.length === 1 && flat.every(f => /^[0-9a-f]{64}$/.test(f.sha256 || '')), '');
  A('★ _收件箱/_已处理 下的照片两边都不列（物理归档位，永不回到待办）', !names.includes('老归档.png') && !archNames.includes('老归档.png'), JSON.stringify(names.concat(archNames)));

  const human = run3(['收件箱', '--data', L2]);
  A('人读输出说清"另有 N 张已处理、已归档不显示"', /已处理/.test(human.stdout) && /3 张/.test(human.stdout), (human.stdout || '').split('\n').filter(l => /待处理/.test(l))[0] || '');
  A('--all 才列出已归档的名字（CLI 自查用，页面通道没有这个 flag）', /已建卡-page\.png/.test(run3(['收件箱', '--all', '--data', L2]).stdout), '');
  A('不加 --all 时人读输出不列已归档件（列表要短）', !/已建卡-page\.png/.test(human.stdout), '');

  /* 退化方向①：没有台账（新克隆/空库）⇒ 全部按待处理显示，不许"借机藏起来" */
  fs.renameSync(LED, LED + '.bak');
  const noLed = run3(['收件箱', '--json', '--data', L2]);
  const J2 = noLed.status === 0 ? JSON.parse(noLed.stdout) : { total: -1, archivedCount: -1 };
  A('没有台账 → 全部按待处理显示（新库不许误藏）', J2.total === 4 && J2.archivedCount === 0, 'total=' + J2.total + ' archived=' + J2.archivedCount);

  /* 退化方向②：台账坏了 ⇒ 仍按待处理显示，且**把原因说出来**（静默藏 = 用户以为照片丢了） */
  fs.writeFileSync(LED, '{ 这不是 JSON', 'utf8');
  const badLed = run3(['收件箱', '--json', '--data', L2]);
  const J3 = badLed.status === 0 ? JSON.parse(badLed.stdout) : { total: -1, archivedNote: '' };
  A('★ 台账坏了 → 退回"全部待处理"并说明原因（不许静默藏照片）',
    J3.total === 4 && /台账/.test(String(J3.archivedNote || '')),
    'total=' + J3.total + ' note=' + String(J3.archivedNote || '').slice(0, 60));

  /* 退化方向③：台账形状不对（cards 是数组，PowerShell 往返就会这样）⇒ 同上，不许抛异常 */
  fs.writeFileSync(LED, JSON.stringify({ cards: [{ page: '_收件箱/待处理1.png' }] }), 'utf8');
  const shapeBad = run3(['收件箱', '--json', '--data', L2]);
  const J4 = shapeBad.status === 0 ? JSON.parse(shapeBad.stdout) : { total: -1 };
  A('cards 是数组（错形状）→ 退化成全部待处理，不抛异常', J4.total === 4, 'total=' + J4.total);

  /* 路径写法容错：台账里用反斜杠/大小写不同也算已处理（Windows 路径大小写不敏感） */
  fs.writeFileSync(LED, JSON.stringify({
    cards: { '甲|K1': { page: '_收件箱\\批次乙\\已建卡-page.png', import: '_收件箱/已建卡-IMPORT.png' } },
  }), 'utf8');
  const norm = run3(['收件箱', '--json', '--data', L2]);
  const J5 = norm.status === 0 ? JSON.parse(norm.stdout) : { archivedCount: -1 };
  /* 期望 3：台账引用的两张 + 同批次的那张（批次级判据） */
  A('★ 台账里的反斜杠/大小写不同也算已处理（不做假阴性）', J5.archivedCount === 3, 'archivedCount=' + J5.archivedCount);
}

/* ══════════════ 六·补·内容判据（2026-10-31 修）══════════════
 * 用户复报（2026-10-31）：「收件箱中还有这么多？这些照片我们都处理过了呀」。
 * 上一版（2026-10-30）只认**路径字符串** ⇒ 漏判一大片。真库现场：
 *   同一张照片，台账里 `page`/`import` 有时记收件箱原路径，有时记**原卷库里重命名后的路径**
 *   （收件箱 `.../p08-src61.jpg` ↔ 台账 `九年级/英语/原卷/课课练9上-p08-src61.jpg`）。
 *   内容同一张、路径两套 ⇒ 纯路径判据永远判不出来。真库实测 256 张里 56 张这样漏判。
 *
 * 这里钉三件事：
 *   ① 内容判据**能认出来**（路径对不上但字节相同 ⇒ 已处理）；
 *   ② 内容判据**不误藏**（字节不同 ⇒ 仍是待办）；
 *   ③ 性能不塌（已归档件仍然**一次字节都不读**：sha256 字段缺席）。 */
console.log('\n══ 六·补、收件箱「内容判据」（2026-10-31：路径对不上但内容同一张也算已处理）══');
{
  const run3 = (args) => spawnSync(process.execPath, [ENGINE, ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const L3 = path.join(TMP, 'lib-content');
  const inb = path.join(L3, '_收件箱');
  fs.mkdirSync(path.join(inb, '批次丙'), { recursive: true });
  fs.mkdirSync(path.join(L3, '原卷库'), { recursive: true });
  const mk = (p, tag) => fs.writeFileSync(p, Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.from(tag, 'utf8')]));
  /* 场景①：收件箱里一张，台账指向**原卷库里的同内容副本**（改了名的同一张） */
  mk(path.join(inb, '批次丙', 'p08-src61.png'), 'SAME');
  mk(path.join(L3, '原卷库', '课课练9上-p08-src61.png'), 'SAME');
  /* 场景②：收件箱里一张，台账指向**内容不同**的另一张 ⇒ 必须是待办 */
  mk(path.join(inb, '批次丙', 'p09-src62.png'), 'OTHER');
  mk(path.join(L3, '原卷库', '课课练9上-p09-src62.png'), 'DIFFERENT');
  /* 场景③：纯待办件，谁都没引用 */
  mk(path.join(inb, '批次丙', 'p10-src63.png'), 'PENDING');

  const LED = path.join(L3, '_原卷台账.json');
  fs.writeFileSync(LED, JSON.stringify({
    version: 1,
    cards: {
      '乙|E1': { page: '原卷库/课课练9上-p08-src61.png' },
      '乙|E2': { page: '原卷库/课课练9上-p09-src62.png' },
    },
  }, null, 1), 'utf8');

  const r = run3(['收件箱', '--json', '--data', L3]);
  const J = r.status === 0 ? JSON.parse(r.stdout) : { batches: [], archived: [], total: -1, archivedCount: -1 };
  const flat = [];
  for (const b of (J.batches || [])) for (const f of (b.files || [])) flat.push(f);
  const names = flat.map(f => f.name).sort();
  const archNames = (J.archived || []).map(f => f.name).sort();

  A('★ 内容判据：路径对不上但字节相同 ⇒ 判为已处理（真库 4 张这样漏判）',
    archNames.includes('p08-src61.png'), 'archived=' + JSON.stringify(archNames));
  A('★ 内容判据不误藏：台账指向的是**内容不同**的另一张 ⇒ 仍是待办',
    names.includes('p09-src62.png'), '待办=' + JSON.stringify(names));
  A('谁都没引用的那张仍在待办清单里',
    names.includes('p10-src63.png'), '待办=' + JSON.stringify(names));
  A('待处理清单只剩这两张（没把没做过的藏起来）',
    JSON.stringify(names) === JSON.stringify(['p09-src62.png', 'p10-src63.png']), JSON.stringify(names));
  A('total 与待处理清单一致', J.total === 2, 'total=' + J.total);
  A('★ 已归档件仍然不算哈希（性能：IO 只花在真待办上）',
    (J.archived || []).length === 1 && (J.archived || []).every(f => f.sha256 === undefined),
    JSON.stringify((J.archived || [])[0] || null));
  A('待处理件仍有 64 位内容指纹（找图/任务单还要靠它）',
    flat.length === 2 && flat.every(f => /^[0-9a-f]{64}$/.test(f.sha256 || '')), '');

  /* 退化方向④：台账引用的文件**不在盘** ⇒ 不能凭它判已处理（宁可多显示） */
  fs.writeFileSync(LED, JSON.stringify({
    version: 1,
    cards: { '乙|E1': { page: '原卷库/根本不存在.png' } },
  }), 'utf8');
  const miss = run3(['收件箱', '--json', '--data', L3]);
  const JM = miss.status === 0 ? JSON.parse(miss.stdout) : { total: -1, archivedCount: -1 };
  A('台账引用的文件不在盘 ⇒ 不据此判已处理（不产生假阳性）',
    JM.archivedCount === 0 && JM.total === 3, 'archived=' + JM.archivedCount + ' total=' + JM.total);

  /* 退化方向⑤：台账引用的路径**越出库根**（`../` 或绝对路径）⇒ 一律不读、不据此判已处理。
   *    这条是安全边界：内容判据要读文件，若库外路径被 resolve 到库外，就等于让只读工具
   *    碰了库外的文件，还可能拿老库数据误判成"已处理"。 */
  fs.writeFileSync(LED, JSON.stringify({
    version: 1,
    cards: { '乙|E1': { page: '../库外/x.png' }, '乙|E2': { page: path.join(L3, '..', '库外绝对.png') } },
  }), 'utf8');
  const outside = run3(['收件箱', '--json', '--data', L3]);
  const JO = outside.status === 0 ? JSON.parse(outside.stdout) : { total: -1, archivedCount: -1 };
  A('★ 台账引用越出库根 ⇒ 不读不判（库外路径不参与内容判据）',
    JO.archivedCount === 0 && JO.total === 3, 'archived=' + JO.archivedCount + ' total=' + JO.total);

  /* 退化方向⑥（2026-10-31 实测踩到）：`--data` 必须真的生效。
   *    起因：本轮在模块顶层 import 了 `_路径护栏.mjs`，而它在**导入期**就求值并缓存库根，
   *    抢在 `--data` 落进 CTB_DATA 之前 ⇒ root 仍指向仓库 src，--data 直接失效。
   *    教训：任何在导入期求值库根的模块，都不能在参数处理之前被引入。 */
  const withData = run3(['收件箱', '--json', '--data', L3]);
  const JD = withData.status === 0 ? JSON.parse(withData.stdout) : { root: '' };
  A('★ --data 参数真的生效（root 就是它指的库，不是仓库目录）',
    path.resolve(JD.root || '') === path.resolve(L3), 'root=' + JD.root);
}

/* ══════════════ 六·补三·批次级 / 同族 / 转置三条判据（2026-10-31）══════════════
 * 用户裁定：「47 张，只要处理过，那当然不应该放在收件箱里了呀」
 *   ⇒ 同一份作业是**一次处理**的（同一次扫描、同一次挑错），整批都算处理过。
 * 三条新判据各钉一组断言：
 *   ① 批次级：台账引用了某批次目录下任一文件 ⇒ 整批归档
 *      （真库现场：错题卷 7 张卡的 page 指向合卷扫描件，纯路径判据一张都认不出）
 *   ② 顶层同族：顶层文件的"族"（去掉页码/加工后缀）里已有件被台账引用 ⇒ 整族归档
 *      （真库现场：`…物理10月阶段练习-p1p2.jpg` 与 `…-答题纸2.jpg` 同族）
 *   ③ 转置：收件箱件与某个已处理件**互为转置**（尺寸交换）**且内容证据成立**（sha256 相等）
 *      ⇒ 同一张照片的两种姿态（真库现场：横拍的照片在库里存了"转正前/转正后"两份）。
 *      ★ 2026-10-31 C02 整改：尺寸+体积只是**候选筛选**，拿不到内容证据的件**留在待处理**——
 *        旧判据（只比尺寸+体积）会把内容无关、尺寸恰好互为转置的照片误藏成"已处理"。
 * 每条都必须有"不误藏"的对照断言。
 */
console.log('\n══ 六·补三、批次级 / 同族 / 转置三条判据（2026-10-31）══');
{
  const run3 = (args) => spawnSync(process.execPath, [ENGINE, ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const { pngGray } = require('../scripts/png-cjs.cjs');
  const L5 = path.join(TMP, 'lib-batch');
  const inb5 = path.join(L5, '_收件箱');
  const mkPng = (p, w, h, tag) => {
    const buf = pngGray(w, h, () => 200);
    fs.writeFileSync(p, Buffer.concat([buf, Buffer.from(tag, 'utf8')]));
  };

  /* ── 场景①批次级：台账引用批次里的一张 ⇒ 整批归档 ── */
  const B1 = path.join(inb5, '2026-01-02-学生甲-数学-作业');
  fs.mkdirSync(B1, { recursive: true });
  mkPng(path.join(B1, 'p01.png'), 100, 200, 'B1');
  mkPng(path.join(B1, 'p02.png'), 120, 220, 'B2');   // 这一张没被台账引用
  mkPng(path.join(B1, 'p03.png'), 140, 240, 'B3');
  /* ── 场景②同族：顶层两个同族文件，只有其中一个被台账引用 ── */
  mkPng(path.join(inb5, '2026-03-04-学生乙-物理-阶段卷-p1p2.png'), 300, 400, 'F1');
  mkPng(path.join(inb5, '2026-03-04-学生乙-物理-阶段卷-答题纸1.png'), 320, 420, 'F2');
  /* ── 场景③转置（★ 2026-10-31 C02 整改后**只做候选筛选**）：
     收件箱 200x300，已处理件 300x200 —— 尺寸互为转置、体积同量级，但**内容不同**（T1/T2）。
     旧判据（尺寸+体积即判"同一张照片的两种姿态"）会把无关照片误藏成"已处理"；
     新判据要求**内容证据**（sha256 相等）才归档 ⇒ 这一张必须留在待处理清单。 ── */
  mkPng(path.join(inb5, '2026-05-06-学生丙-化学-横拍.png'), 200, 300, 'T1');
  /* ── 对照：完全没人碰过的件 ── */
  mkPng(path.join(inb5, '2026-09-09-学生丁-语文-全新.png'), 500, 600, 'NEW');
  mkPng(path.join(inb5, '2026-07-08-学生戊-数学-全新批次.png'), 520, 640, 'NEW2');

  const LED5 = path.join(L5, '_原卷台账.json');
  fs.writeFileSync(LED5, JSON.stringify({
    version: 1,
    cards: {
      '甲|M1': { page: '_收件箱/2026-01-02-学生甲-数学-作业/p01.png' },
      '乙|M2': { page: '_收件箱/2026-03-04-学生乙-物理-阶段卷-答题纸1.png' },
      '丙|M3': { page: '原卷库/转正后.png' },
    },
  }, null, 1), 'utf8');
  /* 转置判据的**候选**：原卷库里放一张 300x200 的"转正后"件，且被台账引用。
     ⚠ 两张图的大小必须在同一量级（旧条件③）—— 这里给两张同样大小、tag 不同的 PNG。
     ★ 但"同量级 + 互为转置"**只是候选筛选**：C02 整改后还要求 sha256 相等（同一份字节）。
       本夹具刻意让两张**内容不同**（尺寸本身不同 ⇒ 字节必然不同）⇒ 判据必须**不**归档它。
       否则就退回"内容无关的照片被贴上已处理标签"那个缺陷（面上一张 1600x1200 就能骗过去）。 */
  fs.mkdirSync(path.join(L5, '原卷库'), { recursive: true });
  mkPng(path.join(L5, '原卷库', '转正后.png'), 300, 200, 'T2');

  const r = run3(['收件箱', '--json', '--data', L5]);
  const J = r.status === 0 ? JSON.parse(r.stdout) : { batches: [], archived: [], total: -1, archivedCount: -1 };
  const flat = [];
  for (const b of (J.batches || [])) for (const f of (b.files || [])) flat.push(f);
  const names = flat.map(f => f.name).sort();
  const archNames = (J.archived || []).map(f => f.name).sort();

  A('★ 批次级判据：该批次已建过卡 ⇒ 整批归档（含没被单独引用的那两张）',
    archNames.includes('p01.png') && archNames.includes('p02.png') && archNames.includes('p03.png'),
    'archived=' + JSON.stringify(archNames));
  A('★ 顶层同族判据：同族里已有件被引用 ⇒ 同族另一张也归档',
    archNames.includes('2026-03-04-学生乙-物理-阶段卷-p1p2.png') &&
    archNames.includes('2026-03-04-学生乙-物理-阶段卷-答题纸1.png'),
    'archived=' + JSON.stringify(archNames));
  /* ★ 2026-10-31 C02 整改：转置判据（尺寸互为转置 + 体积同量级）**只是候选筛选**，
     结论必须有内容证据（sha256 相等）。这一对是**内容不同**的无关照片（tag T1/T2），
     按新判据必须留在待处理清单 —— 旧断言（期望归档）是照旧（错误）行为写的，已反转。 */
  A('★ 转置判据只做候选筛选：尺寸互为转置但内容不同 ⇒ **留在待处理**（C02）',
    names.includes('2026-05-06-学生丙-化学-横拍.png') && !archNames.includes('2026-05-06-学生丙-化学-横拍.png'),
    'archived=' + JSON.stringify(archNames) + ' 待办=' + JSON.stringify(names));
  A('★ 批次级判据不误藏：从未建过卡的批次 ⇒ 整批仍在待办',
    names.includes('2026-07-08-学生戊-数学-全新批次.png') && names.includes('2026-09-09-学生丁-语文-全新.png'),
    '待办=' + JSON.stringify(names));
  A('待处理清单只剩该剩的三张', JSON.stringify(names) === JSON.stringify([
    '2026-05-06-学生丙-化学-横拍.png',
    '2026-07-08-学生戊-数学-全新批次.png', '2026-09-09-学生丁-语文-全新.png']), JSON.stringify(names));
}

/* ══════════════ 六·补二·卡片裁图判据 + 健壮性（2026-10-31 复核补上）══════════════
 * 复核发现的三个问题，各补一条会红的断言：
 *  ① P1 漏判：有一批卡的 `page` 指向**另一张整页**，而"这张照片本身"被裁成了卡片里的
 *     `原卷截图.jpg` —— 那张裁图**不在台账引用集合里** ⇒ 只用台账做候选源会漏判。
 *     真库实测 5 张（错题卷 图3~图7 → M0021~M0025）已建卡却仍挂在待办清单。
 *  ② P2 越界：收件箱里的 junction/符号链接指向库外时，库外文件会被读进来算指纹。
 *  ③ P3 崩溃：单个文件读不动（权限/占用）会让**整个收件箱列表挂掉**（EPERM 直接退出）。
 */
console.log('\n══ 六·补二、卡片裁图判据 + 健壮性（2026-10-31 复核）══');
{
  const run3 = (args) => spawnSync(process.execPath, [ENGINE, ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const L4 = path.join(TMP, 'lib-card');
  const inb = path.join(L4, '_收件箱', '批次丁');
  const cardDir = path.join(L4, '甲班', '数学', 'M0001-测试卡');
  fs.mkdirSync(inb, { recursive: true });
  fs.mkdirSync(cardDir, { recursive: true });
  fs.mkdirSync(path.join(L4, '原卷库'), { recursive: true });
  const mk = (p, tag) => fs.writeFileSync(p, Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.from(tag, 'utf8')]));
  /* 这张收件箱照片 == 卡片里的题图（裁图），而卡的 page 指向**另一张整页** */
  mk(path.join(inb, '题图.png'), 'CROP');
  mk(path.join(cardDir, '原卷截图.jpg'), 'CROP');
  fs.writeFileSync(path.join(cardDir, '错题记录.md'), '# M0001\n', 'utf8');
  mk(path.join(L4, '原卷库', '另一张整页.jpg'), 'PAGE');
  mk(path.join(inb, '真待办.png'), 'PENDING');
  const LED4 = path.join(L4, '_原卷台账.json');
  fs.writeFileSync(LED4, JSON.stringify({
    version: 1,
    cards: { '甲|M0001': { page: '原卷库/另一张整页.jpg' } },
  }, null, 1), 'utf8');

  const r = run3(['收件箱', '--json', '--data', L4]);
  const J = r.status === 0 ? JSON.parse(r.stdout) : { batches: [], archived: [], total: -1, archivedCount: -1 };
  const flat = [];
  for (const b of (J.batches || [])) for (const f of (b.files || [])) flat.push(f);
  const names = flat.map(f => f.name).sort();
  const archNames = (J.archived || []).map(f => f.name).sort();

  A('★ 卡片裁图判据：收件箱那张 == 卡片里的 原卷截图.jpg ⇒ 判为已处理（真库 5 张这样漏判）',
    archNames.includes('题图.png') && !names.includes('题图.png'),
    'archived=' + JSON.stringify(archNames) + ' 待办=' + JSON.stringify(names));
  A('★ 卡片裁图判据不误藏：不是同一张的那张仍在待办',
    names.includes('真待办.png'), '待办=' + JSON.stringify(names));
  A('待处理清单只剩该剩的一张', JSON.stringify(names) === JSON.stringify(['真待办.png']), JSON.stringify(names));

  /* P3：一个读不动的文件不许拖垮整个列表 */
  const locked = path.join(inb, '锁住.png');
  mk(locked, 'LOCKED');
  try {
    /* 用"目录当文件"制造一个必然读不动的条目：把它换成目录，readFileSync 会抛 EISDIR */
    fs.unlinkSync(locked);
    fs.mkdirSync(locked, { recursive: true });
    const r2 = run3(['收件箱', '--json', '--data', L4]);
    const J2 = r2.status === 0 ? JSON.parse(r2.stdout) : { total: -1 };
    A('★ 收件箱里有读不动的项 ⇒ 整个列表照常列出（不许整列表崩掉）',
      r2.status === 0 && J2.total === 1, 'exit=' + r2.status + ' total=' + J2.total);
    fs.rmSync(locked, { recursive: true, force: true });
  } catch (e) {
    A('★ 收件箱里有读不动的项 ⇒ 整个列表照常列出（不许整列表崩掉）', false, 'setup 失败：' + e.message);
  }
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
  /* 任务单会整段粘给 AI。**数据目录**的路径（库根/收件箱/原图所在处）会把目录结构
     （含孩子化名/年级/学科）一起交给对方会话，直接违反隐私红线；溯源靠 sha256，不靠路径。
     2026-11-01 口径收精确：程序自身安装路径（node.exe / _配方.mjs）不含任何个人信息，
     允许出现在「分支 A」的找图命令里 —— 那是本机代理自取原图的唯一通道。 */
  const img = path.join(ROOT, 'README.md');
  const r = engine(['组装', '--recipe', 'ingest-single', '--subject', '数学', '--image', img]);
  A('任务单不写原图所在路径（数据目录隐私红线）', r.code === 0 && !r.out.includes(img), r.code === 0 ? '扫描 ' + r.out.length + ' 字符' : 'code=' + r.code);
  A('任务单不出现收件箱/数据目录字样（防批次化名外泄）', !/_收件箱[\\/]/.test(r.out) && !/数据[\\/]/.test(r.out), '');
  A('任务单仍带 sha256 溯源锚', r.out.includes('sourceImageSha256') && /[0-9a-f]{64}/.test(r.out), '');
  A('任务单带配方指纹', /指纹/.test(r.out) && /[0-9a-f]{12}/.test(r.out), '');
}

console.log('\n══ 九、批次 2 兼容：选卡是**纯追加**（不选卡时旧契约逐条不变）══');
/* 批次 2 给 `组装` 加了 `--card` / `--card-conflict`，给 `清单` 加了 `--packs` 与经验包段落。
   兼容红线只有一条：**不选卡时行为与今天逐字节相同**。本段钉的是"不需要外部基线"的那一半
   （契约形状与既有字段一个不动）；"与改造前真引擎逐字节对拍"在 `tests\neg-card-select.cjs`
   （它用 `git show 83dbe5c:src\tools\_配方.mjs` 取基线引擎对拍）。两份各管一段，不重复。 */
{
  const LIB2 = path.join(TMP, 'lib-card-contract');
  fs.mkdirSync(path.join(LIB2, '_收件箱', '批次甲'), { recursive: true });
  fs.writeFileSync(path.join(LIB2, '_收件箱', '批次甲', 'p01.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47, 0, 0, 0, 0]));
  const taskRecs = () => {
    const d = path.join(LIB2, '_录题');
    return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'))) : [];
  };

  const r1 = engine(['组装', '--recipe', 'ingest-single', '--subject', '数学', '--data', LIB2]);
  A('无 --card 的组装仍成功（选卡是可选参数，不是新前置）', r1.code === 0 && r1.out.length > 500, 'exit=' + r1.code + ' chars=' + r1.out.length);
  A('★ 不选卡时任务单**没有**经验包段（纯追加：一个字节都不加）',
    !r1.out.includes('### 本次追加的方法（经验包）'), '');
  A('任务单四段结构逐条仍在（一/二/三/四 四个标题，旧契约形状没动）',
    ['## 一、你要做的事', '## 二、任务指令', '## 三、回来之后', '## 四、本机留痕'].every((h) => r1.out.includes(h)), '');

  const before = taskRecs().length;
  const t1 = engine(['组装', '--recipe', 'ingest-single', '--subject', '数学', '--data', LIB2, '--task']);
  const t2 = engine(['组装', '--recipe', 'ingest-single', '--subject', '数学', '--data', LIB2, '--task']);
  const recs = taskRecs();
  A('不选卡时任务记录照常落盘（--task 没被选卡改动）', t1.code === 0 && t2.code === 0 && recs.length === before + 2, 'exit=' + t1.code + '/' + t2.code);
  const two = recs.slice(-2);
  A('★ 不选卡时任务记录的 cards 仍是空数组（保持现值）',
    two.length === 2 && two.every((r) => Array.isArray(r.cards) && r.cards.length === 0), JSON.stringify(two.map((r) => r.cards)));
  A('★ 不选卡的 contractDigest 仍是 64 位 hex 且两次相同（摘要口径没被选卡改动）',
    two.length === 2 && /^[0-9a-f]{64}$/.test(two[0].contractDigest || '') && two[0].contractDigest === two[1].contractDigest,
    two.length === 2 ? two[0].contractDigest : '(记录数不足)');

  const fp = engine(['指纹', '--recipe', 'ingest-single', '--json']);
  const fpj = fp.code === 0 ? JSON.parse(fp.out) : null;
  A('指纹 --json 的字段集合恰为旧契约那 5 个（不许"顺手"往里加字段）',
    !!fpj && JSON.stringify(Object.keys(fpj).sort()) === JSON.stringify(['fingerprint', 'layers', 'recipe', 'subject', 'version']),
    fpj ? Object.keys(fpj).join(',') : 'exit=' + fp.code);

  const lj = engine(['清单', '--json']);
  const ljo = lj.code === 0 ? JSON.parse(lj.out) : null;
  A('清单 --json 的既有字段（root/recipes）与每条配方的字段集合不变',
    !!ljo && Array.isArray(ljo.recipes) && 'root' in ljo &&
    ljo.recipes.every((r) => JSON.stringify(Object.keys(r).sort()) === JSON.stringify(['id', 'kind', 'layers', 'title', 'version'])),
    ljo ? 'recipes=' + ljo.recipes.length : 'exit=' + lj.code);
  A('清单 --json **追加** packs 字段（经验包段落只加不改）',
    !!ljo && 'packs' in ljo, ljo ? 'packs=' + JSON.stringify(ljo.packs).slice(0, 60) : '');

  const off = engine(['指纹', '--recipe', 'ingest-single', '--card', 'a/b@1.0.0']);
  A('选卡参数只对组装生效：指纹带 --card → exit 2（收下不用=静默忽略，因此直接拒）',
    off.code === 2 && /只对/.test(off.err), 'exit=' + off.code);
}

/* 清场 */
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }

console.log(`\nRESULT=${fail ? 'FAIL(' + fail + ')' : 'PASS'}  断言=${pass + fail}  通过=${pass}  失败=${fail}`);
process.exit(fail ? 1 : 0);
