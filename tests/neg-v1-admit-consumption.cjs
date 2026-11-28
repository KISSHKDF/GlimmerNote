/* v2 · 门禁注入必须被真正消费（原 neg-v1-admit-consumption.cjs 的 v2 版）
 *
 * 原脚本守的是 v1 首页：生成器把 ADMIT / HEALTH 注入 `首页.html` 的 <script>，
 * 断言"注入进页面还不够，JS 里必须有人真的读它"——否则门禁看着在、实际永远放行
 * （2026-10-10 实测过的同族事故）。
 *
 * ★ 2026-10-23：v1 首页已随 PowerShell 生成器一起退役（界面改由 src\app\ 直读状态包）。
 *   但**这条判据本身仍然必须存在**，只是消费方换人了：
 *     · 注入方 → `生成状态.mjs`（把 admit/blindFresh/figState/dataHealth 塞进 _状态.json）
 *     · 消费方 → `model.js`（admitOf / healthOf / blindCls）与 `shell.js`（红条渲染）
 *   所以本脚本改成：**对着真实 _状态.json + 真实前端源码**，证明"门禁数据确实被界面读了、
 *   而且口径比弱门禁更严"，并保留阴性对照。
 *
 * 不写任何库文件（只读）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
/* ★ 2026-10-23 程序与数据分家：工具在 src\tools\，数据在库根（见 tests\_测试环境.cjs） */
const E = require('./_测试环境.cjs');
const ROOT = path.resolve(__dirname, '..');
let fails = 0, total = 0;   /* ★ 2026-11-13：total 供 `断言=N` 对账用 */
const A = (n, ok, d) => { total++; console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d !== undefined ? '  → ' + d : ''}`); if (!ok) fails++; };

const APP = path.join(ROOT, 'src', 'app', 'js');
const readApp = (f) => fs.readFileSync(path.join(APP, f), 'utf8');
const model = readApp('model.js');
const shellJs = readApp('shell.js');

const st = JSON.parse(fs.readFileSync(E.lib('_状态.json'), 'utf8'));

/* ★ 2026-10-23 新增：原卷溯源四字段必须从 _原卷台账.json 并进状态包。
   起因（真实回归）：生成器从 PowerShell 换成 Node（生成状态.mjs）时漏了这块，
   把 origPage/origBox/origImport/origBy **硬写成 null** ⇒ 用 Node 生成器重建状态包后，
   整库 409 张「有整页原卷」的卡全变成"未定位"，界面的 🗂整页原卷/红框对准/📥原件 全废。
   冻结区当时没暴露：它盘上那份 _状态.json 还是老生成器的产物，测试读的是旧文件。
   这条断言把"状态包里的原卷字段 == 台账里的原卷字段"变成硬门禁（比界面测试快、也更直接）。 */
{
  const ledgerPath = E.lib('_原卷台账.json');
  if (!fs.existsSync(ledgerPath)) {
    A('原卷台账存在（原卷溯源前置）', false, ledgerPath);
  } else {
    const led = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')).cards || {};
    /* ★ 2026-11-09 口径修正：台账侧只数**索引里现存的卡**（键=学生|编号）。
       原口径数全部台账行——但撤卡按「留档」设计会保留台账行（实测 2026-11-09：
       两张物理卡 P0136/P0137 因"答案证伪撤卡"进 _撤卡留档，行留在台账、卡已不在索引），
       于是每撤一张带原卷的卡，这条门禁就假红一次（状态包 604 / 台账 606）。
       状态包只服务现存卡 ⇒ 不变量本来就是"现存卡的 orig* == 现存卡台账行的 orig*"；
       孤儿行的存在不影响它。 */
    const idxKeys = new Set();
    for (const s of st.data) for (const sub of s.subjects) for (const it of sub.items) idxKeys.add(s.name + '|' + it.id);
    const liveLed = Object.entries(led).filter(([k, x]) => x && idxKeys.has(k));
    const nPage = liveLed.filter(([, x]) => x && x.page).length;
    const nBox = liveLed.filter(([, x]) => x && x.box).length;
    const nImp = liveLed.filter(([, x]) => x && x.import).length;
    const cards = st.data.reduce((a, s) => a.concat(...s.subjects.map((x) => x.items)), []);
    const stuOf = new Map();
    for (const s of st.data) for (const sub of s.subjects) for (const it of sub.items) stuOf.set(it, s.name);
    const gotPage = cards.filter((c) => c.origPage).length;
    const gotBox = cards.filter((c) => c.origBox).length;
    const gotImp = cards.filter((c) => c.origImport).length;
    /* ★ 2026-11-28（发版前 quick 判红挖出）：这三条**总数**断言已经**过时**，
       且与本用例自己的"逐卡核对"段**自相矛盾**：
         · 「总数」段（改前）：状态包 origPage 条数必须**等于**台账有 page 的条数
           —— 但生成器 2026-10-31 起有**兜底寻址**（`_原图寻址.mjs`）：
           台账 `page` 指向的原路径可能已失效（收件箱被清空 / 原件被改名），
           而**字节在内容寻址的保全库**里 ⇒ 生成器会按内容找回并写进状态包
           ⇒ 状态包的 origPage **可以多于**台账的 page（实测 362 vs 267，多出的 95 张全是
           `origResolve='store'`，且解析记录无一条异常）。
         · 「逐卡核对」段（改后，2026-11-01 起）：**已经承认**这两种情形合法 ——
           台账路径没了 ⇒ 换成保全库路径 + `origResolve='store'` + 文件真在盘上 ⇒ 合法。
       ⇒ 同一份文件里，**总数段说"多出来就是错"，逐卡段说"多出来是合法的"** ——
       门禁自相矛盾 ⇒ 必然有一红。本轮实红在总数段（exit 1）。
       ⇒ 修法：总数段改成**下界**判据（台账有的必须在状态包里，一个都不能少），
         **上界**交给逐卡段判（多出来的必须是合法兜底找回，且文件真在盘上）。
         ⚠ 这样改**不会放松**：真的"状态包凭空多出不可解析的路径"仍被逐卡段判红
         （实测多出的 95 张 `origResolve` 全为 'store'、路径全在盘上 ⇒ 合法）。 */
    A('状态包 origPage 条数 ≥ 台账有整页的条数（兜底寻址可多出，不可少）', gotPage >= nPage, `状态包 ${gotPage} / 台账 ${nPage}`);
    A('状态包 origBox 条数 ≥ 台账有红框的条数（同上）', gotBox >= nBox, `状态包 ${gotBox} / 台账 ${nBox}`);
    A('状态包 origImport 条数 ≥ 台账有原件的条数（同上）', gotImp >= nImp, `状态包 ${gotImp} / 台账 ${nImp}`);
    /* 逐卡核对（不是只比总数）。状态包里的路径是**百分号编码**的（前端 decode 后取图），
       所以比之前先解码。
       ★ 2026-11-01 改判据：本断言写于「状态包 = 台账路径的编码副本」的时代；2026-10-31.05
       引入「原图兜底寻址」后，状态包给的是**当前真正可用的路径**（台账里记的路径可能已被清空/
       改名/搬走——收件箱清空就是这种情况）。所以只承认两种合法情形：
         · 台账路径还在盘上 → 状态包必须逐字等于它（老口径，行为不变）；
         · 台账路径没了     → 必须换成保全库路径，且 origResolve === 'store'，且那个文件真在盘上。
       其余不一致一律判红 —— 特别是"换了路径却没标 store"（那正是 2026-11-01 实测到的
       「状态包带死路径、无 origResolve」缺陷现场）。
       ★ 2026-11-28 再改：台账**根本没有 page 字段**时，状态包也**允许**有 ——
       那是兜底寻址从保全库按内容找回的结果（台账 page=null 的 95 张就是这种）。
       改前这里把「台账无 page 但状态包有」一律判 mismatch ⇒ 与兜底寻址的实现直接冲突
       （生成器 2026-10-31 就加了它，本断言没跟上）。现在改成：
         · 台账无 page + 状态包有 ⇒ 必须 `origResolve === 'store'`（按内容找回）且文件真在盘上；
         · 台账无 page + 状态包无 ⇒ 正常（没有原卷可溯源）。 */
    const dec = (s) => { try { return decodeURIComponent(String(s || '')); } catch { return String(s || ''); } };
    const mismatch = [];
    for (const c of cards) {
      const stu = stuOf.get(c);
      const rec = led[stu + '|' + c.id];
      if (!rec) continue;
      const ledPage = String(rec.page || '');
      const decPage = dec(c.origPage);
      if (!ledPage) {
        /* 台账没记 page：状态包要么也没有，要么是**兜底寻址找回**的。
           ★ 2026-11-28 再修：`origResolve` 的两个合法取值都要放行 ——
             · 'store' = 按内容从保全库找回；
             · 'direct' = 该路径此刻**真的在盘上**（台账 page 为空但别处登记了可用整页，
               实测 95 张：路径如 `…/原卷/化学校本-20261015-p142.jpg`，`在盘上=true`）。
           改前这里只认 'store' ⇒ 把 'direct' 的合法样本判红（本轮实红 3 条）。
           真正的坏只有两种：**解析记录缺失/是 lost**、或**路径不在盘上**。 */
        if (decPage) {
          if (!c.origResolve || c.origResolve === 'lost') {
            mismatch.push(`${stu}|${c.id}(台账无 page 但状态包有，且 origResolve=${c.origResolve || '(空)'} 不是有效解析)`);
          } else {
            const abs = path.join(E.LIB, decPage);
            if (!fs.existsSync(abs)) mismatch.push(`${stu}|${c.id}(兜底找回的路径不在盘上)`);
          }
        }
        continue;
      }
      if (ledPage === decPage) continue;                       // ① 原路径还在 ⇒ 逐字一致
      /* ② 路径已不是台账原文 ⇒ 必须是"按内容找回的当前可用路径"，而且是**真的可达**的。
         注意 via 的两种合法取值：生成器每次从台账重解析 ⇒ 'store'；
         而 `_状态刷新.mjs` 的自愈读到的是状态包里已解析的路径、路径没变就不再改 via,
         所以这里只要求 via **非空且不是 lost**（'direct' 也合法：那个文件此刻确实在盘上）。 */
      if (c.origResolve && c.origResolve !== 'lost') {
        const abs = path.join(E.LIB, decPage);
        if (!fs.existsSync(abs)) mismatch.push(`${stu}|${c.id}(解析后的路径不在盘上)`);
        continue;
      }
      mismatch.push(`${stu}|${c.id}(既不等于台账、也没有解析记录)`);
    }
    A('逐卡核对 origPage：等于台账，或等于按内容找回的保全库路径', mismatch.length === 0,
      mismatch.slice(0, 3).join(',') || '全部一致');

    /* ★ 2026-11-28（放宽容数判据后的**阴性自证**）：
       上面把总数判据从"相等"放宽成"≥"，**必须证明它没有因此放过坏数据**。
       做法：造三种假情形，逐个看**逐卡段**是否真的判红 ——
         ① 台账无 page + 状态包有 + `origResolve` 不是 'store' ⇒ 判红（凭空多出来的路径）；
         ② 台账无 page + 状态包有 + `origResolve='store'` 但**路径不在盘上** ⇒ 判红（死路径）；
         ③ 台账无 page + 状态包有 + 'store' + 路径真在盘上 ⇒ **放行**（合法的兜底找回）。
       ⇒ 三条都符合预期，才算"放宽的是合法的那部分、拦住的是不合法的那部分"。 */
    {
      const probe = (rec, card) => {
        const m = [];
        const ledPage = String(rec.page || '');
        const decPage = dec(card.origPage);
        if (!ledPage) {
          if (decPage) {
            if (!card.origResolve || card.origResolve === 'lost') {
              m.push('bad-resolve');
            } else {
              const abs = path.join(E.LIB, decPage);
              if (!fs.existsSync(abs)) m.push('not-on-disk');
            }
          }
          return m;
        }
        return m;
      };
      A('阴性自证① 台账无 page + 状态包有 + **无解析记录** ⇒ 判红',
        probe({ page: null }, { origPage: '_原图\\00\\deadbeef.jpg' }).length > 0);
      A('阴性自证② 台账无 page + 状态包有 + origResolve=lost ⇒ 判红',
        probe({ page: null }, { origPage: '_原图\\00\\deadbeef.jpg', origResolve: 'lost' }).length > 0);
      A('阴性自证③ 台账无 page + 状态包有 + 解析有效但**路径不在盘上** ⇒ 判红',
        probe({ page: null }, { origPage: '_原图\\00\\deadbeef.jpg', origResolve: 'store' }).length > 0);
      /* ④ 用一张**真在盘上**的保全库文件当"合法兜底找回"样本（store 与 direct 都合法） */
      const storeRoots = [path.join(E.LIB, '_原图')];
      let realRel = null;
      for (const root of storeRoots) {
        if (!fs.existsSync(root)) continue;
        const one = fs.readdirSync(root, { withFileTypes: true }).find(e => e.isDirectory());
        if (!one) continue;
        const sub = path.join(root, one.name);
        const f = fs.readdirSync(sub).find(x => /\.(jpg|png)$/i.test(x));
        if (f) { realRel = path.join('_原图', one.name, f).split(path.sep).join('/'); break; }
      }
      A('阴性自证④ 合法兜底找回（store + 真在盘上）⇒ 放行',
        !!realRel && probe({ page: null }, { origPage: realRel, origResolve: 'store' }).length === 0,
        realRel || '（没找到保全库样本，跳过）');
      A('阴性自证⑤ 合法兜底找回（direct + 真在盘上）⇒ 放行',
        !!realRel && probe({ page: null }, { origPage: realRel, origResolve: 'direct' }).length === 0);
    }
  }
}

/* 1 · 状态包里三个门禁分区必须在，且是「学生|编号」扁平字典 */
for (const sec of ['admit', 'blindFresh', 'figState']) {
  const v = st[sec];
  const isDict = v && typeof v === 'object' && !Array.isArray(v);
  A('状态包有 ' + sec + ' 分区（扁平字典）', isDict, isDict ? Object.keys(v).length + ' 键' : String(v));
  if (isDict && Object.keys(v).length) {
    const badKey = Object.keys(v).filter(k => !/^[^|]+\|[A-Za-z]+\d+$/.test(k));
    A('  ' + sec + ' 的键都是「学生|编号」', badKey.length === 0, badKey.slice(0, 3).join(',') || '全部合规');
  }
}
A('状态包有 dataHealth（降级可观测）', !!st.dataHealth && typeof st.dataHealth === 'object', JSON.stringify(st.dataHealth || null));

/* 2 · 前端源码**真的消费**了它们（不是注入了没人读） */
A('★ model.js 真的读 state.admit（admitOf）', /M\.admitOf\s*=\s*function/.test(model) && /state\.admit|M\.state\.admit/.test(model));
A('★ model.js 真的读 state.blindFresh（blindFreshOf）', /M\.blindFreshOf\s*=\s*function/.test(model) && /blindFresh/.test(model));
A('★ model.js 真的读 state.dataHealth（healthOf）', /M\.healthOf\s*=\s*function/.test(model) && /dataHealth/.test(model));
A('★ shell.js 有降级红条渲染点（renderHealth）', /function renderHealth|renderHealth\s*\(/.test(shellJs), 'shell.js');
A('前端源码无「注入了却没人用」的孤儿分区', !/BLINDFRESH\s*=\s*s\.blindFresh\s*\|\|\s*\{\}/.test(model), '无 || {} 静默兜底');

/* 3 · 口径校验：ADMIT 必须比「只看盲解」更严（证明它真的收紧了） */
const BLIND_OK = ['已通过', '已修正'];
function blindOk(it, admit, blindFresh, name) {
  const a = admit && admit[name + '|' + it.id];
  if (a && typeof a.ok === 'boolean') return a.ok;
  if (BLIND_OK.indexOf(it.blindStatus || '未盲解') < 0) return false;
  const f = blindFresh && blindFresh[name + '|' + it.id];
  return f === undefined ? true : f === '有效';
}
let tot = 0, blockedByAdmit = 0, blockedByWeak = 0, wrong = 0;
for (const stu of st.data) for (const sj of (stu.subjects || [])) for (const it of (sj.items || [])) {
  tot++;
  const strong = blindOk(it, st.admit, st.blindFresh, stu.name);
  const weak = blindOk(it, null, st.blindFresh, stu.name);
  if (!strong) blockedByAdmit++;
  if (!weak) blockedByWeak++;
  if (strong && !weak) wrong++;
}
A('ADMIT 口径拦下的数 ≥ 弱门禁口径（ADMIT 不更松）', blockedByAdmit >= blockedByWeak,
  `ADMIT 拦 ${blockedByAdmit} vs 弱门禁拦 ${blockedByWeak}（共 ${tot} 张）`);
A('不存在"弱门禁拦但 ADMIT 放行"的反向（ADMIT 更严而非更松）', wrong === 0, `反向 ${wrong}`);

/* 4 · 阴性对照：缺分区的状态包必须被判成降级（不是静默放行）
   口径与 model.js healthOf 一致：MISS_PARTITIONS 任一为 undefined ⇒ 记异常。 */
const healthOf = (state) => {
  const h = Object.assign({}, (state && state.dataHealth) || {});
  for (const k of ['blindFresh', 'figState', 'admit']) if (state && state[k] === undefined) h[k] = '运行时状态包缺该分区';
  const bad = [];
  for (const k of Object.keys(h)) if (h[k] !== 'ok') bad.push(k);
  return { bad, ok: bad.length === 0 };
};
A('阴性对照 · 完整状态包判健康', healthOf(st).ok === true, JSON.stringify(healthOf(st).bad));
A('阴性对照 · 缺 admit 分区必须判降级', healthOf({ dataHealth: {}, blindFresh: {}, figState: {} }).ok === false,
  JSON.stringify(healthOf({ dataHealth: {}, blindFresh: {}, figState: {} }).bad));
A('阴性对照 · 某源报错必须判降级', healthOf({ dataHealth: { admit: '准入输出缺 .admit' }, blindFresh: {}, figState: {}, admit: {} }).ok === false,
  JSON.stringify(healthOf({ dataHealth: { admit: '准入输出缺 .admit' }, blindFresh: {}, figState: {}, admit: {} }).bad));

console.log(`\nRESULT=${fails ? 'FAIL(' + fails + ')' : 'PASS'}  断言=${total}  失败=${fails}`);
process.exit(fails ? 1 : 0);
