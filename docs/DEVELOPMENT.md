# 开发指南

## 环境与启动

- Node.js 22+、npm；VS Code 1.142.0+。
- 打包脚本另需 Python 3；使用官方 `@vscode/vsce`。
- 运行 `npm ci` 安装锁定依赖。插件运行不需要系统 LaTeX，渲染字体和代码由安装包提供。
- 在 VS Code 打开仓库根目录，按 F5，选择 **CommentInk**。在新开的扩展开发宿主中打开练习代码，右键进入 CommentInk。
- 内部扩展名称仍为 `comment-preview-probe`，发布者 `zuoye`。勿仅为清理命名而改变命令、配置或草稿存储身份。

## 文件结构

| 路径 | 职责 |
|---|---|
| `extension.cjs` | 扩展入口，包含保留的历史显示验证接口 |
| `studio/index.cjs` | 正式命令、启动与编辑流程 |
| `studio/model.js` | 公式和图表模型、带版本的文本编解码 |
| `studio/comment-languages.cjs`、`parser.cjs`、`comment-format.cjs` | 语言语法、真实注释识别与安全包装 |
| `studio/editor.*`、`geometry.js` | 图形编辑器、路径、标签和碰撞几何 |
| `studio/render*.cjs` | 公式渲染和受限工作线程 |
| `studio/preview.cjs`、`inline-layout.cjs` | 每个文件/窗口的 SVG 切片预览与布局 |
| `studio/recovery.cjs` | 草稿、目标迁移与写入保护 |
| `formula-*.cjs`、`block-probe.cjs` | 仍由入口引用的早期原型及公共公式组件，删除前检查调用关系 |
| `INSTALL.md` | 面向用户和商店的图文说明 |
| `docs/USER-GUIDE.md` | 包内离线指南，由打包脚本生成 |

## 测试

`npm test` 运行不依赖 VS Code 图形界面的模型、紧凑编码、几何、导航和公式测试。`npm run test:languages` 另需本地 VS Code 内置语言目录、gcc 和 Python 3；当前 markers 测试默认目录为 Linux 的 `/usr/share/code/resources/app/extensions`，跨平台运行前需调整适配，不应宣称该脚本已经跨平台。

根目录的 `run-*-tests.cjs` 和 `studio/*test-host.cjs` 是真实 VS Code 的专项集成测试仪器。它们使用 Linux 的 `/usr/bin/code`、固定调试端口和临时隔离配置，需要图形会话及另行安装的 Playwright。可用 `NODE_PATH` 指向该依赖目录。不要同时运行使用相同端口的测试；测试配置关闭了沙箱/工作区信任，限受控测试环境使用。

优先用 `node run-guide-tests.cjs` 验证当前开发宿主的教程流程；实际包可用 `COMMENT_STUDIO_VSIX=/absolute/path/package.vsix node run-guide-package-tests.cjs` 验证。部分旧脚本断言记录了历史版本或界面文字，使用前核对，不能视为最新版本全部通过。输出保存在被忽略的 `results*` 中，不应把包含本机路径的原始记录直接公开。

## 打包

```sh
npm run package
```

脚本通过 npx 使用官方 vsce，首次需要联网。也可预先安装并指定入口：

```sh
npm install --prefix /tmp/commentink-vsce @vscode/vsce@4.0.0
python3 scripts/package-release.py --vsce /tmp/commentink-vsce/node_modules/@vscode/vsce/vsce
```

输出为 `dist/commentink-zuoye-<version>.vsix`。脚本用 `INSTALL.md` 作为商店 README，并注册指南图片的 VSIX 可寻址资源；离线指南保留相对链接。构建不会上传或发布扩展。修改截图后发布时须提高版本号，线上图片可达性需在上传后核对。

## 架构约束

以注释中的版本化 JSON/TeX 为权威数据，SVG 是可重建结果。Webview 仅发送受限操作；宿主复核目标、原块指纹、修订及应用结果。自动预览不能更改文档或移动光标。原位布局依赖已有真实行，空间不足时显示源码并诊断，不能借助工作台 DOM 或私有 Monaco API。
