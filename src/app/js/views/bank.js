/* 错题本 2.0 · 题库浏览：多维筛选 + 全文搜 + 详情抽屉（复习史/错题记录/原卷定位） */
(function () {
  const U = CTB.util, M = CTB.model, H = CTB.host, S = CTB.shell;
  const V = CTB.views.bank = {};

  const DEFAULT = { q: '', subject: '全部', diff: '全部', layer: '全部', state: '全部', blind: '全部', code: '', hasImg: false, sort: 'new' };
  let f = Object.assign({}, DEFAULT, U.lsGet('ctb2.filters', {}));
  const save = () => U.lsSet('ctb2.filters', f);

  V.sub = () => { const n = filtered().length; return '筛选出 ' + n + ' 题'; };

  function filtered() {
    let cs = M.cardsOf();
    if (f.code) cs = cs.filter(x => M.causeKey(x.card) === f.code);
    if (f.subject !== '全部') cs = cs.filter(x => x.subject === f.subject);
    if (f.diff !== '全部') cs = cs.filter(x => x.card.difficulty === f.diff);
    if (f.layer !== '全部') cs = cs.filter(x => x.card.causeLayer === f.layer);
    if (f.blind === 'ok') cs = cs.filter(x => M.blindCls(x.card).ok === true);
    if (f.blind === 'no') cs = cs.filter(x => M.blindCls(x.card).ok !== true);
    if (f.hasImg) cs = cs.filter(x => x.card.img);
    if (f.state !== '全部') cs = cs.filter(x => stateOf(x.card) === f.state);
    if (f.q.trim()) {
      const q = f.q.trim().toLowerCase();
      cs = cs.filter(x => [x.card.id, x.card.question, x.card.type, x.card.source, x.card.causeDesc, (x.card.kpoints || []).join(' ')].join(' ').toLowerCase().includes(q));
    }
    const cmp = {
      new: (a, b) => (b.card.sourceDate || '').localeCompare(a.card.sourceDate || ''),
      old: (a, b) => (a.card.sourceDate || '').localeCompare(b.card.sourceDate || ''),
      err: (a, b) => (b.card.errorCount || 1) - (a.card.errorCount || 1),
      id: (a, b) => a.card.id.localeCompare(b.card.id),
      due: (a, b) => { const da = M.dueInfo(a.card), db = M.dueInfo(b.card); return (db.overdue || 0) - (da.overdue || 0) || (a.card.nextDue || '~').localeCompare(b.card.nextDue || '~'); },
    }[f.sort];
    return cs.slice().sort(cmp);
  }
  function stateOf(c) {
    if (c.status === '已归档' || c.reviewStatus === '已归档') return '已归档';
    if (M.mastered(c)) return '已掌握';
    if (c.reviewStatus === '复习中·待批改') return '待批改';
    const d = M.dueInfo(c);
    if (d.code === 'due') return '到期';
    if (c.reviewCount) return '复习中';
    return '未复习';
  }

  V.render = function (el) {
    const all = M.cardsOf();
    const subjects = ['全部'].concat([...new Set(all.map(x => x.subject))]);
    const fn = filtered().length;
    el.innerHTML =
      '<div class="card bk-filters"><div class="stack">' +
      '<div class="row"><input id="bkQ" type="text" class="bk-q" placeholder="搜题干 / 编号 / 知识点 / 来源（模糊）" value="' + U.esc(f.q) + '">' +
      '<select id="bkSort">' + opt([['new', '最新入册'], ['old', '最早入册'], ['due', '到期最优先'], ['err', '错得最多'], ['id', '按编号']], f.sort) + '</select>' +
      '<button class="btn sm ghost" id="bkReset">重置筛选</button></div>' +
      chipRow('subject', subjects, f.subject) +
      chipRow('diff', ['全部'].concat(M.DIFFS), f.diff) +
      '<div class="row">' +
      '<div class="chips"><span class="chip' + (f.layer === '全部' ? ' on' : '') + '" role="button" tabindex="0" data-k="layer" data-v="全部">错因·全部</span>' +
      ['K', 'L', 'S'].map(k => '<span class="chip' + (f.layer === k ? ' on' : '') + '" role="button" tabindex="0" data-k="layer" data-v="' + k + '" title="' + M.LAYER[k].name + '"><span class="chip-dot" style="background:' + M.LAYER[k].color + '"></span>' + k + ' ' + M.LAYER[k].name + '</span>').join('') + '</div>' +
      chipRow('state', ['全部', '未复习', '到期', '复习中', '待批改', '已掌握', '已归档'], f.state) +
      chipRow('blind', ['全部', 'ok', 'no'], f.blind, v => v === 'ok' ? '盲解已通过' : v === 'no' ? '盲解未过/存疑' : '盲解·全部') +
      '<span class="chip' + (f.hasImg ? ' on' : '') + '" role="button" tabindex="0" data-k="hasImg">🖼 只有图</span>' +
      '</div></div></div>' +
      '<div class="row bk-bar"><span class="small muted" id="bkCount">' + countHtml(fn) + '</span>' +
      '<span class="small muted">· 点击行看详情；勾选进组卷篮</span>' +
      '<span class="tb-sp"></span><button class="btn sm" id="bkAddBasket">➕ 把筛选结果全选进组卷篮（上限 30）</button>' +
      '<button class="btn sm primary" id="bkReviewSel">🔁 用筛选结果开复习会话</button></div>' +
      '<div id="bkList"></div>';

    if (f.code) {
      el.insertAdjacentHTML('afterbegin', '<div class="row bk-codebar"><span class="tag info">错因代码筛选：<b>' + U.esc(f.code) + '</b></span><button class="btn xs ghost" id="clrCode">✕ 取消此筛选</button></div>');
      U.$id('clrCode').onclick = () => { f.code = ''; save(); S.render(); };
    }
    renderList();
    U.$id('bkQ').oninput = U.debounce(e => { f.q = e.target.value; save(); renderList(); }, 200);
    U.$id('bkSort').onchange = e => { f.sort = e.target.value; save(); renderList(); };
    U.$id('bkReset').onclick = () => { f = Object.assign({}, DEFAULT); save(); S.render(); };
    /* 键盘可达（F-RB-7）：chip 此前是裸 span（tabIndex -1，实测 25/25 不可 Tab） */
    el.querySelectorAll('.chip[data-k]').forEach(c => {
      c.onclick = () => {
        const k = c.dataset.k;
        if (k === 'hasImg') f.hasImg = !f.hasImg; else f[k] = c.dataset.v;
        save(); S.render();
      };
      c.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); c.click(); } };
    });
    /* 空态里的下一步（bank 的筛选是模块私有，只能从视图内部改） */
    el.querySelectorAll('[data-a]').forEach(b => b.onclick = () => {
      const a = b.dataset.a;
      if (a === 'reset') { f = Object.assign({}, DEFAULT); save(); S.render(); }
      else if (a === 'clearQ') { f.q = ''; f.code = ''; save(); S.render(); }
      else if (a === 'allStu') { M.student('全部'); S.render(); }
      else if (a === 'reload') { S.reload(); }
    });
    U.$id('bkReviewSel').onclick = () => {
      /* ⚠ BUG-15（中）：此前直接 `startSession(filtered())` **没过准入门禁** ——
         同文件 :263 的"单题复习"有门禁，三条入口只有这条漏了
         （实测 202 张里 59 张 canGroup=false，含 1 张已归档）。
      /* ⚠ 2026-10-25（用户连点 3 次都见「这批题都没过准入」，回查全库全是绿的）：
         旧文案把两种不同情形说成同一句话——①筛选后本来就 **0 题**（如筛「盲解未过/存疑」、
         「待批改」，而该生全库盲✓）；②有题但全被 canGroup 拦。0 题时说"都没过准入"是
         冤枉数据，用户逐题核对全绿反而更糊涂。现在两态分开说，且把被拦原因**按门禁逐项
         计数**，让提示自己拿出证据（与工具侧同口径：在册/未掌握/盲解/答案来源）。 */
      const all = filtered();
      /* ⚠ 2026-10-25（第三轮报障的元凶）：`filtered()` 返回的是**包装对象** {key,kid,subject,card}，
         旧写法 `all.filter(M.canGroup)` 把包装对象直接喂给要裸卡的 canGroup
         ⇒ `status` 取不到 ⇒ inBook 恒 false ⇒ **每道题都被判"没过准入"**
         （实测 177/177 题门禁全绿却全被拦）。必须显式传 `x.card`。 */
      const list = all.filter(x => M.canGroup(x.card));
      if (!list.length) {
        if (!all.length) {
          return S.toast('当前筛选筛出 0 题，开不了复习会——放宽筛选（如把「状态/盲解」切回·全部）再试', 'warn', 7000);
        }
        const why = {};
        for (const x of all) {
          const c = x.card;
          const a = M.admitOf(c);
          let r;
          if (!M.inBook(c)) r = '非在册（撤卡/归档）';
          else if (M.mastered(c)) r = '已掌握（不回锅）';
          else if (a && !a.ok) r = M.admitWhy(c) || '准入未过';
          else {
            /* 残余桶细分：盲解状态词 vs 指纹新鲜度，别再笼统说"盲解未过" */
            const bm = M.blindCls(c);
            const fv = M.blindFreshOf(c);
            r = bm.ok !== true ? ('盲解状态:' + (c.blindStatus || '空'))
              : (fv !== undefined && fv !== '有效') ? ('盲解指纹:' + fv)
              : '未知拦截(数据异常)';
          }
          why[r] = (why[r] || 0) + 1;
        }
        const brief = Object.keys(why).sort((p, q) => why[q] - why[p])
          .map(k => k + ' ' + why[k] + '题').join('，');
        /* 探针（2026-10-25）：F-60 修好后"全被拦"应当极罕见。只在真出现"未知拦截"桶时
           才把原始值摆出来 —— 上次正是靠它一眼看出「指纹=有效、准入=过却仍被拦」，
           从而把排查从"数据质量"拉到"入参类型"。平时不打扰用户。 */
        let probe = '';
        if (why['未知拦截(数据异常)']) {
          const c0 = all[0].card, k0 = (M.keyOf && M.keyOf.get(c0)) || '(无键)';
          const rawBF = ((M.state && M.state.blindFresh) || {})[k0];
          const rawAD = ((M.state && M.state.admit) || {})[k0];
          probe = ' ［样例 ' + c0.id + ' 键=' + k0 + '，盲=' + (c0.blindStatus || '空')
            + '，指纹=' + (rawBF === undefined ? '缺' : rawBF)
            + '，准入=' + (rawAD ? (rawAD.ok ? '过' : rawAD.why) : '缺') + '］';
        }
        return S.toast('这 ' + all.length + ' 题全被拦：' + brief + '。' + probe + ' 先补门禁/点⟳重刷，或换筛选范围', 'warn', 12000);
      }
      M.startSession(interleave(list)); S.route('review');
    };
    U.$id('bkAddBasket').onclick = () => {
      const cur = new Set(M.basket());
      for (const x of filtered().slice(0, 30)) cur.add(x.kid + '|' + x.card.id);
      M.basketSet([...cur]); S.toast('已并入组卷篮（现 ' + M.basket().length + ' 题）', 'ok');
    };
  };
  V.onParam = function (p) {
    if (!p) return;
    if (p.code) { f.code = p.code; save(); S.render(); return; }
    /* 复习流空态里的「看被拦的题」会带 blind=no 进来（此前没人消费这个参数 ⇒ 点了没反应） */
    if (p.blind) { f.blind = p.blind; f.q = ''; save(); S.render(); return; }
    if (p.openKey) { const x = M.cards.find(c => c.key === p.openKey); if (x) openCard(x); }
  };

  function opt(arr, sel) { return arr.map(([v, t]) => '<option value="' + U.esc(v) + '"' + (v === sel ? ' selected' : '') + '>' + U.esc(t) + '</option>').join(''); }
  function chipRow(key, vals, cur, lb) {
    const label = { subject: '学科', diff: '难度', state: '状态', blind: '盲解' }[key] || key;
    /* F-48：`v`（学科名/状态名，来自 _索引.json）此前**两处都未 esc** —— 既进 data-v 属性位，也进文本位。
       学科名含 `"` 会属性逃逸 + 点该 chip 还会把半截值写进 f.subject。
       F-RB-7：补 role/tabindex，让 chip 能 Tab 到、回车/空格可激活。 */
    return '<div class="chips">' + vals.map(v => '<span class="chip' + (v === cur ? ' on' : '') + '" role="button" tabindex="0" data-k="' + U.esc(key) + '" data-v="' + U.esc(v) + '">' + (lb ? lb(v) : (v === '全部' ? U.esc(label) + '·全部' : U.esc(v))) + '</span>').join('') + '</div>';
  }
  /* 错因层白名单（F-47）：causeLayer 只许进白名单类名，非法值既不进 class 也不显示 */
  function layerCls(v) { return M.LAYER[v] ? 'tag ' + v : 'tag gray'; }
  function interleave(list) {           // 交错：同科目不连排（interleaving 练习效应，方向性共识）
    const bySj = {}; for (const x of list) (bySj[x.subject] = bySj[x.subject] || []).push(x);
    const out = []; let go = true;
    while (go) { go = false; for (const k in bySj) if (bySj[k].length) { out.push(bySj[k].shift()); go = true; } }
    return out;
  }

  /* 计数条片段（唯一来源）：renderList 与 V.render 共用，避免「列表已过滤、计数还是旧值」 */
  function countHtml(n) {
    const total = M.cardsOf().length;
    return '共 <b class="num">' + n + '</b> 题' +
      (n !== total ? '（本范围 <b class="num">' + total + '</b> 题，筛掉 <b class="num">' + (total - n) + '</b>）' : '');
  }
  function renderList() {
    const box = U.$id('bkList');
    const list = filtered();
    const cEl = U.$id('bkCount'); if (cEl) cEl.innerHTML = countHtml(list.length);   // F-RB-11：计数跟列表同步
    if (!list.length) { box.innerHTML = emptyBox(); return; }
    box.innerHTML = list.map(x => row(x)).join('');
    /* 键盘可达（F-RB-7）：行此前是裸 div（实测 202/202 不可 Tab），键盘用户只能看不能用。
       绑定走**事件委托**：逐行绑定是 202 行 × 2 = 404 个监听器，委托后只剩 1 组，
       行为等价（先判行内按钮，再判行本体）。
       性能口径（_probe\_perf-ab.cjs，202 卡、15 次采样、热身 6 次）：委托中位 6.6~7.1ms、
       逐行绑定中位 5.1~7.1ms —— **同一噪声带**，委托是结构上的省，不敢称提速。 */
    const byKey = new Map(list.map(x => [x.key, x]));
    box.onclick = e => {
      const t = e.target;
      const pb = t.closest && t.closest('[data-print]');
      if (pb) { const x = byKey.get(pb.dataset.print); if (x) CTB.views.paper.singlePreview(x); return; }
      const bb = t.closest && t.closest('[data-basket]');
      if (bb) { M.basketToggle(M.cards.find(c => c.key === bb.dataset.key)); renderList(); return; }
      const r = t.closest && t.closest('.lrow');
      if (r) { const x = byKey.get(r.dataset.k); if (x) openCard(x); }
    };
    box.onkeydown = e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const r = e.target.closest && e.target.closest('.lrow');
      if (!r || e.target !== r) return;        /* 行内按钮自己处理，别抢它的键 */
      e.preventDefault();
      const x = byKey.get(r.dataset.k); if (x) openCard(x);
    };
  }
  /* 空态三段式（沿用总览的设计语言）。
     ⚠ 2026-10-11（F-RB-3，高）**本仓铁律「空真不得报通过」**：此前无论哪种零结果，
     都只印一句「没有符合条件的题 / 换个筛选或清空搜索」——探针实测「筛选挡掉 202 题」
     与「这个范围本来一张卡都没有」两个场景的文案**逐字符相同**。
     在后者上那句建议是错的（没有筛选可换、也没有搜索可清），用户会以为数据丢了。
     现在按「有数据的 0」与「还没开始的 0」分开，并各给一个可点的下一步。 */
  function emptyBox() {
    const total = M.cardsOf().length;
    if (!total) {
      return '<div class="card"><div class="empty ready"><div class="e-ic">📚</div><b>这个范围还没有错题卡</b>' +
        '<div class="e-sub">不是筛选挡掉的——当前学生档里本来就没有卡（全库共 <b class="num">' + M.cards.length + '</b> 张）。' +
        '先切到有数据的学生；若确实刚导入，点「重读数据」让界面重新取一次状态包。</div>' +
        '<div class="e-act"><button class="btn sm primary" data-a="allStu">看全部学生</button>' +
        '<button class="btn sm" data-a="reload">⟳ 重读数据</button></div></div></div>';
    }
    /* 有数据的 0：说清「本范围 N 题，被哪些筛选挡掉」，并给最省事的一步 */
    const active = [];
    if (f.q.trim()) active.push('搜索「' + U.esc(f.q.trim()) + '」');
    if (f.code) active.push('错因代码 ' + U.esc(f.code));
    if (f.subject !== '全部') active.push('学科 ' + U.esc(f.subject));
    if (f.diff !== '全部') active.push('难度 ' + U.esc(f.diff));
    if (f.layer !== '全部') active.push('错因层 ' + U.esc(f.layer));
    if (f.state !== '全部') active.push('状态 ' + U.esc(f.state));
    if (f.blind !== '全部') active.push('盲解 ' + (f.blind === 'ok' ? '已通过' : '未过/存疑'));
    if (f.hasImg) active.push('只有图');
    return '<div class="card"><div class="empty ready"><div class="e-ic">🔍</div><b>筛选把 ' + total + ' 题全挡掉了</b>' +
      '<div class="e-sub">这个范围<b>有</b> <b class="num">' + total + '</b> 张卡，是下面这 <b class="num">' + active.length + '</b> 个条件同时生效筛成了 0 条：' +
      active.join(' ＋ ') + '。放宽任意一条就会重新出现。</div>' +
      '<div class="e-act"><button class="btn sm primary" data-a="reset">重置全部筛选</button>' +
      ((f.q.trim() || f.code) ? '<button class="btn sm" data-a="clearQ">只清搜索/错因代码</button>' : '') +
      '</div></div></div>';
  }
  function row(x) {
    const c = x.card, d = M.dueInfo(c), st = stateOf(c);
    const bm = M.blindCls(c);
    const inBasket = M.basketHas(x);
    return '<div class="lrow" role="button" tabindex="0" data-k="' + U.esc(x.key) + '" title="点击/回车看详情">' +
      (c.img ? '<img class="thumb" loading="lazy" data-thumb="' + U.esc(H.asset(c.img)) + '" src="' + U.esc(H.asset(c.img)) + '" alt="">' : '<div class="thumb thumb-no">无图</div>') +
      '<div class="lr-main"><div class="lr-t"><b class="num">' + U.esc(c.id) + '</b>　' + U.esc(c.question) + '</div>' +
      '<div class="lr-x">' + U.esc(c.type || '题目') + ' · ' + U.esc(c.source || '') + ' · ' + U.esc(c.sourceDate || '') + '</div></div>' +
      '<span class="' + layerCls(c.causeLayer) + '" title="错因三层">' + U.esc((c.causeLayer || '') + (c.causeCode || '')) + (c.causeConfirmed === false ? ' ⚠' : '') + '</span>' +
      '<span class="diff-' + U.esc(c.difficulty) + ' diff-tag">' + U.esc(c.difficulty || '') + '</span>' +
      '<span class="tag ' + ({ '到期': 'bad', '待批改': 'warn', '已掌握': 'ok', '已归档': 'gray', '未复习': 'gray', '复习中': 'info' }[st]) + '">' + st + (d.code === 'due' ? '·' + d.label : '') + '</span>' +
      (bm.ok === true ? '<span class="tag ok" title="盲解已通过">盲✓</span>' : '<span class="tag bad" title="盲解未过：组卷会被工具拦">盲✗</span>') +
      (c.errorCount > 1 ? '<span class="tag bad num" title="重做再错次数">错×' + c.errorCount + '</span>' : '') +
      '<button class="btn xs ghost" data-print="' + U.esc(x.key) + '" title="打印版预览（这题印出来什么样）">🖨</button>' +
      '<button class="btn xs' + (inBasket ? ' ok' : '') + '" data-basket="1" data-key="' + U.esc(x.key) + '" title="勾选/移出组卷篮">' + (inBasket ? '✓ 在篮' : '🧾 入篮') + '</button>' +
      '</div>';
  }

  /* ---------- 详情抽屉 ---------- */
  function openCard(x) {
    if (!x) return;
    const c = x.card;
    const pendingRel = M.pendingOpen().filter(p => p.cardId === c.id);
    const figKey = x.kid + '|' + c.id, fig = (M.state.figState || {})[figKey], blindFresh = (M.state.blindFresh || {})[figKey];
    S.drawer({
      title: c.id + ' · ' + (c.type || '题目'),
      chips: '<span class="' + layerCls(c.causeLayer) + '">' + U.esc((c.causeLayer || '') + (c.causeCode || '')) + '</span>' +
        '<span class="tag sj" style="background:' + U.sjColor(x.subject) + '">' + U.esc(x.kid + '·' + x.subject) + '</span>',
      body:
        '<div class="sect"><h4>题干（印刷版）</h4>' +
        /* F-27/F-57/F-58：题干唯一实现（净化 + 相对图解析到卡片目录 + fig 兜底） */
        '<div class="stembox">' + (M.stemHtmlSafe(c) || U.esc(c.question)) + '</div>' +
        (c.stem ? '<div class="row" style="margin-top:10px"><img class="thumb thumb-lg" src="' + U.esc(H.asset(c.stem)) + '" data-open="' + U.esc(c.stem) + '" title="点开大图" style="cursor:zoom-in"><span class="small muted">裁净题干图（可点开）</span></div>' : '') +
        '</div>' +
        '<div class="sect"><h4>答案与当时错答</h4>' +
        '<div class="ans"><b>正确：</b>' + U.esc(c.answer || '—') + '</div>' +
        '<div class="wrong-ans"><b>孩子错答：</b>' + U.esc(c.studentAnswer || '—') + '</div>' +
        '<div class="cause-box"><span class="' + layerCls(c.causeLayer) + '">' + U.esc((c.causeLayer || '') + (c.causeCode || '')) + '</span> ' +
        (c.causeConfirmed === false ? '<span class="tag warn">⚠ 待孩子口述确认</span>' : '<span class="tag ok">错因已确认</span>') +
        '<div style="margin-top:6px">' + U.esc(c.causeDesc || '（未写错因说明）') + '</div></div></div>' +
        '<div class="sect"><h4>属性</h4><dl class="kv">' +
        kv('来源', U.esc(c.source || '') + '（' + U.esc(c.sourceDate || '') + '）') +
        kv('知识点', (c.kpoints || []).map(k => '<span class="tag gray">' + U.esc(k) + '</span>').join(' ') || '—') +
        kv('难度', U.esc(c.difficulty || '—')) +
        kv('错误次数', c.errorCount || 1) +
        kv('状态', U.esc(c.status || '') + ' / ' + U.esc(c.reviewStatus || '')) +
        kv('复习', (c.reviewCount || 0) + ' 次 · 连对 ' + (c.passStreak || 0)) +
        kv('下次建议', U.esc(c.nextDue || '—') + (c.lastReviewedAt ? '（上次 ' + c.lastReviewedAt + '）' : '')) +
        kv('盲解', U.esc(c.blindStatus || '未盲解') + (c.blindSolveAt ? '（' + c.blindSolveAt + '）' : '') + (blindFresh ? ' · 指纹' + U.esc(blindFresh) : '')) +
        kv('配图', fig ? U.esc(fig.state || '—') : '未登记') +
        '</dl></div>' +
        '<div class="sect"><h4>复习流水</h4>' +
        ((c.reviews || []).filter(r => r && typeof r === 'object').length ? '<div>' + c.reviews.filter(r => r && typeof r === 'object').slice().reverse().map(r =>
          '<div class="row" style="gap:8px;padding:5px 0;border-bottom:1px dashed var(--line)"><span class="num small muted">' + U.esc(r.date) + '</span>' +
          '<span class="tag ' + (r.result === '对' ? 'ok' : r.result === '半对' ? 'warn' : 'bad') + '">' + U.esc(r.result) + '</span>' +
          '<span class="small num">' + U.esc(r.paper || '') + '</span><span class="small muted">' + U.esc(r.note || '') + '</span></div>').join('') + '</div>'
          : '<div class="empty sm ready"><div class="e-ic">🔁</div><b>还没有复习记录</b>' +
          '<div class="e-sub">这张卡还没进过复习流。做一场复习（答 → 判 → 落库）或打印重做卷，记录就会出现在这里。</div>' +
          '<div class="e-act"><a class="btn sm" data-go="review">去做一场复习 →</a></div></div>') +
        '</div>' +
        (pendingRel.length ? '<div class="sect"><h4>关联待办（' + pendingRel.length + '）</h4>' + pendingRel.map(p =>
          '<div class="lrow" data-pend="' + U.esc(p.id) + '"><span class="tag gray">' + U.esc(p.id) + '</span><div class="lr-main"><div class="lr-t">' + U.esc(p.question.slice(0, 80)) + '</div><div class="lr-x">' + U.esc(p.kind + ' · 问' + p.askWho) + '</div></div><button class="btn xs">去办 »</button></div>').join('') + '</div>' : '') +
        '<div class="sect"><h4>原卷证据</h4>' +
        (c.img ? '<img class="thumb thumb-lg" src="' + U.esc(H.asset(c.img)) + '" data-open="' + U.esc(c.img) + '" style="cursor:zoom-in">' : '<span class="small muted">无原卷截图</span>') +
        '</div>',
      footer:
        (c.img || c.stem ? '<button class="btn sm" id="dvImg">🔍 大图看原卷</button>' : '') +
        '<button class="btn sm" id="dvPrint">🖨 打印版预览</button>' +
        (c.md ? '<button class="btn sm" id="dvMd">📄 错题记录.md</button>' : '') +
        '<button class="btn sm' + (M.basketHas(x) ? ' ok' : '') + '" id="dvBasket">🧾 ' + (M.basketHas(x) ? '移出组卷篮' : '加入组卷篮') + '</button>' +
        (M.canGroup(c) ? '<button class="btn sm primary" id="dvReview">🔁 单题复习</button>' : '<span class="small muted" style="margin-left:auto">' + U.esc(M.admitWhy(c) || '盲解未过') + '，组卷/复习会被工具拦</span>'),
      onMount: d => {
        const bP = d.querySelector('#dvPrint'); if (bP) bP.onclick = () => CTB.views.paper.singlePreview(x);
        const lbItem = (rel, title) => Object.assign({
          src: H.asset(rel), rel, title,
          chips: '<span class="tag warn">' + U.esc(c.id) + '</span><span class="' + layerCls(c.causeLayer) + '">' + U.esc((c.causeLayer || '') + (c.causeCode || '')) + '</span>',
          q: c.question,
          detail: '正确答案：' + (c.answer || '—') + '　｜　当时错答：' + (c.studentAnswer || '—') + '　｜　错因：' + (c.causeDesc || '—'),
          hint: '这是从原图（整页原卷）裁下的题图（含孩子黑笔作答与红笔订正），仅用于核对，勿用于重做（泄答案防线）。🗂 原图可打开这道题所在的整页。',
        }, M.origOf(c));
        d.querySelectorAll('[data-open]').forEach(t => t.onclick = () => S.lightbox([lbItem(t.dataset.open, c.id + ' 原卷')]));
        const bImg = d.querySelector('#dvImg'); if (bImg) bImg.onclick = () => S.lightbox([lbItem(c.img || c.stem, c.id + ' 原卷大图')]);
        const bMd = d.querySelector('#dvMd'); if (bMd) bMd.onclick = () => showMd(c);
        const bB = d.querySelector('#dvBasket'); if (bB) bB.onclick = () => { M.basketToggle(x); S.closeDrawer(); S.render(); };
        const bR = d.querySelector('#dvReview'); if (bR) bR.onclick = () => { M.startSession([x]); S.closeDrawer(); S.route('review'); };
        d.querySelectorAll('[data-pend]').forEach(p => p.onclick = () => { S.closeDrawer(); S.route('pending', { anchor: 'pd-' + p.dataset.pend }); });
      },
    });
  }
  function kv(k, v) { return '<dt>' + k + '</dt><dd>' + v + '</dd>'; }
  function showMd(c) {
    H.readFile(M.relPathTmp(c.md)).then(r => {
      S.drawer({ title: c.id + ' · 错题记录', body: '<div class="mdv">' + CTB.md(r.text || '') + '</div>' });
    }).catch(e => S.toast('读取失败：' + e.message, 'bad'));
  }
  M.relPathTmp = rel => H.relPath(rel);   /* 与 host.relPath 同一实现，这里只是取用别名 */
})();
