const { chromium } = require("playwright");
const fs = require("node:fs/promises");
const path = require("node:path");
const { request, geometry, pause, until } = require("./measure-block.cjs");
const [directory, endpoint] = process.argv.slice(2);

async function main() {
  const browser = await chromium.connectOverCDP(endpoint);
  const page = browser.contexts().flatMap((context) => context.pages()).find((p) => p.url().includes("workbench"));
  if (!page) throw new Error("Test workbench not found");
  const cases = [];
  async function capture(name) {
    await pause(500);
    const host = await request("block-snapshot");
    const measured = await geometry(page);
    await page.screenshot({ path: path.join(directory, `${name}.png`) });
    cases.push({ name, host, geometry: measured });
    await fs.writeFile(path.join(directory, "block-more-measurements.json"), JSON.stringify({
      capturedAt: new Date().toISOString(), cases }, null, 2));
    console.log(JSON.stringify({ name, preview: host.preview, reason: host.reason,
      sourceUnchanged: host.sourceUnchanged, attachments: measured.attachments.length,
      visibleRanges: host.visibleRanges }));
    return cases.at(-1);
  }
  const initial = await request("block-snapshot");
  await request("block-action", { operation: "scroll", fields: { line: 0 } });
  await request("block-set");
  await request("block-action", { operation: "scroll", fields: { line: initial.bounds.bodyStart + 8 } });
  const scrolled = await capture("whole-true-anchor-out");
  if (scrolled.host.visibleRanges[0][0] <= initial.bounds.bodyStart) {
    throw new Error("Scroll did not move the anchor outside the visible range");
  }
  await request("block-action", { operation: "scroll", fields: { line: initial.bounds.end + 12 } });
  await capture("whole-entire-block-out");
  await request("block-action", { operation: "scroll", fields: { line: 0 } });
  await capture("whole-return-after-anchor-out");
  await page.setViewportSize({ width: 700, height: 800 });
  await request("block-action", { operation: "wrap" });
  await capture("whole-narrow-wrapped");
  await request("block-action", { operation: "wrap" });
  await page.setViewportSize({ width: 1200, height: 800 });
  await request("block-action", { operation: "scroll", fields: { line: 0 } });
  const beforeClick = await capture("whole-before-click");
  const body = beforeClick.geometry.lines.find((line) => line.text.includes("// title:"));
  if (!body) throw new Error("Body line not rendered");
  await page.mouse.click(body.x + 100, body.y + 60);
  await until(async () => !(await request("block-snapshot")).preview);
  await capture("whole-click-source-revealed");
  await request("block-action", { operation: "select" });
  const copied = await request("block-action", { operation: "copy" });
  const copyChecks = { matchesSelection: copied.clipboard === copied.selectedText,
    includesBegin: copied.clipboard.includes("@comment-diagram begin"),
    includesFormula: copied.clipboard.includes("\\frac"), includesEnd: copied.clipboard.includes("@comment-diagram end") };
  await fs.writeFile(path.join(directory, "clipboard-check-more.json"), JSON.stringify(copyChecks, null, 2));
  console.log(JSON.stringify({ copyChecks }));
  if (!process.env.COMMENT_PREVIEW_KEEP_OPEN) await request("finish");
}
main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
