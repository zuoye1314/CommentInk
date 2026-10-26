const vscode = require("vscode");
const crypto = require("node:crypto");
const { parseFormula, makeTiles } = require("./formula-model.cjs");
const { renderFormula } = require("./formula-renderer.cjs");
const { resolveLineHeight } = require("./formula-layout.cjs");
const { reflowFormula } = require("./formula-reflow.cjs");
const EXAMPLES = {
  objective: [String.raw`\mathcal{L}(\theta)`, String.raw`= \sum_{i=1}^{n}`,
    String.raw`\log\left(`, String.raw`\int_{\mathbb{R}^{d}}`, String.raw`p_\theta(x_i,z)`,
    String.raw`\,dz\right)`, String.raw`-\lambda\left\|`, String.raw`\theta`, String.raw`\right\|_2^2`],
  matrix: [String.raw`A=\begin{pmatrix}`, String.raw`a&b&c\\`, String.raw`d&e&f\\`,
    String.raw`g&h&i`, String.raw`\end{pmatrix}`],
  fraction: [String.raw`f(x)=\frac{`, String.raw`\displaystyle\int_0^x`,
    String.raw`\frac{\sin(t)}{1+t^2}\,dt`, String.raw`}{`,
    String.raw`\sqrt{\displaystyle\sum_{k=1}^n`, String.raw`\frac{x_k^2}{k+1}}`, String.raw`}`],
};

function createFormulaProbe(context) {
  let editor, model, rendered, cacheKey, timer;
  let initialText = "";
  let types = [], tiles = [];
  let state = { preview: false, reason: "initial", revision: 0 };
  let options = { compact: true, zeroWidth: true };
  let tailFolded = false;
  let foldingRegistration;
  let showQueue = Promise.resolve(), intentRevision = 0;
  let statusNotice;
  function notice(message) {
    statusNotice?.dispose();
    statusNotice = vscode.window.setStatusBarMessage(message, 6000);
  }
  async function inActiveEditor(operation) {
    const active = vscode.window.activeTextEditor;
    if (!active || !["python", "javascript", "typescript"].includes(active.document.languageId)) {
      notice("请先打开包含公式注释的 Python、JavaScript 或 TypeScript 文件。");
      return;
    }
    if (active !== editor) {
      await reveal("switch-document");
      editor = active;
      model = rendered = cacheKey = undefined;
      tiles = [];
      initialText = active.document.getText();
      trackFolding();
    }
    return operation();
  }
  const foldingChanged = new vscode.EventEmitter();
  const parse = () => parseFormula(editor.document.getText());
  function trackFolding() {
    if (foldingRegistration) foldingRegistration.dispose();
    // Scope the provider to the document being previewed, so unrelated files
    // keep their language's normal folding provider.
    foldingRegistration = vscode.languages.registerFoldingRangeProvider({
      scheme: editor.document.uri.scheme, pattern: editor.document.uri.path,
    }, {
      onDidChangeFoldingRanges: foldingChanged.event,
      provideFoldingRanges(document) {
        if (!editor || document !== editor.document) return [];
        let b;
        try { b = parse(); } catch { return []; }
        const ranges = [new vscode.FoldingRange(b.start, b.end, vscode.FoldingRangeKind.Region)];
        const tail = tailRange();
        if (tail) ranges.push(new vscode.FoldingRange(tail.start, tail.end, vscode.FoldingRangeKind.Region));
        return ranges;
      },
    });
  }
  function tailRange() {
    if (!state.preview || !options.compact || !model) return null;
    const start = model.bodyStart + tiles.length;
    return start < model.end ? { start, end: model.end } : null;
  }
  function snapshot() {
    const text = editor.document.getText();
    let b, parseError;
    try { b = parse(); } catch (error) { parseError = error.message; }
    return { ...state, options, vscodeVersion: vscode.version,
      sourceUnchanged: text === initialText,
      sourceHash: crypto.createHash("sha256").update(text).digest("hex"), sourceText: text,
      isDirty: editor.document.isDirty, version: editor.document.version,
      bounds: b && { start: b.start, end: b.end, bodyStart: b.bodyStart, bodyEnd: b.bodyEnd, bodyCount: b.bodyCount },
      tex: b?.tex, fingerprint: b?.fingerprint, parseError,
      dimensions: rendered && { width: rendered.width, height: rendered.height },
      tileCount: tiles.length, tail: tailRange(),
      selection: [editor.selection.start.line, editor.selection.start.character,
        editor.selection.end.line, editor.selection.end.character],
      selectedText: editor.document.getText(editor.selection),
      visibleRanges: editor.visibleRanges.map((range) => [range.start.line, range.end.line]) };
  }
  function disposeTypes() { for (const type of types) type.dispose(); types = []; }
  async function reveal(reason = "explicit-source") {
    intentRevision++;
    const tail = tailRange();
    clearTimeout(timer);
    disposeTypes();
    state = { ...state, preview: false, reason };
    tailFolded = false;
    foldingChanged.fire();
    if (tail) await vscode.commands.executeCommand("editor.unfold", { selectionLines: [tail.start] });
    return editor ? snapshot() : state;
  }
  function themeColor() {
    const color = vscode.workspace.getConfiguration("workbench").get("colorCustomizations")?.["editor.foreground"];
    return /^#[0-9a-f]{6}$/i.test(color || "") ? color
      : vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light ? "#202020" : "#d4d4d4";
  }
  function attach() {
    disposeTypes();
    const hidden = vscode.window.createTextEditorDecorationType({ color: "transparent" });
    types.push(hidden);
    editor.setDecorations(hidden, [new vscode.Range(model.start, 0, model.end, editor.document.lineAt(model.end).text.length)]);
    function before(line, settings) {
      const type = vscode.window.createTextEditorDecorationType({ before: settings,
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed });
      types.push(type);
      const at = new vscode.Position(line, model.indent.length);
      editor.setDecorations(type, [new vscode.Range(at, at)]);
    }
    for (const tile of tiles) before(model.bodyStart + tile.index, {
      contentIconPath: vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(tile.svg).toString("base64")}`),
      width: options.zeroWidth ? "0px" : `${tile.width}px`, height: `${tile.height}px`, margin: "0" });
    before(model.start, { contentText: `${model.prefix} 公式`, width: "0px", color: themeColor() });
    before(Math.min(model.bodyStart + tiles.length, model.end), {
      contentText: `${model.prefix} ⋯ 查看公式源码`, width: "0px", color: "#808080" });
  }
  async function foldTail(requestId) {
    foldingChanged.fire();
    const tail = tailRange();
    if (!tail || tailFolded) return;
    await new Promise((resolve) => setTimeout(resolve, 120));
    if (requestId === intentRevision && state.preview && tailRange()?.start === tail.start) {
      await vscode.commands.executeCommand("editor.fold", { selectionLines: [tail.start] });
      tailFolded = true;
    }
  }
  function show(nextOptions = {}) {
    const requestId = ++intentRevision;
    // A font change and a line-height change may arrive as separate events.
    // Serialize unfold/render/fold and skip stale requests so two rebuilds
    // cannot fold an already folded tail's parent.
    showQueue = showQueue.catch(() => {}).then(() => performShow(nextOptions, requestId));
    return showQueue;
  }
  async function performShow(nextOptions, requestId) {
    if (requestId !== intentRevision) return snapshot();
    const previousTail = tailRange();
    if (previousTail && tailFolded) {
      await vscode.commands.executeCommand("editor.unfold", { selectionLines: [previousTail.start] });
    }
    tailFolded = false;
    if (requestId !== intentRevision) return snapshot();
    options = { ...options, ...nextOptions };
    try {
      const next = parse();
      const config = vscode.workspace.getConfiguration("editor", editor.document);
      const metrics = resolveLineHeight({ lineHeight: config.get("lineHeight", 0),
        fontSize: config.get("fontSize", 14), version: vscode.version });
      const { lineHeight } = metrics;
      const fontSize = Math.min(32, Math.max(16, config.get("fontSize", 14) + 6));
      const key = JSON.stringify([next.tex, fontSize, themeColor(), lineHeight]);
      if (key !== cacheKey) {
        rendered = renderFormula(next.tex, { fontSize, color: themeColor() });
        tiles = makeTiles(rendered, lineHeight);
        cacheKey = key;
      }
      if (tiles.length > next.bodyCount) throw new Error("insufficient-existing-comment-lines");
      model = next;
      if (editor.selection.start.line <= model.end && editor.selection.end.line >= model.start) {
        const outside = model.end + 1 < editor.document.lineCount ? model.end + 1 : model.start - 1;
        if (outside < 0) throw new Error("No text line outside formula for caret");
        editor.selection = new vscode.Selection(outside, 0, outside, 0);
      }
      state = { preview: true, reason: "explicit-preview", revision: state.revision + 1,
        ...metrics, fontSize, engine: "MathJax" };
      attach();
      await foldTail(requestId);
      if (requestId === intentRevision) { statusNotice?.dispose(); statusNotice = undefined; }
    } catch (error) {
      if (requestId !== intentRevision) return snapshot();
      await reveal(error.message);
      const message = error.message === "insufficient-existing-comment-lines"
        ? "公式所需空间大于现有注释区域。可执行“整理公式源码并预览”（会修改源码，可撤销）。"
        : `公式暂未预览：${error.message}`;
      notice(message);
    }
    return snapshot();
  }
  async function open() {
    await reveal("open");
    const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(context.extensionUri, "formula-fixture.py"));
    editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    trackFolding();
    initialText = document.getText();
    model = undefined;
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    editor.revealRange(new vscode.Range(0, 0, 0, 0), vscode.TextEditorRevealType.AtTop);
    return snapshot();
  }
  async function replaceExample(example = "matrix") {
    const b = parse(), eol = editor.document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
    const lines = example === "short" ? [b.tex.replace(/\n/g, " ")]
      : example === "invalid" ? [String.raw`\frac{a}`] : EXAMPLES[example];
    if (!lines) throw new Error("Unknown formula example");
    const body = lines.map((line) => `${b.indent}${b.prefix} ${line}`).join(eol);
    await reveal("formula-update");
    await editor.edit((edit) => edit.replace(new vscode.Range(b.bodyStart, 0,
      b.bodyEnd, editor.document.lineAt(b.bodyEnd).text.length), body));
    return show();
  }
  async function formatAndShow() {
    // Formatting is an explicit, undoable source edit, separate from preview.
    // Never add empty comments or change settings to make space.
    try {
      const b = parse(), document = editor.document, version = document.version;
      const config = vscode.workspace.getConfiguration("editor", document);
      const { lineHeight } = resolveLineHeight({ lineHeight: config.get("lineHeight", 0),
        fontSize: config.get("fontSize", 14), version: vscode.version });
      const fontSize = Math.min(32, Math.max(16, config.get("fontSize", 14) + 6));
      const color = themeColor(), formula = renderFormula(b.tex, { fontSize, color });
      const plan = reflowFormula(b.tex, { minimumLines: Math.ceil(formula.height / lineHeight), fontSize, color });
      if (!plan.changed) return show();
      await reveal("explicit-source-format");
      if (document !== editor.document || document.version !== version || parse().identity !== b.identity) {
        throw new Error("Formula changed during formatting; no edit applied");
      }
      const eol = document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
      const body = plan.tex.split("\n").map((line) => `${b.indent}${b.prefix} ${line}`).join(eol);
      const applied = await editor.edit((edit) => edit.replace(new vscode.Range(b.bodyStart, 0,
        b.bodyEnd, document.lineAt(b.bodyEnd).text.length), body), { undoStopBefore: true, undoStopAfter: true });
      if (!applied) throw new Error("Formula source is not editable; no edit applied");
      const result = await show();
      if (result.preview) notice("公式源码已整理；一次撤销可恢复原文。");
      return result;
    } catch (error) {
      await reveal(error.message);
      notice(`未整理公式：${error.message}`);
      return snapshot();
    }
  }
  async function insert() {
    const active = vscode.window.activeTextEditor;
    if (!active || !["python", "javascript", "typescript"].includes(active.document.languageId)) {
      throw new Error("Open a Python, JavaScript or TypeScript file first");
    }
    const picked = await vscode.window.showQuickPick([
      { label: "复杂积分与求和", key: "objective" }, { label: "三阶矩阵", key: "matrix" },
      { label: "嵌套分式与根号", key: "fraction" },
    ], { placeHolder: "选择要插入的公式示例（验证原型）" });
    if (!picked) return;
    await reveal("insert");
    editor = active;
    trackFolding();
    const line = active.document.lineAt(active.selection.active.line);
    const indent = line.text.slice(0, line.firstNonWhitespaceCharacterIndex);
    const prefix = active.document.languageId === "python" ? "#" : "//";
    const eol = active.document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
    const block = ["@math begin v1 formula", ...EXAMPLES[picked.key], "@math end"]
      .map((value) => `${indent}${prefix} ${value}`).join(eol) + eol;
    await active.edit((edit) => edit.insert(new vscode.Position(line.lineNumber, 0), block));
    return show();
  }
  async function action(operation, fields = {}) {
    if (operation === "new-document") {
      await reveal("new-document");
      const doc = await vscode.workspace.openTextDocument({ language: "python",
        content: "# BEFORE_FORMULA: introduction\n# AFTER_FORMULA: explanation\n" });
      editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
      trackFolding();
      initialText = doc.getText();
      editor.selection = new vscode.Selection(1, 0, 1, 0);
      return snapshot();
    }
    if (operation === "undo" || operation === "redo") {
      await vscode.commands.executeCommand(operation);
      await new Promise((resolve) => setTimeout(resolve, 160));
      return snapshot();
    }
    if (operation === "format") return formatAndShow();
    const b = parse();
    if (operation === "focus") {
      await vscode.window.showTextDocument(editor.document, editor.viewColumn);
      const line = fields.where === "before" ? b.start - 1 : fields.where === "after" ? b.end + 1 : fields.line;
      const column = fields.column === "end" ? editor.document.lineAt(line).text.length : (fields.column || 0);
      editor.selection = new vscode.Selection(line, column, line, column);
      editor.revealRange(editor.selection);
    } else if (operation === "select") {
      editor.selection = new vscode.Selection(b.start, 0, b.end, editor.document.lineAt(b.end).text.length);
    } else if (operation === "scroll") {
      editor.revealRange(new vscode.Range(fields.line, 0, fields.line, 0), vscode.TextEditorRevealType.AtTop);
    } else if (operation === "replace") return replaceExample(fields.example);
    else if (operation === "fold" || operation === "unfold") {
      await vscode.commands.executeCommand(`editor.${operation}`, { selectionLines: [b.start] });
    } else if (operation === "wrap") await vscode.commands.executeCommand("editor.action.toggleWordWrap");
    else if (operation === "copy") {
      await vscode.commands.executeCommand("editor.action.clipboardCopyAction");
      return { ...snapshot(), clipboard: await vscode.env.clipboard.readText() };
    } else throw new Error("Unknown formula action");
    await new Promise((resolve) => setTimeout(resolve, 160));
    return snapshot();
  }
  context.subscriptions.push(foldingChanged,
    { dispose() { clearTimeout(timer); disposeTypes(); statusNotice?.dispose(); if (foldingRegistration) foldingRegistration.dispose(); } },
    vscode.commands.registerCommand("commentPreviewProbe.formulaOpen", async () => { await open(); return show(); }),
    vscode.commands.registerCommand("commentPreviewProbe.formulaShow", () => inActiveEditor(() => show())),
    vscode.commands.registerCommand("commentPreviewProbe.formulaSource", () => reveal()),
    vscode.commands.registerCommand("commentPreviewProbe.formulaInsert", insert),
    vscode.commands.registerCommand("commentPreviewProbe.formulaFormat", () => inActiveEditor(formatAndShow)),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (!state.preview || event.textEditor !== editor) return;
      let b;
      try { b = parse(); } catch { return; }
      if (event.selections.some((s) => s.start.line <= b.end && s.end.line >= b.start)) void reveal("caret-entered-formula");
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (!editor || event.document !== editor.document || !state.preview) return;
      clearTimeout(timer);
      let b;
      try { b = parse(); } catch (error) { void reveal(error.message); return; }
      if (b.identity !== model.identity) { void reveal("formula-source-changed"); return; }
      model = b;
      attach();
      state = { ...state, reason: "surrounding-text-updated", revision: state.revision + 1 };
      // VS Code tracks collapsed regions across text edits. Folding an already
      // collapsed tail again can fold its parent, hiding the entire formula.
      // Notify the provider without issuing another fold command.
      timer = setTimeout(() => foldingChanged.fire(), 80);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (state.preview && ["editor.lineHeight", "editor.fontSize"].some((key) => event.affectsConfiguration(key))) void show();
    }),
    vscode.window.onDidChangeActiveColorTheme(() => { if (state.preview) void show(); }));
  return { openFormulaFixture: open, showFormula: show, revealFormula: reveal,
    formulaSnapshot: snapshot, formulaAction: action };
}
module.exports = { createFormulaProbe };
