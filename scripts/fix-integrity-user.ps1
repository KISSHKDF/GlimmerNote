# ═══════════════════════════════════════════════════════════
# 拾光小册 · 完整性标签复位（终端用户可用的急救脚本）
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
#   用法（在**解压出来的目录**里右键 →「在终端/命令提示符中打开」，然后）：
#     powershell -NoProfile -ExecutionPolicy Bypass -File 修复完整性标签.ps1
#     powershell -NoProfile -ExecutionPolicy Bypass -File 修复完整性标签.ps1 -WhatIf
#
#   ★ 2026-11-04：这份脚本现在**随发布包一起发**。
#     改前它只存在于开发仓库的 scripts\ 目录里，而 README 的 FAQ 恰恰让**终端用户**
#     去跑它 —— 用户手里没有这个文件 ⇒ 那条命令必然 FileNotFound。
#     而"缺 WebView2 运行时"与"目录带低完整性标签"是同一台机器上最常撞的两个坑，
#     修标签的脚本却不在包里，等于把最需要它的场合做成了不可用。
#
#   ★ 同一个脚本在开发仓库里还有一份（scripts\fix-integrity.ps1）：那边跑的是
#     「运行区 + 开发区」两处自动解析；本文件是**终端用户版**——只处理
#     **本脚本所在目录的整棵树**（也就是用户解压出来的那一份），不依赖任何
#     仓库内部结构。两者行为不同、各自成立，故不是同一文件的两份拷贝。
# ═══════════════════════════════════════════════════════════
param(
  [switch]$WhatIf
)
$ErrorActionPreference = 'Stop'

# 本脚本所在目录 = 用户解压出来的那个目录（含 app\ 与 数据\）。
$target = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host '拾光小册 · 完整性标签复位' -ForegroundColor Cyan
Write-Host "  目标目录：$target"
Write-Host ''

if (-not (Test-Path -LiteralPath $target)) {
  Write-Host "✖ 目录不存在：$target" -ForegroundColor Red
  exit 1
}

# ★ 2026-11-05（合并评审 P2-10）：包形校验。本脚本对**所在目录的整棵树**改标签；
#   若它被单独拷到别处（比如桌面、某个盘根）再运行，会把那整棵树改掉。
#   所以只在"看起来是拾光小册解压目录"时才动手：必须有 app\拾光小册.exe（发布包的固定形状，见 build-release.ps1 的 mustHave）。
$looksLikePkg = (Test-Path -LiteralPath (Join-Path $target 'app') -PathType Container) -and
                (Test-Path -LiteralPath (Join-Path (Join-Path $target 'app') '拾光小册.exe') -PathType Leaf)
if (-not $looksLikePkg) {
  Write-Host "✖ 这个目录看起来不是拾光小册的解压目录（缺 app\拾光小册.exe）：$target" -ForegroundColor Red
  Write-Host '  本脚本会修改所在目录整棵树的完整性标签，只能放在解压目录里运行。未做任何修改。' -ForegroundColor Yellow
  exit 2
}

$m = @(icacls.exe $target 2>&1 | Select-String -Pattern 'Mandatory')
$before = if ($m.Count -gt 0) { $m[0].ToString().Trim() } else { '(当前无 Mandatory 行 —— 说明没有显式标签，Windows 会按继承处理)' }
Write-Host "  现在：$before"

if ($WhatIf) {
  Write-Host '  （-WhatIf：只显示，不修改）' -ForegroundColor Yellow
  Write-Host ''
  Write-Host '  确认无误后，去掉 -WhatIf 再跑一次即可真正修改。' -ForegroundColor Yellow
  exit 0
}

# 整棵树设为「中完整性」。低完整性进程改不了自己的标签，所以这一步必须在正常权限下跑。
$out = icacls.exe $target /setintegritylevel '(OI)(CI)M' /T /C 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Host "✖ 复位失败：$($out | Select-Object -Last 1)" -ForegroundColor Red
  Write-Host '  常见原因：目录正被占用，或当前账户对它没有「更改权限」。' -ForegroundColor Yellow
  Write-Host '  试试：关掉本程序和浏览器（含后台驻留），再跑一次；' -ForegroundColor Yellow
  Write-Host '        或右键「以管理员身份运行」打开终端再跑。' -ForegroundColor Yellow
  exit 1
}

$m2 = @(icacls.exe $target 2>&1 | Select-String -Pattern 'Mandatory')
$after = if ($m2.Count -gt 0) { $m2[0].ToString().Trim() } else { '(复位后仍无 Mandatory 行)' }
Write-Host "  之后：$after" -ForegroundColor Green
Write-Host ''
Write-Host '✔ 完成。重新双击 拾光小册.exe 试试；若仍失败，把日志发出来：' -ForegroundColor Green
Write-Host '  %LOCALAPPDATA%\拾光小册\shell.log（也可能落在程序目录下）'
exit 0
