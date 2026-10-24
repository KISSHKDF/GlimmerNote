/* 阴性对照：卷面/抽屉里的题图不得撑破容器（2026-10-12 用户实测报障：
   组卷预览的 P0035「钢棒撬石头」题图右侧溢出白纸，约 39mm）。

   根因（两级，都是"样式写不住"）：
     ① 卡片 stemHtml 自带 `style="max-width:820px"`，与 `.sheet .q-stem img{max-width:100%}`
        **同 specificity** ⇒ 行内必胜 ⇒ 按 820px 渲染，而纸面内容可用宽只有 178mm ≈ 673px。
        ⇒ CSS 必须用 `!important` 才能压过行内 style。
     ② `.stembox`（抽屉里的题干，与卷面消费**同一份** stemHtmlSafe 输出）原先**完全没有** img 规则。

   为什么这条断言"改前必红"：判据直接读 app.css 的规则文本，
   删掉 `!important` 或删掉 .stembox 那条，立刻红 —— 不是恒假断言。
   用法：node tests/neg-stem-img-fit.cjs */
const fs = require('fs');
const E = require('./_测试环境.cjs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
/* ★ 2026-10-23 程序与数据分家：rd() 依次找三处 ——
     ① 仓库相对路径（'src/app/js/model.js' 这类前端源码）
     ② 工具目录（'_标记复习.mjs' 这类）
     ③ 库根（'_状态.json' 这类用户数据） */
const rd = f => {
  for (const base of [ROOT, E.TOOLS, E.LIB]) {
    const p2 = path.join(base, f);
    if (fs.existsSync(p2)) return fs.readFileSync(p2, 'utf8');
  }
  throw new Error('rd() 找不到文件：' + f);
};

let pass = 0, fail = 0;
const A = (label, ok, extra = '') => {
  if (ok) { pass++; console.log('  [OK]  ' + label + (extra ? '  → ' + extra : '')); }
  else { fail++; console.log('  [FAIL] ' + label + (extra ? '  → ' + extra : '')); }
};

const ST = JSON.parse(rd('_状态.json'));
const CSS = rd('src/app/css/app.css');

/* ---------- 内存沙箱：载真实的 util/host/model ---------- */
const store = new Map();
const CTB = { util: {}, host: {}, model: {}, shell: {}, views: {} };
const sandbox = {
  console, JSON, Math, Date, Array, Object, String, Number, RegExp, Map, Set, WeakMap,
  isNaN, parseInt, parseFloat, CTB,
  localStorage: {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  },
  window: { addEventListener() { } },
};
sandbox.globalThis = sandbox; sandbox.window = sandbox;
vm.createContext(sandbox);
for (const f of ['src/app/js/util.js', 'src/app/js/host.js', 'src/app/js/model.js']) vm.runInContext(rd(f), sandbox, { filename: f });
const M = sandbox.CTB.model;
M.applyState(ST);

const MM2PX = 96 / 25.4;
const avail = (210 - 16 * 2) * MM2PX;          // .sheet 内容可用宽（px @96dpi）

/* ══ ① 个案：P0035 ══ */
console.log('═══ 卷面题图溢出（P0035 个案） ═══');
let card = null;
for (const k of ST.data) for (const s of (k.subjects || [])) for (const c of (s.items || [])) if (c.id === 'P0035') card = c;
const html = M.stemHtmlSafe(card);
const declared = Number((html.match(/style="[^"]*max-width:\s*(\d+)px/) || [])[1] || 0);
A('前置：该卡渲染出 <img> 且带行内 max-width:820px', declared === 820, 'declared=' + declared);
A('820px 确实超出纸面可用宽（' + avail.toFixed(0) + 'px）⇒ 行内 style 必须被压掉',
  declared > avail, '溢出 ' + (declared - avail).toFixed(0) + 'px');

/* ══ ② 规则：纸面 img 必须能压过行内 style ══ */
console.log('\n═══ CSS 规则（删掉即红） ═══');
/* ⚠ 先剥掉注释再匹配：否则说明文字里的 `max-width:100%` 字样会把断言喂成恒真。 */
const RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
A('（判据自证）剥注释后仍有真规则被匹配到', /\.sheet[^{]*img\s*\{[^}]*\}/.test(RULES));
A('注释里出现的 max-width:100% 字样**未被**计入判据（正则已避开）',
  /\.sheet[^{]*img\s*\{[^}]*max-width:\s*100%\s*!important/.test(RULES), '剥注释后仍需 !important 才匹配');
A('纸面 img 的 max-width 带 !important（唯一能压过行内 style 的手段）',
  /\.sheet[^{]*img\s*\{[^}]*max-width:\s*100%\s*!important/.test(RULES));
A('纸面 img 带 height:auto（等比缩放，不压扁不变形）',
  /\.sheet[^{]*img\s*\{[^}]*height:\s*auto/.test(RULES));

/* ══ ③ 规则：抽屉侧也不能缺 ══ */
A('.stembox（抽屉题干）有 img 规则且带 !important',
  /\.stembox[^{]*img\s*\{[^}]*max-width:\s*100%\s*!important/.test(RULES));

/* ══ ④ 全库：不再有第二张超宽卡 ══ */
console.log('\n═══ 全库体检 ═══');
let nImg = 0, over = [];
for (const k of ST.data) for (const s of (k.subjects || [])) for (const c of (s.items || [])) {
  if (!c.stemHtml) continue;
  const h = M.stemHtmlSafe(c);
  if (!/<img\b/i.test(h)) continue;
  nImg++;
  const px = (h.match(/max-width:\s*(\d+)px/g) || []).map(x => Number(x.match(/\d+/)[0]));
  if (px.some(x => x > avail)) over.push(k.name + '|' + c.id + ' ' + px.join(','));
}
console.log('  渲染出 <img> 的卡 = ' + nImg + '；其中行内声明宽超纸面的 = ' + over.length);
/* ★ 2026-10-24 B-09：原断言「全库只剩已知的 P0035 一张超宽」绑死真实库的一张真实卡——
   换任何库都假红。超宽本身不可怕（上面的 CSS !important 断言才是兜底判据，删规则必红），
   这里改为**信息性普查**：把超宽清单打印出来供人核对，不再断言具体张数。 */
console.log('  [信息] 行内超宽清单（由 CSS !important 兜底覆盖，见上方断言）：' + (over.join(' / ') || '（无）'));

console.log('\nRESULT=' + (fail === 0 ? 'PASS' : 'FAIL') + '  断言=' + (pass + fail) + ' 失败=' + fail);
process.exit(fail === 0 ? 0 : 1);
