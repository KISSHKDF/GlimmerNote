/* 拾光小册 · 经验包（只读视图，2026-11-03 批次 2 建）
 *
 * 这一页解决什么：录题页要「选卡」，可选之前得先能看清本机装了哪些包、哪个是坏的、怎么停用。
 * 三条纪律（与录题页同族 —— 本仓最忌讳的一类缺陷就是"界面静默降级"）：
 *   ① **只读**：不安装、不停用、不删、不遍历目录。装 = 手工把包文件夹复制过去；
 *      停 = 在包目录放一个 `.停用` 文件。这两件事只写在页面文字里，程序不代做。
 *   ② 工具失败 / 返回不是 JSON / 清单里**没有 `packs` 字段** ⇒ 把原因上屏；
 *      绝不渲染成"一个包都没装"——这两件事用户要做的动作完全不同（前者去修通道，后者去装包）。
 *   ③ 不显示本机绝对路径（隐私红线：界面截图与报障都会带出去）。
 *
 * 数据真源：`_配方.mjs 清单 --json` 的 `packs` 字段（= `src\tools\_经验包.mjs` 的 `listPacks()`）。
 * 形状（契约 §2.2，本页只读不改）：
 *   { id, version, dir, enabled, verdict:{ ok, errors:[{code,what,why}] }, title, author, license }
 * 契约细节（目录布局、选卡串、停用标记、限值）见 `docs\经验包规范.md`；本页只是它的一个消费者。
 */
(function () {
  const U = CTB.util, H = CTB.host, S = CTB.shell;
  const V = CTB.views.packs = {};

  /* { ok, packs, error } —— 只活在内存里。装了新包请点「⟳ 重新读」（页面不做目录遍历）。 */
  let cache = null;

  /* 读清单：**唯一实现**（录题页的选卡区也调它，不各写一份解析 —— 两份实现必然漂移，本仓 L-286）。
     三种结局必须分开，不许混成一个"空"：
       · 通道失败 / 不是 JSON / 没有 packs 字段 ⇒ ok:false + error（页面显示原因）
       · packs: []                              ⇒ ok:true，真的一个包都没装（空态）
       · packs: [...]                           ⇒ ok:true，正常 */
  V.load = async function (force) {
    if (cache && !force) return cache;
    try {
      const r = await H.recipe('清单', { json: '1' });
      /* 判据与录题页 `onGenerate`/`loadInbox` 逐字同口径：工具/壳失败时 stdout 是空的，
         只看 out 会把"失败"读成"没装包"（同一族只许一个判据）。 */
      const okFlag = !(r && r.ok === false) && !(r && r.code && r.code !== 0);
      if (!okFlag) {
        throw new Error(String((r && (r.err || r.out)) || '').trim() ||
          ('读经验包清单失败（工具退出码 ' + ((r && r.code) || '?') + '）'));
      }
      const t = String((r && r.out) || '').replace(/^\uFEFF/, '').trim();
      if (!t) throw new Error('读经验包清单失败：工具没有返回内容（退出码 ' + ((r && r.code) || '?') + '）');
      let j = null;
      try { j = JSON.parse(t); }
      catch (e) { throw new Error('读经验包清单失败：返回的不是 JSON（' + String((e && e.message) || e) + '）'); }
      if (!j || !Array.isArray(j.packs)) {
        /* 工具在"经验包段落失败"时给的是 `packs: null` + `packsError: <原因>`（_配方.mjs 的
           packsListing：段落失败不影响配方清单）。**这句原因必须转出来**，否则用户只看到
           "没有 packs 字段"，而真正的原因（模块缺失 / 权限 / 目录读不动）被吞掉。 */
        const why0 = (j && j.packsError) ? String(j.packsError) : '';
        throw new Error(why0
          ? ('经验包段落没有生成出来（工具报的原因：' + why0 + '）')
          : '清单里没有 packs 字段 —— 多半是工具版本对不上（老壳配新页/新壳配老工具）');
      }
      cache = { ok: true, packs: j.packs, error: null };
    } catch (e) {
      cache = { ok: false, packs: [], error: String((e && e.message) || e) };
    }
    return cache;
  };
  /* 供「录题」页与用例：清掉缓存，下一次 load 必然重读。 */
  V.clearCache = function () { cache = null; };

  V.enabledText = p => (p && p.enabled ? '启用' : '已停用');
  /* 停用不是终点：必须同时告诉用户"怎么恢复"，否则他只会以为包坏了。 */
  V.enabledWhy = p => (p && p.enabled) ? '' :
    '包目录里有 `.停用` 文件 ⇒ 不能选卡；要恢复：删掉那个文件，再点「⟳ 重新读」';

  /* 逐包校验结论：errors 每条形如 { code, what, why }，逐条照实说，不合并成一句"校验失败"。 */
  V.verdictText = function (p) {
    const v = (p && p.verdict) || null;
    if (!v) return '校验结论：清单没给（工具版本可能偏旧）';
    if (v.ok) return '校验结论：通过';
    const errs = Array.isArray(v.errors) ? v.errors : [];
    if (!errs.length) return '校验结论：不通过（清单没给具体原因）';
    return '校验结论：不通过 —— ' + errs.map(e => {
      const s = [e && e.what, e && e.why].filter(Boolean).join('：');
      return s || '（未说明）';
    }).join('；');
  };

  /* 来源：清单给的是包目录。相对路径原样显示；**绝对路径一律脱敏**（隐私红线）。
     是不是绝对不靠正则里的盘符转义（那是 lint L2 的雷区）：有冒号、或首字符是分隔符即视为绝对。 */
  V.srcText = function (p) {
    const d = String((p && p.dir) || '').replace(/\\/g, '/');
    if (!d) return '（清单没给来源）';
    const abs = d.indexOf(':') >= 0 || d.startsWith('/');
    if (!abs) return d;
    const seg = d.split('/').filter(Boolean);
    return '…/' + seg.slice(-3).join('/');
  };

  V.sub = function () {
    if (!cache) return '经验包：还没读';
    if (!cache.ok) return '经验包：读不到清单';
    const n = cache.packs.length;
    if (!n) return '没有安装任何经验包';
    const on = cache.packs.filter(p => p && p.enabled).length;
    return '已装 ' + n + ' 个包 · 启用 ' + on;
  };

  V.render = function (el) {
    el.innerHTML =
      '<div class="card ig-hero">' +
      '<div class="ig-hero-t">📦 经验包（方法卡）</div>' +
      '<div class="small muted ig-hero-b">经验包是别人踩完坑写下的<b>方法卡</b>：录题时把卡选进任务单，' +
      '你的 AI 就照这些方法干活。本程序仍然<b>不联网、不装任何东西</b>；<b>本页只读</b>——不安装、不停用、不改你的任何文件。</div>' +
      '</div>' +
      '<div class="card ig-step">' +
      '<div class="row ig-opts"><div class="ig-h">已安装的经验包</div><span class="tb-sp"></span>' +
      '<button class="btn sm ghost" id="pkReload">⟳ 重新读</button></div>' +
      '<div id="pkBox" class="small muted">正在读经验包…</div>' +
      '</div>' +
      '<div class="card ig-step">' +
      '<div class="ig-h">怎么装 / 怎么停</div>' +
      '<div class="small muted" style="line-height:1.9">' +
      '① <b>怎么装</b>：把整个包文件夹复制到<b>经验包根</b> <code>%LOCALAPPDATA%\\拾光小册\\经验包\\</code> 下，' +
      '层级照包自带说明（形如 <code>&lt;包ID&gt;\\&lt;版本&gt;\\</code>，里面要有 <code>pack.json</code>）；' +
      '开发机可用环境变量 <code>CTB_PACKS</code> 指到别处。<br>' +
      '② <b>怎么停</b>：在包目录里放一个名为 <code>.停用</code> 的文件（内容随意，建议写停用原因），' +
      '再点上面的「⟳ 重新读」——停用的包会显示「已停用」，在录题页也选不了；删掉这个文件即恢复。' +
      '</div>' +
      '</div>';
    U.$id('pkReload').onclick = reload;
    paint();
  };

  function packRow(p) {
    const on = !!(p && p.enabled);
    const title = (p && p.title) || (p && p.id) || '(无标题)';
    const meta = ['来源 ' + V.srcText(p), '版本 ' + ((p && p.version) || '?')];
    if (p && p.author) meta.push('作者 ' + p.author);
    if (p && p.license) meta.push('许可 ' + p.license);
    return '<div class="ig-file" style="align-items:flex-start">' +
      '<span class="ig-fn">' +
      '<b>' + U.esc(title) + '</b> <code>' + U.esc((p && p.id) || '') + '</code>' +
      '<div class="small muted">' + U.esc(meta.join(' · ')) + '</div>' +
      '<div class="small muted">' + U.esc(V.verdictText(p)) + '</div>' +
      (on ? '' : '<div class="small muted ig-archnote">' + U.esc(V.enabledWhy(p)) + '</div>') +
      '</span>' +
      '<span class="tag ' + (on ? 'ok' : 'warn') + '">' + V.enabledText(p) + '</span>' +
      '</div>';
  }

  async function reload() {
    const b = U.$id('pkBox');
    if (b) b.innerHTML = '<span class="small muted">⟳ 正在重新读…</span>';
    await V.load(true);
    paint();
  }

  async function paint() {
    const box = U.$id('pkBox');
    if (!box) return;
    const r = await V.load(false);
    if (!r.ok) {
      box.innerHTML = '<div class="ig-warn">✖ 读不到经验包清单</div>' +
        '<pre class="ig-pre ig-bad">' + U.esc(r.error) + '</pre>' +
        '<div class="small muted">这条<b>不等于</b>「没装包」——先按上面的原因排查（多半是桌面壳通道或工具版本）。' +
        '若在浏览器里直开本页，读清单这条通道不可用，请用桌面壳（拾光小册.exe）。</div>';
    } else if (!r.packs.length) {
      box.innerHTML = '<div class="empty">没有安装任何经验包</div>' +
        '<div class="small muted" style="margin-top:6px">没装也能正常录题（任务单只是不含方法卡）。要装看下面「怎么装」。</div>';
    } else {
      box.innerHTML = r.packs.map(packRow).join('');
    }
    if (S.refreshSub) S.refreshSub();
  }

  /* 切到本页时强制重读一次：刚复制进来的包、刚放下的 `.停用` 都应该当场看见。 */
  V.onShow = function () { V.load(true).then(paint); };
})();
