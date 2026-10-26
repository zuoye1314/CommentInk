const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000) { for (const end = Date.now() + ms; Date.now() < end;) { const v = await fn(); if (v) return v; await pause(80); } throw new Error('Language test timed out'); }
async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'asciiflow-compact-')); console.log('Compact evidence: ' + directory);
  const user = path.join(directory, 'user-data'), extensions = path.join(directory, 'extensions');
  await fs.mkdir(path.join(user, 'User'), { recursive: true }); await fs.mkdir(extensions);
  await fs.writeFile(path.join(user, 'User/settings.json'), JSON.stringify({ 'workbench.startupEditor': 'none', 'window.closeWhenEmpty': false, 'workbench.colorTheme': 'Dark Modern', 'editor.lineHeight': 0, 'editor.fontSize': 14, 'editor.minimap.enabled': false, 'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoUpdate': false, 'extensions.ignoreRecommendations': true }));
  const productArgs = process.env.COMMENT_STUDIO_VSIX ? [] : ['--extensionDevelopmentPath', __dirname, '--extensionTestsPath', path.join(__dirname, 'studio/compact-test-host.cjs')];
  if (process.env.COMMENT_STUDIO_VSIX) {
    if (!process.env.COMMENT_VSCE_BIN) throw new Error('COMMENT_VSCE_BIN is required for packaged-extension testing');
    execFileSync('/usr/bin/code', ['--user-data-dir', user, '--extensions-dir', extensions, '--install-extension', process.env.COMMENT_STUDIO_VSIX], { stdio: 'pipe' });
    const bridge = path.join(directory, 'bridge'); await fs.mkdir(bridge);
    await fs.writeFile(path.join(bridge, 'package.json'), JSON.stringify({ name: 'compact-test-bridge', publisher: 'local', version: '0.0.1', engines: { vscode: '^1.142.0' }, activationEvents: ['onStartupFinished'], main: 'index.cjs' }));
    await fs.writeFile(path.join(bridge, 'README.md'), '# Temporary language test bridge\nOnly used in an isolated test profile.\n');
    await fs.writeFile(path.join(bridge, 'index.cjs'), `exports.activate=()=>{require(${JSON.stringify(path.join(__dirname, 'studio/compact-test-host.cjs'))}).run().then(()=>require('vscode').commands.executeCommand('workbench.action.quit'),error=>{require('node:fs').writeFileSync(${JSON.stringify(path.join(directory, 'bridge-error.txt'))},String(error.stack));require('vscode').commands.executeCommand('workbench.action.quit');});};`);
    const bridgePackage = path.join(directory, 'bridge.vsix');
    execFileSync(process.execPath, [process.env.COMMENT_VSCE_BIN, 'package', '--skip-license', '--allow-missing-repository', '--out', bridgePackage], { cwd: bridge, stdio: 'pipe' });
    execFileSync('/usr/bin/code', ['--user-data-dir', user, '--extensions-dir', extensions, '--install-extension', bridgePackage], { stdio: 'pipe' });
  }
  const child = spawn('/usr/bin/code', ['--wait', '--new-window', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--user-data-dir', user, '--extensions-dir', extensions, ...productArgs, '--remote-debugging-port=9367', '--disable-gpu', '--no-sandbox'], { env: { ...process.env, COMMENT_PREVIEW_PROBE_DIR: directory }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = await fs.open(path.join(directory, 'code.log'), 'a'); child.stdout.on('data', (s) => { void log.write(s); }); child.stderr.on('data', (s) => { void log.write(s); });
  const exited = new Promise((r) => child.once('exit', (code) => { void log.close(); r(code); }));
  const checks = [], cases = [], errors = []; let browser, page, ui;
  async function read(file) { try { return JSON.parse(await fs.readFile(path.join(directory, file), 'utf8')); } catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; } }
  async function request(op, fields) {
    const id = Date.now() + '-' + Math.random(); await fs.writeFile(path.join(directory, 'request.tmp'), JSON.stringify({ id, op, fields })); await fs.rename(path.join(directory, 'request.tmp'), path.join(directory, 'request.json'));
    return until(async () => { const r = await read('response.json'); if (r?.id !== id) return; if (r.error) throw new Error(r.error); return r.result; });
  }
  const snapshot = () => request('snapshot');
  async function save() { await fs.writeFile(path.join(directory, 'compact-measurements.json'), JSON.stringify({ at: new Date().toISOString(), package: process.env.COMMENT_STUDIO_VSIX && path.basename(process.env.COMMENT_STUDIO_VSIX), checks, cases, errors }, null, 2)); }
  async function check(name, ok) { checks.push({ name, passed: !!ok }); await save(); assert.ok(ok, name); console.log('PASS ' + name); }
  async function frame() { return until(async () => { for (const f of page.frames()) try { if (await f.locator('#apply').count()) return f; } catch {} }); }
  async function capture(name) { await request('dismiss'); await pause(150); await page.screenshot({ path: path.join(directory, name + '.png') }); }
  try {
    await until(() => read('ready.json'), 60000);
    browser = await chromium.connectOverCDP('http://127.0.0.1:9367'); page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes('workbench'));
    await page.setViewportSize({ width: 1280, height: 1000 }); page.on('pageerror', (e) => errors.push(e.message));


    const entry=(s)=>s.entries[0];
    const settle=()=>until(async()=>{const s=await snapshot();return entry(s)&&s;});
    for(const [language,block,type] of [['c',false,'math'],['c',true,'diagram'],['python',false,'math'],['typescript',false,'diagram']]){
      const name=language+'-'+(block?'block-':'')+type;
      const initial=await request('open',{language,block,type});await settle();
      await request('source');await request('edit');ui=await frame();
      if(type==='math'){await ui.locator('.atom').first().fill('x+1');await ui.locator('.atom').first().press('Tab');}
      else {await ui.locator('[data-node="a"]').first().click();await ui.locator('#label').fill('Changed');await ui.locator('#label').press('Tab');}
      await ui.locator('#apply').click();await until(async()=>!(await snapshot()).sessions.length);let s=await settle();
      const b=s.blocks[0],e=entry(s),payload=b.identity.split('\n').slice(1,-1),content=payload.filter((l)=>!/^(?:\s*\*|\s*#|\s*\/\/)\s*$/.test(l));
      await check(name+': apply stores compact data and only the minimum necessary rows',b.bodyCount===Math.max(content.length,e.tiles)&&content.length<=3);
      await check(name+': source semantics and adjacent caret survive apply',(type==='math'?b.value.numerator.value==='x+1':b.value.nodes[0].text==='Changed')&&[b.start-1,b.end+1].includes(s.selections[0].active[0]));
      await pause(400);
      const slices=await page.locator('.view-lines .view-line span').evaluateAll((els)=>els.reduce((n,el)=>n+['::before','::after'].filter((p)=>{const st=getComputedStyle(el,p);return(st.content+st.backgroundImage).includes('data:image/svg+xml')&&el.getBoundingClientRect().height>0;}).length,0));
      await check(name+': every image slice is visibly rendered',slices===e.tiles);
      cases.push({name,applied:s});await capture('compact-'+name);
      await request('undo');await pause(250);s=await snapshot();await check(name+': a single undo restores the original whole block',s.source===initial.source);
    }
    const matrix={kind:'matrix',cells:[[1,3],[4,7]].map((r)=>r.map((n)=>({kind:'token',value:String(n)})))};
    const old=await request('open',{language:'c',type:'math',legacy:true,value:matrix});await settle();const original=old.source;
    await request('compact');let s=await settle();
    await check('explicit compact shrinks the legacy matrix while preserving its identity and editable cells',s.blocks[0].bodyCount<=6&&s.blocks[0].id==='target'&&JSON.stringify(s.blocks[0].value)===JSON.stringify(matrix)&&s.lineCount<old.lineCount-20);
    const compact=s.source;cases.push({name:'matrix',before:old,after:s});await capture('compact-matrix');
    await request('compact');s=await settle();await check('repeated compact is byte-stable',s.source===compact);
    await request('undo');await pause(300);await check('one undo of explicit compact restores the exact old source',(await snapshot()).source===original);
    await request('redo');await settle();
    for(const y of [0,400]){
      const value={version:1,title:'Flow',nodes:[{id:'a',kind:'box',x:20,y:0,width:120,height:40,text:'Input'},{id:'b',kind:'box',x:200,y,width:120,height:40,text:'Output'}],edges:[{id:'e',from:'a',to:'b'}]};
      await request('open',{language:'c',type:'diagram',block:true,value,minimumBodyLines:1});await request('compact');s=await settle();
      await check('graph y='+y+': compact data uses a few rows and reserves enough image height',s.blocks[0].bodyCount>=entry(s).tiles&&s.blocks[0].bodyCount<=Math.max(3,entry(s).tiles));
      cases.push({name:'graph-'+y,snapshot:s});await capture('compact-graph-'+y);
      if(y===400){
        const full=s.source,tiles=entry(s).tiles;await request('padding',{remove:true});await pause(500);s=await snapshot();
        await check('deleting one required padding row exposes source and reports exactly one missing row',!entry(s)&&s.blocks[0].bodyCount===tiles-1&&s.diagnostics.some((m)=>m.includes('还需 1 行')));
        const deleted=s.source;await pause(400);await check('ordinary preview never silently reinserts a deleted row',(await snapshot()).source===deleted);
        await capture('compact-insufficient');
        await request('padding');await request('move-out');s=await settle();await check('manually restoring one legal comment row restores the preview',s.source===full&&s.blocks[0].bodyCount===tiles);
        await request('padding',{remove:true});await pause(300);await request('compact');s=await settle();await check('explicit compact repairs missing space with minimal rows',s.source===full);
      }
    }
    await request('readonly',{value:true});const locked=(await snapshot()).source;await request('compact');await pause(300);await check('explicit compact respects editor read-only mode',(await snapshot()).source===locked);await request('readonly',{value:false});
    const tex=String.raw`\frac{x}{\sqrt{1+x^2}}`+'\n'+String.raw`+\sum_{k=1}^{n}k`;
    await request('open',{language:'python',type:'math',value:{kind:'raw',tex},minimumBodyLines:1});await request('compact');s=await settle();
    await check('compact keeps raw LaTeX including newlines exactly unchanged',s.blocks[0].value.tex===tex);cases.push({name:'raw-tex',snapshot:s});
    await request('source');await request('edit');ui=await frame();await ui.locator('#copy').click();
    const copied=await until(async()=>{const c=await request('copy-read');return c.blocks?.[0]?.value?.tex===tex&&c;});
    await check('copy exports a self-contained compact padded comment with a fresh block ID',copied.blocks[0].id!=='target'&&copied.blocks[0].bodyCount>=s.entries[0].tiles&&copied.blocks[0].bodyCount<=Math.max(3,s.entries[0].tiles));
    cases.push({name:'clipboard',copied});await request('cancel');
    await request('finish'); await browser.close(); await exited; await save(); console.log('Compact checks: ' + checks.length);
  } catch (e) {
    await page?.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {}); await save(); await request('finish').catch(() => {}); await browser?.close().catch(() => {}); throw e;
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
