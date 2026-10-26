// External TEST harness: observes geometry through Chromium debugging.
// The extension under test uses only stable VS Code APIs and never accesses DOM.
const { chromium } = require("playwright");
const fs = require("node:fs/promises");
const path = require("node:path");

const [directory, endpoint] = process.argv.slice(2);
if (!directory || !endpoint) throw new Error("Usage: measure.cjs OUTPUT_DIRECTORY CDP_ENDPOINT");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(fn, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try { const result = await fn(); if (result) return result; } catch (error) { lastError = error; }
    await pause(100);
  }
  throw new Error(`Probe wait timed out: ${lastError?.message || "condition unmet"}`);
}

async function request(action, fields = {}) {
  const id = `${Date.now()}-${Math.random()}`;
  await fs.writeFile(path.join(directory, "request.tmp"), JSON.stringify({ id, action, ...fields }));
  await fs.rename(path.join(directory, "request.tmp"), path.join(directory, "request.json"));
  return until(async () => {
    const response = JSON.parse(await fs.readFile(path.join(directory, "response.json"), "utf8"));
    if (response.id !== id) return undefined;
    if (response.error) throw new Error(response.error);
    return response;
  });
}

async function geometry(page) {
  return page.evaluate(() => {
    const lines = Array.from(document.querySelectorAll(".monaco-editor .view-lines .view-line"));
    const rect = (element) => {
      const b = element.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    };
    const selected = lines.filter((element) => /BEFORE_PROBE|@comment-diagram probe|AFTER_PROBE|NEIGHBOR_0[234]/.test(element.textContent));
    const attachments = [];
    for (const line of lines) {
      for (const element of [line, ...line.querySelectorAll("span")]) {
        for (const pseudo of ["::before", "::after"]) {
          const style = getComputedStyle(element, pseudo);
          if (style.backgroundImage.includes("diagram.svg") || style.content.includes("diagram.svg")) {
            attachments.push({ line: line.textContent, pseudo, owner: rect(element),
              content: style.content, backgroundImage: style.backgroundImage,
              width: style.width, height: style.height, display: style.display,
              verticalAlign: style.verticalAlign });
          }
        }
      }
    }
    return { lines: selected.map((element) => ({ text: element.textContent, ...rect(element) })), attachments };
  });
}

async function main() {
  const ready = await until(async () => JSON.parse(await fs.readFile(path.join(directory, "ready.json"), "utf8")));
  const browser = await chromium.connectOverCDP(endpoint);
  const page = await until(async () => {
    for (const context of browser.contexts()) {
      for (const candidate of context.pages()) {
        if (candidate.url().includes("workbench")) return candidate;
      }
    }
  });
  await until(async () => (await geometry(page)).lines.length >= 3);
  await page.screenshot({ path: path.join(directory, "baseline.png") });
  const baseline = await geometry(page);
  const cases = [];
  for (const placement of ["after", "before"]) {
    for (const height of [20, 80, 180]) {
      const response = await request("set", { height, placement });
      await until(async () => {
        const measured = await geometry(page);
        return measured.attachments.some((item) => item.height === `${height}px`) && measured;
      });
      await page.screenshot({ path: path.join(directory, `${placement}-${height}.png`) });
      cases.push({ height, placement, host: response.result, geometry: await geometry(page) });
    }
  }
  const cleared = await request("clear");
  await until(async () => !(await geometry(page)).attachments.length);
  const afterClear = await geometry(page);
  await page.screenshot({ path: path.join(directory, "cleared.png") });
  const result = { capturedAt: new Date().toISOString(), ready, baseline, cases,
    cleared: cleared.result, afterClear,
    scope: "Image attachment geometry only; formula rendering, mouse editing, folding and other compatibility remain untested." };
  await fs.writeFile(path.join(directory, "measurements.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ version: ready.vscodeVersion, cases: cases.map((item) => ({
    placement: item.placement, height: item.height, sourceUnchanged: item.host.sourceUnchanged,
    lines: item.geometry.lines, attachments: item.geometry.attachments,
  })) }, null, 2));
  await request("finish");
  // Avoid closing the user's other browser sessions; this endpoint belongs only
  // to the isolated test instance, which exits when the runner finishes.
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
