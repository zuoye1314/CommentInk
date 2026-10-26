const { chromium } = require("playwright");
const fs = require("node:fs/promises");
const path = require("node:path");
const { request, geometry, pause, until } = require("./measure-block.cjs");
const [directory, endpoint] = process.argv.slice(2);

async function main() {
  await until(async () => {
    try { return JSON.parse(await fs.readFile(path.join(directory, "ready.json"), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
  });
  const browser = await chromium.connectOverCDP(endpoint);
  const page = browser.contexts().flatMap((context) => context.pages()).find((p) => p.url().includes("workbench"));
  if (!page) throw new Error("Test workbench not found");
  const cases = [];
  async function capture(name) {
    await pause(450);
    const host = await request("block-snapshot");
    const measured = await geometry(page);
    await page.screenshot({ path: path.join(directory, `${name}.png`) });
    cases.push({ name, host, geometry: measured });
    await fs.writeFile(path.join(directory, "tiles-measurements.json"), JSON.stringify({
      capturedAt: new Date().toISOString(), cases }, null, 2));
    console.log(JSON.stringify({ name, preview: host.preview, reason: host.reason,
      sourceUnchanged: host.sourceUnchanged, attachments: measured.attachments.length,
      visibleRanges: host.visibleRanges }));
    return cases.at(-1);
  }
  const ready = await request("block-snapshot");
  await capture("tiles-baseline");
  await request("block-set", { strategy: "tiles" });
  await capture("tiles-preview");
  await request("block-action", { operation: "scroll", fields: { line: ready.bounds.bodyStart + 8 } });
  const scrolled = await capture("tiles-anchor-out");
  if (scrolled.host.visibleRanges[0][0] <= ready.bounds.bodyStart) throw new Error("Anchor still visible");
  await request("block-action", { operation: "scroll", fields: { line: 0 } });
  await capture("tiles-scroll-return");
  await request("block-action", { operation: "fold" });
  await capture("tiles-folded");
  await request("block-action", { operation: "unfold" });
  await capture("tiles-unfolded");
  await page.setViewportSize({ width: 700, height: 800 });
  await request("block-action", { operation: "wrap" });
  await capture("tiles-narrow-wrapped");
  await request("block-action", { operation: "wrap" });
  await page.setViewportSize({ width: 1200, height: 800 });
  await request("block-action", { operation: "scroll", fields: { line: 0 } });
  const beforeClick = await capture("tiles-before-click");
  const body = beforeClick.geometry.lines.find((line) => line.text.includes("// title:"));
  await page.mouse.click(body.x + 100, body.y + 60);
  await until(async () => !(await request("block-snapshot")).preview);
  await capture("tiles-click-source-revealed");
  await request("block-set", { strategy: "tiles" });
  await request("block-config", { fontSize: 20, lineHeight: 30 });
  await capture("tiles-font-change-fallback");
  await request("block-set", { strategy: "tiles" });
  await capture("tiles-font-20-line-30");
  await request("block-config", { fontSize: 14, lineHeight: 22 });
  await request("block-action", { operation: "scroll", fields: { line: 0 } });
  await request("block-clear");
  await capture("tiles-cleared");
  await request("finish");
}
main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
