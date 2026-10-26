// Test-only bridge: normal extension startup, no forced product activation.
const vscode=require('vscode'),fs=require('node:fs/promises'),path=require('node:path');
const pause=(ms)=>new Promise(r=>setTimeout(r,ms));
async function run(){
  const directory=process.env.COMMENT_PREVIEW_PROBE_DIR,phase=process.env.COMMENT_REOPEN_PHASE;
  const ext=vscode.extensions.getExtension('zuoye.comment-preview-probe');
  for(const end=Date.now()+30000;!ext.isActive&&Date.now()<end;)await pause(80);
  if(!ext.isActive)throw new Error('Product did not activate by itself');
  const {controller}=ext.exports.studio;
  let editor,doc,last;
  const current=()=>vscode.window.activeTextEditor;
  function snapshot(){
    editor=current()||editor;doc=editor?.document||doc;
    const state=doc&&controller.documents.get(doc.uri.toString());
    return {version:ext.packageJSON.version,vscode:vscode.version,platform:process.platform,
      uri:doc?.uri.toString(),source:doc?.getText(),dirty:doc?.isDirty,docVersion:doc?.version,
      selection:editor&&[editor.selection.active.line,editor.selection.active.character],
      editorOptions:editor?.options,
      ranges:editor?.visibleRanges.map(r=>[r.start.line,r.end.line]),
      enabled:state?.enabled||false,blocks:state?.result?.blocks||[],
      diagnostics:doc&&controller.diagnostics.get(doc.uri)?.map(d=>d.message)||[],
      views:controller.snapshot().views.filter(v=>v.uri===doc?.uri.toString()),
      modes:[...controller.views.values()].filter(v=>v.editor.document===doc).map(v=>({column:v.editor.viewColumn,pinned:[...v.source]}))};
  }
  async function action(op,f={}){
    if(op==='open'){
      await vscode.commands.executeCommand('workbench.action.joinAllGroups');
      doc=await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory,'project',f.file)));
      editor=await vscode.window.showTextDocument(doc,{viewColumn:1,preview:false});
      if(f.inside)editor.selection=new vscode.Selection(5,0,5,0);
      else if(f.reset)editor.selection=new vscode.Selection(0,0,0,0);
    } else if(op==='close')await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    else if(op==='move'){
      editor=current();editor.selection=new vscode.Selection(f.line||0,0,f.line||0,0);
    } else if(op==='pin')await vscode.commands.executeCommand('commentStudio.source',current().document.uri);
    else if(op==='preview')await vscode.commands.executeCommand('commentStudio.show',current().document.uri);
    else if(op==='replace'){
      editor=current();doc=editor.document;const at=doc.getText().indexOf(f.from);if(at<0)throw new Error('Missing test text');
      await editor.edit(edit=>edit.replace(new vscode.Range(doc.positionAt(at),doc.positionAt(at+f.from.length)),f.to));
    } else if(op==='paste'){
      editor=current();const text=await fs.readFile(path.join(directory,'project','target.py'),'utf8');
      await editor.edit(edit=>edit.insert(new vscode.Position(1,0),text));
    } else if(op==='language')await vscode.languages.setTextDocumentLanguage(current().document,f.language);
    else if(op==='readonly')await vscode.commands.executeCommand(f.value?'workbench.action.files.setActiveEditorReadonlyInSession':'workbench.action.files.setActiveEditorWriteableInSession');
    else if(op==='settings'){const cfg=vscode.workspace.getConfiguration('editor');for(const [k,v] of Object.entries({fontSize:f.font,lineHeight:f.lineHeight,tabSize:f.tab,wordWrap:f.wrap,detectIndentation:false}))await cfg.update(k,v,vscode.ConfigurationTarget.Global);}
    else if(op==='save')await current().document.save();
    else if(op==='dismiss'){await vscode.commands.executeCommand('notifications.clearAll');await vscode.commands.executeCommand('notifications.hideToasts');}
    else if(op!=='snapshot')throw new Error('Unknown reopen test operation');
    return snapshot();
  }
  await fs.writeFile(path.join(directory,'ready-'+phase+'.json'),JSON.stringify(snapshot()));
  for(const end=Date.now()+15*60_000;Date.now()<end;){
    let req;try{req=JSON.parse(await fs.readFile(path.join(directory,'request.json'),'utf8'));}catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;}
    if(req?.phase===phase&&req.id!==last){last=req.id;
      if(req.op==='finish'){await fs.writeFile(path.join(directory,'response.json'),JSON.stringify({id:last,result:true}));return;}
      try{await fs.writeFile(path.join(directory,'response.json'),JSON.stringify({id:last,result:await action(req.op,req.fields)}));}
      catch(e){await fs.writeFile(path.join(directory,'response.json'),JSON.stringify({id:last,error:e.stack}));}
    }
    await pause(60);
  }
}
module.exports={run};
