const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000) { for (const end = Date.now() + ms; Date.now() < end;) { const v = await fn(); if (v) return v; await pause(80); } throw new Error('Language test timed out'); }
async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'asciiflow-guide-package-')); console.log('Guide evidence: ' + directory);
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
  const child = spawn('/usr/bin/code', ['--wait', '--new-window', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--user-data-dir', user, '--extensions-dir', extensions, ...productArgs, '--remote-debugging-port=9372', '--disable-gpu', '--no-sandbox'], { env: { ...process.env, COMMENT_PREVIEW_PROBE_DIR: directory }, stdio: ['ignore', 'pipe', 'pipe'] });
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
    browser = await chromium.connectOverCDP('http://127.0.0.1:9372'); page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes('workbench'));
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
    await check('actual installed package is 0.0.11',(await read('ready.json')).version==='0.0.11');
    await request('open',{name:'help-entry',source:'// GUIDE MENU\nint main(void){return 0;}\n'});await openMenu('GUIDE MENU');
    await check('right-click submenu offers the guide',await page.getByRole('menuitem',{name:'使用指南',exact:true}).isVisible());
    await page.context().setOffline(true);await menuClick('使用指南');
    const help=await until(async()=>{for(const f of page.frames())try{if(await f.locator('h1').filter({hasText:'CommentInk 使用指南'}).count())return f;}catch{}});
    const expected=14;await until(()=>help.locator('img').evaluateAll((els,n)=>els.length===n&&els.every(e=>e.complete&&e.naturalWidth>0),expected));
    const imgs=await help.locator('img').evaluateAll(els=>els.map(e=>({src:e.src,width:e.naturalWidth,height:e.naturalHeight,alt:e.alt})));
    await check('all screenshots load with browser networking disabled',imgs.length===expected&&imgs.every(i=>i.width>0&&i.height>0));
    await check('screenshots resolve from the installed extension rather than public image hosts',imgs.every(i=>i.src.includes('zuoye.comment-preview-probe-0.0.11')&&i.src.includes('/docs/screenshots/')));
    const text=await help.locator('body').textContent();
    await check('guide covers the main tasks and omits past release entries',['插入第一个公式','流程图','复制','三引号','常见问题','避让'].every(t=>text.includes(t))&&!text.match(/0\.0\.[0-9]/));
    await page.screenshot({path:path.join(directory,'installed-offline-guide.png')});cases.push({name:'offline-installed-guide',images:imgs});
    const scroll=await help.locator('h2').filter({hasText:'10. 常见问题'}).first();await scroll.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(directory,'installed-offline-faq.png')});
    await page.context().setOffline(false);
    await request('finish');await browser.close();await exited;await save();console.log('Guide checks: '+checks.length);
  } catch(e) {await page?.screenshot({path:path.join(directory,'failure.png')}).catch(()=>{});await save();await request('finish').catch(()=>{});await browser?.close().catch(()=>{});throw e;}
}
main().catch((e)=>{console.error(e);process.exitCode=1;});
