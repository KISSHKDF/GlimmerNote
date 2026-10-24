/* 错题本 2.0 · 组卷工作台（题源=勾选篮 or 筛选直入；排卷走「答案折叠」：重排题干+自适应答题区；
   打印/落账分开两步：先「生成可打印卷」纸面重做（b1），回录才动台账；泄答案防线沿用 v1） */
(function () {
  const U = CTB.util, M = CTB.model, H = CTB.host, S = CTB.shell;
  const V = CTB.views.paper = {};
  let sheet = null;           // {title, refs:[x], opts}
  let mode = 'compose';       // compose | preview | ledger

  V.sub = () => mode === 'ledger' ? '台账与回录' : (sheet ? '卷「' + sheet.title + '」' + sheet.refs.length + ' 题' : '篮里 ' + M.basketCount() + ' 题');

  V.onParam = function (p) { if (p && p.reset) { mode = 'compose'; sheet = null; } };

  V.render = function (el) {
    if (mode === 'ledger') return ledgerView(el).catch(e => console.error('[paper] 台账渲染失败：', e));
    if (mode === 'preview' && sheet) return previewView(el);
    composeView(el);
  };

  /* ---------- 配卷 ---------- */
  function composeView(el) {
    const basket = M.basketCards();
    const blocked = basket.filter(x => !M.canGroup(x.card));
    const subjects = [...new Set(M.cardsOf().map(x => x.subject))];
    const kids = [...new Set(basket.map(x => x.kid))];
    const defTitle = (kids.join('、') || M.student()) + '错题重做卷 ' + U.today();   /* 默认卷名跟篮子走，不缓存旧学生 */
    el.innerHTML =
      '<div class="grid g-12">' +
      '<div class="card" style="align-self:start"><div class="card-h"><b>🧾 组卷选项</b></div>' +
      '<div class="stack" style="gap:12px">' +
      '<div class="opt-item" style="flex-wrap:wrap">卷名 <input type="text" id="ppTitle" style="flex:1;min-width:180px" value="' + U.esc(defTitle) + '"></div>' +
      '<div class="opt-item" style="flex-wrap:wrap"><span style="white-space:nowrap">出题形态</span> <select id="ppForm" style="flex:1"><option value="stem">' + '重排题干（优先印刷版）' + '</option><option value="img">裁净题干图（题干.jpg，缺则自动降级重排题干）</option></select></div>' +
      '<label class="opt-item"><input type="checkbox" id="ppAns" checked> 附带答案册（单独一页，家长批改用）</label>' +
      '<label class="opt-item"><input type="checkbox" id="ppInter" checked> 学科内按难度打乱（防位置记忆；生成预览时洗一次，此后入账/打印/答案册/回录都用这一份顺序）</label>' +
      '<div class="small muted" style="border-top:1px dashed var(--line);padding-top:10px">排卷规则：选择/判断不留作答区；填空有坑就地写（坑宽 ≈31mm），无坑留 90px 答题条；计算/解答按难度留 180/280px。</div>' +
      '</div></div>' +

      '<div class="card"><div class="card-h"><b>🎯 选题篮（' + basket.length + '）</b>' +
      '<span class="hint">在「题库浏览」点 🧾入篮；也可下面快捷圈题</span>' +
      '<span class="card-act">' +
      (H.mode === 'shell' ? '' : '<span class="small" style="color:var(--warn)">⚠ 需桌面壳才能落账</span>') +
      '<button class="btn sm ghost" id="ppClear">清空</button>' +
      '<button class="btn sm primary" id="ppPrev"' + (basket.length ? '' : ' disabled') + '>👁 生成试卷预览（打印按钮在预览页右上）</button></span></div>' +

      '<div class="stack" style="gap:10px">' +
      '<div id="ppRepeat"></div>' +
      (blocked.length ? '<div class="pp-note">⚠ ' + blocked.length + ' 题没过准入（盲解/答案来源），落账时工具会拦：' + blocked.map(x => U.esc(x.card.id) + (M.admitWhy(x.card) ? '（' + U.esc(M.admitWhy(x.card)) + '）' : '')).join('、') + '</div>' : '') +
      '<div class="row"><span class="small muted">快捷圈题：</span>' +
      '<button class="btn xs" data-auto="due">全部到期题</button>' +
      '<button class="btn xs" data-auto="err">错2次以上的</button>' +
      subjects.map(s => '<button class="btn xs" data-auto="sj:' + U.esc(s) + '">' + U.esc(s) + '未复习</button>').join('') +
      '<span class="small muted">（进复习流的题走「复习流」直接判分，不进这里）</span></div>' +
      (basket.length ? '<div class="pp-lines">' + basket.map((x, i) => line(x, i)).join('') + '</div>'
        : '<div class="empty"><div class="e-ic">🧺</div><b>篮子是空的</b>去题库浏览勾选，或点上面「快捷圈题」</div>' +
        '<div class="row"><button class="btn" data-go="bank">📚 去题库选题</button></div>') +
      '</div></div></div>' +

      /* 底部操作条（rc.5 找回 v1 的浮动条：下一步去哪，永远摆在眼前） */
      '<div class="card pp-basket" style="margin-top:16px"><div class="row">' +
      '<b style="font-size:16px">已选 <span class="num" style="color:var(--brand)">' + basket.length + '</span> 题</b>' +
      '<span class="small muted">跨学科会自动拆成多张卷、多个批次；被盲解/答案来源门禁拦的题入账时可剔除</span>' +
      '<span class="tb-sp"></span>' +
      '<button class="btn ghost" id="pbClear2"' + (basket.length ? '' : ' disabled') + '>清空</button>' +
      '<button class="btn" id="pbLedger2">📒 台账 / 回录</button>' +
      '<button class="btn primary" style="font-size:15px;padding:12px 22px" id="pbPrev2"' + (basket.length ? '' : ' disabled') + '>🖨 下一步：生成试卷预览并打印 →</button>' +
      '</div></div>';

    U.$id('ppClear').onclick = () => { M.basketClear(); };
    el.querySelectorAll('[data-auto]').forEach(b => b.onclick = () => {
      const v = b.dataset.auto;
      let list = [];
      if (v === 'due') list = M.cardsOf().filter(x => M.dueInfo(x.card).code === 'due' && M.canGroup(x.card));
      else if (v === 'err') list = M.cardsOf().filter(x => (x.card.errorCount || 1) >= 2 && M.canGroup(x.card));
      else { const sj = v.slice(3); list = M.cardsOf().filter(x => x.subject === sj && !x.card.reviewCount && M.canGroup(x.card)); }
      const cur = new Set(M.basket()); list.forEach(x => cur.add(x.kid + '|' + x.card.id)); M.basketSet([...cur]);
      S.toast('圈入 ' + list.length + ' 题（现 ' + M.basket().length + '）', 'ok');
    });
    U.$id('ppPrev').onclick = goPreview;
    U.$id('pbPrev2').onclick = goPreview;
    U.$id('pbClear2').onclick = () => { M.basketClear(); };
    U.$id('pbLedger2').onclick = () => { mode = 'ledger'; S.render(); };
    function goPreview() {
      /* 2026-10-16（P20261015-01 事故根因之一）：preview 模式下再次 goPreview 会**重新洗牌**——
         同一张卷预览一次、入账一次，中间任何一次重进预览都可能换序 ⇒ 卷面/答案册/台账三序分裂。
         现在：同一份 sheet 已存在且**题目集合**没变时，保留既有顺序（比集合不比顺序——洗牌后
         两者本就不同序）；要换序就「清空」重选或改篮子内容。 */
      const now = M.basketCards().filter(x => M.canGroup(x.card));
      const sameSet = sheet && sheet.refs && sheet.refs.length === now.length &&
        sheet.refs.every(x => now.some(y => y.kid === x.kid && y.card.id === x.card.id));
      if (sameSet) {
        sheet.title = U.$id('ppTitle').value.trim() || defTitle;
        S.toast('卷序沿用已生成的这份（不重洗；要换序请改篮子或清空重选）', 'ok');
        mode = 'preview'; S.render(); return;
      }
      const refs = now;
      if (!refs.length) return S.toast('篮里没有可组卷的题（都未过盲解？）', 'warn');
      if (U.$id('ppInter').checked) shuffleWithin(refs);
      sheet = { title: U.$id('ppTitle').value.trim() || defTitle, refs, form: U.$id('ppForm').value, ans: U.$id('ppAns').checked };
      mode = 'preview'; S.render();
    }
    bindLines();
    /* 重复印卷自检（2026-10-24 用户报障：「我给学生A出了两次试卷，发现第一次与第二次题目是一样的」）：
       篮子是 localStorage 持久化的，入账后原来不清空 ⇒ 再进这页还是同一批题，一点预览+入账就再印一遍
       （实测 P20261021-01 与 P20261024-01 交集 30/30）。这里在配卷屏就把"近 7 天已经印过"的题标出来，
       并给一个按钮一键剔除；入账时工具侧还会再硬拦一次（双保险，工具是唯一入口）。 */
    loadLedgerCache().then(() => paintRepeat());
  }
  /* ---------- 近 7 天已印过的题（防重复组卷） ----------
     判据与工具侧 _标记复习.mjs 的「防重复组卷门禁」同口径：同一学生、日期在最近 REPEAT_DAYS 天内、
     非作废批次里出现过的题。工具那边是硬门禁（exit 2），这里只是"让人先看见"。 */
  const REPEAT_DAYS = 7;
  let _ledgerCache = null;
  function ledgerBatches() { return _ledgerCache || []; }
  function loadLedgerCache() {
    return H.readFile('_组卷台账.json').then(r => {
      try { _ledgerCache = (JSON.parse((r && r.text) || '{}').batches) || []; } catch (_) { _ledgerCache = []; }
      return _ledgerCache;
    }).catch(() => { _ledgerCache = []; return _ledgerCache; });
  }
  /* key(kid|id) → {paperId,date,status}：取最近一次印它的批次 */
  function recentPrinted() {
    const since = U.addDays(U.today(), -REPEAT_DAYS);
    const m = {};
    for (const b of ledgerBatches()) {
      if (b.status === '已作废') continue;
      if (!b.date || String(b.date) < since) continue;
      for (const id of (b.items || [])) {
        const k = (b.student || '') + '|' + id;
        if (!m[k] || String(b.date) >= String(m[k].date)) m[k] = { paperId: b.paperId, date: b.date, status: b.status };
      }
    }
    return m;
  }
  function repeatOfBasket() {
    const m = recentPrinted();
    return M.basketCards().filter(x => m[x.kid + '|' + x.card.id]);
  }
  function paintRepeat() {
    const box = U.$id('ppRepeat');
    if (!box) return;
    const rep = repeatOfBasket();
    if (!rep.length) { box.innerHTML = ''; return; }
    const m = recentPrinted();
    const detail = rep.map(x => {
      const r = m[x.kid + '|' + x.card.id];
      return U.esc(x.card.id) + '（' + U.esc(r.date) + ' ' + U.esc(r.paperId) + '）';
    }).join('、');
    box.innerHTML = '<div class="pp-note" style="border-left:4px solid var(--bad)">⚠ <b>篮里有 ' + rep.length + ' 题最近 ' + REPEAT_DAYS + ' 天已经印过卷</b>（' + detail + '）。' +
      '同一套题短期内重印，孩子是照答案默写，这次判的「对」不代表掌握，会污染连对与建议复习日。' +
      '<br>纸卷丢了要原样重印 → 去台账点「👁 看这张卷」直接重印当初那张，<b>不新建批次</b>。' +
      '<div class="row" style="margin-top:8px"><button class="btn sm" id="ppDropRep">从篮里剔除这 ' + rep.length + ' 题</button>' +
      '<span class="small muted">留着也能继续，但入账时工具会硬拦（需 --force 才放行）</span></div></div>';
    const b = U.$id('ppDropRep');
    if (b) b.onclick = () => {
      const drop = new Set(rep.map(x => x.kid + '|' + x.card.id));
      M.basketSet(M.basket().filter(k => !drop.has(k)));
      S.toast('已剔除 ' + rep.length + ' 题（近 ' + REPEAT_DAYS + ' 天印过）', 'ok');
      S.render();
    };
  }
  function shuffleWithin(refs) {
    const g = {};
    for (const x of refs) (g[x.subject] = g[x.subject] || []).push(x);
    const out = [];
    for (const k in g) {
      const arr = g[k];
      for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[arr[i], arr[j]] = [arr[j], arr[i]]; }
      out.push(...arr);
    }
    refs.length = 0; refs.push(...out);
  }
  function line(x, i) {
    return '<div class="pp-line"><span class="no">' + (i + 1) + '</span>' +
      '<span class="tag sj" style="background:' + U.sjColor(x.subject) + '"> ' + U.esc(x.subject) + '</span>' +
      '<span class="small num">' + U.esc(x.card.id) + '</span>' +
      '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + U.esc(x.card.question) + '</span>' +
      '<span class="diff-' + U.esc(x.card.difficulty) + ' small strong">' + U.esc(x.card.difficulty || '') + '</span>' +
      '<button class="btn xs ghost" data-rm="' + U.esc(x.kid + '|' + x.card.id) + '">✕</button></div>';
  }
  function bindLines() {
    document.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => {
      M.basketSet(M.basket().filter(k => k !== b.dataset.rm));   // 直接按键删（kid|id 唯一，无需再查卡）
      S.render();
    });
  }

  /* ---------- 卷面预览 ---------- */
  function previewView(el) {
    /* F-28：卷面渲染期间发生 M.applyState（autoReload 到点/换学生）时索引为 undefined → 此前整页抛错。
       现在先自检 sheet 形态，坏了就退回配卷屏（sheet 还在内存里，点「回编卷」还能恢复）。 */
    if (!sheet || !Array.isArray(sheet.refs) || !sheet.refs.length || !sheet.refs.every(x => x && x.card)) {
      mode = 'compose'; return composeView(el);
    }
    const refs = sheet.refs;
    /* F-29：此前只比**数量**（`Object.keys(committed).length >= groupKeys(refs).length`），
       篮子内容在两次入账之间变化时（数量恰好相同）会显示「已入账 ✓」而新题其实没入账。
       改成逐键核对，与 commitPaper 的 groups 构造同口径。 */
    const allCommitted = sheet.committed && groupKeys(refs).every(k => sheet.committed[k]);
    /* 从台账复原出来的卷（sheet.batch）：本来就是既成批次，**不能再入账一次**（会多建一张重复的卷）。 */
    const fromBatch = !!sheet.batch;
    el.innerHTML =
      /* 操作条吸顶（2026-10-24 用户报障：「回台账的按钮很小，不容易发现；更关键的是往下拉一段屏幕后这个按钮没跟下来」）：
         卷面很长（30 题），滚到第 11 题时顶部按钮已经滚出视野 ⇒ 想回台账只能一路滚回顶部。
         .pv-bar 用 position:sticky 钉在 #view 的滚动容器顶端，任何位置都能回退。 */
      '<div class="row pv-bar">' +
      '<button class="btn" id="pvBack">' + (fromBatch ? '← 回台账' : '← 回编卷') + '</button>' +
      '<span class="tb-sp"></span>' +
      '<button class="btn sm" id="pvLedger">📒 查看组卷台账 / 回录</button>' +
      (fromBatch ? '<span class="small muted">已在台账 ' + U.esc(sheet.batch) + ' ✓</span>'
        : H.mode === 'shell' ? '<button class="btn sm' + (allCommitted ? '' : ' primary') + '" id="pvCommit"' + (allCommitted ? ' disabled' : '') + '>💾 ' + (allCommitted ? '已入账 ✓' : '组卷入账（生成待批改批）') + '</button>' : '<span class="small" style="color:var(--warn)">⚠ 入账需桌面壳</span>') +
      /* 2026-10-11 定版（按本机实测取舍，见 ISSUES I-031）：
         · **主按钮 = 打印（生成 PDF → 交给系统打印）** —— 唯一被证明能出纸的路：
           `PrintToPdfAsync` 出真 PDF，再用 shell 的 print 动词打印；
           **实测打印机自身计数器 7965→7968（真印了 3 页）**。用户要的「像 Word/WPS 点一下就出纸」就是它。
         · 预览按钮保留（Edge 打印预览，用户喜欢它的界面）。
         · WebView2 的 PrintAsync（不弹框直打）在本机恒定 OtherError + 0 字节空作业 ⇒ 不用。 */
      '<button class="btn sm primary" id="pvPrint">🖨 打印试卷（直接出纸）</button>' +
      '<button class="btn sm" id="pvPreview">👁 打印预览</button>' +
      (sheet.ans ? '<button class="btn sm" id="pvPrintAns">🖨 打印答案册（直接出纸）</button>' : '') +
      '</div>' +
      /* ⚠ 2026-10-24（用户实测事故：「我根本找不到在哪里把结果录回系统，也看不到我当初组的卷了」）：
         **打印与入账是两个独立按钮，打印不会建批次**。当时只点了打印（壳日志该时段 0 次 op=mark），
         台账里于是从来没有这张卷 ⇒「📒 台账/回录」空白 ⇒ 无处置结果。
         ⇒ 未入账就打印，必须在卷面上方**当场**警告：这是唯一能拦住"打完才发现没入账"的地方。 */
      (H.mode === 'shell' && !allCommitted ? '<div class="pp-note" style="margin-bottom:14px;border-left:4px solid var(--warn)">⚠ <b>这张卷还没入账</b>：现在打出来的纸，台账里<b>查不到</b>，孩子做完也没地方录对错。请先点上面的「💾 组卷入账（生成待批改批）」，再打印。</div>' : '') +
      /* 从台账复原时要说清"这就是当初那张卷"，否则用户会以为是新组的一张 */
      (fromBatch ? '<div class="pp-note" style="margin-bottom:14px;border-left:4px solid var(--ok)">📒 这是台账批次 <b>' + U.esc(sheet.batch) + '</b> 的卷面复原（' + U.esc(sheet.title) + ' · ' + refs.length + ' 题）——题序就是当初印出去的那张，可直接打印/重印或对答案册。'
        + (sheet.missing ? '其中 <b>' + sheet.missing + '</b> 题的卡已不在题库（题号照旧占位，不会串号）。' : '') + '要换题请回台账或重新组卷。</div>' : '') +
      '<div class="pp-note" style="margin-bottom:14px">流程：<b>① 入账</b>（生成台账批次，孩子名下的「复习中·待批改」）→ <b>② 打印</b> 给孩子纸面重做 → <b>③ 孩子做完</b> 对照答案册批改 → <b>④ 回录</b>（台账/回录里按题给 对/半对/错，状态自动爬档）。预览只呈现「干净题干 + 作答区」，原卷图（黑笔错解+红笔订正）<b>绝不</b>上重做卷。<b>打印是分开的两个单元</b>：试卷按钮只印试卷，答案册按钮只印答案册（别把答案印给孩子）。</div>' +
      '<div class="sheets" id="pvSheets"></div>';
    U.$id('pvSheets').innerHTML = renderSheets();
    /* 复原卷的「返回」回台账（而不是回编卷：编卷屏是空白篮子，会让人以为卷子丢了） */
    U.$id('pvBack').onclick = () => { if (fromBatch) mode = 'ledger'; else mode = 'compose'; S.render(); };
    /* 主按钮 = 生成 PDF 并交给系统打印（唯一验证能出纸的路）；次按钮 = Edge 打印预览 */
    /* 2026-10-24：未入账就打印 = 台账里没有这张卷，事后无从回录。卷面上方已有常驻警告条，
       这里在每次点打印时再提示一次——用户常常不看说明直接点按钮。
       **只提示不硬拦**：先打一份看看版式是合理需求，硬拦会挡住正常操作。 */
    const printGuard = () => {
      if (H.mode !== 'shell' || allCommitted) return;
      S.toast('⚠ 这张卷还没入账！打印后台账里查不到它，孩子做完也没法回录。请先点「💾 组卷入账」。', 'warn', 15000);
    };
    U.$id('pvPrint').onclick = () => { printGuard(); doPdf('paper', 'print'); };
    const pv = U.$id('pvPreview'); if (pv) pv.onclick = () => { printGuard(); doPrint('paper'); };
    const pa = U.$id('pvPrintAns'); if (pa) pa.onclick = () => { printGuard(); doPdf('ans', 'print'); };
    U.$id('pvLedger').onclick = () => { mode = 'ledger'; S.render(); };
    const pc = U.$id('pvCommit'); if (pc) pc.onclick = commitPaper;
  }

  /* ---------- 组卷入账：按学生·学科分组走 _标记复习.mjs 组卷（唯一入口），门禁拦截可剔除重试 ---------- */
  function groupKeys(refs) {
    const g = {}; for (const x of refs) g[x.kid + '|' + x.subject] = (g[x.kid + '|' + x.subject] || 0) + 1; return Object.keys(g);
  }
  async function commitPaper() {
    /* F-39：门禁降级（admit 读不到 ⇒ 界面用的是兜底盲解判据）时，入账前必须让用户知道 */
    if (!M.healthOk() && !confirm('⚠ 数据源降级：' + M.healthText() +
      '\n\n这道门禁现在是「读不到」而不是「通过了」。继续入账可能被工具拒（工具侧判据仍在跑）。\n\n仍要继续吗？')) return;
    /* 防重复印卷（2026-10-24 用户报障）：入账前把"近 7 天已印过"的题摆到眼前。
       这里只是**告知+给选择**，真正的硬门禁在工具侧 —— 它会 exit 2 拦下（需 --force 才放行）。
       为什么两道都要有：界面这道是让人当场知道，工具那道是保证任何入口（含命令行/别的界面）都逃不掉。 */
    await loadLedgerCache();
    const repNow = repeatOfBasket();
    if (repNow.length) {
      const rm = recentPrinted();
      const lines = repNow.slice(0, 12).map(x => {
        const r = rm[x.kid + '|' + x.card.id] || {};
        return x.card.id + '（' + (r.date || '') + ' ' + (r.paperId || '') + '）';
      }).join('、');
      if (!confirm('⚠ 这张卷里有 ' + repNow.length + ' 题最近 ' + REPEAT_DAYS + ' 天已经印过卷：\n' + lines +
        (repNow.length > 12 ? ' …' : '') +
        '\n\n同一套题短期内重印，孩子是照答案默写，这次判的「对」不代表掌握。' +
        '\n\n点「确定」= 仍然入账（工具侧会拦，需要你确认后才放行）；点「取消」= 先回配卷屏剔除这些题。')) {
        S.toast('已取消入账：请先剔除近 ' + REPEAT_DAYS + ' 天印过的题，或等它们到期再组', 'warn', 9000);
        return;
      }
    }
    sheet.committed = sheet.committed || {};
    const groups = {};
    for (const x of sheet.refs) { const k = x.kid + '|' + x.subject; if (!sheet.committed[k]) (groups[k] = groups[k] || []).push(x); }
    const keys = Object.keys(groups);
    if (!keys.length) return S.toast('本卷各学科批次均已入账', 'ok');
    /* 门禁拦下时是否已被用户确认剔除重印题（避免重复弹两次确认） */
    let allowRepeat = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      let curKey = null;                 // F-30：只对「本次失败的那个批次」剔除，不牵连别的组
      try {
        for (const k of Object.keys(groups)) {
          curKey = k;
          const [kid, subject] = k.split('|');
          const ids = groups[k].map(x => x.card.id).join(',');
          /* ⚠ 2026-10-16（P20261015-01 实测事故）：界面洗过牌的顺序就是孩子拿到的卷面顺序，
             工具侧不能再自行交错重排——否则台账、卷面、答案册三种顺序并存，批改对不上题。
             显式传 --no-interleave 让工具只记账（v2.7 起工具默认也不重排，双保险）。
             洗牌只发生在「生成试卷预览」时，入账/打印/回录都沿用 sheet.refs 这一份。 */
          const args = { student: kid, subject, ids, title: sheet.title + '·' + subject, date: U.today(), note: '桌面版 2.0 自助组卷', interleave: '0' };
          if (allowRepeat) args.force = '1';     // 用户已在确认框里明确同意"仍要重印"
          const r = await H.mark('组卷', args);
          /* ⚠ 2026-10-25（英语卷入账实测）：node 未捕获异常的 stderr 是「源码框+堆栈」，
             全文远超 400 字且「Error: …」那行在**头部**——旧的 slice(-400) 恰好把原因行切掉，
             界面 toast 只剩一段无头裸堆栈，用户连报错原因都看不见。
             改为优先摘「Error:/TypeError:/✖ …」整行（截 300 字），摘不到才退回尾部截取；
             下面 catch 里的编号提取（可剔除重试）也靠这行才能捞到被拦的题号。 */
          if (!r || r.code !== 0) {
            const raw = String((r && (r.err || r.out)) || '组卷失败');
            const hit = raw.split(/\r?\n/).map(l => l.trim())
              .find(l => /^(Error:|TypeError:|SyntaxError:|RangeError:|ReferenceError:|✖)/.test(l));
            throw new Error(hit ? hit.slice(0, 300) : raw.slice(-400));
          }
          const pm = String(r.out || '').match(/P\d{8}-\d{2}/);
          sheet.committed[k] = pm ? pm[0] : '?';
        }
        /* ★ 2026-10-24（重复印卷的第二层根因）：入账成功必须把**本卷已入账的题从篮子里摘掉**。
           原来不清空 ⇒ 篮子（localStorage）里还是这 30 题，下次进配卷屏直接再点预览+入账就再印一遍
           （P20261021-01 → P20261024-01 实测就是这条路）。清掉之后，"再组一卷"天然只剩还没印过的题。 */
        const doneKeys = new Set(sheet.refs.map(x => x.kid + '|' + x.card.id));
        const left = M.basket().filter(k => !doneKeys.has(k));
        if (left.length !== M.basket().length) M.basketSet(left);
        _ledgerCache = null;                       // 台账已变，下次进配卷屏重新读
        S.toast('已入账：' + Object.values(sheet.committed).join('、') +
          '（台账可回录；这些题已从篮子里摘掉，不会再被重复印一遍）', 'ok', 9000);
        S.render();
        return;
      } catch (e) {
        /* F-30：错误文本里捞出来的编号必须**确实在本卷里**才允许剔除（此前会把批次号/无关卡号一起删）
           —— 壳/工具目前不返回结构化的 blocked 数组，这里做最小可用兜底：白名单限定在 sheet.refs 内，
           且只作用于失败的那一个批次。结构化契约见修复说明「需 Lead 接手」一节。 */
        const msg = String(e.message);
        const inPaper = new Set(sheet.refs.map(x => x.card.id));
        const ids = [...new Set(msg.match(/[MPLCEY]\d{4}/g) || [])].filter(id => inPaper.has(id));
        /* 防重复门禁单独一条路：它的错误码/文案可辨识，允许"确认后 --force 重试" */
        if (/防重复组卷拦截/.test(msg) && ids.length && !allowRepeat) {
          if (confirm('⚠ 工具侧防重复门禁拦下 ' + ids.length + ' 题（最近 ' + REPEAT_DAYS + ' 天内已印过）：\n' + ids.join('、') +
            '\n\n仍要把这些题再印一遍吗？（重印后这次的对错会写进复习流水）')) {
            allowRepeat = true; continue;
          }
          S.toast('已取消：请先剔除这些题，或在台账里「看这张卷」直接重印当初那张', 'warn', 12000);
          S.render();
          return;
        }
        if (ids.length && curKey && groups[curKey] &&
          confirm('工具门禁拦下 ' + ids.length + ' 题（盲解/答案来源未归档）：\n' + ids.join('、') + '\n\n剔除这些题、其余继续入账吗？')) {
          groups[curKey] = groups[curKey].filter(x => !ids.includes(x.card.id));
          if (!groups[curKey].length) delete groups[curKey];
          if (!Object.keys(groups).length) { S.toast('剩余题目全被拦，未入账', 'warn'); return; }
          continue;
        }
        S.toast('入账未完成：' + e.message, 'bad', 9000);
        S.render();
        return;
      }
    }
  }

  /* 共用卷面渲染（v1 教训：题干/答题区渲染只许一处实现，组卷与单题预览共用，防两处漂移） */
  /* ⚠ 2026-10-11（F-26，高）：`renderSheets()` 一次产出「试卷 + 答案册」，而 `🖨 打印 / 存 PDF`
     把两段一起塞进 #printArea ⇒ **孩子的重做卷背面直接印出答案**（v1 是「生成试卷」/「生成答案册」
     两个按钮两个视图、只印当前视图，分离设计本身就是泄答案防线的一环）。
     现在：试卷与答案册各自一个打印单元，默认打印只出试卷；答案册必须点自己的按钮（家长用）。 */
  function shHead(title, refs, opts) {
    opts = opts || {};
    return '<div class="sh-h"><h1>' + U.esc(opts.h1 || title) + '</h1>' +
      '<div class="sh-meta"><span>' + U.esc([...new Set(refs.map(x => x.kid))].join('、') || M.student()) + '</span>' +
      '<span>出题 ' + refs.length + ' 道</span><span>日期：' + U.today() + '</span>' +
      (opts.score === false ? '' : '<span>得分＿＿＿</span>') + '</div>' +
      (opts.req === false ? '' : '<div class="sh-meta" style="margin-top:2mm"><span>要求：先独立思考再写；卡住 5 分钟以上的题号圈出来</span></div>') +
      '</div>';
  }
  /* 打印单元（纯函数，e2e 直接断言用；title 由这里 esc 一次，调用方传原文） */
  function paperHtml(title, refs, form) {
    let h = '<div class="sheet">' + shHead(title, refs);
    refs.forEach((x, i) => { h += qHtml(x, i, form); });
    return h + '</div>';
  }
  function ansHtml(title, refs) {
    let h = '<div class="sheet">' + shHead(title, refs, { h1: '答案册（家长批改用）', score: false, req: false });
    refs.forEach((x, i) => {
      const c = x.card;
      h += '<div class="q"><div class="q-hd">' + (i + 1) + '．' + U.esc(c.id) + '　<span style="font-weight:400">' + U.esc(c.type || '') + '</span></div>' +
        '<div class="ans-a"><b>答案：</b>' + U.esc(c.answer || '—') + '</div>' +
        '<div class="why"><b>当时错答：</b>' + U.esc(c.studentAnswer || '—') + '　<b>错因：</b>' + U.esc((c.causeLayer || '') + (c.causeCode || '')) + '　' + U.esc(c.causeDesc || '') + '</div></div>';
    });
    return h + '</div>';
  }
  /* 屏幕上可以同时看到两件（家长自己看），但**打印**永远只注入其中一件 */
  function renderSheets() { return paperHtml(sheet.title, sheet.refs, sheet.form) + (sheet.ans ? ansHtml(sheet.title, sheet.refs) : ''); }
  V.printUnit = function (kind) {
    if (!sheet) return '';
    return kind === 'ans' ? ansHtml(sheet.title, sheet.refs) : paperHtml(sheet.title, sheet.refs, sheet.form);
  };
  function qHtml(x, i, form) {
    const c = x.card;
    let stem;
    /* 泄答案防线（rc.3 修正）：原卷截图（含黑笔错解+红笔订正）绝不上重做卷——
       「裁净题干图」模式只许用 题干.jpg（stem），没有就降级印刷版题干/文字题干。
       F-27/F-57/F-58：题干走 M.stemHtmlSafe（唯一实现：白名单净化 + 相对图解析到卡片目录 + fig 兜底）。 */
    if (form === 'img' && c.stem) stem = '<div class="q-stem"><img src="' + U.esc(H.asset(c.stem)) + '"></div>';
    else stem = '<div class="q-stem">' + (M.stemHtmlSafe(c) || M.stemBlankify(U.esc(c.question))) + '</div>';
    const t = (c.type || '') + (c.question || '');
    /* 答题区自适应（2026-10-16 修，用户 P20261015-01 实测两条）：
       ① 填空题「题干里已有坑」的（ASCII 下划线或 blank span）不再另留 90px 大框——
          原来两处都能写，C0002 印出来=题干里一个小坑 + 底下一个大空框，孩子在小坑里写
          字还挤不出去（下划线 6 个字符太窄）。现在：有坑 = 就地写（CSS 把坑加宽），
          无坑（如"写出符号表达式"整句作答类）才留答题条。
       ② stemHtmlSafe 会把 blank span 透传成 HTML，纯 question 文本里的 ______ 也能落坑——
          判据同时看两者（与 v1 answerSpaceOf 同思路，但"有坑不留框"比 v1 更进一步）。 */
    const stemRaw = String(c.stemHtml || '') + String(c.question || '');
    const hasBlankInStem = /_{2,}|＿{2,}/.test(stemRaw) || /class="[^"]*blank/.test(String(c.stemHtml || ''));
    let zone = '';
    if (/选择|判断/.test(c.type || '')) zone = '<div class="anszone note" style="height:0"></div>';
    else if (/填空|默写/.test(c.type || '') && hasBlankInStem) zone = '';
    else if (/填空|默写/.test(c.type || '')) zone = '<div class="anszone" style="height:90px"></div>';
    else if (/计算/.test(t)) zone = '<div class="anszone" style="height:180px"></div>';
    else if (/解答|应用|压轴|证明|简答/.test(t)) zone = '<div class="anszone" style="height:' + (c.difficulty === '难' ? 280 : 220) + 'px"></div>';
    else zone = '<div class="anszone" style="height:150px"></div>';
    return '<div class="q"><div class="q-hd">' + (i + 1) + '．（' + U.esc(c.id) + '）' + U.esc(c.type || '') + '　难度·' + U.esc(c.difficulty || '中') + '</div>' + stem + zone + '</div>';
  }

  /* 打印注入的**唯一出口**：一次只把「一个」打印单元塞进 #printArea。
     e2e 用纯函数 V.printUnit(kind) 做断言（不触发 window.print 对话框）。 */
  V.fillPrintArea = function (kind) {
    const area = U.$id('printArea');
    area.innerHTML = V.printUnit(kind);
    return area;
  };
  /* ⚠ 2026-10-11 修（用户实测报障：「点打印，打印机不应答」）——**根因是 WebView2 里 `window.print()` 是空操作**：
     桌面壳用的是 WebView2，浏览器打印对话框必须由**宿主**实现（官方 API `ICoreWebView2_16::ShowPrintUI`，
     WebView2 Win32 1.0.1518.46 起提供；本仓 SDK 1.0.2903.40、运行时 153.x，都支持）。
     原来这里只调 `window.print()` ⇒ 在壳里点了没有任何反应（不弹框也不报错）；
     而**穷举扫描把 print 打桩了**，这条路径从没被真跑过 —— 又一次"没被走过的路径"。
     现在：① 壳通道 → 调宿主 `print` op（C# 侧 `ShowPrintUI` 弹系统打印对话框）；
           ② 服务端/离线通道（真浏览器）→ 仍用 `window.print()`；
           ③ 宿主失败**不静默**：提示"请按 Ctrl+P"，并**保留**打印区不清空（WebView2 默认启用浏览器快捷键，Ctrl+P 能弹同一界面）。
     清空时机也改了：壳通道等对话框**关闭后**再清，否则卷面可能在对话框还开着时被清掉、印出空白。 */
  function printHtml(html, tip) {
    const area = U.$id('printArea');
    area.innerHTML = html;
    const isShell = (typeof H !== 'undefined') && H.mode === 'shell' && typeof H.print === 'function';
    if (isShell) {
      S.toast(tip || '已送入打印视图，正在打开打印预览…', 'ok');
      H.print().then(r => {
        if (r && r.ok === false) throw new Error(r.error || '宿主打印不可用');
        /* ⚠⚠ 2026-10-11 修（用户第二次报障「点左下角打印之后没反应」的真凶）：
           **这里原来有 `setTimeout(() => { area.innerHTML = ''; }, 400)` —— 必须删掉。**
           因为宿主 `ShowPrintUI` 是「对话框刚弹出就返回」，而 Edge 打印预览是**之后**才去渲染页面内容的；
           400ms 就把 `#printArea` 清空 ⇒ 送进队列的是**空白作业**。
           铁证（Windows 打印服务日志 `Microsoft-Windows-PrintService/Operational`）：
             作业 14/18/19/21/23/24 全部 `打印页数: 0`、`大小(以字节为单位): 0`，
             而打印机与驱动一切正常（Word/WPS 能打）⇒ 空白是应用造成的。
           现在的规矩：**壳通道下绝不自动清空打印区**（它 `display:none`，屏幕上不占位、只对打印可见）。
           清空只在"下一次注入新的打印单元"时发生（`fillPrintArea` 是赋值覆盖），
           顺带让 Ctrl+P 这条退路也始终能印出正确卷面。 */
      }).catch(e => {
        S.toast('没能打开打印预览（' + ((e && e.message) || e) + '）——请按 Ctrl+P 打印，卷面已备好', 'warn', 12000);
        try { console.error('[print] 宿主打印失败：', e); } catch (_) { }
      });
      return;
    }
    S.toast(tip || '已送入打印视图（Ctrl+P 可存 PDF）', 'ok');
    setTimeout(() => { window.print(); setTimeout(() => { area.innerHTML = ''; }, 600); }, 120);
  }
  function doPrint(kind) {
    printHtml(V.printUnit(kind), kind === 'ans'
      ? '已送入打印视图：只有答案册（家长批改用，别给孩子）'
      : '已送入打印视图：只有试卷（不含答案册）');
  }
  /* 直接打印（2026-10-11 新增，用户要求「像 Word/WPS 点一下就出纸」）：
     走宿主 `PrintAsync` —— 不弹对话框，直接打到系统默认打印机。
     与"打印预览"的区别：预览那条要用户在 Edge 预览里再点一次「打印」；
     这条点一下就走纸，正是用户期望的体验（Word/WPS 就是调打印 API，不是弹预览）。
     ⚠ 只在**注入完成后**才调 PrintAsync，且**等它返回**再清空打印区（PrintAsync 是 await 的，
     内容此时已被渲染进作业，清空安全）——这与 `printHtml` 里"绝不提前清空"是两回事，别混。 */
  async function doPrintDirect(kind) {
    if (H.mode !== 'shell' || typeof H.printDirect !== 'function') { S.toast('直接打印需要桌面壳', 'warn'); return; }
    const btn = U.$id('pvPrintNow');
    const old = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '🖨 正在送往打印机…'; }
    try {
      V.fillPrintArea(kind);
      const r = await H.printDirect();
      if (!r || r.ok === false) throw new Error((r && r.error) || '壳返回失败');
      const st = String(r.status || '');
      if (/Unavailable/i.test(st)) S.toast('打印机不可用（离线/无纸/驱动异常）——已交给系统，请检查打印机', 'warn', 12000);
      else if (/OtherError|Abort/i.test(st)) S.toast('打印失败：' + st + '——可改用「📄 存为 PDF」再打印', 'bad', 12000);
      else S.toast('已送往打印机（' + st + '）。没出纸就看打印队列，或用「📄 存为 PDF」', 'ok', 12000);
    } catch (e) {
      S.toast('直接打印失败：' + ((e && e.message) || e) + '——可改用「📄 存为 PDF」', 'bad', 12000);
      try { console.error('[printDirect] 失败：', e); } catch (_) { }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = old; }
      setTimeout(() => { const a = U.$id('printArea'); if (a) a.innerHTML = ''; }, 600);
    }
  }
  /* 存为 PDF（2026-10-11 新增）：**不依赖打印机** —— 直接把当前卷面写成 PDF 落到 组卷\ 下。
     起因：用户报「点打印没反应」，修好对话框后仍可能因打印机/驱动失败（实测这台机器的 HP 打印作业
     在队列里 `Printing, Retained`、总页数 0，而绕过应用直接用 Windows 打印同样卡住 ⇒ 问题在打印子系统）。
     所以给一条**必定可用**的路：先出 PDF（机器可验证：文件存在 + %PDF 头 + 页数），再打印或存档。
     只注入**一个**打印单元（沿用 F-26 泄答案防线：试卷 PDF 绝不含答案册）。 */
  async function doPdf(kind, open) {
    if (H.mode !== 'shell' || typeof H.pdf !== 'function') { S.toast('存 PDF 需要桌面壳', 'warn'); return; }
    const btn = U.$id(kind === 'ans' ? 'pvPrintAns' : 'pvPrint');
    const old = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '📄 生成中…'; }
    try {
      V.fillPrintArea(kind);                      // 唯一出口：一次只注入一个单元
      const stamp = U.today();
      const who = M.student() || '学生';
      /* ⚠ 2026-10-11 实测教训：文件名**必须唯一**。原来固定叫「<日期>-<学生>-<重做卷>.pdf」，
         一旦该文件已存在、**而且正被 PDF 程序打开（文件被锁）**，PrintToPdfAsync 就返回 False
         （实测：用户那份 963KB 重做卷在 WPS 里开着 ⇒ 点打印必然失败，且报错毫无线索）。
         加 HHmm 时间戳即永不相撞，也让"同一批打两次"各自留档。 */
      const hm = (function () { const d = new Date(); return String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0'); })();
      const name = '组卷\\' + stamp + '-' + who + '-' + (kind === 'ans' ? '答案册' : '重做卷') + '-' + hm + '.pdf';
      const r = await H.pdf(name);
      if (!r || r.ok === false) {
        /* ⚠ 2026-10-11 实测：WebView2 **同一时刻只允许一个打印任务**。若「打印预览」还开着，
           PrintToPdfAsync 会立刻以 E_ABORT 失败（宿主返回 ok:false）——不是文件问题，是占用冲突。
           所以把原因说清楚并给出可执行动作，别让用户以为又坏了。 */
        throw new Error(((r && r.error) || '壳返回失败')
          + '（若你正开着「打印预览」，请先关掉它再点打印——WebView2 同一时刻只允许一个打印任务）');
      }
      S.toast('已生成 PDF：' + name + '（' + Math.round((r.bytes || 0) / 1024) + ' KB）'
        + (open === 'print' ? '，正在送往打印机…' : (open ? '，正在打开…' : '')), 'ok', 12000);
      /* 2026-10-11 定版：open==='print' ⇒ 交给**系统 print 动词**打印（本机 .pdf 关联 KWPS.PDF.9，
         其注册表里有 print 动词）；实测这份卷真印了 3 页（打印机计数器 7965→7968）。
         这是唯一被证明能出纸的路；WebView2 的 PrintAsync 在本机恒定 OtherError。 */
      if (open === 'print' && typeof H.printPdf === 'function') {
        const rp = await H.printPdf(name);
        if (!rp || rp.ok === false) throw new Error((rp && rp.error) || '交给系统打印失败');
        S.toast('已送往打印机（' + name + '）。没出纸就看打印队列，或用「👁 打印预览」', 'ok', 15000);
      } else if (open && typeof H.openFile === 'function') { try { await H.openFile(name); } catch (_) { } }
      else if (typeof H.reveal === 'function') { try { await H.reveal(name); } catch (_) { } }
    } catch (e) {
      S.toast('生成 PDF 失败：' + ((e && e.message) || e), 'bad', 12000);
      try { console.error('[pdf] 失败：', e); } catch (_) { }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = old; }
      setTimeout(() => { const a = U.$id('printArea'); if (a) a.innerHTML = ''; }, 400);
    }
  }
  /* 单题打印版预览（v1「每道题都有按钮看印刷版」能力找回，rc.4）：纯预览，不建批次不改状态 */
  V.singlePreview = function (x) {
    const html = paperHtml('单题预览 · ' + x.card.id, [x], 'stem');   // F-31：esc 只在这里做一次
    S.drawer({
      title: '🖨 打印版预览 · ' + x.card.id,
      chips: '<span class="tag sj" style="background:' + U.sjColor(x.subject) + '">' + U.esc(x.kid + '·' + x.subject) + '</span>',
      body: '<div class="small muted" style="margin-bottom:10px">这就是打印出来给孩子重做的样子（干净题干 + 自适应答题区，绝不含原卷笔迹）。纯预览：不建批次、不改状态。</div>' +
        '<div class="sheets" style="max-height:none">' + html + '</div>',
      footer: '<button class="btn" id="spClose">关闭</button><button class="btn primary" id="spPrint">🖨 打印这一题</button>',
      onMount: d => {
        d.querySelector('#spClose').onclick = S.closeDrawer;
        d.querySelector('#spPrint').onclick = () => printHtml(html);
      },
    });
  };

  /* ---------- 台账 / 回录 ----------
     ⚠ 2026-10-11 修（交互穷举扫描抓到的真缺陷，**确定性复现**）：
     `ledgerView` 是 async，`await H.readFile(...)` 之后才写 `U.$id('lgBox').innerHTML`。
     而 await 期间任何一次 `S.render()`（切学生 / 点侧栏 / 按 d r b p t s 快捷键 / 命令面板跳页 /
     autoReload 因焦点变化触发）都会把 `#lgBox` 换成孤儿节点 ⇒
       `TypeError: Cannot set properties of null (setting 'innerHTML')`，
     而且它是 **unhandled promise rejection**（S.render 的 try/catch 接不住），界面看着完全正常、只有 console 里有错。
     正常点击顺序就能撞上（扫描里 `paper:compose` 点 #pbLedger2、`paper:preview` 点 #pvLedger 各出现 1 次）。
     复现步骤：`S.route('paper',{reset:true})` → 点 `#pbLedger2` → 立刻 `S.route('paper',{reset:true})` → 900ms 后读异常。
     修法：① 每次写 DOM 前重新取一次并判空（拿不到就说明已被重渲染顶掉，直接放弃本次写入）；
           ② 用**代次令牌** `V.gen` 保证"只有最后一次渲染派发的异步写入能落地"；
           ③ 调用处 `.catch()` 兜底，别让它变成 unhandled rejection。 */
  let lgGen = 0;
  /* 台账行（2026-10-12 重排，用户报障「这个我整个看不懂」）：
     原先把 批次号/状态/日期/学生·学科/标题/题数 全挤进一行 ellipsis 文本，且**不按学生过滤**——
     顶栏切到学生A却列着学生B的 4 个批次；那 4 条还共用同一个标题、同一日期，用户根本分不清哪张是哪张。
     现在：① 按当前学生档过滤（「全部」= 都列并标出归属）；② 一行分两层：
        第 1 层是人话（「2026-10-11 印的 30 道题」+ 判分进度），第 2 层才是元信息（学科/批次号/标题）。
        标题只有在**彼此不同时**才有意义 ⇒ 自动生成的「学生B错题重做卷 日期·学科」直接不显示。 */
  V.ledgerRow = function (b, seq, isAll) {
    const n = (b.items || []).length;
    const graded = Object.keys(b.results || {}).length;
    const done = b.status === '已批改';
    const who = isAll ? '<span class="tag sj">' + U.esc(b.student) + '</span>' : '';
    return '<div class="lg-row' + (done ? ' done' : '') + '" title="' + U.esc(b.paperId + '　' + (b.title || '')) + '">' +
      '<div class="lg-main">' +
      '<div class="lg-t1"><b class="num">' + U.esc(String(seq)) + '</b>　' + U.esc(b.date || '') + ' 印的 ' + n + ' 道题' +
      (graded ? '<span class="muted small">（已判 ' + graded + '/' + n + '）</span>' : '') + '</div>' +
      '<div class="lg-t2">' + who + '<span class="tag gray">' + U.esc(b.subject || '') + '</span>' +
      '<span class="small muted num">' + U.esc((b.paperId || '').replace('P', '')) + '</span>' +
      (b.title && !/错题重做卷 \d{4}-\d{2}-\d{2}·/.test(b.title) ? '<span class="small muted">' + U.esc(b.title) + '</span>' : '') +
      '</div></div>' +
      '<span class="tag ' + (done ? 'ok' : 'warn') + '">' + (done ? '已批改' : '等你批改') + '</span>' +
      /* ⚠ 2026-10-24（用户原话：「我根本找不到当初给孩子组卷子选的是哪几道题目」）：
         台账此前**只有计数**，关掉预览/重开程序后 `sheet` 就没了 ⇒ 这张卷在系统里彻底查不到内容，
         连"我当初组了哪 30 题"都无从看起（与"打印了但没入账"是同一个洞的另一半：
         那次是根本没入账，这次是入了账但没有回看入口）。
         现在每个批次都有「👁 看这张卷」：台账 items 就是印刷顺序（组卷入账显式 --no-interleave 保证），
         所以能从台账原样复原卷面（题干/答题区/答案册/打印），不必另存卷面快照。 */
      '<button class="btn sm" data-open="' + U.esc(b.paperId) + '">👁 看这张卷</button>' +
      (!done && H.mode === 'shell' ? '<button class="btn sm primary" data-grade="' + U.esc(b.paperId) + '">✍ 录入对错</button>' : '') +
      /* ↩ 撤销试卷（2026-10-24 用户要求「任何时候、任何阶段都可以撤销某张试卷」）：
         **不设 !done 条件**——已批改的卷同样能撤（撤＝该卷判分流水一并回滚）。
         只在桌面壳里出现（写通道 H.mark 在壳侧；浏览器网页版只读）。 */
      (H.mode === 'shell' ? '<button class="btn sm danger" data-revoke="' + U.esc(b.paperId) + '" title="撤销这张试卷：卷上的题全部恢复为未组卷（随时可撤，已批改的也能撤）">↩ 撤销试卷</button>' : '') +
      '</div>';
  };
  /* 从台账批次**原样复原**卷面对象（纯函数，门禁可直接断言）。
     关键不变量：`refs` 长度与顺序必须与 items 一一对应——题号是卷面上印死的，
     所以「库里的卡找不到」时**留占位**而不是跳过，否则后面所有题号整体前移，
     复原出的卷面就和当初印出去的那张对不上号了。 */
  V.batchToSheet = function (b) {
    if (!b || !Array.isArray(b.items) || !b.items.length) return null;
    const kid = b.student || '';
    let missing = 0;
    const refs = b.items.map(id => {
      const hit = M.cards.find(x => x.card.id === id && (!kid || x.kid === kid));
      if (hit) return hit;
      missing++;
      return {
        key: kid + '|' + id, kid: kid, subject: b.subject || '',
        card: {
          id: id, question: '（题库里找不到这张卡：' + id + '）', type: '', difficulty: '',
          answer: '—', stemHtml: '', stem: '', studentAnswer: '', causeLayer: '', causeCode: '', causeDesc: '',
        },
      };
    });
    const title = b.title || ((b.date || U.today()) + '-' + kid + '-' + (b.subject || '') + '-错题重做卷');
    /* committed 预置成「已入账」：这是台账里的既成批次，再点入账会多建一张重复的卷 */
    return { title: title, refs: refs, form: 'stem', ans: true, batch: b.paperId, missing: missing, committed: { [kid + '|' + (b.subject || '')]: b.paperId } };
  };
  async function ledgerView(el) {
    const myGen = ++lgGen;
    el.innerHTML = '<div class="card"><div class="card-h"><b>📒 组卷台账</b>' +
      '<span class="hint">印过的卷子都记在这儿：点「👁 看这张卷」回看/重印当初那张卷，点「✍ 录入对错」把结果写进题库；点「↩ 撤销试卷」把整卷退回未组卷（任何时候可撤，已批改的也能撤）</span>' +
      '<span class="card-act"><button class="btn sm ghost" id="lgBack">← 回编卷</button></span></div>' +
      '<div id="lgBox" class="stack" style="gap:10px"><div class="skel" style="height:24px"></div><div class="skel" style="height:24px"></div></div></div>';
    const back = U.$id('lgBack');
    /* 回编卷 = 离开台账语境：必须把复原出来的卷（sheet.batch）清掉，
       否则下次点「生成预览」时会误判成"这一批已入账"而不再建新批次。 */
    if (back) back.onclick = () => { sheet = null; mode = 'compose'; S.render(); };
    /* 统一的"安全写"：重取节点 + 判代次；被重渲染顶掉就静默放弃（不是错误，是正常的竞态） */
    const put = html => {
      if (myGen !== lgGen) return false;
      const box = U.$id('lgBox');
      if (!box) return false;
      box.innerHTML = html;
      return true;
    };
    let raw = null;
    try {
      const r = await H.readFile('_组卷台账.json');
      raw = r && r.text;
    } catch (e) { put('<div class="empty small">读台账失败（文件读不到）：' + U.esc(e.message) + '</div>'); return; }
    let led;
    try { led = JSON.parse(raw || '{}') || {}; }   /* F-32：空文件/null 不再把「解析失败」说成读失败 */
    catch (e) { put('<div class="empty small">台账 JSON 解析失败：' + U.esc(e.message) + '</div>'); return; }
    {
      /* ⚠ 2026-10-12（用户报障「顶栏选学生A却看着学生B的卷子」）：台账**按当前学生档过滤**。
         「全部」档下列全部并标出归属；具体孩子档只列他的批次。计数跟着过滤走，不报全库数。 */
      const all = (led.batches || []).slice().reverse();
      const cur = M.student(), isAll = M.isAll();
      const mine = isAll ? all : all.filter(b => b.student === cur);
      const others = all.length - mine.length;
      const othersWho = M.students().filter(s => s !== cur);
      const head = '<div class="lg-filter">当前看的是 <b>' + U.esc(isAll ? '全部学生' : cur) + '</b>：' + mine.length + ' 个批次' +
        (isAll ? '（全库共 ' + all.length + ' 个）'
          : (others ? '，另有 ' + others + ' 个属于 ' + U.esc(othersWho.join('、')) + '，切顶栏姓名看'
            : '')) + '</div>';
      /* 「第几次」按 (学生,日期) 计数，不能用全局序号：同一天印多张时，全局序号会被别的孩子插队。 */
      const dayCount = {};
      for (const b of mine) { const k = b.student + '|' + b.date; dayCount[k] = (dayCount[k] || 0) + 1; }
      const daySeen = {};
      const numbered = mine.map(b => {
        const k = b.student + '|' + b.date;
        daySeen[k] = (daySeen[k] || 0) + 1;
        return { b: b, seq: dayCount[k] > 1 ? (daySeen[k] + '/' + dayCount[k]) : '唯一' };
      });
      const body = mine.length ? numbered.map(x => V.ledgerRow(x.b, x.seq, isAll)).join('')
        : '<div class="empty sm ready"><div class="e-ic">🧾</div><b>' + U.esc(cur) + '还没有印过卷子</b>' +
        '<div class="e-sub">组一张重做卷并「入账」后，这里会列出每一批的题数与批改状态。纸质重做仍是主路径（b1）。</div>' +
        '<div class="e-act"><a class="btn sm" data-go="paper">去组卷 →</a></div></div>';
      const ok = put(head + body);
      if (!ok) return;                                   // 已被重渲染顶掉：不写、不绑事件
      U.$id('lgBox').querySelectorAll('[data-grade]').forEach(b => b.onclick = () => gradeDialog(b.dataset.grade, mine.find(x => x.paperId === b.dataset.grade)));
      /* 回看/重印：用台账 items 复原卷面（mode=preview 复用卷面渲染与打印通道，不新建任何真源） */
      U.$id('lgBox').querySelectorAll('[data-open]').forEach(b => b.onclick = () => {
        const batch = mine.find(x => x.paperId === b.dataset.open) || all.find(x => x.paperId === b.dataset.open);
        const ns = V.batchToSheet(batch);
        if (!ns) return S.toast('这个批次没有题目记录，没法复原卷面', 'warn');
        sheet = ns; mode = 'preview'; S.render();
        S.toast('已从台账复原 ' + batch.paperId + '：' + ns.refs.length + ' 题' + (ns.missing ? '（其中 ' + ns.missing + ' 题的卡已不在库里，题号照旧保留）' : '') + '——可直接打印', 'ok', 9000);
      });
      /* ↩ 撤销试卷（任何时候、任何阶段；已批改的撤＝判分流水一并回滚，走工具唯一写入口「撤批」） */
      U.$id('lgBox').querySelectorAll('[data-revoke]').forEach(b => b.onclick = () =>
        revokeDialog(b.dataset.revoke, mine.find(x => x.paperId === b.dataset.revoke) || all.find(x => x.paperId === b.dataset.revoke)));
      const go = U.$id('lgBox').querySelector('[data-go]'); if (go) go.onclick = () => { sheet = null; mode = 'compose'; S.render(); };
    }
  }
  /* 回录批改的**每一行**（纯函数：抽屉渲染与门禁断言共用同一份，避免"测试抄一份"漂移）。
     ⚠ 2026-10-24 用户原话：「录入错题成绩时，没有题目编号，建议加上」。
     原文只显示题库内部编号（M0048），可家长手上拿的是**纸上印的题号**（1．、2．…）——
     30 行的抽屉里对不上号，只能靠数行数，数错一行就把对错记到别的题上（比不录更坏）。
     现在：首列方块 = **卷面题号**（与 paperHtml/ansHtml 的 (i+1) 同口径；台账 items 顺序＝印刷顺序，
     见 commitPaper 里 `--no-interleave` 那段注释），内部编号退居第二列。
     results 传批次已有结果：已录过的值就地标亮，但提交只写**本次点过**的题——
     重写未点的行会把它们的复习日期刷成今天（错题本的口径里，日期就是下次建议复习日的起点）。 */
  V.gradeRows = function (items, lookup, results) {
    results = results || {};
    return (items || []).map(function (id, i) {
      const no = i + 1;
      const c = ((lookup && lookup(id)) || {}).card || {};
      const q = String(c.question || '');
      const prev = results[id] || '';
      const btn = v => '<button data-v="' + v + '"' + (prev === v ? ' class="on"' : '') + '>' + v + '</button>';
      return '<div class="lg-gline' + (prev ? ' done' : '') + '" data-no="' + no + '" data-id="' + U.esc(id) + '">' +
        '<span class="lg-no" title="卷面第 ' + no + ' 题">' + no + '</span>' +
        '<span class="lg-id small num" title="题库内部编号">' + U.esc(id) + '</span>' +
        '<span class="lg-q small" title="' + U.esc(q) + '">' + U.esc(q.slice(0, 50) || '（题干为空）') + '</span>' +
        '<div class="seg sm" data-res="' + U.esc(id) + '">' + btn('对') + btn('半对') + btn('错') + '</div>' +
        '</div>';
    }).join('');
  };
  function gradeDialog(paperId, b) {
    const items = (b && b.items) || [];
    const results = (b && b.results) || {};
    const lookup = id => M.cards.find(x => x.card.id === id && x.kid === (b && b.student));
    const doneN = items.filter(id => results[id]).length;
    S.drawer({
      title: '回录批改 · ' + paperId + (b ? '（' + b.student + ' · ' + (b.subject || '') + ' · ' + items.length + ' 题）' : ''),
      body: '<div class="small muted" style="margin-bottom:10px">左列方块＝<b>这张卷上印的题号</b>：纸面上第 3 题，就找左边写 3 的那行；' +
        '后面 <span class="num">M0048</span> 是题库内部编号。按题给结果（与 _标记复习.mjs 批改一致：对/半对/错）。' +
        (doneN ? '本批已有 <b>' + doneN + '</b> 题录过（按钮已亮），不重点它就不会被重写。' : '') + '</div>' +
        '<div class="stack" style="gap:8px">' + V.gradeRows(items, lookup, results) + '</div>' +
        '<div class="opt-item" style="margin-top:12px">备注 <input type="text" id="lgNote" style="flex:1" placeholder="可选：本次重做整体情况"></div>',
      footer: '<span class="small muted" style="flex:1">这次点了 <b id="lgDone">0</b> / ' + items.length +
        ' 题；只提交点过的（结果存本地临时，提交一次性写库）</span>' +
        '<button class="btn" id="lgCancel">取消</button><button class="btn primary" id="lgSubmit">提交批改</button>',
      onMount: d => {
        const picked = {};
        const upd = () => { const el = U.$id('lgDone'); if (el) el.textContent = String(Object.keys(picked).length); };
        d.querySelectorAll('.seg[data-res]').forEach(seg => {
          seg.querySelectorAll('button').forEach(btn => btn.onclick = () => {
            seg.querySelectorAll('button').forEach(x => x.classList.remove('on')); btn.classList.add('on');
            picked[seg.dataset.res] = btn.dataset.v;
            upd();
          });
        });
        /* 续录（批次分几次判完）：直接把第一道**还没录**的题带到眼前，省得在 30 行里找 */
        const first = d.querySelector('.lg-gline:not(.done)');
        if (first && doneN) { try { first.scrollIntoView({ block: 'nearest' }); } catch (_) { } }
        U.$id('lgCancel').onclick = S.closeDrawer;
        U.$id('lgSubmit').onclick = async () => {
          const pairs = Object.keys(picked).map(id => id + '=' + picked[id]);
          if (!pairs.length) return S.toast('一题都没判', 'warn');
          try {
            const r = await H.mark('批改', { paper: paperId, results: pairs.join(','), date: U.today(), note: U.$id('lgNote').value || '桌面版回录' });
            if (r.code !== 0) throw new Error((r.err || r.out || '').slice(-300));
            S.toast('已批改：' + (r.out || '').replace(/\s+/g, ' ').trim().slice(0, 80), 'ok', 6000);
            S.closeDrawer(); S.render(); S.regenBackground();
          } catch (e) { S.toast('回录失败：' + e.message, 'bad', 8000); }
        };
      },
    });
  }

  /* ---------- 撤销试卷（2026-10-24 用户要求）----------
     用户原话：「应该设置一个用户任何时候、任何阶段都可以撤销某张试卷的权限，
     当撤销了某张试卷，该试卷上的题目应该恢复成未组卷状态」。
     语义（走 _标记复习.mjs「撤批」，唯一写入口，壳侧白名单已含）：
       · 批次行从台账移除——未批改的卷直接回组卷池；
       · 已批改的卷：该卷写进每张卡的判分流水 reviews[] 一并撤销、错误次数回退、
         连对/建议复习日按剩余记录重算 ⇒ 卷面状态整体回到组卷前；
       · 错题卡本体（题干/答案/错因/原卷图）不动；
       · 防重复门禁从此不再把这批题算作「最近印过」（台账行已移除）⇒ 立即可重新组卷。
     批次号不复用由工具侧 ledger.paperSeq 水印保证（撤掉最大号也不会被新卷领走）。 */
  /* 撤销确认的题目清单（纯函数，门禁直接断言）。与 V.gradeRows 同一条铁律：
     左列＝**卷面题号**（纸上印的第几题），按台账 items 顺序逐题占位——
     撤错卷比不撤更坏，所以确认框里必须能按纸质卷对号。 */
  V.revokeList = function (items, lookup, results) {
    results = results || {};
    return (items || []).map(function (id, i) {
      const no = i + 1;   /* 卷面题号（与 gradeRows/qHtml 同口径：题号印在纸上，缺卡也得占位） */
      const c = ((lookup && lookup(id)) || {}).card || {};
      const q = String(c.question || '');
      const res = results[id] || '';
      return '<div class="lg-gline' + (res ? ' done' : '') + '" data-no="' + no + '">' +
        '<span class="lg-no" title="卷面第 ' + no + ' 题">' + no + '</span>' +
        '<span class="lg-id small num">' + U.esc(id) + '</span>' +
        '<span class="lg-q small" title="' + U.esc(q) + '">' + U.esc(q.slice(0, 44) || '（题干为空）') + '</span>' +
        '<span class="small ' + (res ? 'num' : 'muted') + '">' + (res ? '已判：' + U.esc(res) : '未录') + '</span>' +
        '</div>';
    }).join('');
  };
  function revokeDialog(paperId, b) {
    const items = (b && b.items) || [];
    const results = (b && b.results) || {};
    const graded = items.filter(id => results[id]).length;
    const lookup = id => M.cards.find(x => x.card.id === id && x.kid === (b && b.student));
    const stageText = graded
      ? '这张卷已经录了 <b>' + graded + '/' + items.length + '</b> 题的结果：撤销后这些 对/半对/错 <b>一并从题库回滚</b>（连对、错误次数、建议复习日按剩余记录重算，可能退出「已掌握」）。'
      : '这张卷还没有录过结果：撤销后纸卷上做的内容将<b>无处回录</b>（孩子已经或快要做完的话，想清楚再撤）。';
    S.drawer({
      title: '↩ 撤销试卷 · ' + paperId + (b ? '（' + b.student + ' · ' + (b.subject || '') + ' · ' + items.length + ' 题）' : ''),
      body: '<div class="pp-note" style="border-left:4px solid var(--bad)"><b>撤销 = 整卷退回</b>：这张卷从台账移除，卷上的 ' + items.length +
        ' 道题<b>全部恢复为未组卷</b>，立刻可以组进新卷。' + stageText + '</div>' +
        '<div class="small muted" style="margin:12px 0 8px">这张卷上的题（左列＝纸面上印的题号）：</div>' +
        '<div class="stack" style="gap:6px;max-height:45vh;overflow:auto">' + V.revokeList(items, lookup, results) + '</div>' +
        '<div class="small muted" style="margin-top:10px">题卡本体（题干/答案/错因/原卷图）不动；纸质卷想留底可先「👁 看这张卷」重印一份。撤错了也不要紧：题目都在池子里，重新组卷即可。</div>',
      footer: '<span class="small muted" style="flex:1">任何时候都可以撤，包括已批改的卷。</span>' +
        '<button class="btn" id="rgCancel">先不撤</button><button class="btn danger" id="rgSubmit">↩ 确认撤销整卷</button>',
      onMount: d => {
        U.$id('rgCancel').onclick = S.closeDrawer;
        U.$id('rgSubmit').onclick = async () => {
          const btn = U.$id('rgSubmit');
          if (btn) { btn.disabled = true; btn.textContent = '⏳ 撤销中…'; }
          try {
            const r = await H.mark('撤批', { paper: paperId });
            if (!r || r.code !== 0) throw new Error((r.err || r.out || '').slice(-300));
            S.closeDrawer();
            if (sheet && sheet.batch === paperId) sheet = null;   // 正在回看的就是这张卷：别让它还顶着「已在台账 ✓」的旧身份
            _ledgerCache = null;
            S.toast('已撤销 ' + paperId + '：卷上 ' + items.length + ' 题恢复为未组卷，可重新组卷', 'ok', 9000);
            S.render();
            S.regenBackground();
          } catch (e) {
            S.toast('撤销失败：' + e.message, 'bad', 10000);
            const b2 = U.$id('rgSubmit'); if (b2) { b2.disabled = false; b2.textContent = '↩ 确认撤销整卷'; }
          }
        };
      },
    });
  }
})();
