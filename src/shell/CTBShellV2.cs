// ============================================================================
// 错题本桌面壳（CTB Shell V2）— 正式版 2.0（2026-10-12 由试用转正，v1 已归档至 _archive\v1-20261012）
// 加载 file:///…/v2/index.html（v1 时代旧布局；现为 AppRoot\index.html）。
// 本目录自足：ctb.ico、wv2-sdk、运行库均在 _桌面v2 内，不再依赖 v1 的 _桌面\。
//
// 桥协议（JS 发 {id,op,payload}；壳回 {ctb:'resp',id,ok,data}；事件 {ctb:'evt'}）：
//   hello          → {version:"2.0"}
//   state          → _状态.json 原文（缺失触发全量重建）
//   regen          → 重跑 _生成首页.ps1，返回新状态包
//   pendingResolve → payload.resolves=[{id,action,answer}] → _待确认.mjs 同步 + 刷 pending → {ok,results,state}
//   pendingAdd     → payload 扁平字符串 → _待确认.mjs 加 + 刷 pending → {ok,newId,state,toolOut}
//   mark           → payload.action∈{组卷,批改,撤批,归档,撤归档,状态} + 扁平 flag → _标记复习.mjs → {ok,code,out,err}
//   recipe         → payload.action∈{清单,收件箱,组装,校验,自检,指纹} + 扁平 flag → _配方.mjs → {ok,code,out,err}
//                    （code 是工具的**真实退出码**：校验通过=0 / 拒收=1 / 参数错=2；2026-10-29 R2 修）
//   readFile       → payload.path（题库根内相对路径）→ {ok,text}
//   openFile       → payload.path → 交内置阅读器/系统程序 → {ok:true}
//   quit           → 退出
// 安全：只读/只跑「既有 CLI 工具」，壳自身不解析/改写任何 JSON 真源；mark/pending 全走唯一写入入口。
// ============================================================================
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace CTBShell2
{
    public class HostBridge
    {
        /* ════════════════════════════════════════════════════════════════════════
           ★ 2026-10-23 两个根分离（架构设计 §2.1）：程序与数据物理分开
              AppRoot  = exe 所在目录（程序：exe / dll / index.html / tools\）——只读
              DataRoot = 用户库（_状态.json 与各工具的真源）——可读可写
           老实现只有一个 Root，程序和数据都从它推导，于是连带四个死结：
             · 装进 Program Files 写不了；· 一份程序只能配一份数据；
             · 升级必须覆盖用户数据；· 靠「九年级 / 七年级-某某」这种目录名自证自己是题库根，
               陌生人换个名字就认不出来，然后掉进"上溯一级"的静默兜底，指向无关目录。
           现在：**两者永不互相推导** —— 程序文件只从 AppRoot 找，用户数据只从 DataRoot 读写。
           ════════════════════════════════════════════════════════════════════════ */

        /// <summary>程序目录 = exe 所在目录。只读，绝不往里写用户数据。</summary>
        public static readonly string AppRoot = ResolveAppRoot();

        /// <summary>用户库目录。所有写操作只落这里。</summary>
        public static readonly string DataRoot = ResolveDataRoot();

        static string ResolveAppRoot()
        {
            try { return Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory); }
            catch
            {
                try { return Path.GetFullPath(Path.GetDirectoryName(Application.ExecutablePath)); }
                catch { return "."; }
            }
        }

        /* DataRoot 优先级：CTB_DATA 环境变量 > AppRoot\..\数据 > AppRoot\数据 > AppRoot（老布局）。
           最后那条兜底是给"程序与数据还混在一个目录"的老库用的 —— 迁移期只读兼容，老库一行不改。 */
        static string ResolveDataRoot()
        {
            try
            {
                string env = Environment.GetEnvironmentVariable("CTB_DATA");
                if (!string.IsNullOrEmpty(env)) return Path.GetFullPath(env);
            }
            catch { }
            try
            {
                string up1 = Path.GetFullPath(Path.Combine(AppRoot, ".."));
                string cand = Path.Combine(up1, "数据");
                if (Directory.Exists(cand)) return cand;
                cand = Path.Combine(AppRoot, "数据");
                if (Directory.Exists(cand)) return cand;
            }
            catch { }
            return AppRoot;   // 老布局：程序与数据同目录
        }

        /* 工具脚本查找：返回**第一个存在的**；都不存在就返回新布局路径，让报错信息指向正确位置。
           三个候选（顺序即优先级）：
             ① <AppRoot>\tools\           发布包（运行区 app\tools\）
             ② <AppRoot>\..\tools\        开发区（<仓库>\src\app 的上一级 = <仓库>\src\tools\）
             ③ <DataRoot>\<文件名>         老布局（程序与数据同目录，工具散在库根）
           ★ 2026-10-23：补 ② 之前，开发态 AppRoot\tools 不存在 ⇒ 直接落到 ③，
             而当时 DataRoot 是冻结区，库根里正好躺着**旧工具副本** ⇒ 开发态一直"碰巧能跑"，
             实际执行的是冻结区 2026-10-16/21 的旧版工具（开发版是 10-23）。
             换成运行区库（纯数据、根目录无工具）后当场 Cannot find module。
             ② 与 _库根.mjs 的 TOOL_DIR 同口径（工具住在 <AppRoot>\tools 或 <仓库>\src\tools）。 */
        public static string ToolPath(string fileName)
        {
            try
            {
                string p = Path.Combine(AppRoot, "tools", fileName);
                if (File.Exists(p)) return p;
                p = Path.Combine(Path.GetFullPath(Path.Combine(AppRoot, "..")), "tools", fileName);
                if (File.Exists(p)) return p;
                p = Path.Combine(DataRoot, fileName);
                if (File.Exists(p)) return p;
            }
            catch { }
            return Path.Combine(AppRoot, "tools", fileName);
        }

        /// <summary>数据文件绝对路径（一律落在 DataRoot 内）。</summary>
        public static string DataPath(string fileName) { return Path.Combine(DataRoot, fileName); }

        /* 程序自己的临时数据（日志 / WebView2 用户数据 / 中转文件）→ %LOCALAPPDATA%\拾光小册\
           为什么不放 AppRoot：程序目录可能只读（Program Files / U 盘只读），写那里会失败。 */
        public static string UserDataDir
        {
            get
            {
                try
                {
                    string b = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                    if (string.IsNullOrEmpty(b)) b = Path.GetTempPath();
                    return Path.Combine(b, "拾光小册");
                }
                catch { return Path.GetTempPath(); }
            }
        }

        // 写串行闸：regen/pendingResolve/pendingAdd/mark 全部排队执行（生成器实测 ~10 秒，并发必互踩）
        public static readonly System.Threading.SemaphoreSlim WriteGate = new System.Threading.SemaphoreSlim(1, 1);

        /* ★ 日志轮转（2026-10-12 加）：原先只有 AppendAllText，永不删 —— 长跑必然膨胀。
           超过阈值就把当前文件改名为 .1（只保留一代），再新建。
           阈值可由 CTB_LOG_MAX_MB 覆盖（MB），默认 5。 */
        static long ComputeLogMaxBytes()
        {
            try {
                long mb = 5;
                string s = Environment.GetEnvironmentVariable("CTB_LOG_MAX_MB");
                long t;
                if (!string.IsNullOrEmpty(s) && long.TryParse(s, out t) && t > 0) mb = t;
                return mb * 1024L * 1024L;
            } catch { return 5L * 1024L * 1024L; }
        }
        static readonly long LogMaxBytes = ComputeLogMaxBytes();

        static string LogPath { get { return Path.Combine(UserDataDir, "shell.log"); } }
        /* ★ 2026-10-30 加：日志必须「写不进去也不静默」。
           事件（用户报障「双击没反应 + 初始化失败」，2026-10-30）：查
           %LOCALAPPDATA%\拾光小册\shell.log，**一条新记录都没有** —— 旧实现把写失败
           整条吞进 `catch { }`，于是「日志缺失」本身把唯一的线索抹掉了，排查只能猜。
           写失败的真实成因是程序跑在 Windows **低完整性**上下文里（详见 InitWeb 的注释），
           但这不是唯一成因：权限、磁盘满、杀软独占句柄都会这样。所以按顺序试三个落点：
             ① %LOCALAPPDATA%\拾光小册\shell.log   正常情况（程序自己的临时数据）
             ② <程序目录>\shell.log                 程序目录可写时的退路
             ③ %TEMP%\拾光小册-shell.log            全都写不进时的最后退路
           三条全失败 ⇒ 原因进 LastLogError，由启动失败对话框带出来，不再无声。 */
        public static string LastLogError = null;
        static string LogTarget(int i)
        {
            if (i == 0) return LogPath;
            if (i == 1) return Path.Combine(AppRoot, "shell.log");
            return Path.Combine(Path.GetTempPath(), "拾光小册-shell.log");
        }
        public static void Log(string s)
        {
            string line = DateTime.Now.ToString("HH:mm:ss.fff ") + s + "\r\n";
            var errs = new StringBuilder();
            for (int i = 0; i < 3; i++)
            {
                string p;
                try { p = LogTarget(i); }
                catch (Exception ex) { errs.Append("[").Append(i).Append("] ").Append(ex.Message).Append("; "); continue; }
                try
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(p));
                    try
                    {
                        var fi = new FileInfo(p);
                        if (fi.Exists && fi.Length > LogMaxBytes)
                        {
                            string old = p + ".1";
                            try { if (File.Exists(old)) File.Delete(old); } catch { }
                            File.Move(p, old);      // 只保留一代，避免轮转文件自己无限堆
                        }
                    }
                    catch { }
                    File.AppendAllText(p, line, Encoding.UTF8);
                    if (i > 0) LastLogError = "日志已降级写入：" + p + "（前面的落点写不进去：" + errs + "）";
                    return;
                }
                catch (Exception ex)
                {
                    errs.Append("[").Append(p).Append("] ").Append(ex.GetType().Name).Append(": ").Append(ex.Message).Append("; ");
                }
            }
            LastLogError = "日志三个落点都写不进去：" + errs;
        }

        public string ReadState()
        {
            string p = DataPath("_状态.json");
            if (!File.Exists(p)) return null;
            return File.ReadAllText(p, Encoding.UTF8);
        }

        /* 空库兜底（2026-10-23）：DataRoot 里**既没有 _状态.json、也没有任何数据真源迹象**时，
           返回一个形状合法的空状态包，让界面正常渲染"还没有错题"而不是红屏。
           落点是架构设计 §5.2「空库也能正常显示（现在这里是红屏）」。
           ⚠ 只在"真的什么都没有"时生效：只要还有 _待确认.json / 学生目录 / 索引，
             就绝不冒充空库 —— 那等于把用户数据静默藏起来。 */
        public static bool LibraryIsEmpty()
        {
            try
            {
                if (File.Exists(DataPath("_状态.json"))) return false;
                if (File.Exists(DataPath("_待确认.json"))) return false;
                if (File.Exists(DataPath("_索引.json"))) return false;
                if (File.Exists(DataPath("library.json"))) return false;
                string[] names = { "students", "九年级", "数据" };
                foreach (string n in names)
                {
                    if (Directory.Exists(Path.Combine(DataRoot, n))) return false;
                }
                /* ★ 2026-10-23（用户实测 BUG#1 的第二层）：**按"有没有索引"判空，而不是按固定目录名**。
                   起因：上面那份硬编码目录名只覆盖历史库（students/九年级/数据），而"新建学生"
                   建出来的目录叫 `<年级>-<姓名>`（如 `七年级-小明`）—— 判空看不见它 ⇒ 建完学生后
                   重建仍走"空库兜底"，界面永远显示 0 个孩子（实测：磁盘已写对、界面不更新）。
                   现在与 生成状态.mjs 的 findIndexes 同口径：任意一层或两层的目录里有 `_索引.json`
                   就说明库里有数据。下划线/点开头是程序保留区，跳过。 */
                foreach (string d in Directory.GetDirectories(DataRoot))
                {
                    string name = Path.GetFileName(d);
                    if (name.StartsWith("_") || name.StartsWith(".")) continue;
                    if (File.Exists(Path.Combine(d, "_索引.json"))) return false;
                    try
                    {
                        foreach (string sub in Directory.GetDirectories(d))
                        {
                            if (File.Exists(Path.Combine(sub, "_索引.json"))) return false;
                        }
                    }
                    catch { }
                }
                return true;
            }
            catch { return false; }
        }

        /* 程序版本串：打包时 scripts\build-release.ps1 会在程序根生成 版本.json。
           开发态没打包就返回 "dev" —— 与前端 js/version.js 的兜底口径一致。 */
        public static string AppVersionString()
        {
            try
            {
                string p = Path.Combine(AppRoot, "版本.json");
                if (File.Exists(p))
                {
                    string tj = File.ReadAllText(p, Encoding.UTF8).TrimStart('\uFEFF');
                    Match m = Regex.Match(tj, "\"version\"\\s*:\\s*\"([^\"]{1,32})\"");
                    if (m.Success) return m.Groups[1].Value;
                }
            }
            catch { }
            return "dev";
        }

        /* 端口真源（2026-10-29 R2 SC-09 / SC-07）：程序根 `端口.json` 的 default 字段。
           为什么选"一处 JSON + 各方读取"而不是共享一个模块：
             · C# 壳读不了 .mjs 常量；前端（file:// 打开的页面）既不能 import Node 模块、
               也不能 fetch 本地 json（跨源被禁）⇒ 三端唯一共同可读的介质就是**程序目录下的一份 json**
               （本仓已有同款先例：`版本.json`，同样由 C# 读、由打包脚本生成）。
             · 前端那一端由壳注入（AddScriptToExecuteOnDocumentCreatedAsync 的
               window.__ctbPortDefault）与 hello 回执两条路带过去，见 ResolveSrvPort 的调用点。
           口径：CTB_PORT 环境变量**优先**（回归用例要起独立端口实例，这是唯一合法的临时覆盖）；
           真源读不到 ⇒ **不猜**，返回 null（http 导航白名单随之整个关掉：fail-loud 记日志 + fail-safe 拒绝）。
           ⚠ 这里绝不再写一个"默认 7187"的兜底 —— 各处各写一份默认值正是本条缺陷的根因。 */
        static string _srvPortCache = null;
        static bool _srvPortResolved = false;
        public static string ResolveSrvPort()
        {
            if (_srvPortResolved) return _srvPortCache;
            _srvPortResolved = true;
            _srvPortCache = ReadSrvPort();
            return _srvPortCache;
        }
        static string ReadSrvPort()
        {
            string env = Environment.GetEnvironmentVariable("CTB_PORT");
            if (!string.IsNullOrEmpty(env) && Regex.IsMatch(env, "^[0-9]{1,5}$")) return env;
            string p = Path.Combine(AppRoot, "端口.json");
            try
            {
                if (!File.Exists(p)) { Log("端口真源缺失：" + p + "（http 导航白名单关闭，本机服务端通道不可用）"); return null; }
                string tj = File.ReadAllText(p, Encoding.UTF8).TrimStart('\uFEFF');
                Match m = Regex.Match(tj, "\"default\"\\s*:\\s*([0-9]{1,5})");
                if (m.Success) return m.Groups[1].Value;
                Log("端口真源形状异常（读不到 default 数字）：" + p);
            }
            catch (Exception ex) { Log("端口真源读取失败：" + p + " ← " + ex.Message); }
            return null;
        }

        public static string EmptyState()
        {
            string ts = DateTime.Now.ToString("yyyy-MM-ddTHH:mm:sszzz");
            return "{\"version\":1,\"generatedAt\":\"" + ts + "\",\"empty\":true"
                 + ",\"data\":[],\"papers\":[]"
                 + ",\"blindFresh\":{},\"figState\":{},\"admit\":{}"
                 + ",\"pending\":{\"items\":[],\"open\":0,\"byAsk\":{},\"ids\":[]}"
                 + ",\"_pendingSrc\":{}"
                 + ",\"dataHealth\":{\"data\":\"ok\",\"pending\":\"ok\",\"blindFresh\":\"ok\",\"figState\":\"ok\"}}";
        }

        // ---- op: state / regen ----
        // 机器级重建互斥：跨进程串行（防「页面 regen + 外部手跑生成器」并写同一文件——2026-10-08 实测竞态会写坏 _状态.json）
        static readonly System.Threading.Mutex RegenMachineMutex = new System.Threading.Mutex(false, @"Global\CTB-Regen-Mutex");
        public string Rebuild()
        {
            if (!WriteGate.Wait(1200000)) return "{\"ok\":false,\"regenError\":\"等待写入闸超时（另有落库/重建在跑）\"}";
            bool held = false;
            try
            {
                try { held = RegenMachineMutex.WaitOne(TimeSpan.FromMinutes(10)); }
                catch (AbandonedMutexException) { held = true; }   // 上一持有者崩溃：接管即视为拿到
                if (!held) return "{\"ok\":false,\"regenError\":\"另一进程正在重建（等待 10 分钟仍占用），稍后再试\"}";
                /* 状态生成器：优先用 Node 版（`生成状态.mjs`，PowerShell 生成器退役方向），
                   找不到再退回老的 `_生成首页.ps1`（迁移期兼容）。两个都没有 → 空库兜底或响亮报错。 */
                string genMjs = ToolPath("生成状态.mjs");
                string genPs1 = ToolPath("_生成首页.ps1");
                bool hasMjs = File.Exists(genMjs);
                bool hasPs1 = File.Exists(genPs1);

                /* ★ 2026-10-23：**空库先判空，再决定要不要跑生成器**。
                   原先只有"连生成器都找不到"才走空库兜底；库是空的但生成器在时照样跑生成器。
                   而生成器自己算库根（_库根.mjs）与壳算 DataRoot 是两套推导，在"开发树 / 首次运行"
                   这种既非发布布局、也非老布局的场景下会算到**不同目录** ⇒ 生成器把状态包写到 A，
                   壳却去 B 读 ⇒ 界面红屏「状态包形态异常（缺 data 数组）」。
                   实测场景：刚 clone 完按 README 直接跑 src\app\拾光小册.exe（没有 数据\ 目录）。
                   现在：库确实是空的就直接给形状合法的空状态包 —— 界面正常显示"还没有错题"，
                   这也正是架构设计 §5.2 的要求。判空仍然严格（见 LibraryIsEmpty：有任何真源就不算空）。 */
                if (LibraryIsEmpty()) { Log("regen: 空库 → 返回空状态包（不跑生成器）"); return EmptyState(); }

                if (!hasMjs && !hasPs1)
                {
                    throw new Exception("找不到状态生成器：期望 " + genMjs + "（库里有数据却没有生成器，拒绝冒充空库）");
                }
                if (hasMjs)
                {
                    Log("regen: 走 Node 生成器 " + genMjs);
                    RunNode(new[] { genMjs }, 300000);      // 退出码 0/1 都算正常，其余抛错
                }
                else
                {
                // ⚠ PS5.1 用 [Console]::OutputEncoding（默认 GBK）解码「生成器内部 & node 门禁 --json」的 UTF-8 输出，
                //   壳里 CreateNoWindow+重定向跑会把中文待办区写成乱码（2026-10-08 实测写坏 _状态.json）。
                //   修复：进入 PS 会话先自设 UTF-8 编码，再点跑生成器脚本。
                var psi = new ProcessStartInfo
                {
                    FileName = "powershell.exe",
                    Arguments = "-NoProfile -ExecutionPolicy Bypass -Command \"[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; & '" + genPs1 + "'\"",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    StandardOutputEncoding = Encoding.UTF8,
                    StandardErrorEncoding = Encoding.UTF8,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true
                };
                using (var p = Process.Start(psi))
                {
                    p.StandardOutput.ReadToEnd();          // 必须读干管道，防阻塞
                    p.StandardError.ReadToEnd();
                    /* ⚠ BUG-14：同 Mark，超时必须可判 + 杀进程，否则写闸被永久占住。 */
                    if (!p.WaitForExit(600000))
                    {
                        try { p.Kill(); } catch { }
                        try { p.WaitForExit(5000); } catch { }
                        throw new Exception("生成器 10 分钟未退出，已强制结束");
                    }
                    if (p.ExitCode != 0) throw new Exception("生成器退出码 " + p.ExitCode);
                }
                }
                string s = ReadState();
                if (s == null) throw new Exception("重建后仍无 _状态.json");
                return s;
            }
            catch (Exception ex)
            {
                return "{\"ok\":false,\"regenError\":\"" + Esc(ex.Message) + "\"}";
            }
            finally { if (held) { try { RegenMachineMutex.ReleaseMutex(); } catch { } } WriteGate.Release(); }
        }

        // ---- op: pendingResolve（与 v1 同契约，页面两版通用）----
        public string PendingResolve(string payload)
        {
            string results = "[]";
            if (!WriteGate.Wait(1200000)) return "{\"ok\":false,\"error\":\"等待写入闸超时（另有落库/重建在跑）\"}";
            bool held = false;
            try
            {
                try { held = RegenMachineMutex.WaitOne(TimeSpan.FromMinutes(10)); } catch (AbandonedMutexException) { held = true; }
                if (!held) return "{\"ok\":false,\"error\":\"另一进程正在重建/刷盘，稍后再试\"}";
                string tmp = Path.Combine(Path.GetTempPath(), "gn-pending-" + DateTime.Now.Ticks + ".json");
                Log("pendingResolve tmp=" + tmp);
                string pkg = "{\"exportedAt\":\"" + DateTime.UtcNow.ToString("o") + "\",\"tool\":\"gn-shell\",\"resolves\":" + ExtractArray(payload, "resolves") + "}";
                File.WriteAllText(tmp, pkg, new UTF8Encoding(false));
                try
                {
                    string out1 = RunNode(new[] { ToolPath("_待确认.mjs"), "同步", "--file", tmp }, 180000);
                    results = ParseResults(out1);
                }
                finally { try { File.Delete(tmp); } catch { } }
                string out2 = RunNode(new[] { ToolPath("_状态刷新.mjs"), "pending" }, 120000);
                return "{\"ok\":true,\"results\":" + results + ",\"state\":" + out2 + "}";
            }
            catch (Exception ex)
            {
                return "{\"ok\":false,\"error\":\"" + Esc(ex.Message) + "\"}";
            }
            finally { if (held) { try { RegenMachineMutex.ReleaseMutex(); } catch { } } WriteGate.Release(); }
        }

        // ---- op: pendingAdd → _待确认.mjs 加（字段全走白名单 flag）----
        public string PendingAdd(string payload)
        {
            if (!WriteGate.Wait(1200000)) return "{\"ok\":false,\"error\":\"等待写入闸超时（另有落库/重建在跑）\"}";
            bool held = false;
            try
            {
                try { held = RegenMachineMutex.WaitOne(TimeSpan.FromMinutes(10)); } catch (AbandonedMutexException) { held = true; }
                if (!held) return "{\"ok\":false,\"error\":\"另一进程正在重建/刷盘，稍后再试\"}";
                var args = new List<string> { ToolPath("_待确认.mjs"), "加" };
                AddFlag(args, payload, "student", "--student");
                AddFlag(args, payload, "subject", "--subject");
                AddFlag(args, payload, "card", "--card");
                AddFlag(args, payload, "kind", "--kind");
                AddFlag(args, payload, "ask", "--ask");
                AddFlag(args, payload, "q", "--q");
                AddFlag(args, payload, "detail", "--detail");
                AddFlag(args, payload, "source", "--source");
                AddFlag(args, payload, "date", "--date");
                AddFlag(args, payload, "qref", "--qref");
                AddFlag(args, payload, "box", "--box");
                AddFlag(args, payload, "evidence", "--evidence");
                string out1 = RunNode(args.ToArray(), 120000);
                string out2 = RunNode(new[] { ToolPath("_状态刷新.mjs"), "pending" }, 120000);
                string newId = "";
                Match m = Regex.Match(out1 ?? "", "T\\d{3}");
                if (m.Success) newId = m.Value;
                return "{\"ok\":true,\"newId\":\"" + newId + "\",\"toolOut\":\"" + Esc(TrimTail(out1)) + "\",\"state\":" + out2 + "}";
            }
            catch (Exception ex)
            {
                return "{\"ok\":false,\"error\":\"" + Esc(ex.Message) + "\"}";
            }
            finally { if (held) { try { RegenMachineMutex.ReleaseMutex(); } catch { } } WriteGate.Release(); }
        }

        // ---- op: createStudent → _建学生.mjs（空库第一步：先有孩子，才有卡）----
        /* 只做两件事：① 把三个字段原样交给工具（校验与落盘都在工具里，壳不重写业务）；
                       ② 建完立刻全量重建状态包，把新学生送到界面。
           为什么重建而不是只刷 pending：学生列表来自 state.data，而 data 只有生成器会产出。 */
        public string CreateStudent(string payload)
        {
            if (!WriteGate.Wait(1200000)) return "{\"ok\":false,\"error\":\"等待写入闸超时（另有落库/重建在跑）\"}";
            bool held = false;
            try
            {
                try { held = RegenMachineMutex.WaitOne(TimeSpan.FromMinutes(10)); } catch (AbandonedMutexException) { held = true; }
                if (!held) return "{\"ok\":false,\"error\":\"另一进程正在重建/刷盘，稍后再试\"}";
                var args = new List<string> { ToolPath("_建学生.mjs"), "--json" };
                AddFlag(args, payload, "name", "--name");
                AddFlag(args, payload, "grade", "--grade");
                AddFlag(args, payload, "subject", "--subject");
                string out1 = RunNode(args.ToArray(), 120000);
                string tail = TrimTail(out1);
                Match m = Regex.Match(out1 ?? "", "\"ok\"\\s*:\\s*true");
                if (!m.Success) return "{\"ok\":false,\"error\":\"" + Esc(tail) + "\"}";

                /* ⚠ 不能在这里调 Rebuild()：本方法已经持有 WriteGate + RegenMachineMutex，
                   而 Rebuild() 开头会**再申请同一把写闸** ⇒ 自己等自己，通道永远不返回
                   （2026-10-24 实测：直接调 CTB.host.createStudent 挂死，壳日志里连 op 响应都没有）。
                   正确做法与 Rebuild 内部一致：自己跑生成器、自己读状态包。 */
                string st = null;
                string genMjs2 = ToolPath("生成状态.mjs");
                if (File.Exists(genMjs2))
                {
                    RunNode(new[] { genMjs2 }, 300000);
                    st = ReadState();
                }
                if (st == null) st = LibraryIsEmpty() ? EmptyState() : null;
                if (st == null) return "{\"ok\":false,\"error\":\"学生已建好，但状态包重建失败（重开程序会重新生成）\"}";
                return "{\"ok\":true,\"toolOut\":\"" + Esc(tail) + "\",\"state\":" + st + "}";
            }
            catch (Exception ex)
            {
                return "{\"ok\":false,\"error\":\"" + Esc(ex.Message) + "\"}";
            }
            finally { if (held) { try { RegenMachineMutex.ReleaseMutex(); } catch { } } WriteGate.Release(); }
        }

        // ---- op: mark → _标记复习.mjs（动作与 flag 双白名单，壳不解释语义）----
        static readonly HashSet<string> MARK_ACTIONS = new HashSet<string> { "组卷", "批改", "撤批", "归档", "撤归档", "状态" };
        public string Mark(string payload)
        {
            string action0 = ExtractString(payload, "action");
            if (!MARK_ACTIONS.Contains(action0)) return "{\"ok\":true,\"code\":2,\"out\":\"\",\"err\":\"白名单外的动作：" + Esc(action0) + "\"}";
            if (!WriteGate.Wait(1200000)) return "{\"ok\":true,\"code\":124,\"out\":\"\",\"err\":\"等待写入闸超时（另有落库/重建在跑）\"}";
            bool held = false;
            try
            {
                // 机器级互斥（F-05）：写闸只在本进程内串行，跨进程的「外部手跑生成器」只能靠这具名互斥体挡住
                try { held = RegenMachineMutex.WaitOne(TimeSpan.FromMinutes(10)); } catch (AbandonedMutexException) { held = true; }
                if (!held) return "{\"ok\":true,\"code\":125,\"out\":\"\",\"err\":\"另一进程正在重建/刷盘，稍后再试\"}";
                string action = action0;
                var args = new List<string> { ToolPath("_标记复习.mjs"), action };
                AddFlag(args, payload, "student", "--student");
                AddFlag(args, payload, "subject", "--subject");
                AddFlag(args, payload, "ids", "--ids");
                AddFlag(args, payload, "title", "--title");
                AddFlag(args, payload, "date", "--date");
                AddFlag(args, payload, "note", "--note");
                AddFlag(args, payload, "paper", "--paper");
                AddFlag(args, payload, "results", "--results");
                AddFlag(args, payload, "reason", "--reason");
                AddFlag(args, payload, "at", "--at");
                AddFlag(args, payload, "to", "--to");
                string force = ExtractString(payload, "force");
                if (force == "1" || force == "true") args.Add("--force");
                // v2.7（2026-10-16）：组卷洗牌权在界面。界面洗过牌的卷面顺序必须原样入账，
                // 工具侧不得再交错重排（台账≠卷面 ⇒ 批改对不上题，P20261015-01 实测事故）。
                // interleave="0"（界面洗牌后）→ --no-interleave；"1" → --interleave；缺省 → 工具默认（不重排）。
                string inter = ExtractString(payload, "interleave");
                if (inter == "0" || inter == "false") args.Add("--no-interleave");
                else if (inter == "1" || inter == "true") args.Add("--interleave");
                string code = "0", stdout = "", stderr = "";
                var psi = new ProcessStartInfo
                {
                    FileName = "node.exe",
                    Arguments = QuoteArgs(args.ToArray()),
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    StandardOutputEncoding = Encoding.UTF8,
                    StandardErrorEncoding = Encoding.UTF8,   // 不设则中文错误信息按 GBK 解码成乱码（e2e 实测踩坑）
                    RedirectStandardOutput = true,
                    RedirectStandardError = true
                };
                using (var p = Process.Start(psi))
                {
                    stdout = p.StandardOutput.ReadToEnd();
                    stderr = p.StandardError.ReadToEnd();
                    /* ⚠ 2026-10-12(BUG-14·高)：ReadToEnd 先阻塞读完（子进程不死就不返回），
                       所以 WaitForExit(ms) 的返回值原先**永远用不上** —— 工具一卡死，界面永远转圈，
                       且 WriteGate 在 finally 里释放 ⇒ 写闸被永久占住，此后所有写入排队等死。
                       现在：显式判断超时并**杀掉进程**，让 finally 能走到。 */
                    if (!p.WaitForExit(180000))
                    {
                        try { p.Kill(); } catch { }
                        try { p.WaitForExit(5000); } catch { }
                        code = "124";
                        stderr = (stderr ?? "") + "\n[超时] 子进程 180s 未退出，已强制结束（写闸即将释放）";
                    }
                    else code = p.ExitCode.ToString();
                    /* ⚠ 2026-10-29（R2 SC-02 / D-09）：这里原有 `code = p.ExitCode.ToString();`
                       一行**无条件覆盖**了上面两个分支，于是超时分支刚设的 "124" 永远作废：
                       ① 上面注释宣告的"超时码 124"不可达；② 若子进程恰在 WaitForExit 超时与 Kill
                       之间以 0 正常结束（工具其实已写完盘），code 变成 "0" ⇒ 前端 paper.js 的
                       `r.code !== 0` 判据放行 ⇒ 界面报"已入账"，而壳的结论是"超时已强制结束"
                       （重复入账方向的错）。删掉它，让两个分支各自的结果生效。 */
                }
                HostBridge.Log("mark " + action + " exit=" + code + " out=" + SliceForLog((stdout ?? "").Replace("\r\n", " | ")));
                return "{\"ok\":true,\"code\":" + code + ",\"out\":\"" + Esc(stdout) + "\",\"err\":\"" + Esc(stderr) + "\"}";
            }
            catch (Exception ex)
            {
                return "{\"ok\":false,\"code\":-1,\"out\":\"\",\"err\":\"" + Esc(ex.Message) + "\"}";
            }
            finally { if (held) { try { RegenMachineMutex.ReleaseMutex(); } catch { } } WriteGate.Release(); }
        }

        // ---- 数据目录包含性校验（唯一实现）：readFile / openFile / revealFile 三个 op 共用（F-03）----
        // 为什么不用裸 StartsWith(root)：`…\错题本-X` 与 `…\错题本` 同前缀，兄弟目录会被漏放（F-04 同类语义）；
        // 为什么必须显式判越界：Path.Combine(root, "C:\Windows\System32\calc.exe") 会**直接返回第二参**（.NET 语义）。
        // 2026-10-23：边界从"一个 Root"改成 DataRoot（用户库）—— 程序目录不再允许页面随便读。
        public bool TryResolveInsideRoot(string rel, out string abs, out string why)
        {
            abs = null; why = null;
            if (string.IsNullOrEmpty(rel)) { why = "path 为空"; return false; }
            string rootFull;
            try { rootFull = Path.GetFullPath(DataRoot); }
            catch (Exception ex) { why = "库目录不可用：" + ex.Message; return false; }
            try { abs = Path.GetFullPath(Path.Combine(rootFull, rel.Replace('/', Path.DirectorySeparatorChar))); }
            catch (Exception ex) { abs = null; why = "路径非法：" + ex.Message; return false; }
            if (!abs.StartsWith(rootFull + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            { abs = null; why = "越界拒绝（只允许库目录内路径）：" + rel; return false; }
            return true;
        }

        // ---- op: recipe → _配方.mjs（动作白名单；壳不解释语义，只做透明转发）----
        /* 2026-10-27 新增：界面「录题」页的通道。
           设计要点（为什么是"透明转发"而不是壳里判逻辑）：
             · 壳不认识"配方/学科/错因"，它只负责把白名单动作 + 白名单参数转成命令行；
             · 配方在哪、怎么拼、怎么校验，全由 _配方.mjs 决定 —— 这样加一条反例不用重编壳。
           安全边界：
             · 动作白名单（清单/收件箱/组装/校验/自检/指纹），别的一律拒；
             · 参数逐个 AddFlag（不接受任意拼接）；
             · 库根**显式**用 --data 传进去，不依赖环境变量继承；
             · **不进写闸**：本工具只读配方与收件箱、只写调用方指定的临时文件，不写用户库。
           超时 60s：组装是一次纯文本拼接，校验是一次 JSON 比对，都远低于这个量级。 */
        static readonly HashSet<string> RECIPE_ACTIONS = new HashSet<string> { "清单", "收件箱", "组装", "校验", "自检", "指纹" };
        public string Recipe(string payload)
        {
            string action = ExtractString(payload, "action");
            if (!RECIPE_ACTIONS.Contains(action))
                return "{\"ok\":false,\"code\":2,\"out\":\"\",\"err\":\"白名单外的动作：" + Esc(action) + "\"}";
            string tmp = null;
            try
            {
                var args = new List<string> { ToolPath("_配方.mjs"), action };
                AddFlag(args, payload, "recipe", "--recipe");
                AddFlag(args, payload, "subject", "--subject");
                AddFlag(args, payload, "textbook", "--textbook");
                AddFlag(args, payload, "image", "--image");
                /* 校验/自检的输入：页面传的是**文本**（用户从自己的 AI 粘回来的 JSON），
                   先落临时文件再让工具读 —— 避免把上万字符塞进命令行（Windows 命令行上限 32767）。 */
                string text = ExtractString(payload, "text");
                if (!string.IsNullOrEmpty(text))
                {
                    tmp = Path.Combine(Path.GetTempPath(), "gn-recipe-" + DateTime.Now.Ticks + ".json");
                    File.WriteAllText(tmp, text, new UTF8Encoding(false));
                    args.Add("--in"); args.Add(tmp);
                }
                args.Add("--data"); args.Add(DataRoot);
                if (ExtractString(payload, "json") == "1") args.Add("--json");

                /* ★ 2026-10-29（R2 SC-02 / D-01）：回**真实退出码**，不再硬编码 code:0。
                   与同文件 Mark() 同口径（ok = 通道成功；code = 工具退出码），也与
                   tests\neg-recipe-contract.cjs 钉住的契约一致：校验通过=0 / 拒收=1 / 参数错=2。
                   改前：无论工具退出 0 还是 1，这里都回 {"ok":true,"code":0,...} ⇒
                   ingest.js:313 按 code===0 判 ⇒ 「✖ 校验未通过」被渲染成绿色「✔ 校验通过」。 */
                int exit; string se;
                string so = RunNodeRaw(args.ToArray(), 60000, out exit, out se);
                Log("recipe " + action + " exit=" + exit + " out=" + SliceForLog((so ?? "").Replace("\r\n", " | ")));
                return "{\"ok\":true,\"code\":" + exit + ",\"out\":\"" + Esc(so ?? "") + "\",\"err\":\"" + Esc(se ?? "") + "\"}";
            }
            catch (Exception ex)
            {
                /* 走到这里只剩"进程起不来/参数非法"这类真错误（exit 2 已由上面的 code 如实带回，
                   不再是异常）⇒ ok:false + code:-1，页面走"请求失败"分支并显示原文。 */
                Log("recipe " + action + " FAILED: " + ex.Message);
                return "{\"ok\":false,\"code\":-1,\"out\":\"\",\"err\":\"" + Esc(ex.Message) + "\"}";
            }
            finally { if (tmp != null) { try { File.Delete(tmp); } catch { } } }
        }

        // ---- op: readFile（限题库根内，≤4MB）----
        public string ReadFile(string payload)
        {
            try
            {
                string rel = ExtractString(payload, "path");
                string abs, why;
                if (!TryResolveInsideRoot(rel, out abs, out why)) throw new Exception(why);
                var fi = new FileInfo(abs);
                if (!fi.Exists) throw new Exception("文件不存在：" + rel);
                if (fi.Length > 4 * 1024 * 1024) throw new Exception("文件过大（>4MB）：" + rel);
                string text = File.ReadAllText(abs, Encoding.UTF8);
                return "{\"ok\":true,\"text\":\"" + Esc(text) + "\"}";
            }
            catch (Exception ex)
            {
                return "{\"ok\":false,\"error\":\"" + Esc(ex.Message) + "\"}";
            }
        }

        // ---------------- 小工具 ----------------
        static void AddFlag(List<string> args, string payload, string key, string flag)
        {
            string v = ExtractString(payload, key);
            if (!string.IsNullOrEmpty(v)) { args.Add(flag); args.Add(v); }
        }
        static string TrimTail(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            s = s.Replace("\r\n", " | ");
            return s.Length > 400 ? s.Substring(s.Length - 400) : s;
        }
        static string SliceForLog(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            return s.Length > 300 ? s.Substring(0, 300) : s;
        }

        /* 分片（唯一实现；tests\chunk-roundtrip.cjs 与之同构并逐字符比对）：
           ① 片长按 UTF-8 字节预算算，单条 postMessage 不再逼近 1MB 线（F-02）；
           ② **绝不把代理对切成两半**：切两半时 Chromium 会把孤代理换成 U+FFFD；更致命的是旧实现 len-- 之后
              游标仍按原片长前进 ⇒ 尾部静默少发字符（F-01 实测「已发送 1433599/1433600，完整=false」）。
           不变量：string.Concat(SplitByByteBudget(s, b)) 与 s **逐字符相等**；片数与片长只由本函数算，调用方不得另算 n。 */
        public static List<string> SplitByByteBudget(string s, int byteBudget)
        {
            var parts = new List<string>();
            if (s == null) return parts;
            if (s.Length == 0) { parts.Add(""); return parts; }
            int pos = 0;
            while (pos < s.Length)
            {
                int len = 0, used = 0;
                while (pos + len < s.Length)
                {
                    char c = s[pos + len];
                    bool pair = char.IsHighSurrogate(c) && pos + len + 1 < s.Length && char.IsLowSurrogate(s[pos + len + 1]);
                    // 字节数口径必须与 Encoding.UTF8.GetByteCount 一致：代理对 4；孤代理按替换字符 U+FFFD 算 3
                    int cb = pair ? 4 : (char.IsSurrogate(c) ? 3 : (c < 0x80 ? 1 : (c < 0x800 ? 2 : 3)));
                    if (len > 0 && used + cb > byteBudget) break;   // 满片即止；len==0 时至少收 1 个字符，保证游标一定前进
                    used += cb;
                    len += pair ? 2 : 1;
                }
                parts.Add(s.Substring(pos, len));
                pos += len;
            }
            return parts;
        }

        /* 跑 node 的**唯一底座**：返回值仍是 stdout，但退出码与 stderr 一并带出。
           为什么要有 outCode（2026-10-29 R2 SC-02 / D-01）：原实现把退出码在**返回处就丢掉了**，
           而 `_配方.mjs 校验` 的退出码是被测试钉死的契约（tests\neg-recipe-contract.cjs:141/160：
           通过=0 / 拒收=1 / 参数错=2）。丢掉它 ⇒ Recipe() 只能硬编码 code:0 ⇒
           页面把"拒收"渲染成绿色「✔ 校验通过」（失败被讲成成功，L1 阻断项）。
           outCode = 进程真实退出码；超时被杀记 124（与 Mark 同码）且**不抛**，由包装决定怎么报。 */
        string RunNodeRaw(string[] args, int timeoutMs, out int outCode, out string outErr)
        {
            var psi = new ProcessStartInfo
            {
                FileName = "node.exe",
                Arguments = QuoteArgs(args),
                UseShellExecute = false,
                CreateNoWindow = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            using (var p = Process.Start(psi))
            {
                string so = p.StandardOutput.ReadToEnd();
                string se = p.StandardError.ReadToEnd();
                /* ⚠ BUG-14：同 Mark —— 超时必须可判并杀进程。 */
                if (!p.WaitForExit(timeoutMs))
                {
                    try { p.Kill(); } catch { }
                    try { p.WaitForExit(5000); } catch { }
                    outCode = 124;
                    outErr = (se ?? "") + "\n[超时] node 子进程 " + (timeoutMs / 1000) + "s 未退出，已强制结束";
                    return so;
                }
                outCode = p.ExitCode;
                outErr = se;
                return so;
            }
        }

        /* 门禁语义包装（既有调用方的口径**不变**）：0/1 均正常（1=有未通过项）；其他=失败（抛错）。
           需要真实退出码的调用方（Recipe）直接用 RunNodeRaw —— 不要在这里加分支，
           也不要再复制一份进程代码（同一事实两个实现正是 SC-07 要收敛的东西）。 */
        string RunNode(string[] args, int timeoutMs)
        {
            int code; string se;
            string so = RunNodeRaw(args, timeoutMs, out code, out se);
            if (code == 124) throw new Exception("node 子进程 " + (timeoutMs / 1000) + "s 未退出，已强制结束");
            if (code != 0 && code != 1)
                throw new Exception("node 退出码 " + code + "：" + ((se ?? "").Trim().Length > 0 ? se.Trim() : (so ?? "").Trim()));
            return so;
        }
/// <summary>真正懂 JSON 字符串转义的取值器（唯一实现，两个 ExtractString 共用）。
        /// 逐字符扫描：找 "key"，跳到冒号后必须是引号，再按 JSON 规则读到闭合引号
        /// —— \" 不算闭合、\\ 跳两字符、\uXXXX 解成字符。找不到或不是字符串 → false。</summary>
        public static bool TryReadJsonString(string json, string key, out string value)
        {
            value = null;
            if (string.IsNullOrEmpty(json) || string.IsNullOrEmpty(key)) return false;
            string pat = "\"" + key + "\"";
            int k = json.IndexOf(pat, StringComparison.Ordinal);
            if (k < 0) return false;
            int i = k + pat.Length;
            while (i < json.Length && char.IsWhiteSpace(json[i])) i++;
            if (i >= json.Length || json[i] != ':') return false;
            i++;
            while (i < json.Length && char.IsWhiteSpace(json[i])) i++;
            if (i >= json.Length || json[i] != '"') return false;    // 非字符串 → 不取
            i++;
            var sb = new StringBuilder();
            while (i < json.Length)
            {
                char c = json[i];
                if (c == '"') { value = sb.ToString(); return true; }   // 正常闭合
                if (c == '\\')
                {
                    if (i + 1 >= json.Length) return false;             // 悬空反斜杠 = 坏 JSON
                    char n = json[i + 1];
                    switch (n)
                    {
                        case '"': sb.Append('"'); i += 2; break;
                        case '\\': sb.Append('\\'); i += 2; break;
                        case '/': sb.Append('/'); i += 2; break;
                        case 'n': sb.Append('\n'); i += 2; break;
                        case 'r': sb.Append('\r'); i += 2; break;
                        case 't': sb.Append('\t'); i += 2; break;
                        case 'b': sb.Append('\b'); i += 2; break;
                        case 'f': sb.Append('\f'); i += 2; break;
                        case 'u':
                            if (i + 5 < json.Length)
                            {
                                int code;
                                if (int.TryParse(json.Substring(i + 2, 4), System.Globalization.NumberStyles.HexNumber,
                                                 System.Globalization.CultureInfo.InvariantCulture, out code))
                                { sb.Append((char)code); i += 6; }
                                else return false;
                            }
                            else return false;
                            break;
                        default: sb.Append(n); i += 2; break;
                    }
                    continue;
                }
                sb.Append(c); i++;
            }
            return false;                                                 // 没闭合 → 坏 JSON，不给半个值
        }

/// <summary>把参数拼成 Windows 命令行（CRT 规则）：先把每个参数里的反斜杠与引号
        /// 按 CRT 规则转义，再用双引号包住。
        /// ⚠ 2026-10-12 修（审计 BUG-13·高 的第二环）：原实现把 " 换成 \"（Linux 风格）。
        /// Windows 规则不同：先转义反斜杠、再转义引号，且**结尾处的反斜杠要翻倍**；
        /// 否则"内容以 \ 结尾 + 闭合引号"会把闭合引号吃掉，后一个参数被吞进本参数
        /// （实测 node 收到 ["--note","本卷不含 \" --date 2026-10-12"] ⇒ --date 丢失）。
        /// 回归见 tests/neg-shell-args.cjs（引号/反斜杠/尾随反斜杠/中文/空串）。</summary>
        static string QuoteArgs(string[] args)
        {
            var sb = new StringBuilder();
            for (int i = 0; i < args.Length; i++)
            {
                if (i > 0) sb.Append(' ');
                sb.Append('"');
                string a = args[i] ?? "";
                for (int k = 0; k < a.Length; k++)
                {
                    int bs = 0;
                    while (k < a.Length && a[k] == '\\') { bs++; k++; }
                    if (k == a.Length) { sb.Append('\\', bs * 2); k--; break; }    // 收尾反斜杠：翻倍
                    if (a[k] == '"') { sb.Append('\\', bs * 2 + 1); sb.Append('"'); }  // 引号前补一个
                    else { sb.Append('\\', bs); sb.Append(a[k]); }
                }
                sb.Append('"');
            }
            return sb.ToString();
        }
        public static string Esc(string s)
        {
            if (s == null) return "";
            var sb = new StringBuilder();
            foreach (char c in s)
            {
                switch (c)
                {
                    case '\\': sb.Append("\\\\"); break;
                    case '"': sb.Append("\\\""); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            return sb.ToString();
        }
/// <summary>⚠ 2026-10-12 修（审计 BUG-13·高）：原实现是"找下一个引号"，**不认转义** ——
        /// 家长在批改备注里写一个英文双引号（如 见"P3"），浏览器发来的是 \"，
        /// 于是闭合引号判错位置 ⇒ 值被截断/清空；再叠加 QuoteArgs 用 Linux 风格转义，
        /// 截断产物以反斜杠结尾会把闭合引号吃掉 ⇒ 实测 note 变成空字符串，
        /// 而工具退出码仍是 0、界面照报"已落库" ⇒ **静默数据损坏**。现统一走 TryReadJsonString。</summary>
        static string ExtractString(string json, string key)
        {
            string v;
            return TryReadJsonString(json, key, out v) ? v : "";
        }
        /* ⚠ 2026-10-29（R2 审计 SC-01(5)）：这里原有那个「按字符还原转义」的静态方法（35 行）。
           它已被 TryReadJsonString 取代（上面 ExtractString 的注释就是那次修复写的），
           全仓零引用（只有定义行本身命中）—— 死代码删掉。
           留着的代价是维护者以为"转义还原还有第二条路"，而那条路从来没被走过。 */
        static string ExtractArray(string json, string key)
        {
            if (json == null) return "[]";
            string pat = "\"" + key + "\"";
            int k = json.IndexOf(pat, StringComparison.Ordinal);
            if (k < 0) return "[]";
            int c = json.IndexOf('[', k);
            if (c < 0) return "[]";
            int depth = 0, i = c;
            bool inStr = false, esc = false;
            for (; i < json.Length; i++)
            {
                char ch = json[i];
                if (inStr) { if (esc) esc = false; else if (ch == '\\') esc = true; else if (ch == '"') inStr = false; continue; }
                if (ch == '"') inStr = true;
                else if (ch == '[') depth++;
                else if (ch == ']') { depth--; if (depth == 0) return json.Substring(c, i - c + 1); }
            }
            return "[]";
        }
        /* 解析 `_待确认.mjs 同步` 的 stdout，逐行产出 {id,status,line}。
         *
         * ⚠ 2026-10-21 修（用户报障「待办办完之后还会弹出来，不能消失」的**第二个**根因）：
         *   旧实现用 `line.IndexOf("T0")` 找编号 ⇒ 只认 **T001~T099**。台账编号早已涨到 T196，
         *   T1xx 的行一个都匹配不上 ⇒ results 恒为 `[]`。而前端把「results 为空」当成"没拿到逐条结果"
         *   而不报错，于是照常弹绿字「已落库 Txxx（工具幂等，重复提交不会双计）」并清本地草稿，
         *   实际上工具那边可能是「↔ 已是已作废，跳过」——用户看到成功、待办却原地不动。
         *   现改为：`T` + **至少 3 位数字**（不限定首位），逐字符扫描到非数字为止，编号长度自适应。
         *   契约：本函数只认「行首状态符 + 编号」的行；一行都解析不出 ⇒ 返回 "[]"，
         *   前端据此必须报错（见 v2\js\views\pending.js 的 hasResults 判据）。 */
        static string ParseResults(string stdout)
        {
            var sb = new StringBuilder("[");
            bool first = true;
            if (stdout != null)
            {
                foreach (var rawLine in stdout.Split('\n'))
                {
                    string line = rawLine.Trim();
                    if (line.Length < 5) continue;
                    /* 只认带状态符的行：✔(U+2714) 落库 / ↔(U+2194) 跳过 / ✖(U+2716) 不存在。
                       不带状态符的行（如「同步完成：…」汇总行）一律不当结果。 */
                    char mark = line[0];
                    if (mark != '✔' && mark != '↔' && mark != '✖') continue;
                    string id = ScanId(line);
                    if (id == null) continue;
                    string status = mark == '↔' ? "skipped" : (mark == '✖' ? "missing" : "ok");
                    if (!first) sb.Append(",");
                    first = false;
                    sb.Append("{\"id\":\"").Append(id).Append("\",\"status\":\"").Append(status)
                      .Append("\",\"line\":\"").Append(Esc(line)).Append("\"}");
                }
            }
            sb.Append("]");
            return sb.ToString();
        }
        /* 从一行里扫出第一个「T + ≥3 位数字」的编号（T001…T999…T1000 都能认） */
        static string ScanId(string line)
        {
            for (int i = 0; i <= line.Length - 4; i++)
            {
                if (line[i] != 'T') continue;
                int j = i + 1, digits = 0;
                while (j < line.Length && IsDigit(line[j])) { j++; digits++; }
                if (digits >= 3) return line.Substring(i, j - i);
            }
            return null;
        }
        static bool IsDigit(char c) { return c >= '0' && c <= '9'; }
    }

    // ============================================================================
    public class ShellForm : Form
    {
        WebView2 wv;
        HostBridge bridge;
        NotifyIcon tray;
        CoreWebView2Environment env;
        bool dueNotified = false;

        public ShellForm()
        {
            bridge = new HostBridge();
            Text = "拾光小册";
            Width = 1500; Height = 950;
            StartPosition = FormStartPosition.CenterScreen;
            WindowState = FormWindowState.Maximized;
            try
            {
                /* 图标在程序目录（AppRoot）。老布局下它躺在 _桌面v2\ 里，一并兼容。 */
                string icoPath = Path.Combine(HostBridge.AppRoot, "ctb.ico");
                if (!File.Exists(icoPath)) icoPath = Path.Combine(HostBridge.AppRoot, "_桌面v2", "ctb.ico");
                if (File.Exists(icoPath)) { Icon = new System.Drawing.Icon(icoPath, 32, 32); ShowIcon = true; }
                else Icon = System.Drawing.SystemIcons.Application;
            }
            catch { Icon = System.Drawing.SystemIcons.Application; }
            Font = new System.Drawing.Font("Microsoft YaHei UI", 9F);
            wv = new WebView2 { Dock = DockStyle.Fill };
            Controls.Add(wv);
            InitWeb();
            Shown += (s, e) => { InitTray(); CheckDueReminder(); };
        }

        async void InitWeb()
        {
            try
            {
                string udf = Path.Combine(HostBridge.UserDataDir, "wv2-profile");
                HostBridge.Log("creating env, udf=" + udf);
                /* 2026-10-12（搬迁工作区后实测）：只靠环境变量 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
                   传调试参数，**新用户数据目录下不再生效**（9223 起不来，测试门禁的 CDP 步骤卡住）。
                   改为显式读该环境变量并塞进 CoreWebView2EnvironmentOptions；
                   环境变量为空时 opts=null ⇒ **日常使用行为与原来完全一致**，只是给开发/测试留了可靠开关。 */
                string extraArgs = Environment.GetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS");
                CoreWebView2EnvironmentOptions envOpts = string.IsNullOrEmpty(extraArgs)
                    ? null
                    : new CoreWebView2EnvironmentOptions { AdditionalBrowserArguments = extraArgs };
                if (envOpts != null) HostBridge.Log("extra browser args: " + extraArgs);
                /* ★ 2026-10-30 加：用户数据目录「一个不行换下一个」，且每条失败都留痕。
                   事件（用户 2026-10-30 报障，两张截图）：①双击先被 Windows SmartScreen 拦住
                   （「Windows 已保护你的电脑…发行者 CTB Local Signer」）；②放行后弹
                   「拾光小册 · 初始化失败 / 请求的资源在使用中。(异常来自 HRESULT:0x800700AA)」。
                   实测根因**不是**"目录被别的进程锁着"（当时的排查第一反应，已排除：没有第二个
                   实例、没有 msedgewebview2 子进程、profile 里也没有被独占的句柄）：
                   运行区目录（程序根 `app\` 的上一级）整棵树被打了 Windows **低强制性完整性标签**
                   （S:AI(ML;OICIID;NW;;;LW)，DSH 文件沙箱授权的常驻副作用，会继承给新写入文件），
                   于是 拾光小册.exe 也带低标签 ⇒ 进程以**低完整性**跑（实测令牌 IL=0x1000）
                   ⇒ 写不了中完整性的 %LOCALAPPDATA% ⇒ WebView2 建不出用户数据目录，
                   报出来的就是 0x800700AA/ERROR_BUSY。同一原因也让 shell.log 写不进去。
                   对照实验：把同一份 app 复制到不带标签的目录、标签置 Medium，进程 IL=0x2000，
                   WebView2 正常 ready ⇒ 单一根因、两个症状。
                   所以这里加的是**可诊断性**而不是"绕过"：候选目录逐个试，每次失败把路径 +
                   异常类型 + HRESULT 写进日志，再用最后一条异常走原有失败弹窗。 */
                var udfCandidates = new List<string> { udf, Path.Combine(HostBridge.AppRoot, "wv2-profile") };
                Exception lastEnvErr = null;
                foreach (string cand in udfCandidates)
                {
                    try
                    {
                        if (cand != udf) HostBridge.Log("creating env（降级重试）, udf=" + cand);
                        env = await CoreWebView2Environment.CreateAsync(null, cand, envOpts);
                        await wv.EnsureCoreWebView2Async(env);
                        if (cand != udf) HostBridge.Log("已降级到备用用户数据目录：" + cand);
                        lastEnvErr = null;
                        break;
                    }
                    catch (Exception ex)
                    {
                        lastEnvErr = ex;
                        HostBridge.Log("creating env FAILED at " + cand + " : " + ex.GetType().Name + ": " + ex.Message
                            + " (HRESULT=0x" + (ex.HResult & 0xFFFFFFFF).ToString("X8") + ")");
                    }
                }
                if (lastEnvErr != null) throw lastEnvErr;
                HostBridge.Log("webview ready");
                wv.CoreWebView2.WebMessageReceived += OnWebMessage;
                await wv.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(
                    "window.ctbHost={postMessage:function(s){window.chrome.webview.postMessage(s);}};");
                /* ★ 2026-10-29（R2 SC-09）：把端口真源解析出来的值**注入页面**。
                   为什么必须由壳注入：页面是 file:// 打开的 —— 不能 fetch 本地 json、不能 import
                   Node 模块，只能靠注入（与本仓 `版本.js` 注入 window.__GNOTE_VERSION__ 同一手法）。
                   覆盖顺序仍是：?ctbPort= → localStorage → 这里的注入值 → location.port（服务端模式）。 */
                string srvPort = HostBridge.ResolveSrvPort();
                if (!string.IsNullOrEmpty(srvPort))
                    await wv.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(
                        "window.__ctbPortDefault='" + srvPort + "';");
                /* 前端入口：新布局就在程序根（app\index.html）；老布局在 app\v2\index.html，一并兼容。 */
                string homePath = Path.Combine(HostBridge.AppRoot, "index.html");
                if (!File.Exists(homePath)) homePath = Path.Combine(HostBridge.AppRoot, "v2", "index.html");
                if (!File.Exists(homePath)) throw new Exception("找不到界面文件：期望 " + Path.Combine(HostBridge.AppRoot, "index.html") + "（程序目录不完整？）");
                string home = new Uri(homePath).AbsoluteUri;
                /* ★ 2026-10-29（R2 SC-09/SC-07 端口真源收敛）：端口不再在本文件写死。
                   真源 = 程序根 `端口.json` 的 default，CTB_PORT 环境变量优先（见 ResolveSrvPort）。
                   C# 不能 import 前端/Node 的模块 ⇒ 走"一处 JSON 真源 + 各方读取"。
                   真源读不到 ⇒ **不猜**：srvPrefix 置空 ⇒ 下方 NavigationStarting 关掉整个 http 白名单
                   （fail-loud 记日志 + fail-safe 拒绝），而不是退回一个写死的默认端口。 */
                string srvPrefix = string.IsNullOrEmpty(srvPort) ? null : "http://127.0.0.1:" + srvPort;
                HostBridge.Log("navigation whitelist = " + (srvPrefix ?? "(关闭：端口真源不可读)"));
                wv.CoreWebView2.NavigationStarting += (s, e) =>
                {
                    string u = e.Uri;
                    if (u.StartsWith("http", StringComparison.OrdinalIgnoreCase))
                    {
                        if (srvPrefix == null) { HostBridge.Log("REJECT http nav（端口真源不可读）：" + u); e.Cancel = true; return; }
                        if (!u.StartsWith(srvPrefix, StringComparison.OrdinalIgnoreCase)) e.Cancel = true;
                        return;
                    }
                    if (u.StartsWith("file:", StringComparison.OrdinalIgnoreCase))
                    {
                        string p = LocalLinks.FileUriToPath(u);
                        if (p != null && LocalLinks.NormalizePath(p) == LocalLinks.NormalizePath(homePath)) return;
                        e.Cancel = true;
                        LocalLinks.Dispatch(this, env, u);
                    }
                };
                wv.CoreWebView2.NewWindowRequested += (s, e) => { e.Handled = true; LocalLinks.Dispatch(this, env, e.Uri); };

                /* ★ 2026-10-12 开发期禁用缓存（修"改了 JS 不生效"，实测踩到）。
                   起因：改了 v2\js\host.js 后重跑门禁，页面仍在用**旧脚本** ——
                   `file://` 下 WebView2 照样缓存 JS/CSS。表现极隐蔽：门禁 FAIL 里显示的 URL
                   还带着本该已被修掉的旧拼接结果，让人以为"我的修复没写对"，
                   其实代码早就改了、只是没加载。
                   做法：`CTB_DEV=1` 时调用 `CoreWebView2.Profile.ClearBrowsingDataAsync`
                   把磁盘缓存清掉（对 <script>/<img>/<link> 全部生效，不只是 fetch）。
                   日常使用不加该环境变量 ⇒ 行为与从前完全一致（仍走缓存，启动更快）。 */
                bool devMode = string.Equals(Environment.GetEnvironmentVariable("CTB_DEV"), "1", StringComparison.OrdinalIgnoreCase);
                if (devMode)
                {
                    try
                    {
                        wv.CoreWebView2.Profile.ClearBrowsingDataAsync(
                            Microsoft.Web.WebView2.Core.CoreWebView2BrowsingDataKinds.DiskCache).Wait(3000);
                        HostBridge.Log("dev mode: 已清浏览缓存（CTB_DEV=1），确保加载最新 JS/CSS");
                    }
                    catch (Exception ex) { HostBridge.Log("dev mode 清缓存失败（不影响功能）：" + ex.Message); }
                }

                wv.CoreWebView2.Navigate(home);
                HostBridge.Log("navigated: " + home);
            }
            catch (Exception ex)
            {
                HostBridge.Log("InitWeb FAILED: " + ex);
                /* ★ 2026-10-30 加：失败提示要能直接指向"最可能的那种原因"，而不是只说删目录。
                   成因与实测过程见上面 CreateAsync 前那段注释（低完整性标签导致 0x800700AA）。
                   提示里同时带出「日志降级到哪」和「三个落点都写不进去时的原因」——
                   2026-10-30 那次排查最大的坑就是日志本身静默消失。 */
                var lines = new List<string>();
                lines.Add(ex.Message);
                lines.Add("");
                lines.Add("常见原因与处置：");
                lines.Add("· 请求的资源在使用中 / 0x800700AA：微信/浏览器等正在或曾经占用同一个数据目录，");
                lines.Add("  或本程序所在目录被 Windows 打上了「低强制性完整性标签」（这时进程权限不足，");
                lines.Add("  既建不了数据目录也写不了日志）。命令提示符里执行");
                lines.Add("     icacls \"<程序目录>\" /setintegritylevel (OI)(CI)M /T");
                lines.Add("  把整棵树恢复成中完整性即可；先确认路径再执行。");
                lines.Add("· 若反复失败：删除 %LOCALAPPDATA%\\拾光小册\\wv2-profile 后重开。");
                lines.Add("");
                lines.Add("日志：%LOCALAPPDATA%\\拾光小册\\shell.log（也可能降级写到程序目录）。");
                if (!string.IsNullOrEmpty(HostBridge.LastLogError)) lines.Add("日志状态：" + HostBridge.LastLogError);
                MessageBox.Show(string.Join("\r\n", lines.ToArray()), "拾光小册 · 初始化失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close();
            }
        }

        void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            string raw;
            try { raw = e.TryGetWebMessageAsString(); } catch { HostBridge.Log("webmessage: read failed"); return; }
            string id = HostBridge_Extract(raw, "id");
            string op = HostBridge_Extract(raw, "op");
            int pk = raw.IndexOf("\"payload\"");
            string payload = pk < 0 ? "{}" : ExtractObjectRaw(raw, pk);

            System.Threading.Tasks.Task.Run(() =>
            {
                string resp = null;
                if (op == "hello") resp = "{\"version\":\"" + EscJs(HostBridge.AppVersionString()) + "\",\"appRoot\":\"" + EscJs(HostBridge.AppRoot) + "\",\"dataRoot\":\"" + EscJs(HostBridge.DataRoot) + "\",\"port\":\"" + EscJs(HostBridge.ResolveSrvPort() ?? "") + "\"}";
                else if (op == "state") { string s = bridge.ReadState(); resp = s != null ? s : bridge.Rebuild(); }
                else if (op == "regen") resp = bridge.Rebuild();
                else if (op == "pendingResolve") resp = bridge.PendingResolve(payload);
                else if (op == "pendingAdd") resp = bridge.PendingAdd(payload);
                /* ★ 2026-10-23 新增：新建学生（空库第一步）。
                   起因（用户实测 BUG#1）：空库里没有任何地方能建"孩子"，新用户进门就堵死。 */
                else if (op == "createStudent") resp = bridge.CreateStudent(payload);
                else if (op == "mark") resp = bridge.Mark(payload);
                /* ★ 2026-10-27 新增：配方层通道（界面「录题」页）。
                   壳只做透明转发，配方逻辑全在 _配方.mjs —— 加一条反例不需要重编壳。 */
                else if (op == "recipe") resp = bridge.Recipe(payload);
                else if (op == "readFile") resp = bridge.ReadFile(payload);
                else if (op == "openFile")
                {
                    // 越界一律拒（F-03）：Path.Combine 对绝对路径「直接返回第二参」，不校验就能拿系统程序开任意 exe
                    string rel = ExtractStringTop(raw, "path"), abs, why;
                    if (!bridge.TryResolveInsideRoot(rel, out abs, out why))
                    {
                        HostBridge.Log("openFile REJECTED: " + rel + " ← " + why);
                        resp = "{\"ok\":false,\"error\":\"" + EscJs(why) + "\"}";
                    }
                    else
                    {
                        try { LocalLinks.Dispatch(this, env, new Uri(abs).AbsoluteUri); resp = "{\"ok\":true}"; }
                        catch (Exception ex) { resp = "{\"ok\":false,\"error\":\"" + EscJs(ex.Message) + "\"}"; }
                    }
                }
                else if (op == "revealFile")
                {
                    string rel = ExtractStringTop(raw, "path"), abs, why;
                    if (!bridge.TryResolveInsideRoot(rel, out abs, out why))
                    {
                        // 与 e2e「壳侧 revealFile op 已装载」探针同口径：越界也写 reveal FAILED，日志可被断言看见
                        HostBridge.Log("reveal FAILED [" + rel + "]: " + why);
                        resp = "{\"ok\":false,\"error\":\"" + EscJs(why) + "\"}";
                    }
                    else resp = LocalLinks.Reveal(abs) ? "{\"ok\":true}" : "{\"ok\":false,\"error\":\"资源管理器打不开该路径（文件不存在）\"}";
                }
                else if (op == "print")
                {
                    /* ⚠ 2026-10-11 新增（用户实测报障：「点打印，打印机不应答」）：
                       WebView2 里 `window.print()` 是**空操作** —— 打印对话框必须由宿主实现。
                       官方 API：ICoreWebView2_16::ShowPrintUI（WebView2 Win32 1.0.1518.46 起；
                       本仓 SDK 1.0.2903.40 / 运行时 153.x 均支持，见 WebView2.idl:3238）。
                       kind=system → 系统打印对话框（可直接选打印机）；kind=browser → 浏览器打印预览。
                       必须在 UI 线程调用。对话框是异步的：这里**立刻回执**（不等它关闭），
                       页面侧据回执决定何时清空打印区，避免把桥堵住 10 分钟。 */
                    try
                    {
                        string kind = ExtractStringTop(raw, "kind");
                        CoreWebView2PrintDialogKind dlg = (kind == "browser")
                            ? CoreWebView2PrintDialogKind.Browser
                            : CoreWebView2PrintDialogKind.System;
                        HostBridge.Log("print: ShowPrintUI(" + dlg + ")");
                        BeginInvoke((Action)(() =>
                        {
                            try
                            {
                                /* ⚠ .NET 包装里 ShowPrintUI 返回 **void**（不是 Task），不能 await；
                                   而且它在"对话框弹出"时就返回、**不是**等用户关掉它 ⇒ 页面侧**不能**靠回执去清空打印区
                                   （那样会在对话框还开着时把卷面清掉）。页面侧改为：壳通道下保留卷面不清，
                                   顺便让 Ctrl+P 这条退路也能印出正确内容。 */
                                wv.CoreWebView2.ShowPrintUI(dlg);
                                HostBridge.Log("print: dialog shown");
                            }
                            catch (Exception ex) { HostBridge.Log("print FAILED: " + ex.Message); }
                        }));
                        resp = "{\"ok\":true,\"mode\":\"showprintui\",\"kind\":\"" + EscJs(kind == "browser" ? "browser" : "system") + "\"}";
                    }
                    catch (Exception ex)
                    {
                        HostBridge.Log("print FAILED: " + ex.Message);
                        resp = "{\"ok\":false,\"error\":\"" + EscJs(ex.Message) + "\"}";
                    }
                }
                else if (op == "pdf")
                {
                    /* 2026-10-11 新增（用户报障「点打印没反应」的**根治性替代路**）：
                       用户目标是「打出来给孩子纸面重做」，而打印对话框能否成功还取决于打印机/驱动。
                       PrintToPdfAsync 把当前卷面直接写成 PDF —— **不依赖任何打印机**，
                       产物可用系统默认 PDF 阅读器打开再打印，也可存档/发到打印店。
                       路径必须落在题库根内（复用唯一实现 TryResolveInsideRoot，防越界写）。
                       PrintToPdfAsync 要在 UI 线程发起，而本分派跑在 Task.Run 里 ⇒
                       用 TaskCompletionSource + BeginInvoke 桥接，并**等它完成**再回执（页面才知道何时去打开文件）。 */
                    string rel = ExtractStringTop(raw, "path"), abs, why;
                    if (!bridge.TryResolveInsideRoot(rel, out abs, out why))
                    {
                        HostBridge.Log("pdf REJECTED: " + rel + " ← " + why);
                        resp = "{\"ok\":false,\"error\":\"" + EscJs(why) + "\"}";
                    }
                    else
                    {
                        try
                        {
                            string dir = Path.GetDirectoryName(abs);
                            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                            var tcs = new System.Threading.Tasks.TaskCompletionSource<bool>();
                            BeginInvoke((Action)(async () =>
                            {
                                try
                                {
                                    bool okPdf = await wv.CoreWebView2.PrintToPdfAsync(abs, null);
                                    HostBridge.Log("pdf: PrintToPdfAsync -> " + okPdf + " " + abs);
                                    tcs.TrySetResult(okPdf);
                                }
                                catch (Exception ex) { HostBridge.Log("pdf FAILED: " + ex.Message); tcs.TrySetException(ex); }
                            }));
                            if (!tcs.Task.Wait(60000)) resp = "{\"ok\":false,\"error\":\"生成 PDF 超时（60s）\"}";
                            else if (!tcs.Task.Result) resp = "{\"ok\":false,\"error\":\"PrintToPdfAsync 返回 false\"}";
                            else resp = "{\"ok\":true,\"path\":\"" + EscJs(rel) + "\",\"bytes\":\"" + (File.Exists(abs) ? new FileInfo(abs).Length : 0) + "\"}";
                        }
                        catch (Exception ex)
                        {
                            HostBridge.Log("pdf FAILED: " + ex.Message);
                            resp = "{\"ok\":false,\"error\":\"" + EscJs(ex.Message) + "\"}";
                        }
                    }
                }
                else if (op == "printDirect")
                {
                    /* 2026-10-11 新增（用户要求「像 Word/WPS 那样点一下就打」）：
                       WebView2 的 PrintAsync 直接打到指定打印机、**不弹任何对话框**，
                       这正是 Word/WPS 的体验；而 ShowPrintUI 只是打开预览、要用户再点一次打印。
                       实现要点：PrintSettings 来自 CoreWebView2Environment.CreatePrintSettings()；
                       不传 printer 就用系统默认打印机；PrintAsync 的返回值是打印状态枚举，
                       可直接区分「成功 / 打印机不可用 / 其他错误」，便于如实回执给页面。 */
                    try
                    {
                        string want = ExtractStringTop(raw, "printer");
                        var tcsP = new System.Threading.Tasks.TaskCompletionSource<string>();
                        BeginInvoke((Action)(async () =>
                        {
                            try
                            {
                                var ps = env.CreatePrintSettings();
                                if (string.IsNullOrEmpty(want))
                                {
                                    /* 不传名字时必须解析**系统默认打印机名**：
                                       PrintAsync 需要明确的 PrinterName，空名字会被判无效设置 ⇒ OtherError + 0 页空作业（实测）。 */
                                    try { want = new System.Drawing.Printing.PrinterSettings().PrinterName; }
                                    catch (Exception ex2) { HostBridge.Log("printDirect: 取默认打印机失败 " + ex2.Message); }
                                }
                                if (!string.IsNullOrEmpty(want)) ps.PrinterName = want;
                                else HostBridge.Log("printDirect: 警告——没拿到打印机名，可能失败");
                                /* 实测：只设 PrinterName 时 status=OtherError（1.5 秒即返回 ⇒ 被快速判为"设置对该打印机无效"，
                                   官方文档口径：E_INVALIDARG + OTHER_ERROR）。怀疑默认页面尺寸/边距对这个 IPP 类驱动无效，
                                   所以显式给 A4 与常规边距/缩放（单位：英寸）。 */
                                try
                                {
                                    ps.PageWidth = 8.27;      // A4 210mm
                                    ps.PageHeight = 11.69;    // A4 297mm
                                    ps.MarginTop = 0.4; ps.MarginBottom = 0.4; ps.MarginLeft = 0.4; ps.MarginRight = 0.4;
                                    ps.ScaleFactor = 1.0;
                                    ps.ShouldPrintBackgrounds = true;
                                    ps.ShouldPrintHeaderAndFooter = false;
                                    HostBridge.Log("printDirect: 已设 A4 " + ps.PageWidth + "x" + ps.PageHeight + " in, bg=" + ps.ShouldPrintBackgrounds);
                                }
                                catch (Exception ex3) { HostBridge.Log("printDirect: 设打印参数失败 " + ex3.Message); }
                                HostBridge.Log("printDirect: PrintAsync printer=" + (string.IsNullOrEmpty(want) ? "(default)" : want));
                                var status = await wv.CoreWebView2.PrintAsync(ps);
                                HostBridge.Log("printDirect: status=" + status);
                                tcsP.TrySetResult(status.ToString());
                            }
                            catch (Exception ex) { HostBridge.Log("printDirect FAILED: " + ex.Message); tcsP.TrySetException(ex); }
                        }));
                        if (!tcsP.Task.Wait(180000)) resp = "{\"ok\":false,\"error\":\"直接打印超时（180s）\"}";
                        else resp = "{\"ok\":true,\"status\":\"" + EscJs(tcsP.Task.Result) + "\"}";
                    }
                    catch (Exception ex)
                    {
                        HostBridge.Log("printDirect FAILED: " + ex.Message);
                        resp = "{\"ok\":false,\"error\":\"" + EscJs(ex.Message) + "\"}";
                    }
                }
                else if (op == "printPdf")
                {
                    /* 2026-10-11 新增：**把已生成的 PDF 交给系统打印** —— 用户要的「像 Word/WPS 点一下就出纸」。
                       为什么不用 WebView2 的 PrintAsync：实测在本机恒定 status=OtherError 且生成 0 字节空作业
                       （显式传打印机名 + A4 参数后仍失败）；而 PrintToPdfAsync 同内容却正常。
                       为什么用 shell 的 print 动词：本机 .pdf 关联到 KWPS.PDF.9，其注册表里**有 print 动词**
                       （wps.exe /prometheus /pdf /n /p "%1"）。实测用它打印那份 963KB 重做卷，
                       打印机自身计数器 TotalImpressions 7965→7968（**真的印了 3 页**）。
                       路径必须落在题库根内（复用唯一实现 TryResolveInsideRoot）。 */
                    string rel = ExtractStringTop(raw, "path"), abs, why;
                    if (!bridge.TryResolveInsideRoot(rel, out abs, out why))
                    {
                        HostBridge.Log("printPdf REJECTED: " + rel + " ← " + why);
                        resp = "{\"ok\":false,\"error\":\"" + EscJs(why) + "\"}";
                    }
                    else if (!File.Exists(abs)) resp = "{\"ok\":false,\"error\":\"PDF 不存在：" + EscJs(rel) + "\"}";
                    else
                    {
                        try
                        {
                            var psi = new System.Diagnostics.ProcessStartInfo(abs);
                            psi.Verb = "print";
                            psi.UseShellExecute = true;
                            System.Diagnostics.Process.Start(psi);
                            HostBridge.Log("printPdf: shell print verb -> " + abs);
                            resp = "{\"ok\":true,\"mode\":\"shell-print-verb\",\"path\":\"" + EscJs(rel) + "\"}";
                        }
                        catch (Exception ex)
                        {
                            HostBridge.Log("printPdf FAILED: " + ex.Message);
                            resp = "{\"ok\":false,\"error\":\"" + EscJs(ex.Message) + "\"}";
                        }
                    }
                }
                else if (op == "quit")
                {
                    resp = "{\"ok\":true}";
                    BeginInvoke((Action)(() => { try { if (tray != null) tray.Visible = false; } catch { } Application.Exit(); }));
                }
                else resp = "{\"ok\":false,\"error\":\"unknown op\"}";
                if (resp == null) return;
                HostBridge.Log("responding id=" + id + " op=" + op + " bytes=" + resp.Length);
                BeginInvoke((Action)(() => PostToWeb(id, resp)));
            });
        }

        // PostWebMessageAsJson 有 1MB 硬限（_状态.json 已 1.3MB+，还会涨）→ 大响应切片传输，页面侧重组。
        // 预算按 **UTF-8 字节数**算（F-02）：题库中文/emoji 占比高时「字符数」会低估真实体积，且 Esc 把 " 变 \" 还会再胀一倍。
        const int MSG_LIMIT_BYTES = 256 * 1024;
        void PostToWeb(string id, string resp)
        {
            try
            {
                if (resp == null) return;
                int bytes = Encoding.UTF8.GetByteCount(resp);
                if (bytes <= MSG_LIMIT_BYTES)
                {
                    wv.CoreWebView2.PostWebMessageAsJson("{\"ctb\":\"resp\",\"id\":\"" + id + "\",\"ok\":true,\"data\":" + resp + "}");
                    return;
                }
                var parts = HostBridge.SplitByByteBudget(resp, MSG_LIMIT_BYTES);
                int n = parts.Count;   // n = **实际片数**（旧实现按算出来的原 n 发、len-- 后游标多走 1 ⇒ 尾部静默丢字符，F-01）
                for (int i = 0; i < n; i++)
                {
                    wv.CoreWebView2.PostWebMessageAsJson("{\"ctb\":\"resp-part\",\"id\":\"" + id + "\",\"i\":" + i + ",\"n\":" + n + ",\"part\":\"" + HostBridge.Esc(parts[i]) + "\"}");
                }
                HostBridge.Log("posted CHUNKED id=" + id + " chars=" + resp.Length + " bytes=" + bytes + " parts=" + n);
            }
            catch (Exception ex) { HostBridge.Log("post failed: " + ex.Message); }
        }

        // 复用桥小工具（静态壳方法薄封装，避免把解析器设为 public 后到处调）
        static string HostBridge_Extract(string json, string key)
        {
            string pat = "\"" + key + "\"";
            int k = json.IndexOf(pat, StringComparison.Ordinal);
            if (k < 0) return "";
            int colon = json.IndexOf(':', k + pat.Length);
            int q1 = json.IndexOf('"', colon + 1);
            if (q1 < 0) return "";
            int q2 = json.IndexOf('"', q1 + 1);
            return q2 < 0 ? "" : json.Substring(q1 + 1, q2 - q1 - 1);
        }
/// <summary>与 ExtractString 同源。旧版比它还差一档：连反斜杠都不还原
        /// （路径含 \ 时得到 a\\b 错路径、含引号时被截断成"含\"）。现统一走 TryReadJsonString。</summary>
        static string ExtractStringTop(string json, string key)
        {
            string v;
            return HostBridge.TryReadJsonString(json, key, out v) ? v : "";
        }
        static string ExtractObjectRaw(string json, int from)
        {
            int c = json.IndexOf('{', from);
            if (c < 0) return "{}";
            int depth = 0; bool inStr = false, esc = false;
            for (int i = c; i < json.Length; i++)
            {
                char ch = json[i];
                if (inStr) { if (esc) esc = false; else if (ch == '\\') esc = true; else if (ch == '"') inStr = false; continue; }
                if (ch == '"') inStr = true;
                else if (ch == '{') depth++;
                else if (ch == '}') { depth--; if (depth == 0) return json.Substring(c, i - c + 1); }
            }
            return "{}";
        }
/// <summary>把字符串塞进 JSON 字面量位置时做最小转义。
        /// ⚠ 2026-10-12 修（审计 BUG-17·中）：原实现只处理 \ / " / CR / LF，
        /// **漏掉 TAB、BS、NUL 等其余控制字符**；而 JSON.parse 对裸控制字符一律 THROWS。
        /// 调用点里 `why`（越界拒绝原因）含**前端可控的 rel**、ex.Message 含文件路径，
        /// 一旦带 TAB，壳回执就是非法 JSON ⇒ 前端 host.js 的 catch 吞掉后该请求
        /// 既不 resolve 也不 reject ⇒ 一直卡到 30 秒超时。同文件的 Esc（:414）早就做全了，
        /// 这里纯属漏网。现按同一口径：所有 &lt;0x20 走 \u00XX。</summary>
        static string EscJs(string s)
        {
            if (s == null) return "";
            var sb = new StringBuilder();
            foreach (char c in s)
            {
                switch (c)
                {
                    case '\\': sb.Append("\\\\"); break;
                    case '"': sb.Append("\\\""); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    default:
                        if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            return sb.ToString();
        }

        // ---- 托盘 ----
        void InitTray()
        {
            System.Drawing.Icon trayIcon = null;
            try
            {
                string icoPath = Path.Combine(HostBridge.AppRoot, "ctb.ico");
                if (!File.Exists(icoPath)) icoPath = Path.Combine(HostBridge.AppRoot, "_桌面v2", "ctb.ico");
                if (File.Exists(icoPath)) trayIcon = new System.Drawing.Icon(icoPath, 16, 16);
            }
            catch { }
            tray = new NotifyIcon { Icon = trayIcon ?? System.Drawing.SystemIcons.Shield, Text = "拾光小册 · 双击打开", Visible = true };
            var menu = new ContextMenuStrip();
            menu.Items.Add("打开拾光小册", null, (s, e) => RestoreFromTray());
            menu.Items.Add("刷新数据（只读重进）", null, (s, e) => { try { wv.CoreWebView2.PostWebMessageAsJson("{\"ctb\":\"evt\",\"evt\":\"refresh\"}"); } catch { } });
            menu.Items.Add("全量重建（约 10 秒，后台跑）", null, (s, e) =>
            {
                System.Threading.Tasks.Task.Run(() =>
                {
                    bridge.Rebuild();
                    try { BeginInvoke((Action)(() => { try { wv.CoreWebView2.PostWebMessageAsJson("{\"ctb\":\"evt\",\"evt\":\"refresh\"}"); } catch { } })); } catch { }
                });
            });
            menu.Items.Add("重载界面", null, (s, e) => wv.CoreWebView2.Reload());
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("退出", null, (s, e) => { tray.Visible = false; Application.Exit(); });
            tray.ContextMenuStrip = menu;
            tray.DoubleClick += (s, e) => RestoreFromTray();
            uint msg = NativeMethods.RegisterWindowMessage("TaskbarCreated");
            NativeMethods.TaskbarCreatedMsg = msg;
            new RestoreTrayHelper(tray, this);
        }
        internal class NativeMethods
        {
            [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint RegisterWindowMessage(string m);
            public static uint TaskbarCreatedMsg;
        }
        internal class RestoreTrayHelper : System.Windows.Forms.NativeWindow
        {
            NotifyIcon tray; ShellForm form;
            public RestoreTrayHelper(NotifyIcon t, ShellForm f) { tray = t; form = f; this.CreateHandle(new CreateParams()); }
            protected override void WndProc(ref Message m)
            {
                if (NativeMethods.TaskbarCreatedMsg != 0 && m.Msg == (int)NativeMethods.TaskbarCreatedMsg)
                { try { tray.Visible = false; tray.Visible = true; } catch { } }
                base.WndProc(ref m);
            }
        }
        public void RestoreFromTray()
        {
            if (!Visible) Show();
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Maximized;
            Activate();
        }
        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            base.OnFormClosing(e);
            if (tray != null) tray.Visible = false;
        }

        // ---- 到期气泡提醒（与 v1 同语义，独立 dueNotified）----
        void CheckDueReminder()
        {
            var t = new System.Windows.Forms.Timer { Interval = 90000 };
            t.Tick += (s, e) =>
            {
                t.Stop();
                if (dueNotified) return;
                dueNotified = true;
                try
                {
                    string stateJson = bridge.ReadState();
                    if (stateJson == null) return;
                    int due = CountDue(stateJson);
                    if (due > 0) tray.ShowBalloonTip(5000, "拾光小册 · 复习提醒", "今天有 " + due + " 题到建议复习日，开复习流清一清。", ToolTipIcon.Info);
                }
                catch { }
            };
            t.Start();
        }
        static int CountDue(string stateJson)
        {
            int due = 0;
            string today = DateTime.Now.ToString("yyyy-MM-dd");
            int i = 0;
            while ((i = stateJson.IndexOf("\"nextDue\":", i, StringComparison.Ordinal)) >= 0)
            {
                int q1 = stateJson.IndexOf('"', i + 10);
                if (q1 < 0) break;
                int q2 = stateJson.IndexOf('"', q1 + 1);
                if (q2 < 0) break;
                string d = stateJson.Substring(q1 + 1, q2 - q1 - 1);
                if (d.Length == 10 && string.CompareOrdinal(d, today) <= 0) due++;
                i = q2;
            }
            return due;
        }

        /* ★ 全局崩溃兜底（2026-10-12 加）—— 这是"崩了不留痕"的根治。
           改之前：grep ThreadException|UnhandledException 零命中，Main() 外无 try。
           UI 线程上任何未捕获异常 ⇒ 进程直接闪退，**不弹窗、不写日志、不留 dump**，
           用户只看到"程序自己关掉了"，原因随之消失（复现不了也修不了）。
           现在三道兜底：
             ① UI 线程未捕获异常（ThreadException）—— 写完整日志 + 弹可读提示（含日志路径）+ 不吞掉后续
             ② 非 UI 线程/无法捕获的（AppDomain.UnhandledException）—— 写日志 + 记录是否终止
             ③ Main() 整体包 try —— 启动期异常（窗口构造失败等）也能留痕并提示
           提示里给"打开日志目录"的按钮：让用户能直接把原因交回来。 */
        /* ⚠ 安装时机（实测踩到，勿改）：SetUnhandledExceptionMode **必须在创建任何控件之前**调用，
           否则抛 InvalidOperationException："只要在线程上创建了任何控件，则线程异常模式将不能再有任何更改。"
           （2026-10-12 首次实机启动即命中，此前只在非实机路径上编译过。）
           所以拆成两半：Main() 里先设模式，再构造窗口，最后挂事件。 */
        static void SetExceptionMode()
        {
            try { Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException); }
            catch (Exception ex) { try { HostBridge.Log("[崩溃兜底] SetUnhandledExceptionMode 失败（模式沿用默认）：" + ex.Message); } catch { } }
        }

        static void InstallCrashHandlers(ShellForm form)
        {
            // 模式已在 Main() 里设好（见 SetExceptionMode 的注释）；这里只挂事件
            Application.ThreadException += (s, e) =>
            {
                try
                {
                    HostBridge.Log("=== 未捕获异常（UI 线程）===\r\n" + e.Exception);
                }
                catch { }
                try
                {
                    MessageBox.Show(form,
                        "拾光小册遇到一个问题，已记下详细信息：\r\n\r\n" +
                        (e.Exception != null ? e.Exception.Message : "(无消息)") +
                        "\r\n\r\n点击「是」打开日志目录，把它连同现象告诉我。\r\n数据不会因此损坏（写入走原子写 + 写前备份）。",
                        "拾光小册", MessageBoxButtons.YesNo, MessageBoxIcon.Error);
                    string logDir = HostBridge.UserDataDir;
                    try { if (form != null && form.IsHandleCreated) LocalLinks.Reveal(logDir); } catch { }
                }
                catch { }
            };
            AppDomain.CurrentDomain.UnhandledException += (s, e) =>
            {
                try
                {
                    var ex = e.ExceptionObject as Exception;
                    HostBridge.Log("=== 未捕获异常（AppDomain，IsTerminating=" + e.IsTerminating + "）===\r\n" + (ex != null ? ex.ToString() : e.ExceptionObject));
                }
                catch { }
            };
        }

        [STAThread]
        static void Main()
        {
            try
            {
                bool createdNew;
                using (var mutex = new System.Threading.Mutex(true, "CTBShellV2_SingleInstance", out createdNew))
                using (var wake = new System.Threading.EventWaitHandle(false, System.Threading.EventResetMode.AutoReset, "CTBShellV2_Wake"))
                {
                    if (!createdNew) { wake.Set(); return; }
                    ShellForm form = null;
                    System.Threading.ThreadPool.RegisterWaitForSingleObject(wake,
                        (s, t) => { try { if (form != null && form.IsHandleCreated) form.BeginInvoke((Action)(() => form.RestoreFromTray())); } catch { } },
                        null, -1, false);
                    Application.EnableVisualStyles();
                    Application.SetCompatibleTextRenderingDefault(false);
                    try
                    {
                        SetExceptionMode();       // 必须在 new ShellForm() 之前（会创建控件）
                        form = new ShellForm();
                    }
                    catch (Exception ex)   // 窗口构造期失败（缺 WebView2 运行时等）：留痕 + 说清怎么办
                    {
                        HostBridge.Log("=== 启动失败（窗口构造）===\r\n" + ex);
                        MessageBox.Show(
                            "拾光小册启动失败：\r\n\r\n" + ex.Message +
                            "\r\n\r\n日志：\r\n" + Path.Combine(HostBridge.UserDataDir, "shell.log") +
                            "\r\n\r\n若提示缺少 WebView2 运行时，请先安装微软官方 Evergreen Runtime 后重试。",
                            "拾光小册", MessageBoxButtons.OK, MessageBoxIcon.Error);
                        return;
                    }
                    InstallCrashHandlers(form);
                    Application.Run(form);
                }
            }
            catch (Exception ex)
            {
                try { HostBridge.Log("=== Main 致命异常 ===\r\n" + ex); } catch { }
                try
                {
                    MessageBox.Show("拾光小册遇到严重问题：\r\n\r\n" + ex.Message +
                        "\r\n\r\n详细信息已写入 _桌面v2/shell-v2.log",
                        "拾光小册", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
                catch { }
            }
        }
    }

    // ============================================================================
    // 本地文件分发 + 内置 md 阅读器（与 v1 同实现；v2 独立一份，互不影响）
    // ============================================================================
    public static class LocalLinks
    {
        static void Log(string s) { HostBridge.Log(s); }
        public static string NormalizePath(string p)
        {
            try { return Path.GetFullPath(p).TrimEnd('\\', '/'); } catch { return p ?? ""; }
        }
        public static string FileUriToPath(string uri)
        {
            if (string.IsNullOrEmpty(uri)) return null;
            try { var u = new Uri(uri); if (u.IsFile && u.LocalPath.Length > 0) return u.LocalPath; } catch { }
            try
            {
                string s = uri;
                int colon = s.IndexOf(':');
                if (colon >= 0) s = s.Substring(colon + 1);
                if (s.StartsWith("///")) s = s.Substring(2);
                else if (s.StartsWith("//")) { int k = s.IndexOf('/', 2); s = (k < 0) ? "" : s.Substring(k); }
                s = Uri.UnescapeDataString(s);
                if (s.StartsWith("/") && s.Length > 2 && s[2] == ':') s = s.Substring(1);
                return s.Replace('/', '\\');
            }
            catch { return null; }
        }
        /* 在资源管理器里选中该文件（灯箱 📁 位置 按钮）。
           失败**不弹模态框**：返回 false 让页面自己 toast——测试门禁也要调这条，弹窗会把自动化卡死。 */
        public static bool Reveal(string relOrAbs)
        {
            string full = relOrAbs ?? "";
            try
            {
                if (string.IsNullOrEmpty(full)) throw new FileNotFoundException("空路径");
                if (!Path.IsPathRooted(full)) full = Path.Combine(HostBridge.DataRoot, full.Replace('/', Path.DirectorySeparatorChar));
                full = Path.GetFullPath(full);
                ProcessStartInfo psi;
                if (File.Exists(full)) psi = new ProcessStartInfo { FileName = "explorer.exe", Arguments = "/select,\"" + full + "\"", UseShellExecute = true };
                else if (Directory.Exists(full)) psi = new ProcessStartInfo { FileName = full, UseShellExecute = true };
                else throw new FileNotFoundException("找不到：" + full);
                Process.Start(psi);
                Log("reveal OK: " + full);
                return true;
            }
            catch (Exception ex) { Log("reveal FAILED [" + full + "]: " + ex.Message); return false; }
        }
        public static void Dispatch(Form owner, CoreWebView2Environment env, string uri)
        {
            try
            {
                if (string.IsNullOrEmpty(uri)) { Log("dispatch: empty uri"); return; }
                if (uri.StartsWith("http", StringComparison.OrdinalIgnoreCase)) { OpenWithSystem(owner, uri); return; }
                if (!uri.StartsWith("file:", StringComparison.OrdinalIgnoreCase)) { Log("dispatch: 不支持的 URI " + uri); return; }
                string p = FileUriToPath(uri);
                if (string.IsNullOrEmpty(p)) { Log("dispatch: 解码失败 " + uri); Warn(owner, "打不开：无法解析路径\n" + uri); return; }
                if (!File.Exists(p)) { Log("dispatch: 文件不存在 " + p); Warn(owner, "打不开：文件不存在\n" + p); return; }
                if (p.EndsWith(".md", StringComparison.OrdinalIgnoreCase))
                {
                    try
                    {
                        string md = File.ReadAllText(p, Encoding.UTF8);
                        string name = Path.GetFileName(Path.GetDirectoryName(p));
                        new ViewerForm(env, Md.ToHtml(md, name, RelPath(p))).Show();
                        Log("md viewer opened: " + p);
                        return;
                    }
                    catch (Exception ex) { Log("md viewer FAILED: " + ex.Message); }
                }
                OpenWithSystem(owner, p);
            }
            catch (Exception ex) { Log("dispatch FAILED [" + uri + "]: " + ex); Warn(owner, ex.Message); }
        }
        public static string RelPath(string path)
        {
            try
            {
                string baseDir = NormalizePath(HostBridge.DataRoot);
                string full = NormalizePath(path);
                if (full.Length > baseDir.Length && full.StartsWith(baseDir, StringComparison.OrdinalIgnoreCase))
                    return full.Substring(baseDir.Length).TrimStart('\\', '/');
                return full;
            }
            catch { return path; }
        }
        public static void OpenWithSystem(Form owner, string target)
        {
            try { Process.Start(new ProcessStartInfo { FileName = target, UseShellExecute = true }); Log("openWithSystem OK: " + target); }
            catch (Exception ex) { Log("openWithSystem FAILED [" + target + "]: " + ex.Message); Warn(owner, "系统程序打不开：\n" + target + "\n\n" + ex.Message); }
        }
        static void Warn(Form owner, string msg)
        {
            try
            {
                if (owner != null && owner.IsHandleCreated) owner.BeginInvoke((Action)(() => MessageBox.Show(owner, msg, "拾光小册 · 打开失败", MessageBoxButtons.OK, MessageBoxIcon.Warning)));
                else MessageBox.Show(msg, "拾光小册 · 打开失败", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
            catch { }
        }
    }

    // 极简 Markdown → HTML（与 v1 同语义：只有「| 开头 + 次行分隔行」才算表，其余绝不丢行）
    public static class Md
    {
        static string Esc(string s) { return (s ?? "").Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;"); }
        static string Inline(string s)
        {
            s = Esc(s);
            s = Regex.Replace(s, @"\*\*([^*]+)\*\*", "<strong>$1</strong>");
            s = Regex.Replace(s, @"`([^`]+)`", "<code>$1</code>");
            return s;
        }
        static List<string> Cells(string line)
        {
            string t = line.Trim().Trim('|');
            var cells = new List<string>();
            foreach (string c in t.Split('|')) cells.Add(c.Trim());
            return cells;
        }
        static bool IsTableSep(string line)
        {
            string t = line.Trim();
            if (!t.StartsWith("|")) return false;
            return Regex.IsMatch(t, @"^\|[\s:\-|]+\|$");
        }
        const string CSS =
            "<style>:root{color-scheme:light dark}*{box-sizing:border-box}"
          + "body{margin:0;padding:26px 30px;background:#f5f7fc;color:#1b2233;font:15px/1.85 'Microsoft YaHei UI',system-ui,sans-serif}"
          + ".wrap{max-width:880px;margin:0 auto;background:#fff;border:1px solid #e4e9f2;border-radius:14px;padding:26px 30px}"
          + "h1{font-size:22px;border-bottom:2px solid #eaf0ff;padding-bottom:8px}h2{font-size:16.5px;border-left:4px solid #5f7cf9;padding-left:9px}"
          + "blockquote{background:#f0f4ff;border-left:4px solid #7d97ff;padding:8px 14px;border-radius:0 8px 8px 0}"
          + "table{border-collapse:collapse}th,td{border:1px solid #dfe5f0;padding:6px 11px}th{background:#eef2f9}"
          + "@media (prefers-color-scheme:dark){body{background:#0a0f1e;color:#dfe5f2}.wrap{background:#141b2e;border-color:#243053}th{background:#1c2543}}</style>";
        public static string ToHtml(string md, string name, string relPath)
        {
            return "<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'><title>" + Esc(name) + " · 错题记录</title>" + CSS
              + "</head><body><div class='wrap'>" + Body(md) + "</div></body></html>";
        }
        public static string Body(string md)
        {
            string[] lines = (md ?? "").Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');
            var sb = new StringBuilder();
            int i = 0;
            while (i < lines.Length)
            {
                string L = lines[i];
                if (L.Trim().Length == 0) { i++; continue; }
                if (Regex.IsMatch(L, @"^-{3,}\s*$")) { sb.Append("<hr>"); i++; continue; }
                if (L.TrimStart().StartsWith("|") && i + 1 < lines.Length && IsTableSep(lines[i + 1]))
                {
                    sb.Append("<table><thead><tr>");
                    foreach (string c in Cells(L)) sb.Append("<th>").Append(Inline(c)).Append("</th>");
                    sb.Append("</tr></thead><tbody>");
                    i += 2;
                    while (i < lines.Length && lines[i].TrimStart().StartsWith("|"))
                    {
                        var cs = Cells(lines[i]);
                        if (cs.Count == 1 && cs[0].Length == 0) { i++; continue; }
                        sb.Append("<tr>");
                        foreach (string c in cs) sb.Append("<td>").Append(Inline(c)).Append("</td>");
                        sb.Append("</tr>");
                        i++;
                    }
                    sb.Append("</tbody></table>");
                    continue;
                }
                Match hm = Regex.Match(L, @"^\s*(#{1,6})\s+(.*)$");
                if (hm.Success) { int lv = hm.Groups[1].Value.Length; sb.Append("<h").Append(lv).Append('>').Append(Inline(hm.Groups[2].Value)).Append("</h").Append(lv).Append('>'); i++; continue; }
                if (L.TrimStart().StartsWith(">"))
                {
                    var q = new List<string>();
                    while (i < lines.Length && lines[i].TrimStart().StartsWith(">"))
                    {
                        string t = lines[i].TrimStart().Substring(1);
                        if (t.StartsWith(" ")) t = t.Substring(1);
                        q.Add(Inline(t)); i++;
                    }
                    sb.Append("<blockquote>").Append(string.Join("<br>", q.ToArray())).Append("</blockquote>");
                    continue;
                }
                if (Regex.IsMatch(L, @"^\s*\d+\.\s"))
                {
                    sb.Append("<ol>");
                    while (i < lines.Length && Regex.IsMatch(lines[i], @"^\s*\d+\.\s")) { sb.Append("<li>").Append(Inline(Regex.Replace(lines[i], @"^\s*\d+\.\s", ""))).Append("</li>"); i++; }
                    sb.Append("</ol>");
                    continue;
                }
                if (Regex.IsMatch(L, @"^\s*[-*+]\s"))
                {
                    sb.Append("<ul>");
                    while (i < lines.Length && Regex.IsMatch(lines[i], @"^\s*[-*+]\s")) { sb.Append("<li>").Append(Inline(Regex.Replace(lines[i], @"^\s*[-*+]\s", ""))).Append("</li>"); i++; }
                    sb.Append("</ul>");
                    continue;
                }
                var para = new List<string>();
                while (i < lines.Length)
                {
                    string t = lines[i];
                    if (t.Trim().Length == 0) break;
                    if (Regex.IsMatch(t, @"^-{3,}\s*$")) break;
                    if (t.TrimStart().StartsWith(">")) break;
                    if (t.TrimStart().StartsWith("|") && i + 1 < lines.Length && IsTableSep(lines[i + 1])) break;
                    if (Regex.IsMatch(t, @"^\s*#{1,6}\s")) break;
                    if (Regex.IsMatch(t, @"^\s*\d+\.\s") || Regex.IsMatch(t, @"^\s*[-*+]\s")) break;
                    para.Add(Inline(t)); i++;
                }
                if (para.Count == 0) { para.Add(Inline(lines[i])); i++; }
                sb.Append("<p>").Append(string.Join("<br>", para.ToArray())).Append("</p>");
            }
            return sb.ToString();
        }
    }

    public class ViewerForm : Form
    {
        WebView2 wv;
        readonly CoreWebView2Environment env;
        readonly string html;
        public ViewerForm(CoreWebView2Environment environment, string pageHtml)
        {
            env = environment; html = pageHtml;
            Text = "错题记录 · 拾光小册";
            Width = 1020; Height = 880;
            StartPosition = FormStartPosition.CenterScreen;
            wv = new WebView2 { Dock = DockStyle.Fill };
            Controls.Add(wv);
            try
            {
                string icoPath = Path.Combine(HostBridge.AppRoot, "ctb.ico");
            if (!File.Exists(icoPath)) icoPath = Path.Combine(HostBridge.AppRoot, "_桌面v2", "ctb.ico");
                if (File.Exists(icoPath)) Icon = new System.Drawing.Icon(icoPath, 32, 32);
            }
            catch { }
            Shown += async (s, e) =>
            {
                try
                {
                    await wv.EnsureCoreWebView2Async(env);
                    wv.CoreWebView2.Settings.AreDevToolsEnabled = false;
                    wv.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                    await wv.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(
                        "window.addEventListener('keydown',function(e){if(e.key==='Escape'){try{window.chrome.webview.postMessage('close');}catch(_){}}});");
                    wv.CoreWebView2.WebMessageReceived += (a, b) => { try { if (b.TryGetWebMessageAsString() == "close") Close(); } catch { } };
                    wv.CoreWebView2.NavigateToString(html);
                }
                catch (Exception ex)
                {
                    HostBridge.Log("viewer FAILED: " + ex);
                    MessageBox.Show(ex.Message, "错题记录窗口打开失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    Close();
                }
            };
        }
    }
}
