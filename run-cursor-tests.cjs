const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000) { for (const end = Date.now() + ms; Date.now() < end;) { const v = await fn(); if (v) return v; await pause(80); } throw new Error('Language test timed out'); }
async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'asciiflow-cursor-')); console.log('Cursor evidence: ' + directory);
  const user = path.join(directory, 'user-data'), extensions = path.join(directory, 'extensions');
  await fs.mkdir(path.join(user, 'User'), { recursive: true }); await fs.mkdir(extensions);
  await fs.writeFile(path.join(user, 'User/settings.json'), JSON.stringify({ 'workbench.startupEditor': 'none', 'window.closeWhenEmpty': false, 'workbench.colorTheme': 'Dark Modern', 'editor.lineHeight': 0, 'editor.fontSize': 14, 'editor.minimap.enabled': false, 'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoUpdate': false, 'extensions.ignoreRecommendations': true }));
  const productArgs = process.env.COMMENT_STUDIO_VSIX ? [] : ['--extensionDevelopmentPath', __dirname, '--extensionTestsPath', path.join(__dirname, 'studio/cursor-test-host.cjs')];
  if (process.env.COMMENT_STUDIO_VSIX) {
    if (!process.env.COMMENT_VSCE_BIN) throw new Error('COMMENT_VSCE_BIN is required for packaged-extension testing');
    execFileSync('/usr/bin/code', ['--user-data-dir', user, '--extensions-dir', extensions, '--install-extension', process.env.COMMENT_STUDIO_VSIX], { stdio: 'pipe' });
    const bridge = path.join(directory, 'bridge'); await fs.mkdir(bridge);
    await fs.writeFile(path.join(bridge, 'package.json'), JSON.stringify({ name: 'cursor-test-bridge', publisher: 'local', version: '0.0.1', engines: { vscode: '^1.142.0' }, activationEvents: ['onStartupFinished'], main: 'index.cjs' }));
    await fs.writeFile(path.join(bridge, 'README.md'), '# Temporary language test bridge\nOnly used in an isolated test profile.\n');
    await fs.writeFile(path.join(bridge, 'index.cjs'), `exports.activate=()=>{require(${JSON.stringify(path.join(__dirname, 'studio/cursor-test-host.cjs'))}).run().then(()=>require('vscode').commands.executeCommand('workbench.action.quit'),error=>{require('node:fs').writeFileSync(${JSON.stringify(path.join(directory, 'bridge-error.txt'))},String(error.stack));require('vscode').commands.executeCommand('workbench.action.quit');});};`);
    const bridgePackage = path.join(directory, 'bridge.vsix');
    execFileSync(process.execPath, [process.env.COMMENT_VSCE_BIN, 'package', '--skip-license', '--allow-missing-repository', '--out', bridgePackage], { cwd: bridge, stdio: 'pipe' });
    execFileSync('/usr/bin/code', ['--user-data-dir', user, '--extensions-dir', extensions, '--install-extension', bridgePackage], { stdio: 'pipe' });
  }
  const child = spawn('/usr/bin/code', ['--wait', '--new-window', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--user-data-dir', user, '--extensions-dir', extensions, ...productArgs, '--remote-debugging-port=9364', '--disable-gpu', '--no-sandbox'], { env: { ...process.env, COMMENT_PREVIEW_PROBE_DIR: directory }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = await fs.open(path.join(directory, 'code.log'), 'a'); child.stdout.on('data', (s) => { void log.write(s); }); child.stderr.on('data', (s) => { void log.write(s); });
  const exited = new Promise((r) => child.once('exit', (code) => { void log.close(); r(code); }));
  const checks = [], cases = [], errors = []; let browser, page, ui;
  async function read(file) { try { return JSON.parse(await fs.readFile(path.join(directory, file), 'utf8')); } catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; } }
  async function request(op, fields) {
    const id = Date.now() + '-' + Math.random(); await fs.writeFile(path.join(directory, 'request.tmp'), JSON.stringify({ id, op, fields })); await fs.rename(path.join(directory, 'request.tmp'), path.join(directory, 'request.json'));
    return until(async () => { const r = await read('response.json'); if (r?.id !== id) return; if (r.error) throw new Error(r.error); return r.result; });
  }
  const snapshot = () => request('snapshot');
  async function save() { await fs.writeFile(path.join(directory, 'cursor-measurements.json'), JSON.stringify({ at: new Date().toISOString(), package: process.env.COMMENT_STUDIO_VSIX && path.basename(process.env.COMMENT_STUDIO_VSIX), checks, cases, errors }, null, 2)); }
  async function check(name, ok) { checks.push({ name, passed: !!ok }); await save(); assert.ok(ok, name); console.log('PASS ' + name); }
  async function frame() { return until(async () => { for (const f of page.frames()) try { if (await f.locator('#apply').count()) return f; } catch {} }); }
  async function capture(name) { await request('dismiss'); await pause(150); await page.screenshot({ path: path.join(directory, name + '.png') }); }
  try {
    await until(() => read('ready.json'), 60000);
    browser = await chromium.connectOverCDP('http://127.0.0.1:9364'); page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes('workbench'));
    await page.setViewportSize({ width: 1280, height: 1000 }); page.on('pageerror', (e) => errors.push(e.message));

    const baseline = !!process.env.COMMENT_CURSOR_BASELINE;
    for (const [language, block, type] of [['c', false, 'math'], ['c', true, 'diagram'], ['python', false, 'math'], ['typescript', false, 'diagram']]) {
      const name = language + '-' + (block ? 'block-' : '') + type;
      const initial = await request('open', { language, block, type }); await pause(500);
      // Click the actual inline SVG; redundant source and CodeLens controls were removed.
      const label = await page.locator('.view-lines .view-line span').evaluateAll((elements) => {
        const e = elements.find((e) => { const style=getComputedStyle(e, '::before');return (style.content+style.backgroundImage).includes('data:image/svg+xml') && e.getBoundingClientRect().height > 0; });
        if (e) { const r = e.getBoundingClientRect(); return { x: r.x + 25, y: r.y + r.height / 2 }; }
      });
      if (!label) throw new Error(name + ': source decoration is not visible');
      await page.mouse.click(label.x, label.y);
      await until(async () => !(await snapshot()).entries.length);
      const source = await snapshot();
      await request('show'); await pause(600);
      const preview = await snapshot(), b = preview.blocks[0], cursor = preview.selections[0].active[0];
      cases.push({ name, path: 'image-click-preview-command', source, preview }); await save();
      if (baseline) await check(name + ': baseline reproduces jump to last line after preview click', cursor === preview.lineCount - 1);
      else {
        await check(name + ': preview returns caret to an adjacent line', cursor === b.start - 1 || cursor === b.end + 1);
        await check(name + ': preview preserves source and shows target on screen', preview.source === initial.source && preview.entries.length === 1 && preview.visibleRanges.some(([a,z]) => a <= b.start && z >= b.start));
      }
      // Open from the real source location, modify through the actual Webview.
      await request('source'); await request('edit'); ui = await frame();
      if (type === 'math') { await ui.locator('.atom').first().fill('x+1'); await ui.locator('.atom').first().press('Tab'); }
      else { await ui.locator('[data-node="a"]').first().click(); await ui.locator('#label').fill('Updated'); await ui.locator('#label').press('Tab'); }
      await ui.locator('#apply').click();
      await until(async () => !(await snapshot()).sessions.length); await pause(700);
      const applied = await snapshot(), updated = applied.blocks[0]; cases.push({ name, path: 'edit-apply', applied }); await save();
      const line = applied.selections[0].active[0];
      if (baseline) await check(name + ': baseline reproduces jump to last line after apply', line === applied.lineCount - 1);
      else {
        await check(name + ': applying an edit keeps the caret adjacent to its block', line === updated.start - 1 || line === updated.end + 1);
        await check(name + ': applied content and inline image are present near the viewport', (type === 'math' ? updated.value.numerator.value === 'x+1' : updated.value.nodes[0].text === 'Updated') && applied.entries.length === 1 && applied.visibleRanges.some(([a,z]) => a <= updated.start && z >= updated.start));
        const slices = await page.locator('.view-lines .view-line span').evaluateAll((elements) => elements.reduce((n,e) => n + ['::before','::after'].filter((p) => { const s = getComputedStyle(e,p); return (s.content + s.backgroundImage).includes('data:image/svg+xml') && e.getBoundingClientRect().height > 0; }).length, 0));
        await check(name + ': every inline SVG slice is actually visible after apply', slices === applied.entries[0].tiles && slices > 0);
        await capture('cursor-' + name + '-applied');
        const selections = [[2, 1, 3, 2], [updated.bodyStart, 2, updated.bodyStart, 2], [updated.end + 5, 1, updated.end + 5, 1]];
        await request('select', { selections }); await request('show'); await pause(400);
        const multi = await snapshot(); cases.push({ name, path: 'multiple-cursors', multi });
        await check(name + ': preview preserves outside ranges and other cursors', multi.selections.length === 3 && JSON.stringify(multi.selections[0]) === JSON.stringify({anchor:[2,1],active:[3,2]}) && JSON.stringify(multi.selections[2]) === JSON.stringify({anchor:[updated.end+5,1],active:[updated.end+5,1]}) && multi.selections[1].active[0] === updated.start-1);
      }
      await capture('cursor-' + name);
    }
    await request('finish'); await browser.close(); await exited; await save(); console.log('Cursor checks: ' + checks.length);
  } catch (e) {
    await page?.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {}); await save(); await request('finish').catch(() => {}); await browser?.close().catch(() => {}); throw e;
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
