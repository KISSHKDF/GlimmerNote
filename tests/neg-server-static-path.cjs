#!/usr/bin/env node
/**
 * BUG-18 断言（2026-10-11）：静态文件服务的包含性判断必须带**分隔符**——同前缀兄弟目录的请求必须 403。
 *
 * 审计：`_服务端.mjs:117-118`
 *   const abs = path.normalize(path.join(ROOT, rel));
 *   if (!abs.startsWith(ROOT)) return 403;      // ROOT 无结尾分隔符
 * ⇒ 任何形如 `<库根><其它>` 的**同前缀兄弟目录**（如 `<库根>-备份`、`<库根>.bak`）
 *   都能通过判据，库外文件可被读取。改前实测：`GET /..%2f错题本-ntest%2fsecret.txt` → **404**
 *   （不是 403 —— 说明判据已放行到 `fs.readFile`，只是那个目录当前不存在）。
 *
 * 断言分三层：
 *   ① 纯路径自证：**裸 StartsWith（旧判据）确实会放行**兄弟目录，而带分隔符的新判据拒绝它
 *      （证明这条断言有牙齿，不是恒真；同 `tests\neg-shell-path.cjs` 对 C# 侧的做法）；
 *   ② 端到端（独立端口实例）：`..%2f` 编码穿越到兄弟目录 → 403；多级逃逸 → 403；
 *   ③ 不过度拦截：根内文件、根内子目录、默认首页（`/`）、URL 编码中文路径都必须照常 200。
 *      ★ 2026-11-02 R2：这一段只换样本、不改意图 —— 库内静态路由多了一层**业务白名单**
 *      （`_服务端.mjs::staticAllowed`）：`.`/`_` 开头的目录与内部台账一律 403，
 *      只放行 `_原图`/`_收件箱` 两条取图目录 + `_组卷台账.json` 一个根台账。
 *      所以本段"必须 200"的样本改用 R2 放行的文件，`_索引.json` 这类内部件改成**必须 403**；
 *      包含性判据本身的断言（① 纯路径自证、② 越界/同前缀兄弟目录 403）一字未动。
 *      ★ 2026-11-06：三处写死的 `九年级` 改成 `pickStudent()` **现挑**。那个目录名本身就是本轮修的缺陷
 *      （目录名 ≠ `student` 字段）——写死它的代价是库一改名，"预期 403"变成 404，红的是测试自己的假设。
 *
 * 只发 GET，不写任何文件（也不需要在盘上真的造一个兄弟目录：判据在 `fs.readFile` **之前**，
 *   所以"403 而不是 404"本身就是判据生效的证据）。
 * 退出码 0=全绿。
 */
'use strict';
const path = require('path');
const { ROOT, startServer, waitHealth, req, counter } = require('./neg-server-lib.cjs');

const { A, end } = counter();
const PORT = 7193;
const WIN = path.win32;
const SIBLING = path.join(path.dirname(ROOT), path.basename(ROOT) + '-ntest');   // 库根的同前缀兄弟目录

const fs = require('fs');
const E = require('./_测试环境.cjs');
/** 从当前库里**现挑一个学生目录**（其下直接有 `_索引.json`；旧形态则看 `<学生>\<学科>\_索引.json`）。
 *  ★ 2026-11-06：原先三处写死了 `九年级`。那个目录名本身就是本轮修的缺陷（目录名 ≠ `student` 字段）；
 *    写死真库目录名的代价是——库一改名，「预期 403」就变成 404，红的是**测试自己的假设**，
 *    而不是被检代码（实测就是这么红的）。口径同 `tests\_测试环境.cjs::findIndexes`：不写死真实学生目录名（B-09）。 */
const pickStudent = () => {
  const LIB = require('./_测试环境.cjs').LIB;
  let fallback = null, tops;
  try { tops = fs.readdirSync(LIB, { withFileTypes: true }); } catch { return null; }
  for (const n of tops) {
    if (!n.isDirectory() || /^[_.]/.test(n.name)) continue;
    if (fs.existsSync(path.join(LIB, n.name, '_索引.json'))) return n.name;
    let subs; try { subs = fs.readdirSync(path.join(LIB, n.name), { withFileTypes: true }); } catch { continue; }
    for (const s of subs) {
      if (s.isDirectory() && fs.existsSync(path.join(LIB, n.name, s.name, '_索引.json'))) { fallback = fallback || n.name; }
    }
  }
  return fallback;
};
const STUDENT = pickStudent();

/* 判据同构版：旧（裸 StartsWith）vs 新（带尾分隔符 + 大小写不敏感） */
const oldJudge = abs => abs.startsWith(ROOT);
const newJudge = abs => {
  const base = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
  const a = path.normalize(abs).toLowerCase();
  return a === path.normalize(ROOT).toLowerCase() || a.startsWith(base.toLowerCase());
};
const asJoined = rel => path.normalize(path.join(ROOT, rel));   // 服务端等价：Path.Combine + GetFullPath

(async () => {
  console.log('══ ① 纯路径自证：旧判据放行、新判据拒绝 ══');
  {
    const rel = '/../' + path.basename(SIBLING) + '/secret.txt';
    const abs = asJoined(rel);
    A('穿越后归一化结果落在**库根之外**的同前缀兄弟目录', abs === path.join(SIBLING, 'secret.txt'), abs);
    A('自证：裸 startsWith(ROOT) 会**放行**它（本断言的牙齿）', oldJudge(abs) === true, '旧判据=' + oldJudge(abs));
    A('新判据（ROOT + sep）拒绝它', newJudge(abs) === false, '新判据=' + newJudge(abs));
    /* 根内样本：学生目录（现挑）优先；空库时退回根台账 `_组卷台账.json`（R2 放行的根内文件）。 */
    const innerRel = STUDENT ? '/' + STUDENT + '/_索引.json' : '/_组卷台账.json';
    A('根内路径两者都放行（新判据没把正常路径也拒掉）', oldJudge(asJoined(innerRel)) === true && newJudge(asJoined(innerRel)) === true, innerRel);
    A('恰好等于 ROOT 本身仍算根内', newJudge(ROOT) === true);
    A('同前缀但多一层（错题本-X\\…）被拒', newJudge(asJoined('/../' + path.basename(ROOT) + '-X/a.txt')) === false);
    A('大小写不同的根内路径放行（Windows 文件系统不区分大小写）', newJudge(ROOT.toUpperCase() + path.sep + 'a.txt') === true);
  }

  console.log('\n══ ② 端到端：同前缀兄弟目录 / 越界请求必须 403 ══');
  const srv = startServer(PORT);
  let code = 1;
  try {
    if (!await waitHealth(PORT)) { A('独立服务端实例启动（127.0.0.1:' + PORT + '）', false, 'health 超时；stderr=' + srv.err.slice(0, 200)); process.exit(end('BUG-18 包含性判据')); }
    A('独立服务端实例启动（127.0.0.1:' + PORT + '）', true);

    const siblingNames = [path.basename(ROOT) + '-ntest', path.basename(ROOT) + '-备份', path.basename(ROOT) + '.bak'];
    for (const name of siblingNames) {
      const p = '/..%2f' + encodeURIComponent(name) + '%2fsecret.txt';
      const r = await req(PORT, p, { rawPath: true });
      A('GET ' + p + ' → 403（同前缀兄弟目录）', r.status === 403, 'status=' + r.status + ' body=' + r.text.slice(0, 70));
    }
    {
      const cases = [
        ['/..%2f..%2fpackage.json', 403, '越到 MY\\ 下的文件'],
        ['/%2e%2e%2f%2e%2e%2fpackage.json', 403, '全编码形态的多级逃逸'],
        ['/..%2f..%2f..%2f..%2fWindows%2fwin.ini', 403, '逃到系统盘'],
      ];
      for (const [p, want, why] of cases) {
        const r = await req(PORT, p, { rawPath: true });
        A('GET ' + p + ' → ' + want + '（' + why + '）', r.status === want, 'status=' + r.status);
      }
      /* 审计里那条对照请求：`/错题本..%2f..%2fpackage.json` 解码后是 `/错题本../..package.json`
         —— 段 `错题本..` 被后面的 `..` 吃掉，**归一化后落回根内**（`…\错题本\package.json`），
         既不是穿越也没有该文件 ⇒ 正确的答案是 404（根内缺文件），**不是** 403。
         这里显式记下这个口径，避免后人把它当"漏判"再修一次。 */
      const back = await req(PORT, '/%E9%94%99%E9%A2%98%E6%9C%AC..%2f..%2fpackage.json', { rawPath: true });
      A('审计对照请求 /错题本..%2f..%2fpackage.json → 404（归一化后落回根内，非穿越）', back.status === 404, 'status=' + back.status);
      A('对照请求的 404 体里 rel 仍是根内相对形态（证明它没被判成越界）', /not found: \/错题本\.\./.test(back.text), back.text.slice(0, 90));
    }

    console.log('\n══ ③ 不过度拦截：根内资源照旧 200 ══');
    {
      /* ★ 2026-10-23：原先写死了 `_安全写.mjs`、`docs/修复说明-…md`、`首页.html` —— 这三个都是
         **程序/构建产物**，只存在于老布局（程序与数据同目录）。程序与数据分家后：
           · _安全写.mjs 住在 src\tools\，库根里没有；
           · docs\ 是开发文档，发布包里没有；
           · 首页.html 是 v1 构建产物，v3 起界面运行时取数、不再生成它。
         对着运行区库（纯数据）跑就必然 404 —— 那是"测试假设错"，不是"过度拦截"。
         本段要证的语义是「包含性判据不能把**根内真实存在**的路径也拦掉」，所以从当前库里现挑文件；
         挑不到的用例显式 SKIP（跳过必须可见），不假装通过。 */
      const exists = (rel) => { try { return fs.statSync(path.join(E.LIB, rel)).isFile(); } catch { return false; } };

      /* ① 下划线开头的根内文件：从库里现挑一个。
         ★ 2026-11-02 R2：候选顺序**必须**把 `_组卷台账.json` 排最前 —— 库内静态白名单
         （`_服务端.mjs::staticAllowed`）只放行这一个根台账，`_状态.json`/`_待确认.json`/`_索引.json`
         现在一律 403，拿它们当"必须 200"的样本会让本段恒红。 */
      const underFile = ['_组卷台账.json', '_状态.json', '_待确认.json', '_索引.json', '_安全写.mjs']
        .find(exists);
      /* ② 中文文件名 + 连字符：在库里找一个文件名同时含中文与 '-' 的。
         ★ 2026-11-02 R2：必须排除 `_` 开头与含 `.bak` 的名字 —— 否则这里会挑中
         `_原卷台账.json.bak-41-63-20261026052853`（本轮实测就是它），而它正是 R2 第 ④ 道
         判据（文件名含 `.bak`）要杀的形态，必然 403。本段要证的是"包含性判据不误伤中文长文件名"。 */
      const zhDash = (() => {
        let hit = null;
        const walk = (d, rel, depth) => {
          if (hit || depth < 0) return;
          let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
          for (const e of ents) {
            if (hit) return;
            const r = rel ? rel + '/' + e.name : e.name;
            if (e.isDirectory()) { if (!/^(_|\.)/.test(e.name)) walk(path.join(d, e.name), r, depth - 1); continue; }
            if (/[\u4e00-\u9fa5]/.test(e.name) && e.name.includes('-') &&
              !/^[_.]/.test(e.name) && !e.name.includes('.bak')) hit = r;
          }
        };
        walk(E.LIB, '', 2);
        return hit;
      })();

      const inside = [];
      if (underFile) inside.push(['/' + encodeURIComponent(underFile), 200, '根内下划线开头的文件（R2 放行的根台账）']);
      else console.log('  [SKIP] 根内下划线开头的文件 —— 库里一个都没有');
      if (STUDENT) {
        inside.push(['/' + STUDENT + '/_索引.json', 403, '根内下划线台账：R2 第 ③ 道判据明令 403（内部件不下发）']);
        inside.push(['/' + STUDENT + '/' + encodeURIComponent('_索引.json'), 403, '中文目录段 + 下划线台账（同上）']);
      } else {
        console.log('  [SKIP] 学生目录里的下划线台账 403 —— 库里没有学生目录（空库）；跳过必须可见，不假装通过');
      }
      if (zhDash) inside.push(['/' + zhDash.split('/').map(encodeURIComponent).join('/'), 200, '根内中文文件名 + 连字符']);
      else console.log('  [SKIP] 根内中文文件名 + 连字符 —— 库里找不到这类文件');
      /* ★ 2026-11-13 修（本会话解封门禁后暴露）：本段 ①② 已在 2026-10-23 / 2026-11-02 两次整改中更新，
         **③ 这一条漏了** —— 它仍按 R8 **之前**的期望要求 `首页.html` 必须 200，
         而 R8 整改③（`_服务端.mjs::staticAllowed`）明令"`.html`（题干/说明）一律 403"
         （配套用例 `neg-server-static-whitelist.cjs`）。真库里有 `首页.html` ⇒ 本段**必然红**
         （实测：`GET /%E9%A6%96%E9%A1%B5.html` → 403）。现在按现行设计改成**负对照**：
         根内 `.html` 必须 403 —— 这既钉住了"R8 的类型准入没被放松"，
         也把"包含性判据不误伤根内路径"的举证责任交回给①②（它们才是干这个的）。
         ⚠ 顺带记一笔产品面：R8 收紧后"用手机浏览器打开库根 `首页.html`"这条路**已不通**；
         手机侧要看的是**导出的报告/试卷**（这正是家长报告那条链的存在理由）。 */
      if (exists('首页.html')) inside.push(['/' + encodeURIComponent('首页.html'), 403, '根内 .html：R8 类型准入明令 403（题干/说明不下发）']);
      else console.log('  [SKIP] 首页.html —— v3 起界面运行时取数，库里不再有它（发布包/运行区常态）');

      for (const [p, want, why] of inside) {
        const r = await req(PORT, p);
        A('GET ' + p + ' → ' + want + '（' + why + '）', r.status === want, 'status=' + r.status);
      }
      const home = await req(PORT, '/');
      A('GET / → 200 且是 HTML（默认首页仍能取到）', home.status === 200 && /text\/html/.test(String(home.headers['content-type'])), 'status=' + home.status + ' type=' + home.headers['content-type']);
      const bad = await req(PORT, '/..%2f..%2fpackage.json%00.png', { rawPath: true });
      A('带 NUL 的构造路径被拒（400/403，不进 fs）', bad.status === 400 || bad.status === 403, 'status=' + bad.status);
    }
    code = end('BUG-18 静态文件包含性判据');
  } finally { await srv.stop(); }
  process.exit(code);
})();
