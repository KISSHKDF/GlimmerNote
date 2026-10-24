/* 错题本 2.0 · 应用外壳：侧栏 + 顶栏 + 路由 + 抽屉 + 命令面板 + 灯箱 + Toast + 状态条 */
(function () {
  const S = CTB.shell = {};
  const U = CTB.util, H = CTB.host, M = CTB.model;
  CTB.views = CTB.views || {};

  const ROUTES = [
    { id: 'dash', ic: '🏠', name: '今日总览' },
    { id: 'review', ic: '🔁', name: '复习流', badge: () => dueCount() },
    { id: 'bank', ic: '📚', name: '题库浏览' },
    /* ⚠ 2026-10-12：badge 走 `M.basketCount()`（配卷屏同口径），此前用 `basket().length`
       数 localStorage 键数，与配卷屏的「能配成卷的题数」分叉（同屏 5 vs 0）。 */
    { id: 'paper', ic: '🧾', name: '组卷工作台', badge: () => M.basketCount(), gray: true },
    { id: 'pending', ic: '📋', name: '待办工作台', badge: () => M.pendingOpen().length },
    { id: 'stats', ic: '📊', name: '统计分析' },
  ];
  let route = 'dash', routeParam = null;
  S.currentRoute = () => route;
  S.routeParam = () => routeParam;
  S.route = function (id, param) {
    if (id.startsWith('#')) id = id.slice(1);
    if (!CTB.views[id]) id = 'dash';
    route = id; routeParam = param || null;
    if (location.hash.slice(1) !== id) { history.replaceState(null, '', '#' + id); }
    S.render();
  };

  function dueCount() {
    let n = 0; for (const x of M.cardsOf()) { const d = M.dueInfo(x.card); if (d.code === 'due') n++; } return n;
  }

  /* ================= 顶栏 ================= */
  function topbar() {
    const r = ROUTES.find(x => x.id === route);
    const seg = ['全部'].concat(M.students());
    const cur = M.student();
    return '<div class="tb-title">' + (r ? r.ic + ' ' + r.name : '拾光小册') + '</div>' +
      '<div class="tb-sub" id="tbSub"></div>' +
      '<div class="tb-sp"></div>' +
      '<div class="seg" id="stuSeg">' + seg.map(s => '<button data-s="' + U.esc(s) + '"' + (s === cur ? ' class="on"' : '') + '>' + U.esc(s) + '</button>').join('') +
      /* ★ 2026-10-23（BUG#1）：学生分段右侧常驻一个「＋」——空库时它是唯一入口，
         有学生时它是"再加一个孩子"的入口（家长两个孩子很常见）。 */
      '<button class="iconbtn" id="btnNewStu" title="新建学生">＋</button></div>' +
      '<div class="search" id="btnPalette"><span>🔍</span><span style="font-size:13px">搜题 / 命令…</span><kbd>Ctrl</kbd><kbd>K</kbd></div>' +
      '<button class="iconbtn" id="btnTheme" title="切换深浅主题">◐</button>' +
      '<button class="iconbtn" id="btnRefresh" title="重刷数据（从磁盘重读，不动文件）">⟳</button>' +
      '<button class="iconbtn" id="btnHelp" title="帮助与快捷键（?）">?</button>';
  }
  function bindTopbar() {
    document.querySelectorAll('#stuSeg button').forEach(b => b.onclick = () => { M.student(b.dataset.s); S.render(); });
    const ns = U.$id('btnNewStu'); if (ns) ns.onclick = () => S.newStudent();
    U.$id('btnPalette').onclick = () => S.palette();
    U.$id('btnTheme').onclick = () => S.toggleTheme();
    U.$id('btnRefresh').onclick = () => S.reload(false);
    U.$id('btnHelp').onclick = () => S.help();
  }

  /* ================= 侧栏 ================= */
  function sidebar() {
    U.$id('sidebar').innerHTML =
      '<div class="brand"><div class="brand-logo">拾</div><div class="brand-txt"><b>拾光小册</b><i>' + (CTB.version || '') + '</i></div></div>' +
      ROUTES.map(r => {
        const n = r.badge ? r.badge() : 0;
        return '<button class="nav-item' + (r.id === route ? ' on' : '') + '" data-r="' + r.id + '" title="' + r.name + '">' +
          '<span class="ic">' + r.ic + '</span><span class="side-label">' + r.name + '</span>' +
          (n ? '<span class="nav-badge' + (r.gray ? ' gray' : '') + '">' + n + '</span>' : '') + '</button>';
      }).join('') +
      '<button class="nav-item" id="btnSide" title="收起/展开侧栏"><span class="ic">⇄</span><span class="side-label">收起侧栏</span></button>' +
      '<div class="side-foot" id="sideFoot"></div>';
    document.querySelectorAll('.nav-item[data-r]').forEach(b => b.onclick = () => S.route(b.dataset.r));
    U.$id('btnSide').onclick = () => { const on = document.documentElement.dataset.side === 'mini'; document.documentElement.dataset.side = on ? '' : 'mini'; U.lsSet('ctb2.side', on ? 'full' : 'mini'); };
  }

  /* ================= 状态条 ================= */
  function statusbar(extra) {
    const modeTxt = { shell: ['ok', '桌面壳直连'], server: ['ok', '本机服务端 ' + (H.port || '7187')], offline: ['off', '离线（无数据）'], boot: ['off', '连接中'] }[H.mode] || ['', H.mode];
    const gen = M.state && M.state.generatedAt ? new Date(M.state.generatedAt).toLocaleString('zh-CN', { hour12: false }) : '—';
    const bad = M.healthBad();
    U.$id('statusbar').innerHTML =
      '<span><i class="dot ' + modeTxt[0] + '"></i>' + modeTxt[1] + '</span>' +
      '<span>在册 <b class="num">' + M.cards.length + '</b> 题</span>' +
      '<span>未办结待办 <b class="num">' + M.pendingOpen().length + '</b></span>' +
      (bad.length ? '<span class="sb-bad" title="' + U.esc(M.healthText()) + '">⚠ 门禁降级 ' + bad.length + ' 项</span>' : '') +
      '<span>数据生成 <b>' + U.esc(gen) + '</b></span>' +
      (extra ? '<span>' + U.esc(extra) + '</span>' : '') +
      '<span style="margin-left:auto">按 <kbd>?</kbd> 看快捷键</span>';
  }

  /* ================= 数据源健康红条（F-39，高） =================
     `_状态.json.dataHealth` 在 v2 此前零引用（实测 grep 0 命中）：admit/blindFresh/figState 解包失败时
     v2 静默按空表运行 —— 两道硬门禁在界面上失效而用户完全看不到（2026-10-10「界面选得动、工具一提交
     就拒」的复发形态）。v1 首页有 #dataHealthBanner 红条，这里补上同口径的一段（文案取 v1 原话）。
     容器由本函数自建（不放 index.html：本次改动范围限定 v2\js 与 v2\css）。 */
  function healthBanner() {
    let el = U.$id('dataHealthBanner');
    if (!el) {
      el = U.h('div', { id: 'dataHealthBanner', class: 'health-banner', 'data-health-bad': '1' });
      const view = U.$id('view');
      const host = (view && view.parentNode) || document.body;
      if (view) host.insertBefore(el, view); else host.appendChild(el);
    }
    return el;
  }
  function renderHealth() {
    const el = healthBanner();
    const bad = M.healthBad();
    if (!bad.length) { el.hidden = true; el.innerHTML = ''; document.documentElement.removeAttribute('data-health-bad'); return; }
    el.hidden = false;
    document.documentElement.setAttribute('data-health-bad', '1');
    el.innerHTML = '⚠ <b>数据源读取降级</b>，以下门禁当前处于「放行」态（<b>不是通过了，是读不到</b>）：' +
      U.esc(M.healthText()) +
      '<div class="hb-sub">影响：组卷/复习流的准入判定会退回兜底口径（比工具松），入账时可能被工具拒。' +
      '修法：重跑 <code>node _生成首页.ps1</code>；详见 <code>_状态.json</code> 的 <code>dataHealth</code>。</div>';
  }

  /* ================= 主题 ================= */
  S.theme = () => document.documentElement.dataset.theme || 'light';
  S.applyTheme = function (t) {
    document.documentElement.dataset.theme = t;
    U.lsSet('ctb2.theme', t);
  };
  S.toggleTheme = function () { S.applyTheme(S.theme() === 'dark' ? 'light' : 'dark'); S.render(); };

  /* ================= 渲染主流程 ================= */
  S.render = function () {
    try {
      sidebar();
      U.$id('topbar').innerHTML = topbar();
      bindTopbar();
    } catch (e) {
      /* F-40：sidebar/topbar 此前在 try 之外，一次异常把导航一起带走（只能重开窗口）。
         现在至少渲染一个能点的「重载界面」面板，不留空白。 */
      console.error(e);
      const sb = U.$id('sidebar');
      if (sb) sb.innerHTML = '<div class="side-foot">界面外壳渲染出错：<b>' + U.esc(e.message) + '</b></div>';
      const tb0 = U.$id('topbar');
      if (tb0) tb0.innerHTML = '<div class="tb-title">⚠ 界面出错</div><span class="tb-sp"></span>' +
        '<button class="btn sm" onclick="location.reload()">⟳ 重载界面</button>';
    }
    const el = U.$id('view');
    const v = CTB.views[route] || CTB.views.dash;
    el.innerHTML = '';
    /* ⚠ 2026-10-11 修（真壳验收抓到的第三个真 bug：`RangeError: Maximum call stack size exceeded`）：
       原先写法是 `if (routeParam && v.onParam) { v.onParam(routeParam); } routeParam = null;` ——
       **参数在 onParam 返回之后才清**。而 bank.js 的 onParam 内部会自己再调 `S.render()`
       （`p.code`/`p.blind` 两个分支都是 `…save(); S.render(); return;`）⇒ 重入的 S.render() 看到
       routeParam **仍然非空** ⇒ 又调 onParam ⇒ **无限递归**（每次点「按盲解未过筛」都烧一次栈；
       因为那层 try/catch 把 RangeError 吞成 console.error，界面看着"没坏"，最隐蔽）。
       现在：**先把参数取走再调 onParam**（重入时 routeParam 已是 null，递归自然终止）；
       视图若在 `render()` 内自己读 `S.routeParam()`（如 review 读 queue），参数保留到渲染结束再清。 */
    if (routeParam && v.onParam) { const pNow = routeParam; routeParam = null; try { v.onParam(pNow); } catch (e) { console.error(e); } }
    try { v.render(el); } catch (e) {
      console.error(e);
      el.innerHTML = '<div class="card"><div class="empty"><div class="e-ic">⚠️</div><b>视图渲染出错</b><div class="small">' + U.esc(e.message) + '</div></div></div>';
    }
    routeParam = null;   // 视图在 render 内读过参数的（review 的 queue）到此为止
    /* ⚠ 2026-10-11 修（页面内 CTA 全遍历回归抓到的第二个真 bug）：
       `#sideFoot` 在某些形态下不存在（如侧栏渲染失败/窄窗折叠/异常分支只重写了 `#sidebar`），
       这里直接 `.innerHTML=` 就会抛 `Cannot set properties of null`——而且它抛在 render 的**尾部**，
       会让 `renderHealth()` / `statusbar()` / 顶栏副标题**全部不执行**（界面看着像卡住）。
       改为存在性判断，缺失则跳过（派生信息，不该因它打断渲染收尾）。 */
    const sf = U.$id('sideFoot');
    /* ⚠ 2026-10-11（穷举扫描提示级）：题库根路径原先直接塞进 `<b>`，窄侧栏下会**断词折行**成
       「…MY\错 / 题本」。路径不该在词内被打断 ⇒ `word-break:keep-all` + 仅在真放不下时 `overflow-wrap:anywhere`，
       并用 11px 降低存在感。
       ★ 2026-10-12：路径改由运行时推导（H.rootFromLocation），原先写死真库绝对路径 ——
       程序搬到别处后这里会显示**错误的**题库路径，比不显示更糟。 */
    if (sf) {
      var rootPath = '';
      try {
        /* ★ 2026-10-23：路径改由运行时推导（H.rootFromLocation），原先写死真库绝对路径 ——
           程序搬到别处后这里会显示**错误的**题库路径，比不显示更糟。
           ★ 2026-10-23 二次修正：程序与数据分家后，页面所在目录是**程序目录**，
           而用户数据在库目录。壳会把 dataRoot 报上来，有它就显示它。 */
        if (H.dataRoot) {
          rootPath = H.dataRoot;
        } else {
          // file:///D:/X/数据/  →  D:\X\数据
          rootPath = decodeURIComponent(new URL(H.root || location.href).pathname).replace(/^\/([a-z]:)/i, '$1').replace(/\//g, '\\').replace(/\\$/, '');
        }
      } catch (e) { rootPath = '(当前目录)'; }
      sf.innerHTML = '通道：<b>' + { shell: '桌面壳', server: '服务端', offline: '离线' }[H.mode] + '</b><br>库目录：<b style="font-size:11px;word-break:keep-all;overflow-wrap:anywhere">' + U.esc(rootPath) + '</b>';
    }
    renderHealth();
    try { statusbar(); } catch (e) { console.error(e); }
    const tbs = U.$id('tbSub');
    if (tbs) { const sub = v.sub; tbs.textContent = sub ? (typeof sub === 'function' ? sub() : sub) : ''; }
  };

  /* ================= 数据重载 ================= */
  S.reload = async function (silent) {
    if (!silent) S.toast('正在重读数据…');
    try {
      const st = await H.getState();
      M.applyState(st);
      S.render();
      if (!silent) S.toast('数据已刷新', 'ok');
    } catch (e) { S.toast('刷新失败：' + e.message, 'bad'); }
  };
  /* v2.5（2026-10-10）自动重读：起因——T086 的证据图路径在磁盘上早已修好，
     可界面里一直是那张破图，因为壳只在启动时取一次状态、之后再也不看磁盘，
     用户点了几次「打开原图」都静默失败（shell-v2.log 里连刷三条「文件不存在」）。
     规矩：窗口重新获得焦点时比对状态包指纹，变了才重读——不打断正在写的结论。 */
  S.autoReloadDoneAt = 0;
  S.autoReloadBusy = false;
  function dirtyInput() {
    /* 正在写字就别把 DOM 重建掉（会把用户输入抹了）。有内容即视为「在写」。
       ⚠ 2026-10-11（F-42）：选择器此前只覆盖 textarea 与 `input[type=text]` ⇒
       用户正在改 `#rvCap`(number)、`#ppForm`(select)、`#bkSort`(select) 或抽屉里的 `#lgNote`
       会被 S.render() 静默重置。现在把 #view/#drawer 里的 input/select/textarea 全算进来。 */
    for (const el of document.querySelectorAll('#view textarea, #view input, #view select, #drawer textarea, #drawer input, #drawer select, #lightbox textarea, #lightbox input')) {
      if (el.value && String(el.value).trim()) return true;
    }
    return false;
  }
  S.autoReload = async function (force) {
    if (S.autoReloadBusy) return;
    if (H.mode !== 'shell' && H.mode !== 'server') return;
    if (!force && Date.now() - S.autoReloadDoneAt < 8000) return;    // 焦点抖动别反复拉 1MB 状态包
    S.autoReloadDoneAt = Date.now();
    S.autoReloadBusy = true;
    try {
      const st = await H.getState();
      const cur = M.state && M.state.generatedAt;
      if (!st || !st.generatedAt || st.generatedAt === cur) return;   // 磁盘没变 → 什么都不做
      if (dirtyInput()) { S.toast('磁盘上的数据已更新，但你在写结论——写完点右上 ⟳ 刷新', 'warn', 9000); return; }
      M.applyState(st); S.render();
      S.toast('检测到磁盘数据更新，已自动重读', 'ok', 5000);
    } catch (e) { /* 自动重读失败不打扰用户；右上 ⟳ 仍可手动重试 */ }
    finally { S.autoReloadBusy = false; }
  };
  S.regen = async function () {
    S.toast('全量重建中（生成器重跑，约 5 分钟）…', 'warn', 9000);
    try { const st = await H.regen(); if (!st || !Array.isArray(st.data)) throw new Error((st && st.regenError) || '重建返回异常'); M.applyState(st); S.render(); S.toast('重建完成', 'ok'); return true; }
    catch (e) { S.toast('重建失败：' + e.message, 'bad', 8000); return false; }
  };
  /* 非阻塞后台重建：落库后调用；期间可继续浏览，完成后自动刷新界面。壳侧写闸排队，不会互踩。 */
  S.regenBusy = false;
  S.regenBackground = function () {
    if (S.regenBusy) { S.toast('已有重建在后台进行（排队中）', 'warn'); return; }
    if (H.mode !== 'shell' && H.mode !== 'server') return;
    S.regenBusy = true;
    S.toast('数据已写盘；后台重建中（约 5 分钟），可继续浏览，完成后自动刷新', 'warn', 9000);
    H.regen().then(st => {
      if (st && Array.isArray(st.data)) { M.applyState(st); S.render(); S.toast('后台重建完成，磁盘快照已更新', 'ok'); }
      else S.toast('后台重建返回异常：' + ((st && st.regenError) || '未知') + '——可从托盘「全量重建」补刀', 'bad', 9000);
    }).catch(e => S.toast('后台重建失败：' + e.message + '——可从托盘「全量重建」补刀', 'bad', 9000))
      .finally(() => { S.regenBusy = false; });
  };
  /* 壳事件（托盘菜单等） */
  H.onEvent = function (m) { if (m.evt === 'refresh') S.reload(true); };

  /* ================= Toast =================
     2026-10-11 重做。起因（用户报）：右上角同时堆了 5 条一模一样的面板提示，
     把右侧「🎯 复习闭环/复习面板」整块盖住——**重复未去重 + 遮挡内容**，两件都不是审美。
     机制：提示的产生点在视图 render 体内（见 dash.js），而 render 每次 S.render() 都会跑
     （点侧栏 / 切学生 / 切主题 / autoReload 自动重读 / 落库后重绘 …）；原实现来一条 append 一条
     ⇒ 渲染 N 次就堆 N 条。运行期实测：连做 5 次 dash 渲染 → 5 条同文案 toast，浮层高 271px。
     现在的规矩：
       ① 同键去重：同一条（同 key）在屏上只保留一条，重复到达只累加 ×N 并续期，不再堆。
       ② 冷却窗  ：传了 dedupeMs 的同键提示，过期后在窗口内不再重播（渲染风暴不会反复吵）。
       ③ 同屏上限：最多 TOAST_MAX 条，超了从最旧的开始退场。
       ④ 不遮正文：浮层锚右下角（样式在 app.css 的 .toasts），每条可点关。
     参数：msg, type, ms, key(同键标识，缺省 type|msg), dedupeMs(冷却毫秒，缺省 0=只在屏上去重)
     返回：本次对应的 DOM 节点；被冷却窗丢弃时返回 null。 */
  const TOAST_MAX = 2;
  const toastReg = new Map();          // key → {node, timer, at}
  function toastDismiss(node, key) {
    const e = key && toastReg.get(key);
    if (e && e.node === node) { if (e.timer) clearTimeout(e.timer); toastReg.delete(key); }
    if (!node || !node.isConnected) return;
    node.classList.add('out');
    setTimeout(() => { if (node.isConnected) node.remove(); }, 320);
  }
  S.toast = function (msg, type, ms, key, dedupeMs) {
    const box = U.$id('toasts');
    if (!box) return null;
    /* 登记表剪枝：节点若已被外部移除（回归脚本会直接 `#toasts.innerHTML=''`），
       就不能再当作「还在屏上」——否则后续同键提示会被永久吞掉，
       那不叫去重，叫**静默丢消息**（比重复更糟）。 */
    for (const [k, e] of [...toastReg]) if (!e.node.isConnected) { if (e.timer) clearTimeout(e.timer); toastReg.delete(k); }
    const ttl = ms || 3600;
    const k = 't:' + (key || ((type || '') + '|' + msg));
    const prev = toastReg.get(k);
    if (prev && prev.node.isConnected) {
      if (dedupeMs) return prev.node;                                  // ② 冷却窗内：不再重播
      const n = (+(prev.node.dataset.n || '1')) + 1;                    // ① 只累加次数
      prev.node.dataset.n = String(n);
      let b = prev.node.querySelector('.t-n');
      if (!b) { b = U.h('span', { class: 't-n' }); prev.node.insertBefore(b, prev.node.querySelector('.t-x')); }
      b.textContent = '×' + n;
      if (prev.timer) clearTimeout(prev.timer);
      prev.timer = setTimeout(() => toastDismiss(prev.node, k), ttl);
      prev.at = Date.now();
      return prev.node;
    }
    if (prev && dedupeMs && Date.now() - (prev.at || 0) < dedupeMs) return null;   // ②
    const live = [...box.querySelectorAll('.toast:not(.out)')];                     // ③
    if (live.length >= TOAST_MAX) for (const old of live.slice(0, live.length - TOAST_MAX + 1)) {
      const ok = [...toastReg.keys()].find(x => toastReg.get(x).node === old);
      toastDismiss(old, ok || undefined);
    }
    const t = U.h('div', { class: 'toast ' + (type || ''), 'data-n': '1' });
    t.appendChild(U.h('span', { class: 't-m', text: msg }));
    t.appendChild(U.h('button', { class: 't-x', title: '关闭这条提示', 'aria-label': '关闭提示', text: '✕' }));
    const entry = { node: t, at: Date.now(), timer: 0 };
    toastReg.set(k, entry);
    entry.timer = setTimeout(() => toastDismiss(t, k), ttl);
    t.onclick = () => toastDismiss(t, k);
    box.appendChild(t);
    return t;
  };

  /* ================= 抽屉 ================= */
  let drawerCloser = null;
  S.drawer = function (opts) {
    const wrap = U.$id('drawerWrap');
    wrap.hidden = false;
    U.$id('drawer').innerHTML =
      '<div class="drawer-h"><b>' + U.esc(opts.title || '') + '</b>' +
      (opts.chips || '') +
      '<button class="iconbtn" id="drawerClose">✕</button></div>' +
      '<div class="drawer-b">' + opts.body + '</div>' +
      (opts.footer ? '<div class="drawer-f">' + opts.footer + '</div>' : '');
    U.$id('drawerClose').onclick = S.closeDrawer;
    U.$id('drawerMask').onclick = S.closeDrawer;
    drawerCloser = opts.onClose || null;
    if (opts.onMount) opts.onMount(U.$id('drawer'));
  };
  S.closeDrawer = function () {
    U.$id('drawerWrap').hidden = true;
    U.$id('drawer').innerHTML = '';
    if (drawerCloser) { const f = drawerCloser; drawerCloser = null; f(); }
  };

  /* ================= 新建学生（空库第一步） =================
     ★ 2026-10-23 新增（用户实测 BUG#1）：空库里没有任何地方能建"孩子"，
       界面全是空态、新用户进门就堵死。这个表单是全库唯一的"从零开始"入口。
     业务全在工具 src/tools/_建学生.mjs（校验/落盘/防重名），界面只负责收字段。

     ★ 2026-10-24 改版（用户指正）：**不再问学科**。
       「要这个程序的人，肯定每个学科都要录入错题」—— 学科不是"人"的属性，是"题"的属性；
       建学生时问哪一科，等于让用户为同一个孩子重复建好几次。现在只收 姓名（必填）+ 年级（可留空），
       学科在录题时按需长出来（`subjects[那门课]` 自动出现）。
     年级用下拉而不是自由输入：它会进索引并显示在页头，写错就得手工收拾；但它**不进目录名**，
       所以选错了随时能改，不会产生一个搬不动的目录。 */
  const GRADES = ['一年级', '二年级', '三年级', '四年级', '五年级', '六年级',
    '七年级', '八年级', '九年级', '高一', '高二', '高三'];
  S.newStudent = function () {
    const opt = (arr, def) => arr.map((x) => '<option' + (x === def ? ' selected' : '') + '>' + U.esc(x) + '</option>').join('');
    /* 年级默认：库里已有学生的年级 +1（换学年最常用），否则七年级 */
    const guess = (function () {
      for (const k of (M.state && M.state.data) || []) {
        if (!k || !k.grade) continue;
        const i = GRADES.indexOf(k.grade);
        if (i >= 0 && i + 1 < GRADES.length) return GRADES[i + 1];
        if (i >= 0) return k.grade;
      }
      return '七年级';
    })();
    S.drawer({
      title: '＋ 新建学生',
      body: '<div class="stack" style="gap:12px">' +
        '<div class="opt-item">孩子叫什么　<input type="text" id="nsName" maxlength="20" style="width:170px" placeholder="小明（小名也行）"></div>' +
        '<div class="opt-item">几年级　　　<select id="nsGrade"><option value="">（先不填）</option>' + opt(GRADES, guess) + '</select>' +
        '　<span class="small muted">只用于显示与统计；选错随时能改</span></div>' +
        '<div class="pp-note">建好之后就可以往里录题了。<b>不用选学科</b> —— ' +
        '录哪门课的题，那门课就自动出现在题库和统计里（一个孩子本来就会有好几门课）。</div>' +
        (H.mode !== 'shell' ? '<div class="pp-note">当前不是桌面壳通道，新建学生会失败（落库需要 <b>拾光小册.exe</b>）。</div>' : '') +
        '</div>',
      footer: '<span class="small muted" style="flex:1">姓名只存在你自己的电脑上，不上传</span>' +
        '<button class="btn" id="nsCancel">取消</button><button class="btn primary" id="nsOk">建好了</button>',
      onMount: () => {
        const nameEl = U.$id('nsName');
        if (nameEl) nameEl.focus();
        U.$id('nsCancel').onclick = S.closeDrawer;
        const submit = async () => {
          const name = String(U.$id('nsName').value || '').trim();
          const grade = U.$id('nsGrade').value || '';
          if (!name) { S.toast('先填个名字（可以是小名）', 'warn'); nameEl && nameEl.focus(); return; }
          const btn = U.$id('nsOk');
          if (btn) { btn.disabled = true; btn.textContent = '正在建…'; }
          try {
            const r = await H.createStudent({ name, grade });
            if (!r || r.ok === false) throw new Error((r && (r.error || r.out) || '工具拒绝').slice(0, 300));
            S.closeDrawer();
            M.applyState(r.state || await H.getState());
            M.student(name);            // 建完直接切到这孩子，省得用户再点一次
            S.toast('已建好：' + name + (grade ? '（' + grade + '）' : '') + ' —— 现在可以往里录题了', 'ok', 6000);
            S.render();
          } catch (e) {
            if (btn) { btn.disabled = false; btn.textContent = '建好了'; }
            S.toast('新建学生失败：' + ((e && e.message) || e), 'bad', 9000);
          }
        };
        U.$id('nsOk').onclick = submit;
        if (nameEl) nameEl.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } };
      },
    });
  };

  /* ================= 灯箱（裁图 ⇄ 整页原卷 + 红框定位 + 问题上下文/就地办结） =================
     item 字段：src 当前显示图 URL ｜ rel 裁图相对路径 ｜ orig 整页原卷相对路径 ｜ origBox 归一化红框[x,y,w,h]
               ｜ origImport 导入原件相对路径 ｜ origBy 溯源规则 ｜ title ｜ box 裁图像素红框[x,y,w,h]
               ｜ chips HTML 徽章 ｜ q 问题正文 ｜ detail 补充 ｜ hint 怎么办指引 ｜ foot HTML 操作区 ｜ onMount(el) 绑事件
     语义铁律（2026-10-09）：🗂 只打开**整页原卷**（用户当初导入的那一页），绝不打裁图冒充原图；
     未定位到整页时按钮显式禁用并说明原因，不静默降级——「按钮写着原图、打开是特写」就是这次的坑。 */
  let lb = null;
  const lbBase = p => String(p || '').split('/').pop();
  const lbCur = () => (lb ? lb.items[lb.idx] : null);
  S.lightbox = function (items, idx) {
    if (typeof items === 'string') items = [{ src: items }];
    idx = idx || 0;
    lb = { items, idx, scale: 1, ox: 0, oy: 0, drag: null, mode: 'crop' };
    const el = U.$id('lightbox'); el.hidden = false;
    el.innerHTML =
      '<div class="lb-hd"><b id="lbTitle"></b><span id="lbChips"></span><span class="x" id="lbNote"></span>' +
      '<div class="lb-tools">' +
      '<button class="iconbtn" id="lbMode" title="在「裁图」与「原图（整页原卷）」之间切换（快捷键 P）">⇄ 原图</button>' +
      '<button class="iconbtn" id="lbFit" title="复位">⤢</button>' +
      '<button class="iconbtn" id="lbZoomOut" title="缩小">－</button>' +
      '<button class="iconbtn" id="lbZoomIn" title="放大（滚轮）">＋</button>' +
      '<button class="iconbtn" id="lbOpen" title="用系统程序打开原图（整页原卷）">🗂 原图</button>' +
      '<button class="iconbtn" id="lbImp" title="用系统程序打开导入原件">📥 原件</button>' +
      '<button class="iconbtn" id="lbReveal" title="在文件夹中显示">📁 位置</button>' +
      '<button class="iconbtn" id="lbClose" title="关闭（Esc）">✕</button></div></div>' +
      '<div class="lb-src" id="lbSrc"></div>' +
      '<div class="lb-stage" id="lbStage"><div id="lbWrap" style="position:absolute;transform-origin:0 0"><img id="lbImg" alt=""><div class="lb-box" id="lbBox" hidden></div></div></div>' +
      '<div class="lb-ctx" id="lbCtx"></div>';
    U.$id('lbClose').onclick = S.closeLightbox;
    U.$id('lbFit').onclick = () => { lb.scale = 1; lb.ox = 0; lb.oy = 0; applyTf(); };
    U.$id('lbZoomIn').onclick = () => zoomAt(1.25);
    U.$id('lbZoomOut').onclick = () => zoomAt(0.8);
    U.$id('lbMode').onclick = () => S.lbToggleMode();
    U.$id('lbOpen').onclick = () => { const it = lbCur(); if (it && it.orig) H.openFile(it.orig); };
    U.$id('lbImp').onclick = () => { const it = lbCur(); if (it && it.origImport) H.openFile(it.origImport); };
    U.$id('lbReveal').onclick = () => { const it = lbCur(); if (!it) return; H.reveal(lb.mode === 'orig' && it.orig ? it.orig : (it.rel || it.orig || it.origImport)); };
    /* ⚠ 2026-10-12（BUG-16·中）：原先这里是 `el.addEventListener('keydown', lbKey)`，
       而 el 是 index.html 里的**常驻节点** `#lightbox`，关闭只清 innerHTML（:447）
       ⇒ 每开一次灯箱就叠加一个监听器。实测开过 13 次后按一次 `→`，页码从 0 跳到 **13**；
       `P` 切图也会叠执行（按 13 次只反一次）。
       待办办结流每办结一条就自动开一次灯箱（pending.js:234），累积很快。
       现在：用 `onkeydown =`（赋值语义，同一节点只有一个）替代 addEventListener。 */
    el.onkeydown = lbKey;
    el.tabIndex = -1; el.focus();
    const stage = U.$id('lbStage');
    stage.addEventListener('wheel', e => { e.preventDefault(); zoomAt(e.deltaY < 0 ? 1.18 : 0.85, e.offsetX, e.offsetY); });
    stage.addEventListener('pointerdown', e => { lb.drag = { x: e.clientX - lb.ox, y: e.clientY - lb.oy }; stage.classList.add('grabbing'); stage.setPointerCapture(e.pointerId); });
    stage.addEventListener('pointermove', e => { if (!lb || !lb.drag) return; lb.ox = e.clientX - lb.drag.x; lb.oy = e.clientY - lb.drag.y; applyTf(); });
    stage.addEventListener('pointerup', () => { lb && (lb.drag = null); stage.classList.remove('grabbing'); });
    loadLb();
  };
  S.lbToggleMode = function () {
    const it = lbCur(); if (!it || !it.orig || it.orig === it.rel) return;
    lb.mode = lb.mode === 'orig' ? 'crop' : 'orig';
    loadLb();
  };
  S.lbMode = () => (lb ? lb.mode : null);
  S.lbState = () => (lb ? { idx: lb.idx, n: lb.items.length, mode: lb.mode } : null);
  function lbKey(e) {
    if (!lb) return;
    if (/TEXTAREA|INPUT/.test(e.target.tagName)) { if (e.key === 'Escape') e.target.blur(); return; }   // 正在写结论：方向键归文本，Esc 先退输入框
    if (e.key === 'Escape') S.closeLightbox();
    if (e.key === 'p' || e.key === 'P') { S.lbToggleMode(); return; }
    if (e.key === 'ArrowRight' && lb.idx < lb.items.length - 1) { lb.idx++; loadLb(); }
    if (e.key === 'ArrowLeft' && lb.idx > 0) { lb.idx--; loadLb(); }
  }
  function zoomAt(f, cx, cy) {
    const ns = U.clamp(lb.scale * f, 0.2, 12);
    if (cx != null) { lb.ox = cx - (cx - lb.ox) * (ns / lb.scale); lb.oy = cy - (cy - lb.oy) * (ns / lb.scale); }
    lb.scale = ns; applyTf();
  }
  function applyTf() { if (lb) U.$id('lbWrap').style.transform = 'translate(' + lb.ox + 'px,' + lb.oy + 'px) scale(' + lb.scale + ')'; }
  /* 归一化红框（台账口径 0~1）→ 当前图像素（灯箱口径源图像素），两套坐标只在 onload 时才凑齐 */
  const normToPx = (b, img) => (b && b.length === 4 ? [b[0] * img.naturalWidth, b[1] * img.naturalHeight, b[2] * img.naturalWidth, b[3] * img.naturalHeight] : null);
  function loadLb() {
    const it = lb.items[lb.idx];
    const showOrig = lb.mode === 'orig' && !!it.orig;
    U.$id('lbTitle').textContent = it.title || '原卷';
    U.$id('lbChips').innerHTML = it.chips || '';
    U.$id('lbNote').textContent = lb.items.length > 1 ? (lb.idx + 1) + ' / ' + lb.items.length : '';
    /* 能打开什么就摆什么；打不开的说清为什么，禁装「原图」 */
    const canSwitch = !!it.orig && it.orig !== it.rel;
    const modeBtn = U.$id('lbMode');
    modeBtn.style.display = canSwitch ? '' : 'none';
    modeBtn.textContent = showOrig ? '⇄ 裁图' : '⇄ 原图';
    const openBtn = U.$id('lbOpen');
    openBtn.style.display = (it.rel || it.orig) ? '' : 'none';
    openBtn.disabled = !it.orig;
    openBtn.title = it.orig ? '用系统程序打开原图（整页原卷）：' + it.orig : '这张卡还没定位到整页原卷（原卷台账标「未定位」），只能看裁图';
    const impBtn = U.$id('lbImp');
    impBtn.style.display = it.origImport ? '' : 'none';
    impBtn.title = it.origImport ? '用系统程序打开导入原件：' + it.origImport : '无导入原件记录（原图与 _收件箱 里的件 sha256 不同源）';
    U.$id('lbReveal').style.display = (it.rel || it.orig || it.origImport) ? '' : 'none';
    U.$id('lbSrc').innerHTML = showOrig
      ? '<span class="tag ok">原图（整页原卷）</span><code>' + U.esc(it.orig) + '</code>' +
        (it.origBy ? '<span class="muted small">溯源：' + U.esc(it.origBy) + '</span>' : '') +
        (it.origBox ? '<span class="muted small">红框=这道题，已对准</span>' : '<span class="muted small">原图已定位，题目位置未登记（无红框）</span>')
      : ((it.rel ? '<span class="tag gray">裁图</span><code>' + U.esc(it.rel) + '</code>' : '') +
        (canSwitch ? '<span class="muted small">⇄ 原图（P）看这一刀是从哪一页裁的</span>' : (it.orig ? '' : '<span class="tag warn">未定位到整页原卷</span>')));
    /* 上下文面板：这条在问什么 → 就看这块图，绝不让用户对着图猜任务 */
    let ctx = '';
    if (it.q) ctx += '<div class="lb-q">' + U.esc(it.q) + '</div>';
    if (it.detail) ctx += '<div class="lb-d">' + U.esc(it.detail) + '</div>';
    if (it.hint) ctx += '<div class="lb-hint">🧭 ' + U.esc(it.hint) + '</div>';
    if (it.cap) ctx += '<div class="lb-d">' + it.cap + '</div>';
    const ctxEl = U.$id('lbCtx');
    ctxEl.innerHTML = ctx || (it.foot ? '' : '<div class="lb-d muted">对照红框区域查看</div>');
    if (it.foot) ctxEl.innerHTML += '<div class="lb-foot" id="lbFoot">' + it.foot + '</div>';
    ctxEl.scrollTop = 0;
    if (it.onMount) it.onMount(ctxEl);
    const img = U.$id('lbImg');
    img.onload = () => {
      if (!lb) return;
      const stage = U.$id('lbStage'), r = stage.getBoundingClientRect();
      const fit = Math.min((r.width - 40) / img.naturalWidth, (r.height - 40) / img.naturalHeight, 1.4);
      lb.scale = fit;
      let focus = showOrig ? normToPx(it.origBox, img) : it.box;   // 整页用归一化框换算，裁图用源图像素框
      if (focus) {
        const bw = Math.max(1, focus[2]), bh = Math.max(1, focus[3]);
        lb.scale = U.clamp(Math.min(r.width * 0.8 / bw, r.height * 0.8 / bh), 0.3, 10);
        const bx = focus[0] + bw / 2, by = focus[1] + bh / 2;
        lb.ox = r.width / 2 - bx * lb.scale; lb.oy = r.height / 2 - by * lb.scale;
      } else { lb.ox = (r.width - img.naturalWidth * lb.scale) / 2; lb.oy = (r.height - img.naturalHeight * lb.scale) / 2; }
      const bx = U.$id('lbBox');
      if (focus) { bx.hidden = false; bx.style.left = focus[0] + 'px'; bx.style.top = focus[1] + 'px'; bx.style.width = Math.max(10, focus[2]) + 'px'; bx.style.height = Math.max(10, focus[3]) + 'px'; }
      else bx.hidden = true;
      applyTf();
    };
    img.src = showOrig ? H.asset(it.orig) : it.src;
  }

  S.closeLightbox = function () { lb = null; U.$id('lightbox').hidden = true; U.$id('lightbox').innerHTML = ''; };
  S.lbIndex = () => (lb ? lb.idx : 0);

  /* ================= 命令面板 ================= */
  S.palette = function (q0) {
    const wrap = U.$id('paletteWrap');
    wrap.hidden = false;
    const input = U.$id('paletteInput'), list = U.$id('paletteList');
    input.value = q0 || '';
    input.focus();
    const cmds = [
      { t: '→ 今日总览', run: () => S.route('dash') }, { t: '→ 复习流', run: () => S.route('review') },
      { t: '→ 题库浏览', run: () => S.route('bank') }, { t: '→ 组卷工作台', run: () => S.route('paper') },
      { t: '→ 待办工作台', run: () => S.route('pending') }, { t: '→ 统计分析', run: () => S.route('stats') },
      { t: '🎨 切换深浅主题', run: () => S.toggleTheme() },
      { t: '⟳ 重刷数据（只读重进）', run: () => S.reload() },
      { t: '🔧 全量重建（重跑生成器，慢）', run: () => S.regen() },
      { t: '📤 导出待办办结包', run: () => CTB.views.pending.exportPkg && CTB.views.pending.exportPkg() },
      { t: '❔ 帮助与快捷键', run: () => S.help() },
    ];
    if (H.mode === 'shell') cmds.push({ t: '⏻ 退出拾光小册', run: () => H.quit() });
    function draw() {
      const q = input.value.trim();
      let html = '';
      if (q.startsWith('>')) {
        const hits = cmds.filter(c => U.fuzzy(q.slice(1), c.t) >= 0 || !q.slice(1).trim());
        html = '<div class="p-sect">命令</div>' + hits.map((c, i) => '<div class="p-item' + (i === 0 ? ' on' : '') + '" data-i="' + cmds.indexOf(c) + '"><span>⌘</span><b>' + U.esc(c.t) + '</b></div>').join('');
      } else {
        const cs = cmds.filter(c => U.fuzzy(q, c.t) >= 0);
        if (q) {
          const cards = M.search(q, 12);
          html = '<div class="p-sect">题目（' + cards.length + '）</div>' + cards.map(x =>
            '<div class="p-item" data-card="' + U.esc(x.key) + '"><span style="color:' + U.sjColor(x.subject) + '">●</span><b>' + U.esc(x.card.id) + '</b><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + U.esc(x.card.question) + '</span><span class="p-x">' + U.esc(x.kid + '·' + x.subject) + '</span></div>').join('');
          html += '<div class="p-sect">命令</div>' + cs.slice(0, 6).map(c => '<div class="p-item" data-i="' + cmds.indexOf(c) + '"><span>⌘</span><b>' + U.esc(c.t) + '</b></div>').join('');
        } else {
          html = '<div class="p-sect">导航与命令</div>' + cmds.map(c => '<div class="p-item" data-i="' + cmds.indexOf(c) + '"><span>⌘</span><b>' + U.esc(c.t) + '</b></div>').join('') +
            '<div class="p-sect">提示</div><div class="p-item muted" style="cursor:default">直接输入题干/知识点关键字搜题；&gt; 前缀只跑命令</div>';
        }
      }
      list.innerHTML = html || '<div class="p-sect">无匹配</div>';
      list.querySelectorAll('.p-item[data-i]').forEach(el => el.onclick = () => { const c = cmds[+el.dataset.i]; S.closePalette(); c && c.run(); });
      list.querySelectorAll('.p-item[data-card]').forEach(el => el.onclick = () => { S.closePalette(); S.route('bank', { openKey: el.dataset.card }); });
      /* F-51：`draw()` 原来只在 `>` 命令分支给第一项加 `.on`，非 `>` 分支不加 ⇒
         onkeydown 里 `list.querySelector('.p-item.on')` 为 null ⇒ **打开面板直接按 Enter 没反应**。
         统一在 draw() 末尾给首个可选项补 `.on`。 */
      const first = list.querySelector('.p-item[data-i], .p-item[data-card]');
      if (first && !list.querySelector('.p-item.on')) first.classList.add('on');
    }
    input.oninput = draw;
    input.onkeydown = e => {
      const items = [...list.querySelectorAll('.p-item[data-i],.p-item[data-card]')];
      const on = list.querySelector('.p-item.on');
      let i = items.indexOf(on);
      if (e.key === 'ArrowDown') { e.preventDefault(); i = Math.min(items.length - 1, i + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); i = Math.max(0, i - 1); }
      else if (e.key === 'Enter') { if (on) on.click(); return; }
      else if (e.key === 'Escape') { S.closePalette(); return; }
      items.forEach(el => el.classList.remove('on'));
      if (items[i]) { items[i].classList.add('on'); items[i].scrollIntoView({ block: 'nearest' }); }
    };
    U.$id('paletteMask').onclick = S.closePalette;
    draw();
  };
  S.closePalette = function () { U.$id('paletteWrap').hidden = true; };

  /* ================= 帮助 ================= */
  S.help = function () {
    S.drawer({
      title: '帮助 · 快捷键 · 2.0 更新了什么（' + (CTB.version || '') + '）',
      body: '<div class="mdv" style="font-size:13.8px">' +
        '<h3 style="margin-top:0">键盘</h3><table class="tbl"><tbody>' +
        '<tr><td><kbd>Ctrl</kbd><kbd>K</kbd></td><td>命令面板：搜题 / 跳页 / 执行命令</td></tr>' +
        '<tr><td><kbd>1</kbd><kbd>2</kbd><kbd>3</kbd>（复习中）</td><td>判定：对 / 半对 / 错（空格=翻开答案）</td></tr>' +
        '<tr><td><kbd>←</kbd><kbd>→</kbd>（灯箱内）</td><td>多图翻页；滚轮缩放、拖拽平移</td></tr>' +
        '<tr><td><kbd>Esc</kbd></td><td>关闭抽屉/灯箱/面板</td></tr>' +
        '<tr><td><kbd>?</kbd></td><td>本页</td></tr>' +
        '</tbody></table>' +
        '<h3>2.0 新在哪（对照 1.x 首页）</h3><ul>' +
        '<li><b>复习流</b>：到期题/勾选题屏幕重做，答→判→自动组卷入账（走 <code>_标记复习.mjs</code> 唯一入口，连对 2 次=已掌握）。</li>' +
        '<li><b>题库浏览</b>：多维筛选（学科/题型/难度/错因层/状态/盲解/有图）+ 全文搜索 + 详情抽屉（错题记录、复习史、原卷定位）。</li>' +
        '<li><b>组卷工作台</b>：勾选/自动抽题（到期优先）→ A4 试卷 + 答案册 两件套，一键打印（泄答案防线：只出印刷题干与裁净的题干图）。</li>' +
        '<li><b>待办工作台</b>：按「问谁」分区，证据图带高亮框定位，页内办结直落库，可导出办结包。</li>' +
        '<li><b>统计分析</b>：错因三层矩阵、知识点弱项榜、入册/复习热力、逾期风险表、双孩子对比。</li>' +
        '<li><b>界面</b>：纸墨双主题、侧栏信息架构、命令面板、快捷键、状态条——不再是单页长墙。</li>' +
        '</ul>' +
        '<h3>数据规矩（与 1.x 完全相同）</h3><ul>' +
        '<li>磁盘唯一真源；网页只做临时台账，任何落库都走既有工具（复习=<code>_标记复习.mjs</code>，待办=<code>_待确认.mjs</code>）。</li>' +
        '<li>不排期、不推送、不强制（a2）；组卷重做走纸质（b1）；错题永不删行；组卷必过盲解门禁。</li>' +
        '<li>老版本的程序与 <code>首页.html</code> 一个字节都不会被改动。</li>' +
        '</ul></div>',
    });
  };

  /* ================= 全局快捷键 ================= */
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (!U.$id('lightbox').hidden) return S.closeLightbox();
      if (!U.$id('paletteWrap').hidden) return S.closePalette();
      if (!U.$id('drawerWrap').hidden) return S.closeDrawer();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if (U.$id('paletteWrap').hidden) S.palette(); else S.closePalette(); return; }
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (!U.$id('paletteWrap').hidden || !U.$id('lightbox').hidden) return;
    if (e.key === '?') { S.help(); return; }
    const map = { d: 'dash', r: 'review', b: 'bank', p: 'paper', t: 'pending', s: 'stats' };
    if (map[e.key.toLowerCase()]) S.route(map[e.key.toLowerCase()]);
  });

  /* ================= 挂载 ================= */
  S.mount = function () {
    const savedTheme = U.lsGet('ctb2.theme', null) || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    S.applyTheme(savedTheme);
    if (U.lsGet('ctb2.side', 'full') === 'mini') document.documentElement.dataset.side = 'mini';
    const h = (location.hash || '#dash').slice(1);
    route = CTB.views[h] ? h : 'dash';
    document.addEventListener('click', e => {           // 站内 a[data-go] 委托
      const a = e.target.closest && e.target.closest('[data-go]');
      if (a) { e.preventDefault(); S.route(a.dataset.go); }
    });
    S.render();
  };
})();
