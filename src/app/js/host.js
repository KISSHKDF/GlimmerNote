/* 错题本 2.0 · 数据通道（三形态自适应：桌面壳直连 → 本机服务端 → 离线只读）
 * 协议与 v1 桌面壳同族：JS 发 {id,op,payload} 字符串；壳回 {ctb:'resp',id,ok,data}（PostWebMessageAsJson）。 */
(function () {
  const H = CTB.host = {};
  H.mode = 'boot';          // shell | server | offline
  H.root = '';              // 资产 URL 前缀（程序侧 / 服务端）
  /* ★ 2026-10-23：程序与数据分家后，题面照片、原卷图、题干.html 都在**库目录**里，
     不在页面所在目录。资产前缀必须用壳报回来的 dataRoot，不能再从页面 URL 推。 */
  H.dataRoot = '';          // 库目录绝对路径（壳报回来的原样，供状态条显示）
  H.dataRootUrl = '';       // 库目录的 file:// 前缀（拼资产 URL 用）
  H.lastError = '';

  /* ★ 2026-10-12 路径自推导：原先把库前缀写死成一个绝对 file:// 路径（URL 编码的中文路径），
     目录一挪前端就指向不存在的位置。现在从**页面自身 URL** 推导：
     页面在 <题库根>/v2/index.html ⇒ 上溯两级就是题库根，转成 file URI 即资产前缀。
     页面若被以其它路径打开（如服务端 http 模式），下面 server 模式会用 origin，同样不依赖硬编码盘符。

     ⚠ 两个坑（都是实测踩到的）：
       坑1 **不能用 `new URL('../..', location.href)`** —— 本机实测它返回的是**库根的上级**（`file:///D:/…/`），
            中文目录名"错题本"在 URL 构造时被吃掉（location.href 里是 %E9%94%99…，`..` 回退后
            base 落到库根的上级目录），于是所有图片 ERR_FILE_NOT_FOUND（原卷图、红框坐标全取不到）。
       坑2 **file:// 的 `URL.origin` 是字符串 `"null"`**，不是空串；`origin + path` 会拼出
            `null/D:/…` 这种废串。所以 file:// 必须**整串手工拼**，不能用 origin。 */
  function rootFromLocation() {
    try {
      var href = location.href;
      var i = href.indexOf('://');
      if (i < 0) return '';
      var scheme = href.slice(0, i + 3);                 // 'file://' 或 'http://'
      var rest = href.slice(i + 3);
      var q = rest.search(/[?#]/);                        // 去掉查询串与锚点
      if (q >= 0) rest = rest.slice(0, q);
      var pathPart = decodeURIComponent(rest);            // file:// 后是 /D:/…；http 后是 127.0.0.1:7187/…
      // 去掉文件名（index.html），再退一级（v2 → 题库根）
      var rootPath = pathPart.replace(/[^/]*$/, '').replace(/v2\/$/, '');
      if (!rootPath) return scheme;                        // 退化：至少给出 scheme
      // ★ 必须补尾斜杠：资产 URL 是 root + 相对路径，缺斜杠会拼成
      //   file:///…/v2/index.html七年级-学生B/…（门禁实测就是这个 ERR）。
      if (rootPath.charAt(rootPath.length - 1) !== '/') rootPath += '/';
      return scheme + encodeURI(rootPath);
    } catch (e) { return ''; }
  }
  H.rootFromLocation = rootFromLocation;

  /* 绝对目录路径 → file:// 前缀。为什么不直接 new URL('file://' + p)：
     Windows 路径里的中文/空格必须逐段百分号编码，且 file:// 的 origin 是字符串 "null"，
     随手拼会得到 "null/D:/…" 这种废串（上面坑2 记过）。这里整串手工拼。 */
  function fileUrlOfDir(abs) {
    try {
      if (!abs) return '';
      var p = String(abs).replace(/\\/g, '/');
      if (p.charAt(1) === ':') p = '/' + p;                 // D:/a → /D:/a
      if (p.charAt(p.length - 1) !== '/') p += '/';
      return 'file://' + encodeURI(p).replace(/#/g, '%23').replace(/\?/g, '%3F');
    } catch (e) { return ''; }
  }
  H.fileUrlOfDir = fileUrlOfDir;

  /* 端口：原写死 7187。壳的导航白名单也写死同一个值，改一处必须改两处 ⇒ 做成可覆盖。
     覆盖顺序：?ctbPort= 查询参数 → localStorage（界面设置一次就记住）→ 默认 7187。 */
  H.port = (function () {
    try {
      const q = new URLSearchParams(location.search).get('ctbPort');
      if (q && /^\d+$/.test(q)) { try { localStorage.setItem('ctb.port', q); } catch (e) { } return q; }
      const saved = localStorage.getItem('ctb.port');
      if (saved && /^\d+$/.test(saved)) return saved;
    } catch (e) { }
    return '7187';
  })();
  H.serverOrigin = 'http://127.0.0.1:' + H.port;

  /* ---------- 通道探测 ---------- */
  async function probeServer() {
    try {
      const r = await fetch(H.serverOrigin + '/health', { cache: 'no-store' });
      return r.ok;
    } catch (e) { return false; }
  }
  H.init = async function () {
    if (window.ctbHost && window.chrome && window.chrome.webview) {
      H.mode = 'shell';
      H.root = rootFromLocation();
      window.chrome.webview.addEventListener('message', ev => {
        let m; try { m = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data; } catch (e) { return; }
        if (m && m.ctb === 'resp' && pending[m.id]) { pending[m.id](m); delete pending[m.id]; }
        if (m && m.ctb === 'resp-part') {                       // 大响应分片（PostWebMessageAsJson 有 1MB 硬限）
          const p = parts[m.id] || (parts[m.id] = { n: m.n, got: 0, buf: [] });
          if (!p.buf[m.i]) p.got++;
          p.buf[m.i] = m.part;
          if (p.got === p.n) {
            delete parts[m.id];
            let full = null;
            try { full = JSON.parse(p.buf.join('')); } catch (e) { full = { ok: false, error: '分片重组失败：' + e.message }; }
            if (pending[m.id]) { pending[m.id]({ ok: true, data: full }); delete pending[m.id]; }
          }
          return;
        }
        if (m && m.ctb === 'evt' && H.onEvent) H.onEvent(m);
      });
      /* 壳就绪握手（顺带核对壳版本语义） */
      try {
        const r = await bridge('hello', {}, 5000);
        if (r && r.version) H.shellVersion = r.version;
        /* 壳报回来的库目录 = 用户数据真正所在。有它就用它，没有才退回页面推出来的前缀。 */
        if (r && r.dataRoot) { H.dataRoot = r.dataRoot; H.dataRootUrl = fileUrlOfDir(r.dataRoot); }
        if (r && r.appRoot) H.appRoot = r.appRoot;
      } catch (e) { }
      return;
    }
    if (await probeServer()) {
      H.mode = 'server'; H.root = H.serverOrigin + '/'; return;
    }
    H.mode = 'offline';
  };

  /* ---------- 桌面壳桥 ---------- */
  const pending = {};
  const parts = {};
  let seq = 0;
  function bridge(op, payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = 'v2-' + (++seq) + '-' + Date.now().toString(36);
      const t = setTimeout(() => { if (pending[id]) { delete pending[id]; reject(new Error('桌面壳响应超时（op=' + op + '）')); } }, timeoutMs || 120000);
      pending[id] = function (m) {
        clearTimeout(t);
        const data = m.ok ? m.data : null;
        if (!m.ok) return reject(new Error('壳通道失败 op=' + op));
        /* 壳把工具失败包在 data.ok=false 里也当业务失败 */
        resolve(data);
      };
      window.ctbHost.postMessage(JSON.stringify({ id, op, payload: payload || {} }));
    });
  }

  /* ---------- 资产 URL（img/md 字段可能已百分号编码；pending.evidence 是原始相对路径） ---------- */
  H.asset = function (rel) {
    if (!rel) return '';
    if (/^https?:/i.test(rel)) return rel;
    let r = String(rel).replace(/^\.?\//, '');
    /* 含 %-两位十六进制 视为已编码，原样拼接；否则整段 encodeURI（保留 / 与非 ASCII 转义） */
    const encoded = /%[0-9a-fA-F]{2}/.test(r);
    const tail = encoded ? r : encodeURI(r).replace(/#/g, '%23');
    /* 壳通道：资产在库目录；服务端模式：H.root 就是服务端根；离线：退回页面同级。 */
    const base = (H.mode === 'shell' && H.dataRootUrl) ? H.dataRootUrl : H.root;
    return base + tail;
  };
  /* 相对路径（未编码形态，供壳 openFile/md 用）。**唯一实现**在 util.decPath**（v2 两处曾各写一份） */
  H.relPath = function (rel) { return CTB.util.decPath(rel); };

  /* ---------- 业务动作（统一 Promise；失败抛 Error） ---------- */
  H.getState = async function () {
    if (H.mode === 'shell') return bridge('state', {}, 180000);
    if (H.mode === 'server') {
      const r = await fetch(H.root + 'api/state', { cache: 'no-store' });
      if (!r.ok) throw new Error('服务端 /api/state → ' + r.status);
      return r.json();
    }
    throw new Error('未连接数据通道');
  };
  /* 待办办结落库：resolves=[{id,action:'答'|'作废',answer}] → 返回 {ok,results,state}
     ⚠ 2026-10-11（F-33 配套）：服务端此前只回 `j.state`，逐条结果 `results`（ok/skipped/missing）
     在半路被丢掉 ⇒ 页面无法逐条核对，只能"整体成功/失败"。现在与桌面壳同形返回。 */
  H.pendingResolve = async function (resolves) {
    if (H.mode === 'shell') return bridge('pendingResolve', { resolves }, 180000);
    if (H.mode === 'server') {
      const r = await fetch(H.root + 'api/pending', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resolves }) });
      const j = await r.json(); if (!j.ok) throw new Error(j.toolOut || j.error || '落库失败');
      return { ok: true, results: j.results || [], state: j.state || await H.getState() };
    }
    throw new Error('离线模式只能查看，不能落库（请用桌面壳 拾光小册.exe 打开）');
  };
  /* 待办加条：fields 全为扁平字符串 */
  H.pendingAdd = async function (fields) {
    if (H.mode === 'shell') return bridge('pendingAdd', fields, 120000);
    throw new Error('加待办需桌面壳通道');
  };
  /* ★ 2026-10-23 新增：新建学生（空库第一步）。
     起因（用户实测 BUG#1）：空库里没有任何地方能建"孩子"，新用户进门就堵死。
     校验与落盘都在工具 _建学生.mjs 里，壳只做通道；返回带重建后的 state。 */
  H.createStudent = async function (fields) {
    if (H.mode === 'shell') return bridge('createStudent', fields, 300000);
    throw new Error('新建学生需要桌面壳通道（拾光小册.exe）');
  };
  /* 复习/组卷写入：action ∈ 组卷|批改|撤批|归档|撤归档|状态（白名单在壳侧），flags 全为扁平字符串 */
  H.mark = async function (action, flags) {
    const payload = Object.assign({ action }, flags || {});
    if (H.mode === 'shell') return bridge('mark', payload, 180000);
    throw new Error('「' + action + '」需要桌面壳通道（拾光小册.exe）；浏览器网页版当前只支持查看与待办办结');
  };
  /* 全量重建（生成器重跑），返回新 state；生成器实测 ~5 分钟，超时给 10.5 分钟 */
  H.regen = async function () {
    if (H.mode === 'shell') return bridge('regen', {}, 630000);
    if (H.mode === 'server') { const r = await fetch(H.root + 'api/state', { method: 'POST' }); if (!r.ok) throw new Error('重建失败'); return r.json(); }
    throw new Error('离线模式不能重建');
  };
  /* 读题库内文本文件（错题记录.md 抽屉用） */
  H.readFile = async function (relPath) {
    if (H.mode === 'shell') return bridge('readFile', { path: relPath }, 60000);
    if (H.mode === 'server') { const r = await fetch(H.root + encodeURI(relPath)); if (!r.ok) throw new Error('读取失败'); return { ok: true, text: await r.text() }; }
    throw new Error('离线模式不能读文件');
  };
  /* 交系统/内置阅读器打开（图片/PDF/md）。索引里的 img/origPage 是**百分号编码**形态，
     壳侧 Path.Combine 不做反转义（旧路径靠 new Uri() 顺带解了才没出事），所以这里统一还原成解码相对路径。 */
  H.openFile = function (relPath) {
    const p = H.relPath(relPath);
    if (H.mode === 'shell') return bridge('openFile', { path: p }, 30000);
    window.open(H.asset(relPath), '_blank');
  };
  /* 在文件夹中显示（资源管理器选中该文件）；非壳环境退化为直接打开该文件 */
  H.reveal = function (relPath) {
    if (!relPath) return Promise.resolve({ ok: false, error: '无路径' });
    const p = H.relPath(relPath);
    if (H.mode === 'shell') return bridge('revealFile', { path: p }, 30000)
      .catch(e => { if (CTB.shell && CTB.shell.toast) CTB.shell.toast('资源管理器打不开：' + e.message, 'bad'); });
    window.open(H.asset(relPath), '_blank'); return Promise.resolve({ ok: true });
  };
  H.quit = function () { if (H.mode === 'shell') return bridge('quit', {}, 5000); window.close(); };
  /* 打印（2026-10-11 新增，同日按用户实测反馈定默认值）：
     WebView2 里 `window.print()` 是**空操作**，必须让宿主调 `CoreWebView2.ShowPrintUI`。
     kind 取值：
       · 'browser'（**默认**）→ Edge 打印预览，**渲染在应用窗口内部**（含纸张预览/份数/边距/另存为 PDF）。
         用户实测反馈「原来那个打印界面很好」——就是它；因为是页内浮层，**不会被应用窗口挡在后面**。
       · 'system' → Windows 系统打印对话框（独立窗口）。实测**会弹在应用窗口后面**，用户看不见就以为
         "点了没反应"（壳日志里 5 次连点即由此而来）⇒ 不再作默认。
     返回的 Promise 在**对话框弹出后**即 resolve（宿主 `ShowPrintUI` 是同步 void，不等用户关框），
     所以调用方**不能**靠它清空打印区；超时给 10 分钟以防对话框停留很久。 */
  H.print = function (kind) { return bridge('print', { kind: kind || 'browser' }, 600000); };
  /* 直接打印（2026-10-11 新增，用户要求「像 Word/WPS 点一下就出纸」）：
     走宿主 `PrintAsync` —— **不弹任何对话框**，直接打到指定打印机（不传=系统默认）。
     返回 `{ok, status}`，status 是打印状态枚举（如 Succeeded / PrinterUnavailable），
     页面据此给出"已送往打印机"或"打印机不可用"的**明确**反馈，而不是像以前那样静默。
     超时给 3 分钟（真实打印大卷会久）。 */
  H.printDirect = function (printer) { return bridge('printDirect', { printer: printer || '' }, 200000); };
  /* 把已生成的 PDF 交给系统打印（2026-10-11 新增，用户要的「像 Word/WPS 点一下就出纸」）：
     走 shell 的 print 动词（本机 .pdf 关联 KWPS.PDF.9，其注册表里有 print 动词）。
     实测用它打印那份 963KB 重做卷 → 打印机自身计数器 7965→7968（真印了 3 页）。
     与 printDirect（WebView2 PrintAsync）的区别：后者在本机恒定 OtherError、只生成 0 字节空作业。 */
  H.printPdf = function (relPath) { return bridge('printPdf', { path: relPath }, 60000); };
  /* 存为 PDF（2026-10-11 新增）：**不依赖打印机** —— 用户目标是"打出来给孩子做"，
     但打印对话框能否成功还取决于打印机/驱动。PrintToPdfAsync 直接出 PDF，可再打印/存档/发打印店。
     relPath 必须落在题库根内（壳侧用 TryResolveInsideRoot 校验，越界拒绝）。 */
  H.pdf = function (relPath) { return bridge('pdf', { path: relPath }, 120000); };
})();
