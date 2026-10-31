#!/usr/bin/env node
/**
 * neg-paper-reject-sync.cjs —— 组卷"剔除被门禁拦下的题"必须同步卷面题源（2026-10-31 建，
 * 外部 codex 审查 D03 的护栏）
 *
 * 缺陷（修前实测）：
 *   卷面 E0001、E0002；工具拒绝 E0001；用户点「剔除并继续」⇒
 *   ① 只有 `groups[curKey]` 被过滤 ⇒ 提交给工具的只剩 E0002（这条是对的）；
 *   ② 但预览/打印/答案册都读 `sheet.refs`（renderSheets）⇒ **纸面仍印着被拦的 E0001**；
 *   ③ 清篮用的是 `new Set(sheet.refs…)` ⇒ **没入账的 E0001 也被从篮子里摘掉**，
 *      用户以为印过了，实际台账里没有、篮子也没了（静默少题）；
 *   ④ 纸面第 2 题（E0002）在台账里成了第 1 题 ⇒ 家长按卷面题号回录必然对错位置。
 *
 * 判据（三条主判据 + 一条正向 + 阴性自证）：
 *   ① 剔除后 `sheet.refs` 里不得再有被拒的卡；
 *   ② `renderSheets()`（= 打印/预览/答案册的唯一渲染源）里不得再出现被拒卡号；
 *   ③ 篮子只摘"真正入账的那些题"，被拒的题必须留在篮子里；
 *   ④ 正向：入账成功的题仍从篮子里摘掉（不能为修 ③ 把清篮整个废掉）；
 *   ⑤ 阴性自证：把"同步 sheet.refs"这段摘掉 ⇒ ①② 必须变红。
 *
 * 用法：node tests\neg-paper-reject-sync.cjs
 * 退出码：0=PASS / 1=FAIL
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
let worst = 0, passed = 0;
function A(name, ok, detail) {
  if (ok) { passed++; console.log('[OK]   ' + name + (detail ? '  → ' + String(detail).slice(0, 220) : '')); }
  else { worst++; console.log('[FAIL] ' + name + (detail ? '  → ' + String(detail).slice(0, 220) : '')); }
}
const read = f => fs.readFileSync(path.join(ROOT, 'src', 'app', 'js', f), 'utf8');

/** 载入真实前端 + 真实 paper.js（只在**内存**里给它补两个测试口，不改文件） */
function makeEnv(overrides) {
  const ov = overrides || {};
  const CTB = {};
  const store = {};
  const ctx = {
    CTB, console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Promise,
    localStorage: {
      getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; },
    },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
  };
  ctx.addEventListener = () => { };
  ctx.removeEventListener = () => { };
  ctx.window = ctx; ctx.globalThis = ctx; ctx.window.CTB = CTB;
  const el = { innerHTML: '', querySelectorAll: () => [], querySelector: () => null };
  ctx.document = {
    addEventListener() { }, removeEventListener() { },
    documentElement: {}, body: {},
    createElement: () => ({ style: {}, addEventListener() { }, appendChild() { } }),
    getElementById: () => el,
  };
  vm.createContext(ctx);
  const load = (f, src) => vm.runInContext(src || read(f), ctx, { filename: f });
  for (const f of ['util.js', 'host.js', 'model.js', 'shell.js']) load(f);

  /* paper.js 里 `sheet`/`commitPaper`/`renderSheets` 都是模块私有的：
     只在内存源码末尾补三个测试口（文件本身不动），见文件头说明。 */
  const patch = src => src.replace(/\}\)\(\);\s*$/,
    '  CTB.views.paper.__setSheet = s => { sheet = s; };\n'
    + '  CTB.views.paper.__getSheet = () => sheet;\n'
    + '  CTB.views.paper.__commit = commitPaper;\n'
    + '  CTB.views.paper.__renderSheets = renderSheets;\n'
    + '})();\n');
  const paperSrc = ov['views/paper.js'] || read('views/paper.js');
  const patched = patch(paperSrc);
  CTB.views = CTB.views || {};
  load('views/paper.js', srcOr(ov['views/paper.js+patched'], patched));

  const { util: U, host: H, model: M, shell: S, views: V } = CTB;
  const calls = [];
  H.readFile = async () => ({ text: JSON.stringify({ batches: [] }) });
  H.mark = async (op, a) => {
    calls.push({ op, ids: a.ids });
    /* 第一次调用：工具门禁拒绝 E0001；第二次（剔除后）：成功 */
    if (a.ids.includes('E0001')) return { code: 1, err: 'Error: 作答契约门禁 E0001：题干有 1 个空但没有逐空答案' };
    return { code: 0, out: '✔ 已组卷 P20261031-01' };
  };
  S.confirm = async () => true;
  S.toast = () => { };
  S.render = () => { };
  U.$id = () => null;
  /* 篮子用内存实现（不碰浏览器 localStorage 的真实键名，避免污染） */
  let basket = [];
  M.basket = () => basket.slice();
  M.basketSet = list => { basket = list.slice(); };
  M.canGroup = () => true;
  M.state = { papers: [] };
  return { CTB, U, H, M, S, V, calls, el, setBasket: l => { basket = l.slice(); }, basket: () => basket.slice() };
}
const srcOr = (a, b) => a || b;

function refs(ids) {
  return ids.map(id => ({ kid: '测试生', subject: '数学', card: { id, question: id + ' 的题干', kpoints: [] } }));
}

(async () => {
  const ALL = ['E0001', 'E0002'];

  /* 基线：一题都不拦时，两题都入账、篮子清空 */
  {
    const env = makeEnv();
    env.setBasket(['测试生|E0001', '测试生|E0002']);
    env.H.mark = async (op, a) => { env.calls.push({ op, ids: a.ids }); return { code: 0, out: '✔ P20261031-09' }; };
    env.V.paper.__setSheet({ title: '测试卷', ans: true, form: {}, refs: refs(ALL) });
    await env.V.paper.__commit();
    A('正向基线 · 两题都入账时篮子被清空', env.basket().length === 0, '剩余 ' + JSON.stringify(env.basket()));
    A('正向基线 · 卷面仍含两题', /E0001/.test(env.V.paper.__renderSheets()) && /E0002/.test(env.V.paper.__renderSheets()), '');
  }

  /* 主判据：E0001 被拦 ⇒ 剔除并继续 */
  console.log('\n== 主判据：门禁拦下 E0001，用户选「剔除并继续」==');
  const env = makeEnv();
  env.setBasket(['测试生|E0001', '测试生|E0002']);
  env.V.paper.__setSheet({ title: '测试卷', ans: true, form: {}, refs: refs(ALL) });
  await env.V.paper.__commit();
  const sheetAfter = env.V.paper.__getSheet();
  const refIds = sheetAfter.refs.map(x => x.card.id);
  const rendered = env.V.paper.__renderSheets();
  console.log('  工具调用：' + JSON.stringify(env.calls));
  console.log('  剔除后 sheet.refs = ' + JSON.stringify(refIds));
  A('工具确实收到了两次调用（先全量、再剔除后重试）', env.calls.length === 2, JSON.stringify(env.calls.map(c => c.ids)));
  A('★ ③/① 被拒的 E0001 已从 sheet.refs 摘掉', !refIds.includes('E0001'), JSON.stringify(refIds));
  A('★ ② 打印/预览/答案册不再出现被拒卡号（纸面与台账同一份题序）',
    !/E0001/.test(rendered), (/E0001/.test(rendered) ? '渲染里仍有 E0001' : '干净'));
  A('★ ② 卷面仍保留入账成功的 E0002', /E0002/.test(rendered), '');
  A('★ ④ 篮子只摘真正入账的题：E0002 已摘、被拒的 E0001 仍在篮子里',
    JSON.stringify(env.basket()) === JSON.stringify(['测试生|E0001']), '篮子=' + JSON.stringify(env.basket()));

  /* 阴性自证：把"同步 sheet.refs"这段摘掉 ⇒ ①② 必须变红 */
  console.log('\n== 阴性自证：摘掉"同步 sheet.refs" ==');
  const src = read('views/paper.js');
  /* 掏法：把"按 kid|卡号 过滤 sheet.refs"这一句换回"什么都不做"（= 旧行为）。
     ⚠ 不要用整段多行正则匹配：实现里的注释/键口径改一次就匹配不上，
       于是"掏不动"被静默当成通过（第一版就这么失灵的）。这里用**单句**替换 + 失败即红。 */
  const needle = '          sheet.refs = sheet.refs.filter(x => !dropKeys.has(x.kid + \'|\' + x.card.id));';
  const broken = src.includes(needle) ? src.replace(needle, '          /* [阴性自证] 故意不同步 sheet.refs */') : src;
  A('阴性自证 · 判据能被"摘掉同步"打红（掏得动）', broken !== src,
    broken === src ? '替换点没匹配到 —— 用例与实现脱钩，必须修用例' : '已构造坏版本');
  if (broken !== src) {
    const bad = makeEnv({ 'views/paper.js': broken });
    bad.setBasket(['测试生|E0001', '测试生|E0002']);
    bad.V.paper.__setSheet({ title: '测试卷', ans: true, form: {}, refs: refs(ALL) });
    await bad.V.paper.__commit();
    const badRefIds = bad.V.paper.__getSheet().refs.map(x => x.card.id);
    const badRendered = bad.V.paper.__renderSheets();
    A('阴性自证 · 坏版本下 sheet.refs 仍含被拒题（= 主判据①会红）',
      badRefIds.includes('E0001'), JSON.stringify(badRefIds));
    A('阴性自证 · 坏版本下打印卷仍印着被拒题（= 主判据②会红）',
      /E0001/.test(badRendered), /E0001/.test(badRendered) ? '渲染里出现 E0001（复现成功）' : '没复现出来');
  }

  /* 新判据（external 复核抓出的第二版回归）：**跨学科**时"本轮早先成功的那一组"也要从篮子摘掉。
     场景：数学组先成功 → 物理组被门禁拦 → 用户剔除后重试只提交物理。
     按"剩余 groups"算清篮时 groups 里已无数学 ⇒ 数学那批题留在篮子里 ⇒ 下次又被抽出来再印一遍。 */
  console.log('\n== 跨学科：早成功的组也要从篮子摘掉 ==');
  {
    const env = makeEnv();
    env.setBasket(['测试生|E0001', '测试生|E0002', '测试生|P0001']);
    /* 数学组成功；物理组先被拦，重试成功 */
    let call = 0;
    env.H.mark = async (op, a) => {
      call++;
      env.calls.push({ op, ids: a.ids, subject: a.subject });
      if (a.subject === '数学') return { code: 0, out: '✔ P20261031-11' };
      if (call === 2) return { code: 1, err: 'Error: 作答契约门禁 E0002：答案不全' };
      return { code: 0, out: '✔ P20261031-12' };
    };
    env.V.paper.__setSheet({
      title: '跨学科卷', ans: true, form: {},
      refs: [
        { kid: '测试生', subject: '数学', card: { id: 'E0001', question: 'q', kpoints: [] } },
        { kid: '测试生', subject: '物理', card: { id: 'E0002', question: 'q', kpoints: [] } },
        { kid: '测试生', subject: '物理', card: { id: 'P0001', question: 'q', kpoints: [] } },
      ],
    });
    await env.V.paper.__commit();
    const left = env.basket();
    console.log('  篮子剩余 = ' + JSON.stringify(left) + '；工具调用 = ' + JSON.stringify(env.calls.map(c => c.subject + ':' + c.ids)));
    A('★ 数学组（早成功）的题已从篮子摘掉', !left.includes('测试生|E0001'), JSON.stringify(left));
    A('★ 物理组（重试成功）的题也已摘掉', !left.includes('测试生|P0001'), JSON.stringify(left));
    A('★ 被门禁拒掉的那题仍留在篮子（它没入账）', left.includes('测试生|E0002'), JSON.stringify(left));
    A('★ 剔除重试没有对已成功组重复组卷（序列里数学只出现一次）',
      env.calls.filter(c => c.subject === '数学').length === 1,
      JSON.stringify(env.calls.map(c => c.subject)));
  }

  /* 阴性自证：把"累积集合"退回成"剩余 groups"⇒ 上一条必须变红 */
  console.log('\n== 阴性自证：把清篮退回成"剩余 groups" ==');
  {
    const srcPaper = read('views/paper.js');
    const broken = srcPaper.replace('        const doneKeys = committedKeys;',
      '        const doneKeys = new Set(Object.values(groups).flat().map(x => x.kid + \'|\' + x.card.id));');
    A('阴性自证 · 判据能被退回旧写法打红（掏得动）', broken !== srcPaper,
      broken === srcPaper ? '替换点没匹配到 —— 用例与实现脱钩，必须修用例' : '已构造坏版本');
    if (broken !== srcPaper) {
      const env = makeEnv({ 'views/paper.js': broken });
      env.setBasket(['测试生|E0001', '测试生|E0002', '测试生|P0001']);
      let call = 0;
      env.H.mark = async (op, a) => {
        call++;
        if (a.subject === '数学') return { code: 0, out: '✔ P20261031-11' };
        if (call === 2) return { code: 1, err: 'Error: 作答契约门禁 E0002：答案不全' };
        return { code: 0, out: '✔ P20261031-12' };
      };
      env.V.paper.__setSheet({
        title: '跨学科卷', ans: true, form: {},
        refs: [
          { kid: '测试生', subject: '数学', card: { id: 'E0001', question: 'q', kpoints: [] } },
          { kid: '测试生', subject: '物理', card: { id: 'E0002', question: 'q', kpoints: [] } },
          { kid: '测试生', subject: '物理', card: { id: 'P0001', question: 'q', kpoints: [] } },
        ],
      });
      await env.V.paper.__commit();
      A('阴性自证 · 坏版本下已入账的数学题留在篮子里（= 主判据会红）',
        env.basket().includes('测试生|E0001'), '篮子=' + JSON.stringify(env.basket()));
    }
  }

  console.log('\n──────────────────────────────');
  console.log(worst === 0 ? 'RESULT=PASS 断言=' + passed : 'RESULT=FAIL 断言=' + passed + ' 失败=' + worst);
  process.exit(worst === 0 ? 0 : 1);
})().catch(e => { console.error('✖ 用例自身异常：' + (e && e.stack || e)); process.exit(1); });
