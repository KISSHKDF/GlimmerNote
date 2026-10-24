# ═══════════════════════════════════════════════════════════
# 拾光小册 · 编桌面壳（csc / .NET Framework 4，零运行时依赖）
#
#   输入：src\shell\CTBShellV2.cs、src\shell\ctb.ico、vendor\webview2\*.dll（由 scripts\fetch-deps.ps1 取）
#   输出：src\app\拾光小册.exe  +  3 个 WebView2 dll  +  ctb.ico
#         —— 直接落在 src\app\，所以 build-release.ps1 不用改就能把它们打进包。
#
#   为什么产物落在 src\app\：
#     包里 app\ 就是「程序目录」。exe、运行库、界面文件放在同一个目录，
#     壳启动时 AppRoot = 自己所在目录，找 index.html / 找 dll 都不需要再上溯。
#     这些产物由 .gitignore 挡住（*.exe / *.dll），不会进 git。
#
#   用法：powershell -File src\shell\build.ps1
#   依赖：先跑 powershell -File scripts\fetch-deps.ps1
# ═══════════════════════════════════════════════════════════
$ErrorActionPreference = 'Stop'

$shellDir = $PSScriptRoot                                  # ...\src\shell
$repoRoot = Split-Path -Parent (Split-Path -Parent $shellDir)
$appDir   = Join-Path $repoRoot 'src\app'
$depsDir  = Join-Path $repoRoot 'vendor\webview2'
$srcFile  = Join-Path $shellDir 'CTBShellV2.cs'
$icoFile  = Join-Path $shellDir 'ctb.ico'
$exeName  = '拾光小册.exe'
$exeOut   = Join-Path $appDir $exeName

Write-Host "拾光小册 · 编桌面壳" -ForegroundColor Cyan
Write-Host "  仓库：$repoRoot"
Write-Host "  输出：$appDir"

# ── 1) 前置检查：源码 / 图标 / 依赖 / 编译器 ──
foreach ($p in @($srcFile, $icoFile)) {
  if (-not (Test-Path $p)) { throw "缺少文件：$p" }
}
if (-not (Test-Path $appDir)) { New-Item -ItemType Directory -Path $appDir -Force | Out-Null }

$deps = @('Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll')
# 依赖目录可由 CTB_WEBVIEW2_DIR 覆盖（自定义位置 / CI）
$depRoot = $(if ($env:CTB_WEBVIEW2_DIR) { $env:CTB_WEBVIEW2_DIR } else { $depsDir })
$missing = @($deps | Where-Object { -not (Test-Path (Join-Path $depRoot $_)) })
if ($missing.Count -gt 0) {
  throw ("缺少 WebView2 依赖（$depRoot）：`r`n  " + ($missing -join "`r`n  ") +
         "`r`n`r`n请先跑：powershell -File scripts\fetch-deps.ps1")
}

$csc = $null
foreach ($c in @(
    'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe',
    'C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe')) {
  if (Test-Path $c) { $csc = $c; break }
}
if (-not $csc) { throw '找不到 .NET Framework csc.exe（Win10/11 自带 .NET FX 4.x，缺失属异常环境）' }

# ── 2) 版本号：唯一真源 VERSION.json（不再在本脚本写死）──
$verFile = Join-Path $repoRoot 'VERSION.json'
if (-not (Test-Path $verFile)) { throw "找不到 VERSION.json：$verFile" }
$V = Get-Content $verFile -Raw -Encoding UTF8 | ConvertFrom-Json
$verStr = [string]$V.version
if ($verStr -notmatch '^\d{4}\.\d{2}\.\d{2}\.\d{2}$') { throw "VERSION.json 的 version 不符合日期制 YYYY.MM.DD.NN：$verStr" }
# 日期制 → 四段程序集版本：2026.10.23.01 → 2026.10.23.1
$seg = $verStr -split '\.'
$asmVer = '{0}.{1}.{2}.{3}' -f $seg[0], [int]$seg[1], [int]$seg[2], [int]$seg[3]
Write-Host "  版本：$verStr（程序集 $asmVer）"

# ── 3) 版本资源：AssemblyInfo 走 Win32 VERSIONINFO 自动生成（零外部依赖，无需 rc.exe）──
$aiFile = Join-Path $env:TEMP ("gn-asm-" + [guid]::NewGuid().ToString('N') + ".cs")
$aiBody = @"
using System.Reflection;
using System.Resources;
using System.Runtime.InteropServices;

[assembly: AssemblyTitle("GlimmerNote")]
[assembly: AssemblyDescription("GlimmerNote Desktop Shell")]
[assembly: AssemblyCompany("GlimmerNote")]
[assembly: AssemblyProduct("GlimmerNote")]
[assembly: AssemblyCopyright("See LICENSE")]
[assembly: AssemblyTrademark("")]
[assembly: AssemblyCulture("")]
[assembly: AssemblyVersion("$asmVer")]
[assembly: AssemblyFileVersion("$asmVer")]
[assembly: AssemblyInformationalVersion("$verStr")]
[assembly: NeutralResourcesLanguage("zh-CN")]
"@
[IO.File]::WriteAllText($aiFile, $aiBody, (New-Object System.Text.UTF8Encoding($true)))

try {
  # ── 4) 编译 ──
  Write-Host "  编译中…"
  if (Test-Path $exeOut) { Remove-Item $exeOut -Force }   # 被占用会在这里报错（壳还开着）
  & $csc /nologo /target:winexe /out:"$exeOut" /platform:anycpu `
    /win32icon:"$icoFile" `
    /reference:"$(Join-Path $depRoot 'Microsoft.Web.WebView2.Core.dll')" `
    /reference:"$(Join-Path $depRoot 'Microsoft.Web.WebView2.WinForms.dll')" `
    /reference:System.dll /reference:System.Drawing.dll /reference:System.Windows.Forms.dll `
    "$srcFile" "$aiFile" | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "csc 编译失败（退出码 $LASTEXITCODE）" }
} finally {
  if (Test-Path $aiFile) { Remove-Item $aiFile -Force -ErrorAction SilentlyContinue }
}
if (-not (Test-Path $exeOut)) { throw "编译后没有产物：$exeOut" }

# ── 5) 把运行时依赖 + 图标拷到 exe 旁边（它们必须随 exe 一起发布）──
foreach ($d in $deps) {
  Copy-Item (Join-Path $depRoot $d) (Join-Path $appDir $d) -Force
}
Copy-Item $icoFile (Join-Path $appDir 'ctb.ico') -Force

# ── 6) 可选签名（本机没证书只警告，不中断：自签证书换机就得重生成）──
$thumb = '47EE200CB7D161219CFF998CC6F3435E06DEBDF3'
$signed = $false
try {
  $cert = Get-ChildItem Cert:\CurrentUser\My -ErrorAction SilentlyContinue |
          Where-Object { $_.Thumbprint -eq $thumb } | Select-Object -First 1
  if ($cert) {
    $null = Set-AuthenticodeSignature -FilePath $exeOut -Certificate $cert `
      -TimestampServer 'http://timestamp.digicert.com' -ErrorAction Stop
    $sig = Get-AuthenticodeSignature $exeOut
    Write-Host ("  签名：{0}" -f $sig.Status)
    $signed = $true
  } else {
    Write-Host "  未签名：本机没有证书 $thumb（不影响运行；SmartScreen 可能提示）" -ForegroundColor Yellow
  }
} catch {
  Write-Host ("  签名失败（不中断）：{0}" -f $_.Exception.Message) -ForegroundColor Yellow
}

# ── 7) 回收信息（供发版核对）──
$vi = (Get-Item $exeOut).VersionInfo
$exeLen = (Get-Item $exeOut).Length
$depLen = ($deps | ForEach-Object { (Get-Item (Join-Path $appDir $_)).Length } | Measure-Object -Sum).Sum

Write-Host ""
Write-Host "✔ 编壳完成" -ForegroundColor Green
Write-Host ("  产物：{0}" -f $exeOut)
Write-Host ("  体积：exe {0:N0} 字节（{1:N1} KB）＋ 运行库 {2:N0} 字节（{3:N1} KB，3 个 dll 必须随 exe 发布）" -f `
  $exeLen, ($exeLen / 1KB), $depLen, ($depLen / 1KB))
Write-Host ("  版本资源：FileVersion={0}  ProductName={1}  Description={2}" -f $vi.FileVersion, $vi.ProductName, $vi.FileDescription)
Write-Host ("  已签名：{0}" -f $(if ($signed) { '是' } else { '否' }))
Write-Host ""
Write-Host "下一步：powershell -File scripts\build-release.ps1"
