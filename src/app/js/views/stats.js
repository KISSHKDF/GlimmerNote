/* 错题本 2.0 · 统计分析
 * 原则（调研 C·JLA 综述 + 厂商 A/B 双面）：只呈现「负荷与风险」，不预测分数；每张图挂一个下一步动作；
 * 不做同伴排名。掌握度双轨口径暂以工具既有 passStreak 为准（BKT/FSRS 属未来项，不在试用版写盘）。 */
(function () {
  const U = CTB.util, M = CTB.model, S = CTB.shell;
  const V = CTB.views.stats = {};

  V.sub = () => '范围：' + M.student() + ' · 全库 ' + M.cards.length + ' 题';

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

      '<div class="card"><div class="card-h"><b>薄弱知识点 Top' + kp.length + '</b><span class="hint">kpoints 出现次数</span></div>' +
      CTB.chart.hbars(kp.map(([name, value]) => ({ name, value })), {}) + '</div></div>' +

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
    el.querySelectorAll('[data-risk]').forEach(a => a.onclick = () => S.route('review', { queue: 'due' }));
  };
  function qc(label, n, hint) {
    return '<div style="min-width:150px"><b class="num" style="font-size:24px;color:' + (n ? 'var(--warn)' : 'var(--ok)') + '">' + n + '</b><div class="small">' + label + '<div class="muted" style="font-size:11px">' + hint + '</div></div></div>';
  }
})();
