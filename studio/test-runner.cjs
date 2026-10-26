// Test-only native editor controls; never loaded by a product command.
const vscode = require("vscode");
const fs = require("node:fs/promises");
const path = require("node:path");
const M = require("./model.js");
const { hash, parseBlocks } = require("./parser.cjs");

async function run() {
  const directory = process.env.COMMENT_PREVIEW_PROBE_DIR;
  const api = await vscode.extensions.getExtension("zuoye.comment-preview-probe").activate();
  const { controller, editor: visual } = api.studio;
  const oldClipboard = await vscode.env.clipboard.readText();
  let copied;
  const documents = new Map();
  const a = { kind: "fraction", numerator: M.token("x-μ"), denominator: M.token("σ") };
  const b = { kind: "matrix", cells: [[M.token("a"), M.token("b")], [M.token("c"), M.token("d")]] };
  for (const [key, language, prefix] of [["python", "python", "#"], ["typescript", "typescript", "//"]]) {
    const fake = `${prefix} @math begin v1 fake\n${prefix} x+y\n${prefix} @math end`;
    const text = (language === "python" ? `# Introduction\nfake = \"\"\"\n${fake}\n\"\"\"\n` : `// Introduction\nconst fake = \`\n${fake}\n\`;\n`)
      + `${prefix} BEFORE_A\n` + M.serialize({ type: "math", id: "a", value: a, prefix }) + `\n${prefix} BETWEEN\n`
      + M.serialize({ type: "math", id: "b", value: b, prefix }) + `\n${prefix} AFTER_B\n`
      + (language === "python" ? "def identity(x):\n    return x\n" : "function identity(x: number) {\n  return x;\n}\n");
    const file = path.join(directory, key === "python" ? "multi.py" : "multi.ts");
    await fs.writeFile(file, text);
    documents.set(key, await vscode.workspace.openTextDocument(vscode.Uri.file(file)));
  }
  const freshPath = path.join(directory, "fresh.py"); await fs.writeFile(freshPath, "# BEFORE_FRESH\n# AFTER_FRESH\n");
  documents.set("fresh", await vscode.workspace.openTextDocument(vscode.Uri.file(freshPath)));
  const active = await vscode.window.showTextDocument(documents.get("python"), vscode.ViewColumn.One);
  active.selection = new vscode.Selection(0, 0, 0, 0);
  function snapshot() {
    return { ...controller.snapshot(),
      documents: [...documents].map(([key, d]) => ({ key, uri: d.uri.toString(), sourceText: d.getText(), hash: hash(d.getText()),
        blocks: parseBlocks(d.getText(), d.languageId).blocks, diagnostics: parseBlocks(d.getText(), d.languageId).diagnostics })),
      sessions: [...visual.sessions].map((s) => ({ id: s.id, type: s.type, uri: s.uri, value: s.value, existing: s.existing, lastEvent: s.lastEvent })),
      activeUri: vscode.window.activeTextEditor?.document.uri.toString() };
  }
  async function focus(fields) {
    const doc = documents.get(fields.file || "python");
    const e = await vscode.window.showTextDocument(doc, fields.column || vscode.ViewColumn.One);
    const b = controller.parse(doc).blocks.find((block) => block.id === fields.id);
    const line = fields.where === "inside" ? b.bodyStart : fields.where === "after" ? b.end + 1 : fields.line || 0;
    const column = fields.end ? doc.lineAt(line).text.length : 0;
    e.selection = new vscode.Selection(line, column, line, column); e.revealRange(e.selection);
    return e;
  }
  async function action(operation, f = {}) {
    if (operation === "focus") await focus(f);
    else if (operation === "show") await vscode.commands.executeCommand("commentStudio.show");
    else if (operation === "split") await vscode.window.showTextDocument(documents.get(f.file || "python"), vscode.ViewColumn.Two);
    else if (operation === "open-formula" || operation === "open-diagram") {
      await focus({ file: f.file || "fresh", line: f.line ?? 1, column: f.column || 1 });
      if (f.id) await vscode.commands.executeCommand("commentStudio.edit", documents.get(f.file || "fresh").uri.toString(), f.id);
      else await vscode.commands.executeCommand(operation === "open-diagram" ? "commentStudio.newDiagram" : "commentStudio.newFormula");
    } else if (operation === "edit-before") {
      const doc = documents.get(f.file || "python"), edit = new vscode.WorkspaceEdit();
      edit.insert(doc.uri, new vscode.Position(0, 0), doc.languageId === "python" ? "# EXTRA_BEFORE\n" : "// EXTRA_BEFORE\n");
      await vscode.workspace.applyEdit(edit);
    } else if (operation === "edit-value") {
      const doc = documents.get(f.file || "python"), block = controller.parse(doc).blocks.find((b) => b.id === (f.id || "b"));
      const range = new vscode.Range(block.start, 0, block.end, doc.lineAt(block.end).text.length);
      const text = doc.getText(range), from = f.from || '"value": "b"', to = f.to || '"value": "z"';
      if (!text.includes(from)) throw new Error("Expected test token missing");
      const edit = new vscode.WorkspaceEdit(); edit.replace(doc.uri, range, text.replace(from, to)); await vscode.workspace.applyEdit(edit);
    } else if (operation === "duplicate") {
      const doc = documents.get("python"), edit = new vscode.WorkspaceEdit();
      edit.insert(doc.uri, new vscode.Position(doc.lineCount - 1, 0), M.serialize({ type: "math", id: "a", value: a }) + "\n");
      await vscode.workspace.applyEdit(edit);
    } else if (operation === "undo" || operation === "redo") await vscode.commands.executeCommand(operation);
    else if (operation === "fold" || operation === "unfold") {
      const e = vscode.window.activeTextEditor, block = controller.parse(e.document).blocks.find((b) => b.id === f.id);
      await vscode.commands.executeCommand(`editor.${operation}`, { selectionLines: [block.start], direction: "down", levels: 1 });
    } else if (operation === "hide-panel") await vscode.window.showTextDocument(documents.get("fresh"), vscode.ViewColumn.One);
    else if (operation === "show-panel") [...visual.sessions][0].panel.reveal(vscode.ViewColumn.One);
    else if (operation === "close-panel") for (const s of [...visual.sessions]) s.panel.dispose();
    else if (operation === "cancel-during-apply") {
      const session = [...visual.sessions][0], pool = api.studio.pool, original = pool.render;
      pool.render = async (...args) => { await new Promise((resolve) => setTimeout(resolve, 150)); return original.apply(pool, args); };
      try {
        const applying = visual.apply(session, session.value); session.panel.dispose();
        try { await applying; throw new Error("Apply unexpectedly completed after cancellation"); }
        catch (error) { if (!error.message.includes("取消")) throw error; }
      } finally { pool.render = original; }
    }
    else if (operation === "theme") await vscode.workspace.getConfiguration("workbench").update("colorTheme", f.name, vscode.ConfigurationTarget.Global);
    else if (operation === "copy-capture") {
      const value = await vscode.env.clipboard.readText();
      if (!/^\/\/ @diagram begin v1 /.test(value) || !value.includes("标准化")) throw new Error("Clipboard is not the expected test graph; not recording it");
      copied = value;
      return { text: value, parsed: parseBlocks(value, "typescript") };
    } else if (operation === "paste-copy") {
      if (!copied) throw new Error("No captured test clipboard");
      const file = path.join(directory, "copy.ts"); await fs.writeFile(file, "// BEFORE_COPY\n" + copied + "\n// AFTER_COPY\n");
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file)); documents.set("copy", doc);
      api.studio.pool.cache.clear(); api.studio.pool.cacheBytes = 0;
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.One); await controller.show();
    } else if (operation === "wrap") await vscode.commands.executeCommand("editor.action.toggleWordWrap");
    else if (operation === "single-group") await vscode.commands.executeCommand("workbench.action.joinAllGroups");
    else if (operation === "font") {
      await vscode.workspace.getConfiguration("editor").update("fontSize", f.size, vscode.ConfigurationTarget.Global);
    }
    else if (operation === "demo") await vscode.commands.executeCommand("commentStudio.demo");
    else if (operation === "reveal") controller.reveal();
    else throw new Error("Unknown studio test action");
    await new Promise((resolve) => setTimeout(resolve, 200));
    return snapshot();
  }
  await fs.writeFile(path.join(directory, "ready.json"), JSON.stringify(snapshot()));
  let last;
  const deadline = Date.now() + 20 * 60_000;
  async function restoreClipboard() {
    const written = visual.lastCopy || copied;
    if (written !== undefined && await vscode.env.clipboard.readText() === written) await vscode.env.clipboard.writeText(oldClipboard);
  }
  while (Date.now() < deadline) {
    let request;
    try { request = JSON.parse(await fs.readFile(path.join(directory, "request.json"), "utf8")); }
    catch (e) { if (e.code !== "ENOENT" && !(e instanceof SyntaxError)) throw e; }
    if (request && request.id !== last) {
      last = request.id;
      try {
        let result;
        if (request.action === "studio-snapshot") result = snapshot();
        else if (request.action === "studio-action") result = await action(request.operation, request.fields);
        else if (request.action === "finish") {
          for (const session of [...visual.sessions]) session.panel.dispose();
          await restoreClipboard();
          await fs.writeFile(path.join(directory, "response.json"), JSON.stringify({ id: last, finished: true })); return;
        } else throw new Error("Unknown request");
        await fs.writeFile(path.join(directory, "response.json"), JSON.stringify({ id: last, result }));
      } catch (error) { await fs.writeFile(path.join(directory, "response.json"), JSON.stringify({ id: last, error: error.message })); }
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  await restoreClipboard(); throw new Error("Studio test channel timed out");
}
module.exports = { run };
