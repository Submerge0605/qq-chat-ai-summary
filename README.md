# QQ 聊天记录 AI 摘要

在 Windows 上读取本机 QQ 聊天记录，生成按话题整理的摘要。聊天内容只在本机处理，不上传。

## 使用

1. 解压整个文件夹（不要只单独拿走 `QQ Chat Summary.exe`）。
2. 双击 **`启动 QQ 摘要.bat`**。
3. 登录页会列出本机 QQ 账号。选一个，程序会自动连接；首次连接会先关闭正在运行的 QQ，再快速登录。
4. 连接成功后点「进入主界面」：选会话 → 设参数 → 生成摘要。

第一次连接需要 5–20 秒；程序会在 `%LOCALAPPDATA%\QChatSummary\napcat` 准备一份运行时，只准备一次。

## 系统要求

* Windows 10 / 11 x64
* QQNT 9.9.x，且本机至少登录过一次
* .NET Framework 4.0（系统自带）
* 生成摘要需要 Node.js（`node` 在 PATH 中）

## 常见问题

**一直卡在“等待 NapCat 起来”**
先看弹窗里的日志路径和最后几行。常见原因：
* QQ 没有完全退出（托盘里还有）：手动退出 QQ 后重试。
* 3000 端口被别的程序占用：关闭占用程序后重试。
* 程序目录只读或权限异常：把整个文件夹移到 `D:\QChatSummary` 这类普通目录再运行。

**登录页只有 QQ 号，没有昵称**
等 2 秒会自动补上；仍为空点一下「重新检测」。

**换一个 QQ 号**
在登录页选另一个号即可，程序会关闭当前 QQ 再快速登录。

**提示“Windows 已保护你的电脑”**
先运行 `启动 QQ 摘要.bat`；仍有提示时，运行 `工具\安装信任并解除锁定.bat`。
自签名证书没有 SmartScreen 信誉，蓝色提示可能仍会出现；这是 Windows 的预期行为。

**摘要里的成员名/群名不对**
点「重新检测」，确认登录的是正确的 QQ 号。

## 数据位置

| 内容 | 位置 |
| --- | --- |
| 程序配置（含加密后的 API Key） | `%LOCALAPPDATA%\QChatSummary\config.json` |
| 日志 | `%LOCALAPPDATA%\QChatSummary\logs\` |
| 摘要结果 | `%LOCALAPPDATA%\QChatSummary\results\` |
| NapCat 运行时副本 | `%LOCALAPPDATA%\QChatSummary\napcat\` |

## 卸载

删除程序文件夹，再删除 `%LOCALAPPDATA%\QChatSummary`。
不写注册表，不安装服务。

## 第三方组件

* NapCatQQ 运行时（AGPL-3.0）—— 见 `THIRD-PARTY-NOTICES.txt`。
* 应用图标由软件所有者提供。
