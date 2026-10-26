const { chromium } = require("playwright");
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const { request, geometry, pause, until } = require("../measure-block.cjs");
const [directory, endpoint] = process.argv.slice(2);
const action = (operation, fields = {}) => request("studio-action", { operation, fields });

async function main() {
  await until(async () => { try { return JSON.parse(await fs.readFile(path.join(directory, "ready.json"), "utf8")); }
    catch (e) { if (e.code !== "ENOENT" && !(e instanceof SyntaxError)) throw e; } }, 60_000);
  const browser = await chromium.connectOverCDP(endpoint);
  const page = await until(() => browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("workbench")));
  await page.setViewportSize({ width: 1200, height: 1000 });
  const cases = [], checks = [];
  const save = () => fs.writeFile(path.join(directory, "studio-measurements.json"), JSON.stringify({ capturedAt: new Date().toISOString(), cases, checks }, null, 2));
  async function capture(name) {
    await pause(550);
    const host = await request("studio-snapshot"), measured = await geometry(page);
    await page.screenshot({ path: path.join(directory, `${name}.png`) });
    const state = { name, host, geometry: measured }; cases.push(state); await save();
    console.log(JSON.stringify({ name, views: host.views.map((v) => ({ column: v.column, entries: v.entries.map((e) => e.id), errors: v.errors })), sessions: host.sessions.length, attachments: measured.attachments.length }));
    return state;
  }
  async function check(name, predicate) { checks.push({ name, passed: !!predicate }); await save(); assert.ok(predicate, name); }
  const doc = (state, key) => state.host.documents.find((d) => d.key === key);
  const view = (state, column) => state.host.views.find((v) => v.column === column);
  const tileCount = (state) => state.host.views.reduce((n, v) => n + v.entries.reduce((sum, e) => sum + e.tiles, 0), 0);
  const baseline = await capture("studio-baseline");
  await action("show");
  const multi = await capture("studio-multiple-formulas");
  await check("two actual Python comment blocks preview together and the string impostor is ignored", view(multi, 1).entries.length === 2
    && doc(multi, "python").blocks.map((b) => b.id).join(",") === "a,b");
  await check("opening multiple previews does not modify source", doc(multi, "python").hash === doc(baseline, "python").hash);
  await check("every expected SVG slice is actually visible", multi.geometry.attachments.length === tileCount(multi));
  await action("split");
  const split = await capture("studio-same-file-split");
  await check("same file in two groups has independent complete decorations", split.host.views.length === 2
    && split.host.views.every((v) => v.entries.length === 2) && split.geometry.attachments.length === tileCount(split));
  await action("focus", { file: "python", column: 1, id: "a", where: "inside" });
  const source = await capture("studio-source-in-one-view");
  await check("entering one formula reveals only that formula in that window", view(source, 1).entries.map((e) => e.id).join(",") === "b"
    && view(source, 2).entries.length === 2);
  await action("focus", { file: "typescript", column: 1 }); await action("focus", { file: "python", column: 1 });
  const tabReturn = await capture("studio-source-mode-after-tab-switch");
  await check("moving the cursor outside on tab return automatically restores that view", view(tabReturn, 1).entries.length === 2
    && view(tabReturn, 2).entries.length === 2);
  await action("focus", { file: "typescript", column: 2 }); await action("show");
  const typescript = await capture("studio-python-typescript");
  await check("different documents with equal IDs do not overwrite each other", doc(typescript, "typescript").blocks.length === 2
    && view(typescript, 2).entries.length === 2 && view(typescript, 1).entries.length === 2);
  const tsHash = doc(typescript, "typescript").hash;
  await action("edit-before");
  const moved = await capture("studio-unrelated-edit");
  await check("outside edits reanchor existing previews without affecting the other file", view(moved, 1).entries.length === 2
    && view(moved, 2).entries.length === 2 && doc(moved, "typescript").hash === tsHash);
  await action("focus", { file: "python", column: 1 }); await action("show");
  await action("edit-value");
  const changed = await capture("studio-one-formula-changed");
  await check("an external valid edit refreshes its preview while unrelated formulas remain", view(changed, 1).entries.length === 2
    && doc(changed, "python").blocks.find((b) => b.id === "b").tex.includes("z")
    && view(changed, 2).entries.length === 2);
  await action("undo"); await action("show");
  await action("duplicate");
  const duplicate = await capture("studio-duplicate-identifiers");
  await check("duplicate IDs fail closed without suppressing the valid other block", doc(duplicate, "python").diagnostics.length === 2
    && view(duplicate, 1).entries.map((e) => e.id).join(",") === "b");
  await action("undo"); await action("show");
  await action("fold", { id: "a" });
  const folded = await capture("studio-fully-folded");
  await check("native whole-block folding hides only its own SVG", folded.geometry.attachments.length === tileCount(folded) - view(folded, 1).entries.find((e) => e.id === "a").tiles);
  await action("unfold", { id: "a" });
  await capture("studio-unfolded");
  await action("single-group");
  // Standalone graphical formula: no hand-written TeX is entered.
  async function frame() {
    return until(async () => {
      for (const f of page.frames()) try { if (await f.locator("#apply").count()) return f; } catch { /* frame may be rebuilding */ }
    });
  }
  await action("open-formula");
  let ui = await frame(); await ui.getByRole("textbox", { name: "分子", exact: true }).fill("x-μ");
  await ui.getByRole("textbox", { name: "分母", exact: true }).fill("σ");
  await ui.getByRole("button", { name: "根号", exact: true }).click();
  await ui.getByRole("textbox", { name: "内容", exact: true }).click();
  await ui.getByRole("button", { name: "并列", exact: true }).click();
  await ui.getByRole("textbox", { name: "并列项1", exact: true }).click();
  await ui.getByRole("button", { name: "上标", exact: true }).click();
  await ui.getByRole("textbox", { name: "上标", exact: true }).fill("2");
  await ui.getByRole("textbox", { name: "并列项2", exact: true }).fill("+ε");
  await pause(500);
  const built = await capture("studio-visual-formula");
  await check("nested fraction/root/power is built through actual template controls", built.host.sessions[0].value.denominator.kind === "sqrt"
    && built.host.sessions[0].value.denominator.body.items[0].kind === "power");
  await check("graphical formula draft does not change the code", doc(built, "fresh").hash === doc(baseline, "fresh").hash);
  await ui.getByRole("button", { name: "应用到注释", exact: true }).click();
  await until(async () => !(await request("studio-snapshot")).sessions.length);
  const formulaApplied = await capture("studio-formula-applied-inline");
  await check("applying formula returns to inline preview and preserves surrounding annotations", doc(formulaApplied, "fresh").blocks.length === 1
    && doc(formulaApplied, "fresh").sourceText.startsWith("# BEFORE_FRESH\n") && doc(formulaApplied, "fresh").sourceText.endsWith("# AFTER_FRESH\n")
    && view(formulaApplied, 1).entries.length === 1);
  await action("undo"); const formulaUndo = await capture("studio-formula-undo");
  await check("one undo restores exact pre-insertion text", doc(formulaUndo, "fresh").hash === doc(baseline, "fresh").hash);
  await action("redo"); await action("show");
  const formulaRestored = await capture("studio-formula-redo");
  await check("formula redo restores editable data and inline image", doc(formulaRestored, "fresh").hash === doc(formulaApplied, "fresh").hash && view(formulaRestored, 1).entries.length === 1);
  // Graphical diagram + formula + connection.
  await action("open-diagram"); ui = await frame();
  // Frame coordinates need the iframe's offset, which frame locator mouse
  // actions handle. Draw/drag using bounding boxes in main-page coordinates.
  async function canvasPoint(x, y) {
    const box = await ui.locator("#canvas").boundingBox();
    const size = await ui.locator("#canvas").evaluate((el) => ({ w: el.viewBox.baseVal.width, h: el.viewBox.baseVal.height }));
    const scale = Math.min(box.width / size.w, box.height / size.h);
    return { x: box.x + (box.width - size.w * scale) / 2 + x * scale, y: box.y + (box.height - size.h * scale) / 2 + y * scale };
  }
  async function clickPoint(x, y) { const p = await canvasPoint(x, y); await page.mouse.click(p.x, p.y); }
  async function dragPoints(x1, y1, x2, y2) {
    const a = await canvasPoint(x1, y1), b = await canvasPoint(x2, y2);
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 10 }); await page.mouse.up();
  }
  await ui.getByRole("button", { name: "方框", exact: true }).click(); await dragPoints(90, 120, 290, 200);
  await ui.locator("#label").fill("输入 x");
  await ui.getByRole("button", { name: "方框", exact: true }).click(); await dragPoints(480, 120, 720, 210);
  await ui.locator("#label").fill("标准化");
  await ui.getByRole("button", { name: "连线", exact: true }).click(); await clickPoint(190, 160); await clickPoint(600, 165);
  await ui.getByRole("button", { name: "公式", exact: true }).click(); await clickPoint(600, 165);
  await ui.getByRole("textbox", { name: "分子", exact: true }).fill("x-μ"); await ui.getByRole("textbox", { name: "分母", exact: true }).fill("σ");
  await pause(500);
  const diagram = await capture("studio-diagram-formula-editor");
  await check("two nodes, a stable edge and a real formula are created through the canvas", diagram.host.sessions[0].value.nodes.length === 2
    && diagram.host.sessions[0].value.edges.length === 1 && diagram.host.sessions[0].value.nodes[1].formula.kind === "fraction");
  const originalEdge = JSON.stringify(diagram.host.sessions[0].value.edges);
  await ui.getByRole("button", { name: "选择", exact: true }).click(); await dragPoints(190, 160, 190, 290);
  const dragged = await capture("studio-node-moved");
  await check("dragging moves the node and keeps the connection attached by identity", dragged.host.sessions[0].value.nodes[0].y > diagram.host.sessions[0].value.nodes[0].y
    && JSON.stringify(dragged.host.sessions[0].value.edges) === originalEdge);
  await ui.getByRole("button", { name: "撤销", exact: true }).click(); await pause(300);
  const dragUndo = await capture("studio-drag-undo");
  await check("one canvas undo restores one drag", dragUndo.host.sessions[0].value.nodes[0].y === diagram.host.sessions[0].value.nodes[0].y);
  await ui.getByRole("button", { name: "重做", exact: true }).click();
  await ui.getByRole("button", { name: "选择", exact: true }).click(); await clickPoint(600, 165);
  const handle = await ui.locator("[data-resize]").boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 12, handle.y + handle.height / 2 + 12, { steps: 6 }); await page.mouse.up();
  const resized = await capture("studio-node-resized");
  await check("resizing preserves node formula and stable edge references", resized.host.sessions[0].value.nodes[1].width > diagram.host.sessions[0].value.nodes[1].width
    && resized.host.sessions[0].value.nodes[1].formula.kind === "fraction" && JSON.stringify(resized.host.sessions[0].value.edges) === originalEdge);
  await action("hide-panel"); await action("show-panel"); ui = await frame();
  const resumed = await capture("studio-draft-restored");
  await check("hiding/rebuilding the webview restores its draft without writing code", resumed.host.sessions[0].value.nodes[0].y === dragged.host.sessions[0].value.nodes[0].y
    && doc(resumed, "fresh").hash === doc(formulaRestored, "fresh").hash);
  await ui.locator("#copy-language").selectOption("typescript"); await ui.getByRole("button", { name: "复制注释", exact: true }).click();
  await until(async () => (await ui.locator("#status").textContent()).includes("已复制"));
  const clipboard = await action("copy-capture");
  await check("copy exports complete self-contained TS comments with a fresh block identity", clipboard.parsed.blocks.length === 1
    && clipboard.parsed.blocks[0].id !== resumed.host.sessions[0].id
    && JSON.stringify(clipboard.parsed.blocks[0].value) === JSON.stringify(resumed.host.sessions[0].value));
  await ui.getByRole("button", { name: "应用到注释", exact: true }).click();
  await until(async () => !(await request("studio-snapshot")).sessions.length);
  let graphApplied = await capture("studio-diagram-applied-inline");
  await check("diagram and standalone formula coexist inline with code preserved", doc(graphApplied, "fresh").blocks.length === 2
    && view(graphApplied, 1).entries.length === 2 && graphApplied.geometry.attachments.length === tileCount(graphApplied)
    && doc(graphApplied, "fresh").sourceText.endsWith("# AFTER_FRESH\n"));
  const dataBeforeTyping = doc(graphApplied, "fresh").blocks.map((b) => b.fingerprint);
  await action("focus", { file: "fresh", line: 0, end: true }); await page.keyboard.type(" typed-above");
  let s = await request("studio-snapshot");
  const afterLine = s.documents.find((d) => d.key === "fresh").sourceText.split("\n").findIndex((line) => line.includes("AFTER_FRESH"));
  await action("focus", { file: "fresh", line: afterLine, end: true }); await page.keyboard.press("End");
  await page.keyboard.press("Enter"); s = await request("studio-snapshot");
  const activeView = s.views.find((v) => v.column === 1);
  const currentLine = s.documents.find((d) => d.key === "fresh").sourceText.split("\n")[activeView.selection[0]];
  await page.keyboard.insertText((/^\s*#\s*$/.test(currentLine) ? "" : "# ") + "TYPED_AFTER: ordinary annotation");
  graphApplied = await capture("studio-typing-around-inline-blocks");
  await check("real upper/lower typing and Enter preserve both inline objects and stay outside their data", view(graphApplied, 1).entries.length === 2
    && graphApplied.geometry.attachments.length === tileCount(graphApplied)
    && JSON.stringify(doc(graphApplied, "fresh").blocks.map((b) => b.fingerprint)) === JSON.stringify(dataBeforeTyping)
    && doc(graphApplied, "fresh").sourceText.includes("typed-above") && doc(graphApplied, "fresh").sourceText.includes("TYPED_AFTER"));
  const graphBlock = doc(graphApplied, "fresh").blocks.find((b) => b.type === "diagram");
  await action("open-diagram", { file: "fresh", id: graphBlock.id }); ui = await frame();
  const reopened = await capture("studio-diagram-reopened");
  await check("reopening from source restores formula, coordinates and edges", JSON.stringify(reopened.host.sessions[0].value) === JSON.stringify(graphBlock.value));
  await action("cancel-during-apply");
  const cancelled = await capture("studio-cancel-pending-apply");
  await check("closing a panel during asynchronous apply prevents the source write", cancelled.host.sessions.length === 0
    && doc(cancelled, "fresh").hash === doc(graphApplied, "fresh").hash);
  await action("paste-copy");
  const pasted = await capture("studio-copied-to-typescript");
  await check("copied graph previews in another language without its original cache", doc(pasted, "copy").blocks.length === 1
    && view(pasted, 1).entries.length === 1 && doc(pasted, "copy").blocks[0].value.edges.length === 1);
  await page.setViewportSize({ width: 700, height: 1000 }); await action("wrap");
  const narrow = await capture("studio-narrow-inline-graph");
  await check("tested narrow wrapped editor retains all graph slices and the entire image width", narrow.geometry.attachments.length === tileCount(narrow)
    && narrow.geometry.attachments.every((a) => a.owner.x + view(narrow, 1).entries[0].dimensions[0]
      <= narrow.geometry.viewport.x + narrow.geometry.viewport.width));
  await action("wrap"); await page.setViewportSize({ width: 1200, height: 1000 });
  await action("theme", { name: "Light Modern" });
  const light = await capture("studio-light-theme");
  await check("light theme rebuilds previews without changing source", doc(light, "copy").hash === doc(pasted, "copy").hash && light.geometry.attachments.length === tileCount(light));
  await action("theme", { name: "Default High Contrast" });
  const contrast = await capture("studio-high-contrast");
  await check("high contrast theme keeps the inline graph and source intact", contrast.geometry.attachments.length === tileCount(contrast) && doc(contrast, "copy").hash === doc(pasted, "copy").hash);
  await action("font", { size: 20 });
  const largerFont = await capture("studio-larger-font");
  await check("font changes rebuild multi-line graph without folding its parent or changing source", largerFont.geometry.attachments.length === tileCount(largerFont)
    && doc(largerFont, "copy").hash === doc(pasted, "copy").hash);
  await action("font", { size: 14 });
  await action("theme", { name: "Dark Modern" });
  await action("open-diagram", { file: "fresh", id: graphBlock.id }); ui = await frame();
  await action("edit-value", { file: "fresh", id: graphBlock.id, from: '"text": "标准化"', to: '"text": "外部修改"' });
  const conflictBefore = await capture("studio-conflict-before-apply");
  await ui.getByRole("button", { name: "应用到注释", exact: true }).click();
  await until(async () => (await ui.locator("#status").textContent()).includes("未覆盖"));
  const conflict = await capture("studio-conflict-preserves-draft");
  await check("concurrent source changes cannot be overwritten and the draft remains editable", conflict.host.sessions.length === 1
    && doc(conflict, "fresh").hash === doc(conflictBefore, "fresh").hash && conflict.host.sessions[0].value.nodes[1].text === "标准化");
  await action("close-panel");
  const beforeMatrix = await request("studio-snapshot");
  await action("open-formula"); ui = await frame();
  await ui.getByRole("button", { name: "矩阵", exact: true }).click();
  await ui.getByRole("button", { name: "加一行", exact: true }).click(); await ui.getByRole("button", { name: "加一列", exact: true }).click();
  for (let r = 1; r <= 3; r++) for (let c = 1; c <= 3; c++) await ui.getByRole("textbox", { name: `矩阵第${r}行第${c}列`, exact: true }).fill(String(r * 10 + c));
  await until(async () => await ui.locator("#math-preview").evaluate((img) => img.complete && img.naturalWidth > 0
    && atob(img.src.split(",")[1] || "").includes('data-latex="33"')));
  const matrixDraft = await capture("studio-matrix-template");
  await check("a 3x3 matrix is created and edited through template controls", matrixDraft.host.sessions[0].value.cells.length === 3
    && matrixDraft.host.sessions[0].value.cells.every((row) => row.length === 3) && matrixDraft.host.sessions[0].value.cells[2][2].value === "33"
    && await ui.locator("#math-preview").evaluate((img) => img.complete && img.naturalWidth > 0));
  await action("close-panel");
  const matrixCancelled = await capture("studio-matrix-cancelled");
  await check("cancelling a graphical matrix draft leaves the source unchanged", doc(matrixCancelled, "fresh").hash === beforeMatrix.documents.find((d) => d.key === "fresh").hash);
  await action("open-formula"); ui = await frame();
  await ui.getByRole("button", { name: "LaTeX", exact: true }).click(); await ui.locator("#latex").fill("");
  await pause(250); await action("hide-panel"); await action("show-panel"); ui = await frame();
  const incomplete = await capture("studio-incomplete-draft-restored");
  await check("an incomplete LaTeX draft survives webview recreation as editable text", await ui.locator("#latex").isVisible()
    && await ui.locator("#latex").inputValue() === "" && doc(incomplete, "fresh").hash === doc(matrixCancelled, "fresh").hash);
  await ui.locator("#latex").fill(String.raw`\frac{1}{\sqrt{2}}`);
  await until(async () => (await request("studio-snapshot")).sessions[0]?.value.kind === "raw");
  const corrected = await capture("studio-incomplete-draft-corrected");
  await check("a restored incomplete draft can be corrected without source changes", corrected.host.sessions[0].value.kind === "raw"
    && corrected.host.sessions[0].value.tex.includes("sqrt") && doc(corrected, "fresh").hash === doc(matrixCancelled, "fresh").hash);
  await action("close-panel");
  await action("demo");
  const demo = await capture("studio-native-demo-command");
  await check("the user-facing demo command opens an editable untitled inline example", demo.host.views.some((v) => v.uri.startsWith("untitled:") && v.entries.length === 1));
  await save(); console.log(JSON.stringify({ assertions: checks.length, passed: checks.every((c) => c.passed) }));
  await request("finish");
}
main().then(() => process.exit(0)).catch(async (error) => {
  console.error(error); try { await request("finish"); } catch { /* bounded runner lifetime */ } process.exit(1);
});
