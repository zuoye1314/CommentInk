// Test-only bridge for a real desktop VS Code profile, reused across a full quit.
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const { parseBlocks, hash } = require('./parser.cjs');
const M = require('./model.js');
async function run() {
  const directory = process.env.COMMENT_PREVIEW_PROBE_DIR, phase = process.env.COMMENT_CANVAS_PHASE || '1';
  const api = await vscode.extensions.getExtension('zuoye.comment-preview-probe').activate();
  const { editor: visual, controller } = api.studio;
  const originalClipboard = await vscode.env.clipboard.readText();
  const file = path.join(directory, 'project', 'src', 'canvas.py');
  if (phase === '1') await fs.mkdir(path.dirname(file), { recursive: true });
  if (phase === '1') { try { await fs.access(file); } catch { await fs.writeFile(file, '# BEFORE_CANVAS\n# AFTER_CANVAS\n'); } }
  const originalDisk = await fs.readFile(file, 'utf8').catch(() => null);
  if (phase === '1') {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const editor = await vscode.window.showTextDocument(doc, 1); editor.selection = new vscode.Selection(1, 0, 1, 0);
  }
  const disposables = [];
  // A genuine read-only file-system provider, rather than a mocked editor.edit.
  const virtualText = M.serialize({ type: 'math', id: 'readonly', value: M.token('x') }) + '\n# AFTER\n';
  const changed = new vscode.EventEmitter();
  disposables.push(changed, vscode.workspace.registerFileSystemProvider('studio-readonly-test', {
    onDidChangeFile: changed.event, watch() { return { dispose() {} }; },
    stat() { return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: Buffer.byteLength(virtualText), permissions: vscode.FilePermission.Readonly }; },
    readFile() { return Buffer.from(virtualText); }, readDirectory() { return []; },
    writeFile() { throw vscode.FileSystemError.NoPermissions(); }, rename() { throw vscode.FileSystemError.NoPermissions(); },
    delete() { throw vscode.FileSystemError.NoPermissions(); }, createDirectory() { throw vscode.FileSystemError.NoPermissions(); },
  }, { isReadonly: true }));
  function snapshot() {
    return { phase, hostPid: process.pid, hostParentPid: process.ppid, ...controller.snapshot(), sessions: [...visual.sessions].map((s) => ({ id: s.id, draftId: s.draftId, uri: s.uri, type: s.type, value: s.value, ui: s.ui, target: visual.savedTarget(s), error: s.error, closed: s.closed, restored: s.restored })),
      documents: vscode.workspace.textDocuments.filter((d) => d.uri.fsPath.startsWith(directory) || d.uri.scheme === 'studio-readonly-test').map((d) => ({ uri: d.uri.toString(), source: d.getText(), hash: hash(d.getText()), dirty: d.isDirty, blocks: parseBlocks(d.getText(), d.languageId).blocks })),
      journal: visual.journal, activeUri: vscode.window.activeTextEditor?.document.uri.toString() };
  }
  async function action(op, f = {}) {
    if (op === 'dismiss') { await vscode.commands.executeCommand('notifications.clearAll'); await vscode.commands.executeCommand('notifications.hideToasts'); }
    else if (op === 'open') {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(f.file || file));
      const editor = await vscode.window.showTextDocument(doc, 1); editor.selection = new vscode.Selection(1, 0, 1, 0);
      const block = controller.parse(doc).blocks.find((b) => b.type === (f.type || 'diagram'));
      await visual.open(f.type || 'diagram', doc.uri.toString(), block?.id, { forceNew: !!f.fresh });
    } else if (op === 'rename' || op === 'rename-directory') {
      const s = [...visual.sessions][0], old = vscode.Uri.parse(s.uri);
      const oldUri = op === 'rename-directory' ? vscode.Uri.file(path.dirname(old.fsPath)) : old;
      const newUri = op === 'rename-directory' ? vscode.Uri.file(path.join(directory, 'project', 'renamed-src')) : vscode.Uri.file(path.join(path.dirname(old.fsPath), f.name || 'renamed.py'));
      const edit = new vscode.WorkspaceEdit(); edit.renameFile(oldUri, newUri);
      if (!await vscode.workspace.applyEdit(edit)) throw new Error('Native rename failed');
      await visual.renames; await visual.journalWrite;
    } else if (op === 'save-source') {
      const doc = f.uri ? await vscode.workspace.openTextDocument(vscode.Uri.parse(f.uri)) : vscode.window.activeTextEditor?.document;
      if (!doc || !await doc.save()) throw new Error('Save failed');
    } else if (op === 'chmod') await fs.chmod(vscode.Uri.parse([...visual.sessions][0].uri).fsPath, f.readonly ? 0o444 : 0o644);
    else if (op === 'open-readonly-provider') {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse('studio-readonly-test:/fixture.py'));
      await vscode.languages.setTextDocumentLanguage(doc, 'python'); await vscode.window.showTextDocument(doc, 1);
      await visual.open('math', doc.uri.toString(), 'readonly');
    } else if (op === 'hide') await vscode.window.showTextDocument([...visual.sessions][0].doc, 1);
    else if (op === 'reveal') [...visual.sessions][0].panel.reveal(1);
    else if (op === 'close') for (const s of [...visual.sessions]) s.panel.dispose();
    else if (op === 'conflict') {
      const s = [...visual.sessions][0], d = s.doc, b = controller.parse(d).blocks.find((b) => b.id === s.id);
      const edit = new vscode.WorkspaceEdit(); edit.insert(d.uri, new vscode.Position(b.start + 1, 0), '# changed concurrent\n'); await vscode.workspace.applyEdit(edit);
    } else if (op === 'resolve-conflict') {
      const s = [...visual.sessions][0], d = s.doc, line = d.getText().split(/\r?\n/).indexOf('# changed concurrent');
      if (line < 0) throw new Error('Conflict fixture missing');
      const edit = new vscode.WorkspaceEdit(); edit.delete(d.uri, new vscode.Range(line, 0, line + 1, 0)); await vscode.workspace.applyEdit(edit);
    } else if (op === 'external-change') {
      const s = [...visual.sessions][0], doc = s.doc, edit = new vscode.WorkspaceEdit(); edit.insert(doc.uri, new vscode.Position(0, 0), '# Unrelated external line\n'); await vscode.workspace.applyEdit(edit);
    } else if (op === 'readonly-editor') {
      const s = [...visual.sessions][0]; await vscode.window.showTextDocument(s.doc, 1);
      await vscode.commands.executeCommand(f.readonly ? 'workbench.action.files.setActiveEditorReadonlyInSession' : 'workbench.action.files.setActiveEditorWriteableInSession');
      s.panel.reveal(1);
    } else if (op === 'undo' || op === 'redo') await vscode.commands.executeCommand(op);
    else if (op === 'clipboard') return { text: visual.lastCopy && await vscode.env.clipboard.readText() === visual.lastCopy ? visual.lastCopy : null };
    else if (op === 'flush') { await visual.journalWrite; return snapshot(); }
    else if (op === 'quit') {
      await visual.journalWrite;
      await fs.writeFile(path.join(directory, 'before-quit.json'), JSON.stringify(snapshot(), null, 2));
      // The next process cannot recover a private clipboard held only in this
      // process. Restore before shutdown, without writing it to evidence.
      if (visual.lastCopy && await vscode.env.clipboard.readText() === visual.lastCopy) await vscode.env.clipboard.writeText(originalClipboard);
      // Do not dispose the webview: exercise VS Code's own shutdown serializer.
      setTimeout(() => vscode.commands.executeCommand('workbench.action.quit'), 250);
    } else if (op === 'finish') {
      for (const s of [...visual.sessions]) s.panel.dispose();
      if (visual.lastCopy && await vscode.env.clipboard.readText() === visual.lastCopy) await vscode.env.clipboard.writeText(originalClipboard);
      for (const d of disposables) d.dispose(); setTimeout(() => vscode.commands.executeCommand('workbench.action.quit'), 250); return { finish: true };
    } else throw new Error('Unknown canvas test action: ' + op);
    await new Promise((resolve) => setTimeout(resolve, 200)); return snapshot();
  }
  await fs.writeFile(path.join(directory, `canvas-ready-${phase}.json`), JSON.stringify({ ...snapshot(), originalDisk }));
  let last;
  for (let count = 0; count < 30000; count++) {
    let req; try { req = JSON.parse(await fs.readFile(path.join(directory, 'canvas-request.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    if (req && req.id !== last && req.phase === phase) {
      last = req.id;
      try {
        const result = req.op === 'snapshot' ? snapshot() : await action(req.op, req.fields);
        await fs.writeFile(path.join(directory, 'canvas-response.json'), JSON.stringify({ id: last, result }));
        if (req.op === 'finish') return;
      } catch (error) { await fs.writeFile(path.join(directory, 'canvas-response.json'), JSON.stringify({ id: last, error: error.message })); }
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error('Canvas test bridge timed out');
}
module.exports = { run };
