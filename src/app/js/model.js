/* 错题本 2.0 · 数据模型（唯一数据源 = 壳/服务端送来的 _状态.json；本层只做派生与过滤，绝不写盘） */
(function () {
  const M = CTB.model = {};
  const U = CTB.util;
  const H = CTB.host;        /* origOf 要把索引里的 URL 编码路径还原成壳能用的相对路径 */

  /* ---------- 常量字典（与工具侧语义对齐，不自造含义） ---------- */
  /* ⚠ 2026-10-11（F-RB-1，高）：M.LADDER 是**工具侧的历史/文案表**
     （`_标记复习.mjs:39 LADDER`；该文件 `intervalOf` 的注释明确写着「LADDER 常量保留给文案/历史引用，
     判定统一走本函数」）。旧 review.js 的 previewIv 却拿它当判据算「答对后下一次几天」⇒
     答对只给 1 天，比「半对」的 3 天还短（方向反了），与工具真正写进 nextDue 的值差 6 天。
     **凡算建议日一律走下面的 M.intervalOf（与工具 intervalOf 同口径），禁止再用 M.LADDER。** */
  M.LADDER = [1, 3, 7, 15, 30, 60, 90];
  M.INTERVAL_LADDER_OK = [7, 15, 30, 60, 90];
  /* 间隔 —— **与工具同口径的唯一实现**，照抄 `_标记复习.mjs:181 intervalOf`。
     工具在 actGrading:229 先落 reviews、:232 再算 passStreak ⇒ 传入的 pass **已含本次**。
     改这里必须同步 `tests/neg-v2-ui-review-bank.cjs` 的交叉校验（该脚本直接从 `_标记复习.mjs`
     解出 LADDER_OK 与本表比对，漂移即红）。 */
  M.intervalOf = function (res, pass) {
    if (res === '错') return 1;
    if (res === '半对') return 3;
    const L = M.INTERVAL_LADDER_OK;
    return L[Math.min(Math.max(pass || 1, 1), L.length) - 1];
  };
  /* 判分预告：把「本卡当前连对 + 这次判定」代进同口径函数（pass 含本次，与工具一致） */
  M.previewIntervalOf = (card, res) => M.intervalOf(res, (card && card.passStreak ? card.passStreak : 0) + 1);
  M.LAYER = { K: { name: '知识性', color: 'var(--k)', soft: 'var(--k-soft)' }, L: { name: '逻辑性', color: 'var(--l)', soft: 'var(--l-soft)' }, S: { name: '习惯性', color: 'var(--s)', soft: 'var(--s-soft)' } };
  M.DIFFS = ['易', '中', '难'];
  M.KINDS = ['笔迹归属', '错因口述', '老师漏判', '卷面辨认', '口径确认', '系统维护', '其他'];
  M.ASK_ORDER = ['孩子', '老师', '原卷', '系统'];
  M.ASK_HINT = { 孩子: '孩子本人能答（错因、笔迹）', 老师: '只能跟老师核对（漏判、扣分口径）', 原卷: '拿原卷放大就能定（被覆盖/不清）', 系统: '不是问人，是待改的数据/工具问题' };
  M.ASK_IC = { 孩子: '🧒', 老师: '👩‍🏫', 原卷: '🔍', 系统: '🛠' };

  /* ---------- 状态装载 ---------- */
  M.state = null;
  M.cards = [];             // 扁平 [{key,kid,subject,card}]
  M.listeners = [];
  M.on = fn => M.listeners.push(fn);
  M.emit = () => M.listeners.forEach(fn => { try { fn(); } catch (e) { console.error(e); } });

  /* ---------- 数据源健康（F-39：门禁解包失败的显式报警） ----------
     `_状态.json.dataHealth` 在 v2 此前**零引用**（实测 grep 0 命中）——admit/blindFresh/figState
     解包失败时 v2 静默按空表运行，两道硬门禁在界面上失效而用户完全看不到（2026-10-10
     「界面选得动、工具一提交就拒」的复发形态）。口径与 v1 `_生成首页.ps1:642-674` 的
     applyState/renderHealthBanner 完全一致：① 读 state.dataHealth；② **运行时缺分区也算降级**
     （v1 同款：blindFresh/figState/admit 为 undefined 时记 '运行时状态包缺该分区'）。 */
  M.GATE_NAME = {
    admit: '组卷准入（盲解 + 答案来源）', blindFresh: '盲解指纹新鲜度',
    figState: '配图门禁', pending: '待办台账', data: '题库数据',
  };
  M.MISS_PARTITIONS = ['blindFresh', 'figState', 'admit'];
  M.health = { raw: {}, bad: [], ok: true };
  M.healthOf = function (state) {
    const h = Object.assign({}, (state && state.dataHealth) || {});
    for (const k of M.MISS_PARTITIONS) if (state && state[k] === undefined) h[k] = '运行时状态包缺该分区';
    const bad = [];
    for (const k of Object.keys(h)) if (k.charAt(0) !== '_' && h[k] !== 'ok') bad.push({ key: k, name: M.GATE_NAME[k] || k, val: String(h[k]) });
    return { raw: h, bad: bad, ok: bad.length === 0 };
  };
  /* readonly 派生：shell 红条 / paper 入账前确认 / e2e 断言共用这一处判据 */
  M.healthBad = () => (M.health && M.health.bad) || [];
  M.healthOk = () => !M.healthBad().length;
  M.healthText = () => M.healthBad().map(b => b.name + '：' + b.val).join('；');

  M.applyState = function (state) {
    if (!state || !Array.isArray(state.data)) throw new Error('状态包形态异常（缺 data 数组）');
    M.state = state;
    M.cards = [];
    M.keyOf = new WeakMap();          // card 对象 → "学生|编号"，供 blindFresh 查表（canGroup 只拿到 card）
    for (const kid of state.data) for (const sub of (kid.subjects || [])) for (const card of (sub.items || [])) {
      M.keyOf.set(card, kid.name + '|' + card.id);
      M.cards.push({ key: kid.name + '|' + card.id, kid: kid.name, subject: sub.name, card });
    }
    M.heat = M.heatValues();
    M.health = M.healthOf(state);      // F-39：门禁降级必须显式（见上方 GATE_NAME 段注释）
    M.emit();
  };

  /* ---------- 选择（学生维度，全局顶栏切换；localStorage 记忆） ---------- */
  M.students = () => (M.state && M.state.data || []).map(k => k.name);
  let cur = U.lsGet('ctb2.student', null);
  /* ⚠ 2026-10-11（F-16）：cur 是 localStorage 里的残留值时（学生改名/删档），此前直接返回它 ⇒
     界面全空且顶栏没有这个按钮，用户以为数据没了。现在不在名单里就回落「全部」。 */
  M.student = function (name) {
    if (name !== undefined) { cur = name; U.lsSet('ctb2.student', name); M.emit(); }
    const list = M.students();
    if (cur && cur !== '全部' && list.indexOf(cur) < 0) return '全部';
    return cur || (list[0] || '全部');
  };
  M.isAll = () => M.student() === '全部';
  M.cardsOf = function () { return M.isAll() ? M.cards : M.cards.filter(c => c.kid === M.student()); };

  /* ---------- 复习派生态（a2 精神：nextDue 只是建议日，不排期不强制） ---------- */
  M.dueInfo = function (c) {
    const today = U.today();
    if (c.status === '已归档' || c.reviewStatus === '已归档') return { code: 'arch', label: '已归档', cls: 'gray', overdue: 0 };
    if (!c.nextDue) return { code: 'new', label: c.reviewCount > 0 ? '待再练' : '未复习', cls: 'gray', overdue: 0 };
    const dd = U.diffDays(c.nextDue, today);       // >0 = 已过期 dd 天；null = 日期非法（F-11）
    if (dd == null) return { code: 'baddate', label: '建议日无效：' + String(c.nextDue).slice(0, 16), cls: 'warn', overdue: null };
    if (dd >= 0) return { code: 'due', label: dd === 0 ? '今日到期' : '逾期 ' + dd + ' 天', cls: 'bad', overdue: dd };
    return { code: 'future', label: U.fmtMd(c.nextDue) + ' 建议', cls: 'gray', overdue: -dd };
  };
  M.mastered = c => (c.passStreak >= 2 && c.status !== '已归档') || c.reviewStatus === '已掌握';
  M.inBook = c => c.status === '在册';
  /* ⚠ 2026-10-11（F-09，高）：此前判据是 `/通过|修正/.test(s)` ⇒ 「未通过」「不通过」「已通过但存疑」
     全部被判成 ok:true（探针实证 3/3）。工具侧的唯一白名单是 `_标记复习.mjs:368 BLIND_OK` 与
     `_盲解复核.mjs:57 VERIFIED`，两者都是 `['已通过','已修正']` **精确相等**。
     这里改成同口径：只认白名单，明确的否定态给 false，其余**未知态一律 null**（不是 true）。 */
  M.BLIND_OK = ['已通过', '已修正'];
  /* ★ 2026-10-23（全量双路规则进软件）：状态词补上「待双路」。
     规则来源 = `_盲解复核.mjs` 头注释与 `_词表.md`：入库题必须**两个互不通气的解题者各做一遍**，
     两路都与录入 answer 一致才准入；只跑完一路 → 「待双路」→ 禁止组卷。
     此前 `待双路` 落进下面的"未知态"分支（正则没覆盖这三个字），界面只能笼统说"盲解未过"，
     用户看不出到底差什么 ⇒ 现在是**具名状态**，给明确原因。 */
  M.BLIND_PENDING = '待双路';
  M.BLIND_NO = {
    '未盲解': '还没做过独立盲解',
    '待双路': '只跑完一路，还差另一路（双路一致才准入）',
    '不一致': '两路里有结论与录入不符，待回原卷核实',
  };
  M.blindCls = function (c) {
    const s = (c && c.blindStatus) || '';
    if (M.BLIND_OK.indexOf(s) >= 0) return { ok: true };
    if (M.BLIND_NO[s]) return { ok: false, why: M.BLIND_NO[s] };
    if (/存疑|拦|不一致|未|不|缺/.test(s)) return { ok: false };
    return { ok: null };            // 未知/空 → null（未知 ≠ 通过）
  };
  /* 盲解指纹新鲜度（v1.8+ 铁律的另一半）：题干在盲解之后被改过 → 结论失效，须重盲解。
     数据来自 _盲解复核.mjs 算出的 _状态.json.blindFresh（键 = 学生|编号）。
     ⚠ 2026-10-10 修：此前 v2 只镜了 blindStatus 这一半，且用 `ok !== false` —— 把「未盲解/待双路」
     这种**未知态**也当放行，与工具口径（只认 已通过/已修正）不一致。现在两边同口径：
     ① 状态必须明确是 已通过/已修正；② 若状态包给了新鲜度且不是「有效」→ 拦。 */
  M.blindFreshOf = function (c) {
    const k = M.keyOf && M.keyOf.get(c);
    if (!k) return undefined;
    return ((M.state && M.state.blindFresh) || {})[k];
  };
  M.blindOk = function (c) {
    if (M.blindCls(c).ok !== true) return false;
    const f = M.blindFreshOf(c);
    return f === undefined ? true : f === '有效';   // 无登记时不误伤；登记了则以新鲜度为准
  };
  /* 组卷准入。判定的**唯一实现**在 `_标记复习.mjs 准入`（盲解 + 答案来源两道硬门禁的合成结论），
     由 `_生成首页.ps1` 注入 _状态.json.admit，这里只读不重算。
     ⚠ 2026-10-10：此前 v2 自己写了一份判断、只镜了盲解门禁、漏了答案来源门禁
     ⇒ 界面上选得动、一提交就被工具拒（发布门禁实测踩到）。仍保留 blindOk 作为兜底：
     状态包里没有 admit（旧包）时退回"只看盲解"，宁可界面宽容一点，也绝不让界面比工具更严。 */
  M.admitOf = function (c) {
    const k = M.keyOf && M.keyOf.get(c);
    if (!k) return null;
    const a = ((M.state && M.state.admit) || {})[k];
    return a && typeof a.ok === 'boolean' ? a : null;
  };
  M.canGroup = function (c) {
    if (!M.inBook(c)) return false;
    /* ⚠ 2026-10-11（F-10）：v1 `_生成首页.ps1:737` 的池子是
       `statusOf(it) ∉ {已掌握,已归档} && blindOk(it)` —— 已掌握题**不进池**。
       v2 此前只判 inBook + 准入，会把已掌握的题再送进复习流/组卷篮（当前库 passStreak>=2 为 0 张，
       属口径漂移未显形）。这里补齐 v1 口径。 */
    if (M.mastered(c)) return false;
    const a = M.admitOf(c);
    if (a) return a.ok;
    return M.blindOk(c);          // 兜底：旧状态包没有 admit 时退回原来的判断
  };
  /* 准入被拒的人话理由（抽屉里显示"为什么这张卡不能进篮子"） */
  M.admitWhy = function (c) { const a = M.admitOf(c); return a && !a.ok ? (a.why || '未通过准入') : ''; };

  /* ---------- 错因/知识点聚合 ---------- */
  M.distBy = function (cards, fn) { return U.count(cards, fn); };
  M.causeKey = c => c.causeLayer && c.causeCode ? c.causeLayer + c.causeCode : null;
  M.kpointRank = function (cards, minN) {
    const m = {}; for (const x of cards) for (const kp of ((x.card && x.card.kpoints) || [])) { if (kp == null || kp === '') continue; m[kp] = (m[kp] || 0) + 1; }   // F-17：null 不入榜
    return U.sortEntries(m).filter(e => !minN || e[1] >= minN);
  };
  M.heatValues = function () {
    const v = {};
    for (const x of M.cards) {
      if (x.card.sourceDate) v[x.card.sourceDate] = (v[x.card.sourceDate] || 0) + 1;      // 入册日
      for (const r of (x.card.reviews || [])) if (r && r.date) v[r.date] = (v[r.date] || 0) + 1; // 复习日（r 判空：脏数据可能混入 null 元素，2026-10-16 实测启动即崩）
    }
    return v;
  };

  /* ---------- 待办 ---------- */
  M.pendingItems = () => (M.state && M.state.pending && M.state.pending.items) || [];
  M.pendingOpen = () => M.pendingItems().filter(i => i.status !== '已确认' && i.status !== '已作废');
  M.pendingByAsk = function () {
    const g = {}; for (const a of M.ASK_ORDER) g[a] = [];
    for (const it of M.pendingOpen()) (g[it.askWho] = g[it.askWho] || []).push(it);
    return g;
  };
  /* 办结包逐条结果分类（F-33，高）：壳 `CTBShellV2.cs:398 ParseResults` 与服务端 `_服务端.mjs:91`
     把每条标成 ok / skipped(↔ 已是终态) / missing(✖ id 不存在)。此前 pending.exportPkg 只看
     `st.ok === false`（恒为 true）就 `lsDel('ctb2.pendingLocal')` **清掉全部本地草稿** ⇒ 被拒那条的
     结论永久丢失。判据收在这里一处：**只有 status==='ok' 才允许清本地**，其余原样保留。 */
  M.pkgOutcome = function (results, ids) {
    const by = {};
    for (const r of (Array.isArray(results) ? results : [])) if (r && r.id) by[r.id] = String(r.status || 'unknown');
    const del = [], keep = [];
    for (const id of (ids || [])) (by[id] === 'ok' ? del : keep).push(id);
    return { del: del, keep: keep.map(id => ({ id: id, status: by[id] || 'unknown' })), by: by };
  };

  /* ---------- 组卷篮子（localStorage 临时台账；入账走 _标记复习.mjs） ----------
   * ⚠ 2026-10-12（BUG-11，高·串题）：篮子原先存**裸 `card.id`**，而本库 202 张卡里
   *   **31 个卡号在学生A与学生B之间重号**（M0001…M0031 等）⇒ 顶栏切到「全部」时，
   *   `basketCards()` 会把两个孩子的同名卡**一起**捞进组卷池，印出孩子不属于自己的题
   *   （实测：只入篮「学生B·M0001」却捞出 2 张，答案分别是 −19 与一道函数题）。
   *   根因是"用业务编号当身份"——编号只在**单库内**唯一，跨库会撞。
   * 现在：**一律用 `kid|id` 作身份**（与 `M.cards[].key`、准入表、盲解新鲜度表同一把钥匙），
   *   并保留对旧格式（裸 id）的**只读迁移**，让用户已存的篮子不至于凭空清空。
   */
  /* 卡片引用 → 篮子键。传 card 或带 kid 的引用都可以 */
  M.basketKeyOf = function (x) {
    if (!x) return '';
    if (x.kid) return x.kid + '|' + x.card.id;      // cardsOf() 的条目 {kid, card}
    return String(x.id || '');                    // 裸 card（无 kid）⇒ 无法定身份，调用方须先补 kid
  };
  M.basketKey = kid => 'ctb2.basket.' + (kid === undefined ? M.student() : kid);
  /* ⚠ F-12（2026-10-11）：localStorage 被写坏（`'{"a":1}'`）时直接返回对象 ⇒
     `basketCards()` 的 `new Set(obj)` 抛 TypeError ⇒ 整页「渲染出错」。守卫沿用。 */
  M.basket = function (kid) {
    const v = U.lsGet(M.basketKey(kid), []);
    return Array.isArray(v) ? v : [];
  };
  M.basketSet = function (list, kid) { U.lsSet(M.basketKey(kid), (Array.isArray(list) ? list : []).slice()); M.emit(); };
  /** 旧格式（裸 id）→ 新格式（kid|id）：一次性迁移，保留用户已选的题。
   *  ⚠ 2026-10-12 修（用户实测那个「5」）：原先只迁 `M.student()` 那一档，且只在启动时被调一次
   *    ⇒ **别的孩子的旧篮永远迁不到**，切过去还是裸编号。
   *    现在：**遍历全部槽位**（每个学生 + 「全部」档）逐个迁。
   *  ⚠ 关键实现约束：迁移**不得**用 `M.student(kid)` 切档来做（① `M.student()` 有副作用会把当前档
   *    留在最后遍历的那个上；② 「全部」档压根不在 `M.students()` 里，永远迁不到）。
   *    改为**按槽位名直接读/写 localStorage**（`basket(kid)` / `basketSet(list, kid)`），全程不动当前档。
   *  ⚠ 顺带丢弃解析不到的键（库里已删的题、认不出的旧格式）——它们正是角标虚高的来源。
   *    判据仍与从前一致：宁可少一题，不可错一题。 */
  M.basketMigrate = function () {
    const slots = M.students().concat(['全部']);
    for (const slot of slots) migrateSlot(slot);
    /* 一个槽位（= 一个学生档，或「全部」档） */
    function migrateSlot(slot) {
      const b = M.basket(slot);
      if (!b.length) return;
      const known = {};
      /* 「全部」档看得见全部卡；具体学生档只看自己的（防把另一个孩子的题当成自己的） */
      for (const x of M.cards) {
        if (slot === '全部' || x.kid === slot) known[x.kid + '|' + x.card.id] = 1;
      }
      const out = [], seen = {};
      for (const raw of b) {
        const s = String(raw);
        /* 旧裸 id：只有具体学生档能确定归属；「全部」档不猜（宁可少一题，不可错一题） */
        const k = s.indexOf('|') >= 0 ? s : (slot !== '全部' ? slot + '|' + s : '');
        if (!k || !known[k] || seen[k]) continue;
        seen[k] = 1; out.push(k);
      }
      /* 已是新格式且无脏键时不写（少一次 localStorage 写 + 少一次 emit） */
      if (out.length !== b.length || out.some((v, i) => v !== b[i])) M.basketSet(out, slot);
    }
  };
  M.basketHas = function (x) { return M.basket().indexOf(M.basketKeyOf(x)) >= 0; };
  /* ⚠ 2026-10-12（用户实测「组卷工作台显示 5」，同屏配卷屏却是「篮子是空的」）：
     角标/顶栏副标题数的是 `basket().length`（localStorage 里的**键数**），配卷屏数的是
     `basketCards().length`（**能解析成真实题卡**的键）——两套口径，同屏 5 与 0 并存。
     那个 5 的真实内容是 BUG-11 改 `kid|id` 时没迁干净的**旧裸编号**（本机实测：`["M0027"…"M0031"]`）。
     修法：**计数只有一个实现** `M.basketCount()`，语义＝「真正能配成卷的题数」＝配卷屏口径。
     凡展示篮子题数的地方一律调它；**禁止**任何地方直接 `basket().length`。 */
  M.basketCount = function () { return M.basketCards().length; };
  M.basketToggle = function (x) {
    const k = M.basketKeyOf(x); if (!k) return;
    const b = M.basket(), i = b.indexOf(k);
    if (i >= 0) b.splice(i, 1); else b.push(k);
    M.basketSet(b);
  };
  M.basketClear = () => M.basketSet([]);
  M.basketCards = function () {
    const b = M.basket(), set = new Set(b), idx = new Map(b.map((k, i) => [k, i]));
    return M.cardsOf().filter(x => set.has(x.kid + '|' + x.card.id))
      .sort((a, c) => idx.get(a.kid + '|' + a.card.id) - idx.get(c.kid + '|' + c.card.id));
  };

  /* ---------- 复习会话（内存态；结束时一次性走 组卷→批改） ---------- */
  M.session = null;         // {queue:[cardRef], idx, results:{kid|subject|id:{res,date}}, committed:{kid|subject:{paperId,list}}, startedAt}
  M.startSession = function (queue) {
    if (!queue.length) return null;
    M.session = { queue, idx: 0, results: {}, committed: {}, startedAt: new Date().toISOString() };
    return M.session;
  };
  M.sessionGrade = function (res) {
    const s = M.session; if (!s || !s.queue[s.idx]) return;
    const ref = s.queue[s.idx];
    s.results[ref.kid + '|' + ref.subject + '|' + ref.card.id] = { id: ref.card.id, kid: ref.kid, subject: ref.subject, res, date: U.today() };
    s.idx++;
    M.emit();
  };
  M.sessionUndo = function () {
    const s = M.session; if (!s) return;
    if (s.idx < s.queue.length) {                     // 还停在未答题上：若该题已判过（重改）先清掉
      const ref = s.queue[s.idx], k = ref.kid + '|' + ref.subject + '|' + ref.card.id;
      if (s.results[k]) delete s.results[k];
      else if (s.idx > 0) { const p = s.queue[s.idx - 1]; delete s.results[p.kid + '|' + p.subject + '|' + p.card.id]; s.idx--; }
      /* ⚠ 2026-10-12（BUG-06，中）：跳过标记必须与撤销**同步清理**。
         原实现只动 results/idx，从不碰 s.skipped ⇒ "跳过 → 撤销"后回到那道题，
         它却仍被算作"已跳过"：结算屏照报"另 N 题跳过未判"，
         而"只练这 N 题"会把**已经判过的题**拉进新会话（第一次判定随 M.session=null 丢失）。
         ⚠ 第一版修复也写错过：清的是 `s.queue[s.idx].key`（撤销**前**那张），
         而撤销会把 idx 退回**上一张** ⇒ 该清的那张标记原封不动（探针实测仍为 1）。
         正确判据：清**退回后 idx 所指那道题**的标记 —— 那才是用户眼前、语义上"没跳过"的题。 */
      if (s.skipped && s.idx < s.queue.length && s.queue[s.idx]) delete s.skipped[s.queue[s.idx].key];
    } else {                                          // 已到尾部：撤最后一题的判定
      const p = s.queue[s.queue.length - 1]; delete s.results[p.kid + '|' + p.subject + '|' + p.card.id]; s.idx--;
      if (s.skipped) delete s.skipped[p.key];
    }
    M.emit();
  };
  M.sessionDone = () => M.session && M.session.idx >= M.session.queue.length;
  M.sessionGradedCount = () => M.session ? Object.keys(M.session.results).length : 0;
  M.sessionSkippedCount = () => M.session ? Object.keys(M.session.skipped || {}).length : 0;
  /* 把若干题从本场判定里剔除（门禁拦下时用）。
     ⚠ 2026-10-11（F-RB-10，中）：此前 review.commit 只 `delete s.results[k]`，
     而 endSession 在「本组判定已被摘空（组消失）」时会退回 `committed[key].list` 取列表 ⇒
     **被剔的被拦题又被捞回来重新批改**，永远失败、批次永久停「待批改」。
     ⚠ 2026-10-12（BUG-05·同源·高）：原实现按**裸 id** 匹配（`set.has(r.id)`），
     而库里有 31 个卡号跨学生重号 ⇒ 剔「学生A·P0001」会连带把「学生B·P0001」也剔掉。
     现在：入参必须是完整键 `kid|id`；只给裸 id 时**直接拒绝剔除**（宁可让用户重试，
     也不静默删掉另一个孩子的判定）。剔除同时剪 results 与 committed[k].list。 */
  M.sessionDrop = function (ids) {
    const s = M.session; if (!s || !ids || !ids.length) return 0;
    const full = new Set(ids.map(String).filter(x => x.indexOf('|') >= 0));
    if (!full.size) return 0;                 // 只给裸 id：无法定身份，宁可不剔也不误删
    const match = r => full.has(r.kid + '|' + r.id);
    let n = 0;
    for (const k of Object.keys(s.results)) { if (match(s.results[k])) { delete s.results[k]; n++; } }
    for (const gk of Object.keys(s.committed || {})) {
      const c = s.committed[gk];
      if (!c || !Array.isArray(c.list)) continue;
      const keep = c.list.filter(r => !match(r));
      if (keep.length !== c.list.length) { n += c.list.length - keep.length; c.list = keep; }
    }
    M.emit();
    return n;
  };
  /* 本场还欠着的组：results 里的组 ∪ committed 里没跑完的组。
     ⚠ BUG-12（高·判定丢失）修复：`endSession` 把"组卷成功、批改失败"的组登记进 committed 并
     把判定摘出 results，所以**只数 results 会漏掉它们** ⇒ 结算屏以为"这场没判任何题"、
     又因 rows.length=0 不给落库按钮（review.js:324）⇒ 判分永久丢失且无入口可补。
     判据必须是"还有没有任何东西没写回台账"，而不是"results 里还有几条"。 */
  M.sessionOutstanding = function () {
    const s = M.session; if (!s) return [];
    const g = {};
    for (const k in s.results) { const r = s.results[k]; const gk = r.kid + '|' + r.subject; (g[gk] = g[gk] || { kid: r.kid, subject: r.subject, n: 0 }).n++; }
    for (const k in (s.committed || {})) { if (!g[k]) { const p = String(k).split('|'); g[k] = { kid: p[0] || '', subject: p[1] || '', n: (s.committed[k].list || []).length }; } }
    return Object.keys(g).map(k => g[k]);
  };
  /** 还有多少条判定没写回台账（results + committed 两处一起数） */
  M.sessionPendingCount = function () {
    const s = M.session; if (!s) return 0;
    let n = 0;
    for (const k in s.results) n++;
    for (const k in (s.committed || {})) n += ((s.committed[k] && s.committed[k].list) || []).length;
    return n;
  };
  /** 裸 id 在本场命中几条（>1 说明跨学生重号，调用方须改传完整键） */
  M.sessionAmbiguous = function (id) {
    const s = M.session; if (!s) return 0;
    let c = 0;
    for (const k in s.results) if (s.results[k].id === id) c++;
    for (const k in (s.committed || {})) for (const r of ((s.committed[k] && s.committed[k].list) || [])) if (r.id === id) c++;
    return c;
  };
  M.sessionGroups = function () {   // 按学生·学科分组（组卷天然单科）
    const g = {};
    for (const k in M.session.results) { const r = M.session.results[k]; const key = r.kid + '|' + r.subject; (g[key] = g[key] || []).push(r); }
    return g;
  };
  /* 本场落库：按学生·学科 组卷 → 批改。
     ⚠ 2026-10-11（F-13/F-20，高）：此前「组卷」成功而「批改」失败时本组判定**仍留在 results**
     （删除语句写在 r2 成功之后）⇒ 用户重试同一场 → 同一批题**再组一张卷**：台账出现两个 P 批次，
     第一张永久停在「待批改」，孩子会收到两张一样的卷。
     现在与 paper.js 的 `sheet.committed` 同款「先记批次再批改」：组卷成功立刻摘出本组判定并登记
     `committed[组]={paperId,list}`，失败重试时**只补批改、绝不再组卷**。 */
  M.endSession = async function () {
    const s = M.session;
    if (!s) return [];
    s.committed = s.committed || {};
    const groups = M.sessionGroups();
    const stamp = U.today();
    const out = [];
    const keys = Object.keys(groups).concat(Object.keys(s.committed).filter(k => !groups[k]));
    for (const key of keys) {
      const [kid, subject] = key.split('|');
      let list = groups[key] || (s.committed[key] && s.committed[key].list) || [];
      let paperId = s.committed[key] && s.committed[key].paperId;
      /* F-RB-10 配套：本组判定被剔空（组消失、committed.list 也剪空）时不要再发一次空批改
         —— 空 results 只会让工具把该批次继续留在「待批改」，用户看到的是「已落库」却永远没批改。
         批次已建但无可批内容：撤掉登记（不让它在下一次重试里阴魂不散），
         该批次可在组卷工作台按批次号「撤批」处理。 */
      if (!list.length) { delete s.committed[key]; continue; }
      const resStr = list.map(x => x.id + '=' + x.res).join(',');
      if (!paperId) {
        const ids = list.map(x => x.id).join(',');
        const paperTitle = '屏幕复习·' + kid + subject + '·' + stamp;
        const r1 = await CTB.host.mark('组卷', { student: kid, subject, ids, title: paperTitle, date: stamp, note: '复习流自动卷' });
        if (!r1 || r1.code !== 0) throw new Error('组卷失败：' + ((r1 && (r1.err || r1.out) || '').slice(-400)));
        const pm = String(r1.out || '').match(/P\d{8}-\d{2}/);
        if (!pm) throw new Error('组卷成功但未解析到批次号：' + String(r1.out || '').slice(-200));
        paperId = pm[0];
        /* 立刻登记批次号 + 摘出本组判定：此后任一步失败都不会再组第二张卷 */
        s.committed[key] = { paperId: paperId, list: list.slice() };
        for (const x of list) delete s.results[x.kid + '|' + x.subject + '|' + x.id];
      }
      const noteParts = list.filter(x => x.note).map(x => x.id + '：' + x.note);
      const noteStr = ('屏幕复习·' + kid + subject + ' ' + stamp + (noteParts.length ? ' ｜转折点笔记 ' + noteParts.join('；') : '')).slice(0, 400);
      const r2 = await CTB.host.mark('批改', { paper: paperId, results: resStr, date: stamp, note: noteStr });
      if (!r2 || r2.code !== 0) throw new Error('批改失败（批次 ' + paperId + ' 已建，重试只会补批改、不会重复组卷）：' + ((r2 && (r2.err || r2.out) || '').slice(-400)));
      out.push(paperId + '（' + list.length + ' 题）');
      delete s.committed[key];                    // 本组全链路完成
    }
    return out;
  };

  /* ---------- 印刷版题干（**唯一实现**，三处渲染点共用） ----------
     ⚠ 2026-10-11（F-27 / F-57 / F-58）：
     ① F-27：paper.qHtml / review.card / bank.openCard 三处此前都是 `'<div class="q-stem">' + c.stemHtml + '</div>`
        直插原始 HTML。`题干.html` 由 agent 生成（189/202 张卡有），内容可含任意标签/事件属性 ⇒ XSS 面。
     ② F-57：11 张卡的 `题干.html` 里写 `<img src="题图.jpg">`（相对**卡片自身目录**），而 v2 文档 base 在
        `v2\`、v1 在题库根，两处都不存在该文件 ⇒ 印刷版题干缺图（物理题图缺失＝题目不可解）。实测：
        P0017/P0024/P0029/P0035/P0036/P0038/P0040/P0048/P0070/P0074/P0075 共 11 张，src 全是 `题图.jpg`。
     ③ F-58：卡片有 `fig`（题图.jpg）而 stemHtml 无内联图时，v1 `stemBlockOf` 会补出图，v2 完全不引用 `fig`
        （实测 1 张：C0003）。
     一处实现，四个来源一个优先级：stemHtml（净化+相对图重写）> fig 兜底 > 纯文字题干。 */
  /* 白名单按**本库实测出现过的**标签/属性定（2026-10-11 扫描 189 张 stemHtml：
     标签 28 种、属性 56 种、`on*` 事件属性 **0** 处、29 个 style 值全是布局样式）。
     ⚠ 与审计建议的唯一偏差：**保留 style**（width:6em/display:flex 是分数与表格布局的承重墙，
     剔掉会让物理/数学卷面散架）；改为对 style 值做危险函数过滤（url()/expression/javascript:/behavior）。 */
  M.STEM_TAGS = ['p', 'span', 'i', 'b', 'strong', 'em', 'u', 's', 'sub', 'sup', 'br', 'div',
    'table', 'thead', 'tbody', 'tr', 'td', 'th', 'img',
    'svg', 'g', 'defs', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'marker', 'pattern', 'use'];
  M.STEM_ATTRS = ['class', 'style', 'id', 'title', 'alt', 'src', 'width', 'height', 'viewbox', 'xmlns', 'd', 'cx', 'cy', 'r', 'rx', 'ry',
    'x', 'y', 'x1', 'y1', 'x2', 'y2', 'points', 'fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap',
    'stroke-linejoin', 'stroke-opacity', 'transform', 'text-anchor', 'dominant-baseline', 'font-family', 'font-size', 'font-style', 'font-weight',
    'marker-start', 'marker-end', 'marker-mid', 'markerwidth', 'markerheight', 'markerunits', 'refx', 'refy', 'orient',
    'patternunits', 'patterntransform', 'preserveaspectratio', 'rowspan', 'colspan', 'dy', 'dx', 'opacity', 'role', 'aria-label'];
  /* 卡片目录：stemHtml 里的相对 src 必须相对**卡片自身目录**解析。目录来源＝索引里既有的
     题库根相对路径字段（不新造约定）；四个字段实测同目录（202 张卡 0 例不一致）。 */
  M.CARD_DIR_SRC = ['md', 'img', 'stem', 'fig', 'origPage'];
  M.cardDirOf = function (card) {
    if (!card) return '';
    for (const f of M.CARD_DIR_SRC) {
      const dec = U.decPath(card[f]);
      const i = dec.lastIndexOf('/');
      if (i > 0) return dec.slice(0, i);
    }
    return '';
  };
  /* 相对引用 → 题库根相对路径（外链/绝对/已编码/自带目录的原样返回，不猜） */
  M.qualifyRel = function (dir, src) {
    const s = String(src == null ? '' : src).trim();
    if (!s) return '';
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) return s;        // http: https: data: file: C:
    if (s.charAt(0) === '/' || s.charAt(0) === '\\') return s; // 根绝对
    if (/%[0-9a-fA-F]{2}/.test(s)) return s;                   // 已编码 → 既有约定视作题库根相对
    if (s.indexOf('/') >= 0) return s;                         // 自带目录 → 同上
    return dir ? dir + '/' + s : s;
  };
  /* 净化 + 相对图重写（asset 由 host 提供：题库根相对路径 → 可加载 URL） */
  M.stemHtmlSafe = function (card) {
    /* ⚠ 2026-10-11 修（F-58 其实没修完）：原先 `if (!card || !card.stemHtml) return '';` 直接早退，
       于是"**只有题图、没有 题干.html**"的卡（本库 C0003 实测 1 张，且题图正是这类题的题干本体）
       永远走不到下面的 fig 兜底 ⇒ v2 印不出题，而断言"有 fig 应补出题图"必然红。
       现在：card 为空才早退；stemHtml 为空时按空串继续走净化，再由 fig 兜底补图。 */
    if (!card) return '';
    const dir = M.cardDirOf(card);
    const asset = rel => H.asset(rel);
    /* ⚠ 2026-10-23：`String(null)` 得到字符串 "null"，会原样印到「题干（印刷版）」区块里
       （用真卡实测撞到）。stemHtml 缺席/为 null 都按空串处理，交给下方 question/fig 兜底。 */
    let s = (card.stemHtml === null || card.stemHtml === undefined) ? '' : String(card.stemHtml);
    /* 先连内容一起丢掉「整段危险容器」，再做标签级白名单（否则只剩标签被剔、脚本正文留在页面上） */
    s = s.replace(/<(script|style|iframe|object|embed|template|noscript|svg\s*:\s*script)\b[\s\S]*?<\/\1\s*>/gi, '');
    s = s.replace(/<(script|style|iframe|object|embed|link|meta|base|form|input|button|textarea|select)\b[^>]*>/gi, '');
    let out = '', last = 0, m;
    const re = /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
    while ((m = re.exec(s))) {
      out += s.slice(last, m.index); last = re.lastIndex;
      const closing = m[0].charAt(1) === '/';
      const name = m[1].toLowerCase();
      if (M.STEM_TAGS.indexOf(name) < 0) continue;                 // 非白名单标签：丢标签留正文
      out += '<' + (closing ? '/' : '') + name + (closing ? '' : M.filterAttrs(m[2], dir, asset)) + (closing ? '' : (/\/\s*$/.test(m[3]) ? ' /' : '')) + '>';
    }
    out += s.slice(last);
    /* fig 兜底（F-58）：题干里既无 <img> 也无 <svg> 时才补，避免与内联图重复 */
    if (card.fig && !/<(img|svg)\b/i.test(out)) out += '<div class="stem-figure"><img src="' + U.esc(H.asset(card.fig)) + '" alt="题图"></div>';
    /* 填空空位（2026-10-16）：转 .blank 的实现唯一化到 M.stemBlankify（纯文本兜底同用）。 */
    out = M.stemBlankify(out);
    return out;
  };
  /* 填空空位转换（2026-10-16，C0002 实测「填空位置太小，一写就跑出去」）：
     题干里的 ASCII 下划线（______，多为索引 question 直印）与全角＿串转成真空位 .blank；
     已是 .blank 的（题干.html 手写，自带宽度）不受影响（无下划线串可匹配）。
     宽度：手写 span 有 style 用 style，转换出来的给 min-width:7em（≈31mm，Na⁺、Cl⁻ 这类
     短答案写得下；多空题均分纸面也够）。⚠ 只动「空位」不动文字；SVG 内部不下笔，跳过。
     stemHtmlSafe 的出口与 qHtml 的纯文本兜底（无 题干.html 的卡）都走这一个实现。 */
  M.stemBlankify = function (s) {
    if (!s || !/_{2,}|＿{2,}/.test(s)) return s;
    return String(s).split(/(<svg[\s\S]*?<\/svg>)/gi).map(seg =>
      /^<svg/i.test(seg) ? seg : seg.replace(/_{2,}/g, '<span class="blank" style="min-width:7em"></span>').replace(/＿{2,}/g, '<span class="blank" style="min-width:7em"></span>')
    ).join('');
  };
  /* 属性级白名单（`on*` 一律剔除；src 重写到卡片目录；style 值过危险函数） */
  M.filterAttrs = function (raw, dir, asset) {
    const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
    let m, out = '';
    while ((m = re.exec(raw || ''))) {
      let name = m[1].toLowerCase();
      const val = m[2] != null ? m[2] : (m[3] != null ? m[3] : (m[4] != null ? m[4] : ''));
      if (name.slice(0, 2) === 'on') continue;                     // 事件属性：一律不许（XSS 主通道）
      if (name.indexOf('xlink:') === 0) name = name.slice(6);
      if (M.STEM_ATTRS.indexOf(name) < 0) continue;
      let v = val;
      if (name === 'src') {
        if (/^\s*javascript:/i.test(v)) continue;
        v = asset(M.qualifyRel(dir, v));                           // ← F-57 的修复点
      } else if (name === 'style') {
        if (/url\s*\(|expression\s*\(|javascript:|behavio[u]?r\s*:|-moz-binding/i.test(v)) continue;
      } else if (name === 'href') {
        if (!/^(https?:|data:image\/|#|\.{0,2}\/)/i.test(v)) continue;
      }
      out += ' ' + name + '="' + U.esc(v) + '"';
    }
    return out;
  };

  /* ---------- 搜索 ---------- */
  M.search = function (q, limit) {
    if (!q || q.trim().length < 1) return [];
    const hits = [];
    for (const x of M.cards) {
      const c = x.card;
      const hay = [c.id, x.kid, x.subject, c.question, c.type, c.source, c.causeDesc, (c.kpoints || []).join(' ')].join(' ');
      const sc = U.fuzzy(q.trim(), hay);
      if (sc >= 0) hits.push({ x, sc });
    }
    return hits.sort((a, b) => b.sc - a.sc).slice(0, limit || 20).map(h => h.x);
  };
  /* 卡片 → 原卷溯源三件套（索引 origPage/origImport 是 URL 编码形态，壳要的是解码相对路径）。
     三处灯箱调用点共用这一个实现，禁止各写一份——漂移过一次（裁图冒充原图）就是教训。 */
  M.origOf = function (c) {
    return {
      orig: c && c.origPage ? H.relPath(c.origPage) : null,
      origImport: c && c.origImport ? H.relPath(c.origImport) : null,
      origBox: (c && c.origBox && c.origBox.length === 4) ? c.origBox : null,
      origBy: (c && c.origBy) || null,
    };
  };
})();
