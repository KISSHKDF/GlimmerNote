#Requires -Version 5.1
<#
.SYNOPSIS
  把仓库内的版本化 git 钩子（.githooks\）安装到当前克隆上。

.DESCRIPTION
  为什么需要这一步（L-02 根因）：
    .git\hooks\ 不进版本库 —— 干净克隆里 pre-commit / commit-msg / pre-push 全是空的，
    门禁只存在于当初手工装过的那台机器上，别人（和 CI、和未来的自己）克隆下来等于裸奔。
    把钩子放进 .githooks\ 并纳管后，新克隆只需跑一次本脚本。

  本脚本做三件事：
    1) git config core.hooksPath .githooks      —— 让 git 去 .githooks\ 找钩子
    2) 自检三个钩子存在、非空、LF 换行、且能被 sh 解析（sh -n）
    3) 打印结果；任何一项不通过则 exit 1

  幂等：重复执行只重复设置同一个值，无副作用。

.EXAMPLE
  powershell -NoProfile -File scripts\install-hooks.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$script:bad = 0
function Ok([string]$m)   { Write-Host "  [OK]   $m" -ForegroundColor Green }
function Bad([string]$m)  { Write-Host "  [FAIL] $m" -ForegroundColor Red; $script:bad++ }
function Warn([string]$m) { Write-Host "  [WARN] $m" -ForegroundColor Yellow }
function Info([string]$m) { Write-Host "  [INFO] $m" }

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Host "[install-hooks] 找不到 git，无法安装钩子。" -ForegroundColor Red
  exit 1
}

$repo = (& git rev-parse --show-toplevel 2>$null)
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($repo)) {
  Write-Host "[install-hooks] 当前目录不在 git 工作区内，请在本仓库内运行。" -ForegroundColor Red
  exit 1
}
$repo = $repo.Trim() -replace '/', '\'
Push-Location -LiteralPath $repo
try {
  Write-Host "[install-hooks] 仓库：$repo"

  # 找 sh：优先 PATH，其次按 git --exec-path 反推 Git for Windows 的 usr\bin\sh.exe
  function Find-Sh {
    $c = Get-Command sh -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    $execPath = (& git --exec-path 2>$null)
    if (-not $execPath) { return $null }
    $execPath = $execPath.Trim() -replace '/', '\'
    $p1 = Split-Path -Parent $execPath          # ...\mingw64\libexec
    $p2 = Split-Path -Parent $p1                # ...\mingw64
    $p3 = Split-Path -Parent $p2                # ...\Git
    foreach ($cand in @((Join-Path $p3 'usr\bin\sh.exe'), (Join-Path $p3 'bin\sh.exe'))) {
      if (Test-Path -LiteralPath $cand) { return $cand }
    }
    return $null
  }
  $sh = Find-Sh

  $hooks = @('pre-commit', 'commit-msg', 'pre-push')
  $hookDir = Join-Path $repo '.githooks'
  $missing = @()

  if (-not (Test-Path -LiteralPath $hookDir -PathType Container)) {
    Bad "缺少钩子目录 .githooks\"
  } else {
    Ok "钩子目录 .githooks\ 存在"
  }

  foreach ($h in $hooks) {
    $f = Join-Path $hookDir $h
    if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { Bad "缺少钩子 $h"; $missing += $h; continue }
    $bytes = [System.IO.File]::ReadAllBytes($f)
    if ($bytes.Length -eq 0) { Bad "$h 是空文件"; $missing += $h; continue }
    if ($bytes -contains [byte]0x0D) { Bad "$h 含 CR（应为 LF 换行）"; $missing += $h; continue }
    $head = [System.Text.Encoding]::ASCII.GetString($bytes[0..([Math]::Min(1, $bytes.Length - 1))])
    if ($head -ne '#!') { Bad "$h 缺 shebang"; $missing += $h; continue }
    if (-not $sh) {
      Warn "$h 存在且为 LF+shebang，但找不到 sh，跳过语法解析自检"
      continue
    }
    $out = & $sh -n $f 2>&1
    if ($LASTEXITCODE -ne 0) { Bad "$h 无法被 sh 解析：$out"; $missing += $h }
    else { Ok "$h 存在、LF 换行、sh -n 解析通过" }
  }

  # 已纳管的钩子应带可执行位（Linux/macOS 克隆上 git 才会执行它们）
  $lsOut = (& git ls-files -s -- .githooks 2>$null)
  if ($LASTEXITCODE -eq 0 -and $lsOut) {
    foreach ($line in @($lsOut)) {
      if ($line -match '^(\d{6}) \S+\s+\d+\t(.+)$') {
        $mode = $Matches[1]; $name = $Matches[2]
        if ($mode -eq '100755') { Ok "$name 索引模式 100755（可执行）" }
        else { Warn "$name 索引模式 $mode（非可执行）；如需修正：git update-index --chmod=+x $name" }
      }
    }
  }

  if ($missing.Count -gt 0) {
    Write-Host "[install-hooks] 未安装：钩子自检未通过（$($missing -join ', ')）" -ForegroundColor Red
    exit 1
  }

  # 真正安装：设 core.hooksPath（幂等，重复设置同值无副作用）
  $before = (& git config --local --get core.hooksPath 2>$null)
  & git config --local core.hooksPath .githooks
  if ($LASTEXITCODE -ne 0) { Bad "git config core.hooksPath 设置失败"; exit 1 }
  $after = (& git config --local --get core.hooksPath 2>$null)
  if ($after -ne '.githooks') { Bad "core.hooksPath 回读为 '$after'，期望 '.githooks'"; exit 1 }
  if ($before -eq '.githooks') { Ok "core.hooksPath 已是 .githooks（幂等，无变更）" }
  else { Ok "core.hooksPath: '$before' -> '.githooks'" }

  # .git\hooks\ 里的同名老钩子会被 hooksPath 覆盖而静默失效 —— 提醒，不算失败
  $legacy = @()
  foreach ($h in $hooks) {
    $lf = Join-Path $repo ('.git\hooks\' + $h)
    if (Test-Path -LiteralPath $lf) { $legacy += $h }
  }
  if ($legacy.Count -gt 0) {
    Warn "注意：.git\hooks\ 下仍有同名旧钩子（$($legacy -join ', ')）——已设 core.hooksPath 后它们不再生效，建议手工删除以免误判"
  }

  Write-Host "[install-hooks] 完成：3 个钩子已生效（git commit / git push 会走 .githooks\）"
  exit 0
}
finally {
  Pop-Location
}
