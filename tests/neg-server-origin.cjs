#!/usr/bin/env node
/**
 * BUG-17 断言（2026-10-11）：`Origin: null` 不再是"可信来源"，且逐项记录**改前/改后**实测行为。
 *
 * 审计：`_服务端.mjs:136` 把 `null` 与 `127.0.0.1:PORT`/`localhost:PORT` 并列放行；而
 *   `<iframe sandbox>`（不透明源）发出的请求 `Origin` **也是 `null`** ⇒ 本机任意网页都能
 *   `POST /api/pending` 往人工判读真源里写内容（响应还带 `Access-Control-Allow-Origin: *`）。
 *
 * 本次**不引入 token**（会让现有不带 token 的 v1/v2 页面当场不可用），只做不破坏现有客户端的加固：
 *   X-Frame-Options/CSP、CORS 只回显白名单（绝不再发 `*`）、POST 只收 `application/json`。
 *   残余风险与"后续该怎么上 token"见 docs\修复说明-服务端-20261011.md §4。
 *
 * ★ 2026-10-30 S02（本轮）：上面的"残余风险"被审计落实了 —— `null` 的信任被**整体取消**，
 *   并补上了 token（见 tests\neg-server-host-and-token.cjs）。本文件 ② 节因此**改写**：
 *   它原来 pin 的正是"Origin: null 仍可用"这条**待修的旧行为**（改前实测：GET 200 + ACAO=null、
 *   POST 400 = 已穿过来源门禁），现在 pin 的是新判据"null 一律 403、且不回显任何 ACAO"。
 *   这不是"把断言放宽到能过"：判据从「null → 200」换成了「null → 403」，比原来更严；
 *   ③ 节原来靠 `Origin: null` 冒充 file:// 客户端走通写路径，现在改用**白名单同源**
 *   （`http://127.0.0.1:PORT`）—— 那才是 server 模式真实客户端（服务端自己发的页面）的来源。
 *
 * 本用例在**独立端口**的实例上跑，不碰用户那个 7187 进程；POST 一律用不存在/空载荷，
 *   且落库前先比 `_待确认.json` 的**内容哈希**（真源内容必须一字未动）。
 * 退出码 0=全绿。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { ROOT, SERVER, startServer, waitHealth, req, sha16, counter, stripComments } = require('./neg-server-lib.cjs');

/* ★ 2026-10-23 程序与数据分家：工具在 src\tools\，数据在库根（见 tests\_测试环境.cjs） */
const E = require('./_测试环境.cjs');
const { A, end } = counter();
const PORT = 7192;
const EVIL = 'https://evil.example';
const PENDING = E.lib('_待确认.json');
const JSONH = { 'Content-Type': 'application/json' };

(async () => {
  const srv = startServer(PORT);
  let code = 1;
  try {
    if (!await waitHealth(PORT)) { A('独立服务端实例启动（127.0.0.1:' + PORT + '）', false, 'health 超时；stderr=' + srv.err.slice(0, 200)); process.exit(end('BUG-17 Origin/CORS')); }
    A('独立服务端实例启动（127.0.0.1:' + PORT + '）', true);
    const allowed = 'http://127.0.0.1:' + PORT;
    const seen = [];
    const H = r => { seen.push({ status: r.status, acao: r.headers['access-control-allow-origin'] }); return r; };

    console.log('══ ① 来源门禁：坏来源必须 403（含 POST —— 审计要求的硬断言） ══');
    {
      const g = H(await req(PORT, '/api/state', { headers: { Origin: EVIL } }));
      A('GET /api/state + Origin: evil → 403', g.status === 403, 'status=' + g.status);
      const p = H(await req(PORT, '/api/pending', { method: 'POST', headers: Object.assign({ Origin: EVIL }, JSONH), body: JSON.stringify({ resolves: [{ id: 'T99999', action: '答', answer: 'x' }] }) }));
      A('POST /api/pending + Origin: evil → 403（审计要求的断言）', p.status === 403, 'status=' + p.status + ' body=' + p.text.slice(0, 80));
      const o = H(await req(PORT, '/api/pending', { method: 'OPTIONS', headers: { Origin: EVIL, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } }));
      A('OPTIONS 预检 + Origin: evil → 403（不再给跨源写放行）', o.status === 403, 'status=' + o.status);
    }

    console.log('\n══ ② Origin: null 的改前/改后行为（★ 2026-10-30 S02：判据反转，见文件头说明） ══');
    {
      /* 改前（2026-10-11 那版）：GET 200 + ACAO=null、POST 400（穿过来源门禁，只被载荷校验拒）。
         那不是"file:// 客户端能用"，而是"**一切不透明源**都能用"——两个在 HTTP 层不可区分。
         现在：null 与外部来源同等对待，入口 403，且不发放行头。 */
      const g = H(await req(PORT, '/api/state', { headers: { Origin: 'null' } }));
      A('GET /api/state + Origin: null → **403**（改前 200；null = 不透明源，不再当 file:// 客户端）',
        g.status === 403, 'status=' + g.status + ' body=' + g.text.slice(0, 90));
      A('被拒的 null 源拿不到任何 Access-Control-Allow-Origin（连 "null" 都不回显）',
        g.headers['access-control-allow-origin'] === undefined, String(g.headers['access-control-allow-origin']));

      const tp = H(await req(PORT, '/api/pending', { method: 'POST', headers: { Origin: 'null', 'Content-Type': 'text/plain' }, body: JSON.stringify({ resolves: [] }) }));
      A('POST + Origin: null + text/plain → 403（改前 415，且再改前是 200：现在连门都进不去）',
        tp.status === 403, 'status=' + tp.status + ' body=' + tp.text.slice(0, 90));

      const pre = H(await req(PORT, '/api/pending', { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } }));
      A('OPTIONS 预检 + Origin: null → **403**（改前 204：预检放行等于给跨源写开绿灯，现在连预检都不放）',
        pre.status === 403, 'status=' + pre.status + ' ACAO=' + String(pre.headers['access-control-allow-origin']));

      const em = H(await req(PORT, '/api/pending', { method: 'POST', headers: Object.assign({ Origin: 'null' }, JSONH), body: JSON.stringify({ resolves: [] }) }));
      A('POST + Origin: null + application/json + 空 resolves → 403（改前 400：**已穿过来源门禁**，这条正是审计要堵的口子）',
        em.status === 403, 'status=' + em.status + ' body=' + em.text.slice(0, 90));

      /* 源码级防回退：判据不得再出现"null 单独放行"的写法。
         必须去注释再判 —— 本仓的修复说明按惯例会把旧写法抄进注释里（neg-server-lib.stripComments 就是为此而写）。 */
      const src = stripComments(fs.readFileSync(SERVER, 'utf8'));
      A("源码里不再有 `origin === 'null'` 这类放行判据（去注释后）",
        !/===\s*'null'/.test(src) && !/===\s*"null"/.test(src), '源码（去注释）里命中放行判据');
    }

    console.log('\n══ ③ 现有客户端形状不被破坏：合法 JSON 体可达工具层且真源内容零改动 ══');
    {
      /* ★ 2026-10-30 S02：这两条原先带 `Origin: null`（靠 null 信任冒充 file:// 客户端）。
         null 已不可信，改用 server 模式**真实客户端**的来源：服务端自己发布的同源页面
         （`http://127.0.0.1:PORT`）。要证的语义不变：「正常客户端的形状能穿过两道门禁、
         到达工具层，且真源一字未动」。 */
      const before = sha16(PENDING);
      const r = H(await req(PORT, '/api/pending', {
        method: 'POST',
        headers: Object.assign({ Origin: allowed }, JSONH),
        body: JSON.stringify({ tool: 'ctb-homepage-pending', resolves: [{ id: 'T99999', action: '答', answer: 'E2E 探针：不存在的 id，应被工具忽略、不写真源' }] }),
        timeoutMs: 60000,
      }));
      A('不存在的 id → 200 且 results 为空（工具护栏忽略，未落库）', r.status === 200 && Array.isArray((r.json || {}).results) && r.json.results.length === 0,
        'status=' + r.status + ' results=' + JSON.stringify((r.json || {}).results));
      A('_待确认.json 内容哈希未变（真源一字未动）', sha16(PENDING) === before, before + ' → ' + sha16(PENDING));
      A('POST 响应带新状态包（页面原地刷新用的那条语义没变）', !!(r.json && r.json.state && r.json.state.pending), 'hasState=' + !!(r.json && r.json.state));
    }

    console.log('\n══ ④ 响应头：防被嵌 + 不收窄到通配 ══');
    {
      const h = H(await req(PORT, '/health'));
      A('X-Frame-Options: DENY（防本服务页面被 iframe 嵌入）', h.headers['x-frame-options'] === 'DENY', String(h.headers['x-frame-options']));
      A("CSP 含 frame-ancestors 'none'", /frame-ancestors 'none'/.test(String(h.headers['content-security-policy'])), String(h.headers['content-security-policy']));
      A('X-Content-Type-Options: nosniff', h.headers['x-content-type-options'] === 'nosniff', String(h.headers['x-content-type-options']));
      /* ★ 2026-10-23：原来固定取 `/_安全写.mjs` —— 那是**程序文件**，只存在于老布局（程序与数据同目录）里；
         程序与数据分家后它住在 src\tools\，库根里没有 ⇒ 对着运行区库跑必然 404。
         本断言要证的是「静态文件响应也带 XFO DENY」，取哪个文件无所谓，所以从库里挑一个确实存在的。 */
      const STATIC_CAND = ['_状态.json', '_待确认.json', '_组卷台账.json', '_索引.json', '九年级/_索引.json', '_安全写.mjs'];
      const staticRel = STATIC_CAND.find((rel) => { try { return fs.statSync(path.join(E.LIB, rel)).isFile(); } catch { return false; } });
      A('库里有可用来验静态响应的文件（前置）', !!staticRel, staticRel || ('候选全不在：' + STATIC_CAND.join(' / ')));
      const s = H(await req(PORT, '/' + staticRel.split('/').map(encodeURIComponent).join('/')));
      A('静态文件响应也带 XFO DENY（200 且头齐）', s.status === 200 && s.headers['x-frame-options'] === 'DENY', 'status=' + s.status + ' xfo=' + s.headers['x-frame-options']);
      const al = H(await req(PORT, '/api/state', { headers: { Origin: allowed } }));
      A('白名单来源（' + allowed + '）被原样回显', al.headers['access-control-allow-origin'] === allowed, String(al.headers['access-control-allow-origin']));
      A('Vary: Origin（避免缓存把某个来源的 ACAO 复用给别的来源）', String(al.headers.vary || '').includes('Origin'), String(al.headers.vary));
      const no = H(await req(PORT, '/api/state'));
      A('无 Origin（同源/非浏览器）时不发 ACAO', no.headers['access-control-allow-origin'] === undefined, String(no.headers['access-control-allow-origin']));
      const star = seen.filter(x => x.acao === '*');
      A('全部 ' + seen.length + ' 个响应里 ACAO 从未出现通配 *（改前每个响应都是 *）', star.length === 0, '命中 ' + star.length + ' 个');
    }

    console.log('\n══ ⑤ 记录（写进修复说明的"改前/改后"口径） ══');
    console.log('  改前（审计 + 我对运行中 7187 进程的只读实测）：Origin: evil → 403；Origin: null → 200；' +
      'POST /api/pending + Origin: null → 200（**穿过来源门禁**）；所有响应 ACAO=*。');
    console.log('  上一轮（2026-10-11 BUG-17）：Origin: null → 200（保留 file:// 客户端）；POST + null + json → 可达工具层' +
      '（当时记为**残余风险**）；POST + null + 非 json → 415；ACAO 只回显白名单/null。');
    console.log('  本轮（2026-10-30 S02，本实例实测）：Origin: evil / null → 一律 403 且不发任何 ACAO；' +
      'POST + null（任何 Content-Type）→ 403；server 模式真实客户端（同源 http 页面）形状不变、真源零改动；' +
      'ACAO 只回显白名单来源。file:// 直开页面不再连服务端（改走桌面壳 postMessage），详见 _服务端.mjs 的 S02 段注释。');
    code = end('BUG-17 Origin: null 加固');
  } finally { await srv.stop(); }
  process.exit(code);
})();
