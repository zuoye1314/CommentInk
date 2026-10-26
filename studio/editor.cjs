const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { hash } = require("./parser.cjs");
const { validateFormula, validateScene, template } = require("./model.js");
const { safeUI, renamedUri, assertWritable } = require("./recovery.cjs");
const { ensureLanguage, languageStyle } = require('./comment-languages.cjs');
const { serializeComment } = require('./comment-format.cjs');
const { fitInline } = require('./inline-layout.cjs');
const freshId = () => crypto.randomUUID().replace(/-/g, "");

class VisualEditor {
  constructor(context, controller, pool) {
    this.context = context; this.controller = controller; this.pool = pool; this.sessions = new Set();
    this.journal = context.workspaceState.get("commentStudio.drafts.v1", {}); this.journalWrite = Promise.resolve(); this.renames = Promise.resolve();
    context.subscriptions.push(this,
      vscode.window.registerWebviewPanelSerializer("commentStudio.editor", {
        deserializeWebviewPanel: async (panel, state) => {
          const journal = this.journal[state?.draftId];
          if (journal) state = { ...state, ...((journal.revision || 0) >= (state.revision || 0) ? { value: journal.value, ui: journal.ui, revision: journal.revision } : {}), target: journal.target };
          try {
            if (!state?.target || !["math", "diagram"].includes(state.type)) throw new Error("草稿缺少目标信息");
            const uri = vscode.Uri.parse(state.target.uri);
            let doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
            if (!doc && uri.scheme === "file") doc = await vscode.workspace.openTextDocument(uri);
            if (!doc) throw new Error("请先重新打开原文件，再恢复草稿");
            await ensureLanguage(doc.languageId);
            this.mount(panel, { ...state.target, doc, type: state.type, value: state.value, ui: state.ui, draftId: state.draftId, draftRevision: state.revision, restored: true });
          } catch (error) {
            // Keep the saved draft visible, but do not authorize a write target.
            this.mount(panel, { type: state?.type === "diagram" ? "diagram" : "math", value: state?.value, ui: state?.ui, draftId: state?.draftId, recoveryTarget: state?.target,
              error: error.message });
          }
        },
      }),
      vscode.workspace.onDidRenameFiles((event) => {
        this.renames = this.renames.then(() => this.renamed(event)).catch((error) => {
          for (const session of this.sessions) void session.panel.webview.postMessage({ action: "notice", text: `文件迁移失败：${error.message}；草稿仍保留。` });
        });
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        for (const session of this.sessions) if (session.doc === event.document && !session.existing && !session.applying) {
          let delta = 0;
          for (const change of event.contentChanges) {
            if (change.rangeOffset + change.rangeLength < session.anchor
                || (change.rangeLength > 0 && change.rangeOffset + change.rangeLength === session.anchor)) {
              delta += change.text.length - change.rangeLength;
            } else if (change.rangeOffset <= session.anchor) session.conflict = true;
          }
          session.anchor += delta;
          session.baseHash = hash(event.document.getText());
          this.updateTarget(session);
        }
      }));
  }
  async open(type, uriText, id, { forceNew = false } = {}) {
    const doc = uriText ? await vscode.workspace.openTextDocument(typeof uriText === 'string' ? vscode.Uri.parse(uriText) : uriText) : vscode.window.activeTextEditor?.document;
    if (!doc) throw new Error("请先打开要插入注释的文件");
    await ensureLanguage(doc.languageId);
    const editor = vscode.window.activeTextEditor?.document === doc ? vscode.window.activeTextEditor
      : await vscode.window.showTextDocument(doc);
    const parsed = this.controller.parse(doc);
    if (!parsed.unsafeLines) throw new Error(parsed.diagnostics[0]?.message || "无法识别文件语法");
    const block = forceNew ? null : id ? parsed.blocks.find((b) => b.id === id)
      : parsed.blocks.find((b) => editor.selection.active.line >= b.start && editor.selection.active.line <= b.end);
    if (id && !block) throw new Error("目标注释已改变或标识不唯一，未打开可写编辑会话");
    if (!forceNew && !block) throw new Error('光标处还没有可编辑的公式或图表；请运行「插入公式」或「绘制图表」新建。');
    const line = editor.selection.active.line;
    if (!block && ((line === 0 && /^(#!|\s*<\?xml|\s*<\?php)/i.test(doc.lineAt(0).text))
        || (doc.languageId === 'python' && line < 2 && /coding\s*[:=]/.test(doc.lineAt(line).text)))) throw new Error('请在文件声明或脚本头之后选择独立行，避免改变文件的执行或编码方式。');
    if (!block && parsed.unsafeLines.includes(line)) throw new Error("当前位置涉及字符串、续行、未闭合注释或嵌入语言；请选择普通代码行或完整块注释的内部独立行。");
    const at = parsed.contexts?.[line], style = block?.commentStyle || (at?.kind === 'block' ? { block: [at.open, at.close] } : languageStyle(doc.languageId));
    const session = { doc, uri: doc.uri.toString(), column: editor.viewColumn, type: block?.type || type,
      id: block?.id || freshId(), existing: Boolean(block), fingerprint: block?.fingerprint,
      prefix: block?.prefix || (doc.languageId === "python" ? "#" : "//"),
      commentStyle: style,
      indent: block?.indent ?? doc.lineAt(line).text.slice(0, doc.lineAt(line).firstNonWhitespaceCharacterIndex),
      value: block?.value || (type === "diagram" ? { version: 1, title: "图表", nodes: [], edges: [] } : template("fraction")),
      anchor: doc.offsetAt(new vscode.Position(line, 0)), baseHash: hash(doc.getText()) };
    const panel = vscode.window.createWebviewPanel("commentStudio.editor", `CommentInk · ${block?.carrier === 'python-string' ? '编辑 Python 多行字符串' : block ? "编辑注释" : type === "diagram" ? "绘制图表" : "编辑公式"}`,
      editor.viewColumn || vscode.ViewColumn.One, { enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "studio")] });
    this.mount(panel, session);
    return session;
  }
  mount(panel, session) {
    session.panel = panel; session.revision = 0; session.draftId ||= freshId(); session.draftRevision ||= 0;
    session.ui = safeUI(session.ui);
    if (session.restored && !session.existing && session.baseHash !== hash(session.doc.getText())) session.conflict = true;
    this.sessions.add(session);
    const nonce = crypto.randomBytes(18).toString("base64");
    panel.webview.options = { enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "studio")] };
    const asset = (name) => panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "studio", name)).toString();
    panel.webview.html = fs.readFileSync(path.join(__dirname, "editor.html"), "utf8")
      .replaceAll("__CSP__", panel.webview.cspSource).replaceAll("__NONCE__", nonce)
      .replaceAll("__STYLE__", asset("editor.css")).replaceAll("__MODEL__", asset("model.js")).replaceAll("__GEOMETRY__", asset("geometry.js")).replaceAll("__SCRIPT__", asset("editor.js"));
    const receive = panel.webview.onDidReceiveMessage(async (message) => {
      if (session.closed) return;
      if (!message || !Number.isSafeInteger(message.request) || !["ready", "draft", "render", "apply", "copy"].includes(message.action)) return;
      if (message.action !== "ready" && message.sessionToken !== nonce) return;
      session.lastEvent = { action: message.action, request: message.request, kind: message.value?.kind };
      try {
        if (message.action === "ready") {
          await panel.webview.postMessage({ action: "init", type: session.type, value: session.value, carrier: session.commentStyle?.pythonString ? 'python-string' : 'comment',
            target: this.savedTarget(session), ui: session.ui, draftId: session.draftId, revision: session.draftRevision, error: session.error || session.notice, sessionToken: nonce });
          return;
        }
        if (JSON.stringify(message.value).length > 64 * 1024) throw new Error("草稿超过大小限制");
        if (message.action === "draft") {
          session.value = session.type === "math" ? validateFormula(message.value, { draft: true }) : validateScene(message.value, { draft: true });
          session.ui = safeUI(message.ui);
          session.draftRevision = Number.isSafeInteger(message.revision) ? Math.max(session.draftRevision, message.revision) : session.draftRevision + 1;
          await this.saveDraft(session); return;
        }
        if (message.action === "apply" || message.action === "copy") session.notice = undefined;
        const value = session.type === "math" ? validateFormula(message.value) : validateScene(message.value);
        session.value = value;
        if (message.action === "render") {
          const revision = ++session.revision;
          const metrics = session.doc ? this.controller.metrics(session.doc) : { color: "#d4d4d4", fontSize: 20 };
          const result = await this.pool.render(session.type, value, metrics);
          if (revision === session.revision) await panel.webview.postMessage({ action: "rendered", request: message.request,
            svg: `data:image/svg+xml;base64,${Buffer.from(result.svg).toString("base64")}`, nodes: result.nodes, width: result.width, height: result.height });
        } else {
          if (message.action === "copy") {
            const metrics = session.doc ? this.controller.metrics(session.doc) : { color: "#d4d4d4", fontSize: 20 };
            const minimumBodyLines = await this.minimumLines(session.type, value, metrics);
            if (session.closed) return;
            if (!["current", "python", "typescript"].includes(message.copyLanguage)) throw new Error("复制语言无效");
            const prefix = message.copyLanguage === "python" ? "#" : message.copyLanguage === "typescript" ? "//" : session.prefix || "#";
            const style = session.commentStyle?.pythonString && message.copyLanguage === 'current' ? { line: '#' }
              : message.copyLanguage === 'current' ? session.commentStyle || { line: prefix } : { line: prefix };
            const block = serializeComment({ type: session.type, value, id: freshId(), style, indent: session.indent || '', minimumBodyLines });
            await vscode.env.clipboard.writeText(block);
            this.lastCopy = block;
            await panel.webview.postMessage({ action: "notice", text: "已复制完整注释，可粘贴到另一个文件继续编辑。" });
          } else {
            if (!session.doc || session.error) throw new Error(session.error || "没有可写入的原文件，草稿仍保留");
            if (session.busy) throw new Error("正在应用，请稍候");
            session.busy = true;
            try { await this.apply(session, value); } finally { session.busy = false; }
          }
        }
      } catch (error) {
        if (message.action === "apply" || message.action === "copy") session.notice = error.message;
        if (!session.closed) await panel.webview.postMessage({ action: "error", operation: message.action, request: message.request, text: error.message });
      }
    });
    panel.onDidDispose(() => { session.closed = true; session.revision++; receive.dispose(); this.sessions.delete(session); });
  }
  savedTarget(session) {
    if (session.recoveryTarget) return session.recoveryTarget;
    return { uri: session.uri, column: session.column, type: session.type, id: session.id, existing: session.existing,
      fingerprint: session.fingerprint, anchor: session.anchor, baseHash: session.baseHash, prefix: session.prefix, commentStyle: session.commentStyle, indent: session.indent, conflict: session.conflict };
  }
  async saveDraft(session) {
    const snapshot = { type: session.type, value: session.value, ui: session.ui, target: this.savedTarget(session), revision: session.draftRevision };
    this.journal[session.draftId] = JSON.parse(JSON.stringify(snapshot));
    const keys = Object.keys(this.journal);
    for (const key of keys.slice(0, Math.max(0, keys.length - 20))) delete this.journal[key];
    const records = JSON.parse(JSON.stringify(this.journal));
    this.journalWrite = this.journalWrite.catch(() => {}).then(() => this.context.workspaceState.update("commentStudio.drafts.v1", records));
    return this.journalWrite;
  }
  updateTarget(session) {
    void this.saveDraft(session).catch((error) => { if (!session.closed) void session.panel.webview.postMessage({ action: "notice", text: `草稿备份失败：${error.message}` }); });
    void session.panel.webview.postMessage({ action: "target", target: this.savedTarget(session) });
  }
  async renamed(event) {
    for (const file of event.files) for (const session of this.sessions) {
      if (!session.uri) continue;
      const uri = renamedUri(vscode.Uri.parse(session.uri), file.oldUri, file.newUri);
      if (!uri) continue;
      session.doc = await vscode.workspace.openTextDocument(uri); session.uri = uri.toString();
      if (!session.existing && session.baseHash !== hash(session.doc.getText())) session.conflict = true;
      session.panel.title = `编辑注释 · ${path.posix.basename(uri.path)}`;
      this.updateTarget(session);
      await session.panel.webview.postMessage({ action: "notice", text: "已跟随文件重命名；应用前仍会检查原注释。" });
    }
  }
  async minimumLines(type, value, metrics) {
    const rendered = await this.pool.render(type, value, metrics);
    // Save valid source even if the image is too wide for inline preview.
    // That case falls back to source with the usual width diagnostic.
    try { return Math.ceil(fitInline(rendered, metrics.fontSize).height / metrics.lineHeight) || 0; }
    catch { return 0; }
  }
  async source(session, value, id = session.id) {
    const { doc } = session;
    const parsed = this.controller.parse(doc);
    if (!parsed.unsafeLines) throw new Error("文件语法暂不完整，保留草稿并停止写入");
    const old = session.existing ? parsed.blocks.find((b) => b.id === session.id) : null;
    if (session.existing && (!old || old.fingerprint !== session.fingerprint)) throw new Error("原注释已被修改或删除，未覆盖；草稿仍保留");
    if (!session.existing && session.conflict) throw new Error("插入位置已被修改，未写入；草稿仍保留");
    const position = doc.positionAt(session.anchor);
    if (!old && (position.character !== 0 || parsed.unsafeLines.includes(position.line))) throw new Error("插入位置已进入字符串或不再是行首，未写入");
    const line = doc.lineAt(old?.start ?? position.line);
    const indent = old?.indent ?? line.text.slice(0, line.firstNonWhitespaceCharacterIndex);
    const at = parsed.contexts?.[position.line];
    const style = old?.commentStyle || (old ? { line: old.prefix } : at?.kind === 'block' ? { block: [at.open, at.close] } : languageStyle(doc.languageId));
    const minimumBodyLines = await this.minimumLines(session.type, value, this.controller.metrics(doc));
    return serializeComment({ type: session.type, value, id, indent, style, minimumBodyLines, interior: old?.interior || at?.kind === 'block', leader: old?.leader || (at?.kind === 'block' ? at.leader : undefined), eol: doc.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n" });
  }
  async apply(session, value) {
    await this.renames;
    const doc = session.doc;
    await assertWritable(doc);
    if (doc.isClosed) throw new Error("原文件已关闭或重命名，草稿仍保留");
    const version = doc.version;
    const text = await this.source(session, value);
    if (session.closed) throw new Error("编辑已取消，未写入");
    if (session.doc !== doc || doc.isClosed) throw new Error("文件刚刚重命名或关闭，请重试；草稿仍保留");
    // Rendering yielded to the host. Revalidate both version and semantic block
    // before constructing the actual editor edit.
    if (version !== doc.version) throw new Error("文件刚刚发生变化，请重试应用；草稿仍保留");
    const block = session.existing ? this.controller.parse(doc).blocks.find((b) => b.id === session.id) : null;
    const editor = await vscode.window.showTextDocument(doc, session.column || vscode.ViewColumn.One);
    if (session.closed) throw new Error("编辑已取消，未写入");
    if (version !== doc.version) throw new Error("文件刚刚发生变化，未写入");
    await assertWritable(doc);
    if (session.closed || session.doc !== doc || version !== doc.version) throw new Error("目标或编辑状态刚刚改变，未写入；草稿仍保留");
    const original = doc.getText();
    const start = block ? doc.offsetAt(new vscode.Position(block.start, 0)) : session.anchor;
    const end = block ? doc.offsetAt(new vscode.Position(block.end, doc.lineAt(block.end).text.length)) : start;
    const insertion = text + (!block ? doc.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n" : "");
    const expected = original.slice(0, start) + insertion + original.slice(end);
    session.applying = true;
    let applied;
    try {
      applied = await editor.edit((edit) => {
        if (block) edit.replace(new vscode.Range(block.start, 0, block.end, doc.lineAt(block.end).text.length), text);
        else edit.insert(doc.positionAt(session.anchor), text + (doc.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n"));
      }, { undoStopBefore: true, undoStopAfter: true });
    } finally { session.applying = false; }
    // In the tested VS Code host editor.edit can report true even when the
    // underlying read-only editor rejected executeEdits. Verify the document,
    // rather than discarding the draft on an acknowledgement alone.
    if (!applied || doc.getText() !== expected) {
      session.notice = doc.getText() === original ? "文件只读或编辑器拒绝写入，草稿仍保留" : "编辑器未接受完整修改或文件发生变化，请检查源码；草稿仍保留";
      session.panel.reveal(session.column);
      throw new Error(session.notice);
    }
    delete this.journal[session.draftId];
    const records = JSON.parse(JSON.stringify(this.journal));
    this.journalWrite = this.journalWrite.catch(() => {}).then(() => this.context.workspaceState.update("commentStudio.drafts.v1", records));
    session.panel.dispose();
    try { await this.controller.show(editor, { focusId: session.id }); }
    catch (error) { vscode.window.setStatusBarMessage(`源码已应用；预览暂未显示：${error.message}`, 6000); }
  }
  async compact(editor = vscode.window.activeTextEditor, id) {
    if (!editor) throw new Error('请先把光标放入要整理的公式或图表注释。');
    const doc = editor.document;
    await ensureLanguage(doc.languageId);
    await assertWritable(doc);
    const block = this.controller.parse(doc).blocks.find((b) => id ? b.id === id
      : editor.selection.active.line >= b.start && editor.selection.active.line <= b.end);
    if (!block) throw new Error('光标处没有有效的公式或图表数据，请先修复源码或将光标移入数据块。');
    const version = doc.version, original = doc.getText();
    const start = doc.offsetAt(new vscode.Position(block.start, 0));
    const end = doc.offsetAt(new vscode.Position(block.end, doc.lineAt(block.end).text.length));
    const text = await this.source({ doc, existing: true, id: block.id, type: block.type,
      fingerprint: block.fingerprint, anchor: start }, block.value);
    await assertWritable(doc);
    if (doc.isClosed || doc.version !== version) throw new Error('文件刚刚发生变化，未整理，请重试。');
    const expected = original.slice(0, start) + text + original.slice(end);
    if (expected !== original) {
      const applied = await editor.edit((edit) => edit.replace(new vscode.Range(block.start, 0, block.end,
        doc.lineAt(block.end).text.length), text), { undoStopBefore: true, undoStopAfter: true });
      if (!applied || doc.getText() !== expected) throw new Error('文件只读或编辑器未接受完整修改，请检查源码。');
    }
    return this.controller.show(editor, { focusId: block.id });
  }
  dispose() { for (const session of [...this.sessions]) session.panel.dispose(); this.lastCopy = undefined; }
}
module.exports = { VisualEditor };
