# ═══════════════════════════════════════════════════════════
# 拾光小册 · 完整性标签复位（一次性急救脚本）
#
#   什么时候用：
#     双击 `拾光小册.exe` 后弹「拾光小册 · 初始化失败 / 请求的资源在使用中
#     (异常来自 HRESULT:0x800700AA)」，或者干脆**日志一个字都没有**。
#
#   为什么会有这个问题：
#     Windows 每个文件都带一个「强制性完整性级别」。若程序所在的目录被写上了
#     低完整性（Low）标签，**新写入的文件会继承它**，而 Windows 让带低标签的
#     可执行文件跑在低完整性上下文里 —— 那种上下文写不了用户目录，
#     于是 WebView2 建不出数据目录、日志也写不进去。
#
#   正常情况不需要手动跑：`scripts\deploy.ps1` 每次部署都会自己复位一遍。
#   只有当程序不是经 deploy.ps1 落地（手工复制、解压到别处）时才需要它。
#
#   用法（默认同时处理运行区与开发区）：
#     powershell -NoProfile -ExecutionPolicy Bypass -File scripts\fix-integrity.ps1
#     powershell -NoProfile -ExecutionPolicy Bypass -File scripts\fix-integrity.ps1 -Path <目标目录>
#     powershell -NoProfile -ExecutionPolicy Bypass -File scripts\fix-integrity.ps1 -WhatIf
# ═══════════════════════════════════════════════════════════
param(
  [string[]]$Path,
  [switch]$WhatIf
)
$ErrorActionPreference = 'Stop'

# 默认：运行区 <仓库上一级>\GlimmerNote 与开发区本身（两者并列）。
# ⚠ 不能在 param() 默认值里用 $PSScriptRoot（Windows PowerShell 5.1 求值默认值时它还是空）。
if (-not $Path -or $Path.Count -eq 0) {
  $repoRoot = Split-Path -Parent $PSScriptRoot
  $Path = @((Split-Path -Parent $repoRoot), $repoRoot) |
    ForEach-Object { if ($_ -eq (Split-Path -Parent $repoRoot)) { Join-Path $_ 'GlimmerNote' } else { $_ } } |
    Where-Object { Test-Path $_ }
}

Write-Host '拾光小册 · 完整性标签复位' -ForegroundColor Cyan
$failed = 0
foreach ($p in $Path) {
  if (-not (Test-Path $p)) { Write-Host "  跳过（不存在）：$p" -ForegroundColor Yellow; continue }
  $full = (Resolve-Path -LiteralPath $p).Path
  $before = (icacls.exe $full 2>&1 | Select-String -Pattern 'Mandatory').ToString().Trim()
  Write-Host "  $full"
  Write-Host "    现在：$before"
  if ($WhatIf) {
    Write-Host '    （-WhatIf：只显示，不修改）' -ForegroundColor Yellow
    continue
  }
  # 整棵树设为「中完整性」。低完整性进程改不了自己的标签，所以这一步必须在正常权限下跑。
  $out = icacls.exe $full /setintegritylevel '(OI)(CI)M' /T /C 2>&1
  if ($LASTEXITCODE -ne 0) {
    $failed++
    Write-Host "    ✖ 复位失败：$($out | Select-Object -Last 1)" -ForegroundColor Red
    continue
  }
  $after = (icacls.exe $full 2>&1 | Select-String -Pattern 'Mandatory').ToString().Trim()
  Write-Host "    之后：$after" -ForegroundColor Green
}

Write-Host ''
if ($failed -gt 0) {
  Write-Host "✖ 有 $failed 个目录没改成。常见原因：目录被占用，或当前账户对它没有「更改权限」。" -ForegroundColor Red
  exit 1
}
Write-Host '✔ 完成。重新双击 拾光小册.exe 试试；若仍失败，把日志发出来：' -ForegroundColor Green
Write-Host '  %LOCALAPPDATA%\拾光小册\shell.log（也可能落在程序目录下）'
exit 0
