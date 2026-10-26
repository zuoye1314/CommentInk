const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000) { for (const end = Date.now() + ms; Date.now() < end;) { const v = await fn(); if (v) return v; await pause(80); } throw new Error('Language test timed out'); }
async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'asciiflow-languages-')); console.log('Language evidence: ' + directory);
  const user = path.join(directory, 'user-data'), extensions = path.join(directory, 'extensions');
  await fs.mkdir(path.join(user, 'User'), { recursive: true }); await fs.mkdir(extensions);
  await fs.writeFile(path.join(user, 'User/settings.json'), JSON.stringify({ 'workbench.startupEditor': 'none', 'window.closeWhenEmpty': false, 'workbench.colorTheme': 'Dark Modern', 'editor.lineHeight': 0, 'editor.fontSize': 14, 'editor.minimap.enabled': false, 'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoUpdate': false, 'extensions.ignoreRecommendations': true }));
  const productArgs = process.env.COMMENT_STUDIO_VSIX ? [] : ['--extensionDevelopmentPath', __dirname, '--extensionTestsPath', path.join(__dirname, 'studio/language-test-host.cjs')];
  if (process.env.COMMENT_STUDIO_VSIX) {
    if (!process.env.COMMENT_VSCE_BIN) throw new Error('COMMENT_VSCE_BIN is required for packaged-extension testing');
    execFileSync('/usr/bin/code', ['--user-data-dir', user, '--extensions-dir', extensions, '--install-extension', process.env.COMMENT_STUDIO_VSIX], { stdio: 'pipe' });
    const bridge = path.join(directory, 'bridge'); await fs.mkdir(bridge);
    await fs.writeFile(path.join(bridge, 'package.json'), JSON.stringify({ name: 'language-test-bridge', publisher: 'local', version: '0.0.1', engines: { vscode: '^1.142.0' }, activationEvents: ['onStartupFinished'], main: 'index.cjs' }));
    await fs.writeFile(path.join(bridge, 'README.md'), '# Temporary language test bridge\nOnly used in an isolated test profile.\n');
    await fs.writeFile(path.join(bridge, 'index.cjs'), `exports.activate=()=>{require(${JSON.stringify(path.join(__dirname, 'studio/language-test-host.cjs'))}).run().then(()=>require('vscode').commands.executeCommand('workbench.action.quit'),error=>{require('node:fs').writeFileSync(${JSON.stringify(path.join(directory, 'bridge-error.txt'))},String(error.stack));require('vscode').commands.executeCommand('workbench.action.quit');});};`);
    const bridgePackage = path.join(directory, 'bridge.vsix');
    execFileSync(process.execPath, [process.env.COMMENT_VSCE_BIN, 'package', '--skip-license', '--allow-missing-repository', '--out', bridgePackage], { cwd: bridge, stdio: 'pipe' });
    execFileSync('/usr/bin/code', ['--user-data-dir', user, '--extensions-dir', extensions, '--install-extension', bridgePackage], { stdio: 'pipe' });
  }
  const child = spawn('/usr/bin/code', ['--wait', '--new-window', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--user-data-dir', user, '--extensions-dir', extensions, ...productArgs, '--remote-debugging-port=9363', '--disable-gpu', '--no-sandbox'], { env: { ...process.env, COMMENT_PREVIEW_PROBE_DIR: directory }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = await fs.open(path.join(directory, 'code.log'), 'a'); child.stdout.on('data', (s) => { void log.write(s); }); child.stderr.on('data', (s) => { void log.write(s); });
  const exited = new Promise((r) => child.once('exit', (code) => { void log.close(); r(code); }));
  const checks = [], cases = [], errors = []; let browser, page, ui;
  async function read(file) { try { return JSON.parse(await fs.readFile(path.join(directory, file), 'utf8')); } catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; } }
  async function request(op, fields) {
    const id = Date.now() + '-' + Math.random(); await fs.writeFile(path.join(directory, 'request.tmp'), JSON.stringify({ id, op, fields })); await fs.rename(path.join(directory, 'request.tmp'), path.join(directory, 'request.json'));
    return until(async () => { const r = await read('response.json'); if (r?.id !== id) return; if (r.error) throw new Error(r.error); return r.result; });
  }
  const snapshot = () => request('snapshot');
  async function save() { await fs.writeFile(path.join(directory, 'language-measurements.json'), JSON.stringify({ at: new Date().toISOString(), package: process.env.COMMENT_STUDIO_VSIX && path.basename(process.env.COMMENT_STUDIO_VSIX), checks, cases, errors }, null, 2)); }
  async function check(name, ok) { checks.push({ name, passed: !!ok }); await save(); assert.ok(ok, name); console.log('PASS ' + name); }
  async function frame() { return until(async () => { for (const f of page.frames()) try { if (await f.locator('#apply').count()) return f; } catch {} }); }
  async function capture(name) { await request('dismiss'); await pause(150); await page.screenshot({ path: path.join(directory, name + '.png') }); }
  try {
    await until(() => read('ready.json'), 60000);
    browser = await chromium.connectOverCDP('http://127.0.0.1:9363'); page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes('workbench'));
    await page.setViewportSize({ width: 1280, height: 1000 }); page.on('pageerror', (e) => errors.push(e.message));
    await request('no-editor'); await request('command', { command: 'commentStudio.newDiagram' }); await until(async () => (await page.locator('.notifications-toasts').innerText()).includes('请先打开'));
    await check('no active source editor explains how to proceed', !(await snapshot()).sessions.length); await request('dismiss');
    const languages = ['c', 'cpp', 'csharp', 'java', 'go', 'rust', 'dart', 'swift', 'objective-c', 'python', 'javascript', 'typescript', 'javascriptreact', 'typescriptreact', 'ruby', 'shellscript', 'powershell', 'php', 'lua', 'sql', 'r', 'html', 'xml', 'css', 'scss', 'less', 'yaml', 'makefile', 'dockerfile', 'perl', 'markdown', 'jsonc', 'bat', 'ini', 'latex', 'julia', 'clojure', 'fsharp', 'groovy'];
    for (const language of languages.filter((id) => !process.env.COMMENT_LANGUAGE_FOCUS || id === process.env.COMMENT_LANGUAGE_FOCUS)) {
      const before = await request('open', { language, extension: language === 'c' ? 'c' : language === 'cpp' ? 'cpp' : undefined, program: language === 'c' ? 'int add(int a, int b) { return a+b; }\n' : '' });
      await request('command', { command: 'commentStudio.newFormula' }); ui = await frame(); await ui.locator('.atom').first().fill('x'); await ui.locator('.atom').nth(1).fill('y'); await ui.locator('.atom').nth(1).press('Tab');
      await ui.locator('#apply').click(); const applied = await until(async () => { const s = await snapshot(); return !s.sessions.length && s.blocks.length === 1 && s; });
      await check(language + ': actual insert command opens editor and applies valid native comments', applied.blocks[0].value.numerator.value === 'x' && applied.source.startsWith(before.original.slice(0, before.anchor)) && applied.source.endsWith(before.original.slice(before.anchor)));
      await request('reopen'); ui = await frame(); await check(language + ': edit-at-cursor restores the formula', (await snapshot()).sessions[0].value.numerator.value === 'x');
      await ui.locator('.atom').first().fill('z'); await ui.locator('.atom').first().press('Tab'); await ui.locator('#apply').click();
      const updated = await until(async () => { const s = await snapshot(); return !s.sessions.length && s.blocks[0]?.value.numerator.value === 'z' && s; }); cases.push({ language, before, updated }); await save();
      if (language === 'c') { execFileSync('gcc', ['-x', 'c', '-std=c11', '-fsyntax-only', '-'], { input: updated.source }); await capture('languages-c-inline'); }
      if (['html', 'css', 'sql', 'shellscript'].includes(language)) await capture('languages-' + language);
    }
    for (const language of ['c', 'cpp', 'javascript', 'java', 'rust', 'css', 'html', 'sql', 'lua', 'powershell', 'ruby'].filter((id) => !process.env.COMMENT_LANGUAGE_FOCUS || id === process.env.COMMENT_LANGUAGE_FOCUS)) {
      const before = await request('open', { language, insideBlock: true, extension: language === 'c' ? 'c' : undefined, program: language === 'c' ? 'int main(void) { return 0; }\n' : '' });
      await request('command', { command: 'commentStudio.newFormula' }); ui = await frame(); await ui.locator('.atom').first().fill('a+b'); await ui.locator('.atom').nth(1).fill('n+1'); await ui.locator('.atom').nth(1).press('Tab'); await ui.locator('#apply').click();
      const applied = await until(async () => { const s = await snapshot(); return !s.sessions.length && s.blocks.length === 1 && s; });
      await check(language + ': insertion inside existing block retains its enclosure and ordinary text', applied.blocks[0].interior && applied.source.startsWith(before.original.slice(0, before.anchor)) && applied.source.endsWith(before.original.slice(before.anchor)));
      await request('reopen'); ui = await frame(); await ui.locator('#copy').click(); const copy = await until(async () => (await request('clipboard')).text);
      await check(language + ': copying from a block includes a complete standalone enclosure', copy.includes('@math begin') && copy.includes('@math end') && copy.includes(language === 'html' ? '<!--' : language === 'ruby' ? '=begin' : language === 'lua' ? '--[[' : language === 'powershell' ? '<#' : '/*'));
      if (language === 'c') {
        execFileSync('gcc', ['-x', 'c', '-std=c11', '-fsyntax-only', '-'], { input: applied.source }); await capture('languages-c-block-editor');
        await ui.locator('.atom').first().fill('c+d'); await ui.locator('.atom').first().press('Tab'); await ui.locator('#apply').click();
        const changed = await until(async () => { const s = await snapshot(); return !s.sessions.length && s.blocks[0]?.value.numerator.value === 'c+d' && s; });
        await check('C: updating an existing block preserves its enclosing comment and program', changed.blocks[0].interior && changed.source.includes('/* BEFORE\n') && changed.source.endsWith('int main(void) { return 0; }\n'));
        execFileSync('gcc', ['-x', 'c', '-std=c11', '-fsyntax-only', '-'], { input: changed.source }); await capture('languages-c-block-inline');
      }
      cases.push({ language, mode: 'existing-block', before, applied }); await save();
    }
    await request('open', { language: 'c', insideBlock: true, extension: 'c', program: 'int main(void) { return 0; }\n' });
    await request('command', { command: 'commentStudio.newDiagram' }); ui = await frame();
    async function point(x, y) {
      const q = await ui.locator('#canvas').evaluate((el, p) => { const q = new DOMPoint(p.x, p.y).matrixTransform(el.getScreenCTM()); return { x: q.x, y: q.y }; }, { x, y });
      const box = await ui.locator('body').boundingBox(); return { x: box.x + q.x, y: box.y + q.y };
    }
    async function click(x, y) { const p = await point(x, y); await page.mouse.click(p.x, p.y); }
    async function drag(x, y, x2, y2) { const a = await point(x, y), b = await point(x2, y2); await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 8 }); await page.mouse.up(); }
    await ui.locator('[data-tool="box"]').click(); await drag(70, 90, 220, 170); await drag(320, 90, 470, 170);
    await ui.locator('[data-tool="select"]').click(); await click(100, 120); await ui.locator('#label').fill('输入 */'); await ui.locator('#label').press('Tab');
    await ui.locator('[data-tool="edge"]').click(); await click(110, 130); await click(360, 130);
    await capture('languages-c-diagram-editor'); await ui.locator('#apply').click();
    const diagram = await until(async () => { const s = await snapshot(); return !s.sessions.length && s.blocks[0]?.type === 'diagram' && s; });
    await check('C: actual diagram command draws connected nodes and escapes block terminators', diagram.blocks[0].value.nodes.length === 2 && diagram.blocks[0].value.edges.length === 1 && diagram.source.includes('\\u002a/') && diagram.source.includes('/* BEFORE\n'));
    execFileSync('gcc', ['-x', 'c', '-std=c11', '-fsyntax-only', '-'], { input: diagram.source });
    await capture('languages-c-diagram-inline'); await request('command', { command: 'commentStudio.source' });
    await check('C: reveal source command removes the inline image', !(await snapshot()).entries.length);
    await request('command', { command: 'commentStudio.show' }); await check('C: preview command restores the saved diagram', (await snapshot()).entries.some((e) => e.type === 'diagram'));
    await pause(400); await capture('languages-c-final-preview');
    const labels = await page.locator('.view-lines span').evaluateAll((elements) => elements.map((e) => getComputedStyle(e, '::before').content).filter((s) => s !== 'none' && s !== 'normal'));
    await check('C: real preview labels display the diagram title without undefined', labels.some((s) => s.includes('图表')) && !labels.some((s) => s.includes('undefined')));
    const visibleSlices = await page.locator('.view-lines .view-line span').evaluateAll((elements) => elements.reduce((count, e) => count + ['::before', '::after'].filter((pseudo) => { const s = getComputedStyle(e, pseudo); return (s.content + s.backgroundImage).includes('data:image/svg+xml') && e.getBoundingClientRect().height > 0; }).length, 0));
    await check('C: every diagram SVG slice remains on screen after source and preview switching', visibleSlices === (await snapshot()).entries.reduce((sum, e) => sum + e.tiles, 0) && visibleSlices > 0);
    cases.push({ language: 'c', mode: 'stable-preview', snapshot: await snapshot(), visibleSlices, foldRanges: await request('fold-ranges') }); await save();
    cases.push({ language: 'c', mode: 'diagram', applied: diagram }); await save();
    for (const [language, source, command, message] of [['json', '{}', 'commentStudio.newFormula', '不允许注释'], ['plaintext', '', 'commentStudio.newDiagram', '语言模式'], ['c', 'int x;\n', 'commentStudio.show', '还没有'], ['c', 'int x;\n', 'commentStudio.edit', '还没有'], ['c', 'const char *s = "a\\\n// string\n";\n', 'commentStudio.newFormula', '字符串']]) {
      await request('dismiss'); await request('raw', { language, source, line: message === '字符串' ? 1 : 0 }); await request('command', { command });
      await until(async () => (await page.locator('.notifications-toasts').innerText()).includes(message)); const s = await snapshot();
      await check(language + ': ' + command + ' explains ' + message + ' without modifying source', !s.sessions.length && s.source === source); await capture('languages-warning-' + language + '-' + checks.length);
    }
    await request('finish'); await browser.close(); await exited; await save(); console.log('Language checks: ' + checks.length);
  } catch (e) {
    await page?.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {}); await save(); await request('finish').catch(() => {}); await browser?.close().catch(() => {}); throw e;
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
