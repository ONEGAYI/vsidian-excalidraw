<div align="center">

# Vsidian Excalidraw

**在 VS Code 里直接画 Excalidraw，与 Obsidian 共用同一份 Markdown 图档**

*专为 [Vsidian](https://github.com/ONEGAYI/vsidian) 打造的原生白板附加组件 · 基于 [Excalidraw](https://github.com/excalidraw/excalidraw) 官方画板构建*

[![VS Code](https://img.shields.io/badge/VS%20Code-1.82.3%2B-0596FB)](https://code.visualstudio.com/)
[![Vsidian Addon API](https://img.shields.io/badge/Vsidian%20API-1.1.0%2B-7C3AED)](https://github.com/ONEGAYI/vsidian)
[![License: MIT](https://img.shields.io/badge/license-MIT-2EA043)](LICENSE)

[核心亮点](#-核心亮点) · [三步上手](#-三步上手) · [兼容与边界](#-兼容与边界) · [安装指南](#-安装指南)

</div>

---

写笔记在 VS Code，画草图却要切回 Obsidian，甚至导出图片再手动贴回文档？

**Vsidian Excalidraw** 把原汁原味的 Excalidraw 画板直接搬进 VS Code——打开库里原有的 `.excalidraw.md` 即可浏览和修改，画板改动原位写回同一份 Markdown 文件。**不导出、不转码、不维护两份文件**，真正做到双端无缝接力。

---

## ✨ 核心亮点

### 1. 同一份图档，双端零转换往返
* **原生格式直读直写**：自动识别 Obsidian Excalidraw 图档（含 `excalidraw-plugin` 属性），无论是易读的 `json` 还是紧凑的 `compressed-json`，保存时都**原样保留原有编码形式**。
* **只改画作，不动你的笔记**：写回时仅局部更新发生变动的图形、文字索引与元素链接；你写下的笔记正文、YAML 属性、既有元素 ID、本地图片引用以及其他未编辑字段全部原封不动。
* **绝不打扰普通笔记**：不会接管常规 `.md` 文件的默认打开方式，日常写 Markdown 依然保持纯粹流畅。

### 2. 先看后画，笔记与画板自由切换
* **只读模式防误触**：进入画板默认处于 **只读** 状态，可随时平移、缩放浏览结构，不怕看图时不小心拖歪元素。
* **一键开画，随时切回**：点击顶部 **编辑画板** 立即进入创作，编辑带 Obsidian 链接的文字时保留原始 `[[链接|别名]]` 方便修改；点 **完成编辑** 收起编辑态，点击 **查看 Markdown** 即可切回 Vsidian 阅读笔记正文与属性。
* **原地新建，即刻联动**：通过命令面板随时新建 `.excalidraw.md`（或 `.md`）图档，放在同一个笔记库中，打开 Obsidian 就能继续接着画。

### 3. 像改代码一样顺手的原生体验
* **融入 VS Code 撤销与保存体系**：画板上的每一次绘制和修改都接入 VS Code 文档历史——`Ctrl/Cmd+S` 保存、`Ctrl/Cmd+Z` / `Ctrl/Cmd+Y` 撤销重做，手感与编辑普通文件完全一致。
* **主题与语言自动跟随**：自动适配 VS Code 的深色、浅色与高对比度主题，工具栏与画板界面随 VS Code 显示语言自动呈现中文或英文。
* **内置全套手绘字体，离线可用**：随包完整集成官方画板及 Virgil、Excalifont、Xiaolai、Cascadia 等手绘与中英文字体，无需联网加载 CDN，内网或离线环境照常使用。
* **多重防冲突与防损坏保护**：
  * 外部修改文件时保留画板现场并提醒冲突，避免覆盖丢失；
  * 笔记代码围栏里的格式示例不会被误认为画板，遇到多个无法区分的独立绘图块也会主动停止写回以防误伤正文；
  * 若画板文字中误输入会破坏图档结构的保留标记（如独占一行的 `## Drawing` 或 `%%`），保存前即时拦截提示。

### 4. 库内图片与双链，如常工作
* **本地图片直接显示**：自动解析图档关联的库内图片附件（支持 PNG、JPG、WebP、GIF、SVG），缺图时温和提示并保留文件里的原始引用不丢失。
* **图形链接一点即达**：点击画板元素绑定的 `[[双链]]` 可直接用 Vsidian 打开对应笔记，点击 `http(s)://` 外链可直接跳转到浏览器。

---

## ⚡ 三步上手

| 你想做什么 | 怎么操作 | 发生什么 |
| :--- | :--- | :--- |
| **浏览已有图档** | 打开任意 Obsidian 图档 → 点击编辑器右上角画板图标，或执行 **Vsidian: 在 Excalidraw 画板中打开** | 以 **只读** 模式打开高清白板，可自由缩放和平移 |
| **绘制与修改** | 点击工具栏 **编辑画板** → 绘制图形或文字 → `Ctrl/Cmd+S` 保存 | 改动增量写回原 Markdown，完整保留笔记正文与属性 |
| **从零新建图档** | 打开命令面板执行 **Vsidian: 新建 Excalidraw 图档** | 生成标准 `Drawing.excalidraw.md` 并直接进入画板 |

> **小贴士**：需要切回文字视角时，点击工具栏 **查看 Markdown** 即可在 Vsidian 编辑器中阅读正文与属性；从另一端（如 Obsidian）继续编辑前，请先保存当前文件。

---

## 🧭 兼容与边界

为了让双端往返保持稳定可靠，首版聚焦核心绘图与图文阅读场景：

* **工作区与路径解析**：若图档引用了以 Obsidian 库根目录为起点的附件或双链，请在 VS Code 中将 **Obsidian 库根目录** 作为工作区文件夹打开。
* **当前支持的内容**：支持常见图形、文字与库内已有图片附件的渲染与编辑；Obsidian 端继续使用原社区插件 [Excalidraw](https://github.com/zsviczian/obsidian-excalidraw-plugin)，无需额外配置。
* **暂未覆盖的高级特性**：自定义脚本、网页 / 笔记 / PDF 等高级嵌入不在 Vsidian 画板中执行或渲染（但原始数据会原样保留不破坏）；首版暂不支持在画板内直接拖入或粘贴新图片，也不接管其他笔记里 `![[图]]` 的嵌入预览。

---

## 📦 安装指南

### 前置条件
* **VS Code** 1.82.3 或更新版本
* 已安装并启用 **Vsidian**（`onegayi.vsidian`，提供附加组件 API 1.1.0+）

### 安装步骤
1. 获取本扩展的 `.vsix` 安装包（或从源码构建）。
2. 在 VS Code 中打开命令面板（`Ctrl+Shift+P` / `Cmd+Shift+P`），执行 `扩展: 从 VSIX 安装…`（`Extensions: Install from VSIX…`）并选择安装包。
3. 前往 **Vsidian 设置 → 第三方组件** 确认启用 **Vsidian Excalidraw**，即可开始使用。

---

<details>
<summary>🛠️ 开发者构建、真机验证与发布说明（点击展开）</summary>

### 从源码构建与单测

测试脚本使用 Node.js 24，构建产出位于 `dist/`，打包的 VSIX 位于 `out/`。构建随包提供官方画板与字体，不依赖 CDN。

```powershell
npm ci
npm test
npm run compile
npm run package
```

### 双宿主真机往返验收

真宿主验收由 `test/native.mjs` 在隔离测试库及 Windows 独立桌面运行，各阶段使用同一临时目录：

```powershell
node test/native.mjs <阶段> out/roundtrip <Vsidian源码目录> <Code.exe> <Vsidian构建或解包目录> <Obsidian.exe> <Obsidian插件解包目录> [Vsidian组件解包目录]
```

* 依次运行 `seed`（Obsidian 生成 `json` 与 `compressed-json` 两种图档）、`vscode`（Vsidian 阅读、绘制、撤销、切换与保存）、`reopen`（Obsidian 重开校验），以及 `create`、`new`（Vsidian 新建图档、Obsidian 重开校验）。
* Obsidian 插件目录应包含官方发布的 `main.js`、`manifest.json` 和 `styles.css`。测试记录和截图保存在临时目录内，不读写日常使用的库。

### 发布到 VS Code Marketplace

CI 在 PR 和 `main` 上跑测试、类型检查和打包。Release 只认 `main` 上已通过 CI 的提交：GitHub Release 附上该提交的 VSIX，Marketplace 再发布同一个文件，不重新构建。

首次配置时，在 GitHub **Settings → Environments** 创建 `marketplace`，部署规则选择 **Selected branches and tags**，只放行 **Tag** 类型的 `v*`。在 [Marketplace 发布者后台](https://marketplace.visualstudio.com/manage) 打开 `ONEGAYI` 的 **Trusted Publishing**，添加一条策略：

| 字段 | 值 |
| --- | --- |
| Policy name | `vsidian-excalidraw release` |
| Repository owner | `ONEGAYI` |
| Repository | `vsidian-excalidraw` |
| Workflow | `release.yml` |
| Environment | `marketplace` |

[Trusted Publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#publish-with-github-actions-and-trusted-publishing) 会给发布步骤发放短期凭据，不需要设置 `VSCE_PAT`。

发版时，确认 `main` 对应提交的 CI 已通过、标签与 `package.json` 版本一致，再推送带发布说明的标签。例如，`main` 版本为 `0.1.0` 时：

```powershell
git fetch origin
git tag -a v0.1.0 origin/main -F release-notes.md
git push origin v0.1.0
```

先把本版说明写进 `release-notes.md`；它无需提交，标签里的说明会成为 GitHub Release 正文。如果 GitHub Release 已成功、只有 Marketplace 步骤失败，修好策略后在同一次运行里选 **Re-run failed jobs**，不必重打标签。

### 上游依赖与授权

* 画板核心使用 [Excalidraw SDK 0.18.1](https://github.com/excalidraw/excalidraw/tree/v0.18.1)（版本由 `package-lock.json` 锁定），字体与第三方授权声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 与 [licenses/](licenses/)。
* Vsidian 独立实现 [Obsidian Excalidraw 的 Markdown 文件格式](https://github.com/zsviczian/obsidian-excalidraw-plugin/blob/2.29.4/src/shared/excalidrawMarkdownParsing.ts)，不导入或打包参考子模块代码；平时构建无需初始化子模块。
* 如需查阅或比对 Obsidian Excalidraw（自 `2.29.4` 起步）的解析与保存源码，可初始化只读参考子模块：

```powershell
git submodule update --init -- upstream/obsidian-excalidraw-plugin
```

跟进新版本时，在子模块检出目标发布标签比对解析/保存逻辑，并用同版本官方发布物运行上述双宿主往返测试验证后，再更新父仓库记录的子模块提交。

</details>
