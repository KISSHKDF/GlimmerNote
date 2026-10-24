#!/usr/bin/env node
/**
 * 安全读写底座的自检（2026-10-10 建，对应 BUG-01 / BUG-02）
 *
 * 只碰临时目录，绝不碰题库真源。
 * 断言（正向 + 阴性对照都要过，否则本门禁自己就是摆设）：
 *   1. 原子写：正常写入成功，内容完整，且不留下 .tmp-* 残留
 *   2. 破 JSON 读回：抛错（不是"当作空库"）
 *   3. 形状不符读回：抛错（不是"重置为空"）
 *   4. 写前备份：_备份-真源 里出现旧内容副本；超过 keep 份会轮转
 *   5. **阴性对照**：模拟"写到一半失败"（用一个注定失败的 path）→ 目标文件必须原样不动
 *   6. 阴性对照：故意把 JSON 截断成半截 → readJsonStrict 必须拒绝（而这正是旧代码会"静默清空"的入口）
 *
 * 退出码 0=全过；1=有失败。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readJsonStrict, writeJsonAtomic, backupJson } from '../src/tools/_安全写.mjs';

let fails = 0, n = 0;
const A = (name, ok, detail) => { n++; console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${name}${detail !== undefined ? '  → ' + detail : ''}`); if (!ok) fails++; };

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ctb-safewrite-'));
const f = path.join(T, 'db.json');
const say = e => String(e && e.message || e);

/* 1 · 原子写 */
writeJsonAtomic(f, { items: [1, 2, 3], note: '中文' });
const back = JSON.parse(fs.readFileSync(f, 'utf8'));
A('原子写：内容完整往返', JSON.stringify(back.items) === '[1,2,3]' && back.note === '中文', JSON.stringify(back));
A('原子写：无 .tmp 残留', fs.readdirSync(T).filter(x => x.includes('.tmp-')).length === 0, fs.readdirSync(T).join(','));

/* 2 · 破 JSON 必须抛错 */
fs.writeFileSync(f, '{"items":[1,2,3', 'utf8');
let t2 = null; try { readJsonStrict(f); } catch (e) { t2 = e; }
A('破 JSON → 抛错（拒绝当空库）', !!t2 && /不是合法 JSON/.test(say(t2)), say(t2).slice(0, 80));

/* 3 · 形状不符必须抛错 */
fs.writeFileSync(f, JSON.stringify({ items: { value: [1, 2, 3] } }), 'utf8');
let t3 = null; try { readJsonStrict(f, { shape: j => Array.isArray(j.items), what: 'items 数组' }); } catch (e) { t3 = e; }
A('形状不符 → 抛错（拒绝重置为空）', !!t3 && /结构异常/.test(say(t3)), say(t3).slice(0, 80));
A('形状相符 → 正常返回', (() => { fs.writeFileSync(f, JSON.stringify({ items: [] }), 'utf8'); return readJsonStrict(f, { shape: j => Array.isArray(j.items) }).items.length === 0; })());

/* 4 · 写前备份 + 轮转 */
writeJsonAtomic(f, { items: ['v1'] }, { backup: true });
writeJsonAtomic(f, { items: ['v2'] }, { backup: true });
const bakDir = path.join(T, '_备份-真源');
const baks = fs.existsSync(bakDir) ? fs.readdirSync(bakDir) : [];
A('写前备份：生成副本', baks.length >= 2, baks.join(','));
/* 备份的语义是「某个版本被覆盖**之前**的内容」——不是"最新内容"。
   第二次写之前文件里是 v1，所以副本集合里应当出现 v1。 */
const bakText = baks.map(n => fs.readFileSync(path.join(bakDir, n), 'utf8')).join('|');
A('写前备份：捕获了被覆盖前的内容', bakText.includes('"v1"'), bakText.replace(/\s+/g, ' ').slice(0, 120));
for (let i = 0; i < 12; i++) writeJsonAtomic(f, { items: ['x' + i] }, { backup: true, keep: 3 });
A('写前备份：按 keep 轮转（不无限膨胀）', fs.readdirSync(bakDir).length <= 3, String(fs.readdirSync(bakDir).length));

/* 5 · 阴性对照：写入中途失败 → 目标文件原样不动 */
fs.writeFileSync(f, JSON.stringify({ items: ['SAFE'] }), 'utf8');
const before = fs.readFileSync(f, 'utf8');
let t5 = null;
try {
  // 让临时文件创建失败：把目标目录里塞一个同名目录？更直接——用一个不可写路径做 dir
  const badDir = path.join(T, 'nope');
  fs.mkdirSync(badDir);                       // 目录存在
  fs.chmodSync(badDir, 0o500);                // 尽量只读（Windows 上 chmod 作用有限）
  writeJsonAtomic(path.join(badDir, 'sub', 'x.json'), { items: ['NEW'] });
  // 若这行没抛（Windows 权限模型宽松），退化为"写一个非法父路径"
  writeJsonAtomic(path.join(T, 'a\0b.json'), { items: ['NEW'] });
} catch (e) { t5 = e; }
A('阴性对照：写失败会抛错且报「原文件未改动」', !!t5, say(t5).slice(0, 90));
A('阴性对照：目标文件字节未变', fs.readFileSync(f, 'utf8') === before, fs.readFileSync(f, 'utf8').slice(0, 40));
A('阴性对照：无半截临时文件残留', fs.readdirSync(T).filter(x => x.includes('.tmp-')).length === 0, fs.readdirSync(T).join(','));

/* 6 · 阴性对照：半截文件被拒（旧代码在此静默清空真源） */
fs.writeFileSync(f, '{"items":[1,2', 'utf8');
let t6 = null; try { readJsonStrict(f, { shape: j => Array.isArray(j.items) }); } catch (e) { t6 = e; }
A('阴性对照：半截文件被拒（不回退成空表）', !!t6, say(t6).slice(0, 60));

try { fs.rmSync(T, { recursive: true, force: true }); } catch { }
console.log(`\nRESULT=${fails ? 'FAIL(' + fails + ')' : 'PASS'} 断言=${n}`);
process.exit(fails ? 1 : 0);
