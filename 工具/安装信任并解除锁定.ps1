#requires -version 5.0
<#
  安装信任并解除锁定.ps1（v0.7）

  作用（四件事，可重复执行）：
    1) 生成/复用一张自签名代码签名证书：CN=Submerge（Code Signing EKU，RSA 3072 / SHA256 / 5 年）
       私钥留在本机、不可导出（NonExportable），只装在 CurrentUser 范围，不需要管理员。
    2) 把这张证书装进当前用户的「受信任的发布者」(TrustedPublisher) 和「受信任的根证书颁发机构」(Root)。
       已存在则跳过；Root 需要你在 Windows 的「安全警告」里点一次「是」（系统强制，无法静默）。
    3) 递归清除项目目录内 exe/bat/dll/ps1/md 的 MOTW（Zone.Identifier，「从网络下载」标记）。
       这一条才是真正解决蓝色 SmartScreen 弹窗的关键。
    4) 用这张证书给 QQ Chat Summary.exe 做 Authenticode 签名（SHA256，不联网、不加时间戳）。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File .\工具\安装信任并解除锁定.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File .\工具\安装信任并解除锁定.ps1 -RootConsent   # 允许弹一次「安全警告」让你点「是」
    powershell -NoProfile -ExecutionPolicy Bypass -File .\工具\安装信任并解除锁定.ps1 -NoRoot -NoSign  # 只清 MOTW
    powershell -NoProfile -ExecutionPolicy Bypass -File .\工具\安装信任并解除锁定.ps1 -Exe "D:\某处\QQ Chat Summary.exe"

  不做：不改注册表里任何 SmartScreen / Defender 策略，不关实时防护，不伪造他人签名，不联网。
  退出码：0=全部完成；1=完成但有遗留（根证书没确认 / 签名不是 Valid）；2=关键步骤失败。
#>
[CmdletBinding()]
param(
    [string]$ProjectRoot = '',
    [string]$Exe = '',
    [switch]$NoRoot,
    [switch]$NoSign,
    [switch]$RootConsent,
    [string]$TimestampServer = '',
    [int]$RootConsentTimeoutSec = 120
)

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$ErrorActionPreference = 'Continue'

$OurCN      = 'Submerge'
$OurSubject = 'CN=' + $OurCN
$Exts       = @('.exe', '.bat', '.dll', '.ps1', '.md')
$Line       = ('-' * 74)
$ProjRoot   = Split-Path -Parent $PSScriptRoot
if (-not [string]::IsNullOrWhiteSpace($ProjectRoot)) { $ProjRoot = $ProjectRoot }
$ProjRoot = (Get-Item -LiteralPath $ProjRoot).FullName
if ([string]::IsNullOrWhiteSpace($Exe)) {
    $new = Join-Path $ProjRoot 'QQ Chat Summary.exe'
    if (Test-Path -LiteralPath $new) { $Exe = $new } else { $Exe = Join-Path $ProjRoot 'QChatSummary.exe' }
}

$SignDir = Join-Path $PSScriptRoot 'signing'
$CerPath = Join-Path $SignDir 'Submerge-codesign.cer'

$Failures = New-Object System.Collections.ArrayList
$Warnings = New-Object System.Collections.ArrayList
$RootState = '未处理'
$SignState = '未处理'

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

function Get-OurCerts {
    return @(Get-ChildItem 'Cert:\CurrentUser\My' -ErrorAction SilentlyContinue |
        Where-Object { $_.Subject -eq $OurSubject })
}
function Test-CertInStore([string]$storePath) {
    return @(Get-ChildItem -LiteralPath $storePath -ErrorAction SilentlyContinue |
        Where-Object { $_.Subject -eq $OurSubject })
}
function Get-MotwFiles([System.IO.FileInfo[]]$items) {
    $hit = @()
    foreach ($f in $items) {
        $s = Get-Item -LiteralPath $f.FullName -Stream 'Zone.Identifier' -ErrorAction SilentlyContinue
        if ($s) { $hit += $f }
    }
    return $hit
}
function Install-CertToStore([string]$cerPath, [string]$storePath) {
    Import-Certificate -FilePath $cerPath -CertStoreLocation $storePath -ErrorAction Stop | Out-Null
}

Write-Banner '安装信任并解除锁定（v0.7）'
Write-Info '本脚本只改「当前用户」范围的证书存储和文件标记，不需要管理员权限。'
Write-Info '不会修改注册表里任何 SmartScreen / Defender 策略，不会关闭实时防护，不会联网。'
Write-Info ('项目目录：' + $ProjRoot)

# ---------------------------------------------------------------- 0. 前置检查
Write-Banner '0/6  前置检查'

if (-not (Test-Path -LiteralPath $Exe)) {
    Write-Err2 ('[错误] 找不到要签名的程序：' + $Exe)
    Write-Err2 '       请确认 QQ Chat Summary.exe 在项目目录里，或用 -Exe 指定完整路径。'
    exit 2
}
$exeItem = Get-Item -LiteralPath $Exe
Write-Info ('目标 exe ：' + $exeItem.FullName)
Write-Info ('大小/时间：' + $exeItem.Length + ' 字节 / ' + $exeItem.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))
Write-Info ('PowerShell：' + $PSVersionTable.PSVersion.ToString())

if (-not (Test-Path -LiteralPath $SignDir)) {
    New-Item -ItemType Directory -Path $SignDir -Force | Out-Null
    Write-Info ('已创建目录：' + $SignDir)
}

# ---------------------------------------------------------------- 1. 证书
Write-Banner '1/6  自签名代码签名证书（CurrentUser\My）'

$cert = $null
$certs = @(Get-OurCerts | Where-Object { $_.HasPrivateKey } | Sort-Object NotAfter -Descending)
if ($certs.Count -gt 0) {
    $candidate = $certs[0]
    $hasCodeSigningEku = $false
    foreach ($ext in $candidate.Extensions) {
        if ($ext.Oid.Value -eq '2.5.29.37' -and $ext.Format($false) -match '1\.3\.6\.1\.5\.5\.7\.3\.3') { $hasCodeSigningEku = $true }
    }
    $tooOld = ($candidate.NotAfter -lt (Get-Date).AddDays(30))
    if ($hasCodeSigningEku -and -not $tooOld) {
        $cert = $candidate
        Write-Ok ('复用已有证书：' + $cert.Thumbprint)
        Write-Info ('  主题：' + $cert.Subject)
        Write-Info ('  到期：' + $cert.NotAfter.ToString('yyyy-MM-dd HH:mm:ss') + '（私钥留在本机、不可导出）')
    }
    else {
        $reason = '缺少 Code Signing 用途'
        if (-not $hasCodeSigningEku) { $reason = '缺少 Code Signing 用途（EKU 1.3.6.1.5.5.7.3.3）' }
        if ($tooOld) { $reason = '证书将在 30 天内到期' }
        Write-Warn2 ('已有证书不可用（' + $reason + '），将重新生成，并清理旧的自签名证书。')
        foreach ($old in $certs) {
            try { Remove-Item -LiteralPath ('Cert:\CurrentUser\My\' + $old.Thumbprint) -Force -ErrorAction Stop; Write-Info ('  已删除旧证书 ' + $old.Thumbprint) }
            catch { Write-Warn2 ('  删除旧证书失败（可忽略）：' + $old.Thumbprint + ' - ' + $_.Exception.Message) }
        }
        $cert = $null
    }
}

if (-not $cert) {
    try {
        $cert = New-SelfSignedCertificate -Type CodeSigningCert `
            -Subject $OurSubject `
            -FriendlyName 'Submerge 代码签名（本机自签名）' `
            -CertStoreLocation 'Cert:\CurrentUser\My' `
            -KeyExportPolicy NonExportable `
            -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 `
            -NotAfter (Get-Date).AddYears(5) `
            -ErrorAction Stop
    }
    catch {
        Write-Err2 '[错误] 生成自签名证书失败。'
        Write-Err2 ('       系统返回：' + $_.Exception.Message)
        Write-Err2 '       常见原因：证书服务（CryptSvc）被停用、组策略禁止用户证书、PowerShell 版本过低。'
        exit 2
    }
    Write-Ok ('已生成新证书：' + $cert.Thumbprint)
    Write-Info ('  主题：' + $cert.Subject)
    Write-Info ('  到期：' + $cert.NotAfter.ToString('yyyy-MM-dd HH:mm:ss'))
}

# 导出公钥证书（给「手动安装」和「对外分发说明」用；不含私钥）
try {
    Export-Certificate -Cert $cert -FilePath $CerPath -Type CERT -Force -ErrorAction Stop | Out-Null
    Write-Info ('公钥证书已导出：' + $CerPath)
}
catch {
    Write-Warn2 ('导出公钥证书失败（不影响签名）：' + $_.Exception.Message)
}

# ---------------------------------------------------------------- 2. TrustedPublisher
Write-Banner '2/6  装进「受信任的发布者」（CurrentUser\TrustedPublisher）'

$tp = @(Test-CertInStore 'Cert:\CurrentUser\TrustedPublisher')
if ($tp.Count -gt 0) {
    Write-Ok ('已存在，跳过：' + $tp[0].Thumbprint)
}
else {
    try {
        Install-CertToStore $CerPath 'Cert:\CurrentUser\TrustedPublisher'
        $tp = @(Test-CertInStore 'Cert:\CurrentUser\TrustedPublisher')
        if ($tp.Count -gt 0) { Write-Ok ('已导入：' + $tp[0].Thumbprint) }
        else {
            Write-Err2 '[错误] 导入「受信任的发布者」后仍读不到证书。'
            [void]$Failures.Add('TrustedPublisher 导入无效')
        }
    }
    catch {
        Write-Err2 '[错误] 导入「受信任的发布者」失败。'
        Write-Err2 ('       系统返回：' + $_.Exception.Message)
        [void]$Failures.Add('TrustedPublisher 导入失败：' + $_.Exception.Message)
    }
}

# ---------------------------------------------------------------- 3. Root
Write-Banner '3/6  装进「受信任的根证书颁发机构」（CurrentUser\Root）'

$root = @(Test-CertInStore 'Cert:\CurrentUser\Root')
if ($root.Count -gt 0) {
    $RootState = '已存在'
    Write-Ok ('已存在，跳过：' + $root[0].Thumbprint)
}
elseif ($NoRoot) {
    $RootState = '已按 -NoRoot 跳过'
    Write-Warn2 '已按 -NoRoot 跳过根证书安装（exe 签名状态不会是 Valid，但不影响清 MOTW）。'
}
else {
    Write-Info 'Windows 规定：把自签名证书放进「受信任的根证书颁发机构」必须由你本人确认一次。'
    Write-Info '下面先尝试静默导入；如果系统要求确认，本步骤不会卡死，会把后续做法写清楚。'

    $rootError = ''
    try {
        Install-CertToStore $CerPath 'Cert:\CurrentUser\Root'
    }
    catch {
        $rootError = $_.Exception.Message
    }
    $root = @(Test-CertInStore 'Cert:\CurrentUser\Root')

    if ($root.Count -gt 0) {
        $RootState = '已安装'
        Write-Ok ('已导入根证书：' + $root[0].Thumbprint)
    }
    elseif ($RootConsent) {
        Write-Warn2 '静默导入未成功，改为打开一次系统「安全警告」窗口，请在其中点「是」。'
        Write-Warn2 ('最多等待 ' + $RootConsentTimeoutSec + ' 秒。')
        $certutil = Join-Path $env:SystemRoot 'System32\certutil.exe'
        if (-not (Test-Path -LiteralPath $certutil)) {
            Write-Err2 '[错误] 找不到 certutil.exe，无法弹出确认窗口。'
            [void]$Failures.Add('找不到 certutil.exe')
        }
        else {
            $argLine = '-addstore -f -user Root "' + $CerPath + '"'
            try {
                $proc = Start-Process -FilePath $certutil -ArgumentList $argLine -PassThru -WindowStyle Hidden -ErrorAction Stop
                $done = $proc.WaitForExit($RootConsentTimeoutSec * 1000)
                if (-not $done) {
                    try { $proc.Kill() } catch { }
                    Write-Err2 ('[超时] ' + $RootConsentTimeoutSec + ' 秒内没有点「是」，已结束等待（没有装进 Root）。')
                    $rootError = '等待确认超时'
                }
                else {
                    Write-Info ('certutil 退出码：' + $proc.ExitCode)
                }
            }
            catch {
                Write-Err2 ('[错误] 启动 certutil 失败：' + $_.Exception.Message)
                $rootError = $_.Exception.Message
            }
            $root = @(Test-CertInStore 'Cert:\CurrentUser\Root')
            if ($root.Count -gt 0) {
                $RootState = '已安装（经你确认）'
                Write-Ok ('已导入根证书：' + $root[0].Thumbprint)
            }
        }
    }

    if ($root.Count -eq 0) {
        $RootState = '未确认（需要点一次「是」）'
        Write-Host ''
        Write-Warn2 '【需要你点一次「是」】根证书还没装进 Root，原因：'
        if ($rootError -ne '') { Write-Warn2 ('  系统返回：' + $rootError) }
        else { Write-Warn2 '  Windows 要求在弹窗里由你本人确认（不会静默安装根证书，这是系统安全设计）。' }
        Write-Info ''
        Write-Info '影响范围（说清楚，不夸大）：'
        Write-Info '  - 「清 MOTW」不受影响：双击 exe 不会因为这个原因重新弹蓝色 SmartScreen。'
        Write-Info '  - 受影响的是签名状态：exe 属性里能看到签名者和时间，但状态显示「根证书不受信任」。'
        Write-Info ''
        Write-Info '三种完成方式（任选其一，做完再跑一次本脚本即可复核）：'
        Write-Info '  1) 双击 工具\安装信任并解除锁定.bat（它会带 -RootConsent，在「安全警告」里点「是」）'
        Write-Info ('  2) 双击 ' + $CerPath + ' → 安装证书 → 当前用户 → 放入「受信任的根证书颁发机构」')
        Write-Info ('  3) 命令：certutil -addstore -f -user Root "' + $CerPath + '"，在弹窗里点「是」')
        Write-Info ''
        [void]$Warnings.Add('根证书未确认（签名状态不会是 Valid）')
    }
}

# ---------------------------------------------------------------- 4. 清 MOTW
Write-Banner '4/6  递归清除 MOTW（Zone.Identifier，「从网络下载」标记）—— 这条才是 SmartScreen 的关键'

$files = @(Get-ChildItem -LiteralPath $ProjRoot -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $Exts -contains $_.Extension.ToLower() })
Write-Info ('扫描范围：' + $ProjRoot + '（递归）')
Write-Info ('文件类型：exe / bat / dll / ps1 / md；共 ' + $files.Count + ' 个文件')

$motwBefore = @(Get-MotwFiles $files)
Write-Info ('带 MOTW 的文件：' + $motwBefore.Count + ' 个')

$clearedCount = 0
$clearFails = @()
foreach ($f in $motwBefore) {
    try {
        Unblock-File -LiteralPath $f.FullName -ErrorAction Stop
        $still = Get-Item -LiteralPath $f.FullName -Stream 'Zone.Identifier' -ErrorAction SilentlyContinue
        if ($still) {
            $clearFails += ($f.FullName + '  → 清除后仍然存在（可能被占用或权限不足）')
        }
        else {
            $clearedCount++
            Write-Ok ('已清除：' + $f.FullName)
        }
    }
    catch {
        $clearFails += ($f.FullName + '  → ' + $_.Exception.Message)
    }
}

$motwAfter = @(Get-MotwFiles $files)
if ($clearFails.Count -gt 0) {
    Write-Err2 ('[部分失败] ' + $clearFails.Count + ' 个文件没能清除 MOTW：')
    foreach ($cf in $clearFails) { Write-Err2 ('  - ' + $cf) }
    [void]$Failures.Add($clearFails.Count.ToString() + ' 个文件清除 MOTW 失败')
}
if ($motwBefore.Count -eq 0) {
    Write-Ok '这些文件本来就没有 MOTW，不需要处理（可重复执行）。'
}
else {
    Write-Ok ('已清除 ' + $clearedCount + ' 个，仍带 MOTW 的 ' + $motwAfter.Count + ' 个。')
}

# ---------------------------------------------------------------- 5. 签名
Write-Banner '5/6  用自签名证书给 exe 做 Authenticode 签名（SHA256，不联网）'

if ($NoSign) {
    $SignState = '已按 -NoSign 跳过'
    Write-Warn2 '已按 -NoSign 跳过签名。'
}
else {
    if (-not $cert.HasPrivateKey) {
        Write-Err2 '[错误] 证书没有私钥，无法签名。请删掉该证书后重新运行本脚本。'
        [void]$Failures.Add('证书无私钥')
        $SignState = '失败（无私钥）'
    }
    else {
        $sigNow = Get-AuthenticodeSignature -LiteralPath $Exe -ErrorAction SilentlyContinue
        $alreadyOk = $false
        if ($sigNow -and $sigNow.Status -eq 'Valid' -and $sigNow.SignerCertificate) {
            if ($sigNow.SignerCertificate.Thumbprint -eq $cert.Thumbprint) { $alreadyOk = $true }
        }
        if ($alreadyOk) {
            $SignState = '已是最新（跳过重复签名）'
            Write-Ok '这个 exe 已经是本证书签好的有效签名，跳过重复签名（重复执行安全）。'
        }
        else {
            $signed = $false
            if (-not [string]::IsNullOrWhiteSpace($TimestampServer)) {
                Write-Info ('尝试带时间戳签名（需要联网）：' + $TimestampServer)
                try {
                    $sig = Set-AuthenticodeSignature -LiteralPath $Exe -Certificate $cert -HashAlgorithm SHA256 -TimestampServer $TimestampServer -ErrorAction Stop
                    $sig = Get-AuthenticodeSignature -LiteralPath $Exe -ErrorAction SilentlyContinue
                    if ($sig -and $sig.SignerCertificate) { $signed = $true }
                }
                catch {
                    Write-Warn2 ('带时间戳签名失败：' + $_.Exception.Message)
                    Write-Warn2 '按设计改为不带时间戳重试（离线环境推荐做法）。'
                }
                if (-not $signed) {
                    Write-Warn2 '时间戳签名没成功，改走无时间戳路径（会覆盖刚才写入的签名块）。'
                }
            }
            if (-not $signed) {
                try {
                    $null = Set-AuthenticodeSignature -LiteralPath $Exe -Certificate $cert -HashAlgorithm SHA256 -ErrorAction Stop
                    $signed = $true
                }
                catch {
                    Write-Err2 '[错误] 签名失败。'
                    Write-Err2 ('       系统返回：' + $_.Exception.Message)
                    Write-Err2 '       常见原因：exe 正在运行（被占用）、没有写权限、证书私钥不可用。'
                    Write-Err2 '       处理：先退出 QQ Chat Summary.exe（任务管理器结束进程），再重跑本脚本。'
                    [void]$Failures.Add('签名失败：' + $_.Exception.Message)
                    $SignState = '失败'
                }
            }
            if ($signed) {
                $check = Get-AuthenticodeSignature -LiteralPath $Exe -ErrorAction SilentlyContinue
                if ($check -and $check.SignerCertificate) {
                    if ($check.Status -eq 'Valid') {
                        $SignState = 'Valid（已签名并受本机信任）'
                        Write-Ok ('签名成功：' + $check.SignerCertificate.Subject)
                        Write-Ok ('状态：Valid　指纹：' + $check.SignerCertificate.Thumbprint)
                    }
                    else {
                        $SignState = $check.Status.ToString()
                        Write-Warn2 ('签名已写入，但状态是：' + $check.Status)
                        Write-Warn2 ('系统说明：' + $check.StatusMessage)
                        if ($RootState -ne '已安装' -and $RootState -ne '已存在' -and $RootState -ne '已安装（经你确认）') {
                            Write-Warn2 '原因基本可以确定：根证书还没进 CurrentUser\Root（见第 3 步），不是签名写坏了。'
                        }
                        [void]$Warnings.Add('签名状态为 ' + $check.Status + '（' + $check.StatusMessage + '）')
                    }
                }
                else {
                    Write-Err2 '[错误] 签名后读不到签名者信息，签名很可能没写进去。'
                    [void]$Failures.Add('签名后校验不到签名者')
                    $SignState = '失败（校验不到签名者）'
                }
            }
        }
    }
}

# 签名不会加 MOTW，但为稳妥再确认一次（尤其签名把文件重写过）
$exeMotw = Get-Item -LiteralPath $Exe -Stream 'Zone.Identifier' -ErrorAction SilentlyContinue
if ($exeMotw) {
    try { Unblock-File -LiteralPath $Exe -ErrorAction Stop; Write-Ok '签名后又发现 exe 带 MOTW，已再次清除。' }
    catch { [void]$Failures.Add('签名后 exe 仍带 MOTW：' + $_.Exception.Message) }
}

# ---------------------------------------------------------------- 6. 汇总
Write-Banner '6/6  结果汇总'

$finalSig = Get-AuthenticodeSignature -LiteralPath $Exe -ErrorAction SilentlyContinue
$finalMotw = Get-Item -LiteralPath $Exe -Stream 'Zone.Identifier' -ErrorAction SilentlyContinue
$rootNow = @(Test-CertInStore 'Cert:\CurrentUser\Root')
$tpNow = @(Test-CertInStore 'Cert:\CurrentUser\TrustedPublisher')

$certTp = '（无）'
if ($cert) { $certTp = $cert.Thumbprint }
$rootText = '未安装'
if ($rootNow.Count -gt 0) { $rootText = $rootNow[0].Thumbprint }
$tpText = '未安装'
if ($tpNow.Count -gt 0) { $tpText = $tpNow[0].Thumbprint }

$sigText = '（无签名）'
if ($finalSig -and $finalSig.SignerCertificate) { $sigText = $finalSig.Status.ToString() }
$motwText = '干净（无 MOTW）'
if ($finalMotw) { $motwText = '仍带 MOTW' }

$rows = @(
    @('证书指纹', $certTp),
    @('证书到期', $(if ($cert) { $cert.NotAfter.ToString('yyyy-MM-dd') } else { '-' })),
    @('TrustedPublisher', $tpText),
    @('CurrentUser\Root', $rootText),
    @('exe 签名状态', $sigText),
    @('exe 的 MOTW', $motwText),
    @('Root 处理结果', $RootState),
    @('签名处理结果', $SignState)
)
foreach ($r in $rows) {
    $color = 'Gray'
    if ($r[1] -match 'Valid') { $color = 'Green' }
    if ($r[1] -match '未安装|未确认|失败|仍带') { $color = 'Yellow' }
    Write-Host ('  ' + (Format-Label $r[0] 18) + '：' + $r[1]) -ForegroundColor $color
}

Write-Host ''
if ($motwAfter.Count -gt 0) {
    Write-Err2 ('[未完成] 仍有 ' + $motwAfter.Count + ' 个文件带 MOTW，双击 exe 仍可能弹蓝色 SmartScreen。')
    Write-Err2 '         常见原因：文件被其他进程占用（如正在运行的 QQ 摘要），关闭后重跑本脚本。'
}
else {
    Write-Ok '结论：项目目录内已无 MOTW —— 双击 QQ Chat Summary.exe 不会再因「来自网络」弹蓝色 SmartScreen。'
}

if ($Warnings.Count -gt 0) {
    Write-Host ''
    Write-Warn2 '遗留事项（不影响清 MOTW 的效果）：'
    foreach ($w in $Warnings) { Write-Warn2 ('  - ' + $w) }
}

Write-Host ''
Write-Host '  下一步：' -ForegroundColor Cyan
Write-Host '    1) 复核：powershell -NoProfile -ExecutionPolicy Bypass -File .\工具\检查安全提示.ps1' -ForegroundColor Gray
Write-Host '    2) 启动：双击「启动 QQ 摘要.bat」' -ForegroundColor Gray
Write-Host '    3) 回滚：powershell -NoProfile -ExecutionPolicy Bypass -File .\工具\移除信任.ps1' -ForegroundColor Gray
Write-Host ''

if ($Failures.Count -gt 0) {
    Write-Err2 ('汇总：' + $Failures.Count + ' 个步骤失败。')
    foreach ($f in $Failures) { Write-Err2 ('  - ' + $f) }
    exit 2
}
if ($Warnings.Count -gt 0) { exit 1 }
exit 0
