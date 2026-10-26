// Real desktop canvas and recovery integration test, including a complete quit.
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const G = require('./studio/geometry.js');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, timeout = 30000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const v = await fn(); if (v) return v; await pause(100); } throw new Error('Timed out waiting for canvas test'); }
async function main() {
  const directory = process.env.COMMENT_CANVAS_EVIDENCE || await fs.mkdtemp(path.join(os.tmpdir(), 'asciiflow-canvas-'));
  await fs.mkdir(path.join(directory, 'user-data', 'User'), { recursive: true }); await fs.mkdir(path.join(directory, 'extensions'), { recursive: true }); await fs.mkdir(path.join(directory, 'project'), { recursive: true });
  await fs.writeFile(path.join(directory, 'user-data', 'User', 'settings.json'), JSON.stringify({
    'workbench.startupEditor': 'none', 'workbench.colorTheme': 'Dark Modern', 'window.restoreWindows': 'all',
    'files.hotExit': 'onExitAndWindowClose', 'editor.fontSize': 14, 'editor.lineHeight': 0, 'editor.minimap.enabled': false,
    'workbench.secondarySideBar.defaultVisibility': 'hidden', 'extensions.ignoreRecommendations': true, 'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoUpdate': false,
  }));
  // Ordinary extension loading is essential: --extensionTestsPath uses memory
  // storage and cannot provide evidence of shutdown/restart serialization.
  const packageFile = process.env.COMMENT_STUDIO_VSIX;
  let packageSource;
  if (packageFile) {
    const bytes = await fs.readFile(packageFile);
    packageSource = { file: path.basename(packageFile), sha256: require('node:crypto').createHash('sha256').update(bytes).digest('hex') };
    execFileSync('/usr/bin/code', ['--user-data-dir', path.join(directory, 'user-data'), '--extensions-dir', path.join(directory, 'extensions'), '--install-extension', path.resolve(packageFile)], { stdio: 'pipe' });
  } else {
    const link = path.join(directory, 'extensions', 'zuoye.comment-preview-probe-0.0.1');
    try { await fs.symlink(__dirname, link, 'dir'); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  const bridge = packageFile ? path.join(directory, 'bridge-source') : path.join(directory, 'extensions', 'local.canvas-test-bridge-0.0.1'); await fs.mkdir(bridge, { recursive: true });
  await fs.writeFile(path.join(bridge, 'package.json'), JSON.stringify({ name: 'canvas-test-bridge', publisher: 'local', version: '0.0.1', engines: { vscode: '^1.142.0' }, activationEvents: ['onStartupFinished'], main: 'index.cjs' }));
  await fs.writeFile(path.join(bridge, 'index.cjs'), `exports.activate = () => { require(${JSON.stringify(path.join(__dirname, 'studio/canvas-test-host.cjs'))}).run().catch(error => { require('node:fs').writeFileSync(require('node:path').join(process.env.COMMENT_PREVIEW_PROBE_DIR, 'bridge-error.txt'), String(error.stack)); }); };`);
  if (packageFile) {
    if (!process.env.COMMENT_VSCE_BIN) throw new Error('COMMENT_VSCE_BIN is required for packaged-extension testing');
    await fs.writeFile(path.join(bridge, 'README.md'), '# Isolated test bridge\nNative controls for this temporary VS Code test profile only.\n');
    const bridgePackage = path.join(directory, 'test-bridge.vsix');
    execFileSync(process.execPath, [process.env.COMMENT_VSCE_BIN, 'package', '--allow-missing-repository', '--skip-license', '--out', bridgePackage], { cwd: bridge, stdio: 'pipe' });
    execFileSync('/usr/bin/code', ['--user-data-dir', path.join(directory, 'user-data'), '--extensions-dir', path.join(directory, 'extensions'), '--install-extension', bridgePackage], { stdio: 'pipe' });
  }
  console.log('Canvas evidence: ' + directory);
  const checks = [], states = [], errors = []; let phase = '1', browser, page, ui, child, exitPromise;
  const port = process.env.COMMENT_STUDIO_TEST_PORT || '9362';
  const json = async (file) => { try { return JSON.parse(await fs.readFile(path.join(directory, file), 'utf8')); } catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; } };
  async function request(op, fields = {}) {
    const id = Date.now() + '-' + Math.random();
    await fs.writeFile(path.join(directory, 'canvas-request.tmp'), JSON.stringify({ id, phase, op, fields })); await fs.rename(path.join(directory, 'canvas-request.tmp'), path.join(directory, 'canvas-request.json'));
    return until(async () => { const r = await json('canvas-response.json'); if (r?.id !== id) return; if (r.error) throw new Error(r.error); return r.result; });
  }
  async function save() { await fs.writeFile(path.join(directory, 'canvas-measurements.json'), JSON.stringify({ at: new Date().toISOString(), packageSource, checks, states, errors }, null, 2)); }
  async function check(name, predicate) { checks.push({ name, passed: !!predicate }); await save(); assert.ok(predicate, name); console.log('PASS ' + name); }
  async function frame() { return until(async () => { for (const f of page.frames()) try { if (await f.locator('#apply').count()) return f; } catch {} }); }
  async function capture(name) {
    await request('dismiss');
    for (const label of await page.locator('.notifications-toasts .action-label').all()) {
      const text = (await label.getAttribute('aria-label') || '') + ' ' + (await label.getAttribute('title') || '');
      if (/Clear Notification|Close Notification/i.test(text) && await label.isVisible()) await label.click();
    }
    await pause(350); const host = await request('snapshot');
    let screen;
    if (host.sessions.length) {
      ui = await frame(); screen = await ui.locator('#canvas').evaluate((el) => ({ viewBox: el.getAttribute('viewBox'), selected: el.dataset.selected, nodes: el.querySelectorAll('[data-node]').length, edges: el.querySelectorAll('[data-edge]').length, collisions: el.querySelectorAll('.collision').length }));
    }
    await page.screenshot({ path: path.join(directory, name + '.png') }); const result = { name, host, screen }; states.push(result); await save(); return result;
  }
  async function launch() {
    child = spawn('/usr/bin/code', ['--wait', '--new-window', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--user-data-dir', path.join(directory, 'user-data'), '--extensions-dir', path.join(directory, 'extensions'), '--remote-debugging-port=' + port, '--disable-gpu', '--no-sandbox', path.join(directory, 'project')], { env: { ...process.env, COMMENT_PREVIEW_PROBE_DIR: directory, COMMENT_CANVAS_PHASE: phase }, stdio: ['ignore', 'pipe', 'pipe'] });
    const log = await fs.open(path.join(directory, 'code-phase-' + phase + '.log'), 'a');
    child.stdout.on('data', (s) => { void log.write(s); }); child.stderr.on('data', (s) => { void log.write(s); });
    exitPromise = new Promise((resolve) => child.once('exit', (code) => { void log.close(); resolve({ code }); }));
    await until(() => json('canvas-ready-' + phase + '.json'), 60000);
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
    page = await until(() => browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes('workbench')));
    await page.setViewportSize({ width: 1280, height: 1000 });
    page.on('pageerror', (error) => { errors.push(error.message); });
    await request('dismiss');
  }
  async function point(x, y) {
    const p = await ui.locator('#canvas').evaluate((el, p) => { const q = new DOMPoint(p.x, p.y).matrixTransform(el.getScreenCTM()); return { x: q.x, y: q.y }; }, { x, y });
    const box = await ui.locator('body').boundingBox(); return { x: box.x + p.x, y: box.y + p.y };
  }
  async function drag(x1, y1, x2, y2, options = {}) {
    const a = await point(x1, y1), b = await point(x2, y2);
    if (options.key) await page.keyboard.down(options.key);
    await page.mouse.move(a.x, a.y); await page.mouse.down({ button: options.button || 'left' }); await page.mouse.move(b.x, b.y, { steps: 12 }); await page.mouse.up({ button: options.button || 'left' });
    if (options.key) await page.keyboard.up(options.key); await pause(250);
  }
  const snapshot = () => request('snapshot');
  const current = async () => { const s = await snapshot(); return s.sessions[0].value; };
  async function clickWorld(x, y, modifiers) { const p = await point(x, y); if (modifiers) await page.keyboard.down(modifiers); await page.mouse.click(p.x, p.y); if (modifiers) await page.keyboard.up(modifiers); }
  try {
  await launch();
  await request('open', { fresh: true }); ui = await frame(); await until(() => ui.locator('[data-tool="box"]').isVisible());
  await ui.locator('[data-tool="box"]').click(); await drag(70, 90, 240, 190); await drag(430, 90, 600, 190); await drag(260, 310, 430, 410);
  const created = await capture('canvas-created'); let scene = created.host.sessions[0].value;
  await check('three nodes created with actual drawing gestures', scene.nodes.length === 3);
  const [a, b, c] = scene.nodes.map((n) => n.id);
  await ui.locator('[data-tool="select"]').click(); await clickWorld(110, 130); await ui.locator('#label').fill('输入 x'); await ui.locator('#label').press('Tab');
  await clickWorld(470, 130); await ui.locator('#label').fill('输出 z'); await ui.locator('#label').press('Tab');
  // Connected line and text label.
  await ui.locator('[data-tool="edge"]').click(); await clickWorld(120, 140); await clickWorld(480, 140);
  await ui.locator('[data-tool="select"]').click(); await clickWorld(330, 140); await ui.locator('#label').fill('归一化'); await ui.locator('#label').press('Tab');
  await ui.locator('#edge-arrow').selectOption('both');
  const labeled = await capture('canvas-labeled-connection'); scene = labeled.host.sessions[0].value;
  await check('connected edge label and bidirectional arrows are semantic v2 data', scene.version === 2 && scene.edges[0].from === a && scene.edges[0].to === b && scene.edges[0].label === '归一化' && scene.edges[0].arrow === 'both');
  // View transforms never change model coordinates.
  const beforeView = JSON.stringify(scene);
  await ui.locator('#zoom-in').click(); await ui.locator('#zoom-in').click();
  await ui.locator('[data-tool="pan"]').click(); await drag(650, 240, 800, 290);
  const transformed = await capture('canvas-zoomed-panned');
  await check('zoom and hand pan change only the viewport', JSON.stringify(transformed.host.sessions[0].value) === beforeView && transformed.screen.viewBox !== '0 0 1100 700');
  await ui.locator('[data-tool="select"]').click(); const oldA = (await current()).nodes.find((n) => n.id === a);
  await drag(oldA.x + 40, oldA.y + 40, oldA.x + 80, oldA.y + 70);
  scene = await current(); const movedA = scene.nodes.find((n) => n.id === a);
  await check('dragging at zoomed and panned coordinates moves by the intended world distance', Math.abs(movedA.x - oldA.x - 40) <= 2 && Math.abs(movedA.y - oldA.y - 30) <= 2 && scene.edges[0].from === a);
  await ui.locator('#undo').click(); await ui.locator('#zoom-reset').click();
  // Group select, movement, one-step undo, duplicate/delete and arrows.
  await drag(40, 60, 640, 230);
  const selected = await capture('canvas-marquee-selection');
  await check('marquee selects both top nodes and their internal connection', selected.screen.selected.split(',').length === 3);
  const beforeGroup = await current(); await drag(110, 130, 140, 170); const afterGroup = await current();
  await check('group drag preserves relative spacing and connected IDs', afterGroup.nodes[0].x - beforeGroup.nodes[0].x === 30 && afterGroup.nodes[1].y - beforeGroup.nodes[1].y === 40 && afterGroup.edges[0].to === b);
  await ui.locator('#undo').click(); await check('one canvas undo restores the entire group move', JSON.stringify(await current()) === JSON.stringify(beforeGroup));
  await ui.locator('#redo').click(); await ui.locator('#undo').click();
  // History clears selection, reselect the group before duplication.
  await drag(40, 60, 640, 230); await ui.locator('#duplicate').click();
  const duplicated = await current(); await check('duplicate remaps internal connected endpoints to new stable IDs', duplicated.nodes.length === 5 && duplicated.edges.length === 2 && duplicated.edges[1].from !== a && duplicated.nodes.some((n) => n.id === duplicated.edges[1].from));
  await ui.locator('#delete-selection').click(); await check('deleting a duplicate selection removes its internal edge only', (await current()).nodes.length === 3 && (await current()).edges.length === 1);
  await ui.locator('#undo').click(); await ui.locator('#undo').click();
  await clickWorld(120, 140); await clickWorld(480, 140, 'Shift');
  const shifted = await capture('canvas-shift-multiselect'); await check('Shift click adds another node without losing the first selection', shifted.screen.selected.split(',').length === 2);
  // Free line, endpoint reattachment, bend edit, delete/undo.
  await ui.locator('[data-tool="free"]').click(); await drag(90, 480, 570, 520, { key: 'Alt' });
  await ui.locator('[data-tool="select"]').click();
  scene = await current(); const freeId = scene.edges.at(-1).id;
  await check('free line can exist without either endpoint attached to a node', typeof scene.edges.at(-1).from === 'object' && typeof scene.edges.at(-1).to === 'object');
  await ui.locator('#canvas').evaluate(el => { window.__canvasEvents = []; for (const type of ['pointerdown', 'pointerup', 'click', 'dblclick']) el.addEventListener(type, event => window.__canvasEvents.push({ type, target: event.target.tagName, node: event.target.closest('[data-edge]')?.dataset.edge, detail: event.detail }), true); });
  let midpoint = await point(330, 500); await page.mouse.dblclick(midpoint.x, midpoint.y); await pause(200);
  scene = await current(); await check('double-click creates an editable intermediate bend', scene.edges.at(-1).points.length === 1);
  await drag(330, 500, 330, 570); await check('bend dragging updates the polyline data', (await current()).edges.at(-1).points[0].y === 570);
  await drag(570, 520, 480, 140); await check('dragging a free endpoint onto a node attaches it', (await current()).edges.at(-1).to === b);
  await ui.locator('#label').fill('自由连线'); await ui.locator('#label').press('Tab');
  const freeEdited = await capture('canvas-free-line-bend-label');
  await ui.locator('#clear-bends').click(); await check('clear bends is undoable', (await current()).edges.at(-1).points.length === 0);
  await ui.locator('#undo').click(); await check('undo restores the exact bend', (await current()).edges.at(-1).points[0].y === 570);
  // Overlap third node with top left, warn without moving anything else.
  await ui.locator('[data-tool="select"]').click(); scene = await current(); const oldC = scene.nodes.find((n) => n.id === c);
  await drag(oldC.x + 40, oldC.y + 40, 140, 150);
  const collision = await capture('canvas-collision-warning');
  await check('overlapping objects are visibly flagged and unrelated nodes stay put', collision.screen.collisions >= 2 && collision.host.sessions[0].value.nodes.find((n) => n.id === b).x === 430);
  const beforeArrange = await current(); await ui.locator('#arrange').click();
  scene = await current(); await check('explicit avoid-overlap moves only selected node and clears node collisions', G.collisions(scene.nodes).length === 0 && scene.nodes.find((n) => n.id === b).x === 430);
  await ui.locator('#undo').click(); await check('one undo restores pre-arrangement positions', JSON.stringify(await current()) === JSON.stringify(beforeArrange)); await ui.locator('#redo').click();
  // Put an intervening node into the original edge, then use orthogonal routing.
  scene = await current(); const rightNode = scene.nodes.find((n) => n.id === b);
  await drag(rightNode.x + 30, rightNode.y + 30, 680, 120);
  scene = await current(); const obstacle = scene.nodes.find((n) => n.id === c);
  await drag(obstacle.x + 20, obstacle.y + 20, 290, 120); // target x270,y100
  await clickWorld(250, 140); await ui.locator('#edge-route').selectOption('orthogonal');
  const routed = await capture('canvas-orthogonal-avoidance'); scene = routed.host.sessions[0].value;
  const routedPath = G.route(scene.edges[0], scene.nodes);
  await check('orthogonal connector avoids the intervening object', scene.edges[0].route === 'orthogonal' && !routedPath.blocked && routedPath.points.length >= 4);
  // Reset obstacle to a compact valid layout for saving/inline fallback.
  await ui.locator('#zoom-fit').click(); const fit = await capture('canvas-fit-content'); await check('fit content changes viewport without losing objects', fit.screen.nodes === 3 && fit.screen.edges === 2);
  await ui.locator('#copy-language').selectOption('typescript'); await ui.locator('#copy').click();
  await until(async () => (await request('clipboard')).text);
  const copied = (await request('clipboard')).text; await check('copy includes v2 labels, free points and attached endpoints', copied.includes('@diagram begin v2') && copied.includes('自由连线') && copied.includes('"points"'));
  const beforeApply = await snapshot(); const src = beforeApply.documents.find((d) => d.uri.endsWith('/canvas.py')).source;
  await check('all canvas editing remains a draft until apply', src === '# BEFORE_CANVAS\n# AFTER_CANVAS\n');
  await ui.locator('#apply').click(); await until(async () => !(await snapshot()).sessions.length);
  const applied = await capture('canvas-applied'); const appliedDoc = applied.host.documents.find((d) => d.uri.endsWith('/canvas.py'));
  await check('native apply stores the complete scene and retains ordinary comments', appliedDoc.blocks[0].value.edges.length === 2 && appliedDoc.source.startsWith('# BEFORE_CANVAS\n') && appliedDoc.source.endsWith('# AFTER_CANVAS\n'));
  await request('save-source'); await request('open'); ui = await frame();
  const reopened = await capture('canvas-reopened'); await check('reopening from source preserves every semantic canvas field', JSON.stringify(reopened.host.sessions[0].value) === JSON.stringify(scene));
  // Session-only editor readonly (in addition to disk and read-only provider).
  await request('readonly-editor', { readonly: true }); ui = await frame();
  const readonlyBefore = (await snapshot()).documents.find((d) => d.uri.endsWith('/canvas.py')).hash;
  await clickWorld(110, 130); await ui.locator('#label').fill('只读测试草稿'); await ui.locator('#label').press('Tab');
  await ui.locator('#apply').click(); await pause(700);
  let ro = await capture('canvas-readonly-editor');
  await check('session-readonly editor refuses writes and retains the draft', ro.host.sessions.length === 1 && ro.host.documents.find((d) => d.uri.endsWith('/canvas.py')).hash === readonlyBefore && (await ui.locator('#status').textContent()).includes('只读'));
  await request('readonly-editor', { readonly: false }); await request('chmod', { readonly: true }); ui = await frame(); await ui.locator('#apply').click(); await pause(400);
  ro = await capture('canvas-readonly-permissions');
  await check('read-only file mode refuses writes without destroying the draft', ro.host.sessions.length === 1 && ro.host.documents.find((d) => d.uri.endsWith('/canvas.py')).hash === readonlyBefore && (await ui.locator('#status').textContent()).includes('只读'));
  await ui.locator('#copy').click(); await until(async () => (await request('clipboard')).text?.includes('只读测试草稿'));
  await check('a blocked read-only draft remains copyable without changing the source', (await request('clipboard')).text.includes('只读测试草稿') && (await snapshot()).documents.find((d) => d.uri.endsWith('/canvas.py')).hash === readonlyBefore);
  await request('chmod', { readonly: false });
  // Rename file and its containing directory while keeping an uncommitted draft.
  await request('rename', { name: 'renamed.py' }); await request('rename-directory');
  const renamed = await capture('canvas-renamed-draft');
  await check('file and directory renames update the live draft target', renamed.host.sessions[0].uri.endsWith('/renamed-src/renamed.py') && renamed.host.sessions[0].target.uri === renamed.host.sessions[0].uri);
  ui = await frame(); await ui.locator('#apply').click(); await until(async () => !(await snapshot()).sessions.length);
  const appliedRename = await capture('canvas-applied-after-rename');
  await check('apply after renaming edits only the new file', appliedRename.host.documents.some((d) => d.uri.endsWith('/renamed-src/renamed.py') && d.source.includes('只读测试草稿')) && !await fs.stat(path.join(directory, 'project/src/canvas.py')).then(() => true).catch(() => false));
  const newFile = path.join(directory, 'project/renamed-src/renamed.py');
  await request('save-source');
  // Read-only provider must stay editable as draft, copyable, and never writable.
  await request('open-readonly-provider'); ui = await frame(); await ui.locator('.atom').fill('y'); await ui.locator('#apply').click(); await pause(400);
  const provider = await capture('canvas-readonly-provider');
  await check('read-only filesystem keeps modified formula draft and source x', provider.host.sessions.length === 1 && provider.host.sessions[0].value.value === 'y' && provider.host.documents.find((d) => d.uri.startsWith('studio-readonly-test:')).blocks[0].value.value === 'x');
  await request('close');
  // Prepare an uncommitted graph draft and view transform for a real app exit.
  await request('open', { file: newFile }); ui = await frame(); await ui.locator('#zoom-in').click(); await ui.locator('[data-tool="pan"]').click(); await drag(650, 350, 800, 390);
  await ui.locator('[data-tool="select"]').click(); scene = await current(); const n = scene.nodes[0]; await clickWorld(n.x + 30, n.y + 30); await ui.locator('#label').fill('重启草稿'); await ui.locator('#label').press('Tab');
  const beforeQuit = await capture('canvas-before-full-quit'); await request('flush'); const diskBeforeQuit = await fs.readFile(newFile, 'utf8');
  await request('quit'); const quitResult = await Promise.race([exitPromise, pause(30000).then(() => { throw new Error('VS Code did not quit completely'); })]);
  await check('VS Code test window exits completely with uncommitted canvas draft', quitResult.code === 0);
  await browser.close().catch(() => {}); phase = '2'; await launch();
  await until(async () => (await snapshot()).sessions.length === 1, 45000);
  const firstRestored = await snapshot();
  await page.screenshot({ path: path.join(directory, 'canvas-first-restored-frame.png') });
  await fs.writeFile(path.join(directory, 'first-restored.json'), JSON.stringify(firstRestored, null, 2));
  await check('restored draft exists before any tab hide/rebuild', firstRestored.sessions[0].restored && JSON.stringify(firstRestored.sessions[0].value) === JSON.stringify(beforeQuit.host.sessions[0].value));
  // Playwright/CDP misses an already-created webview's out-of-process frame
  // after reconnection. Switch native tabs to attach a fresh frame for input.
  await request('hide'); await request('reveal'); ui = await frame();
  const restored = await capture('canvas-after-full-restart');
  await check('full restart creates a new extension host and restores the unsaved graph draft', restored.host.hostPid !== beforeQuit.host.hostPid && restored.host.sessions[0].restored && JSON.stringify(restored.host.sessions[0].value) === JSON.stringify(beforeQuit.host.sessions[0].value));
  await check('full restart restores zoom pan and selection as well as the renamed target', restored.screen.viewBox === beforeQuit.screen.viewBox && restored.screen.selected === beforeQuit.screen.selected && restored.host.sessions[0].uri.endsWith('/renamed-src/renamed.py'));
  await check('restoring a draft does not modify the saved source file', await fs.readFile(newFile, 'utf8') === diskBeforeQuit);
  await request('conflict'); const conflictBefore = (await snapshot()).documents.find((d) => d.uri.endsWith('/renamed-src/renamed.py')).hash;
  await ui.locator('#apply').click(); await pause(400);
  const conflict = await capture('canvas-restored-conflict');
  await check('recovered draft refuses to overwrite a concurrently changed source block', conflict.host.sessions.length === 1 && conflict.host.documents.find((d) => d.uri.endsWith('/renamed-src/renamed.py')).hash === conflictBefore && (await ui.locator('#status').textContent()).includes('未覆盖'));
  await request('resolve-conflict');
  await ui.locator('#apply').click(); await until(async () => !(await snapshot()).sessions.length);
  const final = await capture('canvas-recovered-draft-applied');
  await check('recovered draft can be explicitly applied to its original renamed file', final.host.documents.some((d) => d.uri.endsWith('/renamed-src/renamed.py') && d.source.includes('重启草稿')));
  await request('save-source'); await request('finish'); await browser.close(); await exitPromise;
  await save(); console.log('Canvas/recovery checks: ' + checks.length);
  } catch (error) {
    await page?.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {});
    await fs.writeFile(path.join(directory, 'failure-state.json'), JSON.stringify({ host: await snapshot().catch(() => null), events: await ui?.evaluate(() => window.__canvasEvents).catch(() => null), status: await ui?.locator('#status').textContent().catch(() => null), notifications: await page?.locator('.notifications-toasts').evaluate(el=>el.outerHTML).catch(()=>null) }, null, 2));
    await request('finish').catch(() => {});
    await browser?.close().catch(() => {});
    throw error;
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
