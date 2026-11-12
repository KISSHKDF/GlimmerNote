/* 错题本 2.0 · 统计分析
 * 原则（调研 C·JLA 综述 + 厂商 A/B 双面）：只呈现「负荷与风险」，不预测分数；每张图挂一个下一步动作；
 * 不做同伴排名。掌握度双轨口径暂以工具既有 passStreak 为准（BKT/FSRS 属未来项，不在试用版写盘）。 */
(function () {
  const U = CTB.util, M = CTB.model, H = CTB.host, S = CTB.shell;
  const V = CTB.views.stats = {};

  V.sub = () => '范围：' + M.student() + ' · 全库 ' + M.cards.length + ' 题';

  /* ★ 2026-11-13（批次 4 / 家长只读报告）：把统计页的核心三块做成**一张可打印的单页**。
     依据（审计建议）：家长只读报告导出（单文件 HTML/PDF，含**薄弱点 / 趋势 / 待复习清单**），
     并明确"**走导出文件、不上云**"——本仓的离线红线正好要求如此。
     实现路线是**复用既有通道**，不新增任何网络/落库动作：
       · 「🖨 打印家长报告」→ `S.printHtml`（系统打印对话框，可选「Microsoft Print to PDF」存单文件）；
       · 「📄 存为 PDF」→ `H.pdf`（**不依赖打印机**，直接落 `组卷\` 下的唯一文件名）。
     为什么写成**纯函数**：报告要能被测试直接断言（同 `V.printUnit` 的惯例）；
     而且它是**只读快照**——不写库、不改数据、不上传。
     `d` 的形状见 `V.render` 里组装的那一份（本函数只排版，不自己算数）。 */
  V.reportHtml = function (d) {
    const D = d || {};
    const pct = (n, total) => (total > 0 ? Math.round((n / total) * 100) : 0);
    const bar = (n, total, cls) => '<div class="rp-bar ' + (cls || '') + '"><i style="width:' + pct(n, total) + '%"></i></div>';
    const bars = (rows, total) => (rows || []).map(r =>
      '<div class="rp-row"><span class="rp-k">' + U.esc(r[0]) + '</span>' + bar(r[1], total) +
      '<span class="rp-n">' + r[1] + '</span></div>').join('');
    const maxV = Math.max(1, ...(D.vals || [1]));
    return '<div class="sheet rp">' +
      '<div class="rp-h"><h1>' + U.esc(D.student || '学生') + ' · 错题复习报告</h1>' +
      '<div class="rp-sub">' + U.esc(D.today || '') + '　｜　在册 ' + (D.total || 0) + ' 题' +
      (D.archived ? '（另有已归档 ' + D.archived + '）' : '') + '　｜　本报告为只读快照</div></div>' +

      '<h2>一、现在该做什么</h2>' +
      '<div class="rp-callout">' + (D.advice || '先把「到期」的题复习掉；错因分布见下。') + '</div>' +

      '<h2>二、薄弱点</h2>' +
      '<div class="rp-2col">' +
      '<div><b class="rp-cap">错因三层（K 知识 · L 逻辑 · S 习惯）</b>' +
      bars(D.layers || [], D.total) + '</div>' +
      '<div><b class="rp-cap">错因代码 Top ' + ((D.codes || []).length) + '</b>' +
      bars(D.codes || [], D.total) + '</div>' +
      '</div>' +
      '<b class="rp-cap">薄弱考点 Top ' + ((D.kp || []).length) + '（点题库"考点"可筛）</b>' +
      bars(D.kp || [], D.total) +

      '<h2>三、趋势（近 14 天入册）</h2>' +
      '<div class="rp-trend">' + (D.days || []).map((dd, i) =>
        '<div class="rp-col"><i style="height:' + Math.round(((D.vals || [])[i] || 0) / maxV * 100) + '%" title="' +
        (D.vals || [])[i] + ' 题"></i><span>' + U.esc(String(dd).slice(-2)) + '</span></div>').join('') + '</div>' +
      '<div class="rp-note">共 ' + (D.vals || []).reduce((a, b) => a + b, 0) + ' 题；柱子高低=当天新增错题数。</div>' +

      '<h2>四、待复习清单（逾期最久 ' + ((D.risk || []).length) + ' 题）</h2>' +
      ((D.risk || []).length
        ? '<table class="rp-tb"><tr><th>题号</th><th>题目</th><th>应复习日</th><th>逾期</th></tr>' +
          (D.risk || []).map(r => '<tr><td>' + U.esc(r.id) + '</td><td>' + U.esc(String(r.title || '').slice(0, 42)) +
            '</td><td>' + U.esc(r.due || '—') + '</td><td>' + (r.over || 0) + ' 天</td></tr>').join('') + '</table>'
        : '<div class="rp-note">暂无逾期题——判分入账后这里开始说话。</div>') +

      '<div class="rp-foot">口径：错因编码含义以错题卡 `causeDesc` 为准；本报告由拾光小册在**本机**生成，' +
      '不含任何联网动作，可自行打印或存档。</div>' +
      '</div>';
  };

  V.render = function (el) {
    const cards = M.cardsOf().map(x => ({ ...x, c: x.card }));
    const inBook = cards.filter(x => x.c.status !== '已归档');

    /* 错因三层（F-15：LAYER 取值保护——非 K/L/S 的 causeLayer 不再让整页抛 TypeError） */
    const layerCnt = { K: 0, L: 0, S: 0 };
    const codeCnt = {};
    let badLayer = 0;
    for (const x of inBook) {
      if (x.c.causeLayer) { if (M.LAYER[x.c.causeLayer]) layerCnt[x.c.causeLayer]++; else badLayer++; }
      const ck = M.causeKey(x.c); if (ck) codeCnt[ck] = (codeCnt[ck] || 0) + 1;
    }
    const layerItems = Object.entries(layerCnt).map(([k, v]) => ({ name: k + ' ' + M.LAYER[k].name, value: v, color: M.LAYER[k].color }));

    /* 学科 × 层 矩阵 */
    const subjects = [...new Set(inBook.map(x => x.subject))];
    const mat = { K: [], L: [], S: [] };
    for (const sj of subjects) for (const k of ['K', 'L', 'S']) mat[k].push(inBook.filter(x => x.subject === sj && x.c.causeLayer === k).length);

    /* 难度 */
    const diffCnt = M.DIFFS.map(d => inBook.filter(x => x.c.difficulty === d).length);

    /* 入册趋势（近 14 天） */
    const days = []; const vals = [];
    for (let i = 13; i >= 0; i--) { const d = U.addDays(U.today(), -i); days.push(U.fmtMd(d)); vals.push(inBook.filter(x => x.c.sourceDate === d).length); }

    /* 知识点弱项榜（minN=2）：实测 147 个知识点标签里 **82 个是单例（55.8%）**，
       单例标签是噪音（只出现一次＝构不成"弱项"）；minN≥2 后 65 个覆盖 82.6%。
       ⚠ 2026-10-11：此前传 1（单例也上榜，弱项榜被一次性标签灌满）。 */
    const kp = M.kpointRank(inBook.map(x => ({ card: x.c })), 2).slice(0, 12);

    /* 复习/风险 */
    let due = 0, overdue = 0, toReview = 0, mastered = 0, withNextDue = 0;
    const riskList = [];
    for (const x of inBook) {
      const d = M.dueInfo(x.c);
      if (x.c.nextDue) withNextDue++;
      if (d.code === 'due') { due++; if (d.overdue > 0) { overdue++; riskList.push({ x, dd: d }); } }
      if (x.c.reviewStatus === '复习中·待批改') toReview++;
      if (M.mastered(x.c)) mastered++;
    }
    riskList.sort((a, b) => b.dd.overdue - a.dd.overdue);
    /* ⚠ 2026-10-11：到期环在 due=0 时一律显示 **0%**，会被读成"都掌握了"，
       而真实原因往往是"从未产生过到期日"（本库实测：201 张在册题 nextDue 全为空）。
       三态分开口径：due>0 → 到期 N；due=0 且全库无 nextDue → 未产生到期日；due=0 且有 nextDue → 已按时清空。 */
    const dueTri = !withNextDue ? 'none' : (due > 0 ? 'due' : 'clear');
    const dueRing = dueTri === 'none'
      ? { pct: 0, color: 'var(--text3)', sub: '到期 —（本范围 ' + inBook.length + ' 题都没有 nextDue：从未排过期，不是「都复习完了」）' }
      : { pct: U.pct(due, inBook.length), color: 'var(--bad)', sub: '到期 ' + due + '（逾期 ' + overdue + '）' };

    /* 双孩子对比（仅「全部」范围） */
    const cmp = M.isAll() ? M.students().map(k => {
      const cs = cards.filter(x => x.kid === k && x.c.status !== '已归档');
      const mm = cs.filter(x => M.mastered(x.c)).length;
      return { k, n: cs.length, m: mm, p: U.pct(mm, cs.length) };
    }) : [];

    el.innerHTML =
      /* ★ 2026-11-13（批次 4 / 家长只读报告）：导出入口放在最上面 —— 它是这个页面的"出口动作"，
         而不是又一个统计卡（家长要的是"一份能带走/能打印的东西"）。
         ⚠ 「存为 PDF」需要桌面壳（`H.pdf`）；真浏览器下点了会明确提示，不静默。 */
      '<div class="row" style="margin-bottom:12px;gap:8px;align-items:center">' +
      '<button class="btn sm" id="stPrint" title="把薄弱点/趋势/待复习清单排成一张单页，送系统打印对话框（可选「Microsoft Print to PDF」存单文件）">🖨 打印家长报告</button>' +
      '<button class="btn sm" id="stPdf" title="不依赖打印机：直接生成单文件 PDF 落到 组卷\\ 下">📄 存为 PDF</button>' +
      '<span class="small muted">报告是**只读快照**：不含答案、不写库、不联网</span>' +
      '</div>' +
      '<div class="grid g3" style="margin-bottom:16px">' +
      '<div class="card"><div class="card-h"><b>错因三层构成</b><span class="hint">c1 口径：K 知识 / L 逻辑 / S 习惯</span></div>' +
      '<div class="row" style="gap:18px;align-items:center">' + CTB.chart.donut(layerItems, { center: '题', size: 130 }) +
      '<div class="legend" style="flex-direction:column;align-items:flex-start">' + layerItems.map(i => '<span><i style="background:' + i.color + '"></i>' + i.name + ' · ' + i.value + '（' + U.pct(i.value, inBook.length) + '%）</span>').join('') + '</div></div>' +
      '<div class="small muted" style="margin-top:10px">读法：K 高→先补概念再刷题；S 高→审题/检查习惯专项；L 高→说理与分类讨论训练。<b>下一步：</b><a data-go="bank">按层筛题去组卷</a></div></div>' +

      '<div class="card"><div class="card-h"><b>学科 × 错因层</b><span class="hint">看哪科的哪一层在漏</span></div>' +
      CTB.chart.bars(subjects, [
        { name: 'K', values: mat.K, color: 'var(--k)' }, { name: 'L', values: mat.L, color: 'var(--l)' }, { name: 'S', values: mat.S, color: 'var(--s)' }], { height: 130 }) +
      '<div class="legend" style="margin-top:6px"><span><i style="background:var(--k)"></i>K</span><span><i style="background:var(--l)"></i>L</span><span><i style="background:var(--s)"></i>S</span></div></div>' +

      '<div class="card"><div class="card-h"><b>难度构成</b></div>' +
      CTB.chart.donut([{ name: '易', value: diffCnt[0], color: 'var(--d-easy)' }, { name: '中', value: diffCnt[1], color: 'var(--d-mid)' }, { name: '难', value: diffCnt[2], color: 'var(--d-hard)' }], { center: '题', size: 130 }) +
      '<div class="small muted" style="margin-top:8px">难>20% 时建议组卷压到 中易:难 = 6:3:1（先保正确率再上强度）。</div></div>' +

      '</div><div class="grid g-21" style="margin-bottom:16px">' +

      '<div class="card"><div class="card-h"><b>入册趋势（近 14 天）</b><span class="hint">每天新增错题数=作业批改节奏</span></div>' +
      CTB.chart.line(days, [{ name: '新增', values: vals, color: 'var(--brand)' }], { height: 130 }) + '</div>' +

      '<div class="card"><div class="card-h"><b>薄弱知识点 Top' + kp.length + '</b><span class="hint">kpoints 出现次数 · 点考点 → 题库按考点筛</span></div>' +
      (kp.length ? kp.map(([name, value]) =>
        /* 2026-11-09 考点联动：原先 hbars 只能看不能点；改同构 .kbar 按钮（样式类复用，button 默认样式就地复位），
           点击带 kp 跳题库（镜像下方 data-code 的跳转模式）⇒ 统计页的"薄弱"直接变成下一步动作。 */
        '<button class="kbar" data-kp="' + U.esc(name) + '" title="去题库按考点「' + U.esc(name) + '」筛题"' +
        ' style="cursor:pointer;width:100%;background:none;border:none;text-align:left;padding:3px 0;font:inherit">' +
        '<span class="kn" title="' + U.esc(name) + '">' + U.esc(name) + '</span>' +
        '<div class="pbar"><i style="width:' + (value / kp[0][1] * 100) + '%;background:var(--brand)"></i></div>' +
        '<span class="kv2">' + value + '</span></button>').join('')
      : '<div class="empty sm ready"><div class="e-ic">🏷️</div><b>还没有出现 ≥2 次的考点</b>' +
        '<div class="e-sub">单例考点构不成"弱项"（minN=2 口径）；错题卡标注 kpoints 之后这里自动成榜。</div>' +
        '<div class="e-act"><a class="btn sm" data-go="bank">去题库浏览 →</a></div></div>') + '</div></div>' +

      '<div class="grid g-12">' +
      '<div class="card"><div class="card-h"><b>复习进度环</b></div>' +
      '<div class="row" style="gap:22px;justify-content:center;padding:8px 0">' +
      '<div style="text-align:center">' + CTB.chart.ring(U.pct(inBook.length - (inBook.length - mastered), inBook.length) === 0 ? 0 : U.pct(mastered, inBook.length), { size: 110, color: 'var(--ok)' }) + '<div class="small muted">掌握率 ' + mastered + '/' + inBook.length + '</div></div>' +
      '<div style="text-align:center">' + CTB.chart.ring(U.pct(toReview || 0, inBook.length), { size: 110, color: 'var(--warn)' }) + '<div class="small muted">待批改 ' + toReview + '</div></div>' +
      '<div style="text-align:center">' + CTB.chart.ring(dueRing.pct, { size: 110, color: dueRing.color }) + '<div class="small muted">' + dueRing.sub + '</div></div>' +
      '</div>' +
      (riskList.length ? '<div class="small" style="margin-top:10px"><b>逾期最久 Top' + Math.min(6, riskList.length) + '：</b>' +
        riskList.slice(0, 6).map(r => '<a class="tag bad" style="margin:2px" data-risk="' + U.esc(r.x.kid + '|' + r.x.c.id) + '">' + U.esc(r.x.c.id) + ' · ' + r.dd.overdue + '天</a>').join('') + '</div>' :
        '<div class="small muted" style="margin-top:10px">暂无逾期题——判分入账后这里开始说话。</div>') + '</div>' +

      '<div class="stack">' +
      (cmp.length ? '<div class="card"><div class="card-h"><b>两孩子对照</b><span class="hint">只做事实对比，不排名</span></div>' +
        cmp.map(c => '<div class="kbar"><span class="kn">' + U.esc(c.k) + '（' + c.n + ' 题）</span><div class="pbar"><i style="width:' + U.clamp(c.p, 2, 100) + '%;background:var(--brand)"></i></div><span class="kv2">' + c.m + ' 掌握</span></div>').join('') + '</div>' : '') +
      '<div class="card"><div class="card-h"><b>错因代码分布</b><span class="hint">数字=题数 · 点开按码筛题</span></div>' +
      '<div class="row">' + Object.entries(codeCnt).sort((a, b) => b[1] - a[1]).map(([code, n]) =>
        '<button class="chip" data-code="' + U.esc(code) + '"><span style="color:' + (M.LAYER[code[0]] ? M.LAYER[code[0]].color : 'var(--text3)') + '">●</span>' + U.esc(code) + '<b>×' + n + '</b></button>').join('') + '</div>' +
      '<div class="small muted" style="margin-top:8px">口径：层名（K/L/S）来自方案 c1；具体码含义以错题卡 causeDesc 为准，本界面不自造定义。</div></div>' +
      '<div class="card"><div class="card-h"><b>数据质量面板</b><span class="hint">门禁同源</span></div>' +
      '<div class="row" style="gap:16px">' +
      qc('待口述错因', M.cardsOf().filter(x => x.card.causeConfirmed === false).length, '问孩子后卡上打 ✓') +
      qc('盲解未过/存疑', M.cardsOf().filter(x => M.blindCls(x.card).ok !== true).length, '未过不进组卷池') +
      qc('未办结待办', M.pendingOpen().length, '工作台分区办结') +
      '</div></div>' +
      '</div></div>';

    el.querySelectorAll('[data-code]').forEach(b => b.onclick = () => S.route('bank', { code: b.dataset.code }));
    el.querySelectorAll('[data-kp]').forEach(b => b.onclick = () => S.route('bank', { kp: b.dataset.kp }));
    el.querySelectorAll('[data-risk]').forEach(a => a.onclick = () => S.route('review', { queue: 'due' }));

    /* ★ 2026-11-13（批次 4 / 家长只读报告）：组装报告数据（**只喂已算好的数**，报告函数只排版）。 */
    const reportData = {
      student: M.student(), today: U.today(),
      total: inBook.length,
      archived: cards.length - inBook.length,
      layers: layerItems.map(i => [i.name, i.value]),
      codes: Object.entries(codeCnt).sort((a, b) => b[1] - a[1]).slice(0, 8),
      kp: (kp || []).slice(0, 8).map(k => [String(k.name || k.kp || k[0] || ''), Number(k.n || k.count || k[1] || 0)]),
      days: days, vals: vals,
      risk: (riskList || []).slice(0, 8).map(r => ({
        id: r.x.c.id, title: r.x.c.question || r.x.c.title || '',
        due: r.x.c.nextDue || '', over: r.dd.overdue,
      })),
      /* 一句"现在该做什么"：取三层里最高的那层给动作（与页面上那句"读法"同口径） */
      advice: (function () {
        const top = layerItems.slice().sort((a, b) => b.value - a.value)[0];
        if (!inBook.length) return '库里还没有题——先录几道错题，报告才有话可说。';
        if (!top || !top.value) return '错因还没记全：判分时顺手记一句"错在哪一步"，这份报告会立刻有指向。';
        const T = top.name[0];
        return '当前最漏的是 <b>' + U.esc(top.name) + '</b>（' + top.value + ' 题）——' +
          (T === 'K' ? '先补概念再刷题：把这一层的题连成一组讲一遍，再进复习。'
            : T === 'L' ? '做说理与分类讨论专项：要求每题写清依据与"为什么没有其它情况"。'
              : '做审题与检查习惯专项：圈关键词、写完回读一遍、单位与符号单独查。');
      })(),
    };
    const stPrint = U.$id('stPrint');
    if (stPrint) stPrint.onclick = () => S.printHtml(V.reportHtml(reportData),
      '已送入打印视图：家长报告（可在打印对话框里选「Microsoft Print to PDF」存成单文件）');
    const stPdf = U.$id('stPdf');
    if (stPdf) stPdf.onclick = async () => {
      if (H.mode !== 'shell' || typeof H.pdf !== 'function') { S.toast('存 PDF 需要桌面壳（真浏览器里请用「🖨 打印家长报告」）', 'warn'); return; }
      const old = stPdf.textContent;
      stPdf.disabled = true; stPdf.textContent = '📄 生成中…';
      try {
        /* 复用卷面那条**唯一注入出口**的纪律：先注入，再让宿主转 PDF。
           文件名带 HHmm（2026-10-11 的教训：固定文件名 + 文件正被 PDF 程序打开 ⇒ 必然失败且报错无线索）。 */
        U.$id('printArea').innerHTML = V.reportHtml(reportData);
        const hm = (function () { const dd = new Date(); return String(dd.getHours()).padStart(2, '0') + String(dd.getMinutes()).padStart(2, '0'); })();
        const name = '组卷\\' + U.today() + '-' + (M.student() || '学生') + '-家长报告-' + hm + '.pdf';
        const r = await H.pdf(name);
        if (!r || r.ok === false) throw new Error((r && r.error) || '壳返回失败');
        S.toast('已生成 ' + name + '（' + Math.round((r.bytes || 0) / 1024) + ' KB）', 'ok', 10000);
      } catch (e) {
        S.toast('没能生成 PDF（' + ((e && e.message) || e) + '）——请改用「🖨 打印家长报告」', 'warn', 12000);
      } finally { stPdf.disabled = false; stPdf.textContent = old; }
    };
  };
  function qc(label, n, hint) {
    return '<div style="min-width:150px"><b class="num" style="font-size:24px;color:' + (n ? 'var(--warn)' : 'var(--ok)') + '">' + n + '</b><div class="small">' + label + '<div class="muted" style="font-size:11px">' + hint + '</div></div></div>';
  }
})();
