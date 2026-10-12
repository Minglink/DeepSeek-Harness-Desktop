# 0.2.1-alpha.1 社区修订 9

本目录包含相对上次社区重启修订更新的源码、测试和成对文档，逐文件 SHA-256 见 source-changes.json；完整可构建 monorepo 在同标签 Release 的 source.tar.gz 中。根目录保留旧版封装，不能用旧根目录构建本修订。

完整源码排除 node_modules、用户数据、凭据、网站 website/.dist 和市场已生成 client/ 输出；它们的生成来源分别在 website/ 与 apps/desktop/plugins/dsh-community/src/。公共客户端构建配置 .dsh-build/client-build-environment.json 保留本次确切公开输入。按源码根 AGENTS.md 与 apps/desktop/README.md 准备依赖并运行正式构建；构建会生成 lib/、客户端 bundle 和前端 dist，Windows 安装包需 Windows 打包工具。

本次发行版本为 0.2.1-alpha.1，修订为 community-install-logs-fix9-20261012。安装包为未签名 Windows x64 包。本修订修复已有 Purge 私有环境下继续安装插件被误判需要恢复的问题，并保留完整的底层错误原因。真实验收范围及结果见 release-validation.json；仅完成列明的安装、加载与重启检查，不宣称作者插件全部业务功能或全目录实机通过。Infinite Gen 5 完整发行仍按作者脚本安装。

本修订重新验证安装包与内嵌归档完整性。安装器生命周期与 Infinite Gen 5 作者安装流程保留修订 8 的既有证据，并在 release-validation.json 中标明，不能表述为本修订重新执行全部步骤。完整仓库历史文档/组合检查仍有已记录的失败，不能把本次发行说成所有仓库测试全通过。release-validation.json 绑定确切安装包、构建输入与基本验收范围，校验清单见 Release 的 SHA256SUMS.txt。
