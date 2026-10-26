const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000) { for (const end = Date.now() + ms; Date.now() < end;) { const v = await fn(); if (v) return v; await pause(80); } throw new Error('Language test timed out'); }
async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'asciiflow-guide-')); console.log('Guide evidence: ' + directory);
  const user = path.join(directory, 'user-data'), extensions = path.join(directory, 'extensions');
  await fs.mkdir(path.join(user, 'User'), { recursive: true }); await fs.mkdir(extensions);
  await fs.writeFile(path.join(user, 'User/settings.json'), JSON.stringify({ 'workbench.startupEditor': 'none','workbench.secondarySideBar.defaultVisibility':'hidden', 'window.closeWhenEmpty': false, 'workbench.colorTheme': 'Dark Modern', 'editor.lineHeight': 0, 'editor.fontSize': 16, 'editor.minimap.enabled': false, 'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoUpdate': false, 'extensions.ignoreRecommendations': true }));
  const productArgs = process.env.COMMENT_STUDIO_VSIX ? [] : ['--extensionDevelopmentPath', __dirname, '--extensionTestsPath', path.join(__dirname, 'studio/guide-test-host.cjs')];
  if (process.env.COMMENT_STUDIO_VSIX) {
    if (!process.env.COMMENT_VSCE_BIN) throw new Error('COMMENT_VSCE_BIN is required for packaged-extension testing');
    execFileSync('/usr/bin/code', ['--user-data-dir', user, '--extensions-dir', extensions, '--install-extension', process.env.COMMENT_STUDIO_VSIX], { stdio: 'pipe' });
    const bridge = path.join(directory, 'bridge'); await fs.mkdir(bridge);
    await fs.writeFile(path.join(bridge, 'package.json'), JSON.stringify({ name: 'guide-test-bridge', publisher: 'local', version: '0.0.1', engines: { vscode: '^1.142.0' }, activationEvents: ['onStartupFinished'], main: 'index.cjs' }));
    await fs.writeFile(path.join(bridge, 'README.md'), '# Temporary language test bridge\nOnly used in an isolated test profile.\n');
    await fs.writeFile(path.join(bridge, 'index.cjs'), `exports.activate=()=>{require(${JSON.stringify(path.join(__dirname, 'studio/guide-test-host.cjs'))}).run().then(()=>require('vscode').commands.executeCommand('workbench.action.quit'),error=>{require('node:fs').writeFileSync(${JSON.stringify(path.join(directory, 'bridge-error.txt'))},String(error.stack));require('vscode').commands.executeCommand('workbench.action.quit');});};`);
    const bridgePackage = path.join(directory, 'bridge.vsix');
    execFileSync(process.execPath, [process.env.COMMENT_VSCE_BIN, 'package', '--skip-license', '--allow-missing-repository', '--out', bridgePackage], { cwd: bridge, stdio: 'pipe' });
    execFileSync('/usr/bin/code', ['--user-data-dir', user, '--extensions-dir', extensions, '--install-extension', bridgePackage], { stdio: 'pipe' });
  }
  const child = spawn('/usr/bin/code', ['--wait', '--new-window', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--user-data-dir', user, '--extensions-dir', extensions, ...productArgs, '--remote-debugging-port=9371', '--disable-gpu', '--no-sandbox'], { env: { ...process.env, COMMENT_PREVIEW_PROBE_DIR: directory }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = await fs.open(path.join(directory, 'code.log'), 'a'); child.stdout.on('data', (s) => { void log.write(s); }); child.stderr.on('data', (s) => { void log.write(s); });
  const exited = new Promise((r) => child.once('exit', (code) => { void log.close(); r(code); }));
  const checks = [], cases = [], errors = []; let browser, page, ui;
  async function read(file) { try { return JSON.parse(await fs.readFile(path.join(directory, file), 'utf8')); } catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; } }
  async function request(op, fields) {
    const id = Date.now() + '-' + Math.random(); await fs.writeFile(path.join(directory, 'request.tmp'), JSON.stringify({ id, op, fields })); await fs.rename(path.join(directory, 'request.tmp'), path.join(directory, 'request.json'));
    return until(async () => { const r = await read('response.json'); if (r?.id !== id) return; if (r.error) throw new Error(r.error); return r.result; });
  }
  const snapshot = () => request('snapshot');
  async function save() { await fs.writeFile(path.join(directory, 'guide-measurements.json'), JSON.stringify({ at: new Date().toISOString(), package: process.env.COMMENT_STUDIO_VSIX && path.basename(process.env.COMMENT_STUDIO_VSIX), checks, cases, errors }, null, 2)); }
  async function check(name, ok) { checks.push({ name, passed: !!ok }); await save(); assert.ok(ok, name); console.log('PASS ' + name); }
  async function frame() { return until(async () => { for (const f of page.frames()) try { if (await f.locator('#apply').count()) return f; } catch {} }); }
  async function capture(name) { await pause(150); await page.screenshot({ path: path.join(directory, name + '.png') }); }
  try {
    await until(() => read('ready.json'), 60000);
    browser = await chromium.connectOverCDP('http://127.0.0.1:9371'); page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes('workbench'));
    await page.setViewportSize({ width: 1440, height: 960 }); page.on('pageerror', (e) => errors.push(e.message));


    async function openMenu(marker) {
      await request('position', { marker }); await pause(250);
      const line = page.locator('.view-lines .view-line').filter({ hasText: marker }).first();
      await line.click({ button: 'right', position: { x: 100, y: 8 } });
      const parent = page.getByRole('menuitem', { name: 'CommentInk', exact: true }); await parent.waitFor();
      await parent.hover();
      await page.getByRole('menuitem', { name: '插入公式', exact: true }).waitFor(); await pause(300);
    }
    async function menuClick(title) { const item = page.getByRole('menuitem', { name: title, exact: true }); await item.hover(); await pause(150); await item.click(); await until(async () => !(await item.count())); await pause(150); }
    const waitEntries=(count=1)=>until(async()=>{const s=await snapshot();return s.entries.length===count&&s;});
    const applied=()=>until(async()=>{const s=await snapshot();return !s.sessions.length&&s.blocks.length&&s;});
    let original=await request('open',{name:'formula-demo',source:'// 公式示例：在下一行插入\n// INSERT FORMULA\n// 公式下方仍可写说明\nint square(int x) { return x * x; }\n'});
    await openMenu('INSERT FORMULA');await capture('01-context-menu');await menuClick('插入公式');ui=await frame();
    await ui.locator('.atom').first().fill('x');await ui.locator('.atom').nth(1).fill('y');await ui.locator('.atom').nth(1).focus();await ui.locator('[data-template="sqrt"]').click();await ui.locator('.atom').last().fill('y');await ui.locator('.atom').last().press('Tab');
    await until(()=>ui.locator('#math-preview').evaluate(e=>e.complete&&e.naturalWidth>0));await pause(300);await capture('02-formula-template');
    await check('new user can nest a root in a fraction with graphical templates',(await snapshot()).sessions[0].value.denominator.kind==='sqrt');
    await ui.locator('#apply').click();let state=await applied();await waitEntries();await capture('03-inline-formula');
    await check('applying creates inline math and preserves ordinary code',state.blocks[0].value.numerator.value==='x'&&state.source.endsWith('int square(int x) { return x * x; }\n'));
    await request('position',{block:0});await pause(350);await capture('04-editable-source');await check('entering the marker block reveals source',(await snapshot()).entries.length===0);
    await request('edit');ui=await frame();await ui.locator('#advanced').click();await ui.locator('#latex').fill(String.raw`F(x)=\frac{\displaystyle\int_0^x \frac{\sin t}{1+t^2}\,\mathrm{d}t}{\sqrt{\displaystyle\sum_{k=1}^{n}\frac{x_k^2}{k+1}+\varepsilon}}`);await ui.locator('#latex').press('Tab');
    await until(()=>ui.locator('#status').textContent().then(t=>t.includes('草稿已预览')));await capture('05-latex-editor');await ui.locator('#apply').click();state=await applied();await waitEntries();await request('save');await capture('06-complex-formula');
    await check('complex LaTeX is previewed, applied and saved',state.blocks[0].value.kind==='raw'&&state.blocks[0].tex.includes('\\int'));
    await request('open',{name:'matrix-demo',source:'// MATRIX\nint answer = 42;\n'});await request('command',{command:'commentStudio.newFormula'});ui=await frame();await ui.locator('[data-template="matrix"]').click();
    for(const [i,v]of ['1','3','4','7'].entries())await ui.locator('.atom').nth(i).fill(v);await ui.locator('.atom').last().press('Tab');await until(()=>ui.locator('#status').textContent().then(t=>t.includes('草稿已预览')));await capture('07-matrix-template');await check('matrix template exposes four editable cells',(await snapshot()).sessions[0].value.cells[1][1].value==='7');await request('cancel');
    await request('open',{name:'flow-demo',source:'// 图表示例：输入经过处理得到输出\n// INSERT DIAGRAM\n// 图表下方可继续解释实现细节\nint normalize(int x) { return x; }\n'});await openMenu('INSERT DIAGRAM');await menuClick('绘制图表');ui=await frame();
    async function point(x,y){const p=await ui.locator('#canvas').evaluate((el,p)=>{const q=new DOMPoint(p.x,p.y).matrixTransform(el.getScreenCTM());return {x:q.x,y:q.y};},{x,y});const box=await ui.locator('body').boundingBox();return {x:box.x+p.x,y:box.y+p.y};}
    async function click(x,y,key){const p=await point(x,y);if(key)await page.keyboard.down(key);await page.mouse.click(p.x,p.y);if(key)await page.keyboard.up(key);}
    async function drag(a,b,c,d,key){const p=await point(a,b),q=await point(c,d);if(key)await page.keyboard.down(key);await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(q.x,q.y,{steps:12});await page.mouse.up();if(key)await page.keyboard.up(key);await pause(180);}
    await ui.locator('[data-tool="box"]').click();await drag(40,80,170,150);await drag(260,80,390,150);
    await ui.locator('[data-tool="select"]').click();await click(70,110);await ui.locator('#label').fill('输入 x');await ui.locator('#label').press('Tab');await click(290,110);await ui.locator('#label').fill('输出 z');await ui.locator('#label').press('Tab');
    await ui.locator('[data-tool="edge"]').click();await click(70,110);await click(290,110);await ui.locator('[data-tool="select"]').click();await click(210,115);await ui.locator('#label').fill('处理');await ui.locator('#label').press('Tab');
    await ui.locator('#zoom-fit').click();await capture('08-canvas-overview');state=await snapshot();await check('drawing gestures create two labeled boxes and their connected arrow',state.sessions[0].value.nodes.length===2&&state.sessions[0].value.edges[0].label==='处理');
    await ui.locator('#zoom-reset').click();await drag(20,60,410,170);await capture('09-multiselect');await check('dragging empty canvas selects the two nodes and their internal edge',(await ui.locator('#canvas').getAttribute('data-selected')).split(',').length===3);
    await drag(70,110,90,130);await ui.locator('#undo').click();await check('one canvas undo restores a group move',(await snapshot()).sessions[0].value.nodes[0].x===40);
    await ui.locator('[data-tool="formula"]').click();await drag(80,260,320,380);await ui.locator('.atom').first().fill('x-μ');await ui.locator('.atom').nth(1).fill('σ');await ui.locator('.atom').nth(1).press('Tab');await ui.locator('#zoom-fit').click();await until(()=>ui.locator('#status').textContent().then(t=>t.includes('草稿已预览')));await capture('10-formula-in-diagram');await check('a diagram can include a graphical fraction',(await snapshot()).sessions[0].value.nodes.some(n=>n.formula?.denominator.value==='σ'));
    await ui.locator('#close-formula').click();await ui.locator('#zoom-reset').click();await ui.locator('[data-tool="free"]').click();await drag(50,440,370,440,'Alt');await ui.locator('[data-tool="select"]').click();const mid=await point(210,440);await page.mouse.dblclick(mid.x,mid.y);await pause(200);await drag(210,440,210,490);await ui.locator('#label').fill('自由线');await ui.locator('#label').press('Tab');await ui.locator('#zoom-fit').click();await capture('11-free-line');
    await check('a free line can keep unconnected endpoints and an editable bend',(await snapshot()).sessions[0].value.edges.at(-1).points.length===1);
    await ui.locator('#copy-language').selectOption('python');await ui.locator('#copy').click();state=await until(async()=>{const s=await snapshot();return s.copy&&s;});await capture('12-copy-comment');await check('cross-language copy emits a complete independent Python comment',state.copy.startsWith('# @diagram begin')&&state.copy.trimEnd().endsWith('# @diagram end'));
    await ui.locator('#apply').click();state=await applied();await waitEntries();await request('save');await capture('13-inline-diagram');await check('the graph is saved with its labels, formula and free edge',state.blocks[0].value.nodes.length===3&&state.blocks[0].value.edges.length===2);
    await request('command',{command:'commentStudio.source'});await pause(300);await capture('14-source-mode');await check('manual source mode exposes the complete graph source',(await snapshot()).entries.length===0);await request('command',{command:'commentStudio.show'});await waitEntries();await check('explicit preview returns to automatic switching',(await snapshot()).entries.length===1);
    await request('position',{block:0});await request('edit');ui=await frame();await ui.locator('#zoom-reset').click();await ui.locator('[data-tool="select"]').click();await drag(280,110,100,110);await until(()=>ui.locator('#collision-bar').isVisible());await capture('15-collision-warning');await ui.locator('#arrange').click();await pause(300);await capture('16-collision-arranged');await check('overlap warning provides an explicit repair action',await ui.locator('.node.collision').count()===0);await request('cancel');
    await request('open',{name:'diagnostic-demo',source:'/*\n *4324 @math begin v2 example\n * {"version":2,"formula":{"kind":"token","value":"x"}}\n *\n *\n *\n * @math end\n */\nint main(void){return 0;}\n'});await until(async()=>{const s=await snapshot();return s.diagnostics.some(m=>m.includes('非注释装饰'));});await page.keyboard.press('Control+Shift+m');await pause(300);await capture('17-marker-diagnostic');await check('bad prefixes produce visible repair guidance',(await snapshot()).diagnostics.some(m=>m.includes('4324')));await page.keyboard.press('Control+Shift+m');
    await request('command',{command:'commentStudio.help'});
    const help=await until(async()=>{for(const f of page.frames())try{if(await f.locator('h1').filter({hasText:'CommentInk 使用指南'}).count())return f;}catch{}});
    await until(()=>help.locator('img').evaluateAll(els=>els.length>=14&&els.every(e=>e.complete&&e.naturalWidth>0)));
    await check('bundled help opens from the product command and every local screenshot loads',await help.locator('img').count()>=14);
    await check('the user guide omits historical version entries',!(await help.locator('body').textContent()).match(/0\.0\.[0-9]/));
    await page.screenshot({path:path.join(directory,'18-offline-guide.png')});
    cases.push({name:'tutorial-complete',snapshot:await snapshot()});
    await request('finish');await browser.close();await exited;await save();console.log('Guide checks: '+checks.length);
  } catch(e) {await page?.screenshot({path:path.join(directory,'failure.png')}).catch(()=>{});await save();await request('finish').catch(()=>{});await browser?.close().catch(()=>{});throw e;}
}
main().catch((e)=>{console.error(e);process.exitCode=1;});
