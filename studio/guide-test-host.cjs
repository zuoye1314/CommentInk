// Test-only native bridge, confined to the launcher's temporary profile/files.
const vscode = require('vscode'), fs = require('node:fs/promises'), path = require('node:path');
async function run() {
  const directory = process.env.COMMENT_PREVIEW_PROBE_DIR;
  const extension = vscode.extensions.getExtension('zuoye.comment-preview-probe');
  // Packaged tests wait for the product's own startup activation. No command
  // search or explicit activation is used to make its context menu appear.
  if (process.env.COMMENT_STUDIO_VSIX) {
    for (const end = Date.now() + 20000; !extension.isActive && Date.now() < end;) await new Promise((r) => setTimeout(r, 80));
    if (!extension.isActive) throw new Error('Product did not activate at startup');
  } else await extension.activate();
  const api = extension.exports;
  const root = extension.extensionPath, { controller, editor: visual } = api.studio;
  const L = require(path.join(root, 'studio/comment-languages.cjs'));
  const { serializeComment } = require(path.join(root, 'studio/comment-format.cjs'));
  const M = require(path.join(root, 'studio/model.js'));
  let document, textEditor, sequence = 0;
  function snapshot() {
    textEditor = vscode.window.visibleTextEditors.find((e) => e.document === document) || textEditor;
    return { uri: document?.uri.toString(), displayName: extension.packageJSON.displayName, documents: vscode.workspace.textDocuments.filter((d) => d.uri.fsPath.startsWith(directory)).map((d) => ({uri:d.uri.toString(),source:d.getText()})), source: document?.getText(),copy:visual.lastCopy,dirty:document?.isDirty,diagnostics:document&&controller.diagnostics.get(document.uri)?.map(d=>d.message)||[],lineCount: document?.lineCount, blocks: document && controller.parse(document).blocks,
      selections: textEditor?.selections.map((s) => ({ anchor: [s.anchor.line, s.anchor.character], active: [s.active.line, s.active.character] })),
      visibleRanges: textEditor?.visibleRanges.map((r) => [r.start.line, r.end.line]),
      sessions: [...visual.sessions].map((s) => ({ type: s.type, value: s.value, uri: s.uri, anchor: s.anchor })),
      entries: controller.snapshot().views.filter((v) => v.uri === document?.uri.toString()).flatMap((v) => v.entries) };
  }
  async function action(op, f = {}) {
    if (op === 'open') {
      for (const s of [...visual.sessions]) s.panel.dispose();
      const source = f.source || '// MENU FORMULA\n// MENU DIAGRAM\n// MENU AFTER\nint main(void) { return 0; }\n';
      const file = path.join(directory, (f.name || 'guide-' + (++sequence)) + (f.language === 'python' ? '.py' : '.c')); await fs.writeFile(file, source);
      document = await vscode.languages.setTextDocumentLanguage(await vscode.workspace.openTextDocument(vscode.Uri.file(file)), f.language || 'c');
      textEditor = await vscode.window.showTextDocument(document, 1); textEditor.selection = new vscode.Selection(0, 0, 0, 0);
    } else if (op === 'position') {
      textEditor = await vscode.window.showTextDocument(document, 1);
      const line = f.marker ? document.getText().split('\n').findIndex((s) => s.includes(f.marker)) : controller.parse(document).blocks[f.block || 0].start;
      textEditor.selection = new vscode.Selection(line, 0, line, 0);
      textEditor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    } else if (op === 'readonly') {
      await vscode.commands.executeCommand(f.value ? 'workbench.action.files.setActiveEditorReadonlyInSession' : 'workbench.action.files.setActiveEditorWriteableInSession');
    } else if (op === 'cancel') { for (const s of [...visual.sessions]) s.panel.dispose();
    } else if (op === 'source') {
      controller.reveal(textEditor, 'target');
      const b = controller.parse(document).blocks[0]; textEditor.selection = new vscode.Selection(b.bodyStart + 1, 2, b.bodyStart + 1, 2);
    } else if (op === 'show') await vscode.commands.executeCommand('commentStudio.show', document.uri.toString(), 'target');
    else if (op === 'select') {
      textEditor.selections = f.selections.map((s) => new vscode.Selection(...s));
    } else if (op === 'edit') await vscode.commands.executeCommand('commentStudio.edit', document.uri.toString(), controller.parse(document).blocks[f.block || 0]?.id);
    else if (op === 'command') await vscode.commands.executeCommand(f.command, document.uri);
    else if (op === 'save') await document.save();
    else if (op === 'move') { textEditor = await vscode.window.showTextDocument(document, 1);textEditor.selection=new vscode.Selection(f.line || 0,0,f.line || 0,0); }
    else if (op === 'replace') { const at=document.getText().indexOf(f.from);if(at<0)throw new Error('Missing text');await textEditor.edit(e=>e.replace(new vscode.Range(document.positionAt(at),document.positionAt(at+f.from.length)),f.to)); }
    else if (op === 'dismiss') { await vscode.commands.executeCommand('notifications.clearAll'); await vscode.commands.executeCommand('notifications.hideToasts'); }
    else if (op !== 'snapshot') throw new Error('Unknown menu test operation');
    return snapshot();
  }
  await fs.writeFile(path.join(directory, 'ready.json'), JSON.stringify({ version: extension.packageJSON.version, vscode: vscode.version, platform: process.platform }));
  let last;
  try {
    for (const end = Date.now() + 15 * 60_000; Date.now() < end;) {
      let req; try { req = JSON.parse(await fs.readFile(path.join(directory, 'request.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; }
      if (req && req.id !== last) {
        last = req.id;
        if (req.op === 'finish') { await fs.writeFile(path.join(directory, 'response.json'), JSON.stringify({ id: last, result: true })); return; }
        try { await fs.writeFile(path.join(directory, 'response.json'), JSON.stringify({ id: last, result: await action(req.op, req.fields) })); }
        catch (e) { await fs.writeFile(path.join(directory, 'response.json'), JSON.stringify({ id: last, error: e.stack })); }
      }
      await new Promise((r) => setTimeout(r, 60));
    }
  } finally { for (const s of [...visual.sessions]) s.panel.dispose(); }
}
module.exports = { run };
