#!/usr/bin/env node
/**
 * BUG#1 回归（2026-10-23 用户实测）：空库里必须能新建学生。
 *          2026-10-24 改版（用户指正）：**新建学生不问学科**。
 *
 * 起因（用户原话「果然没有地方添加小孩的入口，这是第一个BUG」）：
 *   空库时界面全是空态，而"学生"只能靠手工往磁盘建目录 + 写 `_索引.json`。
 *   新用户进门第一件事就做不了 ⇒ 整个产品堵死。
 *
 * 改版原因（用户原话「新建学生不需要与学科挂勾的，要这个程序的人，肯定是每个学科都要录入错题的」）：
 *   学科不是"人"的属性，是"题"的属性。建学生时问学科，等于让用户为同一个孩子重复建好几次。
 *   现在只收 姓名（必填）+ 年级（可留空）；学科在录题时按需长出来。
 *
 * 本用例守四层（缺一层这个 BUG 就会以别的形式回来）：
 *   ① 工具层：能建出 `subjects:{}` 形态的学生索引；非法名/重名必须被拒；幂等且能补年级；
 *   ② 界面层：空库首页有「＋ 新建学生」、顶栏有常驻「＋」、表单里**没有学科下拉**；
 *   ③ 接线层：前端 → 壳 → 工具这条链真的连上；
 *   ④ 生成器层：这种"只有学生、没有卡"的索引必须能被 生成状态.mjs 认出来（否则界面永远 0 个孩子）。
 *
 * 只跑在**临时空目录**上（mkdtemp），真库零改动。
 * 退出码 0=通过；1=有断言红。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const E = require('./_测试环境.cjs');

let fails = 0, skips = 0, asserts = 0;
const A = (n, ok, d) => { asserts++; console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d !== undefined ? '  → ' + d : ''}`); if (!ok) fails++; };
const S = (n, why) => { skips++; console.log(`[SKIP] ${n}  → ${why}`); };

/* 空库（只有目录，没有任何索引）——这才是"新用户第一次打开"的真实形态 */
const LIB = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-newstu-'));
const toolEnv = Object.assign({}, process.env, { CTB_DATA: LIB });
const runTool = (name, args) => {
  try {
    const out = execFileSync(process.execPath, [E.tool(name), ...args], { encoding: 'utf8', maxBuffer: 32e6, env: toolEnv });
    return { code: 0, out: String(out) };
  } catch (e) { return { code: e.status == null ? -1 : e.status, out: String(e.stdout || ''), err: String(e.stderr || '') }; }
};
const 建学生 = (args) => runTool('_建学生.mjs', [...args, '--json']);

console.log('临时空库 =', LIB);

/* ---------- ① 工具层 ---------- */
console.log('\n══ ① 工具：_建学生.mjs（只收姓名+年级，不问学科）══');
{
  A('源码里不再有"缺少 --subject"的拒绝分支',
    !/缺少 --subject/.test(fs.readFileSync(E.tool('_建学生.mjs'), 'utf8')));

  const r = 建学生(['--name', '小明']);
  A('只给姓名就能建（年级可留空）', r.code === 0, (r.out || r.err || '').slice(0, 120));
  let j = null; try { j = JSON.parse(r.out.trim()); } catch { }
  A('返回 ok:true 且 grade 为空', !!j && j.ok === true && j.grade === '', r.out.trim().slice(0, 140));
  A('索引路径是 <姓名>/_索引.json（不带学科层）', !!j && /^小明\/_索引\.json$/.test(j.index || ''), j && j.index);

  const idxAbs = path.join(LIB, '小明', '_索引.json');
  A('索引文件真的落盘', fs.existsSync(idxAbs), idxAbs);
  if (fs.existsSync(idxAbs)) {
    const doc = JSON.parse(fs.readFileSync(idxAbs, 'utf8').replace(/^\uFEFF/, ''));
    A('索引是多学科形态（subjects 是空对象，不是 items 数组）',
      doc.student === '小明' && doc.subjects && typeof doc.subjects === 'object'
      && !Array.isArray(doc.subjects) && Object.keys(doc.subjects).length === 0,
      JSON.stringify({ student: doc.student, grade: doc.grade, subjects: doc.subjects }));
    A('索引里没有 subject 单值字段（不绑学科）', doc.subject === undefined, String(doc.subject));
  }

  /* 幂等 + 补年级 */
  const r2 = 建学生(['--name', '小明', '--grade', '七年级']);
  let j2 = null; try { j2 = JSON.parse(r2.out.trim()); } catch { }
  A('重复建同一个人 → 幂等不报错', r2.code === 0 && !!j2 && j2.existed === true, r2.out.trim().slice(0, 140));
  A('这次带了年级 → 顺手补上（updated:true）', !!j2 && j2.updated === true && j2.grade === '七年级',
    JSON.stringify(j2 && { updated: j2.updated, grade: j2.grade }));
  if (fs.existsSync(idxAbs)) {
    const doc = JSON.parse(fs.readFileSync(idxAbs, 'utf8').replace(/^\uFEFF/, ''));
    A('补年级后磁盘上的 grade 真的变了', doc.grade === '七年级', doc.grade);
    A('补年级没有动 subjects（不碰人家的题库）', doc.subjects && Object.keys(doc.subjects).length === 0, JSON.stringify(doc.subjects));
  }

  /* 两个人并存 */
  const r3 = 建学生(['--name', '小红', '--grade', '三年级']);
  A('第二个孩子也能建（互不影响）', r3.code === 0 && fs.existsSync(path.join(LIB, '小红', '_索引.json')), r3.out.trim().slice(0, 100));

  /* 重名必须拒：历史库里目录名是 <年级>-<姓名>，同名不同目录会让界面把两个身份合成一个。
     ⚠ 场景要选对：不能拿"已经有自己目录的孩子"来测 —— 那种情况会先命中"就是同一个孩子"的幂等分支。
     真实场景是：老库里只有 <七年级-小刚> 这种目录，此时再新建「小刚」必须拦。 */
  const clash = path.join(LIB, '七年级-小刚');
  fs.mkdirSync(clash, { recursive: true });
  fs.writeFileSync(path.join(clash, '_索引.json'), JSON.stringify({ student: '小刚', grade: '七年级', subjects: {} }), 'utf8');
  const r4 = 建学生(['--name', '小刚', '--grade', '七年级']);
  A('别处已有同名孩子 → 拒绝（exit 2）', r4.code === 2, 'exit=' + r4.code + ' ' + r4.out.trim().slice(0, 120));
  A('拒绝理由点名"同名"', /同名/.test(r4.out), r4.out.trim().slice(0, 130));
  A('被拒时没有在根目录下建出「小刚」', !fs.existsSync(path.join(LIB, '小刚')), path.join('小刚'));

  /* 非法名 */
  for (const [args, why] of [
    [['--name', 'a/b'], '姓名含 /'],
    [['--name', ''], '空姓名'],
    [['--name', '_隐藏'], '姓名以下划线开头（程序保留区）'],
    [['--name', '..'], '姓名是 ..'],
  ]) {
    const r5 = 建学生(args);
    A('拒绝：' + why, r5.code === 2, 'exit=' + r5.code + ' ' + r5.out.trim().slice(0, 90));
  }
}

/* ---------- ④ 生成器层：只有学生没有卡，也必须出现在状态包里 ---------- */
console.log('\n══ ④ 生成器：只有学生、没有卡也能认出来 ══');
{
  const g = runTool('生成状态.mjs', ['--quiet']);
  A('这种库上生成器能跑通（exit 0）', g.code === 0, 'exit=' + g.code + ' ' + String(g.err || '').slice(0, 120));
  const stPath = path.join(LIB, '_状态.json');
  A('状态包已生成', fs.existsSync(stPath), stPath);
  if (fs.existsSync(stPath)) {
    const st = JSON.parse(fs.readFileSync(stPath, 'utf8').replace(/^\uFEFF/, ''));
    const names = (st.data || []).map((k) => k.name);
    A('两个学生都在 data 里', names.includes('小明') && names.includes('小红'), JSON.stringify(names));
    const ming = (st.data || []).find((k) => k.name === '小明');
    A('学生的 subjects 为空数组（还没录题）', ming && Array.isArray(ming.subjects) && ming.subjects.length === 0,
      JSON.stringify(ming && ming.subjects));
    A('学生的 grade 带过去了', ming && ming.grade === '七年级', ming && ming.grade);
  }
}

/* ---------- ② 界面层 ---------- */
console.log('\n══ ② 界面：空库有入口，且表单不问学科 ══');
{
  /* 为什么不真渲染：dash/shell 依赖 DOM（document/window），无头装载要拖进 jsdom。
     这里做**源码级**断言；真正"点一下能不能开表单"由 e2e 交互穷举覆盖（它点遍所有 [data-a]）。 */
  const APP = path.join(E.REPO, 'src', 'app', 'js');
  const dashSrc = fs.readFileSync(path.join(APP, 'views', 'dash.js'), 'utf8');
  const shellSrc = fs.readFileSync(path.join(APP, 'shell.js'), 'utf8');

  A('dash 视图有「＋ 新建学生」按钮（data-a="newStu"）', /data-a="newStu"/.test(dashSrc));
  A('该按钮只在没有学生时出现（条件渲染）',
    /M\.students\(\)\.length\s*\?\s*''\s*:\s*'<button[^>]*data-a="newStu"/.test(dashSrc));
  A('data-a 分发挂了 newStu → S.newStudent()', /newStu\s*:\s*\(\)\s*=>\s*S\.newStudent\(\)/.test(dashSrc));
  A('顶栏学生分段旁有常驻「＋」（btnNewStu）', /id="btnNewStu"/.test(shellSrc));
  A('顶栏「＋」绑了 S.newStudent', /btnNewStu'\)[^\n]{0,90}S\.newStudent\(\)/.test(shellSrc));
  A('表里有姓名字段', /id="nsName"/.test(shellSrc));

  /* ★ 改版核心：不许再有学科下拉 */
  A('★ 表里**没有**学科下拉（nsSubj 不存在）', !/id="nsSubj"/.test(shellSrc), '存在则说明改版被回滚了');
  A('★ 提交时不再传 subject', !/createStudent\(\{\s*name,\s*grade,\s*subject/.test(shellSrc));
  A('年级下拉第一项是「（先不填）」（年级可留空）', /<option value="">（先不填）<\/option>/.test(shellSrc));
  A('文案说清了"不用选学科"', /不用选学科/.test(shellSrc));
  A('成功后切到新学生并重绘', /M\.student\(name\)/.test(shellSrc) && /M\.applyState\(/.test(shellSrc));
}

/* ---------- ③ 接线层 ---------- */
console.log('\n══ ③ 接线：前端 → 壳 → 工具 ══');
{
  const hostSrc = fs.readFileSync(path.join(E.REPO, 'src', 'app', 'js', 'host.js'), 'utf8');
  const csSrc = fs.readFileSync(path.join(E.REPO, 'src', 'shell', 'CTBShellV2.cs'), 'utf8');
  A('host.js 暴露 H.createStudent', /H\.createStudent\s*=\s*(async\s*)?function/.test(hostSrc));
  A("host.js 走 bridge('createStudent')", /bridge\('createStudent'/.test(hostSrc));
  A('壳的 op 分发里有 createStudent', /op\s*==\s*"createStudent"/.test(csSrc));
  A('壳里 CreateStudent 真的调 _建学生.mjs', /CreateStudent\(string payload\)[\s\S]{0,900}?_建学生\.mjs/.test(csSrc));
  /* 从方法开头到重建之间隔着 args 列表 + RunNode + 正则，实测约 1100 字符；窗口给 2000 留余量 */
  A('建完会把新状态包一起返回（否则界面不刷新）',
    /CreateStudent\(string payload\)[\s\S]{0,2000}?(Rebuild\(\)|ReadState\(\))/.test(csSrc));
  A('工具文件存在', fs.existsSync(E.tool('_建学生.mjs')));
}

console.log(`\nRESULT=${fails ? 'FAIL(' + fails + ')' : 'PASS'} 断言=${asserts} 失败=${fails}` + (skips ? ` 跳过=${skips}` : ''));
console.log(`临时库（可手工核对）：${LIB}`);
process.exit(fails ? 1 : 0);
