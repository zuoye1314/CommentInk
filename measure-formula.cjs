const { chromium } = require("playwright");
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const { request, geometry, pause, until } = require("./measure-block.cjs");
const [directory, endpoint] = process.argv.slice(2);
const action = (operation, fields = {}) => request("formula-action", { operation, fields });

async function main() {
  await until(async () => {
    try { return JSON.parse(await fs.readFile(path.join(directory, "ready.json"), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
  });
  const browser = await chromium.connectOverCDP(endpoint);
  const page = await until(async () => browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("workbench")));
  const cases = [], checks = [];
  async function save() {
    await fs.writeFile(path.join(directory, "formula-measurements.json"), JSON.stringify({
      capturedAt: new Date().toISOString(), cases, checks }, null, 2));
  }
  async function capture(name) {
    await pause(450);
    const host = await request("formula-snapshot");
    const measured = await geometry(page);
    await page.screenshot({ path: path.join(directory, `${name}.png`) });
    const result = { name, host, geometry: measured };
    cases.push(result);
    await save();
    console.log(JSON.stringify({ name, preview: host.preview, reason: host.reason,
      dimensions: host.dimensions, attachments: measured.attachments.length, tail: host.tail }));
    return result;
  }
  function check(name, predicate) {
    checks.push({ name, passed: Boolean(predicate) });
    assert.ok(predicate, name);
  }
  function visibleFormula(stage) {
    return stage.host.preview && stage.geometry.attachments.length === stage.host.tileCount;
  }
  function codeGap(stage) {
    const before = stage.geometry.lines.find((line) => line.text.includes("BEFORE_FORMULA"));
    const after = stage.geometry.lines.find((line) => line.text.includes("AFTER_FORMULA"));
    return before && after ? after.y - before.y : null;
  }
  async function addComment(where, label) {
    await action("focus", { where, column: "end" });
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    const s = await request("formula-snapshot");
    const currentLine = s.sourceText.split(/\r?\n/)[s.selection[0]];
    await page.keyboard.insertText((/^\s*#\s*$/.test(currentLine) ? "" : "# ") + label);
  }
  const baseline = await capture("formula-source-baseline");
  await request("formula-show", { options: { compact: false, zeroWidth: true } });
  const expanded = await capture("formula-preview-expanded");
  check("real SVG formula preserves source", expanded.host.preview && expanded.host.sourceHash === baseline.host.sourceHash);
  await request("formula-show", { options: { compact: true } });
  const compact = await capture("formula-preview-compact");
  check("compact folding reduces occupied height", codeGap(compact) < codeGap(expanded));
  await action("focus", { where: "before", column: "end" });
  await page.keyboard.type(" typed-above", { delay: 12 });
  const above = await capture("formula-type-above");
  check("typing above keeps visible formula", visibleFormula(above) && above.host.fingerprint === compact.host.fingerprint);
  await addComment("before", "ABOVE_NEW: ordinary comment");
  const newAbove = await capture("formula-new-line-above");
  check("new upper comment stays outside block", visibleFormula(newAbove)
    && newAbove.host.sourceText.indexOf("ABOVE_NEW") < newAbove.host.sourceText.indexOf("@math begin"));
  await action("focus", { where: "after", column: "end" });
  await page.keyboard.type(" typed-below", { delay: 12 });
  await addComment("after", "BELOW_NEW: ordinary comment");
  const below = await capture("formula-new-line-below");
  check("typing below keeps visible formula", visibleFormula(below) && below.host.fingerprint === compact.host.fingerprint);
  check("new lower comment stays outside block", below.host.sourceText.indexOf("BELOW_NEW") > below.host.sourceText.indexOf("@math end"));
  const surroundings = below.host.sourceText;
  await action("replace", { example: "matrix" });
  const matrix = await capture("formula-matrix-updated");
  check("formula update keeps annotations", visibleFormula(matrix) && ["typed-above", "ABOVE_NEW", "typed-below", "BELOW_NEW"]
    .every((label) => matrix.host.sourceText.includes(label)));
  await action("undo");
  const undone = await capture("formula-update-undone");
  check("one undo restores just formula update", undone.host.sourceText === surroundings);
  await request("formula-show");
  await page.setViewportSize({ width: 700, height: 800 });
  await action("wrap");
  const wrapped = await capture("formula-narrow-wrapped");
  check("narrow wrapped view retains preview", wrapped.host.preview && wrapped.geometry.attachments.length === wrapped.host.tileCount);
  await action("wrap");
  await page.setViewportSize({ width: 1200, height: 800 });
  await request("formula-config", { fontSize: 20, lineHeight: 30 });
  const enlarged = await capture("formula-font-20-line-30");
  check("font change rebuilds measured formula", visibleFormula(enlarged) && enlarged.host.dimensions.height > compact.host.dimensions.height);
  await request("formula-config", { fontSize: 14, lineHeight: 22 });
  await action("fold");
  const folded = await capture("formula-fully-folded");
  check("folded formula has no leaked image", folded.geometry.attachments.length === 0);
  await action("unfold");
  await request("formula-show");
  const unfolded = await capture("formula-unfolded");
  check("unfold restores visible formula", visibleFormula(unfolded));
  await action("focus", { where: "before", column: 0 });
  await page.keyboard.press("ArrowDown");
  const entered = await capture("formula-keyboard-enters-source");
  check("keyboard entry reveals editable source", !entered.host.preview && entered.host.reason === "caret-entered-formula");
  await request("formula-show");
  await action("select");
  const copied = await action("copy");
  check("copy contains complete original formula source", copied.clipboard === copied.selectedText
    && copied.clipboard.includes("@math begin") && copied.clipboard.includes("\\int") && copied.clipboard.includes("@math end"));
  await capture("formula-selected-source");
  await request("formula-show");
  await action("focus", { where: "after", column: 0 });
  const beforeDelete = await request("formula-snapshot");
  await page.keyboard.press("Backspace");
  const invalidBoundary = await capture("formula-boundary-delete");
  check("boundary deletion reveals invalid source", !invalidBoundary.host.preview && Boolean(invalidBoundary.host.parseError));
  await page.keyboard.press("Control+z");
  const restored = await capture("formula-boundary-undo");
  check("boundary undo restores text", restored.host.sourceText === beforeDelete.sourceText);
  await request("formula-show");
  await action("replace", { example: "fraction" });
  const fraction = await capture("formula-nested-fraction");
  check("nested fraction renders", fraction.host.preview);
  await action("scroll", { line: fraction.host.bounds.bodyStart + 8 });
  const scrolled = await capture("formula-scroll-anchor-out");
  check("formula remains partially visible after its anchor leaves", scrolled.host.visibleRanges[0][0] > fraction.host.bounds.bodyStart
    && scrolled.geometry.attachments.length > 0 && scrolled.geometry.attachments.length < fraction.host.tileCount);
  await action("scroll", { line: 0 });
  const returned = await capture("formula-scroll-return");
  check("scroll return restores complete formula", visibleFormula(returned));
  const firstBody = returned.geometry.lines.find((line) => line.text.includes("# f(x)="));
  await page.mouse.click(firstBody.x + 80, firstBody.y + 30);
  const clicked = await capture("formula-click-source");
  check("clicking formula reveals source", !clicked.host.preview && clicked.host.reason === "caret-entered-formula");
  await request("formula-show");
  await request("formula-config", { fontSize: 14, lineHeight: 0 });
  const automatic = await capture("formula-automatic-line-height");
  check("default automatic line height keeps visible formula", visibleFormula(automatic)
    && automatic.host.lineHeight === 19 && automatic.host.configuredLineHeight === 0);
  await request("formula-config", { fontSize: 14, lineHeight: 22 });
  await request("formula-show");
  await action("replace", { example: "short" });
  const insufficient = await capture("formula-insufficient-lines");
  check("short source falls back without covering code", !insufficient.host.preview
    && insufficient.host.reason === "insufficient-existing-comment-lines" && insufficient.geometry.attachments.length === 0);
  await action("replace", { example: "invalid" });
  const invalidMath = await capture("formula-invalid-tex");
  check("invalid TeX leaves visible source", !invalidMath.host.preview && invalidMath.geometry.attachments.length === 0);
  await action("replace", { example: "objective" });
  await capture("formula-restored-objective");
  await action("new-document");
  const insertion = request("formula-insert");
  await page.getByText("复杂积分与求和", { exact: true }).click();
  await insertion;
  const inserted = await capture("formula-insert-command");
  check("insert command keeps upper and lower text", inserted.host.preview
    && inserted.host.sourceText.startsWith("# BEFORE_FORMULA") && inserted.host.sourceText.includes("# AFTER_FORMULA"));
  await action("undo");
  const insertionUndo = await capture("formula-insert-undone");
  check("insertion is one reversible edit", insertionUndo.host.sourceText === "# BEFORE_FORMULA: introduction\n# AFTER_FORMULA: explanation\n");
  await save();
  console.log(JSON.stringify({ assertions: checks.length, passed: checks.every((item) => item.passed) }));
  await request("finish");
}
main().then(() => process.exit(0)).catch(async (error) => {
  console.error(error);
  try { await request("finish"); } catch { /* runner timeout also cleans up */ }
  process.exit(1);
});
