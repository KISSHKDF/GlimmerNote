/* 拾光小册 · 录题（配方层界面，2026-10-27 建）
 *
 * 这一页解决什么（用户原话）：「别人下载了我们的程序，换成他自己手中的 AI，
 * 能做到不踩与我们同样的坑吗？」—— 程序不带大脑，但把"说明书和判卷标准"交给用户。
 *
 * 三段式（对应 _配方.mjs 的三个动作）：
 *   ① **收件箱**：把照片丢进 数据\_收件箱\<批次>\，这里就能看见（不提供文件选择框：
 *      用户明确说过"不考虑人工输入原图"，入口就是收件箱本身）
 *   ② **生成任务单**：选配方式和学科 → 拼出完整提示词 → 复制给你自己的 AI
 *   ③ **校验回传**：AI 的 JSON 粘回来 → 逐条按 schema 校验 → 告诉你哪条不合格
 *
 * ★ 2026-11-04：第 ③ 步之后接上**第四步「建卡入库」**。
 *   改前本页走完校验+确认就**结束**（写着「本页不落库」），因为仓内**没有任何东西能把 JSON 变成卡**：
 *   实测 2026-11-04 19:36 那次录题，任务记录 `cards` 是**空数组**、库里**零张新卡**。
 *   现在 `_录题入库.mjs`（仓内新增）+ 壳 op `ingestLand` 把这条链接上了。
 *
 * 三条界面纪律：
 *   · 校验环节**只读**；**入库**是第四步的显式按钮，且必须走桌面壳通道（写用户库）；
 *   · 不显示本机绝对路径（隐私红线：截图和报障都会带出去）；
 *   · 校验不通过时**逐条说清哪里错**，不弹一句"失败了"。
 */
(function () {
  const U = CTB.util, M = CTB.model, H = CTB.host, S = CTB.shell;
  const V = CTB.views.ingest = {};

  const LS_KEY = 'ctb2.ingest';
  const st = Object.assign({
    recipe: 'ingest-page',   /* 默认整页：一次作业往往错好几道，整页比单题省事 */
    subject: '数学',
    conflict: 'deny',        /* 选卡冲突策略：deny=拒绝（契约默认）/ first=先到先得 / all=全部 */
    batch: '',
    picked: {},              /* rel → true，收件箱里勾了哪些图 */
    typed: {},               /* packId → 用户填的卡 ID 原文（逗号分隔）—— 见下方「选卡」 */
    packs: null,             /* 经验包清单缓存（形状见 views/packs.js 的 V.load） */
    task: '',                /* 生成好的任务单全文 */
    verdict: null,           /* 校验结果 */
    inbox: null,
  }, U.lsGet(LS_KEY, {}));
  const save = () => U.lsSet(LS_KEY, { recipe: st.recipe, subject: st.subject, conflict: st.conflict });
  /* 这几个不持久化：每次进来重新取，避免"昨天选中的图/卡今天还在"的错觉
     —— 静默带出来的残留选择比空着更危险（用户会以为是自己这次选的）。 */
  st.task = ''; st.verdict = null; st.inbox = null; st.picked = {}; st.batch = '';
  st.typed = {}; st.packs = null;
  /* 冲突策略是持久化的，但 localStorage 里的值可能被改坏/来自旧版本 ⇒ 白名单兜底，不许把野值送进壳。 */
  if (!/^(deny|first|all)$/.test(String(st.conflict))) st.conflict = 'deny';
  /* 本次生成任务单对应的那一张（rel + 内容指纹）。只活在内存里，切页即失效。 */
  st.shot = null;
  /* ★ 2026-11-03（批次 1 收尾「页面接线」）：本次生成对应的任务号（<库根>\_录题\<taskId>.json）。
     与 st.shot 同一生命周期：只活在内存里；重新生成任务单就换新任务（同图同配方也是**两个**任务，
     这正是"错配必须被发现"的前提）。任务记录本体随库走，这里是"当前正在校验哪一次"的句柄。 */
  st.taskId = null;

  const SUBJECTS = ['数学', '语文', '英语', '物理', '化学', '生物', '历史', '地理', '政治'];

  V.sub = () => {
    const n = st.inbox ? st.inbox.total : 0;
    return n ? ('收件箱 ' + n + ' 张待处理') : '收件箱空着';
  };
  /* 侧栏角标（shell.js 的 ingestPending 读它）。来源只有本页缓存，不起进程。 */
  V.pendingCount = () => (st.inbox ? st.inbox.total : 0);

  /* ---------- 复制（WebView2 里 navigator.clipboard 常不可用，三层兜底） ---------- */
  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* 落到下一层 */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed'; ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }

  /* ---------- 取收件箱 ---------- */
  /* ⚠ 2026-10-29 修（R2 审计 D-02，与下面 :261 的「组装」同族）：
     原代码只看 `r.out` —— 工具/壳失败时 stdout 是空的，于是**空字符串被当成"收件箱还是空的"**，
     页面显示"把错题照片放进去"，用户会一直去反复丢照片，永远看不到真因（配方目录缺失 / node 报错 /
     壳通道失败）。判据与同文件 `onGenerate` 的 `okFlag` **逐字同口径**（同一族只许一个判据）：
     失败必须 throw ⇒ 由 catch 落进 `st.inbox.error` ⇒ paintInbox 渲染"读不到收件箱"+ 原因。 */
  async function loadInbox(force) {
    if (st.inbox && !force) return st.inbox;
    try {
      const r = await H.recipe('收件箱', { json: '1' });
      const okFlag = !(r && r.ok === false) && !(r && r.code && r.code !== 0);
      if (!okFlag) {
        throw new Error(String((r && (r.err || r.out)) || '').trim() ||
          ('读收件箱失败（工具退出码 ' + ((r && r.code) || '?') + '）'));
      }
      const t = String((r && r.out) || '').replace(/^\uFEFF/, '').trim();
      if (!t) throw new Error('读收件箱失败：工具没有返回内容（退出码 ' + ((r && r.code) || '?') + '）');
      st.inbox = JSON.parse(t);
    } catch (e) {
      st.inbox = { batches: [], total: 0, error: String(e && e.message || e) };
    }
    return st.inbox;
  }

  /* ---------- 视图 ---------- */
  V.render = function (el) {
    el.innerHTML =
      '<div class="card ig-hero">' +
      '<div class="ig-hero-t">📥 录题 · 用你自己的 AI</div>' +
      '<div class="small muted ig-hero-b">程序<b>不联网、不带模型、不收密钥</b>。它只做两件事：' +
      '把「怎么把照片变成错题卡」写成任务单交给你；把你拿回来的答案按契约逐条校验。' +
      '判错、转录、切图这些活由你的 AI 干 —— 坑我们已经替你踩平了。</div>' +
      '</div>' +
      '<div class="card ig-step">' +
      '<div class="ig-h"><span class="ig-n">1</span>把照片放进收件箱</div>' +
      '<div class="small muted" id="igInboxBox">正在读收件箱…</div>' +
      '</div>' +
      '<div class="card ig-step">' +
      '<div class="ig-h"><span class="ig-n">2</span>生成任务单，交给你的 AI</div>' +
      '<div class="row ig-opts">' +
      '<label class="ig-f"><span>配方</span>' +
      '<select id="igRecipe" class="bk-sort">' +
      '<option value="ingest-page">整页多题（一次作业错好几道就用这个）</option>' +
      '<option value="ingest-single">单题（只拍了一道题）</option>' +
      '</select></label>' +
      '<label class="ig-f"><span>学科</span><select id="igSubject" class="bk-sort">' +
      SUBJECTS.map(s => '<option value="' + U.esc(s) + '">' + U.esc(s) + '</option>').join('') +
      '</select></label>' +
      '<span class="tb-sp"></span>' +
      '<button class="btn sm primary" id="igGen">生成任务单</button>' +
      '</div>' +
      /* ★ 2026-11-03（批次 2 · 经验包）：选卡区。卡 = 方法卡，选了就随任务单一起交给 AI。
         只读清单 + 只读选择，不做安装/停用（那是用户在文件夹里的手工动作，页面不代做）。 */
      '<div class="ig-arch" style="margin-top:10px">' +
      '<div class="row ig-opts">' +
      '<label class="ig-f"><span>选卡冲突策略</span><select id="igConflict" class="bk-sort">' +
      '<option value="deny">拒绝（默认）</option>' +
      '<option value="first">先到先得</option>' +
      '<option value="all">全部拼入</option>' +
      '</select></label>' +
      '<span class="small muted" style="max-width:280px">两张卡覆盖同一个步骤时的处理：拒绝＝直接报错让你重选</span>' +
      '<span class="tb-sp"></span>' +
      '<button class="btn sm ghost" id="igPacksReload">⟳ 重新读经验包</button>' +
      '</div>' +
      '<div id="igPackBox" class="small muted" style="margin-top:6px">正在读经验包…</div>' +
      '</div>' +
      '<div id="igTaskBox"></div>' +
      '</div>' +
      '<div class="card ig-step">' +
      '<div class="ig-h"><span class="ig-n">3</span>把 AI 的答案粘回来校验</div>' +
      '<div class="small muted">把 AI 输出的那一整段<b>原样</b>粘进来（外面裹了解释文字也没关系，程序会自己剥掉；' +
      '一份 JSON 里用了 <code>envelope</code> 就必须同时有 <code>result</code>，缺哪样会直接点名）。' +
      '<b>生成任务单后走三层校验（格式 → 与任务及原图匹配 → 人工确认）</b>；' +
      '没生成任务单时只校验格式，会明确标"未与任务关联"。</div>' +
      '<textarea id="igIn" class="ig-ta" placeholder="粘贴 cards.json 内容，例如 {&quot;envelope&quot;:{…},&quot;result&quot;:{&quot;cards&quot;:[…]}}"></textarea>' +
      '<div class="row" style="margin-top:8px"><button class="btn sm primary" id="igCheck">校验</button>' +
      '<span class="small muted">★ 2026-11-04：校验通过并<b>人工确认</b>后，下面会出现「📥 建卡入库」按钮 —— ' +
      '点它，卡当场进库（门禁当场跑，盲解清稿当场备好）。</span></div>' +
      '<div id="igResult"></div>' +
      '</div>';

    const rSel = U.$id('igRecipe'), sSel = U.$id('igSubject');
    rSel.value = st.recipe; sSel.value = st.subject;
    rSel.onchange = () => { st.recipe = rSel.value; save(); };
    sSel.onchange = () => { st.subject = sSel.value; save(); };
    /* 冲突策略三态（值必须与契约 §3.1 逐字一致：deny|first|all） */
    const cSel = U.$id('igConflict');
    if (cSel) { cSel.value = st.conflict; cSel.onchange = () => { st.conflict = cSel.value; save(); }; }
    const pr = U.$id('igPacksReload');
    if (pr) pr.onclick = reloadPacks;
    U.$id('igGen').onclick = onGenerate;
    U.$id('igCheck').onclick = onCheck;

    paintInbox();
    paintPacks();
  };

  /* 打开收件箱文件夹（2026-10-27 加）
   * 用户提的：现在只能自己在资源管理器里翻到 `数据\_收件箱`，多一步且容易找错。
   * 实现走壳已有的 `revealFile`（它 File.Exists → explorer /select，Directory.Exists → 直接打开目录），
   * 所以**不需要新 op、不需要重编壳之外的东西**；路径固定传 `_收件箱`，不接受页面传任意路径。 */
  async function openInboxFolder() {
    try {
      const r = await H.reveal('_收件箱');
      if (r && r.ok === false) S.toast('打不开文件夹：' + (r.error || '未知原因'), 'warn', 6000);
    } catch (e) {
      S.toast('打不开文件夹：' + String(e && e.message || e), 'warn', 6000);
    }
  }

  /* 「📂 定位这张图」——把要发出去的那**一张**在资源管理器里选中。
   * 起因（2026-10-27 第二次"任务单交不出去"）：任务单只写文件名，而收件箱里的照片会被导入
   *   流程按页码改名（微信图片_…_242_134.jpg → p042.jpg，sha256 不变）。用户拿着旧单子
   *   照名字翻文件夹 ⇒ 找不到 ⇒ 附件没发 ⇒ 对端 AI 按止损指令回「我没有看到图片」（它拒得对）。
   * 所以"发哪张图"不能靠人对名字的记忆，必须由程序指认。
   * 按指纹兜底：勾选时那条路径若已失效，用收件箱列表里已缓存的 sha256 找回同内容的那一张。
   *   —— 这里**不调** `找图` 动作：壳的 RECIPE_ACTIONS 白名单（清单/收件箱/组装/校验/自检/指纹）
   *      没有它，加一个动作就得重编 exe；而本页本来就握着每张图的 sha256，纯内存查表足够。 */
  function inboxFiles() {
    const out = [];
    for (const b of ((st.inbox && st.inbox.batches) || [])) for (const f of (b.files || [])) out.push(f);
    return out;
  }
  async function revealShot() {
    const shot = st.shot;
    if (!shot || !shot.rel) { S.toast('先勾一张照片再生成任务单', 'warn', 6000); return; }
    try {
      const r = await H.reveal(shot.rel);
      if (r && r.ok !== false) return;
      /* 路径失效 ⇒ 按指纹在同源列表里找那一张 */
      const alt = shot.sha256 ? inboxFiles().find(f => f.sha256 === shot.sha256) : null;
      if (alt && alt.rel !== shot.rel) {
        const r2 = await H.reveal(alt.rel);
        if (r2 && r2.ok !== false) {
          st.shot = { rel: alt.rel, sha256: alt.sha256, name: alt.name };
          S.toast('这张图现在叫「' + alt.name + '」—— 已按内容指纹找回并选中', 'ok', 8000);
          return;
        }
        S.toast('按指纹找到了，但资源管理器打不开：' + (r2.error || '未知原因'), 'warn', 7000);
        return;
      }
      S.toast('打不开这张图：' + (r.error || '未知原因') +
        '（多半是照片被移走或改过名 —— 点上面「⟳ 刷新」重读收件箱，再重新勾一次）', 'bad', 9000);
    } catch (e) {
      S.toast('打不开这张图：' + String(e && e.message || e), 'warn', 6000);
    }
  }

  async function paintInbox() {
    const box = U.$id('igInboxBox');
    if (!box) return;
    const r = await loadInbox(false);
    if (r.error) {
      box.innerHTML = '<span class="tag bad">读不到收件箱</span> ' + U.esc(r.error) +
        '<br><span class="small muted">若是浏览器模式打开，本页不能用（需要桌面壳：拾光小册.exe）。</span>';
      return;
    }
    const archN = r.archivedCount || 0;
    const archNote = String(r.archivedNote || '');
    /* ⚠ 2026-10-31：跳过项（读不动 / 越出库根）必须说出口。
       这些文件**没有**出现在任何清单里，用户看不到就以为照片丢了。
       "不许静默少列"是这条链路的纪律。 */
    const skipNote = String(r.skipNote || '');
    const skipHtml = skipNote
      ? '<div class="small muted ig-archnote">⚠ 有 ' + U.esc(skipNote) + '，未列入清单（文件仍在收件箱里，没被删）</div>'
      : '';
    if (!r.total) {
      box.innerHTML = '<div class="row" style="margin-bottom:8px">' +
        '<button class="btn sm primary" id="igOpenInbox">📂 打开收件箱文件夹</button>' +
        '<span class="small muted">把错题照片放进去，回来点「刷新」</span>' +
        '<button class="btn sm ghost" id="igRefresh">⟳ 刷新</button></div>' +
        (archN
          ? '<b>没有待处理的照片了。</b>收件箱里 ' + archN + ' 张都已经处理过（已归档，不再列在这里）。<br>' +
            '<span class="small muted">照片<b>一张都没删</b>，仍在 <b>数据\\_收件箱</b> 下；要重做某张，先把它从收件箱挪出去。</span>'
          : '收件箱还是空的。<br>' +
            '<span class="small muted">按批次建子文件夹更好找，例：<b>_收件箱\\数学-10月28日\\</b>' +
            '（不建子文件夹也能用，直接丢在 _收件箱 下即可）</span>') +
        (archNote ? '<div class="small muted ig-archnote">⚠ ' + U.esc(archNote) + '</div>' : '') +
        skipHtml +
        archBlockHtml(r);
      wireInboxButtons(box);
      wireArch(box, archN);
      return;
    }
    const rows = [];
    for (const b of r.batches) {
      rows.push('<div class="ig-batch">▸ <b>' + U.esc(b.name) + '</b>　<span class="small muted">' + b.files.length + ' 张</span></div>');
      for (const f of b.files) {
        const on = !!st.picked[f.rel];
        rows.push('<label class="ig-file' + (on ? ' on' : '') + '">' +
          '<input type="checkbox" data-rel="' + U.esc(f.rel) + '"' + (on ? ' checked' : '') + '>' +
          '<span class="ig-fn">' + U.esc(f.name) + '</span>' +
          '<span class="small muted">' + (f.bytes / 1024).toFixed(0) + ' KB</span>' +
          '<span class="small muted ig-sha" title="内容指纹（溯源用）">' + U.esc(f.sha256.slice(0, 10)) + '</span>' +
          '</label>');
      }
    }
    box.innerHTML = '<div class="row" style="margin-bottom:8px">' +
      '<button class="btn sm" id="igOpenInbox">📂 打开收件箱文件夹</button>' +
      '<button class="btn sm ghost" id="igRefresh">⟳ 刷新</button></div>' +
      '<div class="small muted" style="margin-bottom:6px">共 ' + r.batches.length + ' 批 / ' +
      r.total + ' 张待处理' +
      (archN ? '　<b>另有 ' + archN + ' 张已处理，已归档不显示</b>' : '') +
      '。勾选要处理的那一张（一次一张，判错准确率最高）。</div>' +
      (archNote ? '<div class="small muted ig-archnote">⚠ ' + U.esc(archNote) + '</div>' : '') +
      skipHtml +
      rows.join('') + archBlockHtml(r);
    wireInboxButtons(box);
    wireArch(box, archN);
    box.querySelectorAll('input[data-rel]').forEach(cb => {
      cb.onchange = () => {
        if (cb.checked) { st.picked = {}; }   /* 单选语义：勾新的就取消旧的 */
        st.picked[cb.dataset.rel] = cb.checked;
        if (!cb.checked) delete st.picked[cb.dataset.rel];
        box.querySelectorAll('label.ig-file').forEach(l => l.classList.remove('on'));
        const cur = box.querySelector('input[data-rel="' + CSS.escape(cb.dataset.rel) + '"]');
        if (cur && cur.checked) cur.closest('label').classList.add('on');
      };
    });
  }

  /* ---------- 「已归档」区（2026-10-30 加）----------
   * 用户原话：「把所有的照片都显示出来，又长又多，显示还慢，这个设置明显不合理。
   *   应该把已处理过的照片全部归档，不要在这个窗口显示了」。
   * 判定在工具侧（`_配方.mjs`：被 `_原卷台账.json` 里某张卡引用过 = 已处理），页面只做两件事：
   *   ① 把结论**说清楚**（多少张、为什么不算待办、文件没删）——不许悄悄消失；
   *   ② 需要时能翻出来核对（折叠起来，默认不占地方）。
   * 列表**只读**、不给勾选：已处理的照片再发一遍只会重复建卡；要看原图走题库的「原图」。 */
  function archRowsByBatch(list) {
    const groups = new Map();
    for (const f of list) {
      /* rel 形如 `_收件箱/<批次>/<文件名>` 或 `_收件箱/<文件名>`；只取中间的批次名，不显示盘符与库根 */
      const parts = String(f.rel || '').split('/');
      const dir = parts.length > 2 ? parts.slice(1, -1).join('/') : '';
      const key = dir || '（未分批）';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(f);
    }
    const out = [];
    for (const [dir, files] of groups) {
      out.push('<div class="ig-batch">▸ <b>' + U.esc(dir) + '</b>　<span class="small muted">' + files.length + ' 张</span></div>');
      for (const f of files) {
        out.push('<div class="ig-arch-row" title="' + U.esc(f.rel) + '">' +
          '<span class="ig-arch-tag">已归档</span>' +
          '<span class="ig-fn">' + U.esc(f.name) + '</span>' +
          '<span class="small muted">' + (f.bytes / 1024).toFixed(0) + ' KB</span></div>');
      }
    }
    return out.join('');
  }
  function archBlockHtml(r) {
    const n = r.archivedCount || 0;
    if (!n) return '';
    return '<div class="ig-arch">' +
      '<button class="btn sm ghost" id="igArchToggle">显示已归档的 ' + n + ' 张</button>' +
      '<div class="small muted ig-arch-why">这些照片已经处理过（在 <b>原卷台账</b> 里登记过），' +
      '不再是待办，所以不占上面的清单。文件<b>一张都没删</b>，仍在 <b>数据\\_收件箱</b> 下。</div>' +
      '<div id="igArchBox" hidden>' + archRowsByBatch(r.archived || []) + '</div>' +
      '</div>';
  }
  function wireArch(box, n) {
    const t = box.querySelector('#igArchToggle'); if (!t) return;
    const b = box.querySelector('#igArchBox'); if (!b) return;
    t.onclick = () => {
      b.hidden = !b.hidden;
      t.textContent = b.hidden ? ('显示已归档的 ' + n + ' 张') : '收起已归档';
    };
  }

  /* 收件箱区那两个按钮（空态与有内容态共用） */
  function wireInboxButtons(box) {
    const o = box.querySelector('#igOpenInbox');
    if (o) o.onclick = openInboxFolder;
    const rf = box.querySelector('#igRefresh');
    if (rf) rf.onclick = async () => {
      rf.disabled = true; rf.textContent = '⟳ 刷新中…';
      await loadInbox(true);
      await paintInbox();
      /* 顶栏那句「收件箱 N 张待处理」是 S.render 里取的派生值；
         刷新后数字变了得让它重算，否则又是"列表已更新、标题还停在旧数字"（2026-10-30 实机抓到过）。 */
      if (S.refreshSub) S.refreshSub();
    };
  }

  async function onGenerate() {
    const btn = U.$id('igGen'); const box = U.$id('igTaskBox');
    const picked = Object.keys(st.picked).filter(k => st.picked[k]);
    if (!picked.length) {
      box.innerHTML = '<div class="ig-warn">先在「1」里勾一张照片。没有照片也能看提示词，但任务单会缺溯源字段（校验会拒收）。</div>';
    }
    /* ★ 选卡先算清，再决定发不发：填了却发不出去的东西**不许**被丢掉，
       否则用户会拿到一张"忘了带卡"的任务单，而界面看不出任何异常（静默少卡）。
       st.packs 为空（还没读过）时先补读一次 —— 选卡区是异步读的，用户手快时会有这个空隙。
       ⚠ 两道守卫都不是装饰：本函数会被用例**单独切出来驱动**（兄弟函数不在作用域），
       没有 `loadPacks` 时也不能静默放行，而是把"清单还没读到"如实变成状态、照常上屏。 */
    if (!st.packs) {
      if (typeof loadPacks === 'function') await loadPacks(false);
      if (!st.packs) st.packs = { ok: false, packs: [], error: '经验包清单还没读到（选卡区尚未初始化）' };
    }
    const sel = collectCards(st.packs && st.packs.packs, st.typed);
    if (sel.errors.length) {
      box.innerHTML = '<div class="ig-warn">✖ 选卡有问题，这次先不生成任务单</div>' +
        '<ul class="small muted" style="margin:6px 0 0 18px">' +
        sel.errors.map(e => '<li>' + U.esc(e) + '</li>').join('') + '</ul>' +
        '<div class="small muted">改好上面的选卡区再点「生成任务单」；没有要用的卡就把卡 ID 清空。</div>';
      S.toast('选卡有问题，先按上面的原因改', 'bad', 9000);
      return;
    }
    btn.disabled = true; btn.textContent = '⏳ 生成中…';
    /* ★ 记住"这一张"到底是哪张（含内容指纹），供「定位这张图」按钮指认。
       指纹来自收件箱列表（每次读列表时已算好），不额外起进程。 */
    const shotInfo = picked.length ? (inboxFiles().find(f => f.rel === picked[0]) || null) : null;
    st.shot = (picked.length && shotInfo) ? { rel: shotInfo.rel, sha256: shotInfo.sha256, name: shotInfo.name } : null;
    let boxNote = '';   /* 成功抬头后面补的一句实话（清单读不到之类），没有就不加 */
    try {
      const flags = { recipe: st.recipe, subject: st.subject };
      if (picked.length) { flags.image = picked[0]; }
      /* ★ 2026-11-03（批次 1 收尾）：勾了照片 ⇒ 带 --task 留任务记录（壳侧布尔透传 task=1）。
         没选照片时**不留**——没有原图的任务记录无法对图，只会产一条永远对不上的空壳。 */
      if (picked.length) { flags.task = '1'; }
      /* ★ 2026-11-03（批次 2）：选卡串 = 逗号分隔（壳侧逐项展开成重复的 --card，契约 §4），
         冲突策略只在**确实带了卡**时一起送 —— 没卡时不送，保证"无 --card 时任务单逐字节不变"（契约 §3.2）。 */
      if (sel.cards.length) { flags.cards = sel.cards.join(','); flags.cardConflict = st.conflict || 'deny'; }
      if (st.packs && !st.packs.ok) {
        /* 清单读不到时**没有**任何卡被送出：生成照做（不拦着用户录题），但这句话必须挂在结果上。 */
        boxNote = '　<b>⚠ 经验包清单没读到（本次未选卡）</b>：' + U.esc(String(st.packs.error || '').slice(0, 200));
      }
      st.taskId = null;   /* 每次生成都是一次新任务；旧句柄随生成动作作废 */
      const r = await H.recipe('组装', flags);
      /* ⚠ 2026-10-27 修（用户实测：「生成不了任务单」，而界面显示"已生成（0 字符 / 1 行）"）：
         原代码只看 out、不看 ok/code —— 工具失败时 stdout 是空的，于是"空字符串"被当成
         "生成成功"。**失败必须说失败**，而且要带上工具的真实原因（stderr 里那行"原图不存在"）
         和退出码，否则用户只看到一个 0 字符的框，无从下手。 */
      const okFlag = !(r && r.ok === false) && !(r && r.code && r.code !== 0);
      st.task = okFlag ? String((r && r.out) || '') : '';
      if (!okFlag || !st.task.trim()) {
        const why = String((r && (r.err || r.out)) || '').trim() || '工具没有返回内容（退出码 ' + ((r && r.code) || '?') + '）';
        /* 选卡被工具拒 ⇒ 指路改哪个下拉，别让用户对着原文猜。实测判词两种（2026-11-03）：
           deny 冲突 `✖ 选卡冲突：步骤「X」被两张卡同时覆盖：A 与 B`；重复卡 `✖ 同一张卡被选了两次：A`。 */
        const conflictHit = /--card-conflict|同时覆盖|选卡冲突|同一张卡|选了两次/.test(why);
        box.innerHTML = '<div class="ig-warn">✖ 生成失败：任务单是空的</div>' +
          '<pre class="ig-pre ig-bad">' + U.esc(why.slice(-1200)) + '</pre>' +
          (conflictHit
            ? '<div class="small muted">这是<b>选卡</b>被拒：若两张卡覆盖了同一步骤，把上面「选卡冲突策略」改成' +
              '「先到先得」或「全部拼入」；若是同一张卡填了两次，把重复的卡 ID 去掉（重复选同一张卡三种策略都拒）。</div>'
            : '') +
          '<div class="small muted">常见原因：选中的照片已经被移走/改名（路径按库根解析）；' +
          '或该配方缺学科文件。修好后点上面「⟳ 刷新」重新读收件箱再试。</div>';
        S.toast('生成失败，看下面的原因', 'bad', 8000);
        return;
      }
      const lines = st.task.split('\n').length;
      /* 任务号在工具 stderr 的「任务记录：t-…（<库根>\_录题\…）」行里（stdout 是任务单正文）。
         旧壳没有 task 透传时会解析不到 ⇒ st.taskId 为 null，校验自然落回"仅格式校验"。 */
      const tidM = String((r && r.err) || '').match(/任务记录：(t-[0-9]{8}-[0-9]{6}-[0-9a-f]{6})/);
      st.taskId = tidM ? tidM[1] : null;
      /* 「先到先得」策略下让位的卡由工具打印一行（契约 §3.1）——页面必须把它转出来，不许吞掉：
         吞掉等于"我以为两张卡都生效了，其实只有一张"。 */
      const cardNote = String((r && r.err) || '').split('\n')
        .filter(l => /卡|覆盖|让位|冲突/.test(l) && !/任务记录/.test(l)).join('\n').trim();
      box.innerHTML =
        '<div class="ig-ok">✔ 任务单已生成（' + st.task.length + ' 字符 / ' + lines + ' 行）' +
        (st.taskId ? '　任务号 <b>' + U.esc(st.taskId) + '</b>（已留任务记录，回传校验按三层判）' : '') +
        (picked.length ? '' : '　<b>⚠ 未选照片：AI 拿不到 sourceImageSha256，回传会被拒收</b>') +
        (sel.cards.length ? '　已选卡 <b>' + sel.cards.length + '</b> 张：' + sel.cards.map(U.esc).join('、') : '') +
        boxNote + '</div>' +
        (cardNote ? '<pre class="ig-pre" id="igCardNote">经验包提示（工具原文）：\n' + U.esc(cardNote) + '</pre>' : '') +
        '<div class="row" style="margin:8px 0"><button class="btn sm primary" id="igCopy">📋 复制任务单</button>' +
        (st.shot ? '<button class="btn sm primary" id="igReveal">📂 定位这张图</button>' : '') +
        '<button class="btn sm ghost" id="igToggle">展开 / 收起预览</button>' +
        '<span class="small muted">点「📋 复制任务单」把文字发给 AI：<b>本机代理</b>（能跑命令的，如 ZCode）会按任务单「第 0 步」自己取图，<b>不用你发照片</b>；<b>网页版</b> AI 才要用「📂 定位这张图」选中后作为附件发出去。</span></div>' +
        (st.shot
          ? '<div class="small muted" style="margin-bottom:8px">要发的那一张：' + U.esc(st.shot.name) +
            '　指纹 <b>' + U.esc(String(st.shot.sha256 || '').slice(0, 12)) + '</b>' +
            '（照片后来被改名也没关系，这个按钮按指纹找，不按名字找）</div>'
          : '') +
        '<pre class="ig-pre" id="igPre" hidden>' + U.esc(st.task) + '</pre>';
      U.$id('igCopy').onclick = async () => {
        const ok = await copyText(st.task);
        S.toast(ok ? '任务单已复制，去粘给你的 AI 吧' : '复制失败：请展开预览后手动全选复制', ok ? 'ok' : 'warn', 6000);
      };
      const rv = U.$id('igReveal'); if (rv) rv.onclick = revealShot;
      U.$id('igToggle').onclick = () => { const p = U.$id('igPre'); p.hidden = !p.hidden; };
    } catch (e) {
      box.innerHTML = '<div class="ig-warn">✖ 生成失败：' + U.esc(String(e && e.message || e)) + '</div>';
    } finally {
      btn.disabled = false; btn.textContent = '生成任务单';
    }
  }

  /* ⚠ 这一段的**位置是有意的**：函数声明会提升，所以放 onGenerate 之后照样能调；
     而它落在「onGenerate … onBoundCheck」这个窗口里 —— 批次 1 的窗口用例
     （tests\neg-task-page-wiring.cjs）正是按这两个锚点整段切出来驱动的，助手放别处会被切成悬空引用。 */
  /* ---------- 选卡（2026-11-03 批次 2 · 经验包）----------
   * 卡 = 经验包里的「方法卡」，选卡串形状 `<packId>/<cardId>@<version>`（契约 §1）。
   * 清单只给**包**级信息（id/version/enabled/verdict…），不给卡表 ⇒ 卡 ID 由用户照包内说明填。
   * 三条纪律（破任何一条都会退化成"看起来没选卡"，那是本仓最忌讳的一类缺陷）：
   *   ① 清单读不到 ⇒ 选卡区写明**读不到的原因**，且不显示成"没装包"（两件事要做的动作不同）；
   *   ② 停用包 ⇒ 输入框 disabled + 行上写"为什么不能选、怎么恢复"；
   *   ③ 填了但发不出去（包停用 / 卡 ID 非法 / 版本不成形）⇒ **这次不生成**并把原因逐条上屏，
   *      绝不悄悄按"没选卡"生成任务单。
   * 清单的读取与解析只有一份实现：`views/packs.js` 的 `V.load()`（本页只消费，不另写一份）。 */

  /* 卡 ID 门禁：与壳层选卡串形状门禁同字符集（契约 §4 的
     `[A-Za-z0-9._\-]+`，且不含 `/` 与 `@`）——提前拦下，用户看到的是人话，而不是壳的 code:2。 */
  function cardIdOk(id) { return /^[A-Za-z0-9._-]+$/.test(String(id == null ? '' : id)); }
  /* 版本门禁：契约 §1 要求 `数字.数字.数字`；不成形的版本拼出来必被壳拒，先说清。 */
  function packVerOk(v) { return /^[0-9]+\.[0-9]+\.[0-9]+$/.test(String(v == null ? '' : v)); }
  /* 来源显示走「经验包」页的脱敏实现（**唯一实现**：绝对路径不许上屏，隐私红线）；
     模块没装载时如实说"取不到"，不显示成空白（空白会被读成"这个包没有来源"）。 */
  function packSrc(p) {
    const P = packsModule();
    return (P && typeof P.srcText === 'function') ? P.srcText(p) : '（来源取不到：经验包模块没装载）';
  }
  /* 取「经验包」视图模块。用 `typeof` 守卫：本页的函数会被用例**切出来单独驱动**（`new Function`，
     没有页面全局 CTB），少这层守卫就会在"还没来得及渲染"时抛 ReferenceError 把整条生成链路打断。 */
  function packsModule() {
    try { return (typeof CTB !== 'undefined' && CTB && CTB.views) ? (CTB.views.packs || null) : null; }
    catch (e) { return null; }
  }

  /* 纯函数：包清单 + 用户填的卡 ID ⇒ { cards, errors }。
     **errors 非空就不发**——宁可不生成，也不静默少卡（少一张卡 = AI 悄悄不按你的方法干活）。 */
  function collectCards(packs, typed) {
    const out = { cards: [], errors: [] };
    const list = Array.isArray(packs) ? packs : [];
    const seen = {};
    for (const p of list) {
      const id = String((p && p.id) || '');
      if (!id) continue;
      seen[id] = true;
      const raw = String((typed && typed[id]) || '');
      const ids = raw.split(/[,，]/).map(s => s.trim()).filter(Boolean);
      if (!ids.length) continue;
      const ver = (p && p.version);
      if (!p.enabled) {
        out.errors.push('包 ' + id + '@' + String(ver || '?') + ' 已停用（包目录里有 `.停用` 文件），不能选卡：' +
          '要么删掉那个文件再点「⟳ 重新读经验包」，要么把它填的卡 ID 清空。');
        continue;
      }
      if (!packVerOk(ver)) {
        out.errors.push('包 ' + id + ' 的版本「' + String(ver || '') + '」不是「数字.数字.数字」，' +
          '选卡串发不出去（契约 §1）；请核对包目录层级与 pack.json。');
        continue;
      }
      for (const cid of ids) {
        if (!cardIdOk(cid)) {
          out.errors.push('卡 ID「' + cid + '」不合法：只允许字母、数字、点、下划线、连字符（不含 `/` 与 `@`）。');
          continue;
        }
        const sel = id + '/' + cid + '@' + String(ver);
        /* 同一张卡填两次：工具侧**三种策略都拒**（实测 `✖ 同一张卡被选了两次`，exit 2）
           ⇒ 页面侧同一判据提前拦住，别让用户以为换个策略就能过。 */
        if (out.cards.indexOf(sel) >= 0) {
          out.errors.push('卡 ' + sel + ' 被填了两次：同一张卡选两次没有意义，工具会直接拒收（与冲突策略无关）。');
          continue;
        }
        out.cards.push(sel);
      }
    }
    /* 填了清单里没有的包（被卸载/改了 ID）⇒ 点名，不当"没填过"。 */
    for (const k of Object.keys(typed || {})) {
      if (!seen[k] && String((typed[k] || '')).trim()) {
        out.errors.push('选卡里引用了清单里没有的包「' + k + '」（可能已卸载或改了 ID）：' +
          '点「⟳ 重新读经验包」核对，或把它的卡 ID 清空。');
      }
    }
    return out;
  }

  /* 纯函数：选卡区 HTML。err 非空 = 清单读不到，必须把原因摆出来且**不能**摆成空态。 */
  function packsPickerHtml(packs, typed, err) {
    if (err) {
      return '<div class="ig-warn">✖ 读不到经验包清单，选卡区不可用</div>' +
        '<pre class="ig-pre ig-bad">' + U.esc(err) + '</pre>' +
        '<div class="small muted">这<b>不等于</b>「没装包」：没装包也能生成任务单（只是不含方法卡），' +
        '而读不到清单时你**选不了卡** —— 原因就是上面这一条。修好后点「⟳ 重新读经验包」。</div>';
    }
    const list = Array.isArray(packs) ? packs : [];
    if (!list.length) {
      return '<div class="small muted">没有安装任何经验包 —— 这次生成的任务单不含方法卡（不影响录题）。' +
        '装法见侧栏「📦 经验包」页。</div>';
    }
    const rows = list.map(p => {
      const id = String((p && p.id) || '');
      const on = !!(p && p.enabled);
      const ver = String((p && p.version) || '?');
      const title = String((p && p.title) || id || '(无标题)');
      const bad = (p && p.verdict && p.verdict.ok === false)
        ? '<div class="small muted">⚠ 校验不通过：' +
          U.esc((((p.verdict.errors || [])[0] || {}).why) || '见「经验包」页逐条原因') + '</div>'
        : '';
      return '<div class="ig-file" style="align-items:flex-start">' +
        '<span class="ig-fn">' +
        '<b>' + U.esc(title) + '</b> <code>' + U.esc(id) + '</code>' +
        '<div class="small muted">来源 ' + U.esc(packSrc(p)) + ' · 版本 ' + U.esc(ver) + '</div>' + bad +
        '<input type="text" data-pack="' + U.esc(id) + '" value="' + U.esc(String((typed && typed[id]) || '')) + '"' +
        (on ? '' : ' disabled') +
        ' placeholder="' + (on ? '卡 ID（多个用逗号隔开，见包内 README.md）'
          : '已停用：包目录里有 .停用 文件，删掉它再点「⟳ 重新读经验包」') + '">' +
        '</span>' +
        '<span class="tag ' + (on ? 'ok' : 'warn') + '">' + (on ? '启用' : '已停用') + '</span>' +
        '</div>';
    }).join('');
    return '<div class="small muted" style="margin-bottom:6px">' +
      '可以把经验包里的<b>方法卡</b>选进这次任务单（可多选）；卡 ID 见包内 <code>README.md</code>。没装包就留空。</div>' +
      rows;
  }

  /* 读清单 + 画选卡区。读的是「经验包」页那份缓存实现（force=true 才重新起进程）。 */
  async function loadPacks(force) {
    const P = packsModule();
    if (!P || typeof P.load !== 'function') {
      st.packs = { ok: false, packs: [], error: '经验包模块没有装载（index.html 里少了 js/views/packs.js）—— 选卡区不可用' };
      return st.packs;
    }
    try {
      st.packs = await P.load(force);
    } catch (e) {
      /* 读取实现自己已经兜过底；这里再兜一层，保证"读清单"永远不会把生成链路打断
         —— 出事就如实变成"读不到 + 原因"，由选卡区与结果抬头说出来。 */
      st.packs = { ok: false, packs: [], error: '读经验包清单失败：' + String((e && e.message) || e) };
    }
    return st.packs;
  }
  async function paintPacks() {
    const box = U.$id('igPackBox');
    if (!box) return;
    const r = await loadPacks(false);
    box.innerHTML = packsPickerHtml(r.packs, st.typed, r.ok ? null : r.error);
    /* 输入即记（st.typed），生成时不再读 DOM —— 页面逻辑与用例驱动走同一条路。 */
    box.querySelectorAll('input[data-pack]').forEach(inp => {
      inp.oninput = () => {
        const id = inp.dataset.pack;
        if (String(inp.value || '').trim()) st.typed[id] = inp.value;
        else delete st.typed[id];
      };
    });
  }
  async function reloadPacks() {
    const box = U.$id('igPackBox');
    if (box) box.innerHTML = '<span class="small muted">⟳ 正在重新读经验包…</span>';
    await loadPacks(true);
    await paintPacks();
  }

  /* ★ 2026-11-03（批次 1 收尾）：有任务句柄 ⇒ 走三层校验（`_录题任务.mjs 绑定校验`，
     唯一实现，界面与 CLI 共用同一份）。退出码：0 通过 / 1 格式不通过 / 2 任务不存在或用法 /
     3 与任务不匹配（契约见 docs\录题任务契约.md）。显示三层原文——工具已经逐层说清了，页面不转译。 */
  async function onBoundCheck(box, text, btn) {
    const r = await H.taskCheck(st.taskId, text);
    st.verdict = r;
    const code = r && r.code;
    const out = String((r && r.out) || '');
    const err = String((r && r.err) || '');
    if (code === 0) {
      const confirmed = /③ 内容已人工确认：已确认/.test(out);
      /* ★ 2026-11-03（D-4 连带，独立复核点名）：**抬头必须与工具原文同源**。
         改前写死成"✔ 绑定校验通过（① 格式 + ② 与任务及原图匹配）"，可 exit 0 并不只有那一种情形：
         返回 JSON **没带信封**时（旧格式），工具第二层只核了原图 sha、并明写"未与任务关联"，
         却照样 exit 0 ⇒ 页面把"没核对任务号"说成"② 与任务及原图匹配"，界面跟着说谎。
         判据直接读工具自己的两行原文（`仅格式校验（信封已识别）` + `② …：通过`），不另立第二套口径。 */
      const linked = /仅格式校验（信封已识别）/.test(out) && /② 与任务及原图匹配：通过/.test(out);
      /* ★ 2026-11-04：校验通过后**接上入库按钮**（第四步）。
         改前这里写死「下一步：按 docs\作答契约.md 建卡入库（本页不落库）」——
         那句话是**实话**，因为当时仓内**没有任何东西能把 JSON 变成卡**：
         实测 2026-11-04 19:36 那次录题，点完「确认本任务」什么也没发生（库里零张新卡）。
         现在 `_录题入库.mjs` 补上了这一段，这里给的是**真按钮**。
         ⚠ 只有"已确认 + 带信封"才给按钮：没确认过就入库 = 跳过人审那道门。 */
      const canLand = linked && confirmed;
      box.innerHTML = '<div class="ig-ok">' + (linked
        ? '✔ 绑定校验通过（① 格式 + ② 与任务及原图匹配）'
        : '✔ 校验通过 —— 但<b>未与任务关联</b>（这份 JSON 没带信封，程序无法核对它属于哪次任务；只核了格式与原图 sha）') + '</div>' +
        '<div class="small muted" style="margin:4px 0">任务号 <b>' + U.esc(st.taskId) + '</b>' +
        (confirmed ? '　✔ 已人工确认' : '　<b>第三层未完成</b>——人看过下面的结果之后，点「✍ 确认本任务」') + '</div>' +
        '<pre class="ig-pre">' + U.esc(out) + '</pre>' +
        (confirmed ? '' :
          '<div class="row" style="margin-top:8px"><button class="btn sm primary" id="igConfirm">✍ 确认本任务</button>' +
          '<span class="small muted">确认写进任务记录（confirmedAt）。这是**人显式做的动作**，程序不替你确认。</span></div>') +
        (canLand
          ? landBoxHtml()
          : '<div class="small muted" style="margin-top:6px">' + (confirmed
            ? '⚠ 这份 JSON 没带信封，程序无法核对它属于哪次任务 —— <b>不能入库</b>（要入库请让 AI 按任务单第五节的要求带上信封）。'
            : '下一步：先点「✍ 确认本任务」，然后才能入库。') + '</div>');
      S.toast(linked ? '绑定校验通过' : '校验通过（未与任务关联）', linked ? 'ok' : 'warn');
      const cf = U.$id('igConfirm');
      if (cf) cf.onclick = () => onConfirm(cf);
      const lb = U.$id('igLand');
      if (lb) lb.onclick = () => onLand();
    } else if (code === 3) {
      box.innerHTML = '<div class="ig-warn">✖ 与任务不匹配 —— <b>不要入库</b>（跨任务贴错 / 图不一致）</div>' +
        '<pre class="ig-pre ig-bad">' + U.esc(out || err) + '</pre>';
      S.toast('与任务不匹配，看下面点名的原因', 'bad', 8000);
    } else {
      /* 「粘进来的东西里没有 JSON」这类判词由**工具的原文**给出
         （`_录题任务.mjs 绑定校验` / `_配方.mjs 校验` 都会打印「不是合法 JSON：…」，
         连花括号都没有时还会补一行提示），页面不再自己数花括号 ——
         P1-#1 之前页面自己截取、自己猜，猜错了用户也不知道为什么。 */
      box.innerHTML = '<div class="ig-warn">✖ ' + (code === 1 ? '格式不通过' : '校验请求失败（工具退出码 ' + code + '）') + '</div>' +
        '<pre class="ig-pre ig-bad">' + U.esc(err || out) + '</pre>' +
        '<div class="small muted">逐条看上面的原因行，改完再粘一次。常见原因：错因写成中文、缺 confidence、' +
        '缺 sourceImageSha256、多写了契约外字段；外层用了 envelope 就必须同时给 result。</div>';
      S.toast(code === 1 ? '格式不通过，看逐条原因' : '校验失败，看原因', 'bad', 8000);
    }
  }

  /* 第三层确认：只能由人点。确认后重跑一次绑定校验，让三层显示如实刷新。 */
  async function onConfirm(cf) {
    cf.disabled = true; cf.textContent = '⏳ 确认中…';
    try {
      const r = await H.taskConfirm(st.taskId, '');
      if (r && r.code === 0) { S.toast('任务已确认', 'ok'); onCheck(); }
      else {
        S.toast('确认失败：' + String((r && (r.err || r.out)) || '未知原因'), 'bad', 8000);
        cf.disabled = false; cf.textContent = '✍ 确认本任务';
      }
    } catch (e) {
      S.toast('确认失败：' + String(e && e.message || e), 'bad', 8000);
      cf.disabled = false; cf.textContent = '✍ 确认本任务';
    }
  }

  /* ★ 2026-11-04：第四步「建卡入库」——把校验通过的 JSON 落成真错题卡。
     为什么加这一步（实测）：录题页以前走完「校验 + 人工确认」就**结束**了，
     页面写着「本页不落库」——因为仓内**没有任何东西能把 JSON 变成卡**。
     实测 2026-11-04 19:36 那次录题：任务记录 `cards` 是**空数组**（校验用的 JSON 只在页面
     过了一遍，从没存进记录）、库里**零张新卡**。用户点完「确认本任务」什么也没发生。
     现在这一步把链条接上：确认过 + 校验过 ⇒ 点一下 ⇒ 卡进库、门禁当场跑、盲解清稿当场备好。

     顺序纪律（不可颠倒）：
       校验（①格式 ②与任务及原图匹配）→ 人工确认（③）→ **入库**
     入库工具自己会再核一遍这三层（不信前端的结论），任一层不过就**不写盘**。 */
  function landBoxHtml() {
    const kids = M.students();
    const sel = kids.length
      ? '<label class="ig-f"><span>挂到</span><select id="igStudent" class="bk-sort">' +
        kids.map(k => '<option' + (k === M.student() ? ' selected' : '') + '>' + U.esc(k) + '</option>').join('') +
        '</select></label>'
      : '<span class="small muted">库里还没有学生 —— 先到「🏠 首页」建一个，或用「＋ 新建学生」。</span>';
    return '<div class="row" style="margin-top:8px">' + sel +
      '<button class="btn sm primary" id="igLand">📥 建卡入库</button>' +
      '<span class="small muted">卡会挂到上面选的学生名下；入库时当场跑作答契约/配图/原卷溯源三道门禁，并备好盲解清稿</span></div>';
  }

  async function onLand() {
    const box = U.$id('igResult');
    const ta = U.$id('igIn');
    const btn = U.$id('igLand');
    const text = String(ta && ta.value || '').trim();
    if (!st.taskId) { S.toast('还没有任务句柄 —— 先在上面「2」里勾照片生成任务单', 'warn', 7000); return; }
    if (!text) { S.toast('先把 AI 的 JSON 粘进上面的框', 'warn'); return; }
    const student = (U.$id('igStudent') && U.$id('igStudent').value) || '';
    if (!student) { S.toast('库里没有学生 —— 先建一个', 'warn', 7000); return; }
    btn.disabled = true; btn.textContent = '⏳ 入库中…';
    try {
      const r = await H.ingestLand(st.taskId, text, student, st.subject);
      const code = r && r.code;
      const out = String((r && r.out) || '');
      const err = String((r && r.err) || '');
      if (code === 0) {
        box.innerHTML = '<div class="ig-ok">✔ 已入库 —— 卡进库了，门禁当场跑过</div>' +
          '<pre class="ig-pre">' + U.esc(out) + '</pre>' +
          '<div class="small muted">新卡已在「题库」里。下一步：让无上下文解题者盲解一遍（清稿已备好），' +
          '否则这些卡进不了组卷池（盲解门禁是硬拦）。</div>';
        S.toast('已入库', 'ok', 8000);
        if (S.refreshSub) S.refreshSub();
      } else if (code === 3) {
        box.innerHTML = '<div class="ig-warn">✖ 与任务不匹配 —— <b>没有写盘</b></div>' +
          '<pre class="ig-pre ig-bad">' + U.esc(out || err) + '</pre>';
        S.toast('与任务不匹配，看下面点名的原因', 'bad', 9000);
      } else {
        box.innerHTML = '<div class="ig-warn">✖ 入库没成功（退出码 ' + code + '）—— <b>没有写盘</b></div>' +
          '<pre class="ig-pre ig-bad">' + U.esc(err || out) + '</pre>' +
          '<div class="small muted">逐条看上面的原因行，改完再点一次。常见原因：任务还没确认、' +
          '信封里的任务号或原图哈希对不上、学生名写错、契约字段缺项。</div>';
        S.toast('入库没成功，看逐条原因', 'bad', 9000);
      }
    } catch (e) {
      S.toast('入库失败：' + String(e && e.message || e), 'bad', 9000);
    } finally {
      btn.disabled = false; btn.textContent = '📥 建卡入库';
    }
  }

  async function onCheck() {
    const box = U.$id('igResult'); const ta = U.$id('igIn');
    const raw = String(ta.value || '').trim();
    if (!raw) { box.innerHTML = '<div class="ig-warn">先把 AI 的 JSON 粘进上面的框。</div>'; return; }
    /* ★ 2026-11-03（批次 1 收尾 · P1-#1）：这里**不再**自己截取"首个 { 到最后一个 }"。
       改前那段截取的注释自称「与工具侧同一容错口径」，而工具侧当时是**裸 JSON.parse**
       —— 注释是假的（施工方案 §2.1 点名的 P1-5 类缺陷），而且两份实现必然漂移
       （本仓 L-286）：页面放行、CLI 拒收，同一次粘贴的结论取决于从哪个入口进来。
       现在页面只做一件事：把用户粘的**原文原样**交给工具（`H.taskCheck` / `H.recipe('校验')`
       都把 text 原文落临时文件再 `--in`）。容错抽取的**唯一实现**在 `src\tools\_配方.mjs`
       的 `extractJsonText`（`_录题任务.mjs 绑定校验` 也用同一个），"没找到花括号"这类判词
       一律读工具的原文，页面不再自己猜。 */
    const text = raw;
    const btn = U.$id('igCheck'); btn.disabled = true; btn.textContent = '⏳ 校验中…';
    try {
      if (st.taskId) { await onBoundCheck(box, text, btn); return; }
      const r = await H.recipe('校验', { recipe: st.recipe, text });
      st.verdict = r;
      const code = r && r.code;
      const out = String((r && r.out) || '');
      const err = String((r && r.err) || '');
      if (code === 0) {
        box.innerHTML = '<div class="ig-ok">✔ 校验通过</div>' +
          '<div class="small muted" style="margin:4px 0"><b>仅格式校验（未与任务关联）</b>——本次没有任务上下文' +
          '（先在「2」里勾照片生成任务单），程序无法核对这份结果属于哪张图、哪次任务。</div>' +
          '<pre class="ig-pre">' + U.esc(out) + '</pre>' +
          '<div class="small muted">下一步：回上面「2」勾照片生成任务单（带任务号）→ 校验 → 确认 → 才能入库。' +
          '<b>没有任务号的一律不入库</b>（否则程序无从核对这份结果属于哪张图）。</div>';
        S.toast('校验通过', 'ok');
      } else {
        /* 同上：判词读工具原文（`_配方.mjs 校验` 会打印「✖ 不是合法 JSON：…」/「连花括号都没有」），
           页面不再自己 `indexOf('{')` 猜一次。 */
        box.innerHTML = '<div class="ig-warn">✖ 未通过（工具退出码 ' + code + '）</div>' +
          '<pre class="ig-pre ig-bad">' + U.esc(err || out) + '</pre>' +
          '<div class="small muted">逐条看上面的「- 」行，改完再粘一次。常见原因：错因写成中文、缺 confidence、' +
          '缺 sourceImageSha256、多写了契约外字段。</div>';
        S.toast('校验未通过，看下面的逐条原因', 'bad', 8000);
      }
    } catch (e) {
      box.innerHTML = '<div class="ig-warn">✖ 校验请求失败：' + U.esc(String(e && e.message || e)) + '</div>';
    } finally {
      btn.disabled = false; btn.textContent = '校验';
    }
  }

  /* 切到本页时重新读一次收件箱（用户刚丢完照片就切回来是最常见的动作）。
     经验包清单不强制重读（它是缓存，装了新包点选卡区的「⟳ 重新读经验包」）—— 免得每次切页起两次进程。 */
  V.onShow = function () {
    loadInbox(true).then(paintInbox).then(() => { if (S.refreshSub) S.refreshSub(); });
    paintPacks();
  };})();
