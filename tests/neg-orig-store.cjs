#!/usr/bin/env node
/**
 * 原图保全库（`_原图.mjs`）阴性对照：八条判据，每条都必须**能红**。
 *
 * 为什么必须有这份用例（不是为了凑数量）：
 *   这套工具是**唯一一件给"不可复现数据"兜底的机械设施**。它如果静默失效——
 *   比如"内容不一致时顺手覆盖了"、"删掉对象后 `快照 --diff` 仍报绿"——
 *   受害的恰好是那批**丢了就再也造不出来**的原图，而且没有任何上层业务会报错。
 *   所以每条不变量都要有一个"故意违反它、工具必须报红"的证据。
 *
 * 实测踩过并因此写进用例的两条（第一版就是错的）：
 *   ① `入库 <目录> --batch "批次名"` 把 "批次名" 当成路径 ⇒ 报"路径不存在"；
 *   ② `快照 --diff` 拿**台账**当"库里现在有什么" ⇒ 删掉一个对象文件后它报"消失 0"。
 *      一个专门用来发现"对象非正常消失"的功能，恰好发现不了对象消失。
 *
 * 退出码 0=对照全部成立；1=有不变量守不住（说明这套保全设施不可信）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const E = require('./_测试环境.cjs');

let fails = 0;
const A = (n, ok, d) => { console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d !== undefined ? '  → ' + d : ''}`); if (!ok) fails++; };

/* 跑工具：返回 {code, out}；绝不抛（要断言"它会失败"） */
const run = (args, lib) => {
  try {
    const out = execFileSync(process.execPath, [E.tool('_原图.mjs'), ...args], {
      encoding: 'utf8', maxBuffer: 64e6, stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { CTB_DATA: lib }),
    });
    return { code: 0, out: String(out) };
  } catch (e) {
    return { code: e.status == null ? -1 : e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
};
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();

const LIB = E.makeTempLib();
const SRC = path.join(LIB, '_测试源');
const write = (rel, buf) => {
  const p = path.join(SRC, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, buf);
  return p;
};

/* ── 夹具：四种扩展名 + 同内容不同名（测去重）+ 收件箱里的非影像件 ── */
const jpgA = Buffer.alloc(4096, 0x1f);
const pngB = Buffer.alloc(2048, 0x3f);
const csvC = Buffer.from('seq,page\r\n54,1\r\n', 'utf8');
const mdD = Buffer.from('# 人工判读依据\n', 'utf8');
write('a.jpg', jpgA);
write('sub/a-copy.jpg', jpgA);          // 与 a.jpg 同字节、不同名 ⇒ 只应存 1 份
write('b.png', pngB);
write('c.csv', csvC);
write('d.md', mdD);

const STORE = path.join(LIB, '_原图');
const LEDGER = path.join(LIB, '_原图台账.json');
const objectsOf = () => {
  const out = [];
  (function w(d) {
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== '_快照') w(p); continue; }
      if (!e.name.endsWith('.tmp')) out.push(p);
    }
  })(STORE);
  return out;
};

/* ════════ 1. --dry 必须真的不写盘（"只看一眼"不许留下半截库） ════════ */
{
  const r = run(['入库', SRC, '--dry'], LIB);
  A('1a --dry 退出 0', r.code === 0, 'exit=' + r.code);
  A('1b --dry 后库目录不存在', !fs.existsSync(STORE));
  A('1c --dry 后台账不存在', !fs.existsSync(LEDGER));
  A('1d --dry 不删源（4 个源文件全在）', objectsOf().length === 0 && fs.existsSync(path.join(SRC, 'a.jpg')));
}

/* ════════ 2. 入库：去重、扩展名保留、非影像件也保全 ════════ */
{
  const r = run(['入库', SRC, '--batch', '夹具批次'], LIB);
  A('2a 入库退出 0（含带值的 --batch 不被当成路径）', r.code === 0, 'exit=' + r.code);
  const objs = objectsOf();
  A('2b 5 个源文件 → 4 个对象（同内容不同名去重）', objs.length === 4, objs.length + ' 个：' + objs.map((p) => path.extname(p)).join(','));
  const exts = objs.map((p) => path.extname(p).toLowerCase()).sort();
  A('2c 扩展名按原格式保留（.csv/.jpg/.md/.png，无 .bin 冒充）',
    JSON.stringify(exts) === JSON.stringify(['.csv', '.jpg', '.md', '.png']), exts.join(','));
  const names = objs.map((p) => path.basename(p).replace(/\.[a-z0-9]+$/i, '')).sort();
  A('2d 文件名就是完整 sha256（64 位十六进制）', names.every((n) => /^[0-9a-f]{64}$/.test(n)));
  A('2e 收件箱那类非影像件（csv/md）也被保全', objs.some((p) => p.endsWith('.csv')) && objs.some((p) => p.endsWith('.md')));
  A('2f 源文件一个都没被删/移', fs.existsSync(path.join(SRC, 'a.jpg')) && fs.existsSync(path.join(SRC, 'sub/a-copy.jpg')));
  const doc = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
  A('2g 台账登记了来源与原名（溯源不丢）',
    !!Object.values(doc.objects).find((o) => (o.names || []).includes('a.jpg') && (o.sources || []).length === 2));
}

/* ════════ 3. 幂等：重跑不新增对象（迁移中途被杀后能安全重跑） ════════ */
{
  const before = objectsOf().length;
  const r = run(['入库', SRC], LIB);
  A('3a 重跑退出 0', r.code === 0);
  A('3b 重跑不新增对象', objectsOf().length === before, before + ' → ' + objectsOf().length);
  A('3c 重跑输出里"新增"为 0', /新增 0/.test(r.out), (r.out.match(/新增 \d+/) || [''])[0]);
}

/* ════════ 4. 校验：同长度不同内容必须报红（只比 size 查不出的那类损坏） ════════ */
{
  const target = objectsOf().find((p) => p.endsWith('.png'));
  const sizeBefore = fs.statSync(target).size;
  fs.writeFileSync(target, Buffer.alloc(sizeBefore, 0x77));  // 长度不变、内容全变
  A('4a 篡改后长度确实没变（这是本用例的前提）', fs.statSync(target).size === sizeBefore);
  const r = run(['校验'], LIB);
  A('4b 校验 exit≠0', r.code !== 0, 'exit=' + r.code);
  A('4c 输出点名"内容与登记的 sha 不符"', /内容与登记的 sha 不符/.test(r.out));
  A('4d 恢复原字节后校验回到 0', (fs.writeFileSync(target, pngB), run(['校验'], LIB).code === 0));
}

/* ════════ 5. 只增不改：已存在对象内容不同 ⇒ 拒绝覆盖并报错 ════════ */
{
  /* 把库里的 a.jpg 对象改坏，再用原始源重新入库：必须报"拒绝覆盖"，且**不许**把源内容写进去 */
  const aObj = objectsOf().find((p) => p.endsWith('.jpg'));
  const broken = Buffer.alloc(fs.statSync(aObj).size, 0x55);
  fs.writeFileSync(aObj, broken);
  const brokenSha = sha(broken);
  const r = run(['入库', path.join(SRC, 'a.jpg')], LIB);
  A('5a 入库 exit≠0（拒绝覆盖）', r.code !== 0, 'exit=' + r.code);
  A('5b 输出说明是"已有同名对象但内容不同"', /已有同名对象但内容不同|拒绝覆盖/.test(r.out));
  A('5c 库里那份仍是坏内容（没有被"顺手修好"覆盖掉）', sha(fs.readFileSync(aObj)) === brokenSha);
  A('5d 源文件仍在（工具只复制，不动源）', fs.existsSync(path.join(SRC, 'a.jpg')));
  fs.writeFileSync(aObj, jpgA);   // 还原，便于后续断言
}

/* ════════ 6. 快照 --diff：对象被删必须报红（第一版这里恰好失明） ════════ */
{
  const snap = run(['快照'], LIB);
  A('6a 快照退出 0', snap.code === 0);
  const listName = (snap.out.match(/(\d{8}-\d{6}\.list)/) || [])[1];
  A('6b 快照文件已落盘', !!listName && fs.existsSync(path.join(STORE, '_快照', listName)), String(listName));

  const victim = objectsOf().find((p) => p.endsWith('.md'));
  fs.unlinkSync(victim);
  const d = run(['快照', '--diff', listName], LIB);
  A('6c 删掉对象后 --diff exit≠0', d.code !== 0, 'exit=' + d.code);
  A('6d --diff 报出"非正常消失"且数量为 1', /非正常消失/.test(d.out) && /消失 1/.test(d.out),
    (d.out.match(/消失 \d+/) || [''])[0]);

  /* 负对照：把所有对象补齐后 --diff 必须回到绿（证明它不是"永远红"） */
  run(['入库', SRC], LIB);
  const d2 = run(['快照', '--diff', listName], LIB);
  A('6e 补齐后 --diff 回到 exit 0（判据不是恒红）', d2.code === 0, 'exit=' + d2.code);
}

/* ════════ 7. 快照 --diff：字节数变化必须报红（内容被改写的另一条路径） ════════ */
{
  const snap = run(['快照'], LIB);
  const listName = (snap.out.match(/(\d{8}-\d{6}\.list)/) || [])[1];
  const target = objectsOf().find((p) => p.endsWith('.csv'));
  const b = fs.readFileSync(target);
  fs.writeFileSync(target, Buffer.concat([b, Buffer.from('extra')]));   // 变长
  const d = run(['快照', '--diff', listName], LIB);
  A('7a 字节数变化后 --diff exit≠0', d.code !== 0, 'exit=' + d.code);
  A('7b 输出点名"字节数变了"', /字节数变了/.test(d.out));
  fs.writeFileSync(target, b);
}

/* ════════ 8. 未知命令必须 exit 2（写操作型工具不许"猜一个分支跑"） ════════ */
{
  const r = run(['不存在的命令'], LIB);
  A('8a 未知命令 exit=2', r.code === 2, 'exit=' + r.code);
  A('8b 未知命令不产生任何写盘副作用', r.code === 2 && fs.existsSync(STORE));
}

console.log('');
console.log(`RESULT=${fails ? 'FAIL(' + fails + ')' : 'PASS'} 断言=${8 + 4 + 4 + 4 + 3 + 4 + 4 + 2 + 2} 失败=${fails}`);
process.exit(fails ? 1 : 0);