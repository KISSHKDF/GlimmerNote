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

  /* 缺②：不许让接收方 AI 执行我们的命令/访问路径（它在另一个程序里，没有这个仓库） */
  A('★ 任务单不含要求对端执行的 node 命令', !/node\s+src[\\/]/i.test(ticket) && !/node\s+\S*_配方\.mjs/.test(ticket), '');
  A('★ 任务单明确"不需要运行命令/访问路径"', /不需要运行任何命令/.test(ticket), '');

  /* 缺③：附件必须被摆在第一位，且**由程序指认那一张**，不能叫人按名字去翻文件夹。
     2026-10-27 第二次事故：上一版写的是「点打开收件箱文件夹就能找到它」，而收件箱里的照片
     会被导入流程按页码改名（微信图片_…_242_134.jpg → p042.jpg，sha256 不变）⇒ 照着旧单子
     的名字找不到文件 ⇒ 附件发不出去 ⇒ 对端 AI 只能回「我没有看到图片」。 */
  A('★ 任务单第一件事就是"把照片作为附件发出去"', /先把这张照片作为附件发出去/.test(ticket), '');
  A('★ 任务单让程序指认那一张（定位这张图）', /定位这张图/.test(ticket), '');
  A('★ 任务单不再叫用户"照着文件名去找"', !/就能找到它/.test(ticket), '');
  A('★ 任务单给可对核的内容指纹前缀（名字会改，指纹不会）', /内容指纹前 12 位/.test(ticket), '');
  A('★ 任务单说明旧单子的文件名会失效', /改名/.test(ticket) && /别囤着用/.test(ticket), '');
  A('★ 任务单提醒要发原图不要发缩略图', /不要发微信\/相册里的缩略图/.test(ticket), '');
  /* 隐私：批次文件夹名 = 日期-化名-学科-书名，写进任务单等于把这些送进别人家云端会话。
     绝对路径已由第八节钉住，这里钉**相对路径**这一种泄漏形态。 */
  A('★ 任务单不含库内相对路径（_收件箱/… 会带出化名与学科）', !/_收件箱[\\/]/.test(ticket), '');
  A('★ 任务单不出现「数据」目录字样', !/数据[\\/]/.test(ticket), '');

  /* 止损：漏发图时 AI 应当停手，而不是编造 */
  A('★ 任务单含"没看到图片就停下"的止损指令', /我没有看到图片/.test(ticket) && /然后停下/.test(ticket), '');

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

  A('待处理清单只剩没建过卡的两张', JSON.stringify(names) === JSON.stringify(['待处理1.png', '待处理2.png']), JSON.stringify(names));
  A('total 只数待处理（侧栏角标/标题都用它）', J.total === 2, 'total=' + J.total);
  A('archivedCount 数到台账引用的两张（page 与 import 都算）', J.archivedCount === 2, 'archivedCount=' + J.archivedCount);
  A('archived 带出这两张的名字（页面"显示已归档"要用）', JSON.stringify(archNames) === JSON.stringify(['已建卡-import.png', '已建卡-page.png']), JSON.stringify(archNames));
  A('★ 已归档件不再算哈希（"显示慢"的正面修法：IO 只花在真待办上）', (J.archived || []).length === 2 && (J.archived || []).every(f => f.sha256 === undefined), JSON.stringify((J.archived || [])[0] || null));
  A('待处理件仍有 64 位内容指纹（找图/任务单还要靠它）', flat.length === 2 && flat.every(f => /^[0-9a-f]{64}$/.test(f.sha256 || '')), '');
  A('★ _收件箱/_已处理 下的照片两边都不列（物理归档位，永不回到待办）', !names.includes('老归档.png') && !archNames.includes('老归档.png'), JSON.stringify(names.concat(archNames)));

  const human = run3(['收件箱', '--data', L2]);
  A('人读输出说清"另有 N 张已处理、已归档不显示"', /已处理/.test(human.stdout) && /2 张/.test(human.stdout), (human.stdout || '').split('\n').filter(l => /待处理/.test(l))[0] || '');
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
  A('★ 台账里的反斜杠/大小写不同也算已处理（不做假阴性）', J5.archivedCount === 2, 'archivedCount=' + J5.archivedCount);
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
