# Vsidian Excalidraw

用 Vsidian 或 Obsidian 打开同一份 Excalidraw Markdown 图档。画板上的更改直接存回原文件，不需要导出、转换或维护两份图。

## 安装与使用

需要 VS Code 1.82.3 或更新版本，以及提供稳定附加组件 API 1.1.0 的 Vsidian。用命令 **扩展: 从 VSIX 安装…** 安装本组件。Obsidian 端继续使用原来的社区插件 [Excalidraw](https://github.com/zsviczian/obsidian-excalidraw-plugin)，无需安装本组件。要解析从库根开始的附件路径，请在 VS Code 中将 Obsidian 库根作为工作区文件夹打开。

- **读 Markdown**：在 Vsidian 按平常方式打开文件，读取正文、属性和文字块。
- **看画板**：打开一份 Obsidian 图档，在命令面板执行 **Vsidian: 在 Excalidraw 画板中打开**。进入时是只读模式，可平移、缩放；用 **查看 Markdown** 切回笔记。
- **画和改**：点 **编辑画板**，绘制或修改图形、文字。编辑带 Obsidian 链接的文字时，输入框显示原始的 `[[链接|别名]]`。保存和撤销走 VS Code 文档历史；切回 Markdown 会交回画板改动，但不会替你保存。
- **新建**：执行 **Vsidian: 新建 Excalidraw 图档**，保存为 `.excalidraw.md` 或 `.md`。保留在同一库里即可从 Obsidian 打开。

用另一端接着改之前，先保存当前文件。若 VS Code 中的文档已发生变化，而画板还有没写入的改动，组件会保留画板当前内容并提示冲突。

## 文件兼容范围

识别带 `excalidraw-plugin` 属性的 Markdown，支持普通 `json` 和压缩的 `compressed-json`，写回保持原有形式。组件只更新绘图数据和必要的文字、链接记录，保留笔记正文、属性、已有元素 ID、本地附件引用与未编辑字段。普通 Markdown 的默认打开方式不变。

画板显示常见图形、文字和库内已有图片。自定义脚本、网页/笔记/PDF 等高级嵌入不在 Vsidian 画板执行或渲染，原始数据继续保留。首版不提供新图片导入，也不接管其他笔记里的 `![[图]]` 预览。

## 开发与验证

```powershell
npm ci
npm test
npm run package
```

测试脚本使用 Node.js 24。构建产出 `dist/`；VSIX 放在 `out/`。构建随包提供官方画板与字体，不需要 CDN。

真宿主验收由 `test/native.mjs` 在隔离的测试库及 Windows 独立桌面运行。各阶段使用相同临时目录：

```powershell
node test/native.mjs <阶段> out/roundtrip <Vsidian源码目录> <Code.exe> <Vsidian构建或解包目录> <Obsidian.exe> <Obsidian插件解包目录> [Vsidian组件解包目录]
```

依次运行 `seed`（Obsidian 生成两种图档）、`vscode`（Vsidian 阅读、绘制、撤销、切换和保存）、`reopen`（Obsidian 重开），以及 `create`、`new`（Vsidian 新画、Obsidian 重开）。Obsidian 插件目录应包含官方发布的 `main.js`、`manifest.json` 和 `styles.css`。记录和截图在测试目录内，不读写日常使用的库。

## 上游

画板使用 [Excalidraw SDK](https://github.com/excalidraw/excalidraw/tree/v0.18.1)，版本由 `package-lock.json` 锁定。源码仓库和 VSIX 均包含 `THIRD_PARTY_NOTICES.md` 和 `licenses/`。

需要查看 Obsidian Excalidraw 的解析、保存源码时，在仓库根目录初始化参考子模块：

```powershell
git submodule update --init -- upstream/obsidian-excalidraw-plugin
```

子模块从已实测的 `2.29.4` 起步，父仓库锁定的是标签对应的提交。它只供查阅和比对；Vsidian 独立实现 [Obsidian 的 Markdown 文件格式](https://github.com/zsviczian/obsidian-excalidraw-plugin/blob/2.29.4/src/shared/excalidrawMarkdownParsing.ts)，不导入或打包子模块代码，构建时无需初始化。

跟进新版本时，在子模块中抓取并检出目标发布标签，比较图档解析与保存逻辑，再用同版本的官方发布物跑上面的双宿主往返测试。验证通过后再更新父仓库记录的子模块提交。
