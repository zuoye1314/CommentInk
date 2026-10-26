// External test instrument: only the harness reads workbench layout.
const { chromium } = require("playwright");
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const { renderFormula } = require("./formula-renderer.cjs");
const { visualSignature } = require("./formula-reflow.cjs");
const { request, geometry, pause, until } = require("./measure-block.cjs");
const [directory, endpoint] = process.argv.slice(2);
const action = (operation, fields = {}) => request("formula-action", { operation, fields });

async function main() {
  await until(async () => {
    try { return JSON.parse(await fs.readFile(path.join(directory, "ready.json"), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  });
  const browser = await chromium.connectOverCDP(endpoint);
  const page = await until(() => browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("workbench")));
  const cases = [], checks = [];
  const save = () => fs.writeFile(path.join(directory, "layout-measurements.json"), JSON.stringify({
    capturedAt: new Date().toISOString(), cases, checks }, null, 2));
  async function capture(name) {
    await pause(500);
    const host = await request("formula-snapshot"), measured = await geometry(page);
    await page.screenshot({ path: path.join(directory, `${name}.png`) });
    const entry = { name, host, geometry: measured };
    cases.push(entry);
    await save();
    console.log(JSON.stringify({ name, preview: host.preview, lineHeight: host.lineHeight,
      mode: host.lineHeightMode, tileCount: host.tileCount, attachments: measured.attachments.length }));
    return entry;
  }
  async function check(name, predicate) {
    checks.push({ name, passed: Boolean(predicate) });
    await save();
    assert.ok(predicate, name);
  }
  const visible = (s) => s.host.preview && s.geometry.attachments.length === s.host.tileCount;
  function aligned(s) {
    const rows = s.geometry.lines.filter((l) => l.text.trimStart().startsWith("# "));
    const heights = rows.map((l) => l.height);
    const tiles = s.geometry.attachments;
    return heights.length > 2 && heights.every((h) => Math.abs(h - s.host.lineHeight) < 0.1)
      && tiles.every((a) => Math.abs(parseFloat(a.height) - s.host.lineHeight) < 0.1)
      && tiles.slice(1).every((a, i) => Math.abs(a.owner.y - tiles[i].owner.y - s.host.lineHeight) < 0.2);
  }
  const baseline = await capture("layout-source-default");
  await request("formula-show");
  const initial = await capture("layout-auto-14");
  await check("default preview keeps exact source and dirty state", initial.host.sourceHash === baseline.host.sourceHash
    && initial.host.isDirty === baseline.host.isDirty && initial.host.version === baseline.host.version);
  await check("default 14px uses actual 19px rows with contiguous SVG slices", visible(initial) && aligned(initial));
  for (const [fontSize, lineHeight, expected, name] of [
    [20, 0, 27, "layout-auto-20"], [13.5, 0, 18, "layout-auto-fractional-font"],
    [14, 1.5, 21, "layout-relative-1-5"], [14, 22.5, 23, "layout-pixels-22-5"],
    [14, 0, 19, "layout-auto-restored"],
  ]) {
    await request("formula-config", { fontSize, lineHeight });
    const s = await capture(name);
    await check(`${name}: measured native rows match resolved slices`, visible(s) && aligned(s) && s.host.lineHeight === expected);
    await check(`${name}: configuration changes leave source untouched`, s.host.sourceHash === baseline.host.sourceHash
      && s.host.version === baseline.host.version && s.host.isDirty === baseline.host.isDirty);
  }
  await action("focus", { where: "before", column: "end" });
  await page.keyboard.type(" default-above", { delay: 15 });
  await action("focus", { where: "after", column: "end" });
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  const line = (await request("formula-snapshot")).selection[0];
  const sourceLine = (await request("formula-snapshot")).sourceText.split("\n")[line];
  await page.keyboard.insertText((/^\s*#\s*$/.test(sourceLine) ? "" : "# ") + "DEFAULT_BELOW: ordinary comment");
  const typing = await capture("layout-auto-typing");
  await check("auto height supports above/below editing with visible formula", visible(typing) && aligned(typing)
    && typing.host.fingerprint === initial.host.fingerprint
    && typing.host.sourceText.indexOf("DEFAULT_BELOW") > typing.host.sourceText.indexOf("@math end"));
  await action("replace", { example: "fraction" });
  const tall = await capture("layout-auto-tall");
  await check("high nested formula uses contiguous default-height slices", visible(tall) && aligned(tall));
  await action("scroll", { line: tall.host.bounds.bodyStart + 8 });
  const scrolled = await capture("layout-auto-scrolled");
  await check("default-height slices survive scrolling past their first anchor", scrolled.host.preview
    && scrolled.geometry.attachments.length > 0 && scrolled.geometry.attachments.length < tall.host.tileCount);
  await action("scroll", { line: 0 });
  await page.setViewportSize({ width: 700, height: 800 });
  await action("wrap");
  const narrow = await capture("layout-auto-narrow");
  await check("default-height high formula remains contiguous in tested narrow wrapped window", visible(narrow) && aligned(narrow));
  await action("wrap");
  await page.setViewportSize({ width: 1200, height: 800 });
  await action("replace", { example: "short" });
  const short = await capture("layout-short-source");
  await check("short-source blocker remains explicit without fake padding or overlapping preview", !short.host.preview
    && short.host.reason === "insufficient-existing-comment-lines" && short.host.bounds.bodyCount === 1
    && short.geometry.attachments.length === 0);
  const shortHash = short.host.sourceHash;
  await request("formula-show");
  const retry = await capture("layout-short-retried");
  await check("retrying insufficient source does not modify the document", retry.host.sourceHash === shortHash
    && retry.host.version === short.host.version && retry.geometry.attachments.length === 0);
  await request("formula-format");
  const formatted = await capture("layout-short-formatted");
  await check("explicit format command makes the one-line high formula visible without empty padding", visible(formatted)
    && aligned(formatted) && formatted.host.bounds.bodyCount === formatted.host.tileCount
    && formatted.host.tex.split("\n").every((line) => line.trim()));
  await check("explicit formatting preserves every original non-newline character and SVG geometry",
    formatted.host.tex.replace(/\n/g, "") === short.host.tex
    && visualSignature(renderFormula(formatted.host.tex).svg) === visualSignature(renderFormula(short.host.tex).svg));
  const beforeText = short.host.sourceText.slice(0, short.host.sourceText.indexOf("@math begin"));
  const afterText = short.host.sourceText.slice(short.host.sourceText.indexOf("@math end"));
  await check("formatting leaves all preceding and following comments/code untouched", formatted.host.sourceText.startsWith(beforeText)
    && formatted.host.sourceText.endsWith(afterText));
  await request("formula-format");
  const repeated = await capture("layout-formatted-repeated");
  await check("format command is idempotent once enough actual TeX lines exist", visible(repeated)
    && repeated.host.sourceHash === formatted.host.sourceHash && repeated.host.version === formatted.host.version);
  await action("undo");
  const undo = await capture("layout-format-undone");
  await check("one native undo restores exact original single-line formula and surroundings", undo.host.sourceHash === shortHash);
  await action("redo");
  await request("formula-show");
  const redo = await capture("layout-format-redone");
  await check("redo restores formatted source and visible preview", visible(redo) && aligned(redo)
    && redo.host.sourceHash === formatted.host.sourceHash);
  await page.setViewportSize({ width: 700, height: 800 });
  await action("wrap");
  const formattedNarrow = await capture("layout-formatted-narrow");
  await check("reformatted high formula stays contiguous in the tested narrow wrapped view", visible(formattedNarrow) && aligned(formattedNarrow));
  await action("wrap");
  await page.setViewportSize({ width: 1200, height: 800 });
  await action("replace", { example: "invalid" });
  const invalid = await capture("layout-format-invalid-before");
  await request("formula-format");
  const invalidAfter = await capture("layout-format-invalid-after");
  await check("failed formatting of invalid TeX does not modify source", !invalidAfter.host.preview
    && invalidAfter.host.sourceHash === invalid.host.sourceHash && invalidAfter.host.version === invalid.host.version);
  await save();
  console.log(JSON.stringify({ assertions: checks.length, passed: checks.every((c) => c.passed) }));
  await request("finish");
}
main().then(() => process.exit(0)).catch(async (error) => {
  console.error(error);
  try { await request("finish"); } catch { /* the runner also has a bounded lifetime */ }
  process.exit(1);
});
