const vscode = require("vscode");
const { RenderPool } = require("./render-pool.cjs");
const { PreviewController } = require("./preview.cjs");
const { VisualEditor } = require("./editor.cjs");
const M = require("./model.js");
const { configureLanguages, languageIds } = require('./comment-languages.cjs');

function createStudio(context) {
  configureLanguages(vscode.extensions.all);
  void vscode.commands.executeCommand('setContext', 'commentStudio.languages', languageIds());
  const pool = new RenderPool(), controller = new PreviewController(context, pool), editor = new VisualEditor(context, controller, pool);
  const command = (name, operation) => context.subscriptions.push(vscode.commands.registerCommand(name, async (...args) => {
    try { return await operation(...args); }
    catch (error) { void vscode.window.showWarningMessage(`CommentInk：${error.message}`); }
  }));
  context.subscriptions.push(pool);
  command('commentStudio.help', () => vscode.commands.executeCommand('markdown.showPreview',
    vscode.Uri.joinPath(context.extensionUri, 'docs', 'USER-GUIDE.md')));
  const targetEditor = async (resource) => {
    const active = vscode.window.activeTextEditor;
    if (!resource) return active;
    const uri = typeof resource === 'string' ? vscode.Uri.parse(resource) : resource;
    if (active?.document.uri.toString() === uri.toString()) return active;
    const doc = await vscode.workspace.openTextDocument(uri);
    const visible = vscode.window.visibleTextEditors.find((e) => e.document === doc);
    return vscode.window.showTextDocument(doc, visible?.viewColumn);
  };
  command("commentStudio.show", async (uri, id) => {
    const textEditor = await targetEditor(uri);
    return controller.show(textEditor, { focusId: id });
  });
  command("commentStudio.source", async (uri) => {
    const textEditor = await targetEditor(uri);
    if (!textEditor) throw new Error('请先点击要查看源码的文件。');
    const view = controller.views.get(textEditor);
    if (!view || !controller.parse(textEditor.document).blocks.length) { void vscode.window.showInformationMessage('当前文件已显示源码；如需新建，请运行「绘制图表」或「插入公式」。'); return; }
    return controller.reveal(textEditor);
  });
  command("commentStudio.newFormula", async (uri) => { await targetEditor(uri); return editor.open("math", uri, undefined, { forceNew: true }); });
  command("commentStudio.newDiagram", async (uri) => { await targetEditor(uri); return editor.open("diagram", uri, undefined, { forceNew: true }); });
  command("commentStudio.edit", (uri, id) => editor.open("math", uri, id));
  command("commentStudio.compact", async (uri, id) => editor.compact(await targetEditor(uri), id));
  command("commentStudio.demo", async () => {
    const value = {
      kind: "fraction", numerator: M.token("x-μ"), denominator: M.token("σ"),
    };
    const document = await vscode.workspace.openTextDocument({ language: "python", content: "# 可以在公式上方继续写说明\n# 可以在公式下方继续写说明\n" });
    const minimumBodyLines = await editor.minimumLines('math', value, controller.metrics(document));
    const textEditor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    await textEditor.edit((edit) => edit.insert(new vscode.Position(1, 0), M.serialize({ type: "math", id: "example", value, minimumBodyLines }) + "\n"));
    await controller.show(textEditor);
  });
  return { studio: { controller, editor, pool } };
}
module.exports = { createStudio };
