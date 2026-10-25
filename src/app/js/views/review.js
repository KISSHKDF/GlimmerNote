/* 错题本 2.0 · 复习流（检索练习：先答后翻；判分口径=工具三态；落库仍走 _标记复习.mjs 唯一入口；
   a2 精神：不排期不推送——这里只是把「现在练什么、练完工具给什么建议日」讲清楚） */
(function () {
  const U = CTB.util, M = CTB.model, H = CTB.host, S = CTB.shell;
  const V = CTB.views.review = {};
  let reveal = false, noteVal = '', requeueWrong = U.lsGet('ctb2.rq', true), commitBusy = false;
  let lastKey = null;   // 只在「换卡」时收起已翻开的答案；同卡重绘（主题/渲染）不吞状态
  /* ⚠ 2026-10-11（F-RB-4，中）：转折点笔记原先只存在 `noteVal` 这一个模块变量里，
     而 `card()` 每次重绘都执行 `noteVal = ''` ⇒ 翻答案后写下的笔记，遇到**任何**一次重绘
     （切主题 / autoReload 自动重读 / 落库后重绘 / 按 U 撤销）就被静默抹掉，
     判分时既看不到也不会随判分记入复习流水（探针实测 domBefore="我在这里拐错了" → domAfter=""）。
     现在按卡号存在 noteByKey 里：重绘原样回填，判分取用后清掉。 */
  const noteByKey = {};
  /* ⚠ 2026-10-11（F-RB-9，高）：判分按钮的 onclick 是渲染时绑死在**那个 DOM 节点**上的。
     连点两下「对」时，第一下判完会重绘，但已脱离文档的旧节点仍然持有监听器，
     第二下就沿用到**下一题**上 ⇒ 实测 idx 0→2、results 两条「对」，
     而第二题用户**根本没翻开过答案**（等于凭空替孩子记了一个「对」并写进台账）。
     现在每颗按钮都带上渲染时那张卡的 key，grade() 先核对「还是不是同一张卡 / 答案是不是翻开着」。*/
  function grade(res, expectKey) {
    const s = M.session; if (!s || M.sessionDone()) return;
    if (!reveal) return;                                       // 没翻开答案不许判分
    const x = s.queue[s.idx]; if (!x) return;
    if (expectKey && x.key !== expectKey) return;              // 陈旧按钮（渲染后已换卡）
    const k = x.kid + '|' + x.subject + '|' + x.card.id;
    if (res === '错' && requeueWrong && !x._rq) { const copy = Object.assign({}, x, { _rq: 1 }); s.queue.push(copy); }
    M.sessionGrade(res);
    if (s.results[k] && noteVal) s.results[k].note = noteVal;
    delete noteByKey[x.key];
    reveal = false; noteVal = '';
    S.render();
  }
  /* F-47：causeLayer 只许进白名单类名（非 K/L/S 的取值此前直接进 class 属性位 = 属性逃逸面） */
  const layerCls = v => M.LAYER[v] ? 'tag ' + v : 'tag gray';

  V.sub = () => M.session ? ('进行中 ' + Math.min(M.session.idx + 1, M.session.queue.length) + '/' + M.session.queue.length) : '练 → 判 → 建议日（工具爬档）';

  V.render = function (el) {
    const key = M.session && !M.sessionDone() && M.session.queue[M.session.idx] ? M.session.queue[M.session.idx].key : null;
    if (key !== lastKey) { reveal = false; lastKey = key; }
    if (!M.session) return setup(el);
    if (M.sessionDone()) return summary(el);
    card(el);
  };

  /* ---------- 配置屏 ---------- */
  function setup(el) {
    const p = S.routeParam() || {};
    let src = p.queue || U.lsGet('ctb2.rvSrc', 'due');
    const all = M.cardsOf();
    const cards = all.filter(x => M.canGroup(x.card));
    /* F-24：`cards.length - M.cardsOf().length` 恒为 0（两边同范围），「被门禁拦掉几题」从来没呈现过。
       真正的差集是「本范围内的题」减「可进复习流的题」。 */
    const blockCnt = all.length - cards.length;
    const due = cards.filter(x => M.dueInfo(x.card).code === 'due').sort((a, b) => M.dueInfo(b.card).overdue - M.dueInfo(a.card).overdue);
    const unrev = cards.filter(x => !x.card.reviewCount && M.dueInfo(x.card).code !== 'due').sort((a, b) => (a.card.sourceDate || '').localeCompare(b.card.sourceDate || ''));
    /* ⚠ 2026-10-25（同 bank.js:104 的同类错）：basketCards() 返回包装对象，必须取 .card。
       此前 `filter(M.canGroup)` 让"题源=组卷篮"永远空池。 */
    const basket = M.basketCards().filter(x => M.canGroup(x.card));
    const pools = { due: ['⏰ 到期优先', due], all: ['🗂 全部未复习', unrev], basket: ['🧾 组卷篮', basket] };
    /* ⚠ 2026-10-11 修（用户实测报错：总览点「进入复习流」→「视图渲染出错 Cannot read properties of undefined (reading '1')」）：
       总览的 CTA 走 `S.route('review', { queue: 'pick' })`，而 pools 只有 due/all/basket **没有 pick** ⇒
       下一行 `pools[src][1]` 直接 TypeError。侧栏切页不带参数（走 due）所以一直没暴露。
       这里加兜底：**任何未知题源都回落到 due**（含 localStorage 里残留的旧值），
       绝不让一个非法参数把整页打崩。 */
    if (!pools[src]) src = 'due';
    if (src !== 'basket' && pools[src][1].length === 0 && pools.due[1].length === 0 && pools.all[1].length) src = 'all';   // 到期池空着不拦人：自动切未复习
    const subjects = ['全部', ...new Set(M.cardsOf().map(x => x.subject))];
    let sj = U.lsGet('ctb2.rvSj', '全部');
    let cap = U.lsGet('ctb2.rvCap', 15);

    function poolList() {
      let list = pools[src][1];
      if (sj !== '全部') list = list.filter(x => x.subject === sj);
      return list;
    }
    /* 空态三段式（沿用总览的设计语言：图标 +「现在是什么状态」+「所以你可以做什么」+ 一个可点下一步）。
       本仓铁律「空真不得报通过」：必须分清是**被筛掉/被门禁拦掉**还是**本来就没有**。
       ⚠ 2026-10-11（F-RB-12，中）：此前可练题 0 时界面只有一句「0 题进场」+ 一颗禁用按钮，
       用户读到的不是「为什么没题」而是「界面坏了」（探针实测 emptyEls=0、无 .ready、按钮 disabled）。 */
    function emptyBox() {
      const others = Object.keys(pools).filter(k => k !== src && pools[k][1].length);
      if (!all.length) return '<div class="empty ready"><div class="e-ic">📚</div><b>这个范围还没有题</b>' +
        '<div class="e-sub">当前学生档里一张错题卡都没有——不是被筛掉，是题库这个范围本来就是空的。先切到有数据的学生，或去题库浏览确认导入情况。</div>' +
        '<div class="e-act"><button class="btn sm" data-a="allStu">看全部学生</button><button class="btn sm" data-a="bank">去题库浏览</button></div></div>';
      if (!cards.length) return '<div class="empty ready"><div class="e-ic">🔒</div><b>' + all.length + ' 题全部被门禁挡在复习流外</b>' +
        '<div class="e-sub">不是没有题，是这些题还不能练：盲解未过，或答案来源不足（工具会在组卷时同样拦下）。去题库按「盲解未过」筛出来，逐张看卡在哪道门禁。</div>' +
        '<div class="e-act"><button class="btn sm primary" data-a="bankBlind">看被拦的题</button></div></div>';
      return '<div class="empty ready"><div class="e-ic">🧺</div><b>这个「题源 × 学科」组合是空的</b>' +
        '<div class="e-sub">题源「' + U.esc(pools[src][0]) + '」' + (sj !== '全部' ? '配学科「' + U.esc(sj) + '」' : '') +
        '筛下来 0 题（本范围内可练共 <b class="num">' + cards.length + '</b> 题）。换一个题源、或把学科切回「全部」就能开始。</div>' +
        '<div class="e-act">' + (sj !== '全部' ? '<button class="btn sm primary" data-a="sjAll">学科切回全部</button>' : '') +
        (others.length ? '<button class="btn sm' + (sj === '全部' ? ' primary' : '') + '" data-a="pool" data-v="' + others[0] + '">切到「' + U.esc(pools[others[0]][0]) + '」（<b class="num">' + pools[others[0]][1].length + '</b> 题）</button>' : '') +
        '<button class="btn sm" data-a="bank">去题库浏览</button></div></div>';
    }
    function draw() {
      const list = poolList();
      const q = list.slice(0, cap);
      el.innerHTML =
        '<div class="rv"><div class="card"><div class="card-h"><b>🔁 复习流</b><span class="hint">先自己重做 → 翻开对答案 → 诚实判分（判分决定工具给的建议日）</span></div>' +
        '<div class="stack">' +
        '<div><div class="small muted rv-lbl">题源</div><div class="seg" id="rvSrc">' +
        Object.entries(pools).map(([k, v]) => '<button data-v="' + k + '"' + (k === src ? ' class="on"' : '') + '>' + v[0] + '<span class="cnt">' + v[1].length + '</span></button>').join('') + '</div></div>' +
        '<div><div class="small muted rv-lbl">学科</div><div class="chips" id="rvSj">' +
        subjects.map(s => '<span class="chip' + (s === sj ? ' on' : '') + '" role="button" tabindex="0" data-v="' + U.esc(s) + '">' + U.esc(s) + '</span>').join('') + '</div></div>' +
        '<div class="opt-row"><div class="opt-item">本次上限 <input type="number" id="rvCap" min="1" max="60" value="' + cap + '" class="rv-cap"> 题</div>' +
        '<label class="opt-item"><input type="checkbox" id="rvIle" checked> 学科交错（同科不连排）</label>' +
        '<label class="opt-item"><input type="checkbox" id="rvRq"' + (requeueWrong ? ' checked' : '') + '> 判错的题队尾再做一遍</label></div>' +
        (H.mode !== 'shell' ? '<div class="pp-note">⚠ 当前是' + ({ server: '浏览器（服务端通道）', offline: '离线' }[H.mode] || '未知') + '模式：可以模拟练习，但判分<b>无法写回台账</b>。要用 <b>拾光小册.exe</b> 桌面壳打开才有落库。</div>' : '') +
        '</div></div>' +
        '<div class="card">' + (q.length ?
          '<div class="row"><div class="rv-grow"><b class="num">' + q.length + '</b> 题进场' +
          '<div class="small muted">' + (src === 'due' ? '按逾期天数倒序，逾期最久的先还账；没有到期题时这里主要是未复习题。' : src === 'basket' ? '组卷篮里的题直接屏幕重做。' : '未复习存量按入册先后排。') + '</div>' +
          (blockCnt ? '<div class="small rv-warn">⚠ 本范围内另有 <b class="num">' + blockCnt + '</b> 题被门禁挡在复习流外（盲解未过 / 答案来源不足 / 已掌握 / 已归档）——<button class="btn xs ghost" data-a="bankBlind">按「盲解未过」筛出来看原因</button></div>' : '') +
          '</div>' +
          '<button class="btn primary" id="rvStart">▶ 开始（空格=翻答案 · 1/2/3=判分）</button>' +
          '<button class="btn" id="rvPaper">改用纸质卷（打印重做）</button></div>' :
          emptyBox() + '<div class="row rv-empty-act"><span class="small muted">屏幕练不了时，也可以直接把题印成纸质卷重做：</span><button class="btn" id="rvPaper">改用纸质卷（打印重做）</button></div>') +
        '</div></div>';
      el.querySelectorAll('#rvSrc button').forEach(b => b.onclick = () => { src = b.dataset.v; U.lsSet('ctb2.rvSrc', src); draw(); });
      /* 键盘可达（F-RB-7）：chip 此前是裸 span（tabIndex -1），Tab 永远到不了 ⇒ 键盘用户筛不了学科 */
      el.querySelectorAll('#rvSj .chip').forEach(b => {
        b.onclick = () => { sj = b.dataset.v; U.lsSet('ctb2.rvSj', sj); draw(); };
        b.onkeydown = e => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); b.click(); }
        };
      });
      const acts = {
        bank: () => S.route('bank'),
        bankBlind: () => S.route('bank', { blind: 'no' }),
        paper: () => S.route('paper'),
        sjAll: () => { sj = '全部'; U.lsSet('ctb2.rvSj', sj); draw(); },
        allStu: () => { M.student('全部'); S.render(); },
        pool: b => { src = b.dataset.v; U.lsSet('ctb2.rvSrc', src); draw(); },
      };
      el.querySelectorAll('[data-a]').forEach(b => b.onclick = () => (acts[b.dataset.a] || (() => { }))(b));
      const capEl = U.$id('rvCap');
      if (capEl) capEl.onchange = e => { cap = U.clamp(+e.target.value || 15, 1, 60); U.lsSet('ctb2.rvCap', cap); draw(); };
      U.$id('rvRq').onchange = e => { requeueWrong = e.target.checked; U.lsSet('ctb2.rq', requeueWrong); };
      const st = U.$id('rvStart');
      if (st) st.onclick = () => {
        const ile = U.$id('rvIle').checked;
        let list = q;
        if (ile) list = interleave(list);
        M.startSession(list);
        S.render();
      };
      const pEl = U.$id('rvPaper'); if (pEl) pEl.onclick = () => S.route('paper');   // 空态分支可能不带它
    }
    draw();
  }
  function interleave(list) {
    const bySj = {}; for (const x of list) (bySj[x.subject] = bySj[x.subject] || []).push(x);
    const out = []; let go = true;
    while (go) { go = false; for (const k in bySj) if (bySj[k].length) { out.push(bySj[k].shift()); go = true; } }
    return out;
  }

  /* ---------- 下一建议日预告 ----------
     ⚠ 2026-10-11（F-RB-1，高）：此前这里自带一张表（M.LADDER=[1,3,7,15,…]）现算天数，
     而工具的唯一实现在 `_标记复习.mjs:181 intervalOf`（对 → LADDER_OK=[7,15,30,60,90]）。
     探针实测：全库 143 张可练卡 passStreak 全为 0，答对时界面写「下次≈1天后」，
     工具真正写进 nextDue 的是 **7 天** —— 在孩子做题的界面上承诺了一个错 6 天的日期，
     也是「视图里重算判据」的实证。现在一律走 M.previewIntervalOf（model 侧与工具同口径的唯一实现）。 */
  function previewIv(card, res) { return M.previewIntervalOf(card, res); }

  /* ---------- 单卡屏 ---------- */
  function card(el) {
    const s = M.session, x = s.queue[s.idx], c = x.card;
    const total = s.queue.length;
    const cnt = { '对': 0, '半对': 0, '错': 0 };
    for (const k in s.results) cnt[s.results[k].res]++;
    const staleDays = U.diffDays(c.sourceDate || U.today(), U.today());
    const imgForQ = c.stem || null;
    noteVal = noteByKey[x.key] || '';        // 本卡笔记回填（F-RB-4：重绘不再吞输入）
    const skippedN = M.sessionSkippedCount();
    /* 计数为 0 时降权：0 和 3 都上彩色徽章时，一眼看不出「这场其实还什么都没判」 */
    const ztag = (cls, label, n) => '<span class="tag ' + (n ? cls : 'gray') + ' num">' + label + ' ' + n + '</span>';
    el.innerHTML =
      '<div class="rv">' +
      '<div class="rv-bar"><button class="btn sm ghost" id="rvAbort">✕ 退出</button>' +
      '<div class="rv-prog"><i style="width:' + (s.idx / total * 100) + '%"></i></div>' +
      '<span class="small num rv-pos">' + (s.idx + 1) + ' / ' + total + '</span></div>' +
      '<div class="row small">' + ztag('ok', '对', cnt['对']) + ztag('warn', '半对', cnt['半对']) + ztag('bad', '错', cnt['错']) +
      '<span class="muted num">· 已坚持 ' + s.idx + ' 题</span>' +
      (skippedN ? '<span class="tag gray num">已跳过 ' + skippedN + '</span>' : '') +
      '<span class="tb-sp"></span><button class="btn xs ghost" id="rvUndo">↶ 撤上一题 (U)</button></div>' +

      '<div class="card rv-card">' +
      '<div class="rv-meta"><span class="tag sj" style="background:' + U.sjColor(x.subject) + '">' + U.esc(x.kid + '·' + x.subject) + '</span>' +
      '<b class="num">' + U.esc(c.id) + '</b><span class="tag gray">' + U.esc(c.type || '题目') + '</span>' +
      '<span class="diff-' + U.esc(c.difficulty) + ' diff-tag">' + U.esc(c.difficulty || '') + '</span>' +
      '<span class="' + layerCls(c.causeLayer) + '">' + U.esc((c.causeLayer || '') + (c.causeCode || '')) + '</span>' +
      (c.errorCount > 1 ? '<span class="tag bad num">重做错过 ' + c.errorCount + ' 次</span>' : '') +
      (staleDays > 0 ? '<span class="tag gray num">入册 ' + staleDays + ' 天</span>' : '') +
      (M.dueInfo(c).code === 'due' ? '<span class="tag bad">' + M.dueInfo(c).label + '</span>' : '') + '</div>' +

      '<div class="rv-q">' +
      /* F-27/F-57/F-58：题干唯一实现（白名单净化 + 相对图解析到卡片目录 + fig 兜底） */
      '<div class="stembox"' + (M.stemHtmlSafe(c) ? '' : ' style="white-space:pre-wrap"') + '>' + (M.stemHtmlSafe(c) || U.esc(c.question)) + '</div>' +
      (imgForQ ? '<div class="rv-fig"><img class="rv-img" src="' + U.esc(H.asset(imgForQ)) + '" alt="题干图"></div>' : '') +
      (!c.stemHtml && !imgForQ && c.img ? '<div class="rv-fig"><img class="rv-img rv-blur" src="' + U.esc(H.asset(c.img)) + '" alt=""><div class="small muted rv-figcap">此题只有原卷图（带作答笔迹），翻开后才可见高清版</div></div>' : '') +
      '</div>' +

      '<div class="row rv-actions">' +
      (reveal ? '' : '<button class="btn primary rv-reveal" id="rvReveal">🎯 我答完了 → 翻开对答案（空格）</button>') +
      '<button class="btn" id="rvSkip">跳过本题 (N)</button>' +
      (c.img ? '<button class="btn ghost sm" id="rvImg" title="原卷图（含当时笔迹）">🖼 原卷</button>' : '') +
      '</div>' +
      (reveal ? revealBox(c, noteByKey[x.key] || '') : '') +
      '</div></div>';

    U.$id('rvAbort').onclick = async () => {
      /* 2026-10-25 换 S.confirm：壳里原生 confirm 不可见且冻结整页（见 shell.js S.confirm 注释） */
      if (await S.confirm({ title: '退出并清空本场判定？', body: '未落库的判分将丢失。', ok: '退出并清空', danger: true })) { M.session = null; S.render(); }
    };
    /* ⚠ 2026-10-11（F-22）：此前 `splice(idx,1)` +「idx 回退」——跳过队尾那题时 idx 退 1，
       会**重新显示上一道已判过的题**（判定还在 results 里），用户以为跳题没生效。
       现在：用 skipped 集合标记、idx 单调前进（不改题目顺序，撤销栈的语义也保持不变）。 */
    U.$id('rvSkip').onclick = () => {
      if (!s.skipped) s.skipped = {};
      s.skipped[s.queue[s.idx] && s.queue[s.idx].key] = 1;
      s.idx++;
      S.render();
    };
    U.$id('rvUndo').onclick = () => { M.sessionUndo(); S.render(); };
    U.$id('rvImg').onclick = () => S.lightbox([Object.assign({ src: H.asset(c.img), rel: c.img, title: c.id + ' 原卷（含笔迹，仅核对用）',
      chips: '<span class="tag warn">' + U.esc(c.id) + '</span>', q: c.question,
      hint: '判分前核对：红笔订正处即当时错误点。此图含答案，只在翻开后用。' }, M.origOf(c))]);
    const rv = U.$id('rvReveal'); if (rv) rv.onclick = () => { reveal = true; S.render(); };

    if (reveal) {
      /* 回填本卡已写的转折点（F-RB-4）：重绘不再吞掉用户输入 */
      const nb = U.$id('rvNote');
      if (nb) {
        nb.value = noteVal;
        nb.oninput = e => { noteVal = e.target.value; noteByKey[x.key] = noteVal; };
      }
      /* 判分按钮带上「渲染时那张卡的 key」：换卡后的陈旧点击一律作废（F-RB-9） */
      el.querySelectorAll('[data-grade]').forEach(b => b.onclick = () => grade(b.dataset.grade, x.key));
    }
  }

  function revealBox(c, note) {
    return '<div class="reveal">' +
      '<div class="ans"><b>正确答案：</b>' + U.esc(c.answer || '—') + '</div>' +
      '<div class="wrong-ans"><b>当时错答：</b>' + U.esc(c.studentAnswer || '—') + '</div>' +
      '<div class="cause-box"><span class="' + layerCls(c.causeLayer) + '">' + U.esc((c.causeLayer || '') + (c.causeCode || '')) + ' ' + (M.LAYER[c.causeLayer] ? M.LAYER[c.causeLayer].name : '') + '</span>' +
      '<div class="cause-x">' + U.esc(c.causeDesc || '（无错因说明）') + '</div>' +
      (c.causeConfirmed === false ? '<div class="small cause-warn">⚠ 错因未经孩子口述确认，判分前先问问当时怎么想的</div>' : '') + '</div>' +
      (c.img ? '<div class="ans-fig"><img class="rv-img rv-img-s" src="' + U.esc(H.asset(c.img)) + '" alt="原卷核对"></div>' : '') +
      '<input type="text" id="rvNote" class="rv-note" value="' + U.esc(note || '') + '" placeholder="转折点（可选，随判分记入复习流水）：我想到哪一步、在哪拐错？">' +
      '<div class="grades">' +
      '<button class="btn ok gr-yes" data-grade="对">✓ 对 · 下次≈' + previewIv(c, '对') + '天后 (1)</button>' +
      '<button class="btn warn gr-half" data-grade="半对">◐ 半对 · 下次≈3天 (2)</button>' +
      '<button class="btn danger gr-no" data-grade="错">✗ 错 · 下次≈1天 (3)</button>' +
      '</div></div>';
  }

  /* ---------- 键盘（做题界面的主通道） ----------
     ⚠ 2026-10-11（F-RB-5，中）焦点陷阱实测：焦点停在「跳过本题」上按空格时，
     keydown 里的 `preventDefault()` **拦不住 button 的空格激活**——浏览器对 button 的 Space
     是在 **keyup** 上派 click（探针实测 kdPrevented=true 而 kuPrevented=false，
     结果 idx 0→1：一次空格「翻开了答案」**并且**「跳过了这题」）。
     现在：keydown 处理过的那次空格，在 keyup 上再吞一次，保证「空格=翻答案」这条契约唯一。
     ⚠（F-RB-6，中）Esc 此前在复习流里完全无反应（探针实测 sessionAfter=true、route 仍是 review）——
     一个「做题界面」没有 Esc 退出途径。现在 Esc 交给同一个 ✕ 退出按钮（带确认，复用唯一实现）。
     ⚠ e.repeat：按住 1/N/U 会连发，此前会连判/连跳好几题（与 F-RB-9 同族）。 */
  let spaceHandled = false;
  document.addEventListener('keydown', e => {
    if (!M.session || CTB.shell.currentRoute() !== 'review') return;
    if (!U.$id('view') || U.$id('drawerWrap').hidden === false || U.$id('lightbox').hidden === false || U.$id('paletteWrap').hidden === false) return;
    if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (e.repeat) return;                                    // 按住不放不连发
    if (e.key === 'Escape') { const b = U.$id('rvAbort'); if (b) b.click(); return; }
    if (M.sessionDone()) return;
    if (e.key === ' ') {
      if (!reveal) { e.preventDefault(); spaceHandled = true; reveal = true; S.render(); }
      return;                                                // 已翻开：空格不再做别的
    }
    if (reveal && ['1', '2', '3'].includes(e.key)) {
      e.preventDefault();
      const x = M.session.queue[M.session.idx];
      grade(['对', '半对', '错'][+e.key - 1], x && x.key);     // 带当前卡 key（F-RB-9 同款防护）
      return;
    }
    if (e.key.toLowerCase() === 'n') { const b = U.$id('rvSkip'); if (b) b.click(); return; }
    if (e.key.toLowerCase() === 'u' || e.key === 'ArrowLeft') { M.sessionUndo(); reveal = false; S.render(); }
  });
  /* keyup 兜底：把我们已处理掉的那次空格从 button 的激活路径上摘掉（F-RB-5） */
  document.addEventListener('keyup', e => {
    if (e.key !== ' ' || !spaceHandled) return;
    spaceHandled = false;
    e.preventDefault();
  });

  /* ---------- 结算屏 ---------- */
  function summary(el) {
    const s = M.session;
    const cnt = { '对': 0, '半对': 0, '错': 0 };
    const rows = [];
    for (const k in s.results) { const r = s.results[k]; cnt[r.res]++; rows.push(r); }
    /* ⚠ 2026-10-11（F-RB-8，中）：跳过的题此前在结算屏**完全不可见**（探针实测 4 题队列判 1 跳 3，
       结算屏只写「本场结束 · 1 题已判」）⇒ 用户以为本场就是 1 题，剩下 3 题不知去向，
       而「再来一场」又会把它们原样捞回来。现在：说清跳过几题，并给一个「只练跳过的」下一步。*/
    const skippedN = M.sessionSkippedCount();
    const skippedRefs = (() => {
      const seen = {}, out = [];
      for (const x of s.queue) { if (s.skipped && s.skipped[x.key] && !seen[x.key]) { seen[x.key] = 1; out.push(x); } }
      return out;
    })();
    /* ⚠ BUG-12（高·判定丢失）修复：
       `endSession` 会在「组卷成功、批改失败」时把该组判定搬进 `s.committed` 并从 `results` 摘走。
       原先这里只数 `rows = results`，于是这一屏会说"这场没有判定任何题"、
       而落库按钮的条件又是 `rows.length` ⇒ **按钮消失、判分永久丢失且无入口可补**
       （实测复现：判 2 题 → 组卷成功 → 批改失败 → rows=0 → 无按钮）。
       现在：凡"还有东西没写回台账"（results 或 committed 任一非空）都当作**待落库**，
       并把 committed 里已建批次的那几题显式列出来，让用户看得见"已建批、待补批改"。 */
    const pendingN = M.sessionPendingCount();
    const heldRows = [];
    for (const gk in (s.committed || {})) for (const r of ((s.committed[gk] && s.committed[gk].list) || [])) heldRows.push({ r: r, paperId: s.committed[gk].paperId });
    const ztag = (cls, label, n, big) => '<span class="tag ' + (n ? cls : 'gray') + ' num"' + (big ? ' style="font-size:var(--fs-md)"' : '') + '>' + label + ' <b>' + n + '</b></span>';
    el.innerHTML =
      '<div class="rv"><div class="card rv-done">' +
      '<div class="big">🏁</div><b class="rv-done-t">本场结束 · <span class="num">' + rows.length + '</span> 题已判' +
      (skippedN ? '<span class="muted rv-done-sk">（另 <span class="num">' + skippedN + '</span> 题跳过未判）</span>' : '') + '</b>' +
      '<div class="row rv-done-cnt">' + ztag('ok', '对', cnt['对'], 1) + ztag('warn', '半对', cnt['半对'], 1) + ztag('bad', '错', cnt['错'], 1) + '</div>' +
      '<div class="small muted rv-done-x">「对」累计连对 2 次 = 已掌握；「错」下次建议回到 1 天档</div>' +
      (heldRows.length ?
        '<div class="rv-rows"><div class="row small" style="color:var(--warn)"><b>已建批、待补批改 ' + heldRows.length + ' 题</b>' +
        '<span class="muted">上一轮组卷已成功落盘、批改没成功；点下面的「💾 落库」只会补批改，**不会重复组卷**。</span></div>' +
        heldRows.map(h => '<div class="row small rv-row"><b class="num">' + U.esc(h.r.id) + '</b>' +
        '<span class="tag ' + (h.r.res === '对' ? 'ok' : h.r.res === '半对' ? 'warn' : 'bad') + '">' + h.r.res + '</span>' +
        '<span class="muted rv-row-k">' + U.esc(h.r.kid + '·' + h.r.subject) + '</span>' +
        '<span class="muted">批次 ' + U.esc(h.paperId) + '</span>' +
        (h.r.note ? '<span class="muted" title="' + U.esc(h.r.note) + '">✎ 转折点</span>' : '') + '</div>').join('') + '</div>' : '') +
      (rows.length ?
        '<div class="rv-rows">' + rows.map(r =>
          '<div class="row small rv-row"><b class="num">' + U.esc(r.id) + '</b>' +
          '<span class="tag ' + (r.res === '对' ? 'ok' : r.res === '半对' ? 'warn' : 'bad') + '">' + r.res + '</span>' +
          '<span class="muted rv-row-k">' + U.esc(r.kid + '·' + r.subject) + '</span>' +
          (r.note ? '<span class="muted" title="' + U.esc(r.note) + '">✎ 转折点</span>' : '') + '</div>').join('') + '</div>'
        : (heldRows.length ? '' :
          '<div class="empty ready sm"><div class="e-ic">📝</div><b>这场没有判定任何题</b>' +
          '<div class="e-sub">' + (skippedN ? '你把这 ' + skippedN + ' 题都跳过了，没有产生任何判定，所以没有东西要写回台账。' : '队列是空的，没有产生任何判定。') + '</div>' +
          '<div class="e-act">' + (skippedN ? '<button class="btn sm primary" id="rvRedoSkipped">只练这 ' + skippedN + ' 题</button>' : '') +
          '<button class="btn sm" id="rvMore2">重选范围</button></div></div>')) +
      '</div>' +
      (H.mode === 'shell' && pendingN ?
        '<div class="card"><div class="row"><div class="rv-grow"><b>写回台账' + (heldRows.length ? '（待补批改 ' + heldRows.length + ' 题）' : '') + '</b><div class="small muted">按学生·学科自动 组卷→批改（<code>_标记复习.mjs</code> 唯一入口；写完建议「全量重建」刷新磁盘快照）</div></div>' +
        '<button class="btn" id="rvDrop">丢弃不写</button><button class="btn primary" id="rvCommit">💾 落库</button></div></div>' : '') +
      (skippedN && (rows.length || heldRows.length) ? '<div class="card"><div class="row"><div class="rv-grow"><b>还有 <span class="num">' + skippedN + '</span> 题跳过了</b>' +
        '<div class="small muted">跳过的题不会进本场判定（既不入账也不改变建议日），下次还会被捞出来。</div></div>' +
        '<button class="btn" id="rvRedoSkipped">只练这 ' + skippedN + ' 题</button></div></div>' : '') +
      '<div class="row"><button class="btn" id="rvMore">再来一场</button><span class="tb-sp"></span></div></div>';
    const c1 = U.$id('rvCommit'); if (c1) c1.onclick = commit;
    const d1 = U.$id('rvDrop'); if (d1) d1.onclick = async () => {
      if (await S.confirm({ title: '丢弃本场判定？', body: '不落库，判定直接清空。', ok: '丢弃', danger: true })) { M.session = null; S.render(); }
    };
    U.$id('rvMore').onclick = () => { M.session = null; S.render(); };
    const m2 = U.$id('rvMore2'); if (m2) m2.onclick = () => { M.session = null; S.render(); };
    el.querySelectorAll('#rvRedoSkipped').forEach(b => b.onclick = () => {
      if (!skippedRefs.length) return;
      M.session = null; M.startSession(skippedRefs); S.render();
    });
  }

  async function commit() {
    /* ⚠ 2026-10-11（F-RB-2，高）：双击「落库」此前会**并发跑两遍 endSession**——
       两次都在第一个 await（mark('组卷')）之前读到了同一份 results，于是同一批题
       组了**两张卷**、回录两次（探针实测：组卷 ids=M0027,M0028 出现 2 次、批改 2 次）。
       台账里就会多出一张永远停在「待批改」的卷，孩子收到两张一样的卷。
       现在两道闸：① 入口重入直接返回；② 按钮立刻置灰（不等重绘）。 */
    if (commitBusy) return;
    /* ⚠ BUG-12（高）：原先只判 `results` 非空，而"组卷成功、批改失败"的判定已搬进 `committed`
       ⇒ 这一句会直接 return "本场还没有任何判定"，把用户**唯一**的补救入口堵死。
       判据改为"还有没有任何东西没写回台账"（results ∪ committed）。 */
    if (!M.sessionPendingCount()) { S.toast('本场还没有任何判定，无需落库', 'warn'); return; }
    /* F-39：门禁降级时先让用户知情再落库（工具侧判据仍在跑，可能被拒）
       2026-10-25 换 S.confirm：壳里原生 confirm 不可见且冻结整页 */
    if (!M.healthOk() && !await S.confirm({
      title: '⚠ 数据源降级，仍要落库吗？',
      body: U.esc(M.healthText()) + '<br><br>这道门禁现在是「读不到」而不是「通过了」。继续落库可能被工具拒。',
      ok: '仍要落库', danger: true,
    })) return;
    commitBusy = true;
    const cb = U.$id('rvCommit'); if (cb) { cb.disabled = true; cb.textContent = '⏳ 落库中…'; }
    S.toast('正在按学科组卷并回录…');
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const papers = await M.endSession();
        S.toast('已落库：' + (papers.join('；') || '（剩余判定此前已入账）'), 'ok', 8000);
        commitBusy = false; M.session = null;
        S.regenBackground();          // 非阻塞：后台重建磁盘快照（壳侧写闸排队）
        S.render();
        return;
      } catch (e) {
        /* ⚠ 2026-10-11（F-21，高）：此前从**错误文本**里正则捞 `[MPLCEY]\d{4}`，命中即建议剔除。
           错误信息里出现批次号（P20261011 会命中 `P\d{4}`）或任何无关卡号时，会把与失败**无关**的
           判定一起从本场删掉（静默少落库）。现在两道闸：① 捞到的编号必须**确实在本场 results 里**；
           ② 只剔这些 id，且剔除前要求条数一致（不一致说明只是文本碰撞，不剔）。
           ⚠ 2026-10-12（BUG-05·同源·高）：本库有 31 个卡号跨学生重号，按**裸 id** 剔除会连
           另一个孩子的判定一起删掉。现在一律用完整键 `kid|id` 传给 sessionDrop；
           且**跨学生歧义的 id 直接拒绝剔除**（宁可让用户重试，也不静默删别人的判定）。
           结构化契约（壳返回 blocked:[ids]）见修复说明「需 Lead 接手」。 */
        const mineRows = M.session ? Object.values(M.session.results) : [];
        for (const gk in ((M.session && M.session.committed) || {})) for (const r of ((M.session.committed[gk] && M.session.committed[gk].list) || [])) mineRows.push(r);
        const mine = new Set(mineRows.map(r => r.id));
        const ids = [...new Set(String(e.message).match(/[MPLCEY]\d{4}/g) || [])].filter(id => mine.has(id));
        /* 歧义检查：同一裸 id 在本场命中多张卡（跨学生重号）⇒ 不能盲剔 */
        const ambiguous = ids.filter(id => M.sessionAmbiguous(id) > 1);
        const safeIds = ids.filter(id => !ambiguous.includes(id));
        const still = mineRows.filter(r => safeIds.includes(r.id));
        if (ambiguous.length) {
          commitBusy = false;
          S.toast('工具报出的 ' + ambiguous.join('、') + ' 在本场命中多张卡（两孩子同号），为免删错已**不剔除**。请到组卷工作台按批次号「撤批」后重做。', 'bad', 12000);
          S.render(); return;
        }
        if (safeIds.length && still.length === safeIds.length &&
          await S.confirm({
            title: '工具门禁拦下 ' + safeIds.length + ' 题',
            body: '<b>' + U.esc(safeIds.join('、')) + '</b>（盲解/答案来源未归档）<br>' +
              '要把这些题从本场剔除、其余继续落库吗？<br>' +
              '<span class="small muted">取消 = 中止落库，判定保留在屏幕；被剔的判定会先存本地草稿</span><br>' +
              '<span class="small muted">工具原文：' + U.esc(String(e.message).slice(0, 300)) + '</span>',
            ok: '剔除并继续',
          })) {
          /* 不把复习判定塞进 `pending.localSet` —— 那个库键是**待办编号 T###**，
             混入 kid|id 会让待办工作台出现打不开的条目（2026-10-12 修）。
             判定本来就在 `s.committed` 里，结算屏会把它连批次号一起列出来，用户点「落库」即可补批改。 */
          /* F-RB-10：剔除必须同时剪掉 committed 里那一组的 list，否则整组被剔空时
             endSession 会退回 committed.list 把被拦题又捞回来重新批改（永远失败、批次永久停待批改） */
          const n = M.sessionDrop(still.map(r => r.kid + '|' + r.id));
          S.toast('已剔除 ' + n + ' 题（判定已存本地草稿），重试落库…', 'warn');
          continue;
        }
        commitBusy = false;
        S.toast('落库未完成：' + e.message, 'bad', 10000);
        S.render();
        return;
      }
    }
    commitBusy = false; S.render();
  }
})();
