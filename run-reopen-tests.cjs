const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {spawn,execFileSync}=require('node:child_process'),{chromium}=require('playwright'),assert=require('node:assert/strict');
const {serializeComment}=require('./studio/comment-format.cjs'),M=require('./studio/model.js');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=20000){for(const end=Date.now()+ms;Date.now()<end;){const v=await fn();if(v)return v;await pause(100);}throw new Error('Reopen test timed out');}
async function main(){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'asciiflow-reopen-'));console.log('Reopen evidence: '+directory);
  const user=path.join(directory,'user-data'),extensions=path.join(directory,'extensions'),project=path.join(directory,'project');
  for(const p of [path.join(user,'User'),extensions,project])await fs.mkdir(p,{recursive:true});
  await fs.writeFile(path.join(user,'User/settings.json'),JSON.stringify({'workbench.startupEditor':'none','workbench.colorTheme':'Dark Modern','window.restoreWindows':'all','files.hotExit':'onExitAndWindowClose','editor.fontSize':14,'editor.lineHeight':0,'editor.minimap.enabled':false,'workbench.secondarySideBar.defaultVisibility':'hidden','telemetry.telemetryLevel':'off','update.mode':'none','extensions.autoUpdate':false,'extensions.ignoreRecommendations':true}));
  const formula={kind:'fraction',numerator:M.token('x'),denominator:M.token('y')};
  const graph={version:1,title:'Reopen',nodes:[{id:'a',kind:'box',x:20,y:20,width:120,height:60,text:'Input'},{id:'b',kind:'box',x:220,y:20,width:120,height:60,text:'Output'}],edges:[{id:'e',from:'a',to:'b'}]};
  const definitions=[['c-line.c','math',{line:'//'}],['c-block.c','diagram',{block:['/*','*/']}],['target.py','math',{line:'#'}],['target.ts','diagram',{line:'//'}],['target.html','math',{block:['<!--','-->']}]];
  for(const [name,type,style] of definitions){
    const comment=s=>style.line?style.line+' '+s:style.block[0]+' '+s+' '+style.block[1];
    const text=Array.from({length:4},(_,i)=>comment('before '+i)).join('\n')+'\n'+serializeComment({type,id:'target',value:type==='math'?formula:graph,style,minimumBodyLines:10})+'\n'+comment('after')+'\n';
    await fs.writeFile(path.join(project,name),text);
  }
  const startup=(await fs.readFile(path.join(project,'c-line.c'),'utf8'))+serializeComment({type:'diagram',id:'second',value:graph,style:{line:'//'},minimumBodyLines:10})+'\nint main(void){return 0;}\n';
  await fs.writeFile(path.join(project,'startup.c'),startup);
  await fs.writeFile(path.join(project,'ordinary.py'),'# ordinary file\npass\n');
  await fs.writeFile(path.join(project,'invalid.py'),(await fs.readFile(path.join(project,'target.py'),'utf8')).replace('"value":"x"','"value":x'));
  await fs.writeFile(path.join(project,'short.py'),'# before\n# @math begin v1 short\n# \\frac{x}{y}\n# @math end\n# after\n');
  const fake=serializeComment({type:'math',id:'fake',value:formula,style:{line:'#'},minimumBodyLines:10});
  await fs.writeFile(path.join(project,'string.py'),'text = """\n'+fake+'\n"""\n');
  const triple='value = r"""\n'+serializeComment({type:'math',id:'triple',value:formula,style:{line:'#'},minimumBodyLines:10}).split('\n').map(row=>row.replace(/^# ?/,'')).join('\n')+'\n"""\nanswer=42\n';
  await fs.writeFile(path.join(project,'triple.py'),triple);
  await fs.writeFile(path.join(project,'mode.txt'),await fs.readFile(path.join(project,'target.py')));
  const packageFile=process.env.COMMENT_STUDIO_VSIX;
  if(packageFile)execFileSync('/usr/bin/code',['--user-data-dir',user,'--extensions-dir',extensions,'--install-extension',packageFile],{stdio:'pipe'});
  else await fs.symlink(__dirname,path.join(extensions,'zuoye.comment-preview-probe-0.0.8'),'dir');
  const bridge=path.join(directory,'bridge');await fs.mkdir(bridge);
  await fs.writeFile(path.join(bridge,'package.json'),JSON.stringify({name:'reopen-test-bridge',publisher:'local',version:'0.0.1',engines:{vscode:'^1.142.0'},activationEvents:['onStartupFinished'],main:'index.cjs'}));
  await fs.writeFile(path.join(bridge,'README.md'),'# Isolated reopen test bridge\n');
  await fs.writeFile(path.join(bridge,'index.cjs'),`exports.activate=()=>{require(${JSON.stringify(path.join(__dirname,'studio/reopen-test-host.cjs'))}).run().then(()=>require('vscode').commands.executeCommand('workbench.action.quit'),e=>{require('node:fs').writeFileSync(${JSON.stringify(path.join(directory,'bridge-error.txt'))},String(e.stack));require('vscode').commands.executeCommand('workbench.action.quit');});};`);
  if(packageFile){
    if(!process.env.COMMENT_VSCE_BIN)throw new Error('COMMENT_VSCE_BIN required');
    const vsix=path.join(directory,'bridge.vsix');execFileSync(process.execPath,[process.env.COMMENT_VSCE_BIN,'package','--skip-license','--allow-missing-repository','--out',vsix],{cwd:bridge,stdio:'pipe'});
    execFileSync('/usr/bin/code',['--user-data-dir',user,'--extensions-dir',extensions,'--install-extension',vsix],{stdio:'pipe'});
  }else await fs.symlink(bridge,path.join(extensions,'local.reopen-test-bridge-0.0.1'),'dir');
  const checks=[],states=[],errors=[];let phase='1',browser,page,exitPromise;
  const read=async file=>{try{return JSON.parse(await fs.readFile(path.join(directory,file),'utf8'));}catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;}};
  const save=()=>fs.writeFile(path.join(directory,'reopen-measurements.json'),JSON.stringify({at:new Date().toISOString(),package:packageFile,checks,states,errors},null,2));
  async function check(name,ok){checks.push({name,passed:!!ok});await save();assert.ok(ok,name);console.log('PASS '+name);}
  async function request(op,fields={}){const id=Date.now()+'-'+Math.random();await fs.writeFile(path.join(directory,'request.tmp'),JSON.stringify({id,phase,op,fields}));await fs.rename(path.join(directory,'request.tmp'),path.join(directory,'request.json'));return until(async()=>{const r=await read('response.json');if(r?.id!==id)return;if(r.error)throw new Error(r.error);return r.result;});}
  const snapshot=()=>request('snapshot'),entries=s=>s.views.flatMap(v=>v.entries);
  const rendered=(count=1)=>until(async()=>{const s=await snapshot();return entries(s).length===count&&s;});
  async function capture(name){await request('dismiss');await pause(300);const s=await snapshot();states.push({name,snapshot:s});await page.screenshot({path:path.join(directory,name+'.png')});await save();return s;}
  async function launch(){
    const child=spawn('/usr/bin/code',['--wait','--new-window','--disable-workspace-trust','--skip-welcome','--skip-release-notes','--user-data-dir',user,'--extensions-dir',extensions,'--remote-debugging-port=9368','--disable-gpu','--no-sandbox',project,...(phase==='1'?[path.join(project,'startup.c')]:[])],{env:{...process.env,COMMENT_PREVIEW_PROBE_DIR:directory,COMMENT_REOPEN_PHASE:phase},stdio:['ignore','pipe','pipe']});
    const log=await fs.open(path.join(directory,'code-'+phase+'.log'),'a');child.stdout.on('data',s=>{void log.write(s);});child.stderr.on('data',s=>{void log.write(s);});exitPromise=new Promise(r=>child.once('exit',code=>{void log.close();r(code);}));
    await until(()=>read('ready-'+phase+'.json'),60000);browser=await chromium.connectOverCDP('http://127.0.0.1:9368');page=await until(()=>browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('workbench')));await page.setViewportSize({width:1280,height:1000});page.on('pageerror',e=>errors.push(e.message));
  }
  async function quit(){await request('finish');await browser.close();await exitPromise;}
  try{
    await launch();
    if(process.env.COMMENT_REOPEN_BASELINE){await pause(1200);const s=await capture('baseline-no-auto-preview');await check('0.0.7 reproduces no startup preview despite two saved valid blocks',s.source===startup&&!s.enabled&&entries(s).length===0);await quit();return;}
    let s=await rendered(2);await check('cold startup automatically discovers formula and diagram without any Inscribe command',s.source===startup&&!s.dirty&&s.selection[0]===0);await capture('startup-auto');
    for(const [file] of definitions){
      await request('open',{file,reset:true});s=await rendered();const original=await fs.readFile(path.join(project,file),'utf8');
      await check(file+': opening existing comments automatically renders without editing source',s.source===original&&!s.dirty&&s.selection[0]===0);
      await request('close');await request('open',{file,reset:true});s=await rendered();
      await check(file+': closing and reopening restores preview automatically',s.source===original&&!s.dirty&&s.selection[0]===0);
      await capture('reopened-'+file.replace('.','-'));
    }
    await request('open',{file:'target.py',inside:true});await pause(400);s=await snapshot();await check('a restored cursor inside the block keeps editable source visible',s.enabled&&entries(s).length===0&&s.selection[0]===5);await request('move');await rendered();
    await check('moving the cursor outside resumes preview without an explicit preview command',entries(await snapshot()).length===1);
    await request('pin');await request('open',{file:'c-line.c',reset:true});await rendered();await request('open',{file:'target.py',reset:true});await pause(400);s=await snapshot();await check('tab rediscovery preserves explicitly pinned source mode',entries(s).length===0&&s.modes[0].pinned.includes('target'));await request('preview');await rendered();
    await request('open',{file:'ordinary.py',reset:true});await pause(350);s=await snapshot();await check('ordinary files remain quiet before any marker is inserted',!s.enabled&&!s.diagnostics.length&&!s.dirty);await request('paste');s=await rendered();await check('pasting a complete comment discovers it without inserting a new formula through the plugin',s.blocks.length===1&&s.selection[0]===0);
    await request('open',{file:'invalid.py',reset:true});await pause(500);s=await snapshot();await check('invalid saved data remains source with diagnostics on first open',s.enabled&&!entries(s).length&&s.diagnostics.length>0&&!s.dirty);await request('replace',{from:'"value":x',to:'"value":"x"'});s=await rendered();await check('repairing previously invalid data restores automatic preview',s.diagnostics.length===0);
    await request('open',{file:'short.py',reset:true});await pause(500);s=await snapshot();await check('short saved source reports missing space without adding padding',!entries(s).length&&!s.dirty&&s.diagnostics.some(m=>m.includes('源码空间不足')));await capture('short-source');
    await request('open',{file:'string.py',reset:true});await pause(400);s=await snapshot();await check('comment-looking examples inside ordinary Python strings stay source',!s.enabled&&!entries(s).length&&!s.diagnostics.length&&!s.dirty);
    await request('open',{file:'mode.txt',reset:true});await pause(300);await check('unsupported plain text does not automatically render',!entries(await snapshot()).length);await request('language',{language:'python'});s=await rendered();await check('changing to a supported language starts preview without a command',s.selection[0]===0&&!s.dirty);
    await request('open',{file:'c-line.c',reset:true});await rendered();await request('readonly',{value:true});await request('open',{file:'target.ts',reset:true});await rendered();await request('open',{file:'c-line.c',reset:true});s=await rendered();await check('existing read-only editor can rebuild preview without a write',!s.dirty&&s.source===(await fs.readFile(path.join(project,'c-line.c'),'utf8')));await request('readonly',{value:false});
    await request('open',{file:'startup.c',reset:true});await rendered(2);await capture('before-full-quit');await quit();
    phase='2';await launch();s=await until(async()=>{const s=await snapshot();return s.uri?.endsWith('/startup.c')&&entries(s).length===2&&s;});
    await check('a full quit and restart restores saved-file formula and diagram automatically',s.source===startup&&!s.dirty&&s.selection[0]===0);await capture('after-full-restart');
    const visible=await page.locator('.view-lines .view-line span').evaluateAll(els=>els.reduce((n,e)=>n+['::before','::after'].filter(p=>{const s=getComputedStyle(e,p);return(s.content+s.backgroundImage).includes('data:image/svg+xml')&&e.getBoundingClientRect().height>0;}).length,0));
    await check('all expected SVG slices are visible after the full restart',visible===entries(s).reduce((n,e)=>n+e.tiles,0));
    await request('open',{file:'triple.py',reset:true});s=await rendered();await check('marked triple-string preview is read-only before full exit',s.source===triple&&!s.dirty);await quit();
    phase='3';await launch();s=await until(async()=>{const s=await snapshot();return s.uri?.endsWith('/triple.py')&&entries(s).length===1&&s;});
    await check('full quit and restart automatically restores a marked Python triple-string preview',s.source===triple&&!s.dirty&&s.selection[0]===0);await capture('triple-after-full-restart');
    const tripleVisible=await page.locator('.view-lines .view-line span').evaluateAll(els=>els.filter(e=>{const st=getComputedStyle(e,'::before');return(st.content+st.backgroundImage).includes('data:image/svg+xml')&&e.getBoundingClientRect().height>0;}).length);
    await check('all triple-string SVG slices are actually visible after full restart',tripleVisible===entries(s)[0].tiles);
    await quit();await save();console.log('Reopen checks: '+checks.length);
  }catch(e){await page?.screenshot({path:path.join(directory,'failure.png')}).catch(()=>{});await save();await request('finish').catch(()=>{});await browser?.close().catch(()=>{});throw e;}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
