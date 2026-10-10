# DeepSeek Harness Desktop

## 当前社区版：0.2.1-alpha.1（2026-10-10 插件市场兼容修订）

[下载社区版修订包](https://github.com/Minglink/DeepSeek-Harness-Desktop/releases/tag/v0.2.1-alpha.1-community-market-fix)。Windows x64 未签名预发布安装包，完整版本仍为 `0.2.1-alpha.1`，社区修订为 `community-market-fix-20261010`，请通过修订文件名区分旧包。

本修订修复旧设置导入覆盖当前用户设置的问题：用户显式设置优先，保留旧文本和独占备份，使用真实 revision 检查更新。修复客户端 RPC 注册时因服务作用域取错而无法取得活动 WebServer 的问题，保留原调用者生命周期、浏览器授权和访问边界。桌面默认压缩器仅在启动时确切选中 `@aiwayds/dsh-dcp` 时默认关闭，后续用户显式启用或禁用仍优先；插件选集变更需要重启 Host。

此前的社区注册入口、登录请求、精确发行包校验及合法内置依赖准备修复保留；安装仍需社区登录、授权及票据。历史会话、账号、凭据和用户 profile 不属于本次构建或发布的数据修改范围，旧安装包和发行保留。

实际封装运行时的 Host/Office 检查及 25 项第一方隔离用例通过。广泛 GUI 回归仍有 30 项失败，已有 Web 构建回放有 124 项失败及 484 项待运行，不能视为完整界面验收。市场插件的实际启动、重启和客户端验证范围以各条目记录为准；不代表所有插件业务、外部服务、模型调用或正常桌面安装流程均已验证。

本次修改的源码、测试和双语文档见 [community-desktop-0.2.1-alpha.1](community-desktop-0.2.1-alpha.1)。完整可构建 monorepo 源码附在本 Release 的 `source.tar.gz`，校验见 `SHA256SUMS.txt`。根目录以下内容保留既有 0.1.6 封装记录，构建本修订请使用新的完整源码归档。

---

DeepSeek Harness 的 Windows 桌面版 —— 用 Electron 外壳把官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Web UI 打包成一键安装的桌面应用，并深度集成液态玻璃（Liquid Glass）视觉系统、4K 动态壁纸、`dsh://` 系统级插件一键安装联动协议与 AI 智能插件自愈引擎。

> **声明**：本项目基于官方仓库 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（`deepseek-harness-master`）封装，不修改官方核心代码。核心能力、插件架构与 Web UI 全部来自官方项目，本项目提供 Electron 桌面外壳、自包含运行时打包、液态玻璃主题套件及一键安装协议。

---

## 🌟 版本特性 (v0.1.6 Max)

- **🎨 全新液态玻璃（Liquid Glass）视觉主题套件**：
  - 深度集成 `@deepseek-ai/dsh-client-ui-liquid-glass` 旗舰级玻璃拟态与多层亚克力高斯模糊渲染引擎。
  - 内置超清/4K 动态视频壁纸引擎，全新安装默认启用经典「雷暴预感 1080p」动态壁纸。
  - 支持自定义上传动态视频/静态壁纸、毛玻璃透明度调节、背景遮罩对比度调节与壁纸音量控制。
- **🐋 经典小黑鲸鱼官方高清图标**：
  - 完整适配 Windows 安装包（NSIS）、可执行文件（PE Resource）、卸载程序及客户端各窗口的高清小黑鲸鱼品牌图标。
- **⚡ 开箱即用与自包含运行时**：
  - 双击安装包即用，内置自包含 Node 运行时与全量离线依赖树，零外部依赖，无需任何开发环境。
- **🔌 插件市场「一键安装联动协议」(`dsh://`)**：
  - 支持从网页端、文档、第三方服务一键安全唤起客户端并安装插件。
  - 具备原生弹窗展示插件信息与权限声明，点击“开始安装”后自动下载、解压并配置 Cordis Loader，热重启立即生效。
- **🛡️ AI 驱动智能插件沙箱与自愈装载**：
  - 自动适配非标插件导出语法与 ESM 条件导出，自动补全 Bridge，杜绝启动异常。
- **🔒 数据平滑过渡与安全配置**：
  - 100% 完整保留用户历史会话数据（`~/.dsh/sessions`）与 API 凭据，支持自动清理旧版不兼容残留插件。

---

## 插件一键安装联动协议规范 (dsh://)

### 1. 协议定义
- **协议头**：`dsh://`
- **操作路由**：`/plugin/install`
- **标准格式**：
  ```
  dsh://plugin/install?id={id}&name={name}&version={version}&repo={repo}&permissions={permissions}&downloadUrl={downloadUrl}
  ```

### 2. 参数定义
| 参数名 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `id` | string | 必填 | 插件唯一标识符，英文小写（如 `open-design`） |
| `name` | string | 必填 | 插件中文/英文展示名称 |
| `version` | string | 必填 | 插件语义化版本号（如 `1.0.0`、`latest`） |
| `repo` | string | 必填 | 官方/开源仓库地址或 npm 包名（如 `nexu-io/open-design`） |
| `permissions` | string | 可选 | 插件所需权限声明（客户端弹窗展示用） |
| `downloadUrl` | string | 可选 | 离线 zip/tar 安装包直链地址（备用回退分发渠道） |

### 3. 网页端唤起示例
```html
<a href="dsh://plugin/install?id=latex-ocr&name=LaTeX%E5%85%AC%E5%BC%8F%E8%AF%86%E5%88%AB&version=1.0.0&repo=deepseek-community/latex-ocr&permissions=%E6%9C%AC%E5%9C%B0%E6%96%87%E4%BB%B6%E8%AF%BB%E5%8F%96">
  🚀 一键安装到 DeepSeek Harness
</a>
```

---

## 使用说明

### 1. 安装
1. 从本仓库的 [Releases](../../releases) 下载最新安装包。
2. 双击运行并按提示完成安装。
3. 从桌面快捷方式或开始菜单启动 **DeepSeek Harness**。

### 2. 配置 API Key
首次打开时，界面会弹出 DeepSeek 配置引导，填入你的 `DEEPSEEK_API_KEY` 即可开始使用。

---

## 许可

- 官方 DeepSeek Harness 采用 [MIT License](https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE)。
- 本项目同样以 MIT 许可发布。
