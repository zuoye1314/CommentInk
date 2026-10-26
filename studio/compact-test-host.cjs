// Test-only native bridge, confined to the launcher's temporary profile/files.
const vscode = require('vscode'), fs = require('node:fs/promises'), path = require('node:path');
async function run() {
  const directory = process.env.COMMENT_PREVIEW_PROBE_DIR;
  const extension = vscode.extensions.getExtension('zuoye.comment-preview-probe'), api = await extension.activate();
  const root = extension.extensionPath, { controller, editor: visual } = api.studio;
  const L = require(path.join(root, 'studio/comment-languages.cjs'));
  const { serializeComment } = require(path.join(root, 'studio/comment-format.cjs'));
  const M = require(path.join(root, 'studio/model.js'));
  let document, textEditor, sequence = 0;
  function snapshot() {
    textEditor = vscode.window.visibleTextEditors.find((e) => e.document === document) || textEditor;
    return { source: document?.getText(), lineCount: document?.lineCount, blocks: document && controller.parse(document).blocks,
      selections: textEditor?.selections.map((s) => ({ anchor: [s.anchor.line, s.anchor.character], active: [s.active.line, s.active.character] })),
      visibleRanges: textEditor?.visibleRanges.map((r) => [r.start.line, r.end.line]),
      sessions: [...visual.sessions].map((s) => ({ type: s.type, value: s.value })),
      diagnostics: document && controller.diagnostics.get(document.uri)?.map((d)=>d.message),
      entries: controller.snapshot().views.filter((v) => v.uri === document?.uri.toString()).flatMap((v) => v.entries) };
  }
  async function action(op, f = {}) {
    if (op === 'open') {
      await L.ensureLanguage(f.language);
      const style = L.languageStyle(f.language), comment = style.line || '//';
      const value = f.value || (f.type === 'math' ? M.template('fraction') : { version: 1, title: 'Cursor test', nodes: [{ id: 'a', kind: 'box', x: 40, y: 40, width: 140, height: 60, text: 'Input' }], edges: [] });
      let payload = serializeComment({ type: f.type, id: 'target', value, style: f.block ? { block: style.block } : style, minimumBodyLines: f.minimumBodyLines ?? 8 });
      if (f.legacy) { const body = {version:2,formula:value}; payload = ['@math begin v2 target',...JSON.stringify(body,null,2).split('\n'),'@math end'].map((s)=>comment+' '+s).join('\n'); }
      const source = Array.from({ length: 25 }, (_, i) => `${comment} before ${i}`).join('\n') + '\n' + payload + '\n' + Array.from({ length: 350 }, (_, i) => `${comment} after ${i}`).join('\n') + '\n';
      const file = path.join(directory, 'cursor-' + (++sequence) + '.txt'); await fs.writeFile(file, source);
      document = await vscode.languages.setTextDocumentLanguage(await vscode.workspace.openTextDocument(vscode.Uri.file(file)), f.language);
      textEditor = await vscode.window.showTextDocument(document, 1); textEditor.selection = new vscode.Selection(24, 0, 24, 0);
      await controller.show(textEditor);
      textEditor.revealRange(new vscode.Range(23, 0, 23, 0), vscode.TextEditorRevealType.AtTop);
    } else if (op === 'compact') await vscode.commands.executeCommand('commentStudio.compact',document.uri,'target');
    else if (op === 'undo' || op === 'redo') await vscode.commands.executeCommand(op);
    else if (op === 'move-out') { textEditor.selection=new vscode.Selection(24,0,24,0); }
    else if (op === 'padding') {
      const b=controller.parse(document).blocks[0];
      if(f.remove){
        const line=Array.from({length:b.bodyCount},(_,i)=>b.bodyStart+i).find((line)=> /^(?:\s*\*|\s*#|\s*\/\/)\s*$/.test(document.lineAt(line).text));
        if(line===undefined)throw new Error('No padding row');
        await textEditor.edit((edit)=>edit.delete(new vscode.Range(line,0,line+1,0)),{undoStopBefore:true,undoStopAfter:true});
      } else {
        const line=b.end, leader=b.leader || b.indent+b.prefix+' ';
        await textEditor.edit((edit)=>edit.insert(new vscode.Position(line,0),leader.trimEnd()+'\n'),{undoStopBefore:true,undoStopAfter:true});
      }
    } else if (op === 'readonly') await vscode.commands.executeCommand(f.value?'workbench.action.files.setActiveEditorReadonlyInSession':'workbench.action.files.setActiveEditorWriteableInSession');
    else if (op === 'copy-read') { const text=await vscode.env.clipboard.readText();return {text,blocks:controller.parse(await vscode.workspace.openTextDocument({language:document.languageId,content:text})).blocks}; }
    else if (op === 'cancel') {for(const s of [...visual.sessions])s.panel.dispose();}
    else if (op === 'source') {
      controller.reveal(textEditor, 'target');
      const b = controller.parse(document).blocks[0]; textEditor.selection = new vscode.Selection(b.bodyStart + 1, 2, b.bodyStart + 1, 2);
    } else if (op === 'show') await vscode.commands.executeCommand('commentStudio.show', document.uri.toString(), 'target');
    else if (op === 'select') {
      textEditor.selections = f.selections.map((s) => new vscode.Selection(...s));
    } else if (op === 'edit') await vscode.commands.executeCommand('commentStudio.edit', document.uri.toString(), 'target');
    else if (op === 'dismiss') { await vscode.commands.executeCommand('notifications.clearAll'); await vscode.commands.executeCommand('notifications.hideToasts'); }
    else if (op !== 'snapshot') throw new Error('Unknown cursor test operation');
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
