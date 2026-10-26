const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000) { for (const end = Date.now() + ms; Date.now() < end;) { const v = await fn(); if (v) return v; await pause(80); } throw new Error('Language test timed out'); }
async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'asciiflow-menu-')); console.log('Menu evidence: ' + directory);
  const user = path.join(directory, 'user-data'), extensions = path.join(directory, 'extensions');
  await fs.mkdir(path.join(user, 'User'), { recursive: true }); await fs.mkdir(extensions);
  await fs.writeFile(path.join(user, 'User/settings.json'), JSON.stringify({ 'workbench.startupEditor': 'none', 'window.closeWhenEmpty': false, 'workbench.colorTheme': 'Dark Modern', 'editor.lineHeight': 0, 'editor.fontSize': 14, 'editor.minimap.enabled': false, 'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoUpdate': false, 'extensions.ignoreRecommendations': true }));
  const productArgs = process.env.COMMENT_STUDIO_VSIX ? [] : ['--extensionDevelopmentPath', __dirname, '--extensionTestsPath', path.join(__dirname, 'studio/menu-test-host.cjs')];
  if (process.env.COMMENT_STUDIO_VSIX) {
    if (!process.env.COMMENT_VSCE_BIN) throw new Error('COMMENT_VSCE_BIN is required for packaged-extension testing');
    execFileSync('/usr/bin/code', ['--user-data-dir', user, '--extensions-dir', extensions, '--install-extension', process.env.COMMENT_STUDIO_VSIX], { stdio: 'pipe' });
    const bridge = path.join(directory, 'bridge'); await fs.mkdir(bridge);
    await fs.writeFile(path.join(bridge, 'package.json'), JSON.stringify({ name: 'menu-test-bridge', publisher: 'local', version: '0.0.1', engines: { vscode: '^1.142.0' }, activationEvents: ['onStartupFinished'], main: 'index.cjs' }));
    await fs.writeFile(path.join(bridge, 'README.md'), '# Temporary language test bridge\nOnly used in an isolated test profile.\n');
    await fs.writeFile(path.join(bridge, 'index.cjs'), `exports.activate=()=>{require(${JSON.stringify(path.join(__dirname, 'studio/menu-test-host.cjs'))}).run().then(()=>require('vscode').commands.executeCommand('workbench.action.quit'),error=>{require('node:fs').writeFileSync(${JSON.stringify(path.join(directory, 'bridge-error.txt'))},String(error.stack));require('vscode').commands.executeCommand('workbench.action.quit');});};`);
    const bridgePackage = path.join(directory, 'bridge.vsix');
    execFileSync(process.execPath, [process.env.COMMENT_VSCE_BIN, 'package', '--skip-license', '--allow-missing-repository', '--out', bridgePackage], { cwd: bridge, stdio: 'pipe' });
    execFileSync('/usr/bin/code', ['--user-data-dir', user, '--extensions-dir', extensions, '--install-extension', bridgePackage], { stdio: 'pipe' });
  }
  const child = spawn('/usr/bin/code', ['--wait', '--new-window', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--user-data-dir', user, '--extensions-dir', extensions, ...productArgs, '--remote-debugging-port=9365', '--disable-gpu', '--no-sandbox'], { env: { ...process.env, COMMENT_PREVIEW_PROBE_DIR: directory }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = await fs.open(path.join(directory, 'code.log'), 'a'); child.stdout.on('data', (s) => { void log.write(s); }); child.stderr.on('data', (s) => { void log.write(s); });
  const exited = new Promise((r) => child.once('exit', (code) => { void log.close(); r(code); }));
  const checks = [], cases = [], errors = []; let browser, page, ui;
  async function read(file) { try { return JSON.parse(await fs.readFile(path.join(directory, file), 'utf8')); } catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; } }
  async function request(op, fields) {
    const id = Date.now() + '-' + Math.random(); await fs.writeFile(path.join(directory, 'request.tmp'), JSON.stringify({ id, op, fields })); await fs.rename(path.join(directory, 'request.tmp'), path.join(directory, 'request.json'));
    return until(async () => { const r = await read('response.json'); if (r?.id !== id) return; if (r.error) throw new Error(r.error); return r.result; });
  }
  const snapshot = () => request('snapshot');
  async function save() { await fs.writeFile(path.join(directory, 'menu-measurements.json'), JSON.stringify({ at: new Date().toISOString(), package: process.env.COMMENT_STUDIO_VSIX && path.basename(process.env.COMMENT_STUDIO_VSIX), checks, cases, errors }, null, 2)); }
  async function check(name, ok) { checks.push({ name, passed: !!ok }); await save(); assert.ok(ok, name); console.log('PASS ' + name); }
  async function frame() { return until(async () => { for (const f of page.frames()) try { if (await f.locator('#apply').count()) return f; } catch {} }); }
  async function capture(name) { await pause(150); await page.screenshot({ path: path.join(directory, name + '.png') }); }
  try {
    await until(() => read('ready.json'), 60000);
    browser = await chromium.connectOverCDP('http://127.0.0.1:9365'); page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes('workbench'));
    await page.setViewportSize({ width: 1280, height: 1000 }); page.on('pageerror', (e) => errors.push(e.message));


    async function openMenu(marker) {
      await request('position', { marker }); await pause(250);
      const line = page.locator('.view-lines .view-line').filter({ hasText: marker }).first();
      await line.click({ button: 'right', position: { x: 100, y: 8 } });
      const parent = page.getByRole('menuitem', { name: 'CommentInk', exact: true }); await parent.waitFor();
      await parent.hover();
      await page.getByRole('menuitem', { name: '插入公式', exact: true }).waitFor(); await pause(300);
    }
    async function menuClick(title) { const item = page.getByRole('menuitem', { name: title, exact: true }); await item.hover(); await pause(150); await item.click(); await until(async () => !(await item.count())); await pause(150); }
    let original = await request('open'); await openMenu('MENU FORMULA');
    await check('CommentInk submenu is available without searching a command', await page.getByRole('menuitem', {name:'CommentInk',exact:true}).count() === 1);
    await check('one submenu exposes the six common operations', (await page.getByRole('menuitem').allTextContents()).filter((s) => ['插入公式','绘制图表','编辑光标处的公式或图表','压缩源码并补足预览空间','显示当前文件原位预览','查看当前窗口源码'].includes(s.trim())).length === 6);
    await capture('menu-five-actions');
    await menuClick('插入公式'); ui = await frame();
    let state = await snapshot();
    await check('right-click formula action targets the clicked C document and line', state.sessions[0]?.type === 'math' && state.sessions[0]?.uri === original.uri && state.sessions[0]?.anchor === 0);
    await check('extension and editor branding use CommentInk', state.displayName === 'CommentInk' && await ui.locator('header strong').first().textContent() === 'CommentInk');
    await ui.locator('.atom').first().fill('x'); await ui.locator('.atom').nth(1).fill('y'); await ui.locator('.atom').nth(1).press('Tab'); await ui.locator('#apply').click();
    state = await until(async () => { const s = await snapshot(); return !s.sessions.length && s.blocks.length === 1 && s; });
    await check('formula from the context menu applies valid native C comments', state.blocks[0].value.numerator.value === 'x' && state.source.endsWith(original.source));
    await openMenu('MENU DIAGRAM'); const expectedAnchor = (await snapshot()).source.indexOf('// MENU DIAGRAM');
    await menuClick('绘制图表'); ui = await frame(); state = await snapshot();
    await check('right-click diagram action targets the new clicked line', state.sessions[0]?.type === 'diagram' && state.sessions[0]?.anchor === expectedAnchor);
    await ui.locator('[data-tool="box"]').click();
    const points = await ui.locator('#canvas').evaluate((el) => [new DOMPoint(40,40),new DOMPoint(180,110)].map((p) => { const q=p.matrixTransform(el.getScreenCTM());return {x:q.x,y:q.y}; }));
    const body = await ui.locator('body').boundingBox();
    await page.mouse.move(body.x+points[0].x,body.y+points[0].y);await page.mouse.down();await page.mouse.move(body.x+points[1].x,body.y+points[1].y,{steps:8});await page.mouse.up();await ui.locator('#apply').click();
    state=await until(async()=>{const s=await snapshot();return !s.sessions.length && s.blocks.length===2 && s;});
    await check('diagram from the context menu applies and leaves the formula intact', state.blocks[1].type === 'diagram' && state.blocks[1].value.nodes.length === 1 && state.blocks[0].value.numerator.value === 'x');
    const saved = state.source;
    await openMenu('MENU AFTER'); await menuClick('查看当前窗口源码');
    const revealed = await until(async () => {const s = await snapshot(); return !s.entries.length && s;}); cases.push({name:'source action',snapshot:revealed}); await check('context-menu source action reveals source without modifying it', revealed.source === saved);
    await openMenu('MENU AFTER'); await menuClick('显示当前文件原位预览'); await pause(400);
    await check('context-menu preview action accepts the native Uri and restores both objects', (await snapshot()).entries.length === 2 && (await snapshot()).source === saved);
    await openMenu('MENU AFTER'); await menuClick('查看当前窗口源码');
    await request('position', { block: 0 }); await pause(250);
    await page.locator('.view-lines .view-line').filter({ hasText: '@math begin' }).first().click({button:'right',position:{x:100,y:8}});
    await page.getByRole('menuitem', {name:'CommentInk',exact:true}).hover();await menuClick('编辑光标处的公式或图表');ui=await frame();
    await check('context-menu edit restores the existing formula instead of creating a new one', (await snapshot()).sessions[0]?.value.numerator.value === 'x');
    await request('cancel');await request('position',{marker:'MENU AFTER'});await request('readonly',{value:true});await openMenu('MENU AFTER');
    for(const title of ['插入公式','绘制图表','编辑光标处的公式或图表','压缩源码并补足预览空间']) await check('read-only context disables '+title, await page.getByRole('menuitem',{name:title,exact:true}).getAttribute('aria-disabled') === 'true');
    await capture('menu-readonly');await page.keyboard.press('Escape');await page.keyboard.press('Escape');await request('readonly',{value:false});
    cases.push({name:'C menu round-trip',snapshot:await snapshot()});
    for(const language of ['python','typescript','html']){
      const marker='MENU LANGUAGE';await request('open',{language,source:(language==='python'?'# ':language==='html'?'<!-- ':'// ')+marker+(language==='html'?' -->':'')+'\n'});await openMenu(marker);
      await check(language+': context submenu is available',await page.getByRole('menuitem',{name:'CommentInk',exact:true}).count()===1);
      await page.keyboard.press('Escape');await page.keyboard.press('Escape');
    }
    for(const language of ['json','plaintext']){
      await request('open',{language,source:'MENU UNSUPPORTED\n'});await pause(250);await page.locator('.view-lines .view-line').filter({hasText:'MENU UNSUPPORTED'}).first().click({button:'right',position:{x:100,y:8}});await pause(200);
      await check(language+': unsupported language does not show an unusable submenu',!(await page.getByRole('menuitem',{name:'CommentInk',exact:true}).count()));await page.keyboard.press('Escape');
    }
    await request('finish');await browser.close();await exited;await save();console.log('Menu checks: '+checks.length);
  } catch(e) {await page?.screenshot({path:path.join(directory,'failure.png')}).catch(()=>{});await save();await request('finish').catch(()=>{});await browser?.close().catch(()=>{});throw e;}
}
main().catch((e)=>{console.error(e);process.exitCode=1;});
