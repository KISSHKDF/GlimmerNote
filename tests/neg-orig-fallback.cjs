#!/usr/bin/env node
/**
 * 原图兜底寻址（`_原图寻址.mjs`）阴性对照：六组判据，每条都必须**能红**。
 *
 * 为什么必须有它（不是为了凑数量）：
 *   这条链解决的是"**清空收件箱不会让任何一张卡断链**"。它一旦静默失效——
 *   比如"路径没了就悄悄返回空"（界面按钮变灰但没人知道为什么）、
 *   或"按路径猜一个对象交差"（张冠李戴，卡面显示成另一张卷子）——
 *   受害的正是那批**丢了就再也造不出来**的原图。
 *   所以每条不变量都要有一个"故意违反它、必须报红/必须报错"的证据。
 *
 * 实测踩过并因此写进用例的：
 *   第一版 `快照 --diff` 拿**台账**当"库里现在有什么" ⇒ 删掉一个对象它报"消失 0"；
 *   一个专门发现"对象非正常消失"的功能，恰好发现不了对象消失。
 *   本用例守住同族的另一个面：**兜底不能靠猜**。
 *
 * 退出码 0=对照全部成立；1=有不变量守不住（说明兜底不可信）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const E = require('./_测试环境.cjs');

let fails = 0;
const A = (n, ok, d) => { console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d !== undefined ? '  → ' + d : ''}`); if (!ok) fails++; };

/* 跑工具：返回 {code, out}；绝不抛（要断言"它会失败"）
   ⚠ args 的**第一个元素是工具文件名**，其余是它的参数。
   这里必须 `E.tool(args[0])` 单独取，**不能** `E.tool(...args)` ——
   那会把参数也当成工具名拼进路径（实测 exit 2 + ENOENT）。 */
const run = (args, lib) => {
  try {
    const out = execFileSync(process.execPath, [E.tool(args[0]), ...args.slice(1)], {
      encoding: 'utf8', maxBuffer: 64e6, stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { CTB_DATA: lib }),
    });
    return { code: 0, out: String(out) };
  } catch (e) {
    return { code: e.status == null ? -1 : e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
};

const LIB = E.makeTempLib();
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const IMGB = Buffer.alloc(4096, 0x4b);
const SHA = sha256(IMGB);
const INBOX_REL = '_收件箱/批次1/p01.jpg';
const INBOX_ABS = path.join(LIB, '_收件箱', '批次1', 'p01.jpg');
const CARD_DIR = path.join(LIB, '学生A', '数学', 'M0001-测试');

const mk = (rel, buf) => {
  const p = path.join(LIB, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, buf);
  return p;
};
const writeJson = (rel, obj) => {
  const p = path.join(LIB, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 1), 'utf8');
  return p;
};

/* ── 夹具：一张原图，摆在收件箱里（这样入库时 sources 会记下它）── */
mk(INBOX_REL, IMGB);
mk('学生A/数学/M0001-测试/原卷截图.jpg', Buffer.alloc(100, 9));
mk('学生A/数学/M0001-测试/错题记录.md', '# 夹具\n');
writeJson('学生A/数学/_索引.json', {
  student: '学生A', grade: '七年级', subject: '数学',
  items: [{ id: 'M0001', dir: 'M0001-测试', title: '测试题', question: 'q', answer: 'a' }],
});
/* 台账：page / import 都指向收件箱里那份。
   ⚠ **必须并入**而不是覆盖：`makeTempLib()` 复制过来的合成库里已有若干张卡，
   覆盖整个台账会让门禁报「台账里有索引已无的卡」——那是夹具自己造出来的假红，
   混进被测判据里就分不清"门禁真的红了"和"夹具没配好"。 */
{
  const lp = path.join(LIB, '_原卷台账.json');
  const led = fs.existsSync(lp) ? JSON.parse(fs.readFileSync(lp, 'utf8').replace(/^\uFEFF/, '')) : { version: 1, cards: {} };
  led.cards = led.cards || {};
  led.cards['学生A|M0001'] = {
    key: '学生A|M0001', student: '学生A', subject: '数学',
    cardDir: '学生A/数学/M0001-测试', source: '夹具',
    page: INBOX_REL, import: INBOX_REL, box: [0.1, 0.2, 0.5, 0.3],
    by: '手工', note: '阴性对照夹具',
  };
  fs.writeFileSync(lp, JSON.stringify(led, null, 1), 'utf8');
}

/* ════════ 1. 入库：内容寻址 + 来源登记 ════════ */
{
  const r = run(['_原图.mjs', '入库', path.join(LIB, '_收件箱')], LIB);
  A('1a 入库退出 0', r.code === 0, 'exit=' + r.code);
  const led = JSON.parse(fs.readFileSync(path.join(LIB, '_原图台账.json'), 'utf8'));
  A('1b 台账登记了 sha', !!led.objects[SHA], Object.keys(led.objects).join(','));
  A('1c 登记的来源里有收件箱那条路径',
    (led.objects[SHA].sources || []).some(s => s.replace(/\\/g, '/') === INBOX_REL),
    JSON.stringify(led.objects[SHA].sources));
  const obj = path.join(LIB, '_原图', SHA.slice(0, 2).toLowerCase(), SHA.toLowerCase() + '.jpg');
  A('1d 对象按 sha 命名落盘', fs.existsSync(obj), path.basename(obj));
}

/* ════════ 2. 原路径还在 ⇒ 门禁里**我的那张卡**不报"整页不在盘"（走的是原路径，不是兜底） ════════
 * ⚠ 为什么只断言"我这张卡"：合成库里本来就有指向**未复制的影像**的旧条目
 *   （影像按设计不复制进副本库），它们报"整页不在盘"是**既有噪声**，不是本次要测的东西。
 *   把整门禁的 exit code 当判据会永远红（红的是别人的卡，不是被测行为）。 */
const MY = '学生A|M0001';
const myLine = (out) => (out.split(/\r?\n/).find(l => l.includes(MY)) || '');
{
  const r = run(['_原卷台账.mjs', '门禁'], LIB);
  A('2a 原路径在时，我这张卡不报"整页不在盘"', !/整页不在盘/.test(myLine(r.out)), myLine(r.out));
  A('2b 原路径在时，不出现"兜底"字样（说明走的是原路径）', !/兜底/.test(r.out));
  A('2c 门禁没把兜底当错误（输出里没有我这张卡的 ✗）', !/✗\s*学生A\|M0001/.test(r.out), (r.out.match(/✗\s*学生A\|M0001.*/) || [''])[0]);
}

/* ════════ 3. ★ 核心：原路径没了 ⇒ 按内容从保全库兜底，我这张卡**不再报整页不在盘** ════════ */
{
  fs.unlinkSync(INBOX_ABS);   // 模拟"清空收件箱"
  const r = run(['_原卷台账.mjs', '门禁'], LIB);
  A('3a 原路径失效后，我这张卡不再报"整页不在盘"', !/整页不在盘/.test(myLine(r.out)), myLine(r.out));
  A('3b 输出明说"已从保全库按内容兜底"', /已从保全库按内容兜底/.test(r.out));
  A('3c 明细里点名这张卡', r.out.includes(MY));
  A('3d 我这张卡没有被判成错误', !/✗\s*学生A\|M0001/.test(r.out), (r.out.match(/✗\s*学生A\|M0001.*/) || [''])[0]);
}

/* ════════ 4. 状态生成器：origPage 应指向保全库里的对象 ════════ */
{
  const r = run(['生成状态.mjs', '--out', '-', '--quiet'], LIB);
  A('4a 状态生成器退出 0', r.code === 0, 'exit=' + r.code);
  let st = null;
  try { st = JSON.parse(r.out.replace(/^\uFEFF/, '')); } catch { }
  A('4b 输出是合法 JSON', !!st);
  /* 只找**我这张卡**：状态包里卡片对象上没有 student 字段（它在学生层），
     所以按「父级学生名 + 卡 id」定位，别按卡对象里的 student 字段找。 */
  const find = (st) => {
    for (const d of (st.data || [])) {
      if (d.name !== '学生A') continue;
      for (const s of (d.subjects || [])) {
        for (const c of (s.items || [])) {
          if (c.id === 'M0001' && Object.prototype.hasOwnProperty.call(c, 'origPage')) return c;
        }
      }
    }
    return null;
  };
  const c = find(st);
  A('4c 我这张卡在状态包里（有 origPage 字段）', !!c);
  if (c) {
    A('4d origPage 指向保全库（路径含 _原图/）', decodeURIComponent(c.origPage || '').includes('_原图/'), decodeURIComponent(c.origPage || ''));
    A('4e origResolve 标成 store（明示这是兜底来的）', c.origResolve === 'store', String(c.origResolve));
  }
}

/* ════════ 5. ★ 反面：保全库里也没有 ⇒ **必须判红**（不许兜底成"没事"） ════════ */
{
  const obj = path.join(LIB, '_原图', SHA.slice(0, 2).toLowerCase(), SHA.toLowerCase() + '.jpg');
  fs.unlinkSync(obj);   // 现在字节真的没了
  const r = run(['_原卷台账.mjs', '门禁'], LIB);
  A('5a 字节真没了 ⇒ 门禁判红（exit≠0）', r.code !== 0, 'exit=' + r.code);
  A('5b 输出说清"真的断了"', /真的断了|不在盘/.test(r.out), (r.out.match(/.*(真的断了|整页不在盘).*/) || [''])[0]);
  A('5c 没有谎称"已兜底"', !/已从保全库按内容兜底/.test(r.out));
}

/* ════════ 6. ★ 绝不按路径猜：同一路径换成**别的内容** ⇒ 不得被当成同一张 ════════ */
{
  /* 重新入库**另一份内容**（同一个收件箱路径，但字节不同）：
     若实现是"按路径取对象"而不是"按内容核对"，就会张冠李戴。 */
  const OTHER = Buffer.alloc(4096, 0x99);
  const OTHER_SHA = sha256(OTHER);
  mk(INBOX_REL, OTHER);
  const ing = run(['_原图.mjs', '入库', INBOX_ABS], LIB);
  A('6a 另一份内容入库成功', ing.code === 0, 'exit=' + ing.code);
  const led = JSON.parse(fs.readFileSync(path.join(LIB, '_原图台账.json'), 'utf8'));
  A('6b 台账里是两个不同的 sha', Object.keys(led.objects).length === 2, Object.keys(led.objects).join(','));
  A('6c 两个 sha 内容确实不同', !!led.objects[SHA] && !!led.objects[OTHER_SHA] && SHA !== OTHER_SHA);
  const objOther = path.join(LIB, '_原图', OTHER_SHA.slice(0, 2).toLowerCase(), OTHER_SHA.toLowerCase() + '.jpg');
  A('6d 另一份的对象在盘上', fs.existsSync(objOther));
  /* 关键：台账 page 当初登记的内容（SHA）对应的对象**已经不存在**（第 5 段删了），
     而同路径上现在躺着**内容不同**的另一份（OTHER_SHA）。
     若实现不按内容核对，就会把 OTHER 那份顶替上来 ⇒ 门禁就不该绿。 */
  const r = run(['_原卷台账.mjs', '门禁'], LIB);
  A('6e 内容对不上的那份不许顶替 ⇒ 门禁判红', r.code !== 0, 'exit=' + r.code);
  A('6f 没有谎称"已兜底"', !/已从保全库按内容兜底/.test(r.out));
}

console.log('');
console.log(`RESULT=${fails ? 'FAIL(' + fails + ')' : 'PASS'} 断言=25 失败=${fails}`);
process.exit(fails ? 1 : 0);
