# ═══════════════════════════════════════════════════════════
# 拾光小册 · 运行区路径解析（唯一实现）
#   被 scripts\deploy.ps1 / rollback.ps1 / fix-integrity.ps1 dot-source；
#   scripts\verify-deploy.mjs（JS 侧）按**同一顺序**实现 —— 改这里必须同步改它。
#
# 为什么必须抽成一份（2026-11-01）：
#   运行区不再保证与开发仓库同级（整套可以搬到别的盘）。四个脚本原先各自按
#   「<仓库上一级>\GlimmerNote」推导，运行区一搬走就全都指向同一个**不存在的目录**，
#   部署 / 回滚 / 校验 / 完整性急救一起失效（而且四个脚本各错各的，排查要跑四遍）。
#   解析顺序只许有这一处定义：复制成几份必然漂移（本仓 L-286）。
#
# 解析顺序（唯一契约，文档见 docs\发布链路.md「运行区在哪」）：
#   ① 显式参数（-ProdRoot / --prod）
#   ② 环境变量 $env:GLIMMERNOTE_PROD（用户级；机器差异只放仓库外）
#   ③ 兜底 <仓库上一级>\GlimmerNote（开发区与运行区并列的标准布局）
#   ⚠ 本仓库是公开仓：本文件与任何其它 tracked 文件都**不许**出现本机绝对路径。
#
# 用法（dot-source 后调用；不要用 & 调用，需要拿到同一个 scope 的函数）：
#   . (Join-Path $PSScriptRoot '_运行区.ps1')
#   $ProdRoot = Resolve-ProdRoot -Explicit $ProdRoot -RepoRoot (Split-Path -Parent $PSScriptRoot)
#   ⚠ 不能在 param() 默认值里调用本函数：Windows PowerShell 5.1 求值 param 默认值时
#     $PSScriptRoot 还是空字符串（2026-10-23 实测），必须在 param() 之后再解析。
# ═══════════════════════════════════════════════════════════
# ★ 2026-11-02 R21：5.1 宿主环境自愈（见 scripts\_PS环境.ps1 的说明）
#   ⚠ 只在文件真存在时 dot-source：本文件会被部分用例/工具**单独**复制到沙箱里跑，
#     那时没有 _PS环境.ps1。缺了就**显式告警**继续（可见降级），不静默、也不硬崩。
$psEnvSelfHeal = Join-Path $PSScriptRoot '_PS环境.ps1'
if (Test-Path -LiteralPath $psEnvSelfHeal) { . $psEnvSelfHeal }
else { Write-Host '  ⚠ 缺少 scripts\_PS环境.ps1（5.1 宿主环境自愈）：沿用当前 PSModulePath 继续' -ForegroundColor Yellow }

function Resolve-ProdRoot {
  [CmdletBinding()]
  param(
    # 显式参数（脚本自己的 -ProdRoot）：给了就用它，不再看环境变量。
    [string]$Explicit = '',
    # 开发仓库根。由调用方传 Split-Path -Parent $PSScriptRoot，
    # 不在函数里猜 $PSScriptRoot —— dot-source 进来的函数拿到的是定义处的脚本目录，
    # 与调用方目录不一定相同，靠猜就会在"从别处调用"时静默指错目录。
    [Parameter(Mandatory = $true)][string]$RepoRoot
  )
  if ($Explicit) { return $Explicit }
  $fromEnv = [string]$env:GLIMMERNOTE_PROD
  if ($fromEnv -and $fromEnv.Trim()) { return $fromEnv.Trim() }
  return (Join-Path (Split-Path -Parent $RepoRoot) 'GlimmerNote')
}
