/* 错题本 2.0 · 待办工作台（v2.0b「页内办结」体验的重构版：按「问谁」分区 + 证据图定位 + 直连落库 + 办结包导出兜底）
   2.0.0-rc.2：点证据图进入「带问题上下文的灯箱办结流」——图上看红框，图下看这条在问什么、怎么判、就地写结论办结，办完自动跳下一条 */
(function () {
  const U = CTB.util, M = CTB.model, H = CTB.host, S = CTB.shell;
  const V = CTB.views.pending = {};
  let askFilter = '全部', kindFilter = '全部', showDone = false;
  let viewList = [];      // 当前筛选+排序后的展示列表（灯箱画廊与列表同序）

  V.sub = () => { const n = M.pendingOpen().length; return '未办结 ' + n + ' 条' + (showDone ? '（含已办结展示）' : ''); };

  V.render = function (el) {
    const open = M.pendingOpen();
    const byAsk = M.pendingByAsk();
    const sp = (M.state && M.state.pending) || {};
    const noQref = new Set(sp.noQref || []), noBox = new Set(sp.noBox || []);
    const items = items4view(open);

    el.innerHTML =
      '<div class="askbar">' + M.ASK_ORDER.map(a =>
        '<div class="askstat' + (askFilter === a ? ' on' : '') + (byAsk[a].length >= 5 ? ' stuck' : '') + '" data-ask="' + a + '">' +
        '<b class="num">' + M.ASK_IC[a] + ' ' + byAsk[a].length + '</b><i>问' + a + ' · ' + U.esc(M.ASK_HINT[a]) + '</i></div>').join('') +
      '<div class="askstat' + (askFilter === '全部' ? ' on' : '') + '" data-ask="全部"><b class="num">Σ ' + open.length + '</b><i>全部 · 积压≥5 的区域标红</i></div>' +
      '</div>' +

      '<div class="row" style="margin-bottom:12px">' +
      '<div class="chips" id="pdKinds">' + ['全部'].concat(M.KINDS).map(k => '<span class="chip' + (k === kindFilter ? ' on' : '') + '" data-v="' + U.esc(k) + '">' + U.esc(k) + '</span>').join('') + '</div>' +
      '<span class="tb-sp"></span>' +
      '<label class="opt-item small"><input type="checkbox" id="pdDone"' + (showDone ? ' checked' : '') + '> 显示已办结</label>' +
      '<button class="btn sm" id="pdExport">📤 导出办结包</button>' +
      '<button class="btn sm" id="pdAdd">＋ 记一条新待办</button>' +
      '</div>' +

      ((noQref.size || noBox.size) ? '<div class="pp-note" style="margin-bottom:12px">⚠ 数据完备性：缺题号 ' + noQref.size + ' 条、缺红框 ' + noBox.size + ' 条（题号与证据图是必有字段；可让 agent 跑 <code>定位 --auto</code> 补齐）</div>' : '') +
      /* 2026-10-21：编号重号必须在工作台显式报红。重号时「确认办结」会打到另一条（多为已作废那条），
         表现是"点了没反应/办完还在"，而界面还给绿灯——这条横幅就是让那种静默失效无处藏。 */
      ((sp.dupId && sp.dupId.length) ? '<div class="pp-note bad" style="margin-bottom:12px">⛔ 台账编号重号 ' + sp.dupId.map(d => U.esc(d.id) + '×' + d.count).join('、') + '：同一编号有多条，办结可能落到另一条上（办完不消失）。请让 agent 给拆出来的新条目重新取号。</div>' : '') +
      '<div id="pdList"></div>';

    el.querySelectorAll('[data-ask]').forEach(a => a.onclick = () => { askFilter = a.dataset.ask; S.render(); });
    el.querySelectorAll('#pdKinds .chip').forEach(c => c.onclick = () => { kindFilter = c.dataset.v; S.render(); });
    U.$id('pdDone').onchange = e => { showDone = e.target.checked; S.render(); };
    U.$id('pdExport').onclick = V.exportPkg;
    U.$id('pdAdd').onclick = addDialog;

    const box = U.$id('pdList');
    viewList = items;
    box.innerHTML = items.length ? items.map(p => itemHtml(p, noQref, noBox)).join('')
      : '<div class="card"><div class="empty ready"><div class="e-ic">🧹</div><b>这个分区干净了</b>' +
      '<div class="e-sub">' + (open.length ? '换个「问谁」筛选，还有 ' + open.length + ' 条在其它分区。' : '没有挂起的疑问。新拿不准的问题随时记进来，办结后自动留痕。') + '</div>' +
      '<div class="e-act"><a class="btn sm" data-go="bank">去题库挑几条 →</a></div></div></div>';
    bind(box);
    const p = S.routeParam();
    if (p && p.anchor) {
      const t = U.$id(p.anchor);
      if (t) { t.scrollIntoView({ block: 'center' }); t.classList.add('anchor'); setTimeout(() => t.classList.remove('anchor'), 1800); }
      S.route('pending'); // 清 param
    }
  };

  function items4view(open) {
    let items = askFilter === '全部' ? open.slice() : (open.filter(i => i.askWho === askFilter));
    if (kindFilter !== '全部') items = items.filter(i => i.kind === kindFilter);
    if (showDone) {
      /* F-37：已办结此前按「挂起天数」混排进未办结里，且 `slice(-40)` 依赖台账尾部顺序（列表不稳定）。
         现在：未办结在前、已办结在后按 resolvedAt 倒序，两段各自稳定。 */
      const done = M.pendingItems().filter(i => i.status === '已确认' || i.status === '已作废')
        .slice().sort((a, b) => String(b.resolvedAt || '').localeCompare(String(a.resolvedAt || ''))).slice(0, 40);
      const staleness = x => U.diffDays(x.raisedAt || '2026-01-01', U.today());
      const openSorted = items.slice().sort((a, b) => (staleness(b) || 0) - (staleness(a) || 0));
      const doneSorted = done.slice().sort((a, b) => String(b.resolvedAt || '').localeCompare(String(a.resolvedAt || '')));
      if (askFilter !== '全部') return openSorted;      // 已办结不参与「问谁」分区（分区是未办结的工作面）
      return openSorted.concat(doneSorted);
    }
    const staleness = x => U.diffDays(x.raisedAt || '2026-01-01', U.today());
    return items.sort((a, b) => (staleness(b) || 0) - (staleness(a) || 0));
  }

  function itemHtml(p, noQref, noBox) {
    const stale = U.diffDays(p.raisedAt || U.today(), U.today());
    const done = p.status && p.status !== '未确认';
    const redBar = noQref.has(p.id) ? '<span class="tag bad" title="门禁口径：缺题号">缺题号</span>' : '';
    return '<div class="pd-item" id="pd-' + U.esc(p.id) + '">' +
      '<div class="pd-top"><span class="tag ' + (done ? 'gray' : stale == null || stale >= 3 ? 'bad' : 'warn') + '">' + U.esc(p.id) + '</span>' +
      '<span class="tag gray">' + U.esc(p.kind || '') + '</span>' +
      '<span class="tag info">' + (M.ASK_IC[p.askWho] || '') + ' 问' + U.esc(p.askWho || '') + '</span>' +
      '<span class="small num muted">' + U.esc(p.student || '') + (p.subject ? '·' + U.esc(p.subject) : '') + (p.cardId ? ' · ' + U.esc(p.cardId) : '') + '</span>' +
      '<span class="small muted">' + U.esc(p.raisedAt || '') + ' · 挂起 ' + U.daysText(stale) + '</span>' + redBar +
      (p.qRef ? '<span class="tag ok">' + U.esc(p.qRef) + '</span>' : '') +
      (done ? '<span class="tag ' + (p.status === '已确认' ? 'ok' : '') + '" style="margin-left:auto">' + U.esc(p.status) + '</span>' : '') +
      '</div>' +
      '<div class="pd-q">' + U.esc(p.question || '') + '</div>' +
      (p.detail ? '<div class="pd-x">' + U.esc(p.detail) + '</div>' : '') +
      (p.source ? '<div class="small muted" style="margin-top:6px">来源：' + U.esc(p.source) + (p.evidenceNote ? ' · ' + U.esc(p.evidenceNote) : '') + '</div>' : '') +
      (done ? '<div class="ans" style="margin-top:8px"><b>结论：</b>' + U.esc(p.answer || '') + (p.note ? '（' + U.esc(p.note) + '）' : '') + '</div>' : '') +
      evBlock(p) +
      (done ? '' :
        '<div class="pd-note"><textarea data-ans="' + U.esc(p.id) + '" placeholder="结论/答案（办结必填，作废必写理由）：孩子口述了什么 / 放大原卷看到了什么 / 老师怎么答…" rows="2"></textarea></div>' +
        '<div class="pd-foot">' +
        '<button class="btn sm ok" data-solve="' + U.esc(p.id) + '">✓ 确认办结</button>' +
        '<button class="btn sm danger" data-void="' + U.esc(p.id) + '">🗑 作废</button>' +
        '<button class="btn sm ghost" data-copy="' + U.esc(p.id) + '">📋 复制为本地结论（导出办结包再同步）</button>' +
        (p.cardId && /\w/.test(p.cardId) ? '<button class="btn sm ghost" data-card="' + U.esc(p.student) + '|' + U.esc(p.cardId) + '">🔍 去关联卡</button>' : '') +
        '<span class="localflag small" data-flag="' + U.esc(p.id) + '"></span></div>') +
      '</div>';
  }

  /* ---------- 证据图：坏了要喊出来，不许静默破图（v2.5，2026-10-10） ----------
     起因：用户看到 T086 待办里只有一张加载失败的破图 + 点不动的「打开原图」，
     报「这个待办有问题，没有图形链接」。根因是台账里那条 evidence 写成了通配符路径
     （P0034-＊/原卷截图.jpg，文件永远不存在），而界面只会干等 <img> 加载失败。
     现在三重防线：① 状态包带 evidenceOk=false 时直接渲染红块，根本不发那个请求；
                  ② 加载途中失败 onerror 兜底，把破图换成可读的红块（含路径与补图命令）；
                  ③ 图不可用时不给「打开原图」死按钮——那按钮点了只会静默失败。 */
  function evMissHtml(p, why) {
    return '<div class="pd-evmiss">' +
      '⚠ <b>证据图不可用</b>（' + U.esc(why) + '）：<code>' + U.esc(p.evidence || '（空）') + '</code>' +
      '<br>补法：<code>node _待确认.mjs 定位 --id ' + U.esc(p.id) + ' --evidence "九年级/&lt;学科&gt;/&lt;卡目录&gt;/原卷截图.jpg" --box "x,y,w,h"</code>' +
      '<br>全库自查：<code>node _待确认.mjs 证据</code></div>';
  }
  function evBlock(p) {
    if (!p.evidence) return evMissHtml(p, '缺图（必有字段）');
    if (p.evidenceOk === false) return evMissHtml(p, '文件不在或路径非法');
    /* F-38：图坏了要喊出来，但**不许连「🗂 打开原图」一起删掉**（用户还要靠它去核对/补图）；
       红块里保留按钮 + 一个「重试加载」。 */
    return '<div class="pd-img">' +
      '<img loading="lazy" class="pd-ev" data-zoom="' + U.esc(p.evidence) + '" data-rel="' + U.esc(p.evidence) + '" data-box="' + U.esc((p.box || []).join(',')) + '" src="' + U.esc(H.asset(p.evidence)) + '" alt="证据图" onerror="CTB.pendingEvErr(this)">' +
      /* 2026-10-16 口径（用户定案：裁图=截图，原图=整页）：这张开的是**证据截图**，
         不是原图；原图在灯箱里（点图 → ⇄ 原图）。此前写「打开原图」就是把截图冒充原图。 */
      '<button class="btn xs ghost" data-open="' + U.esc(p.evidence) + '">🗂 打开截图</button></div>';
  }
  /* 给内联 onerror 用的全局钩子（图片可能在 bind() 之前就已失败）。
     F-38：只把 <img> 换成红块，**保留外层的 .pd-img 与「🗂 打开原图」**，并给一个重试入口。 */
  CTB.pendingEvErr = function (img) {
    if (!img || !img.parentNode) return;
    const rel = img.getAttribute('data-rel') || '';
    const box = img.getAttribute('data-box') || '';
    const red = U.h('div', { class: 'pd-evmiss', html:
      '⚠ <b>证据图加载失败</b>（文件不存在或路径非法）：<code>' + U.esc(rel) + '</code>' +
      (box ? '　红框：<code>' + U.esc(box) + '</code>' : '') +
      '<br>这条待办现在看不到题，请补图或换图：<code>node _待确认.mjs 定位 --id … --evidence "…/原卷截图.jpg"</code>' });
    const retry = U.h('button', { class: 'btn xs ghost', text: '⟳ 重试加载' });
    retry.onclick = () => { red.remove(); img.style.display = ''; img.src = H.asset(rel) + (rel.indexOf('?') < 0 ? '?r=' + Date.now() : '&r=' + Date.now()); };
    red.appendChild(retry);
    img.style.display = 'none';
    img.parentNode.insertBefore(red, img);
  };

  function bind(box) {
    box.querySelectorAll('[data-zoom]').forEach(img => img.onclick = () => {
      const host = img.closest('.pd-item');
      openLbAt(host ? host.id.replace(/^pd-/, '') : null);
    });
    box.querySelectorAll('[data-open]').forEach(b => b.onclick = () => H.openFile(b.dataset.open));
    box.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => {
      const ta = box.querySelector('[data-ans="' + b.dataset.copy + '"]');
      if (!ta.value.trim()) return S.toast('先写结论', 'warn');
      V.localSet(b.dataset.copy, { action: '答', answer: ta.value.trim() });
      box.querySelector('[data-flag="' + b.dataset.copy + '"]').textContent = '✔ 已存本地结论（导出包待同步）';
      S.toast('已记入本地办结草稿；点右上「导出办结包」或直接「落库」', 'ok');
    });
    box.querySelectorAll('[data-solve]').forEach(b => b.onclick = () => resolve(b.dataset.solve, '答'));
    box.querySelectorAll('[data-void]').forEach(b => b.onclick = () => resolve(b.dataset.void, '作废'));
    box.querySelectorAll('[data-card]').forEach(b => b.onclick = () => {
      const [kid, cid] = b.dataset.card.split('|');
      const x = M.cards.find(c => c.kid === kid && c.card.id === cid);
      if (!x) return S.toast('关联卡不在当前范围（或还没入册）', 'warn');
      S.route('bank', { openKey: x.key });
    });
  }

  /* ---------- 灯箱办结流（rc.2：图上有红框，图下有这条的问题/判法/办结操作） ---------- */
  const howto = p => ({
    原卷: '这条能当场定：点图进灯箱按 P 切「原图（整页）」放大看红框区域，把看到的具体特征写进结论（如「黑笔在 A 处起笔，支点选 A」），点确认办结。',
    /* 2026-10-19 用户口径：家里两个都是男孩，指代一律用「他」，禁用「TA」——
       这条回话 2026-10-16 就写在 T092 的结论里（"学生A与学生B都是男孩，可以用他"），
       但结论没人消费、界面文案一直挂着 TA（L-373③ 的又一次显形：回话落库 ≠ 回话生效）。 */
    孩子: '这条要问孩子：拿着这张图问他当时怎么想的，把口述原话记进结论再办结。',
    老师: '这条要问老师：可在灯箱按 ⇄ 切到整页原图后截图发老师，答复记进结论后办结。',
    系统: '这条是数据/工具待修项：写清修法办结，或注明已由谁处理。',
  }[p.askWho] || '看图判断，把结论写进下方再办结。');
  /* 2026-10-15 用户口径：裁图=截图；原图=这道题所在的原始整页。灯箱切换按钮与 🗂 都按此语义。 */
  function buildGallery() {
    /* evidenceOk === false（文件不在/路径非法）不进灯箱——进去只会是一块空白，
       而灯箱本来就该是「看图办结」的地方。列表里那些条目会显示红块和补图命令。 */
    return viewList.filter(p => p.evidence && p.evidenceOk !== false && (!p.status || p.status === '未确认'));
  }
  function gItem(p) {
    /* 2026-10-15 用户指正：待办灯箱此前 orig=证据图自身 ⇒ 「⇄/🗂」开到的还是裁图，永远到不了整页。
       现在按 student|cardId 反查题卡，接原卷溯源三件套（M.origOf，与卡片/复习流同一实现）。
       2026-10-16 补第二级回落（T097~T105 实测）：**无卡待办**（cardId 空，"先补录题干再建卡"那类）
       反查不到卡 ⇒ 仍回落裁图。现在回落到台账待办级 origPage/origBox（_待确认.mjs 定位 --origpage 登记，
       门禁 --json 透传）——两级都接不通才回落裁图，且 origBy 会如实写「待办证据图」。 */
    let orig = null, origBox = null, origImport = null, origBy = null;
    const x = (p.cardId && /\w/.test(p.cardId || ''))
      ? M.cards.find(c => c.kid === (p.student || '') && c.card.id === p.cardId) : null;
    const three = x ? M.origOf(x.card) : null;
    /* v2.7（2026-10-19）修：优先级必须**先看待办自己登记的整页**，再退到题卡的整页。
       起因（用户原话）：「错题库中的待办，你提出的问题，与你给出的切图，完全不对应」。
       实测 39 条未确认里 25 条「待办问的题」与「题卡是哪道题」根本不在同一页
       （例：T154 问第 8 页，题卡 E0011 在第 12 页）——旧代码先走 M.origOf(卡)，
       于是「⇄ 原图」开到的永远是**卡所在的那页**，还是错的。
       现在：p.origPage（待办级整页，_待确认.mjs 定位 --origpage 登记）优先，
       卡整页只在待办没登记时才兜底。 */
    if (p.origPage && p.origPage !== p.evidence) {
      orig = p.origPage;                                     // 原始相对路径，H.asset 会整段 encodeURI（与 evidence 同通道）
      origBox = (p.origBox && p.origBox.length === 4) ? p.origBox : null;
      origBy = '待办登记的整页';
    } else if (three && three.orig && three.orig !== p.evidence) {
      orig = three.orig; origBox = three.origBox; origImport = three.origImport; origBy = three.origBy || '原卷台账';
    }
    const hasOrig = !!orig;
    return {
      src: H.asset(p.evidence), rel: p.evidence,
      orig: hasOrig ? orig : p.evidence,
      origBox: hasOrig ? origBox : null,
      origImport: hasOrig ? origImport : null,
      origBy: hasOrig ? origBy : '待办证据图',
      title: '待办 ' + p.id + ' · ' + (p.student || '') + (p.subject ? '·' + p.subject : '') + ' · ' + (p.source || ''),
      chips: '<span class="tag warn">' + U.esc(p.id) + '</span><span class="tag gray">' + U.esc(p.kind || '') + '</span>' +
        '<span class="tag info">' + (M.ASK_IC[p.askWho] || '') + ' 问' + U.esc(p.askWho || '') + '</span>' +
        (p.qRef ? '<span class="tag ok">📍 ' + U.esc(p.qRef) + '</span>' : ''),
      q: p.question, detail: p.detail || '', hint: howto(p),
      box: (p.box && p.box.length === 4) ? p.box : null,
      foot: '<textarea id="lbAns" rows="2" placeholder="结论/答案（办结必填，作废必写理由）：放大后看到了什么 / 孩子口述了什么 / 老师怎么答…"></textarea>' +
        '<button class="btn ok" data-lbsolve>✓ 确认办结</button><button class="btn danger" data-lbvoid>🗑 作废</button>' +
        '<span class="small">Esc 关闭 ｜ ←→ 换条 ｜ 办结后自动跳下一条</span>',
      onMount: el => {
        const ta = el.querySelector('#lbAns');
        el.querySelector('[data-lbsolve]').onclick = () => resolve(p.id, '答', ta.value, true);
        el.querySelector('[data-lbvoid]').onclick = () => resolve(p.id, '作废', ta.value, true);
        if (ta) ta.focus();
      },
    };
  }
  function openLbAt(id, forcedIdx) {
    const g = buildGallery();
    if (!g.length) return S.toast('这个范围里没有带证据图的未办结待办', 'warn');
    let idx = forcedIdx != null ? forcedIdx : Math.max(0, g.findIndex(p => p.id === id));
    S.lightbox(g.map(gItem), idx);
  }

  async function resolve(id, action, answerIn, fromLb) {
    let answer = answerIn != null ? String(answerIn).trim() : '';
    if (answerIn == null) { const ta = document.querySelector('[data-ans="' + id + '"]'); answer = (ta ? ta.value : '').trim(); }
    if (!answer) { S.toast(action === '作废' ? '作废必须写理由（防无留痕作废）' : '先写结论再办结', 'warn'); if (!fromLb) { const ta = document.querySelector('[data-ans="' + id + '"]'); ta && ta.focus(); } return; }
    if (H.mode !== 'shell' && H.mode !== 'server') { V.localSet(id, { action, answer }); S.toast('离线：已存本地，导出包可交 agent 落库', 'warn'); return; }
    try {
      const st = await H.pendingResolve([{ id, action, answer }]);
      if (st && st.ok === false) throw new Error(st.error || '工具拒绝');
      /* ⚠ 2026-10-11（F-34 + F-33）：此前先 `M.applyState(pkg)` 再 `V.localDel(id)`——
         applyState 抛错时 catch 会**又写一遍本地草稿**并提示「落库失败」，而其实已落库（界面自相矛盾）。
         现在：① 先按逐条 `results` 判这条到底落没落库（`ok` 才算）；② 落库确认后先清草稿；
         ③ applyState 单独 try（状态包坏了不该把「已落库」说成失败）。 */
      const oc = M.pkgOutcome(st && st.results, [id]);
      const hasResults = !!(st && Array.isArray(st.results) && st.results.length);
      /* ⚠ 2026-10-21 修（用户报障「办完之后还会弹出来，不能消失」的**第三个**根因）：
         旧判据是 `hasResults && 没落库 → 报错` ⇒ **results 为空时直接放行**，照弹绿字「已落库」
         并清掉本地草稿。而 results 为空恰恰说明"没拿到逐条结果"，落没落库一无所知——
         桌面壳解析器只认 T0xx（见 CTBShellV2.ParseResults 的注释）时，T1xx 就是这种情况，
         用户看到成功、待办不动，连本地草稿也被清了（重试的线索一并丢失）。
         现在：**拿不到逐条结果 = 落库未证实**，一律报错并保留草稿，不许再假报成功。 */
      if (!hasResults) throw new Error('工具没有返回逐条落库结果，无法确认这条是否已落库');
      if (oc.del.indexOf(id) < 0) throw new Error('工具未落库：' + statusCn(oc.keep.length ? oc.keep[0].status : 'unknown'));
      V.localDel(id);
      try { M.applyState((st && st.state) || st); }
      catch (e2) {
        console.error(e2);
        S.toast('已落库 ' + id + '，但状态包应用失败：' + e2.message + '——点右上 ⟳ 重刷', 'warn', 9000);
      }
      S.toast('已落库 ' + id + '（工具幂等，重复提交不会双计）', 'ok');
      S.render();
      if (fromLb) {                        // 办结流：自动推进到下一条（原位置顺延）
        const pos = (S.lbIndex ? S.lbIndex() : 0) || 0;
        const g = buildGallery();
        if (!g.length) { S.closeLightbox(); S.toast('本范围未办结待办已清零 🎉', 'ok', 6000); }
        else openLbAt(null, Math.min(pos, g.length - 1));
      }
    } catch (e) { V.localSet(id, { action, answer }); S.toast('直连落库失败：' + e.message + '（已存本地，可走导出包）', 'bad', 7000); }
  }

  /* ---------- 本地办结草稿（localStorage 临时台账；导出包/同步后清） ---------- */
  V.localGet = () => U.lsGet('ctb2.pendingLocal', {});
  V.localSet = (id, v) => { const m = V.localGet(); m[id] = v; U.lsSet('ctb2.pendingLocal', m); };
  V.localDel = id => { const m = V.localGet(); if (m[id]) { delete m[id]; U.lsSet('ctb2.pendingLocal', m); } };
  /* 逐条结果落账（F-33 的核心，抽出来是为了能被断言直接调用）：
     只清 `status==='ok'` 条目的本地草稿，missing/skipped 一律**保留**并把原因说给用户听。
     ⚠ 2026-10-11（F-33，高）：此前 exportPkg 只看 `st.ok === false`（壳返回 `results:[{status:'missing'}]`
     时 ok 恒为 true）就 `lsDel('ctb2.pendingLocal')` **抹掉全部未落库结论** ⇒ 被拒那条永久丢失。
     判据（M.pkgOutcome）与结果分类同源一处，不在这里重算。 */
  V.applyPkgResults = function (results, ids) {
    const oc = M.pkgOutcome(results, ids);
    for (const id of oc.del) V.localDel(id);
    return { cleared: oc.del, kept: oc.keep, unknown: oc.keep.filter(k => k.status === 'unknown').map(k => k.id) };
  };
  V.exportPkg = async function () {
    const local = V.localGet();
    const ids = Object.keys(local);
    if (!ids.length) return S.toast('本地没有未导出的结论（在每条待办里先写结论再点「复制为本地结论」或落库失败自动进）', 'warn');
    const pkg = { exportedAt: new Date().toISOString(), tool: 'ctb-v2', resolves: ids.map(id => ({ id, action: local[id].action, answer: local[id].answer })) };
    const txt = JSON.stringify(pkg, null, 1);
    try { await navigator.clipboard.writeText(txt); } catch (e) { }
    const blob = new Blob([txt], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ctb-pending-' + U.today() + '.json';
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    if (H.mode === 'shell' || H.mode === 'server') {
      /* 2026-10-25 换 S.confirm：壳里原生 confirm 不可见且冻结整页（见 shell.js S.confirm 注释） */
      if (await S.confirm({
        title: '办结包已生成，现在直接落库吗？',
        body: '检测到落库通道。只清除<b>成功</b>条目的本地草稿；被工具拒的会原样保留。',
        ok: '直接落库',
      })) {
        try {
          const st = await H.pendingResolve(pkg.resolves);
          if (st && st.ok === false) throw new Error(st.error || '工具拒绝');
          const rr = V.applyPkgResults(st && st.results, ids);
          M.applyState((st && st.state) || st);
          S.toast('办结包已提交：落库 ' + rr.cleared.length + ' 条' +
            (rr.kept.length ? '，保留 ' + rr.kept.length + ' 条（' + rr.kept.map(k => k.id + '：' + statusCn(k.status)).join('；') + '）——这几条没落库，草稿还在' : ''),
            rr.kept.length ? 'warn' : 'ok', rr.kept.length ? 12000 : 5000);
          S.render(); return;
        } catch (e) { S.toast('落库失败：' + e.message + '（本地草稿全部保留）', 'bad', 9000); }
      }
    } else {
      S.toast('办结包已导出：把文件放进题库根目录后告诉 agent「同步办结包」即可落库', '', 7000);
    }
  };
  /* 结果状态 → 人话（ok/skipped/missing/unknown 是壳与工具的唯一口径） */
  function statusCn(s) {
    return { ok: '已落库', skipped: '已是终态被跳过', missing: '台账里没有这个编号', unknown: '未返回该条结果' }[s] || s;
  }

  /* ---------- 加待办 ---------- */
  /* F-35：红框输入校验（台账口径 0~1 归一化，四个数、0≤x≤1、0≤y≤1、0<w≤1、0<h≤1） */
  function boxNorm(s) {
    const parts = String(s || '').split(/[,，\s]+/).filter(Boolean).map(Number);
    if (parts.length !== 4 || parts.some(n => !Number.isFinite(n))) return '';
    const [x, y, w, h] = parts;
    if (x < 0 || y < 0 || w <= 0 || h <= 0 || x > 1 || y > 1 || w > 1 || h > 1) return '';
    return parts.join(',');
  }
  function addDialog() {
    const kids = M.students();
    S.drawer({
      title: '＋ 记一条新待办（进 _待确认.json 唯一真源）',
      body: '<div class="stack" style="gap:11px">' +
        '<div class="opt-item">学生 <select id="paKid">' + kids.map(k => '<option>' + U.esc(k) + '</option>').join('') + '</select>' +
        '　学科 <input type="text" id="paSubj" style="width:110px" placeholder="数学"></div>' +
        '<div class="opt-item">关联卡号 <input type="text" id="paCard" style="width:120px" placeholder="P0012">　类型 <select id="paKind">' + M.KINDS.map(k => '<option>' + k + '</option>').join('') + '</select>' +
        '　问谁 <select id="paAsk">' + M.ASK_ORDER.map(k => '<option>' + k + '</option>').join('') + '</select></div>' +
        '<textarea id="paQ" maxlength="800" placeholder="问题一句话（必填）"></textarea>' +
        '<textarea id="paD" maxlength="2000" placeholder="证据/影响（可选）" rows="2"></textarea>' +
        /* F-35：C# AddFlag 支持 --box、_待确认.mjs:322 也读 opt.box，此前表单没有它 ⇒
           新建条目永远没有高亮框（灯箱里看不到红框）。现在补上并透传。 */
        '<div class="opt-item">题号 qRef <input type="text" id="paQref" style="flex:1" placeholder="第12(2)题（留空按卡号自动推导）">　来源 <input type="text" id="paSrc" style="flex:1" placeholder="哪张卷/哪次课"></div>' +
        '<div class="opt-item">证据图红框 <input type="text" id="paBox" style="width:190px" placeholder="x,y,w,h（0~1 归一化，可留空）">　' +
        '<span class="small muted">台账口径 0~1；留空则该条没有红框，灯箱只能裸看整页</span></div>' +
        '<div class="opt-item">证据图相对路径 <input type="text" id="paEv" style="flex:1" placeholder="九年级/原卷/xxx.jpg（强烈建议给）"></div>' +
        (H.mode !== 'shell' ? '<div class="pp-note">当前非桌面壳通道，加条目会失败（落库需 <b>拾光小册.exe</b>）。</div>' : '') +
        '</div>',
      footer: '<span class="small muted" style="flex:1">门禁规矩：拿不准的当场记，别只在脑子里记</span><button class="btn" id="paCancel">取消</button><button class="btn primary" id="paOk">记入台账</button>',
      onMount: () => {
        U.$id('paCancel').onclick = S.closeDrawer;
        U.$id('paOk').onclick = async () => {
          const q = U.$id('paQ').value.trim();
          if (!q) return S.toast('问题不能空', 'warn');
          const fields = {
            student: U.$id('paKid').value, subject: U.$id('paSubj').value.trim(), card: U.$id('paCard').value.trim(),
            kind: U.$id('paKind').value, ask: U.$id('paAsk').value, q, detail: U.$id('paD').value.trim(),
            source: U.$id('paSrc').value.trim(), qref: U.$id('paQref').value.trim(),
            evidence: U.$id('paEv').value.trim(), box: boxNorm(U.$id('paBox').value), date: U.today(),
          };
          try {
            const r = await H.pendingAdd(fields);
            if (!r || r.ok === false) throw new Error((r && (r.error || r.out) || '工具拒绝').slice(0, 300));
            S.closeDrawer();
            M.applyState(r.state || await H.getState());
            S.toast('已记入台账（' + (r.newId || 'Txxx') + '）', 'ok'); S.render();
          } catch (e) { S.toast('加待办失败：' + e.message, 'bad', 7000); }
        };
      },
    });
  }
})();
