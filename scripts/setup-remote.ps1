# scripts\setup-remote.ps1
#
# B-01（有稳定 URL）的一键落地脚本。
# 审计 2026-10-24：本仓库无 remote，B-01 判 FAIL。
# 这不是"写错了"，是"还没发布" —— 但也不能一直空着：没有远端就没有备份、
# 没有协作入口、没有公开的 Issue/Release 渠道。
#
# 用法：
#   1) 先在 GitHub 建一个**空仓库**（不要勾 README/.gitignore/LICENSE，否则首推会冲突）
#   2) 然后跑：
#        powershell -File scripts\setup-remote.ps1 -Url https://github.com/<你>/<仓库名>.git
#   3) 若默认分支名要 main（推荐）：脚本会一并处理
#
# 这个脚本只做四件事：查环境 → 校验 URL → 加 remote → 首次推送（含 tag）。
# 它**不改任何源码**，也不 force push。

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Url,
  [string]$Branch = 'main',
  [switch]$Private
)

$ErrorActionPreference = 'Stop'
$treeRoot = Split-Path $PSScriptRoot -Parent
if (-not (Test-Path (Join-Path $treeRoot 'VERSION.json'))) {
  throw "树根推导失败：$treeRoot 下没有 VERSION.json"
}

function Say([string]$m) { Write-Host "[setup-remote] $m" }

# ── 1) 校验 URL ──
if ($Url -notmatch '^(https://|git@)') {
  throw "URL 必须是 https:// 或 git@ 开头（当前：$Url）"
}
if ($Url -notmatch '\.git$') {
  $Url = $Url.TrimEnd('/') + '.git'
  Say "URL 补成 $Url"
}

Push-Location $treeRoot
try {
  # ── 2) 环境自检 ──
  Say '[1/5] 环境自检'
  $name = (& git config user.name)
  $email = (& git config user.email)
  if ([string]::IsNullOrWhiteSpace($name) -or [string]::IsNullOrWhiteSpace($email)) {
    throw "本仓库没配 git 身份。先跑：`n  git config user.name  `"你的名字`"`n  git config user.email `"你的邮箱`""
  }
  Say "      身份：$name <$email>"

  $dirty = @(& git status --porcelain)
  if ($dirty.Count -gt 0) {
    throw "工作区有 $($dirty.Count) 个未提交改动，先提交再发布：`n$($dirty -join "`n")"
  }
  Say '      工作区干净'

  $existing = @(& git remote 2>$null)
  if ($existing -contains 'origin') {
    $cur = (& git remote get-url origin)
    throw "已经有一个 origin 指向 $cur。要换远端请先：git remote remove origin"
  }
  Say '      当前没有 origin'

  # ── 3) 发布前门禁（不通过就不许推） ──
  Say '[2/5] 发布前门禁（quick）'
  $nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $nodeExe) {
    Say '      ⚠ 找不到 node，跳过门禁。**强烈建议装 Node 后重跑**（门禁是发布前的唯一自动防线）'
  } else {
    & $nodeExe (Join-Path $treeRoot 'tests\run.mjs') 'quick'
    if ($LASTEXITCODE -ne 0) {
      throw "门禁未通过（exit $LASTEXITCODE），拒绝发布。修完再跑。"
    }
    Say '      门禁通过'
  }

  # ── 4) 加 remote 并推 ──
  Say "[3/5] 添加 origin"
  & git remote add origin $Url
  Say "      origin = $Url"

  $currentBranch = (& git rev-parse --abbrev-ref HEAD)
  Say "[4/5] 当前分支 = $currentBranch"
  if ($currentBranch -ne $Branch) {
    Say "      重命名为 $Branch（GitHub 默认 main）"
    & git branch -M $Branch
  }

  Say "[5/5] 首次推送（含 tag）"
  & git push -u origin $Branch
  if ($LASTEXITCODE -ne 0) { throw "推送失败（exit $LASTEXITCODE）。常见原因：远端仓库非空、或没有凭据。" }
  & git push --tags
  if ($LASTEXITCODE -ne 0) { Say '      ⚠ tag 推送失败，可稍后手动 git push --tags' }

  # ── 5) 收尾核对 ──
  Say ''
  Say '========== 完成 =========='
  Say ("远端   : " + (& git remote get-url origin))
  Say ("分支   : " + (& git rev-parse --abbrev-ref HEAD))
  Say ("HEAD   : " + (& git rev-parse --short HEAD))
  Say ("标签数 : " + (@(& git tag).Count))
  Say ("版本   : " + ((Get-Content (Join-Path $treeRoot 'VERSION.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version))
  Say ''
  Say '接下来（B-01 之外的发布清单）：'
  Say '  1) 在 GitHub 网页上把仓库设为 Public（若要开源）'
  Say '  2) 打开 Settings → 启用 Issues（Issue 模板已在 .github\ISSUE_TEMPLATE）'
  Say '  3) 用 GitHub Release 上传 release\ 里的 zip 与 .sha256，正文抄 CHANGELOG 该版本条目'
  Say '  4) Settings → Security → 启用 "Private vulnerability reporting"（配合 SECURITY.md）'
}
finally {
  Pop-Location
}
