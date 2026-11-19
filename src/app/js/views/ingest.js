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
    /* ★ 2026-11-19（用户报障：干净机器上"没有红笔所以没录入错题"）：
       默认从红笔口径 `ingest-page` 改为 `ingest-independent`（整页独立判卷）。
       判据是**覆盖面**，不是口味：
         · 独立判卷口径对"已批改"和"没批改"两种卷子都成立（红笔只原样记进 teacherAnswer 作参考，
           不参与判错）；
         · 红笔口径对"没批改"的卷子**必然 0 卡**——那是口径不适用，不是本页全对。
       用户 2026-11-17 在干净机器上用默认配方跑一份未批改的期中卷 6 页，整条 AGENT 流水线
       零产出；225 条真实任务记录里 `ingest-independent` 被选中 **0 次**（默认值是谁选就是谁）。
       ⇒ 默认必须是那个"不会因为卷面没红笔就空转"的口径。已有用户 localStorage 里存着
       `ingest-page` 的，按原值走（不静默改用户的选择）。 */
    recipe: 'ingest-independent',
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
  /* ★ 2026-11-16（批次 B）：本次成功生成的任务清单（[{taskId, rel}]）与工作单派发态。
     与 st.taskId 同一生命周期：只活在内存里；重新生成就换一批（同图同配方也是**两个**任务）。 */
  st.batchTasks = [];
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
      '<div class="ig-h"><span class="ig-n">2</span>生成任务单，交给你的本机 AGENT</div>' +
      '<div class="row ig-opts">' +
      '<label class="ig-f"><span>孩子</span><select id="igStudent" class="bk-sort"></select></label>' +
      /* ★ 2026-11-19（用户报障：干净机器上说"没有红笔"所以一张错题都没录）：
         旧文案把两个整页配方写成「整页多题（一次作业错好几道就用这个）」vs
         「整页独立判卷（不靠红笔，AI 独立判错）」——**决定性的那件事（卷子有没有批改过）
         一个字都没提**。家长看到"一次作业错好几道就用这个"，自然会选它，
         而它的收录判据是"确认做错**且有红笔标出**"，未批改的卷子必然 0 卡。
         现在按用户要做的判断来写：**先问卷子批改过没有**，再给结论，并把默认口径
         （独立判卷）的选项排在第一位。 */
      '<label class="ig-f"><span>卷子批改过吗</span>' +
      '<select id="igRecipe" class="bk-sort">' +
      '<option value="ingest-independent">还没批改 / 没有红笔 —— AI 自己判对错（默认）</option>' +
      '<option value="ingest-page">已经批改过、卷面有红笔 —— 按红笔标出的错题收</option>' +
      '<option value="ingest-single">只拍了一道题</option>' +
      '</select></label>' +
      '<label class="ig-f"><span>学科</span><select id="igSubject" class="bk-sort">' +
      SUBJECTS.map(s => '<option value="' + U.esc(s) + '">' + U.esc(s) + '</option>').join('') +
      '</select></label>' +
      '<span class="tb-sp"></span>' +
      '<button class="btn sm primary" id="igGen">📦 生成 AGENT 任务包</button>' +
      '</div>' +
      '<div class="small muted">勾<b>一张或多张</b>照片 → 选孩子和学科 → 点「生成 AGENT 任务包」：程序逐张生成任务' +
      '并落一份批次工作单，把派发指令发给你的本机 AGENT（能读文件、跑命令、看图的，如 Claude Code / Codex / ZCode）即可，' +
      '剩下全部由它完成。</div>' +
      /* ★ 2026-11-17（用户裁定「下面应该全自动化」）：选卡区收进 <details>。
         「选卡」是给高级用户的（方法卡随任务单一起交给 AI），绝大多数录题一次都用不到；
         它以前常驻在生成路径上，视觉上等于逼用户先做一道选择。默认折叠，功能一个不删。 */
      '<details class="ig-arch" style="margin-top:10px">' +
      '<summary class="small muted" style="cursor:pointer">⚙ 高级：经验包方法卡（大多数录题用不到，默认不选）</summary>' +
      '<div class="row ig-opts" style="margin-top:8px">' +
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
      '</details>' +
      '<div id="igTaskBox"></div>' +
      '</div>' +
      /* ★ 2026-11-17：第 3 步整段收进 <details>（默认折叠）。
         用户原话：「不应该再去做什么选择，更不应该还要用户再把 AI 的答案粘回来校验这些复杂操作」。
         粘回来校验保留为**兜底通道**（AI 不在本机、或 AGENT 跑到一半断了要人工接手时用），
         但它不再是主路径上的一步 —— 主路径是「生成任务包 → 派发指令 → AGENT 全自动跑完」。 */
      '<details class="card ig-step">' +
      '<summary class="ig-h" style="cursor:pointer"><span class="ig-n">3</span>兜底：把 AI 的答案粘回来手工校验（AGENT 全自动时用不到）</summary>' +
      '<div class="small muted">只有<b>不跑本机 AGENT</b>（比如 AI 在别的机器上、或 AGENT 断了要人工接手）才走这里。' +
      '把 AI 输出的那一整段<b>原样</b>粘进来（外面裹了解释文字也没关系，程序会自己剥掉；' +
      '一份 JSON 里用了 <code>envelope</code> 就必须同时有 <code>result</code>，缺哪样会直接点名）。' +
      '<b>生成任务单后走三层校验（格式 → 与任务及原图匹配 → 人工确认）</b>；' +
      '没生成任务单时只校验格式，会明确标"未与任务关联"。</div>' +
      '<textarea id="igIn" class="ig-ta" placeholder="粘贴 cards.json 内容，例如 {&quot;envelope&quot;:{…},&quot;result&quot;:{&quot;cards&quot;:[…]}}"></textarea>' +
      '<div class="row" style="margin-top:8px"><button class="btn sm primary" id="igCheck">校验</button>' +
      '<span class="small muted">★ 2026-11-04：校验通过并<b>人工确认</b>后，下面会出现「📥 建卡入库」按钮 —— ' +
      '点它，卡当场进库（门禁当场跑，盲解清稿当场备好）。</span></div>' +
      '<div id="igResult"></div>' +
      '</details>';

    const rSel = U.$id('igRecipe'), sSel = U.$id('igSubject'), kidSel = U.$id('igStudent');
    rSel.value = st.recipe; sSel.value = st.subject;
    rSel.onchange = () => { st.recipe = rSel.value; save(); };
    sSel.onchange = () => { st.subject = sSel.value; save(); };
    /* ★ 2026-11-16（批次 B）：孩子下拉前置到生成区（A-3 的 --student 由此发出）。
       学生清单来自状态包 M.students()（与第 4 步入库下拉同一份来源）；库空时禁用并给指路。 */
    function paintStudents() {
      const kids = (typeof M !== 'undefined' && M.students) ? M.students() : [];
      kidSel.innerHTML = kids.length
        ? kids.map(k => '<option value="' + U.esc(k) + '">' + U.esc(k) + '</option>').join('')
        : '<option value="">（库里还没有孩子）</option>';
      kidSel.disabled = !kids.length;
    }
    paintStudents();
    kidSel.onchange = () => { st.student = kidSel.value || ''; };
    /* 冲突策略三态（值必须与契约 §3.1 逐字一致：deny|first|all） */
    const cSel = U.$id('igConflict');
    if (cSel) { cSel.value = st.conflict; cSel.onchange = () => { st.conflict = cSel.value; save(); }; }
    const pr = U.$id('igPacksReload');
    if (pr) pr.onclick = reloadPacks;
    /* ★ 2026-11-17（用户裁定「放照片→选孩子→最多选学科，下面全自动化」）：
       主按钮一次走完 生成任务 → 落工作单 → 出派发指令（onGenerate(true) 的 autoPacket 分支）。
       改前是两个按钮、两步点，且两个按钮都因勾选写成单选而走不通。 */
    U.$id('igGen').onclick = () => onGenerate(true);
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
      '。勾选要处理的那一张或多张 —— <b>每张照片 = 一条任务</b>，一批勾完一次生成即可。' +
      '<div class="small muted" id="igPickHint" style="margin-top:4px"></div></div>' +
      (archNote ? '<div class="small muted ig-archnote">⚠ ' + U.esc(archNote) + '</div>' : '') +
      skipHtml +
      rows.join('') + archBlockHtml(r);
    wireInboxButtons(box);
    wireArch(box, archN);
    /* ★ 2026-11-17 修（多选接通 · 用户原话「只要放进照片、选哪个孩子、最多选学科，
       下面就应该全自动化」）：改前这里第一行是 `if (cb.checked) { st.picked = {}; }`
       —— 每勾一张就把之前勾的全清空（注释写着"单选语义"）。于是 `picked.length` 恒 ≤ 1，
       `onGenerate` 永远走 `renderSingle`，`renderMulti` 里的「📦 生成 AGENT 任务包」
       **永远不可能出现**；批次 B 交付的多图一键任务包实际上是一段死代码。
       实测：勾 3 张后 picked = ['c.jpg'] ⇒ 只剩最后一张。
       现在：每张独立开关（真正的多选），并实时更新"已勾 N 张"的计数提示。
       一个任务绑一张图（任务记录 image 单值是冻结契约），所以 N 张 = N 条任务，不是一张图装 N 题。 */
    const paintPickCount = () => {
      const n = Object.keys(st.picked).filter(k => st.picked[k]).length;
      const hint = box.querySelector('#igPickHint');
      if (!hint) return;
      if (!n) { hint.textContent = '还没勾照片（勾一张或多张）'; return; }
      hint.innerHTML = '已勾 <b>' + n + '</b> 张 → 点「📦 生成 AGENT 任务包」逐张出任务';
    };
    paintPickCount();
    box.querySelectorAll('input[data-rel]').forEach(cb => {
      cb.onchange = () => {
        if (cb.checked) st.picked[cb.dataset.rel] = true;
        else delete st.picked[cb.dataset.rel];
        /* 只动自己那一行的高亮：全清再全画会让"别的行的勾"看起来闪一下 */
        const lab = cb.closest('label');
        if (lab) lab.classList.toggle('on', !!cb.checked);
        paintPickCount();
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

  /* ★ 2026-11-17（一键任务包）：`autoPacket=true` 时，生成完任务**立刻**接着落工作单，
     并把派发指令摆到用户面前 —— 用户的动作到这里就结束了（勾照片 → 选孩子 → 选学科 → 点一下）。
     改前这是两个按钮（先生成任务单、再点生成任务包），多一步纯属程序没接完。 */
  async function onGenerate(autoPacket) {
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
       指纹来自收件箱列表（每次读列表时已算好），不额外起进程。
       ★ 2026-11-16（批次 B）：多图勾选 ⇒ **逐张生成 N 条任务**（任务记录 image 单值是冻结契约，
       一个任务绑一张图）；st.batchTasks 收集本次全部 taskId，供「生成 AGENT 任务包」引用。
       单图路径的产物与改前逐字节一致（flags 构造共用同一段代码）。 */
    const shotInfo = picked.length ? (inboxFiles().find(f => f.rel === picked[0]) || null) : null;
    st.shot = (picked.length && shotInfo) ? { rel: shotInfo.rel, sha256: shotInfo.sha256, name: shotInfo.name } : null;
    st.batchTasks = [];
    let boxNote = '';   /* 成功抬头后面补的一句实话（清单读不到之类），没有就不加 */
    try {
      const oneTicket = async (rel) => {
        const flags = { recipe: st.recipe, subject: st.subject };
        if (rel) { flags.image = rel; }
        /* ★ 2026-11-03（批次 1 收尾）：勾了照片 ⇒ 带 --task 留任务记录（壳侧布尔透传 task=1）。
           没选照片时**不留**——没有原图的任务记录无法对图，只会产一条永远对不上的空壳。 */
        if (rel) { flags.task = '1'; }
        /* ★ 2026-11-16（批次 B / A-3）：学生随单透传（壳侧 STUDENT_SHAPE 门禁后进 --student）。 */
        const kid = (U.$id('igStudent') && U.$id('igStudent').value) || '';
        if (rel && kid) { flags.student = kid; }
        /* ★ 2026-11-03（批次 2）：选卡串 = 逗号分隔（壳侧逐项展开成重复的 --card，契约 §4），
           冲突策略只在**确实带了卡**时一起送 —— 没卡时不送，保证"无 --card 时任务单逐字节不变"（契约 §3.2）。 */
        if (sel.cards.length) { flags.cards = sel.cards.join(','); flags.cardConflict = st.conflict || 'deny'; }
        const rr = await H.recipe('组装', flags);
        const ok = !(rr && rr.ok === false) && !(rr && rr.code && rr.code !== 0);
        const text = ok ? String((rr && rr.out) || '') : '';
        const tidM = ok ? String((rr && rr.err) || '').match(/任务记录：(t-[0-9]{8}-[0-9]{6}-[0-9a-f]{6})/) : null;
        return { ok, text, err: String((rr && (rr.err || rr.out)) || '').trim(), taskId: tidM ? tidM[1] : null };
      };
      if (picked.length <= 1) {
        const one = await oneTicket(picked[0] || null);
        /* ★ 2026-11-17 修（多选接通配套）：单图**也要**登记进 st.batchTasks。
           改前只有多图分支 push，而多图分支因勾选被写成单选**永远进不去** ⇒
           单张照片永远产不出任务包（renderSingle 里没入口、renderMulti 里进不去 = 死循环）。
           现在单图产单条任务包，「生成 AGENT 任务包」是一条真实可走的主路径。 */
        if (one.ok && one.taskId && picked[0]) st.batchTasks.push({ taskId: one.taskId, rel: picked[0] });
        await renderSingle(one);
      } else {
        /* 多图：逐张生成；一张失败不拖整批（失败的记进失败清单，成功的照常进任务包）。 */
        const results = [];
        for (const rel of picked) {
          btn.textContent = '⏳ 生成中 ' + (results.length + 1) + '/' + picked.length + '…';
          const one = await oneTicket(rel);
          results.push({ rel, ...one });
          if (one.ok && one.taskId) st.batchTasks.push({ taskId: one.taskId, rel });
        }
        await renderMulti(results);
      }
    } catch (e) {
      box.innerHTML = '<div class="ig-warn">✖ 生成失败：' + U.esc(String(e && e.message || e)) + '</div>';
    } finally {
      btn.disabled = false; btn.textContent = '📦 生成 AGENT 任务包';
    }
    /* 先把任务单摆出来（用户要看得见"生成了什么"），再自动接任务包 ——
       顺序不能反：任务包要引用的 taskId 必须先落盘。 */
    if (autoPacket && st.batchTasks && st.batchTasks.length) {
      try { await makeWorkPacket(); } catch (e) {
        S.toast('任务包生成失败：' + String(e && e.message || e), 'bad', 8000);
      }
    }
  }

  /* ---------- 单图渲染（原 onGenerate 成功路径整体搬移，行为逐字节不变）---------- */
  async function renderSingle(one) {
    const box = U.$id('igTaskBox');
    const picked = Object.keys(st.picked).filter(k => st.picked[k]);
    if (!one.ok || !one.text.trim()) {
      st.task = '';
      const why = one.err || '工具没有返回内容（退出码 ?）';
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
    const sel = collectCards(st.packs && st.packs.packs, st.typed);
    if (st.packs && !st.packs.ok) {
      /* 清单读不到时**没有**任何卡被送出：生成照做（不拦着用户录题），但这句话必须挂在结果上。 */
      var boxNote = '　<b>⚠ 经验包清单没读到（本次未选卡）</b>：' + U.esc(String(st.packs.error || '').slice(0, 200));
    } else { var boxNote = ''; }
    st.task = one.text;
    st.taskId = one.taskId;
    const lines = st.task.split('\n').length;
    const cardNote = String(one.err || '').split('\n')
      .filter(l => /卡|覆盖|让位|冲突/.test(l) && !/任务记录/.test(l)).join('\n').trim();
    box.innerHTML =
      '<div class="ig-ok">✔ 任务单已生成（' + st.task.length + ' 字符 / ' + lines + ' 行）' +
      (st.taskId ? '　任务号 <b>' + U.esc(st.taskId) + '</b>（已留任务记录，回传校验按三层判）' : '') +
      (picked.length ? '' : '　<b>⚠ 未选照片：AI 拿不到 sourceImageSha256，回传会被拒收</b>') +
      (sel.cards.length ? '　已选卡 <b>' + sel.cards.length + '</b> 张：' + sel.cards.map(U.esc).join('、') : '') +
      boxNote + '</div>' +
      (cardNote ? '<pre class="ig-pre" id="igCardNote">经验包提示（工具原文）：\n' + U.esc(cardNote) + '</pre>' : '') +
      '<div class="row" style="margin:8px 0"><button class="btn sm primary" id="igMakePacket">📦 生成 AGENT 任务包</button>' +
      '<button class="btn sm" id="igCopy">📋 复制任务单</button>' +
      (st.shot ? '<button class="btn sm" id="igReveal">📂 定位这张图</button>' : '') +
      '<button class="btn sm ghost" id="igToggle">展开 / 收起预览</button>' +
      '<span class="small muted">「生成 AGENT 任务包」= 把这批落成工作单并给出派发指令（推荐）；' +
      '只想手工粘任务单给 AI 才用「复制任务单」。</span></div>' +
      (st.shot
        ? '<div class="small muted" style="margin-bottom:8px">要发的那一张：' + U.esc(st.shot.name) +
          '　指纹 <b>' + U.esc(String(st.shot.sha256 || '').slice(0, 12)) + '</b>' +
          '（照片后来被改名也没关系，这个按钮按指纹找，不按名字找）</div>'
        : '') +
      /* ★ 2026-11-17：单图的落点。多图渲染里有它、单图没有 ⇒ makeWorkPacket 找不到容器就
         静默失败（点「生成 AGENT 任务包」什么也不发生）。 */
      '<div id="igPacketBox"></div>' +
      '<pre class="ig-pre" id="igPre" hidden>' + U.esc(st.task) + '</pre>';
    U.$id('igCopy').onclick = async () => {
      const ok = await copyText(st.task);
      S.toast(ok ? '任务单已复制，去粘给你的 AI 吧' : '复制失败：请展开预览后手动全选复制', ok ? 'ok' : 'warn', 6000);
    };
    /* ★ 2026-11-17：单图也要能一键出任务包（改前这条入口不存在 ⇒ 单张照片永远走不到 AGENT） */
    const mkOne = U.$id('igMakePacket');
    if (mkOne) mkOne.onclick = makeWorkPacket;
    const rv = U.$id('igReveal'); if (rv) rv.onclick = revealShot;
    U.$id('igToggle').onclick = () => { const p = U.$id('igPre'); p.hidden = !p.hidden; };
  }

  /* ---------- 多图渲染（批次 B）：N 条任务清单 + 一键任务包 ---------- */
  async function renderMulti(results) {
    const box = U.$id('igTaskBox');
    const okN = results.filter(r => r.ok && r.taskId).length;
    const failN = results.length - okN;
    st.task = (results.find(r => r.ok && r.text) || {}).text || '';
    st.taskId = (results.find(r => r.ok && r.taskId) || {}).taskId || null;
    const rows = results.map((r, i) => {
      const info = inboxFiles().find(f => f.rel === r.rel) || {};
      return '<tr><td>' + (i + 1) + '</td><td class="small">' + U.esc(info.name || r.rel) + '</td><td>' +
        (r.ok && r.taskId ? '<b class="small">' + U.esc(r.taskId) + '</b>' : '<span class="small">✖ ' + U.esc((r.err || '失败').slice(-120)) + '</span>') +
        '</td></tr>';
    }).join('');
    box.innerHTML =
      '<div class="ig-ok">✔ 已生成 <b>' + okN + '</b>/' + results.length + ' 条任务' +
      (failN ? '（<b>' + failN + '</b> 条失败——失败的不进任务包，其余照常）' : '（全部成功）') + '</div>' +
      '<table class="small" style="width:100%;border-collapse:collapse"><tbody>' + rows + '</tbody></table>' +
      (okN && st.studentOk !== false
        ? '<div class="row" style="margin:8px 0"><button class="btn sm primary" id="igMakePacket">📦 生成 AGENT 任务包（' + okN + ' 条）</button>' +
          '<span class="small muted">把整批写成一份工作单，派发指令发给你的本机 AGENT，剩下不用你管。</span></div>' +
          '<div id="igPacketBox"></div>'
        : '') +
      (failN ? '<div class="small muted">失败原因都在上面表里；修好（通常是照片被移走/改名）后重新勾选再生成。</div>' : '');
    const mk = U.$id('igMakePacket');
    if (mk) mk.onclick = makeWorkPacket;
  }

  /* ---------- 一键任务包（批次 B / B-3）：worksheetWrite op → 批次工作单 + 派发指令 ---------- */
  async function makeWorkPacket() {
    const box = U.$id('igPacketBox');
    if (!box) { S.toast('页面上找不到任务包容器（#igPacketBox）—— 请刷新页面', 'bad', 8000); return; }
    const ids = (st.batchTasks || []).map(t => t.taskId);
    if (!ids.length) { S.toast('还没有成功的任务——先生成任务单', 'warn', 7000); return; }
    const kid = (U.$id('igStudent') && U.$id('igStudent').value) || '';
    if (!kid) { S.toast('库里没有孩子——先到「🏠 首页」建一个', 'warn', 7000); return; }
    box.innerHTML = '<div class="small muted">⏳ 正在落工作单…</div>';
    try {
      const r = await H.worksheetWrite(ids.join(','), kid, st.subject);
      const ok = !(r && r.ok === false) && !(r && r.code && r.code !== 0);
      const out = String((r && r.out) || '');
      const pathM = ok ? (out.match(/已写工作单：(.+?)（/) || (function () { try { return [null, (JSON.parse(out) || {}).worksheet]; } catch { return [null, null]; } })()) : null;
      const wsPath = ok ? (pathM && pathM[1] ? pathM[1].trim() : '') : '';
      if (!ok || !wsPath) {
        box.innerHTML = '<div class="ig-warn">✖ 工作单落盘失败</div><pre class="ig-pre ig-bad">' +
          U.esc(String((r && (r.err || r.out)) || '').slice(-600)) + '</pre>';
        S.toast('任务包生成失败，看原因', 'bad', 8000);
        return;
      }
      const dispatch = '请读取并执行 ' + wsPath;
      box.innerHTML = '<div class="ig-ok">✔ AGENT 任务包已生成（' + ids.length + ' 条任务）</div>' +
        '<div class="row" style="margin:8px 0"><button class="btn sm primary" id="igCopyDispatch">📋 复制派发指令</button>' +
        '<span class="small muted">把指令发给你本机的 AGENT（Claude Code / Codex / ZCode 等），它会按工作单跑完全部录题与盲解。</span></div>' +
        '<pre class="ig-pre">' + U.esc(dispatch) + '</pre>' +
        '<div class="small muted">工作单：' + U.esc(wsPath) + '</div>';
      U.$id('igCopyDispatch').onclick = async () => {
        const okc = await copyText(dispatch);
        S.toast(okc ? '派发指令已复制，发给你的 AGENT 吧' : '复制失败，请手动选中上面的指令', okc ? 'ok' : 'warn', 6000);
      };
      S.toast('任务包已生成，复制派发指令发给你 AGENT', 'ok', 6000);
    } catch (e) {
      box.innerHTML = '<div class="ig-warn">✖ 任务包失败：' + U.esc(String(e && e.message || e)) + '</div>';
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
        /* ★ 2026-11-18：0 卡与 N 卡**分开说**。0 卡是"本页无错题"的合法闭环，
           不是"已入库 N 张"；两者都渲染成"卡进库了"会让用户误以为录了题。
           红笔口径判出 0 卡时，最可能是卷面本无红笔批改（口径没选对），必须把换配方说出口。 */
        const zeroCard = /整页无错题（0 卡）|已登记：整页无错题/.test(out);
        if (zeroCard) {
          box.innerHTML = '<div class="ig-ok">✔ 已登记：本页无错题（0 卡）—— 闭环完成</div>' +
            '<pre class="ig-pre">' + U.esc(out) + '</pre>' +
            (st.recipe === 'ingest-page'
              ? '<div class="small muted">⚠ 本页按「红笔口径」判为无错题。若这张卷子本来就没有红笔批改，' +
                '请回上面「2」把配方换成「整页独立判卷」重新生成任务单——它不要求红笔，AI 独立判错、判错即收。</div>'
              : '<div class="small muted">本页按独立判卷口径判为全对，无错题可收；收件箱按任务记录判「已处理」。</div>');
          S.toast('已登记：本页无错题（0 卡）', 'warn', 8000);
          if (S.refreshSub) S.refreshSub();
        } else {
          box.innerHTML = '<div class="ig-ok">✔ 已入库 —— 卡进库了，门禁当场跑过</div>' +
            '<pre class="ig-pre">' + U.esc(out) + '</pre>' +
            '<div class="small muted">卡已进库。<b>界面要重建一次状态包才会显示新卡</b>（约几分钟，或点右上 ⟳ 立即刷新）。' +
            '下一步：让无上下文解题者盲解一遍（清稿已备好），否则这些卡进不了组卷池（盲解门禁是硬拦）。</div>';
          S.toast('已入库（界面正在重建，稍后可见新卡）', 'ok', 8000);
          if (S.refreshSub) S.refreshSub();
          /* ★ 2026-11-12 修（P0 体验缺陷）：入库成功后**必须重建状态包**。
             状态包 `_状态.json` 是界面唯一数据源；壳侧 `ingestLand` 只跑 `_录题入库.mjs`、不跑生成器，
             而同族的 `createStudent`（`CTBShellV2.cs:460-494`）明确会跑 `生成状态.mjs`。
             修前：上面那句断言"新卡已在题库里"，但题库读的是旧状态包 ⇒ 用户切过去找不到卡，
             以为没录进去、可能重录造成重复卡（与 2026-11-04 已修的"录题第 3 步后什么也没发生"同族）。
             这里用与复习流/组卷同款的后台重建（非阻塞；重建期间界面可继续用）。 */
          if (S.regenBackground) S.regenBackground();
        }
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
