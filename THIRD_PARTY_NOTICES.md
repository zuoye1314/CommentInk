# 第三方来源与许可

- 项目在 ASCIIFlow 工作区中开发，交互参考 ASCIIFlow（Lewis Hemens，MIT）。本仓库保留 [原有 MIT 许可声明](LICENSE)。
- 图标使用 Lucide 的 Pen Tool，遵循 ISC；保留 [声明](media/NOTICE.md) 和 [许可原文](media/LICENSE-Lucide)。
- MathJax、MathJax TeX 字体、Lezer、jsonc-parser、vscode-textmate、vscode-oniguruma 及其传递依赖由 `package-lock.json` 锁定。各依赖以自身包内的 LICENSE/NOTICE 为准，安装和再分发时须保留；本仓库不将它们重新授权为项目 MIT。

源码仓库不提交 node_modules。VSIX 打包会包含所需运行依赖，更新依赖时需检查包内许可证是否完整。
