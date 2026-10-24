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
let fails = 0;
const A = (n, ok, d) => { console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d !== undefined ? '  → ' + d : ''}`); if (!ok) fails++; };

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
    const nPage = Object.values(led).filter((x) => x && x.page).length;
    const nBox = Object.values(led).filter((x) => x && x.box).length;
    const nImp = Object.values(led).filter((x) => x && x.import).length;
    const cards = st.data.reduce((a, s) => a.concat(...s.subjects.map((x) => x.items)), []);
    const stuOf = new Map();
    for (const s of st.data) for (const sub of s.subjects) for (const it of sub.items) stuOf.set(it, s.name);
    const gotPage = cards.filter((c) => c.origPage).length;
    const gotBox = cards.filter((c) => c.origBox).length;
    const gotImp = cards.filter((c) => c.origImport).length;
    A('状态包 origPage 条数 == 台账有整页的条数', gotPage === nPage, `状态包 ${gotPage} / 台账 ${nPage}`);
    A('状态包 origBox 条数 == 台账有红框的条数', gotBox === nBox, `状态包 ${gotBox} / 台账 ${nBox}`);
    A('状态包 origImport 条数 == 台账有原件的条数', gotImp === nImp, `状态包 ${gotImp} / 台账 ${nImp}`);
    /* 逐卡核对（不是只比总数）：任一张卡的 origPage 必须等于台账里那条的 page。
       状态包里的路径是**百分号编码**的（老生成器口径，前端 decode 后取图），所以比之前先解码。 */
    const dec = (s) => { try { return decodeURIComponent(String(s || '')); } catch { return String(s || ''); } };
    const mismatch = [];
    for (const c of cards) {
      const stu = stuOf.get(c);
      const rec = led[stu + '|' + c.id];
      if (!rec) continue;
      if (String(rec.page || '') !== dec(c.origPage)) mismatch.push(`${stu}|${c.id}`);
    }
    A('逐卡核对 origPage 与台账一致', mismatch.length === 0, mismatch.slice(0, 3).join(',') || '全部一致');
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

console.log(`\nRESULT=${fails ? 'FAIL(' + fails + ')' : 'PASS'}`);
process.exit(fails ? 1 : 0);
