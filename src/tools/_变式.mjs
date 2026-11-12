#!/usr/bin/env node
/**
 * 拾光小册 · 变式题 Phase 1：库内检索变式（零模型）
 *
 * 权威规格：v1 冻结树 docs\调研-变式题工作流-20261011.md §7 + §9 Phase 1（2026-10-11）。
 *   Phase 1 只做「检索」不做「生成」：候选 = 库内既有的、与源卡共享考点的其它卡——
 *   它们本就是带复习状态/盲解结论的真卡，检索不产生任何新题面（先做"不产生新题面"的，
 *   生成式属 Phase 2+，见调研 §9 排序原则；多空题档 2 的 kc/variantOf 字段族另行合并设计）。
 *
 * 子命令：
 *   资格 [--data <库根>] [--json]
 *       全库劝退类普查计数（回归护栏：图形卡/语文英语/S4/错因未确认/多问整题各类可计算；
 *       计数随库变化是常态，异常清零/膨胀要人工看）。
 *   检索 --for <卡ID> [--student <学生>] [--subject <学科>] [--limit N] [--data <库根>] [--json]
 *       给源卡找"同考点异题"候选。七条候选门禁（Phase 1 规格原文）：
 *         ① 候选同 student；② blindStatus∈{已通过,已修正}；③ difficulty 不升 2 档；
 *         ④ 候选在结果内唯一；⑤ causeConfirmed===true；⑥ S4 不检索；⑦ 检索结果不落
 *         _变式台账.json（台账不存在也不得报错）——本工具全程只读，⑦ 结构性满足。
 *   --selftest
 *       纯函数自证（门禁逐条/排序确定性/难度档），不读库。
 *
 * 本工具的两条口径决定（施工方案 §四 记录在案）：
 *   · ① 收紧为「同学生且同学科」：考点词表按学科建（_词表.md），跨学科同名标签属巧合；
 *   · ⑥ 双侧：源卡 S4 直接拒绝检索（抄写笔误无方法可迁移），候选卡 S4 一律排除；
 *   · ③ 实现为 易(0)<中(1)<难(2)，候选档 − 源档 ≤ 1（更易不限；缺档按入库默认「中」）。
 *
 * 确定性：`检索 --json` 两次调用逐字节相同（Phase 1 验收断言①）——
 *   输出不含时间戳/随机数，排序键全量给出（共享考点数 → 同错因码 → 编号 → 目录名）。
 * 隐私：只输出元数据（编号/考点/难度/状态），不输出题干、学生作答与错因描述。
 * 同构声明：indexFiles / itemsOfJson / isFigureCard 与 _盲解复核.mjs 同构（那边导入期持锁，
 *   不能直接 import）。⚠ 无机械对拍：tests\verify-variant-retrieval.cjs 只验本工具自身行为，
 *   不比两份实现——改动枚举/排除规则必须**人工两处同步**（review 2026-11-09 Minor③）。
 * 权威规格定位：v1 冻结树（外部只读树，不在本仓 tracked）的 docs\调研-变式题工作流-20261011.md
 *   的 §7（检索）与 §9 Phase 1（七条门禁原文出处）。冻结树=仓库上一级目录下与运行区并列的
 *   「错题本-冻结-20261024」目录（README 三区模型所称冻结区；本机路径不写入 tracked 文件）。
 */
import fs from 'fs';
import path from 'path';
import { parseArgs, COMMON_VALUE_FLAGS } from './_参数.mjs';
import { libraryRoot } from './_库根.mjs';
import { readJsonStrict } from './_安全写.mjs';
import { indexFiles } from './_题库发现.mjs';

/* ---------- 参数（--data 必须在任何 libraryRoot() 之前落 env，与全仓同口径） ---------- */
const { action, opt } = parseArgs(process.argv.slice(2), {
  valueFlags: [...COMMON_VALUE_FLAGS, 'for', 'limit'],
  boolFlags: ['json', 'selftest'],
});
if (opt.data) process.env.CTB_DATA = path.resolve(String(opt.data));
const ROOT = opt.selftest ? null : libraryRoot();
const asJson = !!opt.json;
const fail = msg => { console.error('[变式] ' + msg); process.exit(2); };
const usage = () => {
  console.log([
    '用法：node _变式.mjs <动作> [参数]',
    '  资格    [--data <库根>] [--json]                    全库劝退类普查计数',
    '  检索    --for <卡ID> [--student <学生>] [--subject <学科>] [--limit N] [--data <库根>] [--json]',
    '          给源卡找同考点异题候选（七条门禁，确定性排序，默认上限 2 张）',
    '  --selftest                                          纯函数自证（不读库）',
  ].join('\n'));
};

/* ---------- 与 _盲解复核.mjs 同构的只读枚举（两处同步纪律见文件头） ---------- */
const IDX_SHAPE = j => Array.isArray(j.items) || (!!j.subjects && typeof j.subjects === 'object' && !Array.isArray(j.subjects));
const readIndexFile = p => readJsonStrict(p, { shape: IDX_SHAPE, what: 'items 数组或 subjects 对象', label: path.basename(p) });
/* 2026-11-12（审计 F05）：本函数已收敛到 `_题库发现.mjs`（零副作用共享模块）。
   原先 8 个工具各抄一份，实测 3 种实现（本文件那份与 SB 口径不同）⇒ 改一处漏一处且各自测试全绿。 */
function itemsOfJson(j, base) {
  const out = [];
  if (Array.isArray(j.items)) {
    for (const it of j.items) out.push({ item: it, subject: j.subject || '', student: j.student, dirAbs: path.join(base, it.dir) });
  }
  if (j.subjects) {
    for (const [name, v] of Object.entries(j.subjects)) {
      for (const it of (v.items || [])) out.push({ item: it, subject: name, student: j.student, dirAbs: path.join(base, name, it.dir) });
    }
  }
  return out;
}
function allItems(root) {
  const a = [];
  for (const f of indexFiles(root)) {
    const base = path.dirname(f);
    for (const x of itemsOfJson(readIndexFile(f), base)) a.push({ ...x, file: f });
  }
  return a;
}
function isFigureCard(dirAbs) {
  const hp = path.join(dirAbs, '题干.html');
  if (fs.existsSync(hp)) {
    const h = fs.readFileSync(hp, 'utf8');
    if (/<svg[\s\S]*?<\/svg>/i.test(h) || /<img\b/i.test(h)) return true;
  }
  return fs.existsSync(path.join(dirAbs, '题图.jpg'));
}

/* ---------- 纯函数（--selftest 与测试直接钉这里） ---------- */
const DIFF_RANK = { '易': 0, '中': 1, '难': 2 };
const diffRank = d => (d in DIFF_RANK ? DIFF_RANK[d] : DIFF_RANK['中']);   // 缺档=入库默认「中」
const VERIFIED_BLIND = ['已通过', '已修正'];
const MULTI_PART_RE = /[(（]\s*[1１一]\s*[)）]/;   // 调研 §8：一问整题粗筛（下限口径）
const intersect = (a, b) => {
  const bs = new Set(b || []);
  return (a || []).filter(x => bs.has(x));
};
/** 检索候选七条门禁（除⑦结构性满足）。返回 null=通过，否则返回拒绝原因（短码）。
 *  入参兼容两种形态：allItems 的包装对象 {item,student,subject,dirAbs} 与裸卡对象（selftest）。
 *  ⚠ 身份字段（student/subject）住在**包装层**：真库 _索引.json 的 item 里没有这两个字段
 *  （学生与学生级 subjects 名都在文件层）——2026-11-09 首版只读 item ⇒ 跨学生卡静默过闸，
 *  被 tests\verify-variant-retrieval.cjs 当场抓住。判据：包装层优先，裸卡兜底。 */
export function candidateRejectReason(src, cand) {
  const si = src.item || src, ci = cand.item || cand;
  const sStudent = src.student || si.student, cStudent = cand.student || ci.student;
  const sSubject = src.subject || si.subject, cSubject = cand.subject || ci.subject;
  if (String(ci.id) === String(si.id) && cStudent === sStudent) return 'self';
  /* 口径①（同学生且同学科）在这里是**决定**，不是可关的默认——2026-11-09 review 摘除死旋钮 ctx */
  if (cStudent !== sStudent || cSubject !== sSubject) return 'g1';
  if (!VERIFIED_BLIND.includes(String(ci.blindStatus || ''))) return 'g2';
  if (diffRank(ci.difficulty) - diffRank(si.difficulty) > 1) return 'g3';
  if (ci.causeConfirmed !== true) return 'g5';
  if (String(ci.causeCode || '').trim().toUpperCase() === 'S4') return 'g6';
  if (String(ci.status || '') !== '在册') return 'arch';
  if (!intersect(si.kpoints, ci.kpoints).length) return 'kpoints';
  return null;
}
/** 确定性排序键：共享考点数降序 → 同错因码优先 → 编号升序 → 目录名升序（全量给出，无并列歧义）。 */
export function sortCandidates(src, cands) {
  const sKp = (src.item || src).kpoints || [];
  const sCode = String((src.item || src).causeCode || '');
  return cands.slice().sort((a, b) => {
    const ai = a.item || a, bi = b.item || b;
    const ka = intersect(sKp, ai.kpoints).length, kb = intersect(sKp, bi.kpoints).length;
    if (kb !== ka) return kb - ka;
    const ca = String(ai.causeCode || '') === sCode ? 1 : 0;
    const cb = String(bi.causeCode || '') === sCode ? 1 : 0;
    if (cb !== ca) return cb - ca;
    const ia = String(ai.id || '').localeCompare(String(bi.id || ''), 'zh');
    if (ia !== 0) return ia;
    return String(ai.dir || '').localeCompare(String(bi.dir || ''), 'zh');
  });
}
export const isMultiPart = q => MULTI_PART_RE.test(String(q || ''));

/* ---------- 资格普查 ---------- */
function census(root) {
  const items = allItems(root);
  const figCache = new Map();
  const fig = it => {
    if (!figCache.has(it.dirAbs)) figCache.set(it.dirAbs, isFigureCard(it.dirAbs));
    return figCache.get(it.dirAbs);
  };
  const inBook = items.filter(x => String(x.item.status || '') === '在册');
  const classes = { figure: 0, langCNEN: 0, s4: 0, causeUnconfirmed: 0, multiPart: 0 };
  for (const x of items) {
    const it = x.item;
    if (fig(x)) classes.figure++;
    if (x.subject === '语文' || x.subject === '英语') classes.langCNEN++;
    if (String(it.causeCode || '').trim().toUpperCase() === 'S4') classes.s4++;
    if (it.causeConfirmed !== true) classes.causeUnconfirmed++;
    if (isMultiPart(it.question)) classes.multiPart++;
  }
  /* 检索覆盖：在册卡里有多少张能找到 ≥1 个候选（七条门禁全开）。O(N²)，N=452 时 ~0.2s 量级。 */
  let withCandidate = 0;
  for (const s of items) {
    if (String(s.item.status || '') !== '在册') continue;
    if (String(s.item.causeCode || '').trim().toUpperCase() === 'S4') continue;
    if (!(s.item.kpoints || []).length) continue;
    const hit = items.some(c => c !== s && candidateRejectReason(s, c) === null);
    if (hit) withCandidate++;
  }
  return { action: '资格', total: items.length, inBook: inBook.length, classes, coverage: { withCandidate, ofInBook: inBook.length } };
}

/* ---------- 检索 ---------- */
function retrieve(root) {
  if (!opt.for) fail('检索需要 --for <卡ID>（例：--for M0027）');
  const forId = String(opt.for).trim().toUpperCase();
  const items = allItems(root);
  let matches = items.filter(x => String(x.item.id || '').trim().toUpperCase() === forId);
  if (opt.student) matches = matches.filter(x => x.student === String(opt.student).trim());
  if (opt.subject) matches = matches.filter(x => x.subject === String(opt.subject).trim());
  if (!matches.length) fail('找不到卡：' + forId + (opt.student ? '（学生 ' + opt.student + '）' : '') + '——先用 题库/台账 核对编号；跨学生重号时用 --student 显式指名');
  /* 消歧：键=学生|学科|编号。跨学生/跨学科重号 → 要求 --student/--subject；
     同键多**卡目录**（同生同学同编号落到两个 dir）属数据异常，也响亮拒绝（review 2026-11-09 Nit⑦），
     绝不静默取第一张。 */
  const byKey = new Map();
  for (const m of matches) {
    const k = m.student + '|' + m.subject + '|' + forId;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(m);
  }
  if (byKey.size > 1) {
    fail('编号 ' + forId + ' 命中 ' + matches.length + ' 张卡（' + [...byKey.keys()].map(k => k.replace('|' + forId, '')).join('、') + '）——跨学生/跨学科歧义必须用 --student（与 --subject）显式指名，绝不静默取第一张');
  }
  const group = [...byKey.values()][0];
  const dirs = new Set(group.map(m => String(m.item.dir || '')));
  if (dirs.size > 1) {
    fail('编号 ' + forId + ' 在同一学生·学科下落在 ' + dirs.size + ' 个卡目录（' + [...dirs].join('、') + '）——索引数据异常，人工核对后再来');
  }
  const src = group[0];
  const sIt = src.item;
  if (String(sIt.status || '') !== '在册') fail('源卡不在册（status=' + String(sIt.status || '空') + '）：撤卡/归档的题不做变式检索');
  if (String(sIt.causeCode || '').trim().toUpperCase() === 'S4') {
    fail('源卡错因为 S4（抄写笔误）：错因与理解无关，没有方法可迁移，不做变式检索（调研 §8 劝退③）');
  }
  const excluded = {};
  const cands = [];
  for (const c of items) {
    /* 传包装对象（身份字段在包装层，见 candidateRejectReason 注）；裸卡形态只出现在 selftest。 */
    const why = candidateRejectReason(src, c);
    if (why) { excluded[why] = (excluded[why] || 0) + 1; continue; }
    cands.push(c);
  }
  const sorted = sortCandidates(src, cands);
  let limit = 2;
  if (opt.limit !== undefined) {
    limit = Number(String(opt.limit));
    /* 失败必须可见：非数字/非正整数显式拒绝，绝不静默回落默认（review 2026-11-09 Nit④） */
    if (!Number.isInteger(limit) || limit < 1) fail('--limit 必须是 ≥1 的整数（收到：' + opt.limit + '）');
    if (limit > 10) limit = 10;                     // 剂量上限：调研 §4「每题 1~2 道」的工程护栏
  }
  const picked = sorted.slice(0, limit);
  const itemOf = w => w.item || w;
  const sharedOf = w => intersect(sIt.kpoints, itemOf(w).kpoints || []);
  const source = {
    id: sIt.id, student: src.student, subject: src.subject,
    difficulty: sIt.difficulty || '', causeCode: sIt.causeCode || '',
    kpoints: (sIt.kpoints || []).slice(),
  };
  const candidates = picked.map(w => {
    const c = itemOf(w);
    return {
      id: c.id, student: src.student, subject: src.subject, dir: String(c.dir || ''),
      difficulty: c.difficulty || '', causeCode: c.causeCode || '', blindStatus: c.blindStatus || '',
      reviewStatus: c.reviewStatus || '', errorCount: c.errorCount || 0,
      sharedKpoints: sharedOf(w).slice(), via: '库内检索',
    };
  });
  return {
    action: '检索', source, count: candidates.length,
    pool: { scanned: items.length, passed: sorted.length },
    excludedByGate: excluded,
    note: 'Phase 1 库内检索：候选是既有真卡，练习请走 组卷/复习流 常规入口（检索结果不落任何台账）',
    candidates,
  };
}

/* ---------- 输出 ---------- */
function printCensus(r) {
  console.log('变式资格普查（劝退类计数，口径=调研 §8；计数随库变化是常态）：');
  console.log('  全库 ' + r.total + ' 卡（在册 ' + r.inBook + '）');
  console.log('  图形卡 ' + r.classes.figure + ' ｜ 语文/英语 ' + r.classes.langCNEN + ' ｜ S4 抄写笔误 ' + r.classes.s4 +
    ' ｜ 错因未确认 ' + r.classes.causeUnconfirmed + ' ｜ 多问整题(下限) ' + r.classes.multiPart);
  console.log('  检索覆盖（在册且能找到 ≥1 候选）：' + r.coverage.withCandidate + '/' + r.coverage.ofInBook);
}
function printRetrieval(r) {
  const s = r.source;
  console.log('源卡 ' + s.id + '（' + s.student + '·' + s.subject + '，难度 ' + (s.difficulty || '中') + '，考点：' + (s.kpoints.join('、') || '无') + '）');
  console.log('候选池：扫 ' + r.pool.scanned + ' 卡 → 过七条门禁 ' + r.pool.passed + ' 张 → 取前 ' + r.count + '（--limit 可调，上限 10）');
  const ex = Object.entries(r.excludedByGate).filter(([, n]) => n > 0).map(([k, n]) => k + '=' + n).join(' ｜ ');
  if (ex) console.log('门禁排除：' + ex);
  if (!r.candidates.length) {
    console.log('候选 0 张——本卡考点在同学科范围内没有满足门禁的异题（缺盲解/未确认错因/无共享考点都常见）。这不是故障，是库现状。');
    return;
  }
  for (const c of r.candidates) {
    console.log('  ▸ ' + c.id + '（难度 ' + (c.difficulty || '中') + '，共享考点：' + c.sharedKpoints.join('、') +
      '，盲解 ' + c.blindStatus + '，已错 ' + c.errorCount + ' 次）← ' + c.dir);
  }
  console.log('提示：' + r.note);
}

/* ---------- 自证 ---------- */
function selftest() {
  const mk = (id, o) => Object.assign({ id, student: '学生甲', subject: '数学', status: '在册', difficulty: '中', causeCode: 'K1', causeConfirmed: true, blindStatus: '已通过', kpoints: ['考A'], reviewStatus: '未复习', errorCount: 1, dir: id }, o);
  const src = mk('M0001', { kpoints: ['考A', '考B'] });
  let n = 0;
  const ok = (cond, name) => { if (!cond) { console.error('selftest FAIL: ' + name); process.exit(1); } n++; };
  ok(candidateRejectReason(src, mk('M0002', {})) === null, '同科同生同考点过闸');
  ok(candidateRejectReason(src, mk('M0002', { student: '学生乙' })) === 'g1', 'g1 跨学生拒');
  ok(candidateRejectReason(src, mk('M0002', { subject: '物理' })) === 'g1', 'g1 跨学科拒');
  ok(candidateRejectReason(src, mk('M0002', { blindStatus: '不一致' })) === 'g2', 'g2 盲解未过拒');
  ok(candidateRejectReason(src, mk('M0002', { blindStatus: '已修正' })) === null, 'g2 已修正过闸');
  ok(candidateRejectReason(mk('M0001', { difficulty: '易' }), mk('M0002', { difficulty: '难' })) === 'g3', 'g3 难度+2 拒（易→难）');
  ok(candidateRejectReason(src, mk('M0002', { difficulty: '难' })) === null, '难度+1 过闸（中→难，规格允许）');
  ok(candidateRejectReason(mk('M0001', { difficulty: '易' }), mk('M0002', { difficulty: '难', kpoints: [] })) === 'g3', 'g3 先于考点判');
  ok(candidateRejectReason(src, mk('M0002', { causeConfirmed: false })) === 'g5', 'g5 错因未确认拒');
  ok(candidateRejectReason(src, mk('M0002', { causeCode: 'S4' })) === 'g6', 'g6 候选 S4 拒');
  ok(candidateRejectReason(src, mk('M0002', { status: '已归档' })) === 'arch', 'arch 非在册拒');
  ok(candidateRejectReason(src, mk('M0001', {})) === 'self', '自身排除');
  const cands = [mk('M0003', { kpoints: ['考A'] }), mk('M0002', { kpoints: ['考A', '考B'], causeCode: 'K1' }), mk('M0004', { kpoints: ['考A'], causeCode: 'K9' })];
  const sorted = sortCandidates(src, cands);
  ok(sorted.map(x => x.id).join(',') === 'M0002,M0003,M0004', '排序：共享数→同错因→编号');
  const again = sortCandidates(src, cands.slice().reverse());
  ok(JSON.stringify(again.map(x => x.id)) === JSON.stringify(sorted.map(x => x.id)), '排序与输入顺序无关（确定性）');
  ok(isMultiPart('已知 x，求 y 的值。') === false, '多问正则不误伤无小问标号的题');
  ok(isMultiPart('已知x，(一)求y') === true, '多问正则命中（一）');
  ok(isMultiPart('已知x，(1)求y') === true, '多问正则命中 (1)');
  console.log('selftest ok：' + n + ' assertions');
}

/* ---------- 主入口 ---------- */
if (opt.selftest) { selftest(); process.exit(0); }
if (!action || action === '帮助' || action === 'help') { usage(); process.exit(action ? 0 : 2); }
if (action === '资格') {
  const r = census(ROOT);
  if (asJson) console.log(JSON.stringify(r)); else printCensus(r);
  process.exit(0);
}
if (action === '检索') {
  const r = retrieve(ROOT);
  if (asJson) console.log(JSON.stringify(r)); else printRetrieval(r);
  process.exit(0);
}
usage();
fail('未知动作：' + action);
