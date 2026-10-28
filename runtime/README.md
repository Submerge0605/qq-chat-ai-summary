# runtime/napcat —— 随包 NapCat 运行时

本目录让本软件在**不需要额外安装 NapCat** 的机器上也能启动 QQ 的 OneBot 接口。

## 内容

| 文件/目录 | 作用 |
| --- | --- |
| `launcher-user.bat` | NapCat 启动器（注入 QQ、写 loadNapCat.js） |
| `NapCatWinBootMain.exe` | 注入器 |
| `NapCatWinBootHook.dll` | 注入 Hook |
| `napcat.mjs` | NapCat 核心（OneBot HTTP / WebUI） |
| `package.json` | ESM 包描述，声明 express / ws |
| `node_modules/` | express、ws 等运行时依赖 |
| `native/` | Windows x64 原生模块 |
| `static/` | NapCat WebUI 静态资源（可选） |
| `worker/` | 控制台管道 worker |
| `conout-*.js` | 控制台管道辅助模块 |

不包含：账号配置、日志、缓存、任何第三方工具的插件或界面。

## 来源与许可

* NapCatQQ 4.18.28，上游：https://github.com/NapNeko/NapCatQQ
* 许可证：AGPL-3.0，全文见 https://www.gnu.org/licenses/agpl-3.0.txt
* 二进制未修改；仅按运行需要重新组织目录，并移除与本软件无关的插件和静态资源。
* 详细声明见包根目录 `THIRD-PARTY-NOTICES.txt`。
