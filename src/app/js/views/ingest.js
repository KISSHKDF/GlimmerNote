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
 * 三条界面纪律：
 *   · 本页**不写用户库**（引擎只读配方、只读收件箱；校验不入库）；
 *   · 不显示本机绝对路径（隐私红线：截图和报障都会带出去）；
 *   · 校验不通过时**逐条说清哪里错**，不弹一句"失败了"。
 */
(function () {
  const U = CTB.util, H = CTB.host, S = CTB.shell;
  const V = CTB.views.ingest = {};

  const LS_KEY = 'ctb2.ingest';
  const st = Object.assign({
    recipe: 'ingest-page',   /* 默认整页：一次作业往往错好几道，整页比单题省事 */
    subject: '数学',
    batch: '',
    picked: {},              /* rel → true，收件箱里勾了哪些图 */
    task: '',                /* 生成好的任务单全文 */
    verdict: null,           /* 校验结果 */
    inbox: null,
  }, U.lsGet(LS_KEY, {}));
  const save = () => U.lsSet(LS_KEY, { recipe: st.recipe, subject: st.subject });
  /* 这两个不持久化：每次进来重新取，避免"昨天选中的图今天还在"的错觉 */
  st.task = ''; st.verdict = null; st.inbox = null; st.picked = {}; st.batch = '';

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
  async function loadInbox(force) {
    if (st.inbox && !force) return st.inbox;
    try {
      const r = await H.recipe('收件箱', { json: '1' });
      const t = String((r && r.out) || '').replace(/^\uFEFF/, '').trim();
      st.inbox = t ? JSON.parse(t) : { batches: [], total: 0 };
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
      '<div id="igTaskBox"></div>' +
      '</div>' +
      '<div class="card ig-step">' +
      '<div class="ig-h"><span class="ig-n">3</span>把 AI 的答案粘回来校验</div>' +
      '<div class="small muted">把 AI 输出的那一整段 JSON 原样粘进来（多带了说明文字也没关系，只要里面有 JSON）。' +
      '<b>校验只检查格式与字段，不会写进题库</b>。</div>' +
      '<textarea id="igIn" class="ig-ta" placeholder="粘贴 cards.json 内容，例如 {&quot;cards&quot;:[…]}"></textarea>' +
      '<div class="row" style="margin-top:8px"><button class="btn sm primary" id="igCheck">校验</button>' +
      '<span class="small muted">校验通过后再走原有的建卡流程入库（本页不落库）</span></div>' +
      '<div id="igResult"></div>' +
      '</div>';

    const rSel = U.$id('igRecipe'), sSel = U.$id('igSubject');
    rSel.value = st.recipe; sSel.value = st.subject;
    rSel.onchange = () => { st.recipe = rSel.value; save(); };
    sSel.onchange = () => { st.subject = sSel.value; save(); };
    U.$id('igGen').onclick = onGenerate;
    U.$id('igCheck').onclick = onCheck;

    paintInbox();
  };

  async function paintInbox() {
    const box = U.$id('igInboxBox');
    if (!box) return;
    const r = await loadInbox(false);
    if (r.error) {
      box.innerHTML = '<span class="tag bad">读不到收件箱</span> ' + U.esc(r.error) +
        '<br><span class="small muted">若是浏览器模式打开，本页不能用（需要桌面壳：拾光小册.exe）。</span>';
      return;
    }
    if (!r.total) {
      box.innerHTML = '收件箱还是空的。<br>' +
        '<span class="small muted">把错题照片按批次放进这个文件夹，再点右上角「重读数据」或切走再切回来：<br>' +
        '<b>数据\\_收件箱\\&lt;批次名&gt;\\</b>（不建子文件夹也能用，直接丢在 _收件箱 下即可）</span>';
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
    box.innerHTML = '<div class="small muted" style="margin-bottom:6px">共 ' + r.batches.length + ' 批 / ' +
      r.total + ' 张。勾选要处理的那一张（一次一张，判错准确率最高）。</div>' + rows.join('');
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

  async function onGenerate() {
    const btn = U.$id('igGen'); const box = U.$id('igTaskBox');
    const picked = Object.keys(st.picked).filter(k => st.picked[k]);
    if (!picked.length) {
      box.innerHTML = '<div class="ig-warn">先在「1」里勾一张照片。没有照片也能看提示词，但任务单会缺溯源字段（校验会拒收）。</div>';
    }
    btn.disabled = true; btn.textContent = '⏳ 生成中…';
    try {
      const flags = { recipe: st.recipe, subject: st.subject };
      if (picked.length) flags.image = picked[0];
      const r = await H.recipe('组装', flags);
      st.task = String((r && r.out) || '');
      const lines = st.task.split('\n').length;
      box.innerHTML =
        '<div class="ig-ok">✔ 任务单已生成（' + st.task.length + ' 字符 / ' + lines + ' 行）' +
        (picked.length ? '' : '　<b>⚠ 未选照片：AI 拿不到 sourceImageSha256，回传会被拒收</b>') + '</div>' +
        '<div class="row" style="margin:8px 0"><button class="btn sm primary" id="igCopy">📋 复制任务单</button>' +
        '<button class="btn sm ghost" id="igToggle">展开 / 收起预览</button>' +
        '<span class="small muted">复制后整段粘给你的 AI（连同那张照片一起发）</span></div>' +
        '<pre class="ig-pre" id="igPre" hidden>' + U.esc(st.task) + '</pre>';
      U.$id('igCopy').onclick = async () => {
        const ok = await copyText(st.task);
        S.toast(ok ? '任务单已复制，去粘给你的 AI 吧' : '复制失败：请展开预览后手动全选复制', ok ? 'ok' : 'warn', 6000);
      };
      U.$id('igToggle').onclick = () => { const p = U.$id('igPre'); p.hidden = !p.hidden; };
    } catch (e) {
      box.innerHTML = '<div class="ig-warn">✖ 生成失败：' + U.esc(String(e && e.message || e)) + '</div>';
    } finally {
      btn.disabled = false; btn.textContent = '生成任务单';
    }
  }

  async function onCheck() {
    const box = U.$id('igResult'); const ta = U.$id('igIn');
    const raw = String(ta.value || '').trim();
    if (!raw) { box.innerHTML = '<div class="ig-warn">先把 AI 的 JSON 粘进上面的框。</div>'; return; }
    /* AI 常在 JSON 外裹一段解释：截取首个 { 到最后一个 } —— 与工具侧同一容错口径 */
    const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
    const text = (a >= 0 && b > a) ? raw.slice(a, b + 1) : raw;
    const btn = U.$id('igCheck'); btn.disabled = true; btn.textContent = '⏳ 校验中…';
    try {
      const r = await H.recipe('校验', { recipe: st.recipe, text });
      st.verdict = r;
      const code = r && r.code;
      const out = String((r && r.out) || '');
      const err = String((r && r.err) || '');
      if (code === 0) {
        box.innerHTML = '<div class="ig-ok">✔ 校验通过</div><pre class="ig-pre">' + U.esc(out) + '</pre>' +
          '<div class="small muted">下一步：按 `docs\\作答契约.md` 建卡入库（本页不写库）。</div>';
        S.toast('校验通过', 'ok');
      } else {
        box.innerHTML = '<div class="ig-warn">✖ 未通过（工具退出码 ' + code + '）' +
          (a < 0 ? '<br>提示：粘进来的内容里没找到 JSON 花括号' : '') + '</div>' +
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

  /* 切到本页时重新读一次收件箱（用户刚丢完照片就切回来是最常见的动作） */
  V.onShow = function () { loadInbox(true).then(paintInbox); };
})();
