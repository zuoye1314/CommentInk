const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000) { for (const end = Date.now() + ms; Date.now() < end;) { const v = await fn(); if (v) return v; await pause(80); } throw new Error('Language test timed out'); }
async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'asciiflow-live-')); console.log('Live evidence: ' + directory);
  const user = path.join(directory, 'user-data'), extensions = path.join(directory, 'extensions');
  await fs.mkdir(path.join(user, 'User'), { recursive: true }); await fs.mkdir(extensions);
  await fs.writeFile(path.join(user, 'User/settings.json'), JSON.stringify({ 'workbench.startupEditor': 'none', 'window.closeWhenEmpty': false, 'workbench.colorTheme': 'Dark Modern', 'editor.lineHeight': 0, 'editor.fontSize': 14, 'editor.minimap.enabled': false, 'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoUpdate': false, 'extensions.ignoreRecommendations': true }));
  const productArgs = process.env.COMMENT_STUDIO_VSIX ? [] : ['--extensionDevelopmentPath', __dirname, '--extensionTestsPath', path.join(__dirname, 'studio/live-test-host.cjs')];
  if (process.env.COMMENT_STUDIO_VSIX) {
    if (!process.env.COMMENT_VSCE_BIN) throw new Error('COMMENT_VSCE_BIN is required for packaged-extension testing');
    execFileSync('/usr/bin/code', ['--user-data-dir', user, '--extensions-dir', extensions, '--install-extension', process.env.COMMENT_STUDIO_VSIX], { stdio: 'pipe' });
    const bridge = path.join(directory, 'bridge'); await fs.mkdir(bridge);
    await fs.writeFile(path.join(bridge, 'package.json'), JSON.stringify({ name: 'live-test-bridge', publisher: 'local', version: '0.0.1', engines: { vscode: '^1.142.0' }, activationEvents: ['onStartupFinished'], main: 'index.cjs' }));
    await fs.writeFile(path.join(bridge, 'README.md'), '# Temporary language test bridge\nOnly used in an isolated test profile.\n');
    await fs.writeFile(path.join(bridge, 'index.cjs'), `exports.activate=()=>{require(${JSON.stringify(path.join(__dirname, 'studio/live-test-host.cjs'))}).run().then(()=>require('vscode').commands.executeCommand('workbench.action.quit'),error=>{require('node:fs').writeFileSync(${JSON.stringify(path.join(directory, 'bridge-error.txt'))},String(error.stack));require('vscode').commands.executeCommand('workbench.action.quit');});};`);
    const bridgePackage = path.join(directory, 'bridge.vsix');
    execFileSync(process.execPath, [process.env.COMMENT_VSCE_BIN, 'package', '--skip-license', '--allow-missing-repository', '--out', bridgePackage], { cwd: bridge, stdio: 'pipe' });
    execFileSync('/usr/bin/code', ['--user-data-dir', user, '--extensions-dir', extensions, '--install-extension', bridgePackage], { stdio: 'pipe' });
  }
  const child = spawn('/usr/bin/code', ['--wait', '--new-window', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--user-data-dir', user, '--extensions-dir', extensions, ...productArgs, '--remote-debugging-port=9366', '--disable-gpu', '--no-sandbox'], { env: { ...process.env, COMMENT_PREVIEW_PROBE_DIR: directory }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = await fs.open(path.join(directory, 'code.log'), 'a'); child.stdout.on('data', (s) => { void log.write(s); }); child.stderr.on('data', (s) => { void log.write(s); });
  const exited = new Promise((r) => child.once('exit', (code) => { void log.close(); r(code); }));
  const checks = [], cases = [], errors = []; let browser, page, ui;
  async function read(file) { try { return JSON.parse(await fs.readFile(path.join(directory, file), 'utf8')); } catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; } }
  async function request(op, fields) {
    const id = Date.now() + '-' + Math.random(); await fs.writeFile(path.join(directory, 'request.tmp'), JSON.stringify({ id, op, fields })); await fs.rename(path.join(directory, 'request.tmp'), path.join(directory, 'request.json'));
    return until(async () => { const r = await read('response.json'); if (r?.id !== id) return; if (r.error) throw new Error(r.error); return r.result; });
  }
  const snapshot = () => request('snapshot');
  async function save() { await fs.writeFile(path.join(directory, 'live-measurements.json'), JSON.stringify({ at: new Date().toISOString(), package: process.env.COMMENT_STUDIO_VSIX && path.basename(process.env.COMMENT_STUDIO_VSIX), checks, cases, errors }, null, 2)); }
  async function check(name, ok) { checks.push({ name, passed: !!ok }); await save(); assert.ok(ok, name); console.log('PASS ' + name); }
  async function frame() { return until(async () => { for (const f of page.frames()) try { if (await f.locator('#apply').count()) return f; } catch {} }); }
  async function capture(name) { await request('dismiss'); await pause(150); await page.screenshot({ path: path.join(directory, name + '.png') }); }
  try {
    await until(() => read('ready.json'), 60000);
    browser = await chromium.connectOverCDP('http://127.0.0.1:9366'); page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes('workbench'));
    await page.setViewportSize({ width: 1280, height: 1000 }); page.on('pageerror', (e) => errors.push(e.message));


    const ordinary=await request('quiet-language');
    await check('ordinary C editing without preview does not create plugin diagnostics',ordinary.diagnostics.length===0&&ordinary.source.startsWith('// ordinary code'));
    const entry=(s,id='target',column=1)=>s.views.find((v)=>v.column===column)?.entries.find((e)=>e.id===id);
    const waitEntry=(present,id='target',column=1)=>until(async()=>{const s=await snapshot();return !!entry(s,id,column)===present && s;});
    async function clickDecoration(text){
      const point=await page.locator('.view-lines .view-line span').evaluateAll((els,text)=>{const e=els.find((e)=>getComputedStyle(e,'::before').content.includes(text)&&e.getBoundingClientRect().height>0);if(e){const r=e.getBoundingClientRect();return{x:r.x+30,y:r.y+r.height/2};}},text);
      if(!point)throw new Error('Decoration not visible: '+text);await page.mouse.click(point.x,point.y);
    }
    async function actualSlices(){return page.locator('.view-lines .view-line span').evaluateAll((els)=>els.reduce((n,e)=>n+['::before','::after'].filter((p)=>{const s=getComputedStyle(e,p);return(s.content+s.backgroundImage).includes('data:image/svg+xml')&&e.getBoundingClientRect().height>0;}).length,0));}
    for(const [language,type,block,raw] of [['c','math',false,true],['c','diagram',true,false],['python','math',false,false],['typescript','diagram',false,false]]){
      const name=language+'-'+(block?'block-':'')+type, initial=await request('open',{language,type,block,raw});await pause(500);
      const lenses=await request('code-lenses');
      const labels=await page.locator('.view-lines span').evaluateAll((els)=>els.flatMap((e)=>['::before','::after'].map((p)=>getComputedStyle(e,p).content)));
      await check(name+': no inline edit, preview or source controls remain',!lenses.some((c)=>['commentStudio.edit','commentStudio.show'].includes(c?.command))&&!labels.some((label)=>/查看源码|原位预览|编辑公式|编辑图表/.test(label))&&!(await page.locator('.codelens-decoration a').filter({hasText:/编辑公式|编辑图表|原位预览/}).count()));
      await capture('live-'+name+'-clean-preview');
      await clickDecoration(type==='math'?'公式':'图表');let s=await waitEntry(false);
      await check(name+': clicking the object title reveals only the selected object',!!entry(s,'sibling')&&s.source===initial.source);
      await capture('live-'+name+'-editing');
      // A real mouse click into ordinary comments, not a preview command.
      const line=page.locator('.view-lines .view-line').filter({hasText:'ABOVE 2'}).first();await line.click({position:{x:80,y:8}});
      s=await waitEntry(true);const clicked=s.selection;await pause(400);s=await snapshot();
      await check(name+': clicking elsewhere automatically restores preview without moving the caret',s.selection[0]===2&&JSON.stringify(s.selection)===JSON.stringify(clicked)&&s.source===initial.source);
      await check(name+': restored images have all SVG slices visible',await actualSlices()===s.views[0].entries.reduce((n,e)=>n+e.tiles,0));
      const imagePoint=await page.locator('.view-lines .view-line span').evaluateAll((els)=>{const e=els.find((e)=>{const c=getComputedStyle(e,'::before');return(c.content+c.backgroundImage).includes('data:image/svg+xml')&&e.getBoundingClientRect().height>0;});if(e){const r=e.getBoundingClientRect();return{x:r.x+30,y:r.y+r.height/2};}});
      await page.mouse.click(imagePoint.x,imagePoint.y);s=await waitEntry(false);
      await check(name+': clicking the image itself enters visible source',s.modes[0].editing.includes('target')&&!!entry(s,'sibling'));
      await request('move',{where:'above'});await waitEntry(true);
      // Native keyboard navigation enters a hidden block from the preceding line.
      const b=s.blocks.find((b)=>b.id==='target');await request('move',{line:b.start-1});await page.keyboard.press('ArrowDown');s=await waitEntry(false);
      await check(name+': native arrow-key entry shows editable source',s.selection[0]===b.start&&!!entry(s,'sibling'));
      await request('move',{where:'above'});await waitEntry(true);
      const selections=[[2,1,2,1],[b.bodyStart,0,b.bodyStart,0]];await request('select',{selections});s=await waitEntry(false);
      await check(name+': one cursor remaining inside keeps the source visible',s.modes[0].editing.includes('target')&&!!entry(s,'sibling'));
      const outside=[[2,1,2,1],[b.end+1,1,b.end+1,1]];await request('select',{selections:outside});s=await waitEntry(true);
      await check(name+': leaving with every cursor restores preview and preserves both cursors',JSON.stringify(s.selections)===JSON.stringify(outside)&&s.modes[0].editing.length===0);
      await request('select',{selections:[[b.start-1,0,b.end+1,0]]});await waitEntry(false);await request('move',{where:'above'});await waitEntry(true);
      await check(name+': a selection spanning the block stays editable until the range leaves',!!entry(await snapshot()));
      await request('move');await waitEntry(false);
      const change=type==='diagram'?{from:'"text":"Input"',to:'"text":"Changed"'}:raw?{from:'// x\n',to:'// x+1\n'}:{from:'"value":"x"',to:'"value":"x+1"'};
      if(raw){await request('move',{line:b.bodyStart+1,character:4});await page.keyboard.type('+1');}
      else await request('replace',change);await pause(250);s=await snapshot();
      await check(name+': typing inside source keeps the latest content editable',!entry(s)&&s.source===initial.source.replace(change.from,change.to));
      await request('move',{where:'above'});s=await waitEntry(true);cases.push({name,path:'edited-and-left',snapshot:s});
      await check(name+': leaving renders the changed formula or diagram',s.blocks.find((b)=>b.id==='target').identity.includes(change.to.trim())&&entry(s).fingerprint===s.blocks.find((b)=>b.id==='target').fingerprint);
      await capture('live-'+name+'-updated');
      await request('undo');await pause(250);await request('move',{where:'above'});s=await waitEntry(true);
      await check(name+': native undo restores original content and automatic preview',s.source===initial.source&&entry(s).fingerprint===s.blocks.find((b)=>b.id==='target').fingerprint);
      await request('pin');await request('move');await request('move',{where:'above'});await pause(400);s=await snapshot();
      await check(name+': explicit whole-window source mode remains under user control',!s.views[0].entries.length&&s.modes[0].pinned.includes('target'));
      await request('preview');await waitEntry(true);
      await request('readonly',{value:true});const saved=(await snapshot()).source;await request('move');await waitEntry(false);await request('move',{where:'above'});s=await waitEntry(true);
      await check(name+': automatic switching works read-only without editing source',s.source===saved);await request('readonly',{value:false});
    }
    // Recoverable invalid JSON and renderer errors must not hide the source.
    await request('open',{language:'c',type:'diagram',block:true});await request('move');await waitEntry(false);
    const invalid={from:'"text":"Input"',to:'"text":Input'};await request('replace',invalid);await request('move',{where:'above'});await pause(500);let s=await snapshot();
    await check('invalid diagram data remains source with a diagnostic and its sibling stays visible',!entry(s)&&!!entry(s,'sibling')&&s.diagnostics.length>0&&s.source.includes(invalid.to));
    await request('replace',{from:invalid.to,to:invalid.from});s=await waitEntry(true);await check('repairing invalid source automatically recovers the diagram',!!entry(s)&&s.diagnostics.length===0);
    await request('open',{language:'c',type:'math',raw:true});await request('move');await waitEntry(false);await request('replace',{from:'// x\n',to:'// \\invalidcommand\n'});await request('move',{where:'above'});await pause(600);s=await snapshot();
    await check('invalid TeX leaves source visible and publishes a visible diagnostic',!entry(s)&&!!entry(s,'sibling')&&s.diagnostics.length>0);cases.push({name:'invalid-tex',snapshot:s});await capture('live-invalid-tex');
    await request('replace',{from:'// \\invalidcommand\n',to:'// x\n'});await waitEntry(true);
    await check('corrected TeX restores preview without another command',(await snapshot()).diagnostics.length===0);
    await request('move');await waitEntry(false);await request('pin');await request('move',{where:'above'});await pause(400);s=await snapshot();
    await check('explicit source mode also pins a block that was already being edited',!s.views[0].entries.length&&s.modes[0].pinned.includes('target'));
    await request('preview');await waitEntry(true);
    const full='// \\frac{\n// x\n// }{\n// y\n// }',short='// \\frac{x}{y}';
    await request('move');await waitEntry(false);await request('replace',{from:full,to:short});const compact=(await snapshot()).source;await request('move',{where:'above'});await pause(600);s=await snapshot();
    await check('insufficient source height stays visible with a diagnostic and no inserted padding',!entry(s)&&!!entry(s,'sibling')&&s.source===compact&&s.diagnostics.some((m)=>m.includes('源码空间不足')));
    await request('replace',{from:short,to:full});s=await waitEntry(true);await check('restoring enough actual source lines recovers preview automatically',s.diagnostics.length===0);
    // Rapid re-entry while a renderer is yielding cannot apply stale decorations.
    await request('delay',{value:true});await request('rapid');await pause(900);s=await snapshot();
    await check('a delayed render cannot hide the source after rapid re-entry',!entry(s)&&s.selection[0]===s.blocks.find((b)=>b.id==='target').bodyStart);
    await request('move',{where:'above'});s=await waitEntry(true);await check('rapid switching settles to the final outside position',s.selection[0]===2);await request('delay',{value:false});
    // Same document, separate editor groups keep separate selection modes.
    await request('split');await waitEntry(true,'target',2);await request('move',{column:1});s=await waitEntry(false,'target',1);
    await check('editing in one group leaves the same object rendered in another',!!entry(s,'target',2)&&!entry(s,'target',1));
    await request('focus',{column:2});await request('focus',{column:1});await pause(300);s=await snapshot();
    await check('switching editor focus keeps the original source cursor editable',!entry(s,'target',1)&&!!entry(s,'target',2));
    await request('move',{column:1,where:'above'});s=await waitEntry(true,'target',1);await check('leaving source restores both independent editor previews',!!entry(s,'target',2));
    cases.push({name:'two-editor-groups',snapshot:s});await capture('live-two-groups');
    await request('finish');await browser.close();await exited;await save();console.log('Live checks: '+checks.length);
  }catch(e){await page?.screenshot({path:path.join(directory,'failure.png')}).catch(()=>{});await save();await request('finish').catch(()=>{});await browser?.close().catch(()=>{});throw e;}
}
main().catch((e)=>{console.error(e);process.exitCode=1;});
