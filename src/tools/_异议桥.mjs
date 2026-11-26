/**
 * 拾光小册 · 红字异议 → 待办工作台 派生桥（唯一实现，2026-11-14 立）
 *
 * 解决什么（2026-11-14 用户报障「教师异议待裁决，那应该推给我啊，可是待办工作台是干净的」）：
 *   卡上的 `teacherConflict`（红字与采用答案不一致）此前只有两个露出渠道：
 *     ① 题库抽屉里一行小字；② 组卷准入报错点名。
 *   没有任何通道把它推进待办工作台 ⇒ 未裁决异议会在库里"沉底"，
 *   复习屏横幅说"有 N 题被挡"，工作台却干净 —— 用户找不到该做什么。
 *
 * 设计（一份事实一个家）：
 *   · 异议事实**只住在卡上**（`_索引.json` 的 `teacherConflict`），本模块不落任何盘。
 *   · 待办工作台里的条目是**派生视图**：`生成状态.mjs`（全量）与 `_状态刷新.mjs`（pending 增量）
 *     在组装状态包时调 `deriveConflictTodos()`，把未裁决异议合成临时条目（id 前缀 XC-），
 *     与 `_待确认.json` 的真实条目（T 前缀）合并进 `pending.items`。
 *   · 异议裁决落库（`_标记复习.mjs 异议裁决`）→ 索引里 `teacherConflict.resolvedAt` 出现
 *     → 下一次状态包重建时派生条目自然消失 = **自动办结**，没有任何"办结动作"要人补。
 *
 * 为什么派生而不是写台账：
 *   ① 写台账 = 第二份事实，裁决后要同步作废，两处必须永远一致（同步逻辑必然漂移）；
 *   ② 写台账要动 `_待确认.json`（真源），派生不碰任何真源文件；
 *   ③ 条目的生命周期天然等于"异议未裁决"这一个事实，不需要人记着去关。
 *
 * 条目契约（与 `_待确认.mjs::pendingItemOut` 的形状对齐，字段少给不给 0）：
 *   id         'XC-' + 学生|卡号 的稳定散列前 8 位（同一次裁决前后 id 不变，界面锚点稳定）
 *   kind       '红字异议'（KINDS 两份拷贝已同步新增，tests\neg-reason-entry.cjs §0 钉住逐字相等）
 *   askWho     '系统'（裁决是 agent/我的活，不是问孩子/老师）
 *   derived    true —— 前端据此**不渲染**「确认办结/作废」按钮（那会写 T 台账、必失败）
 *
 * ⚠ 本文件必须保持**零副作用**（不解析 argv、不读库根、不写盘）——
 *   它被两个状态包写入方 import（同 `_来源.mjs` 的零副作用纪律，L-729）。
 */
import fs from 'fs';
import path from 'path';

/** 与 `_标记复习.mjs::teacherConflictOpen` 同口径：有冲突对象且没有 resolvedAt ⇒ 未裁决 */
const openConflict = it => !!(it && it.teacherConflict && typeof it.teacherConflict === 'object' && !it.teacherConflict.resolvedAt);

/** 卡片目录下两张候选卡面图里，真实存在的那张（**相对库根**的路径；都不在 ⇒ null）
 *
 *  ★ 2026-11-26 修（真实缺陷，e2e-ui 实测「灯箱带问题正文」红在 `no-img`）：
 *    改前两个错叠在一起 ⇒ **任何一张卡的证据图都找不到**：
 *      ① 用的是**相对路径**（`<学生>\M0077-…\原卷截图.jpg`）⇒ 拿 cwd 去 existsSync
 *         ⇒ 在仓库目录下永远是 false（库里根本没有这个相对路径）；
 *      ② **漏了学科层** ⇒ 真实布局是 `<库根>\<学生>\<学科>\<卡号-描述>\原卷截图.jpg`
 *         （实测 657 张卡里 305+ 张带学科层级），而它拼的是 `<库根>\<学生>\<卡号-描述>\…`。
 *    ⇒ 现在：拼**绝对路径**去找，但**返回相对库根**的路径。
 *
 *  ⚠ **分隔符必须用 `/`**（2026-11-26 实测）：`path.join` 在 Windows 上产出 `\`
 *    ⇒ 前端 `H.asset` 把它 encodeURI 成 `%5C` ⇒ `file://` URL 里反斜杠是**非法字符**
 *    ⇒ 图片必然加载失败（实测 ERR）。库里其它相对路径（`_录题` 的 `image.rel` 等）一律用 `/`，
 *    这里必须跟同一口径。
 */
function cardImageRel(root, stuDirRel, subject, dir) {
  /* 学科层可能有、也可能没有（老卡是 `<学生>\<卡号-描述>`）⇒ 两种都试 */
  const rels = [];
  if (subject) rels.push(path.join(stuDirRel, subject, dir));
  rels.push(path.join(stuDirRel, dir));
  for (const rel of rels) {
    for (const name of ['原卷截图.jpg', '题干.jpg']) {
      const full = path.join(root, rel, name);
      if (fs.existsSync(full)) return rel.split(path.sep).join('/') + '/' + name;
    }
  }
  return null;
}

/** 稳定短 id：同一条异议在多次生成之间拿到同一个 XC id（界面锚点 / 排序稳定） */
function xcId(student, cardId) {
  let h = 0;
  const s = String(student) + '|' + String(cardId);
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return 'XC-' + (h >>> 0).toString(36).padStart(7, '0').slice(0, 7);
}

/**
 * 扫全库索引，合成未裁决异议的派生待办条目。
 * @param {string} ROOT 库根
 * @returns {Array} 条目数组（可直接 concat 进 pending.items；无异议 ⇒ 空数组）
 */
export function deriveConflictTodos(ROOT) {
  const out = [];
  const base = ROOT;
  let ents;
  try { ents = fs.readdirSync(base, { withFileTypes: true }); } catch { return out; }
  for (const stu of ents) {
    if (!stu.isDirectory()) continue;
    if (stu.name.startsWith('_') || stu.name.startsWith('.')) continue;
    const stuDir = path.join(base, stu.name);
    /* 两种索引形态与 生成状态.mjs::cardsOf 同口径（多学科 / 单学科） */
    const idxPath = path.join(stuDir, '_索引.json');
    let idx;
    try { idx = JSON.parse(fs.readFileSync(idxPath, 'utf8').replace(/^\uFEFF/, '')); } catch { continue; }
    const multi = idx.subjects && typeof idx.subjects === 'object' && !Array.isArray(idx.subjects);
    const subjectNames = multi ? Object.keys(idx.subjects) : [idx.subject || stu.name];
    for (const sn of subjectNames) {
      const items = multi ? ((idx.subjects[sn] || {}).items || []) : (idx.items || []);
      for (const it of items) {
        if (!openConflict(it)) continue;
        const tc = it.teacherConflict;
        const imgRel = cardImageRel(base, stu.name, sn, String(it.dir || it.id || ''));
        const where = (it.source || '').slice(0, 40);
        out.push({
          id: xcId(idx.student || stu.name, it.id),
          student: idx.student || stu.name,
          subject: sn || '',
          cardId: it.id,
          kind: '红字异议',
          askWho: '系统',
          question: '卷面红字与这张卡采用的答案对不上（' + (sn || '该学科') + ' ' + it.id +
            (where ? '，' + where : '') + '）：要按独立来源裁决，还是把红字只记为参考？',
          detail: '红字：' + String(tc.teacher || '').slice(0, 120) +
            '　采用答案：' + String(tc.adopted || '').slice(0, 120) +
            (tc.note ? '　入库时的说明：' + String(tc.note).slice(0, 160) : '') +
            '　—— 裁决：node _标记复习.mjs 异议裁决 --student ' + (idx.student || stu.name) +
            ' --ids ' + it.id + ' --as 官方答案|红字参考 --note "依据"',
          source: '红字与采用答案不一致（自动推进，裁决后自动消失）',
          raisedAt: String(tc.at || '') || null,
          status: '未确认',
          evidence: imgRel || '',
          evidenceOk: imgRel ? fs.existsSync(path.join(base, imgRel)) : false,
          qRef: '',
          box: null,
          derived: true,
        });
      }
    }
  }
  return out;
}
