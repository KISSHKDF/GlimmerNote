/* 错题本 2.0 · 今日总览（首页只放「现算的 TOP5+计数」，全量进工作台——a2 与既定教训：不做首页长墙） */
(function () {
  const U = CTB.util, M = CTB.model, S = CTB.shell;
  const V = CTB.views.dash = {};

  /* 热力图时间范围：默认近 12 周。原实现固定 53 周（近一年），本库现实是「近一年几乎全空」
     ⇒ 满屏灰格子，用户读到的不是「这段时间没动」，而是「这界面坏了 / 太空了」。
     0 = 近一年。选择记在 localStorage（`ctb2.heatWeeks`）。 */
  let heatWeeks = (function () { const v = U.lsGet('ctb2.heatWeeks', 12); return (v === 0 || v === 12 || v === 26) ? v : 12; })();

  function bucket() {
    const h = new Date().getHours();
    return h < 6 ? '夜深了' : h < 11 ? '早上好' : h < 14 ? '中午好' : h < 18 ? '下午好' : '晚上好';
  }
  V.sub = () => '范围：' + M.student();

  V.render = function (el) {
    const cards = M.cardsOf();
    const open = M.pendingOpen();
    let due = 0, overdueMax = 0, toDo = 0, mastered = 0, arch = 0, unrev = 0;
    for (const x of cards) {
      const d = M.dueInfo(x.card);
      if (d.code === 'due') { due++; overdueMax = Math.max(overdueMax, d.overdue || 0); }
      if (x.card.status === '已归档' || x.card.reviewStatus === '已归档') arch++;
      else if (M.mastered(x.card)) mastered++;
      else if (!x.card.reviewCount) unrev++;
      if (x.card.reviewStatus === '复习中·待批改') toDo++;
    }
    const noCause = open.filter(i => i.kind === '错因口述').length;
    const needOral = cards.filter(x => x.card.causeConfirmed === false).length;
    const top = open.slice().sort((a, b) => (stale(b) || 0) - (stale(a) || 0)).slice(0, 5);
    const kacts = [
      () => S.route('bank'),
      () => S.route('review', { queue: 'due' }),
      () => S.route('pending'),
      () => S.route('stats'),
    ];

    el.innerHTML =
      '<div class="row" style="margin-bottom:16px">' +
      '<div style="font-size:21px;font-weight:800">' + bucket() + '，' + (M.isAll() ? (M.students().length ? M.students().length + ' 个孩子' : '还没有学生') : U.esc(M.student())) + '</div>' +
      '<div class="muted small">' + U.today() + ' 周' + '日一二三四五六'[new Date().getDay()] + ' · 全库 <b class="num">' + M.cards.length + '</b> 题（当前范围 <b class="num">' + cards.length + '</b>）</div>' +
      '<div class="tb-sp"></div>' +
      /* ★ 2026-10-23（用户实测 BUG#1）：空库时把「新建学生」摆在最显眼处 ——
         新用户进门第一件事就是建孩子，之前这个入口压根不存在（只能手工建目录写索引）。 */
      (M.students().length ? '' : '<button class="btn primary" data-a="newStu">＋ 新建学生</button>') +
      (due ? '<button class="btn primary" data-a="revDue">🔁 开始今日复习（到期 ' + due + '）</button>' : '<button class="btn primary" data-a="revPick">🔁 进入复习流</button>') +
      '<button class="btn" data-a="paper">🧾 组一张重做卷</button>' +
      '</div>' +

      '<div class="grid g4" style="margin-bottom:16px">' +
      kpi(0, '📚', '在册错题', cards.length - arch, '另有已归档 ' + arch + ' 题') +
      kpi(1, '🔁', '到期待复习', due, overdueMax ? '最长逾期 ' + overdueMax + ' 天' : 'nextDue 仅为建议日') +
      kpi(2, '📋', '未办结待办', open.length, '错因口述类 ' + noCause + ' 条') +
      kpi(3, '✅', '已掌握', mastered, '连对 2 次才算（防蒙对）') +
      '</div>' +

      '<div class="grid g-21" style="margin-bottom:16px">' +
      /* ⚠ 2026-10-11（穷举扫描提示级）：待办为空时原先印成「今日待办 TOP0」——"TOP0" 是噪音。
         有 1 条以上才显示 TOPn；为空时直接写「今日待办」（下面就是"待办清零了"的空态）。 */
      '<div class="card"><div class="card-h"><b>📌 ' + (top.length ? '今日待办 TOP' + top.length : '今日待办') + '</b><span class="hint">积压最久优先</span>' +
      '<span class="card-act"><button class="btn sm" data-a="pend">☰ 工作台（共 ' + open.length + '）</button></span></div>' +
      (top.length ? top.map(pendRow).join('') : '<div class="empty ready"><div class="e-ic">🎉</div><b>待办清零了</b>' +
        '<div class="e-sub">没有挂起的疑问。刚拿不准的题当场记进台账，回头一条都不会漏。</div>' +
        '<div class="e-act"><button class="btn primary sm" data-a="paper">🧾 去组一张重做卷</button>' +
        '<button class="btn sm" data-a="pend">📋 看看台账</button></div></div>') +
      '</div>' +

      '<div class="card"><div class="card-h"><b>🎯 复习面板</b><span class="hint">不排期不强制（a2）</span></div>' +
      '<div class="stack" style="gap:12px">' +
      meterRow('未复习', unrev, cards.length - arch, 'var(--brand)') +
      meterRow('复习中·待批改', toDo, cards.length - arch, 'var(--warn)') +
      meterRow('已掌握', mastered, cards.length - arch, 'var(--ok)') +
      '</div><div class="row" style="margin-top:16px">' +
      (due ? '<button class="btn primary sm" data-a="revDue">只练到期（' + due + '）</button>' : '') +
      '<button class="btn sm" data-a="revPick">自选范围复习</button>' +
      (toDo ? '<span class="small muted">' + toDo + ' 题在组卷池等批改 → <a data-a="paper">去回录</a></span>' : '') +
      '</div></div></div>' +

      '<div class="grid g-21">' +
      '<div class="card"><div class="card-h"><b>🗓 学习热力</b><span class="hint">入册/复习均计活跃</span>' +
      '<span class="card-act">' +
      '<span class="seg sm" id="hmSeg">' +
      [[12, '近 12 周'], [26, '近 26 周'], [0, '近一年']].map(([w, t]) =>
        '<button data-w="' + w + '"' + (heatWeeks === w ? ' class="on"' : '') + '>' + t + '</button>').join('') +
      '</span>' +
      '<span class="small muted">🔥 连续 <b class="num">' + streakNow() + '</b> 天</span></span></div>' +
      CTB.chart.heatmap(M.heat, { weeks: heatWeeks, streak: streakNow(), rangeLabel: heatWeeks === 0 ? '近一年' : ('近 ' + heatWeeks + ' 周') }) + '</div>' +
      '<div class="card"><div class="card-h"><b>📊 学科盘面</b><span class="hint">掌握数 / 在册数</span>' +
      '<span class="card-act"><button class="btn sm ghost" data-a="stats">更多分析 →</button></span></div>' +
      subjBars(cards) + '</div></div>';

    const acts = {
      /* ⚠ 2026-10-11 修：revPick 原先传 `{queue:'pick'}`，而 review 视图的 pools 里没有 'pick' 这个题源
         ⇒ 用户点「进入复习流」直接「视图渲染出错 Cannot read properties of undefined (reading '1')」。
         "'pick' 的语义" = 没有到期题时让用户从**全部未复习**里选 ⇒ 正确题源是 'all'。
         （review 侧也已加未知题源兜底，两处都改是为了"语义正确 + 纵深防御"。） */
      revDue: () => S.route('review', { queue: 'due' }), revPick: () => S.route('review', { queue: 'all' }),
      paper: () => S.route('paper'), pend: () => S.route('pending'), stats: () => S.route('stats'),
      addPend: () => S.route('pending', { anchor: 'new' }),
      /* ★ 2026-10-23（BUG#1）：空库唯一入口 —— 没有学生时首页直接给「＋ 新建学生」 */
      newStu: () => S.newStudent(),
    };
    el.querySelectorAll('[data-a]').forEach(a => a.onclick = e => { e.preventDefault(); acts[a.dataset.a] && acts[a.dataset.a](); });
    el.querySelectorAll('.kpi').forEach(k => k.onclick = () => kacts[+k.dataset.k]());
    el.querySelectorAll('[data-anchor]').forEach(a => a.onclick = e => { e.stopPropagation(); S.route('pending', { anchor: 'pd-' + a.dataset.anchor }); });
    const hmSeg = U.$id('hmSeg');
    if (hmSeg) hmSeg.querySelectorAll('button').forEach(b => b.onclick = () => {
      heatWeeks = +b.dataset.w; U.lsSet('ctb2.heatWeeks', heatWeeks);
      hmSeg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      const card = hmSeg.closest('.card');
      const wrap = card && card.querySelector('.hm-wrap');
      const side = card && card.querySelector('.hm-side');
      /* 只换图表本身，不整页重绘：重绘会把滚动位置和焦点一起丢掉 */
      const tmp = document.createElement('div');
      tmp.innerHTML = CTB.chart.heatmap(M.heat, { weeks: heatWeeks, streak: streakNow(), rangeLabel: heatWeeks === 0 ? '近一年' : ('近 ' + heatWeeks + ' 周') });
      if (wrap && wrap.parentNode) wrap.parentNode.replaceChild(tmp.querySelector('.hm-wrap'), wrap);
      if (side && side.parentNode) side.parentNode.replaceChild(tmp.querySelector('.hm-side'), side);
    });
    /* ⚠ 提示产生在 render 体内是历史遗留：render 每次 S.render() 都跑（路由/主题/切学生/
       autoReload/落库后重绘），原来因此堆出 5 条一模一样的面板提示（见 shell.js S.toast 段注释）。
       现在靠 S.toast 的「同键去重 + 冷却窗」兜住：key 里带上题数，题数不变就只显示一次，
       题数变了才算新消息。*/
    if (needOral) S.toast('提示：' + needOral + ' 题错因未经孩子口述确认（卡详情里有 ⚠ 标记）', 'warn', 6000, 'dash.needOral:' + needOral, 300000);
  };

  const stale = p => U.diffDays(p.raisedAt || U.today(), U.today());  function kpi(k, ic, label, n, sub) {
    /* n=0 的卡降权：4 张卡里 3 张是 0，却和「201 在册」一样黑一样粗 ⇒ 眼睛分不出哪张是空的。
       0 不是坏消息，只是「还没开始」，所以只降字重与颜色，不做红/警示色。 */
    return '<div class="card kpi hover' + (n ? '' : ' zero') + '" data-k="' + k + '"><span class="kpi-ic">' + ic + '</span>' +
      '<span class="kpi-n num">' + n + '</span><span class="kpi-l">' + label + '</span><span class="kpi-x">' + U.esc(sub) + '</span></div>';
  }
  function meterRow(name, n, total, color) {
    return '<div class="meter"><span style="min-width:120px" class="small">' + name + '</span>' +
      '<div class="pbar"><i style="width:' + U.pct(n, total) + '%;background:' + color + '"></i></div><span class="mv">' + n + '</span></div>';
  }
  function streakNow() {
    const v = M.heat || {}; let n = 0, d = new Date();
    if (!v[U.dstr(d)]) d.setDate(d.getDate() - 1);
    for (;;) { if (!v[U.dstr(d)] || n > 400) break; n++; d.setDate(d.getDate() - 1); }
    return n;
  }
  function subjBars(cards) {
    const g = {};
    for (const x of cards) { const k = x.kid + '·' + x.subject; g[k] = g[k] || { n: 0, m: 0 }; g[k].n++; if (M.mastered(x.card)) g[k].m++; }
    const rows = Object.entries(g).map(([k, v]) => {
      const p = U.pct(v.m, v.n);
      return '<div class="kbar"><span class="kn">' + U.esc(k) + '</span><div class="pbar"><i style="width:' + U.clamp(p, 2, 100) + '%;background:' + U.sjColor((k.split('·')[1] || '')) + '"></i></div><span class="kv2">' + v.m + '/' + v.n + '</span></div>';
    });
    return rows.join('') || '<div class="empty sm ready"><div class="e-ic">📥</div><b>这个范围还没有题</b>' +
      '<div class="e-sub">题库当前为空或筛选只选中了没有卡的学生。</div>' +
      '<div class="e-act"><button class="btn sm" data-a="stats">看看全库统计</button></div></div>';
  }
  function pendRow(p) {
    const st = stale(p);
    return '<div class="lrow" data-anchor="' + U.esc(p.id) + '"><span class="tag ' + (st == null || st >= 3 ? 'bad' : 'gray') + '">' + U.esc(p.id) + '</span>' +
      '<div class="lr-main"><div class="lr-t">' + U.esc((p.question || '').slice(0, 64)) + '</div>' +
      '<div class="lr-x">' + U.esc([p.student, p.subject, p.kind].filter(Boolean).join('·')) + '　' + (M.ASK_IC[p.askWho] || '') + U.esc(p.askWho || '') + ' · 挂起 ' + U.daysText(st) + '</div></div>' +
      '<button class="btn xs">办 »</button></div>';
  }
})();
