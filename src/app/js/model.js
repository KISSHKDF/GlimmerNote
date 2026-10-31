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
    /* 2026-10-27 补：原卷溯源台账也会进 dataHealth，但这里原先没有中文名 ⇒
       红条上直接显示英文键名（「origPage：…」），用户看不懂那是哪个门禁。 */
    origPage: '原卷溯源台账', papers: '组卷台账',
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
  M.dueInfo = function (x) {
    const c = M.cardOf(x) || {};
    const today = U.today();
    if (c.status === '已归档' || c.reviewStatus === '已归档') return { code: 'arch', label: '已归档', cls: 'gray', overdue: 0 };
    if (!c.nextDue) return { code: 'new', label: c.reviewCount > 0 ? '待再练' : '未复习', cls: 'gray', overdue: 0 };
    const dd = U.diffDays(c.nextDue, today);       // >0 = 已过期 dd 天；null = 日期非法（F-11）
    if (dd == null) return { code: 'baddate', label: '建议日无效：' + String(c.nextDue).slice(0, 16), cls: 'warn', overdue: null };
    if (dd >= 0) return { code: 'due', label: dd === 0 ? '今日到期' : '逾期 ' + dd + ' 天', cls: 'bad', overdue: dd };
    return { code: 'future', label: U.fmtMd(c.nextDue) + ' 建议', cls: 'gray', overdue: -dd };
  };
  M.mastered = x => {
    const c = M.cardOf(x) || {};
    return (c.passStreak >= 2 && c.status !== '已归档') || c.reviewStatus === '已掌握';
  };
  M.inBook = x => { const c = M.cardOf(x) || {}; return c.status === '在册'; };
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
  M.blindCls = function (x) {
    const c = M.cardOf(x) || {};        // 形状统一：包装对象与裸卡都吃（见 M.cardOf 的说明）
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
  M.blindFreshOf = function (x) {
    const c = M.cardOf(x) || {};
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
  M.admitOf = function (x) {
    const c = M.cardOf(x) || {};
    const k = M.keyOf && M.keyOf.get(c);
    if (!k) return null;
    const a = ((M.state && M.state.admit) || {})[k];
    return a && typeof a.ok === 'boolean' ? a : null;
  };
  /* ★ 2026-10-25（用户 3 次报障「这批题都没过准入」，实测 177/177 门禁全绿）：
     真正的缺陷是**入参形状被静默误用**——`cardsOf()`/`basketCards()`/`filtered()` 返回的条目是
     包装对象 `{key,kid,subject,card}`，而 canGroup/blindCls/admitOf 要的是**裸卡**。
     包装对象上 `status` 是 undefined ⇒ `inBook()` 恒 false ⇒ **一律返回 false**。
     于是「题库浏览 → 用筛选结果开复习会」和「复习流 → 题源=组卷篮」这两个入口永远进不去，
     而界面只提示"盲解未过/答案来源没核实"，把一条**类型错误**伪装成**数据质量问题**，
     用户去逐题核对只会越核对越糊涂（本次就是这么查了三轮）。
     修法有两层，缺一不可：
       ① 入口统一收卡：`M.cardOf(x)` 是唯一实现，包装对象与裸卡都能吃（兼容旧的调用点）；
       ② 错误形状**响亮失败**：既不是裸卡也不是能解出裸卡的包装对象时抛错，
          绝不再静默 false —— "静默 false 看着像门禁在工作"正是本 bug 活了这么久的根因。 */
  M.cardOf = function (x) {
    if (!x || typeof x !== 'object') return null;
    /* 只在**确实是包装对象**时拆包（有 .card 对象、自身没有 id）。
       其余一律原样当裸卡 —— 判据自身会对缺字段给出"未知/空"的既定语义
       （例：`blindCls({blindStatus:'已通过'})` 这种只带单字段的调用必须继续有效）。 */
    if (x.card && typeof x.card === 'object' && x.id === undefined) return x.card;
    return x;
  };
  M.canGroup = function (x) {
    const c = M.cardOf(x);
    /* 报错要指名坐标：哪个编号/哪个键，否则下次又是"看不到问题在哪"。
       注意判据是"有没有 id"——canGroup 要做准入查表，没有编号就不可能判得对，
       与其静默 false（本 bug 活了这么久的根因），不如当场响亮失败。 */
    if (!c || c.id === undefined) throw new Error('canGroup(入参形状错)：既不是卡也不是 {card} 包装对象 → ' +
      JSON.stringify(x && Object.keys(x).slice(0, 6)));
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
     `committed[组]={paperId,list}`，失败重试时**只补批改、绝不再组卷**。
     ⚠ 2026-10-25：新增 `opts.force` —— 用户在确认框里明确选「仍要落库」时把 --force 透传给组卷口
     （用途：防重复印卷门禁拦下但用户坚持；工具会打印"绕过"告警留痕）。
     另：返回 `[]` 表示**这一趟什么都没写进台账**，调用方必须据此提示「没有写入」，
     绝不能报「已落库」（2026-10-25 实测：判定被剔空后旧代码打的是绿色「已落库」）。 */
  M.endSession = async function (opts) {
    const force = !!(opts && opts.force);
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
        const payload = { student: kid, subject, ids, title: paperTitle, date: stamp, note: '复习流自动卷' };
        if (force) payload.force = '1';
        const r1 = await CTB.host.mark('组卷', payload);
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
  M.cardDirOf = function (x) {
    const card = M.cardOf(x);           // 形状统一（2026-10-25 D-063）：喂包装对象不再静默返回空串
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
  /* 净化出口的**尾部转义**（S01 的唯一实现；tests/neg-stem-sanitize.cjs 的阴性自证按名字
     掏掉它，改名必须同步那一条用例）。
     只转 `<`：它是"能形成一个标签"的唯一入口。`&`/`>` 必须原样留着，否则题干里既有的
     实体引用（&nbsp;、&lt; 等）在末尾会被印成字面量，与中段正文的口径分叉。 */
  M.escapeStemTail = function (tail) {
    return String(tail == null ? '' : tail).replace(/</g, '&lt;');
  };
  /* 标签属性串里是否出现**引号外**的裸 `<`（= 标签边界不可信）。 */
  M.hasBareLt = function (attrs) {
    return String(attrs == null ? '' : attrs).replace(/"[^"]*"|'[^']*'/g, '').indexOf('<') >= 0;
  };
  /* 净化 + 相对图重写（asset 由 host 提供：题库根相对路径 → 可加载 URL） */
  M.stemHtmlSafe = function (x) {
    /* ⚠ 2026-10-11 修（F-58 其实没修完）：原先 `if (!card || !card.stemHtml) return '';` 直接早退，
       于是"**只有题图、没有 题干.html**"的卡（本库 C0003 实测 1 张，且题图正是这类题的题干本体）
       永远走不到下面的 fig 兜底 ⇒ v2 印不出题，而断言"有 fig 应补出题图"必然红。
       现在：card 为空才早退；stemHtml 为空时按空串继续走净化，再由 fig 兜底补图。
       ★ 2026-10-25（D-063）：再加一层形状统一——喂包装对象时取其 .card，
         否则这里会静默返回空串（题干整块空白，用户看到的是"这题没题面"）。 */
    const card = M.cardOf(x);
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
      /* ★ 2026-10-30（S01 配套）：属性串里出现**引号外的裸 `<`** ⇒ 这个标签的边界已不可信
         （正则为了凑出结尾的 `>`，把后面的标签也吞进了属性串），整只标签丢弃，
         不按"近似"重建 —— 从一个说不清边界的片段里凭空造标签，正是本类漏洞的形态。 */
      if (!closing && M.hasBareLt(m[2])) continue;
      out += '<' + (closing ? '/' : '') + name + (closing ? '' : M.filterAttrs(m[2], dir, asset)) + (closing ? '' : (/\/\s*$/.test(m[3]) ? ' /' : '')) + '>';
    }
    /* ★ 2026-10-30（审计 S01，高）：尾部残留必须**转义后**拼回，原来这里直接
       `out += s.slice(last)` 把没被正则吃掉的原文原样贴进 HTML。
       根因：上面的标签正则只匹配**完整标签**（结尾必须有一个 `>`），而浏览器的 HTML 解析器
       不是这样 —— 末尾那截 `<img src=x onerror=…` 会被它当成"标签还没写完"，紧接着模板
       追加的 `</div>` 恰好把缺失的 `>` 补上 ⇒ 残缺片段凭空变成一个带事件属性的**活标签**。
       三个变体实测（修复前全部原样返回）：末尾无 `>` / 引号未闭合 / 末尾裸 `<`。
       修法（fail-closed）：尾部按纯文本处理，见 M.escapeStemTail 段。
       代价：残缺片段会以原文形式显示在题面上 —— AI 生成的题干坏了应当看得见，
       而不是被静默丢掉、让用户以为"这题本来就没图"。
       ── 为什么只修**末尾**、中段正文（上面的 `s.slice(last, m.index)`）不动 ──
       中段的未匹配片段看着也一样可疑，但实测走不到执行：浏览器在标签状态下对引号的消费
       规则与上面那个正则**逐个字符同序**（成对的引号整段跳过、其余字符逐个吃），因此凡是
       浏览器能拼成"带 on* 属性的标签"的片段，正则也一定能匹配到它 —— 要么被 filterAttrs
       摘掉 on*，要么因标签不在白名单里整只丢掉。两者唯一的真差异在**边界**：浏览器遇到
       输入结束会丢弃未完成的标签，而本模块的输出总是被模板拼进容器
       （`'<div class="q-stem">' + … + '</div>'`），容器自带的 `>` 把尾部那截补全成标签。
       所以可执行面只在末尾；中段残留的后果是"后面的标记被吞掉"（内容缺失，修复前就存在，
       与注入无关），不在本次改动范围内。 */
    out += M.escapeStemTail(s.slice(last));
    /* fig 兜底（F-58）：题干里既无 <img> 也无 <svg> 时才补，避免与内联图重复 */
    if (card.fig && !/<(img|svg)\b/i.test(out)) out += '<div class="stem-figure"><img src="' + U.esc(H.asset(card.fig)) + '" alt="题图"></div>';
    /* 填空空位（2026-10-16）：转 .blank 的实现唯一化到 M.stemBlankify（纯文本兜底同用）。
       ★ 2026-10-25：收尾改走 M.stemFit —— 除了把下划线转成空位，还要按卡片声明的
         逐空答案（answerSlots）把每个空撑到写得下（用户 M0084 报障：6em 的横线装 9em 的答案）。 */
    out = M.stemFit(out, card);
    return out;
  };
  /* 填空空位转换（2026-10-16，C0002 实测「填空位置太小，一写就跑出去」）：
     题干里的 ASCII 下划线（______，多为索引 question 直印）与全角＿串转成真空位 .blank；
     已是 .blank 的（题干.html 手写，自带宽度）不受影响（无下划线串可匹配）。
     ★ 2026-10-25：**编号横线 `____3____` 整体转成一个空位**，编号作为标签印在空位里
       （`.blank-no`）。早一版按普通下划线处理 ⇒ 8 空的完形填空渲染出 16 条横线，
       逐空答案对不上号（实测 E0010）。
     宽度：手写 span 有 style 用 style，转换出来的给 min-width:7em（答案再由 stemFit 撑宽）。
     ⚠ 只动「空位」不动文字；SVG 内部不下笔，跳过。
     stemHtmlSafe 的出口与 qHtml 的纯文本兜底（无 题干.html 的卡）都走这一个实现。 */
  M.blankLabel = function (raw) {
    const m = /[0-9０-９]{1,3}/.exec(String(raw || ''));
    return m ? m[0].replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)) : '';
  };
  M.stemBlankify = function (s) {
    if (!s || !/_{2,}|＿{2,}/.test(s)) return s;
    const conv = seg => {
      /* 先吃编号横线：整段一个空位 + 编号标签 */
      let out = String(seg).replace(M.NUMBERED_UNDERSCORE_RE, m => {
        const n = M.blankLabel(m);
        return '<span class="blank" style="min-width:7em">' + (n ? '<span class="blank-no">' + n + '</span>' : '') + '</span>';
      });
      out = out.replace(/_{2,}/g, '<span class="blank" style="min-width:7em"></span>')
        .replace(/＿{2,}/g, '<span class="blank" style="min-width:7em"></span>');
      return out;
    };
    return String(s).split(/(<svg[\s\S]*?<\/svg>)/gi).map(seg => /^<svg/i.test(seg) ? seg : conv(seg)).join('');
  };
  /* ---------- 作答契约（2026-10-25 用户报障三连的制度化） ----------
     用户原话：「M0066 答案好像不全」「M0011 在图上写出答案，所以组卷时这类题目不需要再留答题区」
     「M0084 给出的下横线长度根本不够写答案」。三件事同一个根：**题干里的"空"从来没被当成数据**。
     现在卡片带三个契约字段（工具侧 `_作答门禁.mjs` 是唯一写入入口）：
       answerMode   blank（答案进横线）| figure（写在/画在图上，不留答题区）| zone（另留答题区）| none（选择/判断）
       answerSlots  逐空答案，顺序＝卷面顺序；条数由工具数题干空位对账
       answerScope  full（缺省）| partial（合卡只考部分空，配 answerSlotsAt + answerNote）
     ⚠ 这里的空位解析与 Node 侧 `src/tools/_空位.mjs` **必须逐字同判**（前端不能 import ESM）。
        `tests/neg-answer-slot-contract.cjs` 的 P 段把全库题干同时喂两份实现逐卡对拍，分叉即红。 */

  /* 空位解析：① <span class="blank">  ② 编号横线 ____3____（算一个空）  ③ ASCII 下划线串  ④ 全角＿串；
     SVG 内部不算空。★ 2026-10-25：编号横线必须整体算一个空——早一版把两段各算一个，
     "8 空的完形"被数成 16 空，工单/答案册全跟着错（子代理填报时实测报回）。 */
  M.SVG_RE = /<svg[\s\S]*?<\/svg>/gi;
  /* 空位 span 识别：class 里含**独立 token `blank`** 才算。
     ⚠ 2026-10-25 实测踩到：早一版 `<span class="blank"[^>]*>` 会把空位内部编号标签
     `<span class="blank-no">3</span>` 也当成一个空位，8 空渲染后又被数成 16 空。 */
  M.BLANK_SPAN_RE = /<\s*span\b([^>]*)>/gi;
  /* ★ 2026-10-31（codex C03，已实测复现）：class 属性必须认**三种合法写法**
     —— 双引号 / 单引号 / 无引号。旧实现只认双引号，于是 `class='blank'` 在门禁里数到 0 个空，
     而净化器（M.filterAttrs 按 HTML 规则认三种、并统一重写）渲染出 1 个空位
     ⇒ 纸面出现一个没登记答案的空位，门禁却是绿的。
     与 Node 侧 `_空位.mjs` 的 ATTR_CLASS_RE/classValOf **逐字同判**（P 段对拍）。 */
  M.ATTR_CLASS_RE = /class\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
  M.classValOf = function (attrs) {
    const m = M.ATTR_CLASS_RE.exec(String(attrs || ''));
    if (!m) return null;
    return m[1] != null ? m[1] : (m[2] != null ? m[2] : m[3]);
  };
  M.hasBlankClass = function (attrs) {
    const v = M.classValOf(attrs);
    return v != null && v.split(/\s+/).indexOf('blank') >= 0;
  };
  M.NUMBERED_UNDERSCORE_RE = /(?:_{2,}|＿{2,})\s*[0-9０-９]{1,3}\s*(?:_{2,}|＿{2,})/g;
  M.UNDERSCORE_RE = /_{2,}|＿{2,}/g;
  M._widthOfTag = function (tag) {
    const m = /style\s*=\s*"[^"]*?\bwidth\s*:\s*([\d.]+)\s*(em|px|mm|%)?/i.exec(String(tag || ''));
    if (!m) return null;
    const v = parseFloat(m[1]); const u = String(m[2] || 'em').toLowerCase();
    if (!isFinite(v)) return null;
    if (u === 'px') return Math.round(v / 16 * 100) / 100;
    if (u === 'mm') return Math.round(v / 4 * 100) / 100;
    if (u === '%') return null;
    return Math.round(v * 100) / 100;
  };
  M.slotsOf = function (html) {
    const src = String(html == null ? '' : html).replace(M.SVG_RE, s => ' '.repeat(s.length));
    const hits = [];
    let m;
    M.BLANK_SPAN_RE.lastIndex = 0;
    while ((m = M.BLANK_SPAN_RE.exec(src))) {
      if (!M.hasBlankClass(m[1])) continue;
      hits.push({ i: m.index, len: m[0].length, kind: 'span', width: M._widthOfTag(m[0]) });
    }
    const numbered = [];
    M.NUMBERED_UNDERSCORE_RE.lastIndex = 0;
    while ((m = M.NUMBERED_UNDERSCORE_RE.exec(src))) {
      numbered.push([m.index, m.index + m[0].length]);
      hits.push({ i: m.index, len: m[0].length, kind: 'raw', width: null });
    }
    const inNumbered = i => numbered.some(([a, b]) => i >= a && i < b);
    M.UNDERSCORE_RE.lastIndex = 0;
    while ((m = M.UNDERSCORE_RE.exec(src))) {
      if (hits.some(h => m.index >= h.i && m.index < h.i + h.len && h.kind === 'span')) continue;
      if (inNumbered(m.index)) continue;
      hits.push({ i: m.index, len: m[0].length, kind: 'raw', width: null });
    }
    hits.sort((a, b) => a.i - b.i);
    return hits.map((h, i) => ({ i: i, kind: h.kind, width: h.width, start: h.i, end: h.i + h.len }));
  };
  M.slotCount = html => M.slotsOf(html).length;
  /* 答案要几 em（宁可偏宽——偏窄正是 M0084 的投诉） */
  M.FULLWIDTH_RE = /[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef\u2200-\u22ff\u2190-\u21ff\u00b1\u00d7\u00f7\u2212\u2260]/;
  M.needEm = function (answer) {
    const s = String(answer == null ? '' : answer);
    if (!s) return 0;
    let w = 0;
    for (const ch of s) {
      if (M.FULLWIDTH_RE.test(ch)) w += 1;
      else if (ch === ' ') w += 0.35;
      else if (/[A-Za-z0-9]/.test(ch)) w += 0.58;
      else if (/[\u0300-\u036f]/.test(ch)) w += 0;
      else w += 0.45;
    }
    return Math.round(Math.min(40, Math.max(0, w + 1.2)) * 100) / 100;
  };
  /* 与 Node 侧 _空位.mjs BLANK_MAX_EM 同值（18em ≈ 72mm：答案本身超过它就不该塞横线，该改 zone；
     改一处必须改两处，tests 的 P 段逐卡对拍） */
  M.BLANK_MAX_EM = 18;
  /* ★ 2026-10-25 二次报障（用户原话，语文默写 Y0003 行路难默写）：
     「给出的横线明显不够写答案…… 再考虑到小孩子写字不规矩，你再放一个 1.5 倍的带下横线的
      空格出来，这才是合理的出题方式」。
     上一版撑到 needEm 就收工 = 成人字迹刚好写满（Y0003：8.2em / 7 字 = 5.2mm 一格），
     孩子一落笔就挤出线外。现在横线至少 = needEm × CHILD_FACTOR(1.5)，
     并夹在 BLANK_MAX_WIDTH_EM(30em ≈ 132mm) 之内（A4 可用宽 178mm，再宽就换行/溢出纸面）。
     与 Node 侧 blankWidthEm / CHILD_FACTOR / BLANK_MAX_WIDTH_EM 逐字同判。 */
  M.CHILD_FACTOR = 1.5;
  M.BLANK_MAX_WIDTH_EM = 30;
  M.blankWidthEm = function (answer) {
    const need = M.needEm(answer);
    if (!need) return 0;
    return Math.round(Math.min(M.BLANK_MAX_WIDTH_EM, need * M.CHILD_FACTOR) * 100) / 100;
  };
  /* 逐空答案（只对 full 作用；partial 用 answerSlotsAt 定位，不能按序号硬套） */
  M.slotAnswers = function (card) {
    const c = card || {};
    const arr = Array.isArray(c.answerSlots) ? c.answerSlots : null;
    if (!arr) return null;
    return arr.map(v => (v == null ? '' : String(v)));
  };
  /* 把逐空答案摊平成"与空位等长"的数组（partial 靠 answerSlotsAt 定位到第几空）。
     ★ 2026-10-25 实测踩到：partial 合卡里 answers[0] 是第 5 空的答案，而 applySlotWidths
       按下标往第 1 空上套 ⇒ 该宽的第 5 空没撑、不该宽的第 1 空被撑开，纸面照旧写不下。
       未登记答案的空位留 undefined（applySlotWidths 见到 undefined 保持原宽，绝不瞎撑）。 */
  M.slotAnswersAligned = function (card, slotCount) {
    const list = M.slotAnswers(card);
    if (!list) return null;
    const c = card || {};
    const n = Math.max(0, Number(slotCount) || 0);
    const at = Array.isArray(c.answerSlotsAt) ? c.answerSlotsAt.map(Number) : null;
    const partial = String(c.answerScope || '') === 'partial';
    const nums = partial && at && at.length ? at : null;
    if (!nums) return list.slice(0, n || list.length);
    const out = new Array(n);
    list.forEach((a, k) => {
      const pos = (nums[k] || 0) - 1;
      if (pos >= 0 && pos < n) out[pos] = a;
    });
    return out;
  };
  /* 把每个空撑到够宽（渲染唯一实现；与 _空位.mjs applySlotWidths 同判） */
  M.applySlotWidths = function (html, answers, opts) {
    const o = Object.assign({ fallbackEm: 7, minEm: 4 }, opts || {});
    const list = Array.isArray(answers) ? answers : [];
    const slots = M.slotsOf(html);
    if (!slots.length) return html;
    let out = String(html);
    for (let k = slots.length - 1; k >= 0; k--) {
      const s = slots[k];
      const raw = out.slice(s.start, s.end);
      const ans = list[k];
      /* ★ 2026-10-25：宽度取 M.blankWidthEm（= needEm × 1.5 的小孩书写余量），不再取 needEm。
         见 M.CHILD_FACTOR 段（用户 Y0003 原话「再放一个 1.5 倍的带下横线的空格出来」）。
         ★ 当晚补：物理上限要连**声明宽度**一起夹——早期按答案撑宽把 39.2em（≈173mm）写进了题干，
           那条横线本身就撑出纸面（全库终检抓到 6 处），而"原有宽度是下限"会把它原样保留。
           与 _空位.mjs applySlotWidths 同判（测试 P2 逐字对拍）。 */
      const width = Math.round(Math.min(M.BLANK_MAX_WIDTH_EM,
        (ans == null || String(ans) === '')
          ? (s.width == null ? o.fallbackEm : s.width)
          : Math.max(o.minEm, s.width == null ? 0 : s.width, M.blankWidthEm(ans))) * 100) / 100;
      const w = width + 'em';
      /* ⚠ 2026-10-25：标签必须**规范化输出**（class 在前、min-width 写在 style 内）。
         原因：盲解清稿的 stemToText 用 `<span class="blank"[^>]*>` 还原空位，属性顺序一变
         就还原失败 ⇒ 纯净文本变 ⇒ 盲解指纹失效（Node 侧早期版本踩过，5 张语文卡当场失效）。
         这里与 src/tools/_空位.mjs 的 rewrite() 逐字同判（tests 的 P 段逐卡对拍）。 */
      let tag;
      if (s.kind === 'span') {
        const mm = /^<span\b([^>]*)>/i.exec(raw || '');
        if (!mm) tag = raw;
        else {
          let attrs = mm[1];
          /* ★ 2026-10-31（codex C03）：class 三种写法都要摘掉再按统一形态重建（与 node 侧 rewrite 同判）。 */
          const clsVal = M.classValOf(attrs);
          attrs = attrs.replace(M.ATTR_CLASS_RE, '');
          const st = /style\s*=\s*"([^"]*)"/i.exec(attrs);
          let styleVal;
          if (st) {
            styleVal = st[1];
            if (/\bmin-width\s*:/i.test(styleVal)) styleVal = styleVal.replace(/\bmin-width\s*:\s*[\d.]+\s*(em|px|mm)?/i, 'min-width:' + w);
            else styleVal = 'min-width:' + w + ';' + styleVal;
            attrs = attrs.replace(/style\s*=\s*"[^"]*"/i, '');
          } else styleVal = 'min-width:' + w;
          const rest = attrs.trim();
          tag = '<span' + (clsVal != null ? ' class="' + clsVal + '"' : ' class="blank"') + ' style="' + styleVal + '"' + (rest ? ' ' + rest : '') + '>';
        }
      } else tag = '<span class="blank" style="min-width:' + w + '"></span>';
      out = out.slice(0, s.start) + tag + out.slice(s.end);
    }
    return out;
  };
  /* 题干出口的统一收尾：填空转换 + 按声明答案撑宽（partial 先按 answerSlotsAt 摊平） */
  M.stemFit = function (html, card) {
    let out = M.stemBlankify(html);
    const ans = M.slotAnswersAligned(card, M.slotCount(out));
    if (ans && ans.length) out = M.applySlotWidths(out, ans);
    return out;
  };

  /* ══════════════════════════════════════════════════════════════════════════
     CSS / SVG 值安全（2026-10-30 审计 S04 的唯一实现）
     ══════════════════════════════════════════════════════════════════════════
     缺陷（两个变体，同一个根因）：
       ① style 的判据是"在**原文**里找字面 `url(`"，而 CSS 允许反斜杠转义：
          `u\72l(`、`\75rl(`、`\000075 rl(` 解析后都是 url()（Edge 的 getComputedStyle
          实测会把它当远程 URL 去取）⇒ 判据比的是**写法**，浏览器执行的是**解析结果**。
       ② fill/stroke/marker-* 等 SVG 呈现属性**整条原值直通**：`fill="url(https://…)"`
          （SVG 的 paint 值本来就是 url() 的合法用法，指向远程图片）⇒ 题面一渲染就出网。
     修法：先把 CSS 转义还原成字符，再对**归一化后的值**判危险形态；URL 型值一律拒绝
     （本库的题干样式只有布局用途：width/display/text-align/max-width…，没有一条合法题干
     需要 url()，所以"一律拒"不会误伤存量）；SVG 的 URL 型属性另立一条白名单：
     none / 颜色值 / url(#本地id)。
     ⚠ 判据表只有一份（M.CSS_DANGER_RE），style 与 SVG paint 共用 —— 两处各写一份必然漂移。 */

  /* CSS 反斜杠转义 → 字符：十六进制形态最多 6 位、其后**一个**空白被吃掉（CSS 规范）；
     其余 `\<字符>` 取字符本身（`\\` → `\` 也走这条）。 */
  M.cssUnescape = function (v) {
    return String(v == null ? '' : v)
      .replace(/\\([0-9a-fA-F]{1,6})\s?/g, (m, hex) => {
        const cp = parseInt(hex, 16);
        if (!(cp > 0 && cp <= 0x10ffff)) return '';        // \0 / 越界码点：CSS 里本就无意义，直接丢
        return String.fromCodePoint(cp);
      })
      .replace(/\\([\s\S])/g, '$1');
  };
  /* 危险函数/值的唯一判据表：URL 型一律拒（含 ie 时代的 expression / behavior / -moz-binding） */
  M.CSS_DANGER_RE = /url\s*\(|image-set\s*\(|@import|expression\s*\(|-moz-binding|\bbehaviou?r\s*:|javascript\s*:|vbscript\s*:/i;
  /* style 值是否安全（true = 可保留）。顺序：先还原转义，再剥注释 ——
     注释剥离在 CSS 里发生在分词**之前**，所以"把 url 拆成两半"的写法同样会被还原出来：
     在 url 的两个字母之间插一段 CSS 注释，归一化后仍然是 url( （第三种攻击写法）。 */
  M.styleSafe = function (raw) {
    const s = M.cssUnescape(raw).replace(/\/\*[\s\S]*?\*\//g, '');
    return !M.CSS_DANGER_RE.test(s);
  };
  /* SVG 里"值可以是 URL"的呈现属性。白名单内当前可达的是 fill/stroke/marker-*；
     clip-path/mask/filter 暂时不在 STEM_ATTRS 里，列进来是为了将来放开时不必再想一遍
     （它们若被放行，这条判据必须已经生效，否则就是第二个 fill 漏洞）。 */
  M.PAINT_ATTRS = ['fill', 'stroke', 'marker-start', 'marker-mid', 'marker-end', 'clip-path', 'mask', 'filter'];
  /* SVG 呈现属性值是否安全：只认 none / 颜色 / 本地 #id 引用，其余（含远程 url()）一律拒 */
  M.paintSafe = function (raw) {
    const s = M.cssUnescape(raw).trim();
    if (!s) return true;
    if (/^(?:none|currentcolor|transparent|inherit|initial|unset|context-fill|context-stroke)$/i.test(s)) return true;
    if (/^#[0-9a-f]{3,8}$/i.test(s)) return true;                       // #f00 / #00ff00 / #aabbccdd
    if (/^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\([^()]*\)$/i.test(s)) return true;  // 颜色函数
    if (/^[a-z]+$/i.test(s)) return true;                               // 命名颜色（red / steelblue …）
    /* 唯一允许的 url()：本地 #id 引用（题干里 pattern / marker 都是这个用法）；
       末尾允许一个 fallback 颜色（`url(#p1) none` 是 SVG 的合法写法）。
       ⚠ `#` 后面**不限字符集**（只排除引号/括号/空白）：题干里 id 可能是中文（`url(#图案)`），
         写窄成 ASCII 会把存量的纹理填充整块拒掉 —— 那是把安全修复变成版面回归。 */
    if (/^url\s*\(\s*(['"]?)#[^()'"\s]+['"]?\s*\)(?:\s+(?:none|#[0-9a-f]{3,8}|[a-z]+))?$/i.test(s)) return true;
    return false;
  };

  /* 属性级白名单（`on*` 一律剔除；src 重写到卡片目录；style / SVG paint 值过 URL 型判据） */
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
        /* ★ 2026-10-30（S04）：判据换成 M.styleSafe —— CSS 转义归一化后再判、URL 型一律拒。
           旧判据只在原文里找字面 url(，`u\72l(` 这类写法整条漏过（见本文件 M.CSS_DANGER_RE 段）。 */
        if (!M.styleSafe(v)) continue;
      } else if (M.PAINT_ATTRS.indexOf(name) >= 0) {
        /* ★ 2026-10-30（S04）：fill/stroke/marker-* 的 URL 型值同罪（远程 url() 一渲染就出网）。
           只丢这个属性，元素与图形本身保留 —— 颜色坏了大不了黑白，整块图没了题就不可解。 */
        if (!M.paintSafe(v)) continue;
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
  M.origOf = function (x) {
    const c = M.cardOf(x);              // 形状统一（2026-10-25 D-063）
    return {
      orig: c && c.origPage ? H.relPath(c.origPage) : null,
      origImport: c && c.origImport ? H.relPath(c.origImport) : null,
      origBox: (c && c.origBox && c.origBox.length === 4) ? c.origBox : null,
      origBy: (c && c.origBy) || null,
    };
  };
})();
