#!/usr/bin/env node
/**
 * 批次 1 收尾「页面接线」（2026-11-03）· 录题任务从页面到工具的整条链
 *
 * 为什么必须有它：批次 1 交付了 CLI 与信封（_录题任务.mjs + 组装 --task），但"页面把参数
 * 送进引擎"要走 桌面壳 → C# → node 这条链，任何一环少接线，页面上就静默退回
 * "仅格式校验"——A 贴进 B 的防线在界面上失效，而 CLI 测试全绿（防线烂在最后一厘米，
 * 同 L-441/L-716"声明与消费者必须机读对齐"家族）。
 *
 * 本用例六段：
 *   A 源码级·壳：taskCheck / taskConfirm 两个 op 已注册；taskId 有形状门禁；固定映射不透传；
 *     绑定校验不进写闸（只读）、确认进写闸（写用户库）；两把都显式 --data、回真实退出码。
 *   B 源码级+**行为级**·前端：host.js 暴露 H.taskCheck/H.taskConfirm 且走 bridge；ingest.js
 *     ①勾了照片才发 task=1 ②从 stderr 解析任务号 ③有任务号走三层校验、没有走格式校验并显式标
 *     "仅格式校验（未与任务关联）" ④确认入口只能由人点。
 *     ★ 2026-11-03 修（T-2）：这四条原来只匹配**字面量与注释文本**——把 `if (picked.length)`
 *       改成 `if (true)`、把确认逻辑塞进 onCheck、把三层校验整段删掉，旧断言**照样绿**
 *       （守的是"源码里还留着那行字"，不是"页面真的这么干"）。现在真的把 ingest.js 里四个
 *       函数**切出来驱动**（`new Function` + 桩），断言它们**实际送出的参数**与**实际绑定的回调**。
 *   B3 源码级+行为级·P1-#1：ingest.js **不再自己写一份容错解析** —— 它只把用户粘的原文原样
 *     交给工具（`H.taskCheck` / `H.recipe('校验')` 收到的 text 与粘贴内容逐字相同）；花括号截取
 *     的**唯一实现**在 `src\tools\_配方.mjs` 的 `extractJsonText`（页面侧判据附"塞回旧代码必判有"的自证）。
 *   C 行为级·--data：`_录题任务.mjs 列/绑定校验 --data <临时库>` 真跑（壳就是走这个参数传库根）。
 *   D 行为级·合成 A/B：临时库上 A、B 两个任务，A 的结果贴给 B 必须 exit 3 且点名原因；
 *     换当前配方不影响旧任务校验（建议书 §7 批次 1 完成判据的 CLI 侧证据）。
 *   E 行为级·D-4 阴性对照：**没有原图 sha** 的任务 + 任意信封 ⇒ 第二层必须报「未覆盖」
 *     且 exit 3，**绝不**出现"② 与任务及原图匹配：通过"（旧实现整段跳过却打印"通过"）。
 *
 * 端到端（真 exe + 真 CDP 驱动页面）在 tests\neg-v2-ingest-task-e2e.cjs —— 两层各管一段。
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
const A = (n, ok, d) => { total++; console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d !== undefined ? '  → ' + String(d).slice(0, 200) : ''}`); if (!ok) fails++; };

const ROOT = path.resolve(__dirname, '..');
const CS = fs.readFileSync(path.join(ROOT, 'src', 'shell', 'CTBShellV2.cs'), 'utf8');
const HOST = fs.readFileSync(path.join(ROOT, 'src', 'app', 'js', 'host.js'), 'utf8');
const INGEST = fs.readFileSync(path.join(ROOT, 'src', 'app', 'js', 'views', 'ingest.js'), 'utf8');
const SHA_TXT = '数学';

/* ═════════ A · 壳侧（源码级） ═════════ */
console.log('═══ A · 壳：两个新 op 已注册、形状门禁、写读分界 ═══');
A('op 分发里有 taskCheck 与 taskConfirm',
  /op\s*==\s*"taskCheck"/.test(CS) && /op\s*==\s*"taskConfirm"/.test(CS));
A('两把 op 都调 HostBridge 的实现', /bridge\.TaskCheck\(payload\)/.test(CS) && /bridge\.TaskConfirm\(payload\)/.test(CS));
A('taskId 形状门禁在场（t-8位-6位-6位hex）', /t-\[0-9\]\{8\}-\[0-9\]\{6\}-\[0-9a-f\]\{6\}/.test(CS));
A('TaskCheck 用 _录题任务.mjs 的 绑定校验', /ToolPath\("_录题任务\.mjs"\), "绑定校验"/.test(CS));
A('TaskConfirm 用 _录题任务.mjs 的 确认', /ToolPath\("_录题任务\.mjs"\), "确认"/.test(CS));
A('两把都显式 --data 注入库根（不靠环境变量继承）',
  (CS.match(/args\.Add\("--data"\);\s*args\.Add\(DataRoot\)/g) || []).length >= 3,
  'Recipe/TaskCheck/TaskConfirm 三处');
A('TaskConfirm 进写闸（确认写用户库）',
  /public string TaskConfirm[\s\S]{0,400}?WriteGate\.Wait\(1200000\)/.test(CS));
A('TaskCheck 不进写闸（绑定校验只读；TaskCheck 与 TaskConfirm 之间无 WriteGate）',
  !/public string TaskCheck[\s\S]{0,900}?WriteGate/.test(CS.replace(/public string TaskConfirm[\s\S]*$/, '')));
A('note 只走 AddFlag 固定映射（不接受任意拼接）', /AddFlag\(args, payload, "note", "--note"\)/.test(CS));
A('回真实退出码（与 Recipe 同口径，不硬编码 ok/code）',
  /"\{\\"ok\\":true,\\"code\\":"\s*\+\s*exit/.test(CS.replace(/public string TaskConfirm[\s\S]*$/, '')));
/* 透传红线：Recipe() 的布尔映射只有 json/task 两个固定键，其余键必须被丢弃。
   ★ 2026-11-03 修（T-1）：原断言是 `.every((m, i, arr) => true)` —— **恒真死断言**：
   解析出来的键一个也不看，往里塞第三把布尔它照样绿（diff-reviewer 变异体实测）。
   恒真断言比没有断言更坏（它占着"有防线"的位置）。现在做**集合相等**（不多不少正好 {json,task}），
   并附一条每次跑都执行的**判据自证**：给判据喂"塞了第三把"的变异体，它必须判不等。 */
const recipeBody = (/public string Recipe\(string payload\)[\s\S]*?\n        \}/.exec(CS) || [''])[0];
const boolKeysOf = (text) => [...new Set((String(text).match(/ExtractString\(payload, "(\w+)"\) == "1"/g) || [])
  .map(s => (/"(\w+)"/.exec(s) || [])[1]))].sort();
const sameKeySet = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const WANT_BOOL_KEYS = ['json', 'task'];
const recipeBoolKeys = boolKeysOf(recipeBody);
A('Recipe 的布尔透传是**集合相等**的 {json,task}（多一把第三键就红；不再是恒真）',
  sameKeySet(recipeBoolKeys, WANT_BOOL_KEYS), '实际=' + JSON.stringify(recipeBoolKeys));
const mutantBoolKeys = boolKeysOf(recipeBody + '\n                if (ExtractString(payload, "xxx") == "1") args.Add("--xxx");');
A('T-1 判据自证：对"塞入第三把布尔"的变异体必须判不等（否则判据自己也是死的）',
  !sameKeySet(mutantBoolKeys, WANT_BOOL_KEYS) && mutantBoolKeys.length === WANT_BOOL_KEYS.length + 1,
  '变异体键=' + JSON.stringify(mutantBoolKeys));

/* ═════════ B · 前端（源码级） ═════════ */
console.log('\n═══ B · 前端：host 通道 + 页面四条纪律 ═══');
A('host.js 暴露 H.taskCheck', /H\.taskCheck\s*=\s*async function/.test(HOST));
A("host.js taskCheck 走 bridge('taskCheck')", /bridge\('taskCheck'/.test(HOST));
A('host.js 暴露 H.taskConfirm', /H\.taskConfirm\s*=\s*async function/.test(HOST));
A("host.js taskConfirm 走 bridge('taskConfirm')", /bridge\('taskConfirm'/.test(HOST));
/* 下面四条原来只匹配字面量/注释（T-2）；保留它们作为**机制钉**（把机制本身钉死），
   真正的判据在 B2 的行为级驱动里。 */
A('ingest.js 源码里 flags.task 只在"勾了图"分支出现（机制钉）', /flags\.task = '1'/.test(INGEST));
A('ingest.js：从 stderr 解析任务号（t-形状）', /任务记录：\(t-\[0-9\]\{8\}-\[0-9\]\{6\}-\[0-9a-f\]\{6\}\)/.test(INGEST));
A('ingest.js：有任务句柄走绑定校验（H.taskCheck）', /H\.taskCheck\(st\.taskId/.test(INGEST));
A('ingest.js：无任务句柄走格式校验并显式标"仅格式校验（未与任务关联）"',
  /仅格式校验（未与任务关联）/.test(INGEST));
A('ingest.js：确认入口调用 H.taskConfirm（人显式点）', /H\.taskConfirm\(st\.taskId/.test(INGEST));
A('ingest.js：错配渲染"不要入库"（exit 3 的 UI 语义）', /与任务不匹配/.test(INGEST) && /不要入库/.test(INGEST));

/* ★ 2026-11-03（批次 1 收尾 · P1-#1）：页面**不再自己写一份容错解析**。
   施工方案 §2.1 点名为 P1-5 类缺陷、§6 批次 1 交付物 4 明确"禁止页面侧再写一份容错解析"。
   判据两半：① 源码里不再有花括号截取；② "没找到花括号"这类判词改成读工具原文（页面不再自己猜）。
   判据自证（T-1 同族）：把那一行原样塞回源码文本，判据必须判有 —— 否则它是恒假断言。 */
/* 判据锚在**真正的截取表达式**上（`raw.indexOf(…)` = 对用户粘的那段文本扫花括号），
   不是"源码里出现过 indexOf 这几个字"——否则注释里提一句就会假红（本轮实测踩过：
   新注释里写了 `indexOf('{')` 作反例，宽松判据当场判有）。 */
const hasOwnBraceSlice = (src) => /\braw\.(indexOf|lastIndexOf)\(/.test(src);
A('ingest.js 里不再有自己的花括号截取（容错解析唯一实现在 src\\tools\\_配方.mjs 的 extractJsonText）',
  !hasOwnBraceSlice(INGEST));
A('P1-#1 判据自证：把旧那一行塞回源码 ⇒ 判据必须判有（否则它也是死的）',
  hasOwnBraceSlice(INGEST.replace('const text = raw;',
    "const a = raw.indexOf('{'), b = raw.lastIndexOf('}'); const text = raw.slice(a, b + 1);")));
A('ingest.js 把原文原样交出去（`const text = raw;`，不再有中间的截取变量）',
  /const text = raw;/.test(INGEST) && !/const text = \(a >= 0/.test(INGEST));
A('ingest.js 不再自己猜"没找到花括号"（这类判词改读工具原文）', !/没找到 JSON 花括号/.test(INGEST));

/* ═════════ B2 · 行为级：真的驱动一次页面逻辑（T-2 的正面判据） ═════════
   切片：把 ingest.js 里四个函数**按函数声明锚点**切出来（不用脆弱的注释锚点），
   用 new Function 注入桩真跑。切片失败（锚点被改名/结构被重排）⇒ 显式判红，不静默跳过。 */
const sliceFn = (from, to) => {
  const a = INGEST.indexOf(from);
  if (a < 0) throw new Error('ingest.js 里找不到起始锚点：' + from);
  const b = to ? INGEST.indexOf(to, a + from.length) : INGEST.length;
  if (to && b < 0) throw new Error('ingest.js 里找不到结束锚点：' + to);
  return INGEST.slice(a, b);
};
let PAGE = null, PAGE_ERR = '', SRC_CONFIRM = '';
try {
  SRC_CONFIRM = sliceFn('async function onConfirm(cf)', 'async function onCheck()');
  const src = sliceFn('async function onGenerate()', 'async function onBoundCheck(')
    + sliceFn('async function onBoundCheck(', 'async function onConfirm(cf)')
    + SRC_CONFIRM
    + sliceFn('async function onCheck()', 'V.onShow = function');
  PAGE = (U, H, S, st, inboxFiles, copyText, revealShot) => new Function(
    'U', 'H', 'S', 'st', 'inboxFiles', 'copyText', 'revealShot',
    src + '\nreturn { onGenerate, onBoundCheck, onConfirm, onCheck };')(U, H, S, st, inboxFiles, copyText, revealShot);
} catch (e) { PAGE_ERR = String((e && e.message) || e); }
A('B0 页面四个函数能从 ingest.js 切出来并驱动（切不出来即红，绝不静默跳过）', !!PAGE, PAGE_ERR);

/* 页面驱动器：桩按"壳+工具的真实行为"分叉 —— 只有带 task=1 才会落任务记录、才会在 stderr 给任务号。
   这样"没勾图不留记录"这条就有可判据的中间量（st.taskId / 真库记录数）。 */
const TID_FAKE = 't-20261103-101010-abcdef';
const mkPage = (over) => {
  const o = over || {};
  const els = {};
  const mkEl = () => ({ innerHTML: '', disabled: false, textContent: '', value: '', onclick: null });
  const calls = { recipe: [], taskCheck: [], taskConfirm: [], toast: [] };
  const st = Object.assign({
    recipe: 'ingest-page', subject: SHA_TXT, batch: '', picked: {}, task: '',
    verdict: null, inbox: null, shot: null, taskId: null,
  }, o.st || {});
  const U = { $id: (id) => (els[id] || (els[id] = mkEl())), esc: (s) => String(s) };
  const H = {
    recipe: async (action, flags) => {
      calls.recipe.push({ action, flags: JSON.parse(JSON.stringify(flags || {})) });
      const withTask = flags && flags.task === '1';
      return { ok: true, code: 0, out: 'TASK-SHEET\n', err: withTask ? 'x 任务记录：' + TID_FAKE + '（<库根>\\_录题\\' + TID_FAKE + '.json）\n' : '' };
    },
    taskCheck: async (id, text) => {
      calls.taskCheck.push({ id, text });
      return o.taskCheckReply || { ok: true, code: 0, out: '绑定校验 · 任务 x\n  ③ 内容已人工确认：**未确认**（人看过之后再跑 `确认 x`）\n', err: '' };
    },
    taskConfirm: async (id) => { calls.taskConfirm.push(id); return { ok: true, code: 0, out: '', err: '' }; },
  };
  const S = { toast: (m) => calls.toast.push(String(m)) };
  const fns = PAGE(U, H, S, st, o.inboxFiles || (() => []), async () => true, () => { });
  return { st, calls, els, fns, $id: U.$id };
};

(async () => {
  const LIB = E.allocTempDir('gn-task-wiring-');
  const run = (args) => {
    /* spawnSync 而不是 execFileSync：任务号在 **stderr**（stdout 只放产物）——
       execFileSync 拿不到 stderr，任务号就丢了（本用例首轮实测踩过）。 */
    const r = spawnSync(process.execPath, [E.tool(args[0]), ...args.slice(1)], {
      encoding: 'utf8', maxBuffer: 64e6,
      env: Object.assign({}, process.env, { CTB_DATA: path.join(os.tmpdir(), '__不存在__' + Date.now()) }),
    });
    return { code: r.status == null ? -1 : r.status, out: String(r.stdout || '') + String(r.stderr || '') };
  };
  /* 注意：env 故意给一个**不存在**的库根 —— --data 必须赢过 CTB_DATA，这条才算数 */
  const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
  const w = (root, rel, buf) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); return p; };
  const JPG = Buffer.from([0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x11, 0x08, 0x05, 0x78, 0x03, 0xE8, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xFF, 0xD9, 0x07]);
  w(LIB, path.join('_收件箱', 'w', 'p001.jpg'), JPG);
  const RECDIR = '_录题';
  const recNames = (root) => { const d = path.join(root, RECDIR); return fs.existsSync(d) ? fs.readdirSync(d).filter(f => /^t-.*\.json$/.test(f)) : []; };

  console.log('\n═══ B2 · 行为级：驱动 onGenerate / onCheck / onBoundCheck（不是匹配字面量）═══');
  /* B2a 没勾图 ⇒ 不发 task / image，也没有任务句柄（缺陷复现：把 `if (picked.length)` 改成
     `if (true)` ⇒ flags 里出现 task=1 ⇒ 本断言变红；B2c 的记录数也会跟着变红） */
  const p0 = mkPage();
  await p0.fns.onGenerate();
  const f0 = (p0.calls.recipe[0] || {}).flags || {};
  A('B2a 行为级·没勾图：H.recipe 实际收到的 flags 里**没有** task / image',
    p0.calls.recipe.length === 1 && !('task' in f0) && !('image' in f0), 'flags=' + JSON.stringify(f0));
  A('B2a 行为级·没勾图：st.taskId 保持 null（没有句柄 ⇒ 校验只能落回"仅格式校验"）',
    p0.st.taskId === null, 'st.taskId=' + String(p0.st.taskId));

  /* B2b 勾了图 ⇒ 发 task=1 + image，任务号来自 stderr 解析
     （缺陷复现：把 stderr 解析删掉/改成读 stdout ⇒ st.taskId 为 null ⇒ 本断言变红） */
  const p1 = mkPage({
    st: { picked: { '_收件箱/w/p001.jpg': true } },
    inboxFiles: () => ([{ rel: '_收件箱/w/p001.jpg', sha256: 'a'.repeat(64), name: 'p001.jpg' }]),
  });
  await p1.fns.onGenerate();
  const f1 = (p1.calls.recipe[0] || {}).flags || {};
  A('B2b 行为级·勾了图：flags.task=1 且带 image（页面送出的正是壳要透传的那把）',
    f1.task === '1' && f1.image === '_收件箱/w/p001.jpg', 'flags=' + JSON.stringify(f1));
  A('B2b 行为级·任务号确实从 stderr 解析出来（stdout 是任务单正文，里面没有任务号）',
    p1.st.taskId === TID_FAKE, 'st.taskId=' + String(p1.st.taskId));

  /* B2c "没勾图不留记录"的**整条行为链**：把页面真送出的 flags 原样重放给真工具
     （缺陷复现：页面若在没勾图时也发 task=1 ⇒ 这条重放会真的落一条记录 ⇒ 记录数变红） */
  const LIB2 = E.allocTempDir('gn-task-wiring-b-');
  w(LIB2, path.join('_收件箱', 'w', 'p001.jpg'), JPG);
  const before2 = recNames(LIB2);
  const replay = ['_配方.mjs', '组装', '--recipe', String(f0.recipe || 'ingest-page'), '--subject', String(f0.subject || SHA_TXT),
    '--out', path.join(LIB2, 'nophoto.md'), '--data', LIB2];
  if (f0.task === '1') replay.push('--task');
  const rReplay = run(replay);
  const after2 = recNames(LIB2);
  A('B2c 行为级链：按页面真送出的 flags 重放 ⇒ 真工具**不落**任何任务记录（"没勾图不留记录"）',
    rReplay.code === 0 && after2.length === before2.length, 'exit=' + rReplay.code + ' 新增记录=' + (after2.length - before2.length));

  /* B2d 有任务句柄走三层绑定校验；没有 ⇒ 走格式校验并在屏幕上显式标"仅格式校验（未与任务关联）"
     （缺陷复现：把 `if (st.taskId)` 改成恒假 ⇒ 有句柄时不再调 H.taskCheck ⇒ 第一条变红；
       把那段提示文案去掉 ⇒ 第二条变红） */
  const p2 = mkPage({ st: { taskId: TID_FAKE } });
  p2.$id('igIn').value = '{ "cards": [] }';
  await p2.fns.onCheck();
  A('B2d 行为级·有任务句柄：onCheck 调 H.taskCheck（三层）且**不走**仅格式校验',
    p2.calls.taskCheck.length === 1 && p2.calls.taskCheck[0].id === TID_FAKE && p2.calls.recipe.length === 0,
    'taskCheck=' + p2.calls.taskCheck.length + ' recipe=' + p2.calls.recipe.length);
  const p3 = mkPage();
  p3.$id('igIn').value = '{ "cards": [] }';
  await p3.fns.onCheck();
  A('B2d 行为级·没有任务句柄：走格式校验，且**上屏**写着"仅格式校验（未与任务关联）"',
    p3.calls.recipe.length === 1 && p3.calls.recipe[0].action === '校验' && /仅格式校验（未与任务关联）/.test(p3.$id('igResult').innerHTML),
    'recipe=' + JSON.stringify(p3.calls.recipe.map(c => c.action)));

  /* B2e 确认只能由人点（T-2 的核心）：走**完整条"粘 JSON → 校验"路径**都不会自动确认；
     点了按钮才会调 H.taskConfirm
     （缺陷复现①：把确认逻辑塞进 onCheck/onBoundCheck 自动跑 ⇒ 第一条变红；
       缺陷复现②：把 `cf.onclick = () => onConfirm(cf)` 去掉 ⇒ 第三条变红（点不动）；
       缺陷复现③：新增第二条确认路径 ⇒ 第四条（结构级计数）变红） */
  const p4 = mkPage({ st: { taskId: TID_FAKE } });
  p4.$id('igIn').value = '{ "cards": [] }';
  await p4.fns.onCheck();   /* 页面「校验」按钮绑的就是它 */
  A('B2e 行为级·走完整条校验路径**不会**自动确认（taskCheck 调了 1 次，taskConfirm 调了 0 次）',
    p4.calls.taskCheck.length === 1 && p4.calls.taskConfirm.length === 0,
    'taskCheck=' + p4.calls.taskCheck.length + ' taskConfirm=' + p4.calls.taskConfirm.length);
  A('B2e 行为级·确认入口就是页面上那个按钮（#igConfirm 的 onclick 已绑定）',
    !!p4.els.igConfirm && typeof p4.els.igConfirm.onclick === 'function');
  if (p4.els.igConfirm && typeof p4.els.igConfirm.onclick === 'function') await p4.els.igConfirm.onclick();  // 模拟"人点了一下"
  A('B2e 行为级·**点了**按钮才调 H.taskConfirm，且带的是本任务号',
    p4.calls.taskConfirm.length === 1 && p4.calls.taskConfirm[0] === TID_FAKE,
    'taskConfirm=' + JSON.stringify(p4.calls.taskConfirm));
  A('B2e 结构级·ingest.js 里只有一处 H.taskConfirm 调用，且落在 onConfirm 里（没有第二条确认路径）',
    (INGEST.match(/H\.taskConfirm\(/g) || []).length === 1 && SRC_CONFIRM.indexOf('H.taskConfirm(') >= 0);

  /* ═════════ C · 行为级：--data 真跑（壳传库根的通路） ═════════ */
  console.log('\n═══ C · _录题任务.mjs --data 真跑 ═══');
  const rList = run(['_录题任务.mjs', '列', '--data', LIB]);
  A('列 --data <临时库> → exit 0（--data 赢过环境变量）', rList.code === 0, 'exit=' + rList.code + ' ' + rList.out.slice(0, 80));

  const rGen = run(['_配方.mjs', '组装', '--recipe', 'ingest-page', '--subject', SHA_TXT, '--task',
    '--image', '_收件箱/w/p001.jpg', '--out', path.join(LIB, 'task.md'), '--data', LIB]);
  A('组装 --task --data → exit 0 且 stderr 有任务号', rGen.code === 0 && /任务记录：t-/.test(rGen.out), 'exit=' + rGen.code);
  const tid = (/任务记录：(t-[0-9]{8}-[0-9]{6}-[0-9a-f]{6})/.exec(rGen.out) || [])[1];
  A('任务号形状符合壳侧门禁', !!tid && /^t-[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$/.test(tid), tid);

  /* ═════════ D · 行为级：A/B 错配 + "切配方不改旧任务校验" ═════════ */
  console.log('\n═══ D · A/B 错配与配方切换（CLI 侧证据）═══');
  const JPG_B = Buffer.from([0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x11, 0x08, 0x05, 0x78, 0x03, 0xE8, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xFF, 0xD9, 0x08]);
  w(LIB, path.join('_收件箱', 'w', 'p002.jpg'), JPG_B);
  const SHA = sha256(JPG), SHA_B = sha256(JPG_B);
  const rGenB = run(['_配方.mjs', '组装', '--recipe', 'ingest-page', '--subject', SHA_TXT, '--task',
    '--image', '_收件箱/w/p002.jpg', '--out', path.join(LIB, 'taskB.md'), '--data', LIB]);
  const tidB = (/任务记录：(t-[0-9]{8}-[0-9]{6}-[0-9a-f]{6})/.exec(rGenB.out) || [])[1];
  A('B 任务生成成功且与 A 不同号', rGenB.code === 0 && !!tidB && tidB !== tid);

  const card = (sha) => ({
    subject: SHA_TXT, title: '合成题', questionText: '1+1=?', studentAnswer: '3',
    answerSource: '独立判卷', causeCode: 'K1', confidence: 'high', sourceImageSha256: sha, teacherAnswer: '',
  });
  const envelope = (taskId, imgSha) => ({
    envelope: { schema: 'glimmernote.ingest-result/v1', taskId, imageSha256: imgSha },
    result: { pageSummary: { totalQuestions: 3, markedWrong: 1 }, cards: [card(imgSha)], skipped: [{ what: '第2题', reason: '未作答' }] },
  });
  const okFile = path.join(LIB, 'r-ok.json'), crossFile = path.join(LIB, 'r-cross.json');
  fs.writeFileSync(okFile, JSON.stringify(envelope(tid, SHA)), 'utf8');
  fs.writeFileSync(crossFile, JSON.stringify(envelope(tid, SHA)), 'utf8');   // A 的结果，贴给 B

  const bind = (id, file) => run(['_录题任务.mjs', '绑定校验', id, '--in', file, '--data', LIB]);
  const okRun = bind(tid, okFile);
  A('A 的结果贴回 A ⇒ exit 0（第三层未完成的提示在场）',
    okRun.code === 0 && /第三层未完成/.test(okRun.out), 'exit=' + okRun.code);
  const crossRun = bind(tidB, crossFile);
  A('A 的结果贴给 B ⇒ exit 3 且点名"信封 taskId"（错配必须被发现）',
    crossRun.code === 3 && /信封 taskId/.test(crossRun.out), 'exit=' + crossRun.code);
  /* "切换当前配方不会改变旧任务校验"（建议书 §7 批次 1 判据）：绑定校验的格式层用的是
     **任务记录**里的配方（rec.recipe.id），与"当前选了什么配方"无关 —— 精确断言这一行：
     绑定校验调 _配方.mjs 校验 时 --recipe 取自 rec.recipe，argv 里没有外部配方入口。 */
  A('绑定校验的配方取自任务记录（rec.recipe.id），不接受外部配方参数',
    /'校验', '--recipe', \(rec\.recipe && rec\.recipe\.id\)/.test(
      fs.readFileSync(path.join(ROOT, 'src', 'tools', '_录题任务.mjs'), 'utf8')));

  /* ═════════ B3 · 行为级：页面把用户粘的**原文**原样交出去（P1-#1） ═════════
     缺陷复现：旧 onCheck 自己截"首个 { 到最后一个 }"再交出去 ⇒ 下面 B3a/B3b 收到的 text
     会是被截过的短串（不含"好的""希望有帮助"）⇒ 两条直接红。
     这一条守的是"页面不再自己写一份容错解析"，容错本身由工具侧的 extractJsonText 负责。 */
  console.log('\n═══ B3 · 行为级：onCheck 交出去的是原文（页面不自己截 JSON）═══');
  const RAW_PROSE = '好的，以下是识别结果：\n{ "cards": [] }\n希望有帮助！';
  const p5 = mkPage({ st: { taskId: TID_FAKE } });
  p5.$id('igIn').value = RAW_PROSE;
  await p5.fns.onCheck();
  A('B3a 行为级·有任务句柄：H.taskCheck 收到的是**原文**（花括号外的说明文字也在）',
    p5.calls.taskCheck.length === 1 && p5.calls.taskCheck[0].text === RAW_PROSE,
    JSON.stringify((p5.calls.taskCheck[0] || {}).text));
  const p6 = mkPage();
  p6.$id('igIn').value = RAW_PROSE;
  await p6.fns.onCheck();
  A('B3b 行为级·无任务句柄：H.recipe(校验) 的 text 同样是原文（两条路的页面口径一致）',
    p6.calls.recipe.length === 1 && p6.calls.recipe[0].action === '校验' && p6.calls.recipe[0].flags.text === RAW_PROSE,
    JSON.stringify((p6.calls.recipe[0] || {}).flags));

  /* B3c 整条行为链：页面交出的**原文** + 真工具的容错抽取 ⇒ exit 0。
     缺陷复现：页面若仍自己截取，这段原文到了工具手里就是被截过的串（这条仍会绿）；
     所以 B3c 单独不够，它和 B3a/B3b、以及工具侧的 neg-task-binding 6b/6h 合起来才闭环：
     页面给原文（B3a/b）+ 工具能剥说明文字（6b）+ 旧两份口径确实不同（6h）。 */
  const prosePure = '好的，以下是识别结果：\n' + JSON.stringify(envelope(tid, SHA)) + '\n希望有帮助！';
  const proseFile2 = w(LIB, 'r-prose-wiring.json', Buffer.from(prosePure, 'utf8'));
  const rProse2 = bind(tid, proseFile2);
  A('B3c 行为级链：页面原文口径 + 真工具容错抽取 ⇒ exit 0（同一次粘贴在页面与 CLI 同一个结论）',
    rProse2.code === 0 && /抽取/.test(rProse2.out), 'exit=' + rProse2.code + ' ｜ ' + rProse2.out.split('\n')[0].slice(0, 80));

  /* ═════════ E · D-4 阴性对照：记录没有原图 sha ⇒ 第二层"未覆盖"，绝不"通过" ═════════
     缺陷复现路径（改前实测）：`组装 --task` 不带 `--image` ⇒ 记录 image.sha256=null；
     再用 imageSha256=64×0 的信封 + 卡 64×f 做绑定校验 ⇒ 旧代码整段跳过第二层，
     却打印「② 与任务及原图匹配：通过」并 exit 0（页面还会把它渲染成"✔ 绑定校验通过"）。
     把 wantSha 判据改回 `if (wantSha && …)`（即恢复缺陷）⇒ E2/E3/E5/E6 全红。 */
  console.log('\n═══ E · D-4：无 sha 的任务记录 + 任意信封（第二层必须"未覆盖"）═══');
  const rNoImg = run(['_配方.mjs', '组装', '--recipe', 'ingest-page', '--subject', SHA_TXT, '--task',
    '--out', path.join(LIB, 'task-noimg.md'), '--data', LIB]);
  const tidNo = (/任务记录：(t-[0-9]{8}-[0-9]{6}-[0-9a-f]{6})/.exec(rNoImg.out) || [])[1];
  let recNo = null;
  try { recNo = JSON.parse(fs.readFileSync(path.join(LIB, RECDIR, tidNo + '.json'), 'utf8')); } catch { }
  A('E1 造出"没有原图 sha"的任务记录（组装 --task 不带 --image ⇒ image.sha256=null）',
    !!recNo && recNo.image && recNo.image.sha256 === null, 'tid=' + tidNo + ' image=' + JSON.stringify(recNo && recNo.image));

  const Z = '0'.repeat(64), F = 'f'.repeat(64);
  const noImgFile = w(LIB, 'r-noimg.json', Buffer.from(JSON.stringify({
    envelope: { schema: 'glimmernote.ingest-result/v1', taskId: tidNo, imageSha256: Z },
    result: { pageSummary: { totalQuestions: 3, markedWrong: 1 }, cards: [card(F)], skipped: [{ what: '第2题', reason: '未作答' }] },
  }), 'utf8'));
  const rNo = bind(tidNo, noImgFile);
  const l2line = (rNo.out.split('\n').find(l => /②/.test(l)) || '').trim();
  A('E2 无 sha 的任务 + 任意信封 ⇒ exit 3（缺陷复现时这里变 0）', rNo.code === 3, 'exit=' + rNo.code);
  A('E3 输出写「② 未覆盖」且**不出现**「② 与任务及原图匹配：通过」（缺陷复现时这条先红）',
    /② 与任务及原图匹配：\*\*未覆盖\*\*/.test(rNo.out) && !/② 与任务及原图匹配：通过/.test(rNo.out), l2line);
  A('E4 点名具体原因："本任务记录没有原图 sha256"（不是一句含糊的失败）', /没有原图 sha256/.test(rNo.out), l2line.slice(0, 80));

  const bareFile = w(LIB, 'r-noimg-bare.json', Buffer.from(JSON.stringify({
    pageSummary: { totalQuestions: 3, markedWrong: 1 }, cards: [card(F)], skipped: [{ what: '第2题', reason: '未作答' }],
  }), 'utf8'));
  const rNoBare = bind(tidNo, bareFile);
  A('E5 裸对象（无信封）遇到无 sha 任务同样 exit 3（"未与任务关联"不能变成"通过"）',
    rNoBare.code === 3 && /② 与任务及原图匹配：\*\*未覆盖\*\*/.test(rNoBare.out) && /未与任务关联/.test(rNoBare.out),
    'exit=' + rNoBare.code);

  const rNoJson = run(['_录题任务.mjs', '绑定校验', tidNo, '--in', noImgFile, '--data', LIB, '--json']);
  let jNo = null; try { jNo = JSON.parse(rNoJson.out); } catch { }
  A('E6 --json 里 matched=false 且 layer2=not-covered（机器消费者也拿不到"通过"）',
    rNoJson.code === 3 && !!jNo && jNo.matched === false && jNo.layer2 === 'not-covered',
    JSON.stringify(jNo && { matched: jNo.matched, layer2: jNo.layer2 }));

  /* E7 第二条门：生成任务记录时就拒绝"勾了图却没拿到 sha"的组合。
     缺陷复现：把 cmdNew 里的用法级检查删掉 ⇒ 这里 exit 0 且真落一条 image.sha256=null 的记录 ⇒ 变红。 */
  w(LIB, 'sheet.md', Buffer.from('# 任务单\n', 'utf8'));
  const beforeNew = recNames(LIB);
  const rNewBad = run(['_录题任务.mjs', '新', '--recipe', 'ingest-page', '--in', path.join(LIB, 'sheet.md'),
    '--image', '_收件箱/w/p001.jpg', '--data', LIB]);
  const afterNew = recNames(LIB);
  A('E7 `新 --image` 不给 `--image-sha` ⇒ exit 2 且**不落**记录（写入口 fail-closed）',
    rNewBad.code === 2 && /拒绝/.test(rNewBad.out) && afterNew.length === beforeNew.length,
    'exit=' + rNewBad.code + ' 新增记录=' + (afterNew.length - beforeNew.length) + ' out=' + rNewBad.out.slice(0, 60));

  console.log('\nRESULT=' + (fails ? 'FAIL(' + fails + ')' : 'PASS') + ' 断言=' + total + ' 失败=' + fails);
  try { fs.rmSync(LIB, { recursive: true, force: true }); } catch (e) { }
  try { fs.rmSync(LIB2, { recursive: true, force: true }); } catch (e) { }
  process.exit(fails ? 1 : 0);
})();
