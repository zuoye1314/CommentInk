// Test-only native bridge. No workspace scripts or user files are executed.
const vscode = require('vscode'), fs = require('node:fs/promises'), path = require('node:path');
async function run() {
  const directory = process.env.COMMENT_PREVIEW_PROBE_DIR;
  const extension = vscode.extensions.getExtension('zuoye.comment-preview-probe'), api = await extension.activate();
  const L = require(path.join(extension.extensionPath, 'studio/comment-languages.cjs'));
  const { editor: visual, controller } = api.studio, oldClipboard = await vscode.env.clipboard.readText();
  let document, original, anchor, fileSequence = 0;
  function snapshot() {
    const parsed = document && controller.parse(document);
    return { language: document?.languageId, uri: document?.uri.toString(), source: document?.getText(), original, anchor,
      blocks: parsed?.blocks, diagnostics: parsed?.diagnostics,
      sessions: [...visual.sessions].map((s) => ({ type: s.type, value: s.value })),
      entries: controller.snapshot().views.filter((v) => v.uri === document?.uri.toString()).flatMap((v) => v.entries) };
  }
  async function action(op, f = {}) {
    if (op === 'open') {
      for (const s of [...visual.sessions]) s.panel.dispose();
      await L.ensureLanguage(f.language);
      const style = L.languageStyle(f.language), line = style.line ? `${style.line} PLACE` : '';
      const header = f.language === 'php' ? '<?php\n' : f.language === 'xml' ? '<?xml version="1.0"?>\n' : '';
      const source = f.source ?? (f.insideBlock ? `${header}${style.block[0]} BEFORE\n${style.block[0] === '/*' ? ' * ' : ' '}PLACE\n${style.block[1]}\n${f.program || ''}`
        : `${header}${line || style.block[0] + ' BEFORE ' + style.block[1]}\n\n${f.program || ''}`);
      const file = path.join(directory, 'fixture-' + f.language + '-' + (++fileSequence) + '.' + (f.extension || 'txt'));
      await fs.writeFile(file, source); document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      document = await vscode.languages.setTextDocumentLanguage(document, f.language);
      original = source;
      const e = await vscode.window.showTextDocument(document, 1), n = f.line ?? source.split('\n').findIndex((s) => f.insideBlock ? s.includes('PLACE') : s === '');
      e.selection = new vscode.Selection(Math.max(n, 0), 0, Math.max(n, 0), 0); anchor = document.offsetAt(e.selection.active);
    } else if (op === 'raw') {
      for (const s of [...visual.sessions]) s.panel.dispose();
      const file = path.join(directory, 'raw-' + (++fileSequence) + '.txt'); await fs.writeFile(file, f.source || '');
      document = await vscode.languages.setTextDocumentLanguage(await vscode.workspace.openTextDocument(vscode.Uri.file(file)), f.language); original = document.getText();
      const e = await vscode.window.showTextDocument(document, 1); e.selection = new vscode.Selection(f.line || 0, 0, f.line || 0, 0);
    } else if (op === 'command') await vscode.commands.executeCommand(f.command);
    else if (op === 'reopen') {
      const b = controller.parse(document).blocks[0], e = await vscode.window.showTextDocument(document, 1);
      e.selection = new vscode.Selection(b.start, 0, b.start, 0); await vscode.commands.executeCommand('commentStudio.edit');
    } else if (op === 'save') await document.save();
    else if (op === 'clipboard') { const text = await vscode.env.clipboard.readText(); return { text: text === visual.lastCopy ? text : undefined }; }
    else if (op === 'dismiss') { await vscode.commands.executeCommand('notifications.clearAll'); await vscode.commands.executeCommand('notifications.hideToasts'); }
    else if (op === 'fold-ranges') return vscode.commands.executeCommand('vscode.executeFoldingRangeProvider', document.uri);
    else if (op === 'no-editor') { for (const s of [...visual.sessions]) s.panel.dispose(); for (const d of vscode.workspace.textDocuments) if (d.isDirty && d.uri.fsPath.startsWith(directory)) await d.save(); await vscode.commands.executeCommand('workbench.action.closeAllEditors'); }
    else if (op !== 'snapshot') throw new Error('Unknown language test operation');
    return snapshot();
  }
  await fs.writeFile(path.join(directory, 'ready.json'), JSON.stringify({ ready: true }));
  let last;
  try {
    for (const deadline = Date.now() + 20 * 60_000; Date.now() < deadline;) {
      let req; try { req = JSON.parse(await fs.readFile(path.join(directory, 'request.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; }
      if (req && req.id !== last) {
        last = req.id;
        if (req.op === 'finish') { await fs.writeFile(path.join(directory, 'response.json'), JSON.stringify({ id: last, result: { finished: true } })); return; }
        try { const result = await action(req.op, req.fields); await fs.writeFile(path.join(directory, 'response.json'), JSON.stringify({ id: last, result })); }
        catch (e) { await fs.writeFile(path.join(directory, 'response.json'), JSON.stringify({ id: last, error: e.message })); }
      }
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
  } finally {
    for (const s of [...visual.sessions]) s.panel.dispose();
    if (visual.lastCopy && await vscode.env.clipboard.readText() === visual.lastCopy) await vscode.env.clipboard.writeText(oldClipboard);
  }
}
module.exports = { run };
