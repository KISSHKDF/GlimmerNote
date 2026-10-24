/* 错题本 2.0 · 自绘 SVG 图表（无外部依赖、离线、随主题令牌走色） */
(function () {
  const C = CTB.chart = {};
  const esc = CTB.util.esc;

  /* ---------- 环形进度 ---------- */
  C.ring = function (pct, opts) {
    opts = opts || {};
    const size = opts.size || 92, sw = opts.width || 9, color = opts.color || 'var(--brand)';
    const r = (size - sw) / 2, cx = size / 2, c = 2 * Math.PI * r;
    const p = CTB.util.clamp(pct, 0, 100);
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '" role="img">' +
      '<circle cx="' + cx + '" cy="' + cx + '" r="' + r + '" fill="none" stroke="var(--surface3)" stroke-width="' + sw + '"/>' +
      '<circle cx="' + cx + '" cy="' + cx + '" r="' + r + '" fill="none" stroke="' + color + '" stroke-width="' + sw +
      '" stroke-linecap="round" stroke-dasharray="' + (c * p / 100) + ' ' + c + '" transform="rotate(-90 ' + cx + ' ' + cx + ')" style="transition:stroke-dasharray .8s cubic-bezier(.2,.7,.3,1)"/>' +
      (opts.label !== false ? '<text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" font-size="' + (size / 5.2) + '" font-weight="800" fill="var(--text)">' + Math.round(p) + '%</text>' : '') +
      '</svg>';
  };

  /* ---------- 甜甜圈（占比） ---------- */
  C.donut = function (items, opts) {
    opts = opts || {};
    const size = opts.size || 150, sw = opts.width || 22, r = (size - sw) / 2, cx = size / 2, c = 2 * Math.PI * r;
    const total = items.reduce((a, x) => a + x.value, 0);
    if (!total) return '<svg width="' + size + '" height="' + size + '"></svg>';
    let acc = 0, segs = '';
    for (const it of items) {
      if (!it.value) continue;
      const len = c * it.value / total;
      segs += '<circle cx="' + cx + '" cy="' + cx + '" r="' + r + '" fill="none" stroke="' + it.color + '" stroke-width="' + sw +
        '" stroke-dasharray="' + (len - 1.5) + ' ' + (c - len + 1.5) + '" stroke-dashoffset="' + (-acc) + '" transform="rotate(-90 ' + cx + ' ' + cx + ')">' +
        '<title>' + esc(it.name) + '：' + it.value + '（' + Math.round(it.value / total * 100) + '%）</title></circle>';
      acc += len;
    }
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '">' + segs +
      '<text x="50%" y="46%" text-anchor="middle" font-size="' + size / 5.5 + '" font-weight="800" fill="var(--text)">' + total + '</text>' +
      '<text x="50%" y="60%" text-anchor="middle" font-size="' + size / 12 + '" fill="var(--text3)">' + esc(opts.center || '总计') + '</text></svg>';
  };

  /* ---------- 竖向柱状（可分组堆叠） ---------- */
  C.bars = function (labels, series, opts) {
    opts = opts || {};
    const W = opts.width || 460, H = opts.height || 150, padL = 8, padB = 20, padT = 8;
    const maxV = Math.max(1, ...labels.map((_, i) => series.reduce((a, s) => a + (s.values[i] || 0), 0)));
    const bw = (W - padL * 2) / Math.max(1, labels.length);
    const barW = Math.min(bw * 0.56, 56);          // 单学科时不被拉成巨条
    let g = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" preserveAspectRatio="none" style="display:block">';
    labels.forEach((lb, i) => {
      let acc = 0;
      series.forEach(s => {
        const v = s.values[i] || 0; if (!v) return;
        const h = (H - padT - padB) * v / maxV;
        const x = padL + i * bw + (bw - barW) / 2, w = barW;
        const y = H - padB - acc - h;
        g += '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + Math.max(1.5, h - 1) + '" rx="3" fill="' + s.color + '"><title>' + esc(lb) + ' · ' + esc(s.name) + '：' + v + '</title></rect>';
        acc += h;
      });
    });
    /* ⚠ 2026-10-11 修（交互穷举扫描抓到的真缺陷，**三条判据都抓不到**：不抛错、不 console，只能靠量几何）：
       标签行原先用 `justify-content:space-between` + `padding:4px ${bw/2}px 0`，
       而 `bw` 是按 **viewBox 宽度 W=460** 算的、不是按**实际渲染宽度**（统计页单学科时卡片内实测 377px）⇒
       单学科时 padding 左右各 222px，把标签行撑到 444px、超出卡片右缘 51px，
       唯一的 `<span>数学</span>` 被压成 **width=0 完全不可见**（学生=学生A/学生B时「学科×错因层」图没有 x 轴学科名；
       切「全部」5 学科时因文字短反而正常，所以只在单学科下暴露）。
       改成：不加水平 padding，每个标签 `flex:1 1 0; min-width:0; 居中` ——
       与上方柱子的"等分带宽"天然对齐（柱子也是按 labels.length 等分），且不依赖 W 与实际宽度的比例。 */
    g += '</svg><div style="display:flex;padding:4px 0 0;color:var(--text3);font-size:11px">' +
      labels.map(lb => '<span style="flex:1 1 0;min-width:0;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(lb) + '</span>').join('') + '</div>';
    return g;
  };

  /* ---------- 横向条形榜（弱项排行用） ---------- */
  C.hbars = function (rows, opts) {
    opts = opts || {};
    const max = Math.max(1, ...rows.map(r => r.value));
    return rows.map(r =>
      '<div class="kbar"><span class="kn" title="' + esc(r.name) + '">' + esc(r.name) + '</span>' +
      '<div class="pbar"><i style="width:' + (r.value / max * 100) + '%;background:' + (r.color || 'var(--brand)') + '"></i></div>' +
      '<span class="kv2">' + r.value + '</span></div>'
    ).join('') || ('<div class="empty sm ready"><div class="e-ic">🏷️</div><b>还没有知识点标签</b>' +
      '<div class="e-sub">错题卡填了 kpoints 之后，这里会自动排出弱项榜。</div>' +
      '<div class="e-act"><a class="btn sm" data-go="bank">去题库浏览 →</a></div></div>');
  };

  /* ---------- sparkline ---------- */
  C.spark = function (values, opts) {
    opts = opts || {};
    const W = opts.width || 120, H = opts.height || 28, color = opts.color || 'var(--brand)';
    const max = Math.max(1, ...values);
    if (values.length < 2) return '';
    const pts = values.map((v, i) => (i / (values.length - 1)) * W + ',' + (H - 3 - (H - 6) * v / max));
    return '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">' +
      '<polyline points="' + pts.join(' ') + '" fill="none" stroke="' + color + '" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" opacity=".8"/></svg>';
  };

  /* ---------- 折线（周趋势） ---------- */
  C.line = function (labels, series, opts) {
    opts = opts || {};
    const W = opts.width || 560, H = opts.height || 150, padL = 26, padR = 8, padT = 10, padB = 22;
    const max = Math.max(1, ...series.flatMap(s => s.values));
    const xs = i => padL + (W - padL - padR) * (labels.length === 1 ? 0.5 : i / (labels.length - 1));
    const ys = v => H - padB - (H - padT - padB) * v / max;
    let g = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="display:block">';
    for (let k = 0; k <= 3; k++) {
      const yv = max * k / 3, y = ys(yv);
      g += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y + '" y2="' + y + '" stroke="var(--line)" stroke-dasharray="3 4"/>' +
        '<text x="' + (padL - 6) + '" y="' + (y + 3.5) + '" text-anchor="end" font-size="10" fill="var(--text3)">' + Math.round(yv) + '</text>';
    }
    series.forEach(s => {
      if (!s.values.length) return;
      g += '<polyline points="' + s.values.map((v, i) => xs(i) + ',' + ys(v)).join(' ') + '" fill="none" stroke="' + s.color + '" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>';
      s.values.forEach((v, i) => { g += '<circle cx="' + xs(i) + '" cy="' + ys(v) + '" r="3" fill="var(--surface)" stroke="' + s.color + '" stroke-width="2"><title>' + esc(labels[i]) + '：' + v + '</title></circle>'; });
    });
    const step = Math.ceil(labels.length / 9);
    g += labels.map((lb, i) => i % step ? '' : '<text x="' + xs(i) + '" y="' + (H - 6) + '" text-anchor="middle" font-size="10" fill="var(--text3)">' + esc(lb) + '</text>').join('');
    return g + '</svg>';
  };

  /* ---------- 热力日历（GitHub 式；values: {date:'yyyy-mm-dd':n}） ----------
     2026-10-11 重做。两个真问题：
       ① 视口荒芜：固定画 53 周（近一年），而本库现实是「近一年几乎全空」⇒ 满屏灰格子，
          读起来像「太荒芜 / 是不是坏了」。现在默认只画近 12 周（`opts.weeks`，0=近一年），
          并在图上方给一行数字摘要——**空也要空得有信息**，不是一片没有解释的灰。
       ② 顶栅格：SVG 用固定 `width`，而「图例 + 月份」那行是不换行 flex、月份右边距按格子宽算
          （12×60px）⇒ 整卡 min-content ≈1147px，把 .g-21 的 2fr 轨道顶到 1189px，
          右栏「学科盘面」被挤成一字一行（见 docs §2）。现在月份行与本体一起进 `.hm-inner`，
          整体裹在 `.hm-wrap`（overflow-x:auto）里 ⇒ 缩小时整块横向滚，不向栅格索要宽度。 */
  C.heatmap = function (values, opts) {
    opts = opts || {};
    values = values || {};
    const nWeeks = opts.weeks === 0 ? 53 : (opts.weeks || 12);
    const day = opts.cell || 12, gap = 3, cell = day + gap;
    const end = new Date(); end.setHours(0, 0, 0, 0);
    const start = new Date(end); start.setDate(start.getDate() - (nWeeks - 1) * 7 - (end.getDay() + 6) % 7);
    let max = 1; for (const k in values) max = Math.max(max, values[k]);
    const weeks = [];
    const cur = new Date(start);
    while (cur <= end) {
      const wk = [];
      for (let d = 0; d < 7; d++) { wk.push(CTB.util.dstr(cur)); cur.setDate(cur.getDate() + 1); }
      weeks.push(wk);
    }
    const colorFor = n => n === 0 ? 'var(--surface3)'
      : 'color-mix(in srgb,var(--brand) ' + Math.round(22 + 78 * Math.min(1, n / max)) + '%, var(--surface3))';
    let g = '<svg width="' + (weeks.length * cell) + '" height="' + (7 * cell + 2) + '" role="img" aria-label="学习热力日历">';
    weeks.forEach((wk, wi) => wk.forEach((ds, di) => {
      const n = values[ds] || 0;
      const future = ds > CTB.util.today();
      g += '<rect class="hm-cell" x="' + (wi * cell) + '" y="' + (di * cell) + '" width="' + day + '" height="' + day + '" rx="2.5" fill="' + (future ? 'transparent' : colorFor(n)) + '"><title>' + ds + '：' + n + ' 题</title></rect>';
    }));
    g += '</svg>';
    /* 月份刻度：按「该月占了几周」给宽度，和上面的格子逐列对齐（整块随 .hm-wrap 一起滚） */
    const months = [];
    let lastM = -1, cnt = 0;
    weeks.forEach(wk => {
      const m = +wk[3].slice(5, 7);
      if (m !== lastM) { if (lastM > 0) months.push({ m: lastM, n: cnt }); lastM = m; cnt = 0; }
      cnt++;
    });
    if (cnt) months.push({ m: lastM, n: cnt });
    const monthRow = '<div class="hm-months-row">' + months.map(x =>
      '<span style="width:' + (x.n * cell) + 'px">' + x.m + '月</span>').join('') + '</div>';
    /* 一行摘要：把「这一片灰」翻译成事实 */
    let act = 0, total = 0;
    for (const wk of weeks) for (const ds of wk) { const n = values[ds] || 0; if (n > 0) act++; total += n; }
    /* 版式：短范围（12/26 周）格子少，若只靠左对齐会在卡里留下一大片空白（又变回「荒芜感」）。
       所以把「数字」搬到图右侧（.hm-side），既填满横向空间，又把「这段到底发生了什么」讲清楚；
       近一年时 .hm-main 收窄、.hm-wrap 横向滚动，右侧数字照旧可读。 */
    const side = '<div class="hm-side">' +
      '<div class="hm-k"><b class="num">' + total + '</b><span>' + (opts.rangeLabel || ('近 ' + nWeeks + ' 周')) + '入册/复习题数</span></div>' +
      '<div class="hm-k"><b class="num">' + act + '</b><span>有记录的天数</span></div>' +
      '<div class="hm-k"><b class="num">' + (opts.streak || 0) + '</b><span>当前连续天数</span></div>' +
      (total ? '' : '<div class="hm-empty">这段时间还没有动过——今天做的第一题就会出现在右下角。</div>') +
      '</div>';
    return '<div class="hm-body"><div class="hm-main">' +
      '<div class="hm-wrap"><div class="hm-inner">' + g + monthRow + '</div></div>' +
      '<div class="hm-lg"><span>少</span>' +
      [0, 1, 2, 3, 4].map(n => '<i style="background:' + colorFor(Math.max(1, n * max / 4)) + '"></i>').join('') +
      '<span>多</span></div></div>' + side + '</div>';
  };
})();
