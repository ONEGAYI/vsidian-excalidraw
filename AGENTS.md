# vsidian-excalidraw

Vsidian 附加组件。Obsidian Excalidraw 与 Vsidian 使用同一份 Markdown 图档；画板本身复用官方 Excalidraw SDK。

- 工程规范遵循 `D:\CODE\Project\AGENTS.md`。功能变更先写契约测试。
- 保存只修改绘图相关数据，保留笔记正文、属性、附件引用及未编辑的数据。不接管普通 Markdown 默认打开方式。
- `src/format.ts` 管理 Obsidian 图档结构；`src/extension.ts` 沿用 VS Code 文本文档的保存与撤销；`src/board.tsx` 负责画板交互。
- `npm test` 验证格式与保真；构建和双宿主验收入口见 README。
