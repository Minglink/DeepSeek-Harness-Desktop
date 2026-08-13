# DeepSeek Harness Desktop

DeepSeek Harness 的 Windows 桌面版 —— 用 Electron 外壳把官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Web UI 打包成一键安装的桌面应用。

> **声明**：本项目基于官方仓库 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（`deepseek-harness-master`）封装，不修改官方核心代码。核心能力、插件架构与 Web UI 全部来自官方项目，本项目仅提供 Electron 桌面外壳、自包含运行时打包与安装器。

---

## 功能特性

- **一键安装**：双击安装包即用，无需安装 Node.js、无需 clone 项目、无需命令行。
- **完全自包含**：内置 Node 24 运行时、完整后端与前端静态资源，不依赖本机任何开发环境。
- **开箱即用的 Web UI**：复用官方完整 Web 界面（会话、工具、工作流、预设、设置等）。
- **首次启动引导**：首次打开在界面内配置 DeepSeek API Key，凭证仅保存在本机用户目录。

---

## 使用说明

### 1. 安装

1. 从本仓库的 [Releases](../../releases) 下载 `DeepSeek Harness Setup 0.1.0.exe`。
2. 双击运行，按提示完成安装（会创建桌面快捷方式）。
3. 从桌面快捷方式或开始菜单启动 **DeepSeek Harness**。

> 首次运行会拉起本地服务，稍等几秒窗口即出现。由于未做代码签名，Windows 可能提示"未知发布者"，点"仍要运行"即可。

### 2. 配置 API Key

首次打开时，界面会弹出 DeepSeek 配置引导，填入你的 `DEEPSEEK_API_KEY` 即可开始使用。

### 3. 日常使用

- 服务默认运行在 `http://127.0.0.1:3080`（仅本机访问）。
- 关闭窗口会自动停止后台服务。
- 应用是单实例的，重复启动只会聚焦已有窗口。

### 4. 卸载

在「设置 → 应用 → 已安装的应用」中找到 **DeepSeek Harness**，点击卸载。

---

## 从源码构建

> 构建需要官方 deepseek-harness 源码（已 `pnpm install` + `pnpm build`）以及 Windows + Node 24 环境。

```powershell
# 1. 准备官方项目（假设在 ../deepseek-harness）
#    pnpm install && pnpm build

# 2. 生成自包含运行时（在官方项目根目录）
pnpm --filter dsh-web-runtime deploy --prod --legacy --config.node-linker=hoisted --config.auto-install-peers=true --config.link-workspace-packages=true ./desktop/runtime
Copy-Item apps/cli/lib ./desktop/runtime -Recurse -Force
Copy-Item apps/cli/config ./desktop/runtime -Recurse -Force
Copy-Item "$env:NVM_SYMLINK\node.exe" ./desktop/node/node.exe -Force

# 3. 打包桌面应用（在本目录）
npm install
npm run dist
```

产物在 `release/` 目录：
- `release/DeepSeek Harness Setup 0.1.0.exe` —— 安装包
- `release/win-unpacked/DeepSeek Harness.exe` —— 免安装版

---

## 目录结构

```
desktop/
├── main.js              # Electron 主进程：拉起后端 + 创建窗口
├── package.json         # Electron 配置与打包（electron-builder）
├── build/icon.png       # 应用图标源（256×256）
├── node/                # 打包用的 Node 24 运行时（构建时生成，不入库）
├── runtime/             # 自包含后端运行时（构建时生成，不入库）
└── release/             # 打包产物（构建时生成，不入库）
```

---

## 工作原理

1. Electron 主进程启动后，用内置 `node.exe` 运行内置 `runtime/lib/bin.js web`。
2. 后端在 `127.0.0.1:3080` 提供官方 Web UI 与 API。
3. 窗口加载该地址；关闭窗口时优雅退出并停止后端。

---

## 许可

- 官方 DeepSeek Harness 采用 [MIT License](https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE)。
- 本项目同样以 MIT 许可发布，Electron 及其依赖遵循各自的开源许可证。
