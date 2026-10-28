#requires -version 5.0
<#
  移除信任.ps1（v0.7）—— 回滚「安装信任并解除锁定.ps1」

  做三件事：
    1) 从 CurrentUser\My 删掉 v0.7 的自签名代码签名证书（含私钥）；
    2) 删掉它在 CurrentUser\Root、CurrentUser\TrustedPublisher、CurrentUser\TrustedPeople 里的副本；
    3) 复核并打印剩余状态，说明哪些东西没有被改动。

  明确不做（很重要）：
    - 不修改注册表里任何 SmartScreen / Defender 策略；
    - 不关闭 Defender 实时防护；
    - 不删除 exe 上已经写入的签名块（那属于程序文件本身，重跑安装脚本即可恢复信任）；
    - 不删除 MOTW 清理结果（清掉的「解除锁定」不会因为删证书而回来）。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File .\工具\移除信任.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File .\工具\移除信任.ps1 -IncludeLegacy    # 顺带清 v0.5 的旧自签名证书
    powershell -NoProfile -ExecutionPolicy Bypass -File .\工具\移除信任.ps1 -Thumbprint <指纹>  # 只删指定证书

  退出码：0=完成（或本来就没有）；1=有删除失败；2=参数错误。
#>
[CmdletBinding()]
param(
    [switch]$IncludeLegacy,
    [string]$Thumbprint = ''
)

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$ErrorActionPreference = 'Continue'

$OurCN        = 'QQ Chat AI Summary 开发者'
$OurSubject   = 'CN=' + $OurCN
$LegacySubstr = 'CN=QChatSummary (self-signed)'
$Line         = ('-' * 74)

$Failures = New-Object System.Collections.ArrayList

function Get-DisplayWidth([string]$s) {
    $w = 0
    foreach ($ch in $s.ToCharArray()) { if ([int]$ch -gt 255) { $w += 2 } else { $w += 1 } }
    return $w
}
function Format-Label([string]$s, [int]$width) {
    $n = $width - (Get-DisplayWidth $s)
    if ($n -lt 1) { $n = 1 }
    return ($s + (' ' * $n))
}
function Write-Banner([string]$t) {
    Write-Host ''
    Write-Host $Line -ForegroundColor DarkCyan
    Write-Host ('  ' + $t) -ForegroundColor Cyan
    Write-Host $Line -ForegroundColor DarkCyan
}
function Write-Info([string]$s)  { Write-Host ('  ' + $s) -ForegroundColor Gray }
function Write-Ok([string]$s)    { Write-Host ('  ' + $s) -ForegroundColor Green }
function Write-Warn2([string]$s) { Write-Host ('  ' + $s) -ForegroundColor Yellow }
function Write-Err2([string]$s)  { Write-Host ('  ' + $s) -ForegroundColor Red }

$Stores = @(
    @('Cert:\CurrentUser\My', 'My（含私钥）'),
    @('Cert:\CurrentUser\Root', 'Root（受信任的根）'),
    @('Cert:\CurrentUser\TrustedPublisher', 'TrustedPublisher（受信任的发布者）'),
    @('Cert:\CurrentUser\TrustedPeople', 'TrustedPeople（受信任的人）')
)

function Test-IsTarget([System.Security.Cryptography.X509Certificates.X509Certificate2]$c) {
    if ($Thumbprint -ne '') { return ($c.Thumbprint -eq $Thumbprint) }
    if ($c.Subject -eq $OurSubject) { return $true }
    if ($IncludeLegacy -and $c.Subject -like ('*' + $LegacySubstr + '*')) { return $true }
    return $false
}

Write-Banner '移除信任（v0.7 回滚）'
Write-Info '只是把「本机信任这张自签名证书」这件事撤掉，不会动系统安全设置。'
Write-Info '不修改任何 SmartScreen / Defender 注册表策略，不关闭实时防护，不联网。'
if ($IncludeLegacy) { Write-Info '已勾选 -IncludeLegacy：会顺带清理 v0.5 的旧自签名证书（CN=QChatSummary (self-signed)）。' }
if ($Thumbprint -ne '') { Write-Info ('只处理指定指纹：' + $Thumbprint) }

# ---------------------------------------------------------------- 1. 找出目标
Write-Banner '1/4  查找目标证书'

$plan = @()
foreach ($s in $Stores) {
    $storePath = $s[0]
    $storeName = $s[1]
    $found = @(Get-ChildItem -LiteralPath $storePath -ErrorAction SilentlyContinue | Where-Object { Test-IsTarget $_ })
    Write-Info ((Format-Label ($storeName + '  ') 30) + ('命中 ' + $found.Count + ' 个'))
    foreach ($c in $found) {
        Write-Info ('    ' + $c.Thumbprint + '  ' + $c.Subject + '  到期 ' + $c.NotAfter.ToString('yyyy-MM-dd'))
        $plan += [pscustomobject]@{ Store = $storePath; StoreName = $storeName; Cert = $c }
    }
}

if ($plan.Count -eq 0) {
    Write-Host ''
    Write-Ok '没有找到要删除的证书（可能已经移除过了，本脚本可重复执行）。'
    Write-Info '如果你确实需要清掉 v0.5 的旧证书，请加 -IncludeLegacy 再跑一次。'
}

# ---------------------------------------------------------------- 2. 删除
Write-Banner '2/4  删除证书'

$removed = 0
foreach ($p in $plan) {
    $target = $p.Store + '\' + $p.Cert.Thumbprint
    try {
        Remove-Item -LiteralPath $target -Force -ErrorAction Stop
        $removed++
        Write-Ok ('已删除 ' + $p.StoreName + ' 中的 ' + $p.Cert.Thumbprint)
    }
    catch {
        Write-Err2 ('[失败] 删除 ' + $p.StoreName + ' 中的 ' + $p.Cert.Thumbprint + ' 失败。')
        Write-Err2 ('       系统返回：' + $_.Exception.Message)
        Write-Err2 '       常见原因：证书被其他程序占用（刚签过名的 exe 还在跑）、或存储只读。'
        [void]$Failures.Add('删除 ' + $p.StoreName + ' 的 ' + $p.Cert.Thumbprint + ' 失败：' + $_.Exception.Message)
    }
}

# ---------------------------------------------------------------- 3. 复核
Write-Banner '3/4  复核：现在还剩什么'

$leftMy  = @(Get-ChildItem 'Cert:\CurrentUser\My' -ErrorAction SilentlyContinue | Where-Object { Test-IsTarget $_ })
$leftRoot = @(Get-ChildItem 'Cert:\CurrentUser\Root' -ErrorAction SilentlyContinue | Where-Object { Test-IsTarget $_ })
$leftTp  = @(Get-ChildItem 'Cert:\CurrentUser\TrustedPublisher' -ErrorAction SilentlyContinue | Where-Object { Test-IsTarget $_ })
$leftTpeople = @(Get-ChildItem 'Cert:\CurrentUser\TrustedPeople' -ErrorAction SilentlyContinue | Where-Object { Test-IsTarget $_ })

Write-Host ('  ' + (Format-Label 'My 剩余' 26) + '：' + $leftMy.Count)
Write-Host ('  ' + (Format-Label 'Root 剩余' 26) + '：' + $leftRoot.Count)
Write-Host ('  ' + (Format-Label 'TrustedPublisher 剩余' 26) + '：' + $leftTp.Count)
Write-Host ('  ' + (Format-Label 'TrustedPeople 剩余' 26) + '：' + $leftTpeople.Count)

$exe = Join-Path (Split-Path -Parent $PSScriptRoot) 'QChatSummary.exe'
if (Test-Path -LiteralPath $exe) {
    $sig = Get-AuthenticodeSignature -LiteralPath $exe -ErrorAction SilentlyContinue
    if ($sig) {
        Write-Host ''
        Write-Host ('  ' + (Format-Label 'exe 签名状态' 26) + '：' + $sig.Status) -ForegroundColor Gray
        if ($sig.SignerCertificate) {
            Write-Host ('  ' + (Format-Label '签名者' 26) + '：' + $sig.SignerCertificate.Subject) -ForegroundColor Gray
        }
    }
}

# ---------------------------------------------------------------- 4. 说明
Write-Banner '4/4  这次回滚改了什么、没改什么'

Write-Info '改了什么：'
Write-Info ('  - 删除了 ' + $removed + ' 个证书条目（当前用户范围）。')
Write-Info '没改什么（明确列出，避免误解）：'
Write-Info '  - 注册表里的 SmartScreen / Defender 策略：一个都没动。'
Write-Info '  - Defender 实时防护：没关过，也没改过。'
Write-Info '  - exe 上的签名块：没删（那是程序文件内容，属于打包环节）。签名还在，但本机不再信任它的根，'
Write-Info '    所以右键「属性 → 数字签名」里状态会显示「根证书不受信任」或类似。'
Write-Info '  - 文件的 MOTW 清理结果：不会因为删证书而恢复。'
Write-Host ''
Write-Info '回滚后双击 exe 会不会弹蓝色 SmartScreen？'
Write-Info '  - 只看 MOTW：如果之前已经清过（文件没有 Zone.Identifier），仍然不会弹。'
Write-Info '  - 想复核：powershell -NoProfile -ExecutionPolicy Bypass -File .\工具\检查安全提示.ps1'
Write-Host ''
Write-Info '如果要恢复信任：重跑 .\工具\安装信任并解除锁定.ps1（会重新生成一张证书并签名）。'
Write-Host ''

if ($Failures.Count -gt 0) {
    Write-Err2 ('汇总：' + $Failures.Count + ' 个删除动作失败。')
    foreach ($f in $Failures) { Write-Err2 ('  - ' + $f) }
    exit 1
}
Write-Ok '回滚完成。'
exit 0
