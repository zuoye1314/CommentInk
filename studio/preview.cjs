const vscode = require("vscode");
const { parseBlocks, hash } = require("./parser.cjs");
const { makeTiles } = require("../formula-model.cjs");
const { resolveLineHeight } = require("../formula-layout.cjs");
const { fitInline, indentColumns } = require("./inline-layout.cjs");
const { previewSelections } = require('./preview-navigation.cjs');
const { languageIds, languageReady, ensureLanguage } = require('./comment-languages.cjs');
const languages = ["python", "javascript", "typescript", "javascriptreact", "typescriptreact"];
const touches = (selections, block) => selections.some((s) => s.start.line <= block.end && s.end.line >= block.start);

class PreviewController {
  constructor(context, pool) {
    for (const id of languageIds()) if (!languages.includes(id)) languages.push(id);
    this.pool = pool; this.documents = new Map(); this.views = new Map(); this.preferences = new Map(); this.discovering = new Map();
    this.foldingChanged = new vscode.EventEmitter();
    this.diagnostics = vscode.languages.createDiagnosticCollection("commentStudio");
    context.subscriptions.push(this, this.foldingChanged, this.diagnostics,
      vscode.languages.registerFoldingRangeProvider(languages.map((language) => ({ language })), {
        onDidChangeFoldingRanges: this.foldingChanged.event,
        provideFoldingRanges: (doc) => this.folds(doc),
      }),
      vscode.workspace.onDidChangeTextDocument((event) => this.changed(event.document)),
      vscode.workspace.onDidOpenTextDocument((doc) => {
        // didOpen also covers language-mode changes, and precedes the window's
        // editor update. Only inspect it if actually visible on the next turn.
        setTimeout(() => { for (const editor of vscode.window.visibleTextEditors) if (editor.document === doc) void this.discover(editor); }, 0);
      }),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        const view = this.views.get(event.textEditor);
        if (!view) return;
        const editing = new Set(this.parse(event.textEditor.document).blocks.filter((b) => touches(event.selections, b)).map((b) => b.id));
        let changed = editing.size !== view.editing.size || [...editing].some((id) => !view.editing.has(id));
        view.editing = editing;
        for (const entry of [...view.entries.values()]) {
          if (editing.has(entry.block.id) || touches(event.selections, entry.block)) {
            this.clearEntry(view, entry, true); changed = true;
          }
        }
        // Automatic transitions never set selections or reveal a range. A
        // user's click outside the block remains the native insertion point.
        if (changed) void this.schedule(view);
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.visibleChanged()),
      vscode.window.onDidChangeActiveTextEditor((editor) => { if (editor) void this.activate(editor); }),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        this.documents.delete(doc.uri.toString()); this.diagnostics.delete(doc.uri);
        for (const key of this.preferences.keys()) if (key.startsWith(doc.uri.toString() + "#")) this.preferences.delete(key);
        for (const [editor, view] of this.views) if (editor.document === doc) { this.clearView(view); this.views.delete(editor); }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        for (const [editor, view] of this.views) if (["editor.fontSize", "editor.lineHeight", "workbench.colorCustomizations"].some((key) => event.affectsConfiguration(key, editor.document))) {
          void this.schedule(view, true);
        }
      }),
      vscode.window.onDidChangeActiveColorTheme(() => { for (const view of this.views.values()) void this.schedule(view, true); }));
    // Activation may happen after restored editors have already opened.
    this.visibleChanged();
  }
  async discover(editor) {
    const doc = editor.document, language = doc.languageId;
    if (this.disposed || doc.isClosed || !languages.includes(language)) return;
    const state = this.documents.get(doc.uri.toString());
    if (state?.enabled) {
      if (!this.views.has(editor)) await this.schedule(this.getView(editor));
      return;
    }
    // Avoid loading grammars/renderers for ordinary source files. A textual
    // marker is only a cheap filter; the parser still requires real comments.
    const text = doc.getText();
    if (text.length > 1024 * 1024 || !/@(?:math|diagram)[ \t]+begin\b/.test(text)) return;
    if (this.discovering.has(doc)) return this.discovering.get(doc);
    const task = (async () => {
      try {
        await ensureLanguage(language);
        if (this.disposed || doc.isClosed || doc.languageId !== language) return;
        const editors = vscode.window.visibleTextEditors.filter((e) => e.document === doc);
        if (!editors.length) return;
        const parsed = this.parse(doc);
        if (!parsed.blocks.length && !parsed.diagnostics.length) return;
        this.documents.get(doc.uri.toString()).enabled = true;
        // Do not call show(): automatic discovery must never relocate a caret,
        // scroll the editor, clear pinned source mode or change the document.
        await Promise.all(editors.filter((e) => !this.views.has(e)).map((e) => this.schedule(this.getView(e))));
      } catch (error) {
        if (!this.disposed && !doc.isClosed) this.diagnostics.set(doc.uri, [new vscode.Diagnostic(
          new vscode.Range(0, 0, 0, 0), `CommentInk 自动预览暂不可用：${error.message}`, vscode.DiagnosticSeverity.Information)]);
      } finally { this.discovering.delete(doc); }
    })();
    this.discovering.set(doc, task);
    return task;
  }
  parse(doc) {
    const key = doc.uri.toString();
    let state = this.documents.get(key);
    if (!state) { state = { enabled: false }; this.documents.set(key, state); }
    if (state.version !== doc.version || state.language !== doc.languageId || state.ready !== languageReady(doc.languageId)) {
      state.result = parseBlocks(doc.getText(), doc.languageId); state.version = doc.version; state.language = doc.languageId; state.ready = languageReady(doc.languageId);
      this.publishDiagnostics(doc);
    }
    return state.result;
  }
  publishDiagnostics(doc) {
    const issues = [...(this.documents.get(doc.uri.toString())?.result?.diagnostics || [])];
    for (const view of this.views.values()) if (view.editor.document === doc) issues.push(...(view.renderErrors || []));
    const unique = new Map(issues.map((d) => [`${d.line || 0}:${d.message}`, d]));
    this.diagnostics.set(doc.uri, [...unique.values()].map((d) => {
      const line = Math.min(doc.lineCount - 1, d.line || 0);
      return new vscode.Diagnostic(new vscode.Range(line, 0, line, doc.lineAt(line).text.length), d.message, vscode.DiagnosticSeverity.Information);
    }));
  }
  getView(editor) {
    let view = this.views.get(editor);
    if (!view) {
      const preference = this.preferences.get(`${editor.document.uri.toString()}#${editor.viewColumn}`);
      const parsed = this.parse(editor.document), pendingUnfold = new Set();
      for (const prior of preference?.tails || []) {
        const block = parsed.blocks.find((b) => b.id === prior.id);
        if (block && block.bodyStart + prior.tiles < block.end) pendingUnfold.add(block.bodyStart + prior.tiles);
      }
      view = { editor, entries: new Map(), source: new Set(preference?.source || []), editing: new Set(), revision: 0, queue: Promise.resolve(), pendingUnfold, errors: [], renderErrors: [] };
      this.views.set(editor, view);
    }
    return view;
  }
  color(doc) {
    const custom = vscode.workspace.getConfiguration("workbench", doc).get("colorCustomizations")?.["editor.foreground"];
    if (/^#[\da-f]{6}$/i.test(custom || "")) return custom;
    return [vscode.ColorThemeKind.Light, vscode.ColorThemeKind.HighContrastLight].includes(vscode.window.activeColorTheme.kind) ? "#202020" : "#e4e4e4";
  }
  metrics(doc) {
    const config = vscode.workspace.getConfiguration("editor", doc), size = config.get("fontSize", 14);
    return { ...resolveLineHeight({ fontSize: size, lineHeight: config.get("lineHeight", 0), version: vscode.version }),
      fontSize: Math.min(32, Math.max(16, size + 6)), color: this.color(doc) };
  }
  tail(entry) {
    const start = entry.block.bodyStart + entry.tiles.length;
    return start < entry.block.end ? { start, end: entry.block.end } : null;
  }
  clearEntry(view, entry, unfold = false) {
    for (const type of entry.types || []) type.dispose();
    view.entries.delete(entry.block.id);
    const tail = this.tail(entry);
    if (unfold && entry.folded && tail) view.pendingUnfold.add(tail.start);
  }
  clearView(view) {
    view.revision++;
    for (const entry of [...view.entries.values()]) this.clearEntry(view, entry, true);
  }
  async unfoldPending(view) {
    view.foldQueue = (view.foldQueue || Promise.resolve()).catch(() => {}).then(async () => {
      if (view.editor !== vscode.window.activeTextEditor || !view.pendingUnfold.size) return;
      const lines = [...view.pendingUnfold]; view.pendingUnfold.clear();
      await vscode.commands.executeCommand("editor.unfold", { selectionLines: lines });
    });
    return view.foldQueue;
  }
  folds(doc) {
    const state = this.documents.get(doc.uri.toString());
    if (!state?.enabled) return;
    const parsed = this.parse(doc), result = new Map();
    const add = ({ start, end }) => result.set(`${start}:${end}`, new vscode.FoldingRange(start, end));
    for (const fold of parsed.folds || []) add(fold);
    for (const b of parsed.blocks) add(b);
    for (const view of this.views.values()) if (view.editor.document === doc) for (const entry of view.entries.values()) {
      const tail = this.tail(entry); if (tail) add(tail);
    }
    return [...result.values()];
  }
  attach(view, entry) {
    for (const type of entry.types || []) type.dispose();
    const { editor } = view, b = entry.block;
    entry.types = [];
    const hidden = vscode.window.createTextEditorDecorationType({ color: "transparent" });
    entry.types.push(hidden);
    editor.setDecorations(hidden, [new vscode.Range(b.start, 0, b.end, editor.document.lineAt(b.end).text.length)]);
    const configuredTab = Number(editor.options.tabSize);
    const columns = indentColumns(b.indent, Number.isInteger(configuredTab) && configuredTab > 0 ? configuredTab : 4);
    // Anchor every slice at column zero, even on empty rows. Equal/opposite
    // margins supply the shared visual indentation without occupying width.
    const margin = columns ? `0 -${columns}ch 0 ${columns}ch` : '0';
    const before = (line, settings) => {
      const type = vscode.window.createTextEditorDecorationType({ before: { ...settings, margin }, rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed });
      entry.types.push(type); const at = new vscode.Position(line, 0);
      editor.setDecorations(type, [new vscode.Range(at, at)]);
    };
    for (const tile of entry.tiles) before(b.bodyStart + tile.index, {
      contentIconPath: vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(tile.svg).toString("base64")}`),
      width: "0px", height: `${tile.height}px`, margin: "0" });
    before(b.start, { contentText: `${b.prefix} ${b.type === "math" ? "公式" : "图表"}`, color: entry.metrics.color, width: "0px" });
  }
  schedule(view, rebuild = false) {
    const revision = ++view.revision;
    view.queue = view.queue.catch(() => {}).then(async () => {
      if (revision !== view.revision || this.disposed) return;
      const { editor } = view, doc = editor.document, version = doc.version;
      if (rebuild) this.clearEntriesForRebuild(view);
      await this.unfoldPending(view);
      const parsed = this.parse(doc); view.errors = parsed.diagnostics.map((d) => d.message); view.renderErrors = [];
      view.editing = new Set(parsed.blocks.filter((b) => touches(editor.selections, b)).map((b) => b.id));
      const ids = new Set(parsed.blocks.map((b) => b.id));
      for (const entry of [...view.entries.values()]) if (!ids.has(entry.block.id)) this.clearEntry(view, entry, true);
      for (const block of parsed.blocks) {
        if (revision !== view.revision || version !== doc.version) return;
        let entry = view.entries.get(block.id);
        if (view.source.has(block.id) || touches(editor.selections, block)) {
          if (entry) this.clearEntry(view, entry, true);
          continue;
        }
        if (entry && entry.block.fingerprint !== block.fingerprint) {
          this.clearEntry(view, entry, true); entry = undefined;
        }
        try {
          if (!entry) {
            const metrics = this.metrics(doc);
            const rendered = fitInline(await this.pool.render(block.type, block.value, metrics), metrics.fontSize);
            if (revision !== view.revision || version !== doc.version) return;
            const tiles = makeTiles(rendered, metrics.lineHeight);
            if (tiles.length > block.bodyCount) throw new Error(`${block.id} 的源码空间不足，还需 ${tiles.length - block.bodyCount} 行注释；补足后离开该区域，或右键 CommentInk →「压缩源码并补足预览空间」`);
            if (touches(editor.selections, block)) continue;
            entry = { block, rendered, tiles, metrics, folded: false };
            view.entries.set(block.id, entry);
          } else entry.block = block;
          this.attach(view, entry);
        } catch (error) { view.errors.push(error.message); view.renderErrors.push({ line: block.start, id: block.id, message: error.message }); }
      }
      this.publishDiagnostics(doc);
      this.foldingChanged.fire();
      await this.unfoldPending(view);
      await this.fold(view, revision);
    });
    return view.queue;
  }
  clearEntriesForRebuild(view) { for (const e of [...view.entries.values()]) this.clearEntry(view, e, true); }
  async fold(view, revision = view.revision) {
    // Active-editor and rebuild events may request folding concurrently. A
    // second editor.fold on an already folded tail selects its parent and can
    // hide the entire image. Serialize intent and mark before yielding.
    view.foldQueue = (view.foldQueue || Promise.resolve()).catch(() => {}).then(async () => {
      if (revision !== view.revision || view.editor !== vscode.window.activeTextEditor) return;
      await new Promise((resolve) => setTimeout(resolve, 120));
      if (revision !== view.revision || view.editor !== vscode.window.activeTextEditor) return;
      const entries = [...view.entries.values()].filter((e) => !e.folded && this.tail(e));
      if (!entries.length) return;
      for (const e of entries) e.folded = true;
      try { await vscode.commands.executeCommand('editor.fold', { levels: 1, direction: 'down', selectionLines: entries.map((e) => this.tail(e).start) }); }
      catch (error) { for (const e of entries) e.folded = false; throw error; }
    });
    return view.foldQueue;
  }
  async activate(editor) {
    const view = this.views.get(editor);
    if (view) { await this.unfoldPending(view); await this.fold(view); }
    else await this.discover(editor);
  }
  visibleChanged() {
    for (const editor of vscode.window.visibleTextEditors) {
      if (!this.views.has(editor)) void this.discover(editor);
    }
    for (const [editor, view] of this.views) if (!vscode.window.visibleTextEditors.includes(editor)) {
      // Retain document enablement, but release decorations for closed/hidden views.
      this.preferences.set(`${editor.document.uri.toString()}#${editor.viewColumn}`, { source: [...view.source],
        tails: [...view.entries.values()].filter((e) => e.folded).map((e) => ({ id: e.block.id, tiles: e.tiles.length })) });
      this.clearView(view); this.views.delete(editor);
      this.publishDiagnostics(editor.document);
    }
  }
  changed(doc) {
    if (!languages.includes(doc.languageId)) return;
    if (!this.documents.get(doc.uri.toString())?.enabled) {
      for (const editor of vscode.window.visibleTextEditors) if (editor.document === doc) void this.discover(editor);
      return;
    }
    this.parse(doc);
    for (const [editor, view] of this.views) if (editor.document === doc) void this.schedule(view);
  }
  async show(editor = vscode.window.activeTextEditor, { focusId } = {}) {
    if (!editor) throw new Error('请先打开并点击要预览的源文件。');
    await ensureLanguage(editor.document.languageId);
    const parsed = this.parse(editor.document);
    if (!parsed.blocks.length) throw new Error(parsed.diagnostics[0]?.message || '当前文件还没有公式或图表数据；请先运行「插入公式」或「绘制图表」，编辑后点击「应用到注释」。');
    const current = editor.selections;
    const navigation = previewSelections(current, parsed.blocks, editor.document.lineCount);
    this.documents.get(editor.document.uri.toString()).enabled = true;
    if (navigation.selections.some((s, i) => s !== current[i])) editor.selections = navigation.selections.map((s) =>
      s instanceof vscode.Selection ? s : new vscode.Selection(s.anchor.line, s.anchor.character, s.active.line, s.active.character));
    const views = vscode.window.visibleTextEditors.filter((e) => e.document === editor.document).map((e) => this.getView(e));
    for (const view of views) view.source.clear();
    await Promise.all(views.map((view) => this.schedule(view, true)));
    // Folding and returning from a Webview can scroll independently of the
    // caret. Reveal only the object explicitly requested or just exited.
    const focus = parsed.blocks.find((b) => focusId ? b.id === focusId : b.start === navigation.focusLine);
    if (focus && editor === vscode.window.activeTextEditor) {
      const entry = this.getView(editor).entries.get(focus.id);
      editor.revealRange(new vscode.Range(focus.start, 0, entry ? focus.bodyStart + entry.tiles.length - 1 : focus.start, 0), vscode.TextEditorRevealType.Default);
    }
    if (this.getView(editor).errors.length) void vscode.window.showWarningMessage('CommentInk：' + this.getView(editor).errors.join('；'));
    return this.snapshot();
  }
  reveal(editor = vscode.window.activeTextEditor, id) {
    const view = this.views.get(editor); if (!view) return;
    view.revision++;
    // A block already being edited has no decoration entry. Explicit source
    // mode must include it too, or leaving its cursor would undo that choice.
    for (const block of this.parse(editor.document).blocks) if (!id || block.id === id) view.source.add(block.id);
    for (const entry of [...view.entries.values()]) if (!id || entry.block.id === id) {
      this.clearEntry(view, entry, true);
    }
    this.foldingChanged.fire();
    void this.unfoldPending(view);
  }
  snapshot() {
    return { views: [...this.views.values()].map((v) => ({ uri: v.editor.document.uri.toString(), column: v.editor.viewColumn,
      sourceHash: hash(v.editor.document.getText()), sourceText: v.editor.document.getText(), version: v.editor.document.version,
      selection: [v.editor.selection.active.line, v.editor.selection.active.character], errors: v.errors,
      entries: [...v.entries.values()].map((e) => ({ id: e.block.id, type: e.block.type, start: e.block.start, end: e.block.end,
        fingerprint: e.block.fingerprint, tiles: e.tiles.length, dimensions: [e.rendered.width, e.rendered.height], folded: e.folded })) })) };
  }
  dispose() {
    this.disposed = true;
    for (const view of this.views.values()) this.clearView(view);
    this.views.clear(); this.documents.clear(); this.preferences.clear();
  }
}
module.exports = { PreviewController, languages };
