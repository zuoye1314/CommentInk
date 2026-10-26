// Test-only native bridge. All files and editor settings belong to the isolated profile.
const vscode = require('vscode'), fs = require('node:fs/promises'), path = require('node:path');
async function run() {
  const directory = process.env.COMMENT_PREVIEW_PROBE_DIR;
  const extension = vscode.extensions.getExtension('zuoye.comment-preview-probe'), api = await extension.activate();
  const { controller, editor: visual, pool } = api.studio;
  const { ensureLanguage } = require(path.join(extension.extensionPath, 'studio/comment-languages.cjs'));
  const { serializeComment } = require(path.join(extension.extensionPath, 'studio/comment-format.cjs'));
  const M = require(path.join(extension.extensionPath, 'studio/model.js'));
  const originalRender = pool.render;
  let doc, editor, sequence = 0;
  const position = (f = {}) => {
    const b = controller.parse(doc).blocks.find((b) => b.id === (f.id || 'target'));
    const line = f.where === 'above' ? 2 : f.where === 'after' ? (b?.end ?? f.end) + 1 : f.line ?? b.bodyStart;
    return new vscode.Position(line, f.character || 0);
  };
  function snapshot() {
    editor = vscode.window.visibleTextEditors.find((e) => e.document === doc && e === vscode.window.activeTextEditor)
      || vscode.window.visibleTextEditors.find((e) => e.document === doc) || editor;
    return { source: doc?.getText(), lineCount: doc?.lineCount, blocks: doc && controller.parse(doc).blocks,
      diagnostics: doc && controller.diagnostics.get(doc.uri)?.map((d) => d.message),
      selection: editor && [editor.selection.active.line, editor.selection.active.character],
      selections: editor?.selections.map((s)=>[s.anchor.line,s.anchor.character,s.active.line,s.active.character]),
      views: controller.snapshot().views.filter((v) => v.uri === doc?.uri.toString()),
      modes: [...controller.views.values()].filter((v) => v.editor.document === doc).map((v) => ({ column:v.editor.viewColumn,editing:[...v.editing],pinned:[...v.source] })) };
  }
  async function action(op, f = {}) {
    if (op === 'quiet-language') {
      const file=path.join(directory,'ordinary.c');await fs.writeFile(file,'int value = 1;\n');
      const ordinary=await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      const native=await vscode.window.showTextDocument(ordinary,1);
      await native.edit((edit)=>edit.insert(new vscode.Position(0,0),'// ordinary code\n'));
      await new Promise((r)=>setTimeout(r,250));
      return {source:ordinary.getText(),diagnostics:vscode.languages.getDiagnostics(ordinary.uri).map((d)=>d.message)};
    } else if (op === 'open') {
      await vscode.commands.executeCommand('workbench.action.joinAllGroups');
      await ensureLanguage(f.language);
      const prefix = f.language === 'python' ? '#' : '//';
      const style = f.block ? { block: ['/*','*/'] } : { line: prefix };
      const value = f.type === 'diagram' ? {version:1,title:'Live',nodes:[{id:'a',kind:'box',x:30,y:20,width:140,height:60,text:'Input'}],edges:[]}
        : {kind:'fraction',numerator:M.token('x'),denominator:M.token('y')};
      const raw = ['@math begin v1 target','\\frac{','x','}{','y','}','@math end'].map((s)=>prefix+' '+s).join('\n');
      const target = f.raw ? raw : serializeComment({type:f.type,id:'target',value,style,minimumBodyLines:8});
      const sibling = serializeComment({type:'math',id:'sibling',value:M.token('k+1'),style:{line:prefix},minimumBodyLines:2});
      const source = Array.from({length:8},(_,i)=>prefix+' ABOVE '+i).join('\n')+'\n'+target+'\n'+prefix+' BETWEEN\n'+sibling+'\n'+prefix+' BELOW\n'+Array.from({length:250},(_,i)=>prefix+' END '+i).join('\n')+'\n';
      const file = path.join(directory,'live-'+(++sequence)+'.txt');await fs.writeFile(file,source);
      doc = await vscode.languages.setTextDocumentLanguage(await vscode.workspace.openTextDocument(vscode.Uri.file(file)),f.language);
      editor = await vscode.window.showTextDocument(doc,1);editor.selection=new vscode.Selection(2,0,2,0);
      await controller.show(editor);editor.revealRange(new vscode.Range(0,0,0,0),vscode.TextEditorRevealType.AtTop);
    } else if (op === 'move') {
      editor = await vscode.window.showTextDocument(doc,f.column || 1);
      const p = position(f);editor.selection=new vscode.Selection(p,p);
      if(f.reveal)editor.revealRange(editor.selection,vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    } else if (op === 'select') editor.selections=f.selections.map((s)=>new vscode.Selection(...s));
    else if (op === 'replace') {
      const at=doc.getText().indexOf(f.from);if(at<0)throw new Error('Test text not found: '+f.from);
      await editor.edit((edit)=>edit.replace(new vscode.Range(doc.positionAt(at),doc.positionAt(at+f.from.length)),f.to),{undoStopBefore:true,undoStopAfter:true});
    } else if (op === 'undo') await vscode.commands.executeCommand('undo');
    else if (op === 'pin') await vscode.commands.executeCommand('commentStudio.source',doc.uri);
    else if (op === 'preview') await vscode.commands.executeCommand('commentStudio.show',doc.uri);
    else if (op === 'split') {
      editor=await vscode.window.showTextDocument(doc,2);editor.selection=new vscode.Selection(2,0,2,0);
    } else if (op === 'focus') editor=await vscode.window.showTextDocument(doc,f.column);
    else if (op === 'readonly') await vscode.commands.executeCommand(f.value?'workbench.action.files.setActiveEditorReadonlyInSession':'workbench.action.files.setActiveEditorWriteableInSession');
    else if (op === 'delay') pool.render=f.value?async function(...args){await new Promise((r)=>setTimeout(r,350));return originalRender.apply(this,args);}:originalRender;
    else if (op === 'rapid') {
      for(let i=0;i<8;i++){const p=position({where:i%2?'above':undefined});editor.selection=new vscode.Selection(p,p);await new Promise((r)=>setTimeout(r,20));}
      const p=position(f);editor.selection=new vscode.Selection(p,p);
    } else if (op === 'code-lenses') return (await vscode.commands.executeCommand('vscode.executeCodeLensProvider',doc.uri))?.map((lens)=>lens.command) || [];
    else if (op === 'dismiss') {await vscode.commands.executeCommand('notifications.clearAll');await vscode.commands.executeCommand('notifications.hideToasts');}
    else if(op!=='snapshot')throw new Error('Unknown live test operation');
    return snapshot();
  }
  await fs.writeFile(path.join(directory,'ready.json'),JSON.stringify({version:extension.packageJSON.version,vscode:vscode.version,platform:process.platform}));
  let last;
  try {
    for(const end=Date.now()+15*60_000;Date.now()<end;){
      let req;try{req=JSON.parse(await fs.readFile(path.join(directory,'request.json'),'utf8'));}catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;}
      if(req&&req.id!==last){last=req.id;if(req.op==='finish'){await fs.writeFile(path.join(directory,'response.json'),JSON.stringify({id:last,result:true}));return;}
        try{await fs.writeFile(path.join(directory,'response.json'),JSON.stringify({id:last,result:await action(req.op,req.fields)}));}
        catch(e){await fs.writeFile(path.join(directory,'response.json'),JSON.stringify({id:last,error:e.stack}));}}
      await new Promise((r)=>setTimeout(r,60));
    }
  } finally {pool.render=originalRender;for(const s of [...visual.sessions])s.panel.dispose();}
}
module.exports={run};
