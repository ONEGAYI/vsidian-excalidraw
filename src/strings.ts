const en = {
  loading: 'Opening the drawing…', board: 'Board', read: 'Read only', edit: 'Edit drawing', done: 'Finish editing',
  save: 'Save', saved: 'Saved', unsaved: 'Unsaved', undo: 'Undo', redo: 'Redo', markdown: 'Open Markdown',
  reload: 'Reload drawing', discard: 'Reload and discard canvas changes?',
  conflict: 'The drawing changed elsewhere. Your pending changes have not been written; reload to continue.',
  badFile: 'This Markdown file does not contain a readable Excalidraw drawing.',
  notDrawing: 'Open an Obsidian Excalidraw Markdown file first.',
  deleted: 'The document could not be updated. Your drawing remains open.',
  missing: 'Some attachments are not available on this board. Their references are kept in the file.',
  disabled: 'Enable Vsidian Excalidraw in Vsidian settings to use the board.',
  reservedText: 'This label contains a reserved Markdown marker, such as “## Drawing” or “%%”. Edit the label before saving.',
  inactive: 'Undo or redo was canceled because this board is no longer active.',
  createTitle: 'New Excalidraw Drawing', createFailed: 'Could not create the drawing.', markdownPath: 'Choose a file ending in .md.',
  working: 'Updating the document…',
}
export function strings(locale: string): typeof en {
  return locale.toLowerCase().startsWith('zh') ? {
    loading: '正在打开图档…', board: '画板', read: '只读', edit: '编辑画板', done: '完成编辑',
    save: '保存', saved: '已保存', unsaved: '未保存', undo: '撤销', redo: '重做', markdown: '查看 Markdown',
    reload: '重新载入图档', discard: '重新载入并放弃画板里尚未写入的修改？',
    conflict: '图档已在别处修改。画板里尚未写入的修改仍在，重新载入后可继续编辑。',
    badFile: '此 Markdown 文件没有可读取的 Excalidraw 图档数据。',
    notDrawing: '请先打开一份 Obsidian Excalidraw Markdown 图档。',
    deleted: '无法更新文档，画板仍保留当前内容。',
    missing: '部分附件无法在画板显示；文件里的原始引用仍然保留。',
    disabled: '请先在 Vsidian 设置中启用 Vsidian Excalidraw。',
    reservedText: '画板文字含有图档保留标记，例如独占一行的「## Drawing」或「%%」。修改这段文字后即可保存。',
    inactive: '画板已不在当前标签，撤销或重做已取消。',
    createTitle: '新建 Excalidraw 图档', createFailed: '无法创建图档。', markdownPath: '请选择以 .md 结尾的文件。',
    working: '正在更新文档…',
  } : en
}
