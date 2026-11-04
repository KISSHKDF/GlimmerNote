#!/usr/bin/env node
/**
 * 原图兜底寻址（`_原图寻址.mjs`）阴性对照：六组判据，每条都必须**能红**。
 *
 * 为什么必须有它（不是为了凑数量）：
 *   这条链解决的是"**清空收件箱不会让任何一张卡断链**"。它一旦静默失效——
 *   比如"路径没了就悄悄返回空"（界面按钮变灰但没人知道为什么）、
 *   或"按路径猜一个对象交差"（张冠李戴，卡面显示成另一张卷子）——
 *   受害的正是那批**丢了就再也造不出来**的原图。
 *   所以每条不变量都要有一个"故意违反它、必须报红/必须报错"的证据。
 *
 * 实测踩过并因此写进用例的：
 *   第一版 `快照 --diff` 拿**台账**当"库里现在有什么" ⇒ 删掉一个对象它报"消失 0"；
 *   一个专门发现"对象非正常消失"的功能，恰好发现不了对象消失。
 *   本用例守住同族的另一个面：**兜底不能靠猜**。
 *
 * 退出码 0=对照全部成立；1=有不变量守不住（说明兜底不可信）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const E = require('./_测试环境.cjs');

let fails = 0;
const A = (n, ok, d) => { console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d !== undefined ? '  → ' + d : ''}`); if (!ok) fails++; };

/* 跑工具：返回 {code, out}；绝不抛（要断言"它会失败"）
   ⚠ args 的**第一个元素是工具文件名**，其余是它的参数。
   这里必须 `E.tool(args[0])` 单独取，**不能** `E.tool(...args)` ——
   那会把参数也当成工具名拼进路径（实测 exit 2 + ENOENT）。 */
const run = (args, lib) => {
  try {
    const out = execFileSync(process.execPath, [E.tool(args[0]), ...args.slice(1)], {
      encoding: 'utf8', maxBuffer: 64e6, stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { CTB_DATA: lib }),
    });
    return { code: 0, out: String(out) };
  } catch (e) {
    return { code: e.status == null ? -1 : e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
};

const LIB = E.makeTempLib();
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const IMGB = Buffer.alloc(4096, 0x4b);
const SHA = sha256(IMGB);
const INBOX_REL = '_收件箱/批次1/p01.jpg';
const INBOX_ABS = path.join(LIB, '_收件箱', '批次1', 'p01.jpg');
const CARD_DIR = path.join(LIB, '学生A', '数学', 'M0001-测试');

const mk = (rel, buf) => {
  const p = path.join(LIB, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, buf);
  return p;
};
const writeJson = (rel, obj) => {
  const p = path.join(LIB, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 1), 'utf8');
  return p;
};

/* ── 夹具：一张原图，摆在收件箱里（这样入库时 sources 会记下它）── */
mk(INBOX_REL, IMGB);
mk('学生A/数学/M0001-测试/原卷截图.jpg', Buffer.alloc(100, 9));
mk('学生A/数学/M0001-测试/错题记录.md', '# 夹具\n');
writeJson('学生A/数学/_索引.json', {
  student: '学生A', grade: '七年级', subject: '数学',
  items: [{ id: 'M0001', dir: 'M0001-测试', title: '测试题', question: 'q', answer: 'a' }],
});
/* 台账：page / import 都指向收件箱里那份。
   ⚠ **必须并入**而不是覆盖：`makeTempLib()` 复制过来的合成库里已有若干张卡，
   覆盖整个台账会让门禁报「台账里有索引已无的卡」——那是夹具自己造出来的假红，
   混进被测判据里就分不清"门禁真的红了"和"夹具没配好"。 */
{
  const lp = path.join(LIB, '_原卷台账.json');
  const led = fs.existsSync(lp) ? JSON.parse(fs.readFileSync(lp, 'utf8').replace(/^\uFEFF/, '')) : { version: 1, cards: {} };
  led.cards = led.cards || {};
  led.cards['学生A|M0001'] = {
    key: '学生A|M0001', student: '学生A', subject: '数学',
    cardDir: '学生A/数学/M0001-测试', source: '夹具',
    page: INBOX_REL, import: INBOX_REL, box: [0.1, 0.2, 0.5, 0.3],
    by: '手工', note: '阴性对照夹具',
  };
  fs.writeFileSync(lp, JSON.stringify(led, null, 1), 'utf8');
}

/* ════════ 1. 入库：内容寻址 + 来源登记 ════════ */
{
  const r = run(['_原图.mjs', '入库', path.join(LIB, '_收件箱')], LIB);
  A('1a 入库退出 0', r.code === 0, 'exit=' + r.code);
  const led = JSON.parse(fs.readFileSync(path.join(LIB, '_原图台账.json'), 'utf8'));
  A('1b 台账登记了 sha', !!led.objects[SHA], Object.keys(led.objects).join(','));
  A('1c 登记的来源里有收件箱那条路径',
    (led.objects[SHA].sources || []).some(s => s.replace(/\\/g, '/') === INBOX_REL),
    JSON.stringify(led.objects[SHA].sources));
  const obj = path.join(LIB, '_原图', SHA.slice(0, 2).toLowerCase(), SHA.toLowerCase() + '.jpg');
  A('1d 对象按 sha 命名落盘', fs.existsSync(obj), path.basename(obj));
}

/* ════════ 2. 原路径还在 ⇒ 门禁里**我的那张卡**不报"整页不在盘"（走的是原路径，不是兜底） ════════
 * ⚠ 为什么只断言"我这张卡"：合成库里本来就有指向**未复制的影像**的旧条目
 *   （影像按设计不复制进副本库），它们报"整页不在盘"是**既有噪声**，不是本次要测的东西。
 *   把整门禁的 exit code 当判据会永远红（红的是别人的卡，不是被测行为）。 */
const MY = '学生A|M0001';
const myLine = (out) => (out.split(/\r?\n/).find(l => l.includes(MY)) || '');
{
  const r = run(['_原卷台账.mjs', '门禁'], LIB);
  A('2a 原路径在时，我这张卡不报"整页不在盘"', !/整页不在盘/.test(myLine(r.out)), myLine(r.out));
  A('2b 原路径在时，不出现"兜底"字样（说明走的是原路径）', !/兜底/.test(r.out));
  A('2c 门禁没把兜底当错误（输出里没有我这张卡的 ✗）', !/✗\s*学生A\|M0001/.test(r.out), (r.out.match(/✗\s*学生A\|M0001.*/) || [''])[0]);
}

/* ════════ 3. ★ 核心：原路径没了 ⇒ 按内容从保全库兜底，我这张卡**不再报整页不在盘** ════════ */
{
  fs.unlinkSync(INBOX_ABS);   // 模拟"清空收件箱"
  const r = run(['_原卷台账.mjs', '门禁'], LIB);
  A('3a 原路径失效后，我这张卡不再报"整页不在盘"', !/整页不在盘/.test(myLine(r.out)), myLine(r.out));
  A('3b 输出明说"已从保全库按内容兜底"', /已从保全库按内容兜底/.test(r.out));
  A('3c 明细里点名这张卡', r.out.includes(MY));
  A('3d 我这张卡没有被判成错误', !/✗\s*学生A\|M0001/.test(r.out), (r.out.match(/✗\s*学生A\|M0001.*/) || [''])[0]);
}

/* ════════ 4. 状态生成器：origPage 应指向保全库里的对象 ════════ */
{
  const r = run(['生成状态.mjs', '--out', '-', '--quiet'], LIB);
  A('4a 状态生成器退出 0', r.code === 0, 'exit=' + r.code);
  let st = null;
  try { st = JSON.parse(r.out.replace(/^\uFEFF/, '')); } catch { }
  A('4b 输出是合法 JSON', !!st);
  /* 只找**我这张卡**：状态包里卡片对象上没有 student 字段（它在学生层），
     所以按「父级学生名 + 卡 id」定位，别按卡对象里的 student 字段找。 */
  const find = (st) => {
    for (const d of (st.data || [])) {
      if (d.name !== '学生A') continue;
      for (const s of (d.subjects || [])) {
        for (const c of (s.items || [])) {
          if (c.id === 'M0001' && Object.prototype.hasOwnProperty.call(c, 'origPage')) return c;
        }
      }
    }
    return null;
  };
  const c = find(st);
  A('4c 我这张卡在状态包里（有 origPage 字段）', !!c);
  if (c) {
    A('4d origPage 指向保全库（路径含 _原图/）', decodeURIComponent(c.origPage || '').includes('_原图/'), decodeURIComponent(c.origPage || ''));
    A('4e origResolve 标成 store（明示这是兜底来的）', c.origResolve === 'store', String(c.origResolve));
  }
}

/* ════════ 5. ★ 反面：保全库里也没有 ⇒ **必须判红**（不许兜底成"没事"） ════════ */
{
  const obj = path.join(LIB, '_原图', SHA.slice(0, 2).toLowerCase(), SHA.toLowerCase() + '.jpg');
  fs.unlinkSync(obj);   // 现在字节真的没了
  const r = run(['_原卷台账.mjs', '门禁'], LIB);
  A('5a 字节真没了 ⇒ 门禁判红（exit≠0）', r.code !== 0, 'exit=' + r.code);
  A('5b 输出说清"真的断了"', /真的断了|不在盘/.test(r.out), (r.out.match(/.*(真的断了|整页不在盘).*/) || [''])[0]);
  A('5c 没有谎称"已兜底"', !/已从保全库按内容兜底/.test(r.out));
}

/* ════════ 6. ★ 绝不按路径猜：同一路径换成**别的内容** ⇒ 不得被当成同一张 ════════
 * ★ 2026-11-03（task-14 收口这条弱断言）：本段原来的核心判据只有 `r.code !== 0`，
 *   而**合成库本来就有** "整页不在盘" 的既有噪声（见 §2 注释：复制过来的库里本来就有指向
 *   未复制影像的条目）⇒ 那条"红"**分不清**是"§6 要验的场景被抓到了"还是"噪声还在"
 *   （T-1 家族：弱判据占着"有防线"的位置）。实测（本轮在 %TEMP% 隔离副本里变异）：把 §6
 *   要验的行为掏掉后，`exit !== 0` 照样成立 —— 旧断言仍绿，本段等于没守。
 *   现在判据落在**两件可区分的事**上：
 *     · 门禁的 ✗ 行必须**点名 `学生A|M0001`**（而不是"反正有红"）；
 *     · **不许**出现"已从保全库按内容兜底"（出现即意味着拿同路径下另一份内容顶替了原 sha）。
 *   为什么必须把路径也清掉才判：门禁只在 `!exists(page)` 时才去问寻址器 —— 路径还在时它
 *   **根本不查**，"内容被换掉"这件事在门禁上完全不可见（本轮实测确认）。
 *   状态构造：路径没了；台账两条 sha 都登记着这条路径；SHA 的对象已在 §5 删除；OTHER 的对象还在盘。 */
{
  /* 重新入库**另一份内容**（同一个收件箱路径，但字节不同）：
     若实现是"按路径取对象"而不是"按内容核对"，就会张冠李戴。 */
  const OTHER = Buffer.alloc(4096, 0x99);
  const OTHER_SHA = sha256(OTHER);
  mk(INBOX_REL, OTHER);
  const ing = run(['_原图.mjs', '入库', INBOX_ABS], LIB);
  A('6a 另一份内容入库成功', ing.code === 0, 'exit=' + ing.code);
  const led = JSON.parse(fs.readFileSync(path.join(LIB, '_原图台账.json'), 'utf8'));
  A('6b 台账里是两个不同的 sha', Object.keys(led.objects).length === 2, Object.keys(led.objects).join(','));
  A('6c 两个 sha 内容确实不同', !!led.objects[SHA] && !!led.objects[OTHER_SHA] && SHA !== OTHER_SHA);
  const objOther = path.join(LIB, '_原图', OTHER_SHA.slice(0, 2).toLowerCase(), OTHER_SHA.toLowerCase() + '.jpg');
  A('6d 另一份的对象在盘上', fs.existsSync(objOther));
  /* 6e 夹具前提（夹具自检，不是被测行为）：两条 sha 的来源里**都**登记着同一条路径。
     没有这条，"一路径两 sha"的夹具可能静默退化（实测过一次：辅助函数用覆盖语义把来源顶掉，
     下游六条断言一起假红，看起来像产品坏了）。 */
  const srcsOf = (sha) => (led.objects[sha].sources || []).map(s => String(s).replace(/\\/g, '/'));
  A('6e 夹具前提：两条 sha 都登记着同一条来源路径',
    srcsOf(SHA).includes(INBOX_REL) && srcsOf(OTHER_SHA).includes(INBOX_REL),
    'A=' + JSON.stringify(srcsOf(SHA)) + ' B=' + JSON.stringify(srcsOf(OTHER_SHA)));

  /* ★ 关键一步：把路径也清掉，门禁才会真的去问寻址器（见段首注释）。
     正确行为 = **拒绝顶替**：不许"挑还在盘的那份"交差，必须如实报这张卡断了。
     ⚠ 判据**不能**落在"门禁输出里点名我的卡"上：门禁的错误打印有 CAP=40 截断（实测本夹具
     当前共 495 条错误、只打 40 行，我的 ✗ 行**打不出来**）。所以判据落在**无截断**的通道：
       · 生产侧：状态包（`生成状态.mjs` 写盘模式的产物，逐卡可查）；
       · 消费侧：切片 `model.js` 的 `M.origOf` 真跑（喂状态包里的**真实字段**，不起浏览器）；
       · 口径：与 `_状态刷新.mjs` 逐字段对照；
       · 措辞 + 寻址器自己的 fail-closed 告警。 */
  fs.unlinkSync(INBOX_ABS);
  const r = run(['_原卷台账.mjs', '门禁'], LIB);
  /* 生产侧：**写盘模式**跑生成器（写的是临时库的 `_状态.json`）——既拿状态包，
     也给下面 `_状态刷新.mjs` 的一致性对照留一个真实起点。 */
  const stateFile = path.join(LIB, '_状态.json');
  const genRun = run(['生成状态.mjs', '--quiet'], LIB);
  const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };
  const pickCard = (s) => {
    for (const d of ((s && s.data) || [])) {
      if (d.name !== '学生A') continue;
      for (const sub of (d.subjects || [])) for (const it of (sub.items || [])) if (it.id === 'M0001') return it;
    }
    return null;
  };
  const gen = readState();
  const card = gen ? pickCard(gen) : null;
  const genPair = card ? { page: card.origPage, resolve: card.origResolve } : null;
  const decPage = (() => { try { return decodeURIComponent(String(card && card.origPage)); } catch { return String(card && card.origPage); } })();

  /* ── 6f 生产侧：fail-closed 现场必须落成 **JSON null**（不是字符串 "null"）+ 'lost' ──
     缺陷复现（把生成器那四行改回 `rp ? …`）⇒ origPage = 字符串 "null"、origResolve = null ⇒ 红。 */
  A('6f 生产侧：状态包 origPage 必须是 **JSON null**、origResolve 必须是 "lost"（写盘生成 exit=' + genRun.code + '）',
    !!card && card.origPage === null && typeof card.origPage === 'object' && card.origResolve === 'lost',
    'origPage=' + JSON.stringify(card && card.origPage) + '(' + typeof (card && card.origPage) + ') origResolve=' + JSON.stringify(card && card.origResolve));
  A('6g 生产侧：不许把我这张卡指到 _原图/ 下"同路径的另一份内容"，也不许标 store（顶替即红）',
    !!card && !/_原图\//.test(decPage) && card.origResolve !== 'store',
    'origPage=' + JSON.stringify(card && card.origPage));

  /* ── 6h 消费侧后果（切片 `model.js` 的 `M.origOf` 真跑）：喂**状态包里的真实字段** ──
     `orig: c && c.origPage ? H.relPath(c.origPage) : null` 判的是真值，所以生产侧写什么决定界面
     怎么理解。缺陷复现 ⇒ 字符串 "null" 判真 ⇒ `orig` 变成 `REL:null`（界面去取一张不存在的图）⇒ 红。 */
  const MODEL_SRC = fs.readFileSync(path.join(E.REPO, 'src', 'app', 'js', 'model.js'), 'utf8');
  let origOf = null;
  try {
    const ma = MODEL_SRC.indexOf('M.origOf = function (x) {');
    const mb = MODEL_SRC.indexOf('\n})();', ma);
    if (ma < 0 || mb < 0) throw new Error('找不到 M.origOf 的边界');
    origOf = new Function('M', 'H', MODEL_SRC.slice(ma, mb) + '\nreturn M.origOf;')(
      { cardOf: (x) => x.card },
      { relPath: (p) => 'REL:' + decodeURIComponent(String(p)) });
  } catch (e) { /* 下面断言会红 */ }
  const consumerOrig = (origOf && card) ? origOf({ card }).orig : '<切片失败>';
  A('6h 消费侧（切片 model.js 真跑）：我这张卡必须映射成 null（"未定位"），不许变成某个 …/null 路径',
    consumerOrig === null, 'orig=' + JSON.stringify(consumerOrig));

  /* ── 6i 两个写入方口径一致：造一个**旧包**现场（死路径 + 缺 origResolve）交给 `_状态刷新.mjs`
     自愈，再与生成器的结论逐字段比。任一侧漂移（生成器写 "null" / 刷新器不清死路径）都会红。 ── */
  const encRelLocal = (rel) => String(rel).split('/').map(encodeURIComponent).join('/');
  let refreshCard = null, refreshNote = '';
  if (gen && card) {
    try {
      card.origPage = encRelLocal(INBOX_REL);      // 旧包现场：死路径（文件已删）
      delete card.origResolve;
      fs.writeFileSync(stateFile, JSON.stringify(gen), 'utf8');
      const rr = run(['_状态刷新.mjs', 'pending'], LIB);
      refreshNote = 'refresh exit=' + rr.code;
      refreshCard = pickCard(readState());
    } catch (e) { refreshNote = 'refresh 抛错：' + String((e && e.message) || e); }
  }
  A('6i 两个写入方口径一致：旧包自愈后的 (origPage,origResolve) 必须等于生成器的结论，且都是 (null,"lost")',
    !!genPair && genPair.page === null && genPair.resolve === 'lost' && !!refreshCard &&
    refreshCard.origPage === null && refreshCard.origResolve === 'lost',
    '生成器=' + JSON.stringify(genPair) + ' 自愈后=' + JSON.stringify(refreshCard && { page: refreshCard.origPage, resolve: refreshCard.origResolve }) + ' ' + refreshNote);

  A('6j 措辞通道：门禁输出不出现"已从保全库按内容兜底"（出现即意味着顶替了原 sha）',
    !/已从保全库按内容兜底/.test(r.out), '出现=' + /已从保全库按内容兜底/.test(r.out));
  A('6k fail-closed 信号可见：输出里有寻址器的"拒绝猜"告警（歧义被如实报出，不是静默 null）',
    /拒绝猜/.test(r.out), (r.out.split(/\r?\n/).find(l => /拒绝猜/.test(l)) || '(没有)').trim().slice(0, 110));
  /* 6l 把"旧判据为什么没用"钉成事实（夹具/工具的现实，不是被测行为）：
     门禁的错误打印是**截断**的（另有 N 条；当前共 M 条错误），而 exit 又必然非 0
     —— 于是"exit≠0"和"输出里点名到卡"两条路**都不可靠**，这正是 §6 旧断言（只有 exit≠0）
     能被噪声养活的原因。
     ★ 2026-11-04 修（CI 在干净克隆上抓到的真缺陷）：判据**不能**写死"错误总数 > 40" ——
       那是**本机真库的规模特征**（实测 495 条），合成夹具库只有 1 条噪声 ⇒ 门禁不触发
       CAP=40 截断 ⇒ 截断行缺席 ⇒ 断言红。同一句断言在真库绿、在干净克隆红 = 腐烂。
       改成**对被测对象当场计算**：截断行存在 ⇒ 直接证明"exit≠0 分不清场景与噪声"；
       未截断（库很小）时由 6m 的"噪声行 ≥1"承担同一命题（噪声在场 ⇒ exit≠0 仍分不清场景）。
       两种库规模下都成立，且**不放宽**：截断时验截断、没截断时验噪声，二者必居其一。 */
  const mTrunc = /另有 (\d+) 条（其余类别错误已截断；当前共 (\d+) 条错误）/.exec(r.out);
  const truncHits = !!mTrunc;
  const noiseHere = r.out.split(/\r?\n/).filter(l => /✗/.test(l) && /整页不在盘/.test(l) && !l.includes(MY));
  A('6l "exit≠0"本身分不清场景与噪声（截断在场 ⇒ 只见总数不见我的行 / 无截断 ⇒ 噪声行本身够红）',
    r.code !== 0 && (truncHits || noiseHere.length >= 1),
    'exit=' + r.code + ' 截断行=' + JSON.stringify(mTrunc ? mTrunc[0] : '(无)') + ' 噪声行数=' + noiseHere.length);
  /* 6m 既有噪声确实在场（不点名我的"整页不在盘" ≥1 行）—— 6l 的补强，防"截断行"判据失效 */
  const noise = r.out.split(/\r?\n/).filter(l => /✗/.test(l) && /整页不在盘/.test(l) && !l.includes(MY));
  A('6m 既有噪声确实在场（不点名我的"整页不在盘" ≥1 行）', noise.length >= 1,
    '噪声行数=' + noise.length + ' 例：' + String(noise[0] || '').trim().slice(0, 80));
}

console.log('');
console.log(`RESULT=${fails ? 'FAIL(' + fails + ')' : 'PASS'} 断言=32 失败=${fails}`);
process.exit(fails ? 1 : 0);
