# ═══════════════════════════════════════════════════════════════
# 拾光小册 · 月度三件套（方案批次 2-2，2026-11-14 建）
#   内容：`_原图.mjs 校验 + 两个家 + 单份`（P10 的三条数据完整性判据一次跑完）
#   产物：%LOCALAPPDATA%\拾光小册\logs\月度三件套-<时间戳>.log
#   调度：Windows 计划任务「拾光小册-月度三件套」（每月 1 日 07:17）
#   退出码：0 = 三条全绿；非 0 = 至少一条红（日志里看哪条）。
#   ⚠ 只读体检（三条子命令都不写库）：写盘只有日志文件。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\月度三件套.ps1 [-DataRoot <库根>]
# ═══════════════════════════════════════════════════════════════
[CmdletBinding()]
param(
  [string]$DataRoot    # 库根（<运行区>\数据）；不填则按 deploy 链同款顺序解析
)
$ErrorActionPreference = 'Continue'

# ── 库根解析（与 scripts\_运行区.ps1 同思想，但这里只需要"数据"目录，不写死本机路径）──
if (-not $DataRoot) {
  $prod = $env:GLIMMERNOTE_PROD
  if (-not $prod) {
    $repoRoot = Split-Path -Parent $PSScriptRoot
    $guess = Join-Path (Split-Path -Parent $repoRoot) 'GlimmerNote'
    if (Test-Path (Join-Path $guess '数据')) { $prod = $guess }
  }
  if ($prod) { $DataRoot = Join-Path $prod '数据' }
}
if (-not $DataRoot -or -not (Test-Path $DataRoot)) {
  Write-Error '库根解析失败：设 -DataRoot 或 GLIMMERNOTE_PROD，或保证 <仓库上一级>\GlimmerNote\数据 存在'
  exit 2
}

# ── 工具与 node 定位（发布包与开发树都兼容）──
$toolCandidates = @(
  (Join-Path (Split-Path -Parent $PSScriptRoot) 'src\tools\_原图.mjs'),
  (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'app\tools\_原图.mjs')
)
$tool = $toolCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $tool) { Write-Error '找不到 _原图.mjs（开发树与发布包都试过）'; exit 2 }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $n2 = Join-Path (Split-Path -Parent (Split-Path -Parent $tool)) 'node.exe'; if (Test-Path $n2) { $node = $n2 } }
if (-not $node) { Write-Error '找不到 node.exe（PATH 与包内都试过）'; exit 2 }

# ── 日志落点 ──
$logDir = Join-Path $env:LOCALAPPDATA '拾光小册\logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$stamp = Get-Date -Format 'yyyy-MM-dd-HHmmss'
$log = Join-Path $logDir ("月度三件套-" + $stamp + '.log')
Start-Transcript -Path $log -Force | Out-Null

Write-Host "月度三件套 · $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Host "库根：$DataRoot"
Write-Host "工具：$tool"
Write-Host ('─' * 60)

$env:CTB_DATA = $DataRoot
$worst = 0
foreach ($sub in @('校验', '两个家', '单份')) {
  Write-Host "`n═══ _原图.mjs $sub ═══"
  & $node $tool $sub 2>&1 | Write-Host
  $rc = $LASTEXITCODE
  $worst = [Math]::Max($worst, $rc)
  Write-Host ("→ exit " + $rc)
}

Write-Host ('─' * 60)
$verdict = if ($worst -eq 0) { '✔ 三件全绿' } else { "✖ 有红（worst=$worst）——日志：$log" }
Write-Host $verdict
# 红即写待办（库根 _待办欠账 的消费方读不到 PowerShell 直接写的 JSON，这里只留文本哨兵行，附在日志里）
Stop-Transcript | Out-Null
exit $worst
