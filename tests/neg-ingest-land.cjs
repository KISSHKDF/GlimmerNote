#!/usr/bin/env node
/**
 * 阴性用例（2026-11-04）：录题「建卡入库」整条链 —— 从校验通过的 JSON 到库里真的一张卡。
 *
 * 为什么必须有它（实测出来的缺陷，不是设想）：
 *   录题页走完「生成任务单 → 校验 → 人工确认」就**结束**了，页面写着「本页不落库」——
 *   因为**仓内没有任何东西能把 JSON 变成卡**。于是：
 *     · 2026-11-04 19:36 那次录题：任务记录 `t-20261104-193617-a063bc.json` 的
 *       `cards` 是**空数组**（校验用的 JSON 只在页面过了一遍，从没存进记录），
 *       全库**零张新卡**（6295 个文件里当天只被碰了 4 个，全是过程件/任务记录）。
 *     · 用户点完「确认本任务」什么也没发生，而且**界面没有任何提示说"没落库"**。
 *   历史上所有入库都是**仓外一次性脚本**做的（`work\kk-math-20261101\land.mjs`），
 *   而且那脚本连三道门禁都只是**打印命令让人手跑** ⇒ 落库瞬间 `blindStatus='未盲解'`、
 *   `answerMode/answerSlots` 缺失，是事后手工补的。这条链以前**不在仓内**，就没有门禁管。
 *
 * 本用例六段：
 *   A 源码级·壳：op `ingestLand` 已注册；taskId 形状门禁；固定映射不透传；**进写闸且在 finally 放闸**；
 *     显式 --data；回真实退出码；正文走临时文件（不塞 argv）。
 *   B 源码级+**行为级**·前端：host.js 暴露 H.ingestLand 且走 bridge；
 *     ingest.js 的 `onLand` **真的能被驱动**，且**实际送出的参数**与绑定正确。
 *   C 行为级·引擎：临时库上真跑 `_录题入库.mjs 入库` ⇒ 卡目录四件套 + 索引条目 + 任务记录回写。
 *   D 行为级·**三层前置**：没确认 ⇒ 不写盘；信封 taskId 不符 ⇒ exit 3 且不写盘；
 *     卡片的 sourceImageSha256 与任务记录不符 ⇒ exit 3 且不写盘。
 *   E 行为级·**门禁当场跑**：入库后作答契约/配图/原卷溯源三道门禁都已跑过（不留"事后手跑"的欠账）。
 *   F 阴性自证：把引擎里的任一前置检查摘掉 ⇒ 断言集必须变红（证明判据有牙齿）。
 *
 * 退出码 0 = 全绿。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const E = require('./_测试环境.cjs');

let fails = 0, total = 0;
/* ★ 2026-11-05（合并评审 P2-8 同类）：裁图走 PowerShell + System.Drawing，只有 Windows 有。
   非 Windows 上依赖裁图产物的断言**显式 SKIP**（打印出来、不计入通过），不冒充通过、也不误报回归。 */
const CAN_CROP = process.platform === 'win32';
const SKIP = (n, why) => console.log('[SKIP] ' + n + '  → ' + why);
const A = (n, ok, d) => {
  total++;
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d !== undefined ? '  → ' + String(d).slice(0, 220) : ''}`);
  if (!ok) fails++;
};

const ROOT = path.resolve(__dirname, '..');
const CS = fs.readFileSync(path.join(ROOT, 'src', 'shell', 'CTBShellV2.cs'), 'utf8');
const HOST = fs.readFileSync(path.join(ROOT, 'src', 'app', 'js', 'host.js'), 'utf8');
const INGEST = fs.readFileSync(path.join(ROOT, 'src', 'app', 'js', 'views', 'ingest.js'), 'utf8');
const LAND = fs.readFileSync(path.join(ROOT, 'src', 'tools', '_录题入库.mjs'), 'utf8');

/* ═════════ A · 壳侧（源码级） ═════════ */
console.log('═══ A · 壳：ingestLand op 已注册、形状门禁、写读分界 ═══');
A('op 分发里有 ingestLand', /op\s*==\s*"ingestLand"/.test(CS));
A('ingestLand 调 HostBridge 的实现', /bridge\.IngestLand\(payload\)/.test(CS));
A('IngestLand 用 _录题入库.mjs 的 入库', /ToolPath\("_录题入库\.mjs"\), "入库"/.test(CS));
A('taskId 形状门禁在场（复用 TaskConfirm 的 TaskIdOk）', /public string IngestLand[\s\S]{0,600}?TaskIdOk\(taskId\)/.test(CS));
A('student 必填（程序不猜卡挂在谁名下）', /public string IngestLand[\s\S]{0,900}?缺少 student/.test(CS));
A('显式 --data 注入库根（不靠环境变量继承）', /public string IngestLand[\s\S]{0,1600}?args\.Add\("--data"\);\s*args\.Add\(DataRoot\)/.test(CS));
A('正文走**临时文件**（不塞 argv：会撞 Windows 32K 上限）',
  /public string IngestLand[\s\S]{0,2000}?gn-ingest-land-/.test(CS) && /public string IngestLand[\s\S]{0,2000}?args\.Add\("--file"\)/.test(CS));
A('进写闸（入库写用户库：卡目录 + 学科索引 + 任务记录）',
  /public string IngestLand[\s\S]{0,2200}?WriteGate\.Wait\(1200000\)/.test(CS));
/* ★ 写闸必须**在 finally 里**放（2026-11-04 P0·Critical 同族坑）：
   取闸不放 ⇒ 一次调用就把壳的写闸焊死 ⇒ 此后组卷/批改/归档全部卡 20 分钟。
   判据锚在 finally 块上（不是"方法体里有 Release"）——否则把释放挪到正常路径末尾也判过。 */
{
  const m = /public string IngestLand\(string payload\)\s*\{/.exec(CS);
  let body = '';
  if (m) {
    let depth = 0, i = CS.indexOf('{', m.index);
    for (; i < CS.length; i++) { if (CS[i] === '{') depth++; else if (CS[i] === '}') { depth--; if (!depth) break; } }
    body = CS.slice(CS.indexOf('{', m.index), i + 1);
  }
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const fi = code.lastIndexOf('finally');
  let inFinally = false;
  if (fi >= 0) {
    const brace = code.indexOf('{', fi);
    let depth = 0, j = brace;
    for (; j < code.length; j++) { if (code[j] === '{') depth++; else if (code[j] === '}') { depth--; if (!depth) break; } }
    inFinally = /WriteGate\.Release\(\)/.test(code.slice(brace, j + 1));
  }
  A('放闸挂在 finally 上（异常路径也会放，否则一样焊死）', inFinally);
  A('判据自证：把 finally 里的放闸摘掉 ⇒ 判据必须判否',
    !/WriteGate\.Release\(\)/.test(code.replace(/finally\s*\{[^}]*WriteGate\.Release\(\);[^}]*\}/, '')));
}
A('回真实退出码（0/1/2/3，不硬编码）',
  /public string IngestLand[\s\S]{0,2600}?"\{\\"ok\\":true,\\"code\\":"\s*\+\s*exit/.test(CS));

/* ═════════ B · 前端（源码级 + 行为级） ═════════ */
console.log('\n═══ B · 前端：host 通道 + 页面入库按钮 ═══');
A('host.js 暴露 H.ingestLand', /H\.ingestLand\s*=\s*async function/.test(HOST));
A("host.js ingestLand 走 bridge('ingestLand')", /bridge\('ingestLand'/.test(HOST));
A('ingest.js 有入库按钮 id=igLand', /id="igLand"/.test(INGEST));
A('ingest.js 的 onLand 调 H.ingestLand', /H\.ingestLand\(st\.taskId/.test(INGEST));
A('ingest.js：入库失败明确说"没有写盘"（不许让人以为写进去了）', /没有写盘/.test(INGEST));
A('ingest.js：旧文案「本页不落库 / 本页不写库」已从校验通过路径移除',
  !/下一步：按 `docs\\\\作答契约\.md` 建卡入库（本页不写库）/.test(INGEST));

/* B2 行为级：把 onLand / landBoxHtml 真切出来驱动（不匹配字面量）。 */
const sliceFn = (from, to) => {
  const a = INGEST.indexOf(from);
  if (a < 0) throw new Error('ingest.js 里找不到起始锚点：' + from);
  const b = to ? INGEST.indexOf(to, a + from.length) : INGEST.length;
  if (to && b < 0) throw new Error('ingest.js 里找不到结束锚点：' + to);
  return INGEST.slice(a, b);
};
let LAND_PAGE = null, LAND_ERR = '';
try {
  const src = sliceFn('function landBoxHtml()', 'async function onLand()')
    + sliceFn('async function onLand()', 'async function onCheck()');
  LAND_PAGE = (U, H, S, st, M) => new Function('U', 'H', 'S', 'st', 'M',
    src + '\nreturn { landBoxHtml, onLand };')(U, H, S, st, M);
} catch (e) { LAND_ERR = String((e && e.message) || e); }
A('B2 页面 onLand/landBoxHtml 能从 ingest.js 切出来并驱动（切不出来即红）', !!LAND_PAGE, LAND_ERR);
const mkLandPage = (reply, over) => {
  const o = over || {};
  const els = {};
  const mkEl = () => ({ innerHTML: '', disabled: false, textContent: '', value: '', onclick: null });
  const calls = { ingestLand: [], toast: [] };
  const st = Object.assign({ taskId: 't-20261104-200000-aaaaaa', subject: '数学', task: '' }, o.st || {});
  const U = { $id: (id) => (els[id] || (els[id] = mkEl())), esc: (s) => String(s) };
  /* 学生下拉的默认选中项 = 库里第一个学生（与 landBoxHtml 的默认值一致） */
  const kids = o.kids || ['学生甲', '学生乙'];
  els.igStudent = mkEl();
  els.igStudent.value = kids[0];
  const H = { ingestLand: async (id, text, student, subject) => { calls.ingestLand.push({ id, text, student, subject }); return reply; } };
  const S = { toast: (m, k) => calls.toast.push(String(m)) };
  const M = { students: () => kids, student: () => kids[0] };
  const fns = LAND_PAGE(U, H, S, st, M);
  return { st, calls, els, fns, $id: U.$id };
};

(async () => {
  const p = mkLandPage({ ok: true, code: 0, out: '✔ 已入库 1 张卡：M0142\n', err: '' });
  p.$id('igIn').value = '{ "cards": [1] }';
  await p.fns.onLand();
  A('B2 行为级：onLand 实际送出 taskId / 原文 / 学生 / 学科',
    p.calls.ingestLand.length === 1
    && p.calls.ingestLand[0].id === 't-20261104-200000-aaaaaa'
    && p.calls.ingestLand[0].text === '{ "cards": [1] }'
    && p.calls.ingestLand[0].student === '学生甲'
    && p.calls.ingestLand[0].subject === '数学',
    JSON.stringify(p.calls.ingestLand[0] || {}));
  A('B2 行为级：成功时上屏「已入库」', /已入库/.test(p.$id('igResult').innerHTML));

  const p2 = mkLandPage({ ok: true, code: 3, out: '✖ 与任务不匹配：信封里的 taskId=…\n', err: '' });
  p2.$id('igIn').value = '{ "cards": [] }';
  await p2.fns.onLand();
  A('B2 行为级：exit 3 渲染「与任务不匹配」且明说没有写盘',
    /与任务不匹配/.test(p2.$id('igResult').innerHTML) && /没有写盘/.test(p2.$id('igResult').innerHTML));
  const p3 = mkLandPage({ ok: true, code: 1, out: '', err: '✖ 任务还没经人工确认\n' });
  p3.$id('igIn').value = '{ "cards": [] }';
  await p3.fns.onLand();
  A('B2 行为级：exit 1 上屏工具原文（不美化、不吞）',
    /还没经人工确认/.test(p3.$id('igResult').innerHTML));
  A('B2 行为级：没有任务句柄时不调通道（直接拦下）',
    await (async () => {
      const p4 = mkLandPage({ ok: true, code: 0, out: '', err: '' }, { st: { taskId: null } });
      p4.$id('igIn').value = '{ "cards": [] }';
      await p4.fns.onLand();
      return p4.calls.ingestLand.length === 0;
    })());

  /* ═════════ C · 行为级·引擎：真跑入库 ═════════ */
  console.log('\n═══ C · 行为级·引擎：真跑 _录题入库.mjs 入库 ═══');
  const LIB = E.allocTempDir('gn-ingest-land-');
  const run = (args, env) => {
    const r = spawnSync(process.execPath, [E.tool(args[0]), ...args.slice(1)], {
      encoding: 'utf8', maxBuffer: 64e6,
      env: Object.assign({}, process.env, { CTB_DATA: path.join(os.tmpdir(), '__不存在__' + Date.now()) }, env || {}),
    });
    return { code: r.status == null ? -1 : r.status, out: String(r.stdout || '') + String(r.stderr || '') };
  };
  const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
  const w = (root, rel, buf) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); return p; };
  /* 一张**真 JPEG**（最小合法 SOF0 头 + EOI）：裁图走 System.Drawing，读不出尺寸就没法裁。
     这里用一张 8x8 的灰度 JPEG，够工具判尺寸与裁图。 */
  const JPG = Buffer.from(
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCABkAGQBAREA/8QAHwAAAQUBAQEBAQ' +
    'AAAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1Fh' +
    'ByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZ' +
    'WmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXG' +
    'x8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APn+iiigD//Z', 'base64');
  const imgRel = '_收件箱/2026-11-04-学生甲-数学-第一章/p001.jpg';
  w(LIB, imgRel, JPG);
  const IMG_SHA = sha256(JPG);

  /* 学生索引（学科级形态） */
  w(LIB, path.join('七年级-学生甲', '数学', '_索引.json'), Buffer.from(JSON.stringify({
    schema: 'glimmernote.index/v1', student: '学生甲', grade: '七年级', subject: '数学',
    items: [], updatedAt: '2026-11-01',
  }), 'utf8'));

  /* 任务记录（已确认） */
  const TID = 't-20261104-200000-aaaaaa';
  w(LIB, path.join('_录题', TID + '.json'), Buffer.from(JSON.stringify({
    schema: 'glimmernote.ingest-task/v1', taskId: TID, createdAt: '2026-11-04T20:00:00+08:00',
    recipe: { id: 'ingest-page', version: '2.1.0', fingerprint: 'deadbeefcafe' },
    cards: [], image: { sha256: IMG_SHA, rel: imgRel }, subject: '数学',
    contractDigest: 'cafe1234', taskDigest: 'aaaa', taskText: '（测试）',
    confirmedAt: '2026-11-04T20:01:00+08:00',
  }), 'utf8'));

  const mkCards = (over) => {
    const o = over || {};
    const c = {
      subject: '数学', title: '煮面条工序时间', source: '第一章数学 · 第3题', sourceDate: '2026-11-04',
      questionText: '小敏煮面条，最少需要 ____ min。',
      studentAnswer: '22', answer: '13',
      answerSource: '独立判卷', answerSourceNote: '可并行工序共 3min，再烧水 7min，再煮 3min，合计 13min', teacherAnswer: '',
      causeCode: 'L1', causeNote: '把能并行的工序串行相加了',
      kpoints: ['统筹优化'], difficulty: '中', hasFigure: false, confidence: 'high',
      sourceImageSha256: o.sha || IMG_SHA, notes: '', bbox: [0.02, 0.29, 0.96, 0.08],
      answerMode: 'blank', answerSlots: ['13'],
    };
    if (o.dropSourceImageSha) delete c.sourceImageSha256;
    return {
      envelope: { schema: 'glimmernote.ingest-result/v1', taskId: o.taskId || TID, imageSha256: o.envSha || IMG_SHA },
      result: { pageSummary: { totalQuestions: 8, markedWrong: 1, unmarked: 7 }, cards: [c], skipped: [{ what: '全页', reason: '测试' }] },
    };
  };
  const cardsFile = (obj, name) => {
    const p = path.join(LIB, name || 'cards.json');
    fs.writeFileSync(p, JSON.stringify(obj), 'utf8');
    return p;
  };

  /* C1 正常入库 */
  const cf1 = cardsFile(mkCards());
  const r1 = run(['_录题入库.mjs', '入库', TID, '--file', cf1, '--student', '学生甲', '--subject', '数学', '--data', LIB]);
  A('C1 正常入库 ⇒ exit 0', r1.code === 0, 'exit=' + r1.code + ' ' + r1.out.slice(0, 200));
  const idx = JSON.parse(fs.readFileSync(path.join(LIB, '七年级-学生甲', '数学', '_索引.json'), 'utf8').replace(/^\uFEFF/, ''));
  A('C1 索引里真的多了一张卡（M0001）', idx.items.length === 1 && idx.items[0].id === 'M0001',
    'items=' + idx.items.length + ' id=' + (idx.items[0] && idx.items[0].id));
  const cardDir = path.join(LIB, '七年级-学生甲', '数学', 'M0001-煮面条工序时间');
  for (const f of ['题干.html', '错题记录.md']) {
    A('C1 卡目录里有 ' + f, fs.existsSync(path.join(cardDir, f)));
  }
  if (CAN_CROP) {
    A('C1 卡目录里有 原卷截图.jpg', fs.existsSync(path.join(cardDir, '原卷截图.jpg')));
    A('C1 裁图记录 sidecar 在（_原卷台账 只认它）', fs.existsSync(path.join(cardDir, '_裁图记录.json')));
  } else {
    SKIP('C1 原卷截图.jpg / 裁图 sidecar', '非 Windows 无 System.Drawing，裁图不可用（Windows 上必须跑）');
  }
  A('C1 任务记录回写了 cards[]（"确认"确认的是真东西，不是空盒子）', (() => {
    const j = JSON.parse(fs.readFileSync(path.join(LIB, '_录题', TID + '.json'), 'utf8').replace(/^\uFEFF/, ''));
    return Array.isArray(j.cards) && j.cards.length === 1;
  })());
  A('C1 索引条目带全复习字段（reviews/reviewCount/passStreak —— 缺了界面会崩）',
    idx.items[0] && Array.isArray(idx.items[0].reviews) && idx.items[0].reviewCount === 0 && idx.items[0].passStreak === 0);
  A('C1 answerMode/answerSlots **不是**入库器写的（红线：只能由 _作答门禁.mjs 写）', (() => {
    /* 入库器自己不写；但它跑 _作答门禁 批量 时会写 —— 所以这里判"入库器代码里没有直接写"，
       真正的红线由 tools\lint + 门禁用例守。这里只判"入库器源码不出现 answerSlots 赋值"。 */
    return !/it\.answerSlots\s*=/.test(LAND) && !/it\.answerMode\s*=/.test(LAND);
  })());

  /* C2 幂等：同一份再跑一次 ⇒ **不产生**第二张卡（用户点两次按钮不该造出两张一样的错题） */
  const before = idx.items.length;
  const r1b = run(['_录题入库.mjs', '入库', TID, '--file', cf1, '--student', '学生甲', '--subject', '数学', '--data', LIB]);
  const idx2 = JSON.parse(fs.readFileSync(path.join(LIB, '七年级-学生甲', '数学', '_索引.json'), 'utf8').replace(/^\uFEFF/, ''));
  A('C2 同一份再入库 ⇒ **幂等跳过**，库里还是 1 张（不造重复卡）',
    r1b.code === 0 && idx2.items.length === before && /幂等/.test(r1b.out),
    'exit=' + r1b.code + ' items=' + idx2.items.length + ' ' + r1b.out.slice(0, 140));

  /* ═════════ D · 行为级·三层前置（不写盘） ═════════ */
  console.log('\n═══ D · 行为级·三层前置：任一层不过 ⇒ 零写盘 ═══');
  const LIB2 = E.allocTempDir('gn-ingest-land-d-');
  w(LIB2, imgRel, JPG);
  w(LIB2, path.join('七年级-学生甲', '数学', '_索引.json'), Buffer.from(JSON.stringify({
    schema: 'glimmernote.index/v1', student: '学生甲', grade: '七年级', subject: '数学',
    items: [], updatedAt: '2026-11-01',
  }), 'utf8'));
  const TID2 = 't-20261104-200001-bbbbbb';
  const mkTask = (confirmed) => Buffer.from(JSON.stringify({
    schema: 'glimmernote.ingest-task/v1', taskId: TID2, createdAt: '2026-11-04T20:00:01+08:00',
    recipe: { id: 'ingest-page', version: '2.1.0', fingerprint: 'deadbeefcafe' },
    cards: [], image: { sha256: IMG_SHA, rel: imgRel }, subject: '数学',
    contractDigest: 'cafe1234', taskDigest: 'bbbb', taskText: '（测试）',
    ...(confirmed ? { confirmedAt: '2026-11-04T20:01:00+08:00' } : {}),
  }), 'utf8');
  const cardCount = (root) => {
    const p = path.join(root, '七年级-学生甲', '数学', '_索引.json');
    if (!fs.existsSync(p)) return -1;
    return (JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')).items || []).length;
  };
  const dirCount = (root) => {
    const p = path.join(root, '七年级-学生甲', '数学');
    if (!fs.existsSync(p)) return 0;
    return fs.readdirSync(p, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('_')).length;
  };

  /* D1 没确认 ⇒ 不许入库 */
  w(LIB2, path.join('_录题', TID2 + '.json'), mkTask(false));
  const cfd = path.join(LIB2, 'cards.json');
  fs.writeFileSync(cfd, JSON.stringify(mkCards({ taskId: TID2 })), 'utf8');
  const rd1 = run(['_录题入库.mjs', '入库', TID2, '--file', cfd, '--student', '学生甲', '--subject', '数学', '--data', LIB2]);
  A('D1 任务**没确认** ⇒ 不许入库（exit≠0）且零写盘',
    rd1.code !== 0 && cardCount(LIB2) === 0 && dirCount(LIB2) === 0,
    'exit=' + rd1.code + ' cards=' + cardCount(LIB2) + ' dirs=' + dirCount(LIB2) + ' ' + rd1.out.slice(0, 120));

  /* D2 已确认但信封 taskId 不符 ⇒ exit 3 */
  w(LIB2, path.join('_录题', TID2 + '.json'), mkTask(true));
  const cfd2 = path.join(LIB2, 'cards2.json');
  fs.writeFileSync(cfd2, JSON.stringify(mkCards({ taskId: 't-20261104-999999-cccccc' })), 'utf8');
  const rd2 = run(['_录题入库.mjs', '入库', TID2, '--file', cfd2, '--student', '学生甲', '--subject', '数学', '--data', LIB2]);
  A('D2 信封 taskId 与任务不符 ⇒ exit 3 且零写盘',
    rd2.code === 3 && cardCount(LIB2) === 0 && dirCount(LIB2) === 0,
    'exit=' + rd2.code + ' cards=' + cardCount(LIB2) + ' ' + rd2.out.slice(0, 140));

  /* D3 信封 imageSha256 不符 ⇒ exit 3 */
  const cfd3 = path.join(LIB2, 'cards3.json');
  fs.writeFileSync(cfd3, JSON.stringify(mkCards({ taskId: TID2, envSha: 'b'.repeat(64) })), 'utf8');
  const rd3 = run(['_录题入库.mjs', '入库', TID2, '--file', cfd3, '--student', '学生甲', '--subject', '数学', '--data', LIB2]);
  A('D3 信封 imageSha256 与任务记录不符 ⇒ exit 3 且零写盘',
    rd3.code === 3 && cardCount(LIB2) === 0 && dirCount(LIB2) === 0,
    'exit=' + rd3.code + ' ' + rd3.out.slice(0, 140));

  /* D4 卡片 sourceImageSha256 不符 ⇒ exit 3 */
  const cfd4 = path.join(LIB2, 'cards4.json');
  fs.writeFileSync(cfd4, JSON.stringify(mkCards({ taskId: TID2, sha: 'c'.repeat(64) })), 'utf8');
  const rd4 = run(['_录题入库.mjs', '入库', TID2, '--file', cfd4, '--student', '学生甲', '--subject', '数学', '--data', LIB2]);
  A('D4 卡的 sourceImageSha256 与任务记录不符 ⇒ exit 3 且零写盘',
    rd4.code === 3 && cardCount(LIB2) === 0 && dirCount(LIB2) === 0,
    'exit=' + rd4.code + ' ' + rd4.out.slice(0, 140));

  /* D5 学生不存在 ⇒ exit 2（程序不猜） */
  const cfd5 = path.join(LIB2, 'cards5.json');
  fs.writeFileSync(cfd5, JSON.stringify(mkCards({ taskId: TID2 })), 'utf8');
  const rd5 = run(['_录题入库.mjs', '入库', TID2, '--file', cfd5, '--student', '不存在的人', '--subject', '数学', '--data', LIB2]);
  A('D5 学生不存在 ⇒ exit 2 且零写盘（程序不替人猜卡挂谁名下）',
    rd5.code === 2 && cardCount(LIB2) === 0 && dirCount(LIB2) === 0,
    'exit=' + rd5.code + ' ' + rd5.out.slice(0, 140));

  /* D6 契约字段缺项 ⇒ exit 1 且零写盘 */
  const bad = mkCards({ taskId: TID2 });
  delete bad.result.cards[0].confidence;
  const cfd6 = path.join(LIB2, 'cards6.json');
  fs.writeFileSync(cfd6, JSON.stringify(bad), 'utf8');
  const rd6 = run(['_录题入库.mjs', '入库', TID2, '--file', cfd6, '--student', '学生甲', '--subject', '数学', '--data', LIB2]);
  A('D6 契约必填字段缺项 ⇒ exit 1 且零写盘（缺项点名，不静默补）',
    rd6.code === 1 && cardCount(LIB2) === 0 && dirCount(LIB2) === 0 && /confidence/.test(rd6.out),
    'exit=' + rd6.code + ' ' + rd6.out.slice(0, 160));

  /* D7 bbox 越界 ⇒ exit 1 且零写盘 */
  const badBox = mkCards({ taskId: TID2 });
  badBox.result.cards[0].bbox = [0.9, 0.1, 0.5, 0.2];
  const cfd7 = path.join(LIB2, 'cards7.json');
  fs.writeFileSync(cfd7, JSON.stringify(badBox), 'utf8');
  const rd7 = run(['_录题入库.mjs', '入库', TID2, '--file', cfd7, '--student', '学生甲', '--subject', '数学', '--data', LIB2]);
  A('D7 bbox 越界 ⇒ exit 1 且零写盘（坐标判据在入库前）',
    rd7.code === 1 && cardCount(LIB2) === 0 && dirCount(LIB2) === 0 && /bbox/.test(rd7.out),
    'exit=' + rd7.code + ' ' + rd7.out.slice(0, 160));

  /* ═════════ E · 行为级·门禁当场跑 ═════════ */
  console.log('\n═══ E · 行为级·门禁当场跑（不留"事后手跑"的欠账） ═══');
  /* ⚠ `_作答门禁.mjs` / `_配图门禁.mjs` / `_原卷台账.mjs` **只认 CTB_DATA**，不认 `--data`
     （它们在 import 期就 `libraryRoot()`；见 `_库根.mjs` 的解析优先级）。
     所以这里必须把 CTB_DATA 指向真库，不能像上面那样故意给一个不存在的目录。 */
  const gatesRun = (root) => {
    const r = run(['_作答门禁.mjs', '门禁'], { CTB_DATA: root });
    const f = run(['_配图门禁.mjs', '门禁'], { CTB_DATA: root });
    const p = run(['_原卷台账.mjs', '门禁'], { CTB_DATA: root });
    return { answer: r.code, figure: f.code, ledger: p.code, out: r.out + f.out + p.out };
  };
  const g = gatesRun(LIB);
  A('E1 入库后作答契约门禁**通过**（答案齐全）', g.answer === 0, 'exit=' + g.answer + ' ' + g.out.slice(0, 300));
  A('E2 入库后配图门禁**通过**', g.figure === 0, 'exit=' + g.figure);
  if (!CAN_CROP) {
    SKIP('E3/E4 原卷溯源台账', '依赖裁图 sidecar，非 Windows 不可用');
  } else {
    A('E3 入库后原卷溯源台账门禁**通过**（裁图 sidecar 被折进去了）', g.ledger === 0, 'exit=' + g.ledger);
    A('E4 原卷台账里能查到这张卡的溯源（page/box 都在）', (() => {
      const p = path.join(LIB, '_原卷台账.json');
      if (!fs.existsSync(p)) return false;
      const j = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
      const e = (j.cards || {})['学生甲|M0001'];
      return !!e && !!e.box && !!e.by;
    })(), '');
    A('E5 盲解清稿已备好（只有题干；卡面显示「未盲解」是事实，但材料不能欠账）',
      (() => {
        const d = path.join(LIB, '_盲解');
        if (!fs.existsSync(d)) return false;
        const f = fs.readdirSync(d).find(x => /盲解清稿/.test(x));
        if (!f) return false;
        const txt = fs.readFileSync(path.join(d, f), 'utf8');
        /* 清稿的自我声明：**只含题干**，不含任何答案、孩子答案与错因 */
        if (!/只含题干/.test(txt)) return false;
        /* 且**不许**含答案（否则盲解就白做了） */
        const body = txt.split('【作答】')[0];
        if (/13min|13 min|统筹优化/.test(body)) return false;
        return /M0001/.test(txt);
      })(), '');
  }

  /* ═════════ F · 阴性自证（判据有牙齿） ═════════ */
  console.log('\n═══ F · 阴性自证：摘掉前置检查 ⇒ 判据必须变红 ═══');
  /* 变异体要能真跑，所以它的 import 必须指向**仓里的真工具**（相对路径会随文件位置失效）。
     这里把 `from './X.mjs'` 改成绝对 file URL，其余一个字不动 —— 变异体与真源码的差别
     **只有**被摘掉的那一条检查。 */
  const TOOLS_ABS = path.join(ROOT, 'src', 'tools').replace(/\\/g, '/');
  const absolutize = (src) => src.replace(/from '\.\/([A-Za-z_\u4e00-\u9fa5]+\.mjs)'/g,
    (m, f) => "from 'file:///" + TOOLS_ABS + '/' + f + "'");
  const runMutant = (mutant, lib, taskId, cardsPath) => {
    const p = path.join(os.tmpdir(), 'gn-ingest-mutant-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(16).slice(2, 8) + '.mjs');
    fs.writeFileSync(p, mutant, 'utf8');
    try {
      return spawnSync(process.execPath, [p, '入库', taskId, '--file', cardsPath, '--student', '学生甲', '--subject', '数学', '--data', lib],
        { encoding: 'utf8', maxBuffer: 64e6, env: Object.assign({}, process.env, { CTB_DATA: lib }) });
    } finally { try { fs.unlinkSync(p); } catch { } }
  };
  const freshLib = (tag) => {
    const L = E.allocTempDir('gn-ingest-land-' + tag + '-');
    w(L, imgRel, JPG);
    w(L, path.join('七年级-学生甲', '数学', '_索引.json'), Buffer.from(JSON.stringify({
      schema: 'glimmernote.index/v1', student: '学生甲', grade: '七年级', subject: '数学', items: [], updatedAt: '2026-11-01',
    }), 'utf8'));
    return L;
  };
  /* F1 把"没确认不许入库"那条摘掉 ⇒ D1 应当变红（即工具会放行）。
     ⚠ 变异锚点必须**精确**：用 `\n  }`（两空格缩进的收尾）而不是宽松的 `\n    }`，
        否则正则会一路吃到下一个同缩进的 `}`，把信封那一段也吃掉 ——
        那样"变异体放行了"就变成了"变异体根本走不到那一步"，自证是假的。 */
  {
    const mutant = absolutize(LAND.replace(/if \(!task\.confirmedAt\) \{[\s\S]*?\n  \}/, 'if (false) { }'));
    const changed = mutant !== LAND;
    A('F1 变异锚点命中（"没确认"的前置检查被摘掉）', changed);
    A('F1 变异体**只**动了那一处（信封那段还在）',
      /envelope/.test(mutant) && /if \(false\) \{ \}/.test(mutant));
    const L = freshLib('f1');
    w(L, path.join('_录题', TID2 + '.json'), mkTask(false));
    const cf = path.join(L, 'cards.json');
    fs.writeFileSync(cf, JSON.stringify(mkCards({ taskId: TID2 })), 'utf8');
    const rm = runMutant(mutant, L, TID2, cf);
    const n = cardCount(L);
    A('F1 变异体**确实放行了**未确认的入库（证明 D1 那条判据抓得住）',
      rm.status === 0 && n === 1, 'exit=' + rm.status + ' cards=' + n + ' ' + String(rm.stderr || '').slice(0, 200));
  }
  /* F2 把"信封 taskId 不符"那条摘掉 ⇒ D2 应当变红。
     ⚠ 锚点用 `\n    }`（**四**空格缩进）：这段在 `if (obj && …) {` 里面，比上面那段深一层。
        用 `\n  }` 会匹配到更外层，把后面一大段吃掉 ⇒ 变异体语法错误 ⇒ 自证是假的。 */
  {
    const mutant = absolutize(LAND.replace(/if \(String\(env\.taskId \|\| ''\) !== taskId\) \{[\s\S]*?\n    \}/, 'if (false) { }'));
    const changed = mutant !== LAND;
    A('F2 变异锚点命中（"信封 taskId 不符"的拦截被摘掉）', changed);
    A('F2 变异体**只**动了那一处（"没确认"那段还在，且后续代码完整）',
      /if \(!task\.confirmedAt\)/.test(mutant) && /if \(false\) \{ \}/.test(mutant)
      && /const imgSha = task\.image && task\.image\.sha256;/.test(mutant));
    const L = freshLib('f2');
    w(L, path.join('_录题', TID2 + '.json'), mkTask(true));
    const cf = path.join(L, 'cards.json');
    fs.writeFileSync(cf, JSON.stringify(mkCards({ taskId: 't-20261104-999999-cccccc' })), 'utf8');
    const rm = runMutant(mutant, L, TID2, cf);
    const n = cardCount(L);
    A('F2 变异体**确实放行了**错配的信封（证明 D2 那条判据抓得住）',
      rm.status === 0 && n === 1, 'exit=' + rm.status + ' cards=' + n + ' ' + String(rm.stderr || '').slice(0, 200));
  }

  /* ═════════ G · 事务（2026-11-05 合并评审 P0-3）═════════
     修前入库只拿锁、没有事务：建卡目录 → 题干 → 记录 → 索引 → 任务记录 中途抛错就留半张卡；
     --dry 照样写盘。判据：注入故障 ⇒ 库**原样**（无卡目录、索引无新条目）；--dry ⇒ 库原样。
     阴性自证：同样注入故障、但把回滚掏掉 ⇒ 必须留下残卡（证明 G2 抓得住）。 */
  console.log('\n═══ G · 事务：中途失败整体回滚；--dry 是真预演 ═══');
  const cardDirOf = L => path.join(L, '七年级-学生甲', '数学', 'M0001-煮面条工序时间');
  const taskCards = L => {
    const j = JSON.parse(fs.readFileSync(path.join(L, '_录题', TID2 + '.json'), 'utf8').replace(/^\uFEFF/, ''));
    return Array.isArray(j.cards) ? j.cards.length : -1;
  };
  {
    const L = freshLib('g1');
    w(L, path.join('_录题', TID2 + '.json'), mkTask(true));
    const cf = path.join(L, 'cards.json');
    fs.writeFileSync(cf, JSON.stringify(mkCards({ taskId: TID2 })), 'utf8');
    const r = run(['_录题入库.mjs', '入库', TID2, '--file', cf, '--student', '学生甲', '--subject', '数学', '--data', L, '--dry']);
    A('G1 --dry ⇒ exit 0 且说明已回滚', r.code === 0 && /已整体回滚/.test(r.out), 'exit=' + r.code + ' ' + r.out.slice(0, 160));
    A('G1 --dry 后索引无新卡', cardCount(L) === 0, 'cards=' + cardCount(L));
    A('G1 --dry 后卡目录不存在（新建的空目录也回滚掉）', !fs.existsSync(cardDirOf(L)));
    A('G1 --dry 后任务记录未被回写', taskCards(L) === 0, 'cards[]=' + taskCards(L));
  }
  const INJECT_AT = '    tx.writeJson(taskFile(taskId), tj, { indent: 1 });';
  A('G 注入锚点存在（写任务记录那一行）', LAND.includes(INJECT_AT));
  const inject = src => src.replace(INJECT_AT, "    throw new Error('注入故障：写任务记录前');\n" + INJECT_AT);
  {
    const L = freshLib('g2');
    w(L, path.join('_录题', TID2 + '.json'), mkTask(true));
    const cf = path.join(L, 'cards.json');
    fs.writeFileSync(cf, JSON.stringify(mkCards({ taskId: TID2 })), 'utf8');
    const rm = runMutant(absolutize(inject(LAND)), L, TID2, cf);
    A('G2 中途故障 ⇒ 非零退出', rm.status !== 0, 'exit=' + rm.status);
    A('G2 ★ 中途故障后索引无新卡（索引已写过一次，被回滚）', cardCount(L) === 0, 'cards=' + cardCount(L));
    A('G2 ★ 中途故障后卡目录不存在', !fs.existsSync(cardDirOf(L)));
  }
  {
    const ROLLBACK_AT = '      const r = tx.rollback();\n      if (r && (r.restored || r.removed)) console.error';
    A('G3 变异锚点存在（catch 里的回滚）', LAND.includes(ROLLBACK_AT));
    const L = freshLib('g3');
    w(L, path.join('_录题', TID2 + '.json'), mkTask(true));
    const cf = path.join(L, 'cards.json');
    fs.writeFileSync(cf, JSON.stringify(mkCards({ taskId: TID2 })), 'utf8');
    const mutant = absolutize(inject(LAND).replace(ROLLBACK_AT, '      const r = null;\n      if (r && (r.restored || r.removed)) console.error'));
    runMutant(mutant, L, TID2, cf);
    A('G3 阴性自证 · 掏掉回滚 ⇒ 残卡留在库里（G2 判据有牙齿）', fs.existsSync(cardDirOf(L)) && cardCount(L) === 1,
      'dir=' + fs.existsSync(cardDirOf(L)) + ' cards=' + cardCount(L));
  }
  /* G4 · 老师红笔 vs 官方答案（2026-11-05 合并评审 P1-6） */
  {
    /* ★ 2026-11-07（红字归属）：有红色批注（teacherAnswer 非空）必须声明 inkAttribution ——
       红字不一定是老师写的，归属不明就不能当权威答案。 */
    const mk = (extra) => { const o = mkCards({ taskId: TID2 }); Object.assign(o.result.cards[0], { answerSource: '官方答案', answer: '13', teacherAnswer: '12', inkAttribution: '老师', answerSourceNote: '菁优网同题页，答案 13' }, extra || {}); return o; };
    const L = freshLib('g4');
    w(L, path.join('_录题', TID2 + '.json'), mkTask(true));
    const cf = path.join(L, 'cards.json');
    fs.writeFileSync(cf, JSON.stringify(mk()), 'utf8');
    const r = run(['_录题入库.mjs', '入库', TID2, '--file', cf, '--student', '学生甲', '--subject', '数学', '--data', L]);
    A('G4 ★ 官方答案与老师红笔不一致且未交代 ⇒ 拒绝入库、零写盘', r.code !== 0 && cardCount(L) === 0 && /老师红笔/.test(r.out), 'exit=' + r.code + ' cards=' + cardCount(L));
    fs.writeFileSync(cf, JSON.stringify(mk({ notes: '与老师红笔不一致：老师写 12，菁优网写 13，独立解法得 13' })), 'utf8');
    const r2 = run(['_录题入库.mjs', '入库', TID2, '--file', cf, '--student', '学生甲', '--subject', '数学', '--data', L]);
    A('G4 对照：notes 交代了分歧 ⇒ 放行', cardCount(L) === 1, 'exit=' + r2.code + ' cards=' + cardCount(L));
    /* ★ 2026-11-05（PR #13 复审 ③）：放行 ≠ 了结 —— 老师红笔落盘、冲突挂牌（组卷准入据此拦） */
    const ix = JSON.parse(fs.readFileSync(path.join(L, '七年级-学生甲', '数学', '_索引.json'), 'utf8').replace(/^\uFEFF/, ''));
    const it = ix.items[0] || {};
    A('G4 ★ teacherAnswer 进了索引', it.teacherAnswer === '12', JSON.stringify(it.teacherAnswer));
    A('G4 ★ 冲突卡挂 teacherConflict（未裁决）', !!it.teacherConflict && it.teacherConflict.teacher === '12' && !it.teacherConflict.resolvedAt, JSON.stringify(it.teacherConflict));
    const md = fs.readFileSync(path.join(cardDirOf(L), '错题记录.md'), 'utf8');
    A('G4 ★ 错题记录.md 写了红字与"须裁决"', /红字（老师批的）：12/.test(md) && /异议裁决/.test(md), md.split('\n').filter(l => l.startsWith('> ')).join(' | '));
    A('G4 ★ 索引记了红字归属', it.inkAttribution === '老师', JSON.stringify(it.inkAttribution));
  }
  /* G9 · 红字归属（2026-11-07 用户裁定）：红字不一定是老师批的 */
  {
    /* ① 有红字却没声明归属 ⇒ 拒（省略 = 归属不明 = 红字不可作权威答案） */
    const L = freshLib('g9a');
    w(L, path.join('_录题', TID2 + '.json'), mkTask(true));
    const cf = path.join(L, 'cards.json');
    const o = mkCards({ taskId: TID2 });
    Object.assign(o.result.cards[0], { answerSource: '独立判卷', teacherAnswer: '12' });
    delete o.result.cards[0].inkAttribution;
    fs.writeFileSync(cf, JSON.stringify(o), 'utf8');
    const r = run(['_录题入库.mjs', '入库', TID2, '--file', cf, '--student', '学生甲', '--subject', '数学', '--data', L]);
    A('G9 ★ 有红色批注却没声明 inkAttribution ⇒ 拒绝、零写盘', r.code !== 0 && cardCount(L) === 0 && /inkAttribution/.test(r.out), 'exit=' + r.code + ' cards=' + cardCount(L));
    /* ② 归属是「孩子」却称「老师定案」⇒ 自相矛盾，直接拒 */
    Object.assign(o.result.cards[0], { answerSource: '老师定案', teacherAnswer: '12', inkAttribution: '孩子', notes: '' });
    fs.writeFileSync(cf, JSON.stringify(o), 'utf8');
    const r2 = run(['_录题入库.mjs', '入库', TID2, '--file', cf, '--student', '学生甲', '--subject', '数学', '--data', L]);
    A('G9 ★ 称「老师定案」但归属是「孩子」⇒ 拒、零写盘（红字不是老师写的就不许按老师定案）',
      r2.code !== 0 && cardCount(L) === 0 && /inkAttribution/.test(r2.out), 'exit=' + r2.code + ' cards=' + cardCount(L));
    /* ③ 归属取值非法 ⇒ 拒 */
    Object.assign(o.result.cards[0], { answerSource: '独立判卷', inkAttribution: '同学甲' });
    fs.writeFileSync(cf, JSON.stringify(o), 'utf8');
    const r3 = run(['_录题入库.mjs', '入库', TID2, '--file', cf, '--student', '学生甲', '--subject', '数学', '--data', L]);
    A('G9 ★ inkAttribution 取值非法 ⇒ 拒、零写盘', r3.code !== 0 && cardCount(L) === 0 && /inkAttribution/.test(r3.out), 'exit=' + r3.code);
    /* ④ 归属是「孩子」+ 来源是「独立判卷」⇒ 放行，且卡面如实写「红字（孩子写的）」 */
    /*   （答案与红字一致 ⇒ 不触发"老师红笔冲突"那道检查，隔离出归属这一项本身） */
    Object.assign(o.result.cards[0], { answerSource: '独立判卷', answer: '12', teacherAnswer: '12', inkAttribution: '孩子', notes: '' });
    fs.writeFileSync(cf, JSON.stringify(o), 'utf8');
    const r4 = run(['_录题入库.mjs', '入库', TID2, '--file', cf, '--student', '学生甲', '--subject', '数学', '--data', L]);
    const md4 = cardCount(L) === 1 ? fs.readFileSync(path.join(cardDirOf(L), '错题记录.md'), 'utf8') : '';
    A('G9 ★ 归属=孩子 + 独立判卷 ⇒ 放行，卡面不写「老师红笔」', r4.code === 0 && cardCount(L) === 1 && /红字（孩子写的）：12/.test(md4) && !/老师红笔/.test(md4),
      'exit=' + r4.code + ' cards=' + cardCount(L) + ' md=' + md4.split('\n').filter(l => l.startsWith('> ')).join(' | '));
  }
  /* G5 · 官方答案省略 teacherAnswer ⇒ 拒（修前漏填即全盲） */
  {
    const L = freshLib('g5');
    w(L, path.join('_录题', TID2 + '.json'), mkTask(true));
    const o = mkCards({ taskId: TID2 }); Object.assign(o.result.cards[0], { answerSource: '官方答案', answerSourceNote: '菁优网同题页，答案 13' }); delete o.result.cards[0].teacherAnswer;
    const cf = path.join(L, 'cards.json'); fs.writeFileSync(cf, JSON.stringify(o), 'utf8');
    const r = run(['_录题入库.mjs', '入库', TID2, '--file', cf, '--student', '学生甲', '--subject', '数学', '--data', L]);
    A('G5 ★ 官方答案却省略 teacherAnswer ⇒ 拒绝、零写盘', r.code !== 0 && cardCount(L) === 0 && /teacherAnswer/.test(r.out), 'exit=' + r.code);
    Object.assign(o.result.cards[0], { teacherAnswer: '' });
    fs.writeFileSync(cf, JSON.stringify(o), 'utf8');
    const r2 = run(['_录题入库.mjs', '入库', TID2, '--file', cf, '--student', '学生甲', '--subject', '数学', '--data', L]);
    A('G5 对照：teacherAnswer="" 明确声明老师没写 ⇒ 放行', r2.code === 0 && cardCount(L) === 1, 'exit=' + r2.code);
    /* 幂等摘要含 teacherAnswer：只改老师红笔重提，不得被当成"同一份"跳过 */
    Object.assign(o.result.cards[0], { teacherAnswer: '12', inkAttribution: '老师', notes: '与老师红笔不一致：老师写 12，站点 13' });
    fs.writeFileSync(cf, JSON.stringify(o), 'utf8');
    const r3 = run(['_录题入库.mjs', '入库', TID2, '--file', cf, '--student', '学生甲', '--subject', '数学', '--data', L]);
    A('G5 ★ 只改 teacherAnswer 重提 ⇒ 不被幂等跳过', !/幂等/.test(r3.out), r3.out.slice(0, 120));
  }
  /* G7 · 二次复审 ③：teacherAnswer 每张卡必填，不分来源；老师定案却与老师红笔不一致 ⇒ 自相矛盾直接拒 */
  {
    const L = freshLib('g7');
    w(L, path.join('_录题', TID2 + '.json'), mkTask(true));
    const cf = path.join(L, 'cards.json');
    const o = mkCards({ taskId: TID2 }); delete o.result.cards[0].teacherAnswer;
    fs.writeFileSync(cf, JSON.stringify(o), 'utf8');
    const r = run(['_录题入库.mjs', '入库', TID2, '--file', cf, '--student', '学生甲', '--subject', '数学', '--data', L]);
    A('G7 ★ 独立判卷 漏填 teacherAnswer ⇒ 拒、零写盘', r.code !== 0 && cardCount(L) === 0 && /teacherAnswer/.test(r.out), 'exit=' + r.code);
    Object.assign(o.result.cards[0], { answerSource: '老师定案', teacherAnswer: '12', inkAttribution: '老师', notes: '与老师红笔不一致：随便写一句' });
    fs.writeFileSync(cf, JSON.stringify(o), 'utf8');
    const r2 = run(['_录题入库.mjs', '入库', TID2, '--file', cf, '--student', '学生甲', '--subject', '数学', '--data', L]);
    A('G7 ★ 老师定案 却与老师红笔不一致 ⇒ 拒（notes 也救不了）', r2.code !== 0 && cardCount(L) === 0 && /自相矛盾/.test(r2.out), 'exit=' + r2.code);
    Object.assign(o.result.cards[0], { answerSource: '老师定案', teacherAnswer: '  ', notes: '' });
    fs.writeFileSync(cf, JSON.stringify(o), 'utf8');
    const r2b = run(['_录题入库.mjs', '入库', TID2, '--file', cf, '--student', '学生甲', '--subject', '数学', '--data', L]);
    A('G7 ★ 老师定案 却 teacherAnswer 为空/空白 ⇒ 拒（修前绕过两道检查直进组卷池）', r2b.code !== 0 && cardCount(L) === 0 && /teacherAnswer 为空/.test(r2b.out), 'exit=' + r2b.code);
    Object.assign(o.result.cards[0], { answerSource: '独立判卷', teacherAnswer: '12', inkAttribution: '老师', notes: '与老师红笔不一致：老师 12，独立解 13' });
    fs.writeFileSync(cf, JSON.stringify(o), 'utf8');
    const r3 = run(['_录题入库.mjs', '入库', TID2, '--file', cf, '--student', '学生甲', '--subject', '数学', '--data', L]);
    const ix = cardCount(L) ? JSON.parse(fs.readFileSync(path.join(L, '七年级-学生甲', '数学', '_索引.json'), 'utf8').replace(/^\uFEFF/, '')).items[0] : {};
    A('G7 ★ 独立判卷 与老师不一致（已交代）⇒ 入库但挂 teacherConflict', r3.code === 0 && !!(ix.teacherConflict && ix.teacherConflict.teacher === '12'), 'exit=' + r3.code);
  }
  /* G10 · 先搜公开题库（2026-11-07 用户裁定）：录题第一步先上网与成熟错题库比对，
     实在找不到再自己一点一点录。规则以前只写在提示词与人工 checklist 里，程序一处不查
     ⇒ "假装查过"（没检索却写官方答案）没有任何拦截。现在补上机械判据。 */
  {
    /* ① answerSource=官方答案 却没指出处 ⇒ 拒（来源造假里最常见的一种） */
    const L = freshLib('g10a');
    w(L, path.join('_录题', TID2 + '.json'), mkTask(true));
    const cf = path.join(L, 'cards.json');
    const o = mkCards({ taskId: TID2 });
    Object.assign(o.result.cards[0], { answerSource: '官方答案', answer: '13', teacherAnswer: '', answerSourceNote: '算了一遍就是 13' });
    fs.writeFileSync(cf, JSON.stringify(o), 'utf8');
    const r = run(['_录题入库.mjs', '入库', TID2, '--file', cf, '--student', '学生甲', '--subject', '数学', '--data', L]);
    A('G10 ★ 官方答案却没指出处 ⇒ 拒绝、零写盘（不许假装查过）', r.code !== 0 && cardCount(L) === 0 && /出处/.test(r.out), 'exit=' + r.code + ' cards=' + cardCount(L));
    /* ② 指出了处（站点名）⇒ 放行 */
    Object.assign(o.result.cards[0], { answerSourceNote: '菁优网同题页，答案 x=2，与卷面一致' });
    fs.writeFileSync(cf, JSON.stringify(o), 'utf8');
    const r2 = run(['_录题入库.mjs', '入库', TID2, '--file', cf, '--student', '学生甲', '--subject', '数学', '--data', L]);
    A('G10 ★ 官方答案 + 站点名 ⇒ 放行', r2.code === 0 && cardCount(L) === 1, 'exit=' + r2.code + ' cards=' + cardCount(L));
    /* ③ 指出了处（答案页页码）⇒ 放行 */
    const L3 = freshLib('g10c');
    w(L3, path.join('_录题', TID2 + '.json'), mkTask(true));
    const cf3 = path.join(L3, 'cards.json');
    const o3 = mkCards({ taskId: TID2 });
    Object.assign(o3.result.cards[0], { answerSource: '官方答案', answer: '13', teacherAnswer: '', answerSourceNote: '答案.pdf 第2页第6题' });
    fs.writeFileSync(cf3, JSON.stringify(o3), 'utf8');
    const r3 = run(['_录题入库.mjs', '入库', TID2, '--file', cf3, '--student', '学生甲', '--subject', '数学', '--data', L3]);
    A('G10 ★ 官方答案 + 答案页页码 ⇒ 放行', r3.code === 0 && cardCount(L3) === 1, 'exit=' + r3.code + ' cards=' + cardCount(L3));
    /* ④ 「独立判卷」不受此判据影响（自己算的也要写关键步骤，但不强制站点名） */
    const L4 = freshLib('g10d');
    w(L4, path.join('_录题', TID2 + '.json'), mkTask(true));
    const cf4 = path.join(L4, 'cards.json');
    const o4 = mkCards({ taskId: TID2 });
    Object.assign(o4.result.cards[0], { answerSource: '独立判卷', answer: '13', teacherAnswer: '' });
    fs.writeFileSync(cf4, JSON.stringify(o4), 'utf8');
    const r4 = run(['_录题入库.mjs', '入库', TID2, '--file', cf4, '--student', '学生甲', '--subject', '数学', '--data', L4]);
    A('G10 对照：独立判卷 不受出处判据影响 ⇒ 放行', r4.code === 0 && cardCount(L4) === 1, 'exit=' + r4.code + ' cards=' + cardCount(L4));
  }
  /* G8 · --in 老别名在严格模式下仍可用（二次复审：误杀） */
  {
    const L = freshLib('g8');
    w(L, path.join('_录题', TID2 + '.json'), mkTask(true));
    const cf = path.join(L, 'cards.json'); fs.writeFileSync(cf, JSON.stringify(mkCards({ taskId: TID2 })), 'utf8');
    const r = run(['_录题入库.mjs', '入库', TID2, '--in', cf, '--student', '学生甲', '--subject', '数学', '--data', L]);
    A('G8 ★ --in <文件>（--file 老别名）⇒ 正常入库', r.code === 0 && cardCount(L) === 1, 'exit=' + r.code + ' ' + r.out.slice(0, 80));
  }
  /* G6 · 严格模式：写盘工具拼错开关当场拒（PR #13 复审 ①：修前 --dryy 被静默丢弃 ⇒ 真入库） */
  {
    const L = freshLib('g6');
    w(L, path.join('_录题', TID2 + '.json'), mkTask(true));
    const cf = path.join(L, 'cards.json'); fs.writeFileSync(cf, JSON.stringify(mkCards({ taskId: TID2 })), 'utf8');
    const r = run(['_录题入库.mjs', '入库', TID2, '--file', cf, '--student', '学生甲', '--subject', '数学', '--data', L, '--dryy']);
    A('G6 ★ 入库 --dryy ⇒ 报"未知参数"且零写盘', r.code !== 0 && /未知参数 --dryy/.test(r.out) && cardCount(L) === 0 && !fs.existsSync(cardDirOf(L)), 'exit=' + r.code + ' cards=' + cardCount(L));
    const r2 = run(['_录题入库.mjs', '入库', TID2, '--file', cf, '--student', '学生甲', '--subject', '数学', '--data', L, '--dry=maybe']);
    A('G6 ★ --dry=maybe（开关带非布尔值）⇒ 拒且零写盘', r2.code !== 0 && cardCount(L) === 0, 'exit=' + r2.code);
    const r3 = run(['_录题入库.mjs', '入库', TID2, '--file', cf, '--student', '学生甲', '--subject', '数学', '--data', L, '--dry=true']);
    A('G6 --dry=true ⇒ 预演（零写盘）', r3.code === 0 && /已整体回滚/.test(r3.out) && cardCount(L) === 0, 'exit=' + r3.code);
  }

  console.log('\nRESULT=' + (fails ? 'FAIL(' + fails + ')' : 'PASS') + ' 断言=' + total);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('用例自身崩了：', e); process.exit(2); });
