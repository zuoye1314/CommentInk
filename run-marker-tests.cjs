const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {spawn,execFileSync}=require('node:child_process'),{chromium}=require('playwright'),assert=require('node:assert/strict');
const {serializeComment}=require('./studio/comment-format.cjs'),M=require('./studio/model.js');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=20000){for(const end=Date.now()+ms;Date.now()<end;){const v=await fn();if(v)return v;await pause(100);}throw new Error('Reopen test timed out');}
async function main(){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'asciiflow-markers-'));console.log('Marker evidence: '+directory);
  const user=path.join(directory,'user-data'),extensions=path.join(directory,'extensions'),project=path.join(directory,'project');
  for(const p of [path.join(user,'User'),extensions,project])await fs.mkdir(p,{recursive:true});
  await fs.writeFile(path.join(user,'User/settings.json'),JSON.stringify({'workbench.startupEditor':'none','workbench.colorTheme':'Dark Modern','window.restoreWindows':'all','files.hotExit':'onExitAndWindowClose','editor.fontSize':14,'editor.lineHeight':0,'editor.minimap.enabled':false,'editor.detectIndentation':false,'workbench.secondarySideBar.defaultVisibility':'hidden','telemetry.telemetryLevel':'off','update.mode':'none','extensions.autoUpdate':false,'extensions.ignoreRecommendations':true}));
  const value={kind:'raw',tex:String.raw`\frac{x}{y}+z`};
  const data=JSON.stringify({version:2,formula:{kind:'raw',texLines:[value.tex]}});
  const math=['@math begin v2 target',data,...Array(12).fill(''),'@math end'];
  const graph=['@diagram begin v1 target',JSON.stringify({version:1,title:'Flow',nodes:[{id:'a',kind:'box',x:20,y:20,width:120,height:60,text:'In'},{id:'b',kind:'box',x:200,y:20,width:120,height:60,text:'Out'}],edges:[{id:'e',from:'a',to:'b'}]}),...Array(12).fill(''),'@diagram end'];
  const block=(rows,leader=' * ')=>['// before','/*',...rows.map(s=>leader+s),'*/','int after = 1;',''].join('\n');
  const triple=(rows,quote='"""',prefix='',assigned=false)=>['# before',assigned?'value = '+prefix+quote:'def f():\n    '+prefix+quote,...rows.map(s=>(assigned?'':'    ')+s),assigned?quote:'    '+quote,assigned?'answer=42':'    return 42',''].join('\n');
  const files={
   'startup.c':block(math),'repeat.c':block(math.map(s=>s.startsWith('@')?'** \t'+s:s)),
   'bare.c':block(math,''),'tabs.c':block(math.map(s=>s.replace('@math ','@math\t')),'\t'),
   'bad-begin.c':block(math.map(s=>s.startsWith('@math begin')?'4324 '+s:s)),
   'bad-end.c':block(math.map(s=>s==='@math end'?'说明 '+s:s)),
   'plain.py':triple(math),'raw.py':triple(math,"'''",'r'),'assigned.py':triple(math,'"""','',true),
   'graph.py':triple(graph),'ordinary.py':triple(['普通说明',...math]),
   'example.py':triple(math.map(s=>'# '+s)),
   'fstring.py':triple(['@math begin v1 target','x',...Array(10).fill(''),'@math end'],'"""','f'),
   'bytes.py':triple(['@math begin v1 target','x',...Array(10).fill(''),'@math end'],'"""','b'),
   'insert.py':'answer=42\n','insert.c':'int answer = 42;\n'
  };
  for(const [name,source] of Object.entries(files))await fs.writeFile(path.join(project,name),source);
  const packageFile=process.env.COMMENT_STUDIO_VSIX;
  if(packageFile)execFileSync('/usr/bin/code',['--user-data-dir',user,'--extensions-dir',extensions,'--install-extension',packageFile],{stdio:'pipe'});
  else await fs.symlink(__dirname,path.join(extensions,'zuoye.comment-preview-probe-0.0.8'),'dir');
  const bridge=path.join(directory,'bridge');await fs.mkdir(bridge);
  await fs.writeFile(path.join(bridge,'package.json'),JSON.stringify({name:'marker-test-bridge',publisher:'local',version:'0.0.1',engines:{vscode:'^1.142.0'},activationEvents:['onStartupFinished'],main:'index.cjs'}));
  await fs.writeFile(path.join(bridge,'README.md'),'# Isolated reopen test bridge\n');
  await fs.writeFile(path.join(bridge,'index.cjs'),`exports.activate=()=>{require(${JSON.stringify(path.join(__dirname,'studio/marker-test-host.cjs'))}).run().then(()=>require('vscode').commands.executeCommand('workbench.action.quit'),e=>{require('node:fs').writeFileSync(${JSON.stringify(path.join(directory,'bridge-error.txt'))},String(e.stack));require('vscode').commands.executeCommand('workbench.action.quit');});};`);
  if(packageFile){
    if(!process.env.COMMENT_VSCE_BIN)throw new Error('COMMENT_VSCE_BIN required');
    const vsix=path.join(directory,'bridge.vsix');execFileSync(process.execPath,[process.env.COMMENT_VSCE_BIN,'package','--skip-license','--allow-missing-repository','--out',vsix],{cwd:bridge,stdio:'pipe'});
    execFileSync('/usr/bin/code',['--user-data-dir',user,'--extensions-dir',extensions,'--install-extension',vsix],{stdio:'pipe'});
  }else await fs.symlink(bridge,path.join(extensions,'local.marker-test-bridge-0.0.1'),'dir');
  const checks=[],states=[],errors=[];let phase='1',browser,page,exitPromise;
  const read=async file=>{try{return JSON.parse(await fs.readFile(path.join(directory,file),'utf8'));}catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;}};
  const save=()=>fs.writeFile(path.join(directory,'marker-measurements.json'),JSON.stringify({at:new Date().toISOString(),package:packageFile,checks,states,errors},null,2));
  async function check(name,ok){checks.push({name,passed:!!ok});await save();assert.ok(ok,name);console.log('PASS '+name);}
  async function request(op,fields={}){const id=Date.now()+'-'+Math.random();await fs.writeFile(path.join(directory,'request.tmp'),JSON.stringify({id,phase,op,fields}));await fs.rename(path.join(directory,'request.tmp'),path.join(directory,'request.json'));return until(async()=>{const r=await read('response.json');if(r?.id!==id)return;if(r.error)throw new Error(r.error);return r.result;});}
  const snapshot=()=>request('snapshot'),entries=s=>s.views.flatMap(v=>v.entries);
  const rendered=(count=1)=>until(async()=>{const s=await snapshot();return entries(s).length===count&&s;});
  async function capture(name){await request('dismiss');await pause(300);const s=await snapshot();states.push({name,snapshot:s});await page.screenshot({path:path.join(directory,name+'.png')});await save();return s;}
  async function launch(){
    const child=spawn('/usr/bin/code',['--wait','--new-window','--disable-workspace-trust','--skip-welcome','--skip-release-notes','--user-data-dir',user,'--extensions-dir',extensions,'--remote-debugging-port=9370','--disable-gpu','--no-sandbox',project,...(phase==='1'?[path.join(project,'startup.c')]:[])],{env:{...process.env,COMMENT_PREVIEW_PROBE_DIR:directory,COMMENT_REOPEN_PHASE:phase},stdio:['ignore','pipe','pipe']});
    const log=await fs.open(path.join(directory,'code-'+phase+'.log'),'a');child.stdout.on('data',s=>{void log.write(s);});child.stderr.on('data',s=>{void log.write(s);});exitPromise=new Promise(r=>child.once('exit',code=>{void log.close();r(code);}));
    await until(()=>read('ready-'+phase+'.json'),60000);browser=await chromium.connectOverCDP('http://127.0.0.1:9370');page=await until(()=>browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('workbench')));await page.setViewportSize({width:1280,height:1000});page.on('pageerror',e=>errors.push(e.message));
  }
  async function quit(){await request('finish');await browser.close();await exitPromise;}
  try{
    await launch();
    async function geometry(){
      await pause(250);
      return page.locator('.view-lines .view-line span').evaluateAll(els=>els.flatMap(e=>{
        const st=getComputedStyle(e,'::before'),content=st.content+st.backgroundImage;
        if(!content.includes('data:image/svg+xml')||e.getBoundingClientRect().height===0)return [];
        const r=e.getBoundingClientRect();return [{x:r.x+parseFloat(st.marginLeft||0),y:r.y,height:r.height,margin:st.marginLeft,content}];
      }));
    }
    const frame=()=>until(async()=>{for(const f of page.frames())try{if(await f.locator('#apply').count())return f;}catch{}});
    for(const file of ['repeat.c','bare.c','tabs.c','plain.py','raw.py','assigned.py','graph.py']){
      const before=files[file];await request('open',{file,reset:true});let s=await rendered();
      await check(file+': automatic preview preserves source and cursor',s.source===before&&!s.dirty&&s.selection[0]===0);
      const g=await geometry();await check(file+': all slices are visible with a shared horizontal origin',g.length===entries(s)[0].tiles&&g.length>1&&Math.max(...g.map(x=>x.x))-Math.min(...g.map(x=>x.x))<.5);
      await capture('preview-'+file);await request('move',{line:s.blocks[0].bodyStart});await pause(250);s=await snapshot();
      await check(file+': entering then leaving source preserves literal and restores image',!entries(s).length&&s.source===before);
      await request('move');await rendered();
      await request('close');await request('open',{file,reset:true});await rendered();await check(file+': reopens without inserting a new object',(await snapshot()).source===before);
    }
    for(const [file,extra,line] of [['bad-begin.c','4324 ',2],['bad-end.c','说明 ',16]]){
      await request('open',{file,reset:true});let s=await until(async()=>{const s=await snapshot();return s.diagnostics.length&&s;});
      await check(file+': invalid prefix gives a located diagnostic and retains all source',!entries(s).length&&s.source===files[file]&&!s.dirty&&s.diagnostics.some(d=>d.line===line&&d.message.includes('非注释装饰内容')));
      await capture('diagnostic-'+file);await request('replace',{from:extra,to:''});await request('move');await rendered();
      await check(file+': correcting the prefix automatically restores preview',(await snapshot()).blocks.length===1);
    }
    for(const file of ['ordinary.py','example.py']){
      await request('open',{file,reset:true});await pause(500);const s=await snapshot();
      await check(file+': unmarked/prose/example strings stay ordinary source',!entries(s).length&&!s.blocks.length&&!s.diagnostics.length&&s.source===files[file]&&!s.dirty);
    }
    for(const file of ['fstring.py','bytes.py']){
      await request('open',{file,reset:true});const s=await until(async()=>{const s=await snapshot();return s.diagnostics.length&&s;});
      await check(file+': unsupported string mode explains the reason without writing',!entries(s).length&&s.diagnostics.some(d=>d.message.includes('f 字符串或 bytes'))&&s.source===files[file]&&!s.dirty);
    }
    await request('open',{file:'raw.py',reset:true});let s=await rendered();const original=s.source,b=s.blocks[0],lines=original.split('\n');
    await request('move',{line:b.start});await request('edit');let ui=await frame();
    await check('marked string editor identifies that applying updates a string',(await ui.locator('#hint').textContent()).includes('更新字符串')&&(await snapshot()).sessions[0].title.includes('Python'));
    await ui.locator('#copy').click();s=await until(async()=>{const s=await snapshot();return s.copy&&s;});
    await check('copy from a triple string generates independent Python # comments',s.copy.startsWith('    # @math begin')&&!s.copy.includes("r'''")&&s.source===original);
    await ui.locator('#latex').fill(String.raw`x^2+\sqrt{y}`);await ui.locator('#latex').press('Tab');await ui.locator('#apply').click();
    s=await until(async()=>{const s=await snapshot();return !s.sessions.length&&s.blocks[0]?.tex===String.raw`x^2+\sqrt{y}`&&s;});await rendered();
    await check('editing a marked literal preserves quotes, function and surrounding code',s.blocks[0].id==='target'&&s.source.startsWith(lines.slice(0,b.start).join('\n')+'\n')&&s.source.endsWith('\n'+lines.slice(b.end+1).join('\n')));
    await capture('applied-triple');await request('undo');await check('one native undo restores the complete original literal',(await snapshot()).source===original);
    for(const file of ['insert.py','insert.c']){
      await request('open',{file,reset:true});await request('new');ui=await frame();await ui.locator('.atom').first().fill('a');await ui.locator('.atom').nth(1).fill('b');await ui.locator('.atom').nth(1).press('Tab');await ui.locator('#apply').click();
      s=await until(async()=>{const s=await snapshot();return !s.sessions.length&&s.blocks.length===1&&s;});
      await check(file+': insertion on ordinary code automatically wraps a legal comment',s.source.endsWith(files[file])&&s.source.startsWith(file.endsWith('.py')?'# @math begin':'// @math begin'));
    }
    await check('installed manifest includes the selected icon',(await snapshot()).icon==='media/icon.png');
    await quit();await save();console.log('Marker checks: '+checks.length);
  }catch(e){await page?.screenshot({path:path.join(directory,'failure.png')}).catch(()=>{});await save();await request('finish').catch(()=>{});await browser?.close().catch(()=>{});throw e;}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
