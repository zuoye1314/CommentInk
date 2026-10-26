# CommentInk

在 VS Code 代码注释中绘制图表、编辑公式，并在原位置预览。支持图形化画布、公式模板和可选 LaTeX 输入，使用 MathJax 离线渲染。

![复杂公式在代码注释中的预览](docs/screenshots/06-complex-formula.png)

## 安装和使用

扩展标识：`zuoye.comment-preview-probe`，显示名称：**CommentInk**。

[打开 VS Code Marketplace 页面](https://marketplace.visualstudio.com/items?itemName=zuoye.comment-preview-probe)（以商店当前上架状态为准）。也可以通过本地 VSIX 安装。

1. 用 VS Code 打开 C、Python、JavaScript 等源文件，在独立行点击右键。
2. 选择 **CommentInk → 插入公式** 或 **绘制图表**。
3. 在编辑器中创作，点击 **应用到注释**，然后保存源文件。
4. 光标进入数据块时显示源码，离开后自动预览；继续图形化编辑请使用右键菜单。

完整图文教程见 **[使用指南](INSTALL.md)**，包含 14 张真实 VS Code 操作截图；安装后也可离线打开。

## 主要能力

- 分式、根号、上下标、积分、求和、矩阵模板；复杂公式支持直接输入 TeX 数学表达式。
- 方框、连线、自由线、标签、文字与公式节点；平移缩放、多选、撤销和显式碰撞避让。
- 可恢复的版本化文本保存在注释中，复制源文件后仍可继续编辑。
- 自动生成当前语言的注释包装；Python 带完整标记的限定三引号字符串作为扩展载体识别。

## 运行边界

需要 **VS Code 1.142.0+**。主要验证环境为 Linux / VS Code 1.142.0；其他系统、Remote、Web、中文输入法及读屏软件尚未完成同等验收。

原位预览利用真实注释行容纳 SVG 切片，不能让代码编辑器自动按任意图片高度撑开。插入、应用或明确整理时补足最少注释行；仅查看或缩放不改文件。空间不足、无效标记或不支持的语法会保留源码并提示。

## 开发

```sh
npm ci
npm test
```

在 VS Code 打开项目后按 F5 启动扩展开发宿主。打包、架构和集成测试说明见 [开发指南](docs/DEVELOPMENT.md)，验证范围见 [验证说明](docs/VERIFICATION.md)。提交修改前请阅读 [贡献约定](CONTRIBUTING.md)。

## 许可证与致谢

使用 [MIT 许可证](LICENSE)，保留 ASCIIFlow 原有版权声明。交互设计参考 [ASCIIFlow](https://github.com/lewish/asciiflow)；图标基于 Lucide Pen Tool，版权与 ISC 许可见 [图标声明](media/NOTICE.md)。依赖的许可证见 [第三方说明](THIRD_PARTY_NOTICES.md)。
