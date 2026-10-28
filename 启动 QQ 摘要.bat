@echo off
rem =====================================================================
rem  启动 QQ 摘要（v0.7.6）
rem
rem  作用：先把整个目录里 exe/bat/dll/ps1/md 的「从网络下载」标记（MOTW）
rem        递归清掉，再启动主程序（QQ Chat Summary.exe 或 QChatSummary.exe）。
rem        这样双击本 bat 不会触发蓝色「Windows 已保护你的电脑」。
rem
rem  说明：等价于右键文件、属性、勾「解除锁定」；
rem        不改注册表、不关 Defender、不联网、不需要管理员。
rem
rem  兼容：本文件自己带 MOTW 时，第一次双击会先弹一次黄色
rem        「打开文件 - 安全警告」，点「运行」即可；
rem        跑起来之后它也会把自己一起解锁，第二次就干净了。
rem        即使 PowerShell 不可用或清标记失败，也照样启动程序。
rem
rem  编码：本文件用 GBK（代码页 936）保存。
rem        改成 UTF-8 会让 cmd 解析中文时断行出错（已实测），所以别改编码。
rem =====================================================================
setlocal
cd /d "%~dp0"

rem 完整性级别：Low IL 的 exe 写不了 %LOCALAPPDATA%，NapCat/QQ 会立刻退出。
rem 打包时已是 Medium，这里再兜底一次（失败不阻塞）。
icacls "%~dp0." /setintegritylevel (OI)(CI)Medium /T >nul 2>&1

rem 兼容两种主程序文件名（带空格 / 不带空格）
set "APP=QQ Chat Summary.exe"
if not exist "%APP%" set "APP=QChatSummary.exe"
if not exist "%APP%" (
  echo [错误] 当前目录没有主程序：QQ Chat Summary.exe 或 QChatSummary.exe。
  echo        请把本文件和主程序放在同一个文件夹里。
  pause
  exit /b 1
)

echo 正在清理「从网络下载」标记并启动 QQ 聊天记录 AI 摘要...
echo （清标记失败不影响启动，程序会照常打开）

rem ---- 递归清 MOTW：整个目录，只处理 exe/bat/dll/ps1/md；失败不中断 ----
where powershell >nul 2>nul
if errorlevel 1 goto launch
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue'; $ext=@('.exe','.bat','.dll','.ps1','.md'); Get-ChildItem -LiteralPath '%~dp0' -Recurse -File | Where-Object { $ext -contains $_.Extension.ToLower() } | Unblock-File -ErrorAction SilentlyContinue" >nul 2>nul

:launch
start "" "%APP%"
exit /b 0