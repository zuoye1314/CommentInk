// External test instrumentation only. The tested extension has no DOM access.
const { chromium } = require("playwright");
const fs = require("node:fs/promises");
const path = require("node:path");

const [directory, endpoint] = process.argv.slice(2);
if (!directory || !endpoint) throw new Error("Usage: measure-block.cjs OUTPUT_DIRECTORY CDP_ENDPOINT");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await fn();
    if (result) return result;
    await pause(100);
  }
  throw new Error("Timed out waiting for probe");
}
async function request(action, fields = {}) {
  const id = `${Date.now()}-${Math.random()}`;
  await fs.writeFile(path.join(directory, "request.tmp"), JSON.stringify({ id, action, ...fields }));
  await fs.rename(path.join(directory, "request.tmp"), path.join(directory, "request.json"));
  return until(async () => {
    let response;
    try { response = JSON.parse(await fs.readFile(path.join(directory, "response.json"), "utf8")); }
    catch (error) { if (error.code === "ENOENT" || error instanceof SyntaxError) return; throw error; }
    if (response.id !== id) return;
    if (response.error) throw new Error(response.error);
    return response.result || response;
  });
}
async function geometry(page) {
  return page.evaluate(() => {
    const rect = (element) => {
      const b = element.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    };
    const normalize = (value) => value.replace(/\u00a0/g, " ");
    const lines = Array.from(document.querySelectorAll(".monaco-editor .view-lines .view-line"));
    const data = lines.map((line) => ({ text: normalize(line.textContent), ...rect(line),
      spans: Array.from(line.querySelectorAll("span")).filter((el) => el.childElementCount === 0)
        .map((el) => ({ text: normalize(el.textContent), color: getComputedStyle(el).color })) }));
    const attachments = [];
    for (const line of lines) {
      for (const element of [line, ...line.querySelectorAll("span")]) {
        for (const pseudo of ["::before", "::after"]) {
          const s = getComputedStyle(element, pseudo);
          if (s.content.includes(".svg") || s.backgroundImage.includes(".svg")
              || s.content.includes("data:image/svg+xml")) {
            attachments.push({ line: normalize(line.textContent), pseudo, owner: rect(element),
              content: s.content, backgroundImage: s.backgroundImage,
              width: s.width, height: s.height, display: s.display });
          }
        }
      }
    }
    const viewport = document.querySelector(".monaco-editor .overflow-guard");
    return { viewport: viewport && rect(viewport), devicePixelRatio, lines: data, attachments };
  });
}
async function main() {
  const ready = await until(async () => {
    try { return JSON.parse(await fs.readFile(path.join(directory, "ready.json"), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
  });
  const browser = await chromium.connectOverCDP(endpoint);
  const page = await until(async () => browser.contexts().flatMap((c) => c.pages())
    .find((p) => p.url().includes("workbench")));
  await until(async () => (await geometry(page)).lines.some((l) => l.text.includes("BEFORE_BLOCK")));
  const cases = [];
  async function capture(name) {
    await pause(350);
    const host = await request("block-snapshot");
    const measured = await geometry(page);
    await page.screenshot({ path: path.join(directory, `${name}.png`) });
    const result = { name, host, geometry: measured };
    cases.push(result);
    await fs.writeFile(path.join(directory, "block-measurements.json"), JSON.stringify({
      capturedAt: new Date().toISOString(), ready, cases }, null, 2));
    console.log(JSON.stringify({ name, preview: host.preview, reason: host.reason,
      sourceUnchanged: host.sourceUnchanged, attachments: measured.attachments.length,
      visibleRanges: host.visibleRanges }));
    return result;
  }
  await capture("baseline");
  await request("block-set");
  await capture("whole-preview");
  await request("block-action", { operation: "scroll", fields: { line: ready.bounds.bodyStart + 5 } });
  await capture("whole-scroll-anchor-out");
  await request("block-action", { operation: "scroll", fields: { line: 0 } });
  await capture("whole-scroll-return");
  await request("block-action", { operation: "fold" });
  await capture("whole-folded");
  await request("block-action", { operation: "unfold" });
  await capture("whole-unfolded");
  await request("block-action", { operation: "wrap" });
  await capture("whole-wrapped");
  await request("block-action", { operation: "wrap" });
  await request("block-action", { operation: "select" });
  await capture("selection-source-revealed");
  const copied = await request("block-action", { operation: "copy" });
  await fs.writeFile(path.join(directory, "clipboard-check.json"), JSON.stringify({
    matchesSelection: copied.clipboard === copied.selectedText,
    includesBegin: copied.clipboard.includes("@comment-diagram begin"),
    includesFormula: copied.clipboard.includes("\\frac"),
    includesEnd: copied.clipboard.includes("@comment-diagram end"),
  }, null, 2));
  await request("block-set");
  await request("block-action", { operation: "edit" });
  await capture("source-edit-reveals");
  await request("block-action", { operation: "undo" });
  await capture("source-undo-restores");
  await request("block-set");
  await request("block-config", { fontSize: 20, lineHeight: 30 });
  await capture("font-20-line-30");
  await request("block-config", { fontSize: 14, lineHeight: 22 });
  await request("block-action", { operation: "scroll", fields: { line: 0 } });
  await request("block-clear");
  await capture("cleared");
  // Leave the test channel open briefly for a possible targeted follow-up.
  if (!process.env.COMMENT_PREVIEW_KEEP_OPEN) await request("finish");
}
module.exports = { request, geometry, pause, until };
if (require.main === module) {
  main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
}
