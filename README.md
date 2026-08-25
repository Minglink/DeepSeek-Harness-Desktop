# DeepSeek Harness Desktop

DeepSeek Harness 的 Windows 桌面版 —— 用 Electron 外壳把官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Web UI 打包成一键安装的桌面应用，并提供 `dsh://` 系统级插件一键安装联动协议。

> **声明**：本项目基于官方仓库 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（`deepseek-harness-master`）封装，不修改官方核心代码。核心能力、插件架构与 Web UI 全部来自官方项目，本项目仅提供 Electron 桌面外壳、自包含运行时打包与一键安装协议。

---

## 版本特性 (v0.1.0-a)

- **一键安装**：双击安装包即用，内置 Node 24 运行时、完整后端与前端，无需任何开发环境。
- **开箱即用的 Web UI**：复用官方完整 Web 界面（会话、工具、工作流、预设、设置等）。
- **插件市场「一键安装联动协议」支持 (`dsh://`)**：
  - 支持从网页端、文档、第三方服务一键安全唤起客户端并安装插件。
  - 具备弹窗展示插件信息与权限声明，用户点击“开始安装”后自动下载、解压并配置。

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
1. 从本仓库的 [Releases](../../releases) 下载安装包。
2. 双击运行并按提示完成安装。
3. 从桌面快捷方式或开始菜单启动 **DeepSeek Harness**。

### 2. 配置 API Key
首次打开时，界面会弹出 DeepSeek 配置引导，填入你的 `DEEPSEEK_API_KEY` 即可开始使用。

---

## 许可

- 官方 DeepSeek Harness 采用 [MIT License](https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE)。
- 本项目同样以 MIT 许可发布。
