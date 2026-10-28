#requires -version 5.0
<#
  检查安全提示.ps1（v0.7）—— 只读诊断：双击 QQ Chat Summary.exe 会不会弹蓝色 SmartScreen

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File .\工具\检查安全提示.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File .\工具\检查安全提示.ps1 -All
    powershell -NoProfile -ExecutionPolicy Bypass -File .\工具\检查安全提示.ps1 -Target "D:\某处\QQ Chat Summary.exe"

  看什么：MOTW（Zone.Identifier 备用数据流，逐文件）、Authenticode 签名状态、证书是否在
          CurrentUser\My / Root / TrustedPublisher、SmartScreen 与 Smart App Control 策略值、
          Defender 实时防护状态。
  结论依据：本项目的蓝色弹窗「Windows 已保护你的电脑」已定位为 **文件带 MOTW** 才触发；
          另有 Smart App Control 开启时会拦截低信誉程序（独立条件，单独报告）。
  只读：不写文件、不改注册表、不装证书、不联网。
  退出码：0 = 干净，3 = 发现 MOTW，2 = 参数/路径错误。
#>
[CmdletBinding()]
param(
    [string]$Target = '',
    [switch]$All
)

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$ErrorActionPreference = 'SilentlyContinue'

$ProjRoot   = Split-Path -Parent $PSScriptRoot
$OurCN      = 'Submerge'
$OurSubject = 'CN=' + $OurCN
$Exts       = @('.exe', '.bat', '.dll', '.ps1', '.md')
$Line       = ('-' * 74)

function Get-DisplayWidth([string]$s) {
    $w = 0
    foreach ($ch in $s.ToCharArray()) {
        if ([int]$ch -gt 255) { $w += 2 } else { $w += 1 }
    }
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
function Write-Row([string]$label, [string]$value, [string]$color) {
    if ([string]::IsNullOrEmpty($color)) { $color = 'Gray' }
    Write-Host ('  ' + (Format-Label $label 22) + '：' + $value) -ForegroundColor $color
}

function Get-MotwInfo([string]$path) {
    $s = Get-Item -LiteralPath $path -Stream 'Zone.Identifier' -ErrorAction SilentlyContinue
    if (-not $s) { return $null }
    $lines = @()
    try { $lines = @(Get-Content -LiteralPath ($path + ':Zone.Identifier') -ErrorAction Stop) } catch { $lines = @() }
    $zone = ''
    $url = ''
    foreach ($ln in $lines) {
        if ($ln -match '^\s*ZoneId\s*=\s*(-?[0-9]+)') { $zone = $Matches[1] }
        if ($ln -match '^\s*HostUrl\s*=\s*(.+)$')      { $url = $Matches[1].Trim() }
    }
    return [pscustomobject]@{ ZoneId = $zone; HostUrl = $url; Lines = $lines }
}
function Get-ZoneText([string]$zone) {
    switch ($zone) {
        '0'     { return '0 本地计算机' }
        '1'     { return '1 本地 Intranet' }
        '2'     { return '2 受信任的站点' }
        '3'     { return '3 Internet（从网络下载）' }
        '4'     { return '4 受限制的站点' }
        default { return ($zone + '（未知）') }
    }
}
function Test-CertInStore([string]$storePath, [string]$subject) {
    return @(Get-ChildItem -LiteralPath $storePath -ErrorAction SilentlyContinue |
        Where-Object { $_.Subject -eq $subject })
}
function Read-Reg([string]$path, [string]$name, [string]$label, [string]$meaning) {
    $v = (Get-ItemProperty -LiteralPath $path -Name $name -ErrorAction SilentlyContinue).$name
    if ($null -eq $v) {
        Write-Row $label '未设置（用系统默认）' 'Gray'
        return $null
    }
    Write-Row $label ([string]$v + '    ' + $meaning) 'Gray'
    return $v
}

# ---------------------------------------------------------------- 参数与范围
Write-Banner '检查安全提示（v0.7，只读）'

if ([string]::IsNullOrWhiteSpace($Target)) { $Target = $ProjRoot }
if (-not (Test-Path -LiteralPath $Target)) {
    Write-Host ('[错误] 找不到路径：' + $Target) -ForegroundColor Red
    Write-Host '        请检查路径是否写错；省略参数表示检查整个项目目录。' -ForegroundColor Red
    exit 2
}

$targetItem = Get-Item -LiteralPath $Target
if ($targetItem.PSIsContainer) {
    $scanRoot = $targetItem.FullName
    $files = @(Get-ChildItem -LiteralPath $scanRoot -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $Exts -contains $_.Extension.ToLower() })
    $scopeText = '整个目录（递归）：' + $scanRoot
}
else {
    $files = @($targetItem)
    $scopeText = '单个文件：' + $targetItem.FullName
}
$files = @($files | Sort-Object -Property FullName)

Write-Banner '1/5  文件范围'
Write-Row '检查范围' $scopeText
Write-Row '文件类型' 'exe / bat / dll / ps1 / md'
Write-Row '文件总数' ([string]$files.Count)
Write-Row '检查时间' ((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))

if ($files.Count -eq 0) {
    Write-Host '  [提示] 这个范围里没有 exe/bat/dll/ps1/md 文件，下面只看证书与系统策略。' -ForegroundColor Yellow
}

# ---------------------------------------------------------------- MOTW
Write-Banner '2/5  MOTW（「从网络下载」标记，Zone.Identifier 备用数据流）'

$motwFiles = @()
$statusMap = @{}
foreach ($f in $files) {
    $info = Get-MotwInfo $f.FullName
    if ($info) {
        $motwFiles += [pscustomobject]@{ File = $f; Info = $info }
        $statusMap[$f.FullName] = $info
    }
}

if ($files.Count -gt 0) {
    Write-Host '  [逐文件状态]（干净 = 无 Zone.Identifier）' -ForegroundColor DarkGray
    foreach ($f in $files) {
        if ($statusMap.ContainsKey($f.FullName)) {
            Write-Host ('    有 MOTW   ' + $f.FullName) -ForegroundColor Yellow
        }
        else {
            Write-Host ('    干净      ' + $f.FullName) -ForegroundColor DarkGray
        }
    }
}

if ($motwFiles.Count -eq 0) {
    Write-Host ''
    Write-Row '带 MOTW 的文件' '0 个' 'Green'
    Write-Host '  → 这些文件都没有 Zone.Identifier，双击不会被 SmartScreen 以「来源不可信」拦下。' -ForegroundColor Green
}
else {
    Write-Host ''
    Write-Row '带 MOTW 的文件' ($motwFiles.Count.ToString() + ' 个（共检查 ' + $files.Count + ' 个）') 'Yellow'
    foreach ($m in $motwFiles) {
        Write-Host ''
        Write-Host ('    ' + $m.File.FullName) -ForegroundColor Yellow
        Write-Host ('      ZoneId = ' + (Get-ZoneText $m.Info.ZoneId)) -ForegroundColor Yellow
        if ($m.Info.HostUrl -ne '') { Write-Host ('      HostUrl = ' + $m.Info.HostUrl) -ForegroundColor DarkYellow }
        Write-Host ('      大小 ' + $m.File.Length + ' 字节，修改于 ' + $m.File.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')) -ForegroundColor DarkGray
        if ($All) {
            foreach ($ln in $m.Info.Lines) { Write-Host ('      | ' + $ln) -ForegroundColor DarkGray }
        }
    }
}

# ---------------------------------------------------------------- 签名
Write-Banner '3/5  数字签名（Authenticode）'

$exeFiles = @($files | Where-Object { $_.Extension.ToLower() -eq '.exe' })
if ($exeFiles.Count -eq 0) {
    Write-Row '可执行文件' '范围内没有 exe' 'Yellow'
}
else {
    foreach ($exe in $exeFiles) {
        $sig = Get-AuthenticodeSignature -LiteralPath $exe.FullName -ErrorAction SilentlyContinue
        Write-Host ''
        Write-Host ('    ' + $exe.FullName) -ForegroundColor Gray
        if (-not $sig) {
            Write-Host '      [错误] 读取签名失败（文件被占用、无权限或不是 PE 文件）' -ForegroundColor Red
            continue
        }
        $stColor = 'Yellow'
        if ($sig.Status -eq 'Valid')     { $stColor = 'Green' }
        if ($sig.Status -eq 'NotSigned') { $stColor = 'DarkYellow' }
        Write-Host ('      Status      = ' + $sig.Status) -ForegroundColor $stColor
        if ($sig.Status -ne 'NotSigned') {
            Write-Host ('      StatusText  = ' + $sig.StatusMessage) -ForegroundColor DarkGray
        }
        if ($sig.SignerCertificate) {
            Write-Host ('      签名者      = ' + $sig.SignerCertificate.Subject) -ForegroundColor Gray
            Write-Host ('      指纹        = ' + $sig.SignerCertificate.Thumbprint) -ForegroundColor DarkGray
        }
        else {
            Write-Host '      签名者      = （未签名）' -ForegroundColor DarkYellow
            Write-Host '      说明        = 没有 Authenticode 签名，右键「属性 → 数字签名」里看不到发布者。' -ForegroundColor DarkGray
        }
    }
}

# ---------------------------------------------------------------- 证书
Write-Banner '4/5  自签名证书安装情况（只影响「发布者名称/信任链」，不影响 SmartScreen 声誉）'

$myCerts  = @(Get-ChildItem 'Cert:\CurrentUser\My' -ErrorAction SilentlyContinue | Where-Object { $_.Subject -eq $OurSubject })
$rootCert = @(Test-CertInStore 'Cert:\CurrentUser\Root' $OurSubject)
$tpCert   = @(Test-CertInStore 'Cert:\CurrentUser\TrustedPublisher' $OurSubject)

if ($myCerts.Count -eq 0) {
    Write-Row 'CurrentUser\My' '没有（还没跑过安装脚本）' 'DarkYellow'
}
else {
    foreach ($c in $myCerts) {
        $keyText = '无私钥'
        if ($c.HasPrivateKey) { $keyText = '有私钥' }
        Write-Row 'CurrentUser\My' ($c.Thumbprint + '  到期 ' + $c.NotAfter.ToString('yyyy-MM-dd') + '  ' + $keyText) 'Gray'
    }
    $eku = @()
    foreach ($c in $myCerts) {
        foreach ($e in $c.Extensions) {
            if ($e.Oid.Value -eq '2.5.29.37') { $eku += $e.Format($false) }
        }
    }
    if ($eku.Count -gt 0) { Write-Row '增强型密钥用法' ($eku -join ' / ') 'DarkGray' }
}

if ($rootCert.Count -eq 0) { Write-Row 'CurrentUser\Root' '没有（根信任未确认）' 'DarkYellow' }
else                       { Write-Row 'CurrentUser\Root' ($rootCert[0].Thumbprint + '  到期 ' + $rootCert[0].NotAfter.ToString('yyyy-MM-dd')) 'Green' }

if ($tpCert.Count -eq 0)   { Write-Row 'TrustedPublisher' '没有' 'DarkYellow' }
else                       { Write-Row 'TrustedPublisher' ($tpCert[0].Thumbprint + '  到期 ' + $tpCert[0].NotAfter.ToString('yyyy-MM-dd')) 'Green' }

if ($myCerts.Count -gt 0) {
    $probe = $myCerts[0]
    $chain = New-Object System.Security.Cryptography.X509Certificates.X509Chain
    $chain.ChainPolicy.RevocationMode = [System.Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
    $built = $chain.Build($probe)
    if ($built) {
        Write-Row '本机信任链' '通过（该证书可作为受信任的根）' 'Green'
    }
    else {
        $statuses = @($chain.ChainStatus | ForEach-Object { $_.Status.ToString() })
        Write-Row '本机信任链' ('不通过：' + ($statuses -join ', ')) 'Yellow'
        Write-Host '      → 根证书还没被本机确认信任，所以 exe 签名状态不会显示为 Valid。' -ForegroundColor DarkYellow
    }
}
else {
    Write-Row '本机信任链' '无证书可验证' 'DarkGray'
}

# ---------------------------------------------------------------- 系统策略
Write-Banner '5/5  SmartScreen / Smart App Control / Defender（只读取值，不做修改）'

$null = Read-Reg 'HKCU:\Software\Microsoft\Windows\CurrentVersion\AppHost' 'EnableWebContentEvaluation' 'SmartScreen 内容评估' '（1=开，0=关）'
$null = Read-Reg 'HKCU:\Software\Microsoft\Windows\CurrentVersion\AppHost' 'PreventOverride' 'SmartScreen 禁止覆盖' '（1=用户不能点「仍要运行」）'
$null = Read-Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\System' 'EnableSmartScreen' '策略：SmartScreen' '（0=关闭，1=开启）'
$null = Read-Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\System' 'ShellSmartScreenLevel' '策略：级别' '（Warn=警告 / Block=阻止）'
$null = Read-Reg 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer' 'SmartScreenEnabled' '资源管理器 SmartScreen' '（旧值，Win11 多为空）'

$sac = (Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy' -Name 'VerifiedAndReputablePolicyState' -ErrorAction SilentlyContinue).VerifiedAndReputablePolicyState
if ($null -eq $sac) {
    Write-Row 'Smart App Control' '未设置（读不到，通常等于关闭）' 'Gray'
}
else {
    $sacText = [string]$sac + ' = 关闭'
    if ($sac -eq 1) { $sacText = '1 = 开启（会拦截低信誉程序，与 MOTW 无关）' }
    if ($sac -eq 2) { $sacText = '2 = 评估模式' }
    $sacColor = 'Gray'
    if ($sac -eq 1) { $sacColor = 'Yellow' }
    Write-Row 'Smart App Control' $sacText $sacColor
}

try {
    $mp = Get-MpComputerStatus -ErrorAction Stop
    $rt = '否'
    if ($mp.RealTimeProtectionEnabled) { $rt = '是' }
    Write-Row 'Defender 实时防护' $rt 'Gray'
}
catch {
    Write-Row 'Defender 实时防护' '读取失败（未安装 Defender 或权限不足）' 'DarkGray'
}

# ---------------------------------------------------------------- 结论
Write-Banner '结论：双击 QQ Chat Summary.exe 会不会弹蓝色 SmartScreen'

$motwExes = @($motwFiles | Where-Object { $_.File.Extension.ToLower() -eq '.exe' })
$motwBats = @($motwFiles | Where-Object { $_.File.Extension.ToLower() -eq '.bat' })
$motwOth  = @($motwFiles | Where-Object { @('.exe', '.bat') -notcontains $_.File.Extension.ToLower() })

if ($motwExes.Count -gt 0) {
    Write-Host ''
    Write-Host '  【判定】会弹「Windows 已保护你的电脑 / Microsoft Defender SmartScreen 阻止了无法识别的应用启动」' -ForegroundColor Red
    Write-Host '  【依据】下面这些 exe 带 MOTW（Zone.Identifier）。SmartScreen 对「来自网络 + 无信誉」的文件会拦截；' -ForegroundColor Yellow
    Write-Host '          v0.6 的清标记是在程序启动后做的，来不及挡第一次双击。' -ForegroundColor Yellow
    foreach ($m in $motwExes) { Write-Host ('          - ' + $m.File.FullName + '  ZoneId=' + $m.Info.ZoneId) -ForegroundColor Yellow }
    Write-Host '  【处理】任选其一：' -ForegroundColor Green
    Write-Host '          1) 跑 工具\安装信任并解除锁定.ps1（递归清 MOTW + 自签名），之后复查应报「不会弹」' -ForegroundColor Green
    Write-Host '          2) 双击 启动 QQ 摘要.bat（先递归清标记，再启动）' -ForegroundColor Green
    Write-Host '          3) 右键该 exe → 属性 → 勾「解除锁定」→ 确定' -ForegroundColor Green
    $verdict = '会弹'
}
elseif ($motwFiles.Count -gt 0) {
    Write-Host ''
    Write-Host '  【判定】双击 exe 不会因 MOTW 弹蓝色 SmartScreen（exe 本身没有 MOTW）' -ForegroundColor Green
    Write-Host '  【依据】带 MOTW 的只是非 exe 文件：' -ForegroundColor Yellow
    foreach ($m in ($motwBats + $motwOth)) { Write-Host ('          - ' + $m.File.FullName) -ForegroundColor Yellow }
    if ($motwBats.Count -gt 0) {
        Write-Host '          bat 自己带 MOTW 时，双击 bat 会先弹一次黄色「打开文件 - 安全警告」，点「运行」即可；' -ForegroundColor Yellow
        Write-Host '          跑一次后脚本会把它自己也递归解锁，第二次双击就干净了。' -ForegroundColor Yellow
    }
    Write-Host '  【处理】跑一次 工具\安装信任并解除锁定.ps1 或 启动 QQ 摘要.bat 即可全部清掉。' -ForegroundColor Green
    $verdict = 'exe 不会弹'
}
else {
    Write-Host ''
    Write-Host '  【判定】不会弹蓝色 SmartScreen' -ForegroundColor Green
    Write-Host '  【依据】本次检查范围内没有任何文件带 MOTW（Zone.Identifier），不满足已确认的触发条件。' -ForegroundColor Green
    Write-Host '  【注意】若你重新从网盘 / 邮件 / 浏览器下载一次这个 exe，MOTW 会重新出现，弹窗也会回来。' -ForegroundColor Yellow
    $verdict = '不会弹'
}

if ($rootCert.Count -eq 0 -and $myCerts.Count -gt 0) {
    Write-Host ''
    Write-Host '  【补充】根证书尚未确认（CurrentUser\Root 里没有），exe 签名状态不会是 Valid；' -ForegroundColor DarkYellow
    Write-Host '          这不影响清 MOTW 的效果，也不会让 SmartScreen 弹窗变多。' -ForegroundColor DarkYellow
}

Write-Host ''
Write-Host ('  本次结论：' + $verdict) -ForegroundColor Cyan
if ($sac -eq 1) {
    Write-Host '  【另一条风险】Smart App Control 处于「开启」：它可能拦截任何低信誉程序，与 MOTW 无关，' -ForegroundColor Yellow
    Write-Host '              需要单独评估（本工具不修改、也不建议关闭系统安全功能）。' -ForegroundColor Yellow
}
Write-Host ''
Write-Host '  详细说明见 docs\v07-security.md' -ForegroundColor DarkGray
Write-Host ''

if ($motwFiles.Count -gt 0) { exit 3 }
exit 0
