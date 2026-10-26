const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {spawn,execFileSync}=require('node:child_process'),{chromium}=require('playwright'),assert=require('node:assert/strict');
const {serializeComment}=require('./studio/comment-format.cjs'),M=require('./studio/model.js');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=20000){for(const end=Date.now()+ms;Date.now()<end;){const v=await fn();if(v)return v;await pause(100);}throw new Error('Reopen test timed out');}
async function main(){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'asciiflow-alignment-'));console.log('Alignment evidence: '+directory);
  const user=path.join(directory,'user-data'),extensions=path.join(directory,'extensions'),project=path.join(directory,'project');
  for(const p of [path.join(user,'User'),extensions,project])await fs.mkdir(p,{recursive:true});
  await fs.writeFile(path.join(user,'User/settings.json'),JSON.stringify({'workbench.startupEditor':'none','workbench.colorTheme':'Dark Modern','window.restoreWindows':'all','files.hotExit':'onExitAndWindowClose','editor.fontSize':14,'editor.lineHeight':0,'editor.minimap.enabled':false,'editor.detectIndentation':false,'workbench.secondarySideBar.defaultVisibility':'hidden','telemetry.telemetryLevel':'off','update.mode':'none','extensions.autoUpdate':false,'extensions.ignoreRecommendations':true}));
  const value={kind:'raw',tex:String.raw`F(x)=\frac{
  \displaystyle\int_0^x \frac{\sin t}{1+t^2}\,\mathrm{d}t
}{
  \sqrt{\displaystyle\sum_{k=1}^{n}\frac{x_k^2}{k+1}+\varepsilon}
}`};
  // Keep both real blank lines and rows with different whitespace lengths.
  const data=JSON.stringify({version:2,formula:{kind:'raw',texLines:value.tex.split('\n')}});
  function fixture({indent=' ',star=false,mixed=false,eol='\n',type='math'}={}){
    const body=type==='math'?data:JSON.stringify({version:1,title:'Flow',nodes:[{id:'a',kind:'box',x:20,y:20,width:120,height:140,text:'Tall node'}],edges:[]});
    const leader=indent+(star?'* ':'');
    const rows=M.compactRows(JSON.parse(body));
    const blank=Array.from({length:12},(_,i)=>star?leader.trimEnd():mixed?['',' ','  ','\t','    '][i%5]:'');
    return ['// before 0','// before 1','/*',indent,leader+`@${type} begin v${type==='math'?2:1} target`,...rows.map(row=>leader+row),...blank,leader+`@${type} end`,indent,'*/','int after = 1;',''].join(eol);
  }
  const cases=[['star.c',{star:true}],['plain.c',{}],['mixed.c',{mixed:true}],['tab.c',{indent:'\t',mixed:true}],['spaces.c',{indent:'    ',mixed:true}],['crlf.c',{mixed:true,eol:'\r\n'}],['graph.c',{type:'diagram',mixed:true}]];
  for(const [name,options] of cases)await fs.writeFile(path.join(project,name),fixture(options));
  await fs.copyFile(path.join(project,'plain.c'),path.join(project,'startup.c'));
  const packageFile=process.env.COMMENT_STUDIO_VSIX;
  if(packageFile)execFileSync('/usr/bin/code',['--user-data-dir',user,'--extensions-dir',extensions,'--install-extension',packageFile],{stdio:'pipe'});
  else await fs.symlink(__dirname,path.join(extensions,'zuoye.comment-preview-probe-0.0.8'),'dir');
  const bridge=path.join(directory,'bridge');await fs.mkdir(bridge);
  await fs.writeFile(path.join(bridge,'package.json'),JSON.stringify({name:'alignment-test-bridge',publisher:'local',version:'0.0.1',engines:{vscode:'^1.142.0'},activationEvents:['onStartupFinished'],main:'index.cjs'}));
  await fs.writeFile(path.join(bridge,'README.md'),'# Isolated reopen test bridge\n');
  await fs.writeFile(path.join(bridge,'index.cjs'),`exports.activate=()=>{require(${JSON.stringify(path.join(__dirname,'studio/alignment-test-host.cjs'))}).run().then(()=>require('vscode').commands.executeCommand('workbench.action.quit'),e=>{require('node:fs').writeFileSync(${JSON.stringify(path.join(directory,'bridge-error.txt'))},String(e.stack));require('vscode').commands.executeCommand('workbench.action.quit');});};`);
  if(packageFile){
    if(!process.env.COMMENT_VSCE_BIN)throw new Error('COMMENT_VSCE_BIN required');
    const vsix=path.join(directory,'bridge.vsix');execFileSync(process.execPath,[process.env.COMMENT_VSCE_BIN,'package','--skip-license','--allow-missing-repository','--out',vsix],{cwd:bridge,stdio:'pipe'});
    execFileSync('/usr/bin/code',['--user-data-dir',user,'--extensions-dir',extensions,'--install-extension',vsix],{stdio:'pipe'});
  }else await fs.symlink(bridge,path.join(extensions,'local.alignment-test-bridge-0.0.1'),'dir');
  const checks=[],states=[],errors=[];let phase='1',browser,page,exitPromise;
  const read=async file=>{try{return JSON.parse(await fs.readFile(path.join(directory,file),'utf8'));}catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;}};
  const save=()=>fs.writeFile(path.join(directory,'alignment-measurements.json'),JSON.stringify({at:new Date().toISOString(),package:packageFile,checks,states,errors},null,2));
  async function check(name,ok){checks.push({name,passed:!!ok});await save();assert.ok(ok,name);console.log('PASS '+name);}
  async function request(op,fields={}){const id=Date.now()+'-'+Math.random();await fs.writeFile(path.join(directory,'request.tmp'),JSON.stringify({id,phase,op,fields}));await fs.rename(path.join(directory,'request.tmp'),path.join(directory,'request.json'));return until(async()=>{const r=await read('response.json');if(r?.id!==id)return;if(r.error)throw new Error(r.error);return r.result;});}
  const snapshot=()=>request('snapshot'),entries=s=>s.views.flatMap(v=>v.entries);
  const rendered=(count=1)=>until(async()=>{const s=await snapshot();return entries(s).length===count&&s;});
  async function capture(name){await request('dismiss');await pause(300);const s=await snapshot();states.push({name,snapshot:s});await page.screenshot({path:path.join(directory,name+'.png')});await save();return s;}
  async function launch(){
    const child=spawn('/usr/bin/code',['--wait','--new-window','--disable-workspace-trust','--skip-welcome','--skip-release-notes','--user-data-dir',user,'--extensions-dir',extensions,'--remote-debugging-port=9369','--disable-gpu','--no-sandbox',project,...(phase==='1'?[path.join(project,'startup.c')]:[])],{env:{...process.env,COMMENT_PREVIEW_PROBE_DIR:directory,COMMENT_REOPEN_PHASE:phase},stdio:['ignore','pipe','pipe']});
    const log=await fs.open(path.join(directory,'code-'+phase+'.log'),'a');child.stdout.on('data',s=>{void log.write(s);});child.stderr.on('data',s=>{void log.write(s);});exitPromise=new Promise(r=>child.once('exit',code=>{void log.close();r(code);}));
    await until(()=>read('ready-'+phase+'.json'),60000);browser=await chromium.connectOverCDP('http://127.0.0.1:9369');page=await until(()=>browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('workbench')));await page.setViewportSize({width:1280,height:1000});page.on('pageerror',e=>errors.push(e.message));
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
    if(process.env.COMMENT_REOPEN_BASELINE){
      await request('open',{file:'star.c',reset:true});await rendered();const good=await geometry();
      await request('open',{file:'plain.c',reset:true});await rendered();const bad=await geometry();
      const spread=g=>Math.max(...g.map(x=>x.x))-Math.min(...g.map(x=>x.x));
      states.push({name:'baseline',star:good,plain:bad});await capture('baseline-plain-misaligned');
      await check('0.0.8 reproduces shifted slices on empty unstarred rows, while starred rows align',good.length>3&&bad.length>3&&spread(good)<1&&spread(bad)>2);await quit();return;
    }
    for(const [file] of cases){
      const before=await fs.readFile(path.join(project,file),'utf8');await request('open',{file,reset:true});let s=await rendered();
      const g=await geometry(),spread=Math.max(...g.map(x=>x.x))-Math.min(...g.map(x=>x.x));
      await check(file+': every SVG slice has the same horizontal origin',g.length===entries(s)[0].tiles&&spread<.5);
      await check(file+': preview preserves exact source, dirty state and cursor',s.source===before&&!s.dirty&&s.selection[0]===0);
      states.push({name:file,geometry:g,snapshot:s});await capture('aligned-'+file);
      await request('move',{line:5});await pause(300);s=await snapshot();await check(file+': source entry removes all slices for ordinary editing',entries(s).length===0&&s.source===before);
      await request('move');s=await rendered();const restored=await geometry();
      await check(file+': leaving source restores aligned slices',restored.length===entries(s)[0].tiles&&Math.max(...restored.map(x=>x.x))-Math.min(...restored.map(x=>x.x))<.5);
    }
    // Native settings and word wrap still need real screenshots, not just model coordinates.
    for(const config of [{font:20,lineHeight:30,tab:8,wrap:'off'},{font:14,lineHeight:0,tab:4,wrap:'on'}]){
      await request('settings',config);await request('open',{file:'tab.c',reset:true});const s=await rendered();
      const g=await geometry();await check('font '+config.font+' / tab '+config.tab+' / wrap '+config.wrap+': slices stay aligned',g.length===entries(s)[0].tiles&&Math.max(...g.map(x=>x.x))-Math.min(...g.map(x=>x.x))<.5);
      const ys=[...new Set(g.map(x=>x.y))].sort((a,b)=>a-b);await check('font '+config.font+' / wrap '+config.wrap+': successive slices keep a constant line interval',ys.slice(1).every((y,i)=>Math.abs(y-ys[i]-(config.lineHeight||19))<.6));
      states.push({name:'configured-layout',config,geometry:g,snapshot:s});
      await check('configured tab size '+config.tab+' is resolved in the native editor',s.editorOptions.tabSize===config.tab);
      await capture('aligned-font-'+config.font+'-'+config.wrap);
    }
    await quit();await save();console.log('Alignment checks: '+checks.length);
  }catch(e){await page?.screenshot({path:path.join(directory,'failure.png')}).catch(()=>{});await save();await request('finish').catch(()=>{});await browser?.close().catch(()=>{});throw e;}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
