/* 错题本 2.0 · 基础工具（全局命名空间 CTB） */
window.CTB = window.CTB || {};
(function () {
  const U = CTB.util = {};

  /* ---- HTML 转义（所有动态文本必须过 esc，防注入错文里出现的 < & 等） ---- */
  U.esc = s => (s == null ? '' : String(s))
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  /* ---- DOM：轻量创建（字符串模板路线为主，这里只兜复杂交互节点） ---- */
  U.h = function (tag, attrs, inner) {
    const el = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'class') el.className = attrs[k];
      else if (k.startsWith('on') && typeof attrs[k] === 'function') el.addEventListener(k.slice(2), attrs[k]);
      else if (k === 'html') el.innerHTML = attrs[k];
      else if (k === 'text') el.textContent = attrs[k];
      else if (attrs[k] != null) el.setAttribute(k, attrs[k]);
    }
    if (inner != null) el.innerHTML = inner;
    return el;
  };
  U.$ = sel => document.querySelector(sel);
  U.$id = id => document.getElementById(id);

  /* ---- 路径（**唯一实现**）：索引里的 img/stem/md/origPage/evidence 是百分号编码形态，
     host.relPath 与 model 侧算「卡片目录」都走这里；禁止各写一份（此前 host.relPath 与
     bank.js 的 relPathTmp 已经是一份实现的两个门面，不要再长出第三份）。 ---- */
  U.decPath = function (rel) {
    if (rel == null || rel === '') return '';
    try { return decodeURIComponent(String(rel).replace(/^\.?\//, '')); } catch (e) { return String(rel); }
  };

  /* ---- 日期 ---- */
  U.dstr = d => { d = d instanceof Date ? d : new Date(d); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  U.today = () => U.dstr(new Date());
  U.addDays = (ds, n) => { const x = new Date(ds + 'T00:00:00'); x.setDate(x.getDate() + n); return U.dstr(x); };
  /* ⚠ 2026-10-11（F-11）：此前 `new Date(a + 'T00:00:00')` 对非法值产 NaN——
     `'2026/10/11'`/`'2026-13-45'` → NaN（首页显示「最长逾期 NaN 天」、待办显示「挂起 NaN 天」），
     `20261011`/`{}` → `String(123)` 后拼串 → 更会直接抛 TypeError 把整个视图打成「渲染出错」。
     现在：只认 YYYY-MM-DD（工具侧 nextDue/raisedAt 的唯一形态），其它一律返回 **null**（不是 NaN、不抛）。 */
  U.parseDay = function (ds) {
    if (typeof ds !== 'string') return null;
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(ds.trim());
    if (!m) return null;
    const y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const t = Date.UTC(y, mo - 1, d), back = new Date(t);
    if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
    return t;
  };
  U.diffDays = function (a, b) {
    const da = U.parseDay(a), db = U.parseDay(b == null ? U.today() : b);
    if (da == null || db == null) return null;
    return Math.round((db - da) / 864e5);
  };
  U.fmtMd = ds => (typeof ds === 'string' && ds) ? ds.slice(5).replace('-', '/') : '—';
  U.weekLabel = ds => { const d = new Date(ds + 'T00:00:00'); const w = '日一二三四五六'[d.getDay()]; return w; };
  /* 天数的人话（null=日期非法，不写成 NaN 也不写成 0） */
  U.daysText = n => (n == null ? '日期非法' : n + ' 天');

  /* ---- 存储（localStorage 只做「未同步的临时台账」，磁盘真源在工具侧） ---- */
  U.lsGet = (k, dft) => { try { const v = localStorage.getItem(k); return v == null ? dft : JSON.parse(v); } catch (e) { return dft; } };
  U.lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } };
  U.lsDel = k => { try { localStorage.removeItem(k); } catch (e) { } };

  /* ---- misc ---- */
  U.clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  U.pct = (a, b) => b ? Math.round(a / b * 100) : 0;
  U.debounce = (fn, ms) => { let t; return function () { clearTimeout(t); const a = arguments, s = this; t = setTimeout(() => fn.apply(s, a), ms); }; };
  U.uid = p => p + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  U.count = (arr, fn) => { const m = {}; for (const x of arr) { const k = fn(x); if (k == null) continue; m[k] = (m[k] || 0) + 1; } return m; };
  U.sortEntries = (m, dir) => Object.entries(m).sort((a, b) => dir === 'asc' ? a[1] - b[1] : b[1] - a[1]);
  /* 简易模糊匹配（命令面板/搜索）：子序列 + 前缀加权 */
  U.fuzzy = function (q, text) {
    q = q.toLowerCase(); text = (text || '').toLowerCase();
    if (!q) return 0;
    const direct = text.indexOf(q);
    if (direct >= 0) return 1000 - direct;
    let qi = 0, score = 0, gap = 0;
    for (let ti = 0; ti < text.length && qi < q.length; ti++) {
      if (text[ti] === q[qi]) { score += 10 - Math.min(9, gap); qi++; gap = 0; } else if (qi > 0) gap++;
    }
    return qi === q.length ? score : -1;
  };
  /* 学科色：tokens 里预置，未预置学科按名称哈希派生 hue */
  U.sjColor = function (name) {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--sj-' + name);
    if (v && v.trim()) return v.trim();
    let h = 0; for (const ch of name) h = (h * 31 + ch.codePointAt(0)) % 360;
    return 'hsl(' + h + ' 58% 46%)';
  };
})();
