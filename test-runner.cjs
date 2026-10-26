// Test-only control channel. This is not part of the proposed product.
const vscode = require("vscode");
const fs = require("node:fs/promises");
const path = require("node:path");

async function run() {
  const directory = process.env.COMMENT_PREVIEW_PROBE_DIR;
  if (!directory) throw new Error("COMMENT_PREVIEW_PROBE_DIR is required");
  const extension = vscode.extensions.getExtension("zuoye.comment-preview-probe");
  if (!extension) throw new Error("Development extension not found");
  const api = await extension.activate();
  const blockMode = process.env.COMMENT_PREVIEW_PROBE_MODE === "block";
  const formulaMode = process.env.COMMENT_PREVIEW_PROBE_MODE === "formula";
  const clipboardMode = blockMode || formulaMode;
  // Keep clipboard tests reversible. Never serialize the previous clipboard.
  const previousClipboard = clipboardMode ? await vscode.env.clipboard.readText() : undefined;
  let copiedByTest;
  async function restoreClipboard() {
    if (clipboardMode && copiedByTest !== undefined
        && await vscode.env.clipboard.readText() === copiedByTest) {
      await vscode.env.clipboard.writeText(previousClipboard);
    }
  }
  const initial = formulaMode ? await api.openFormulaFixture()
    : blockMode ? await api.openBlockFixture() : await api.openFixture();
  await fs.writeFile(path.join(directory, "ready.json"), JSON.stringify(initial, null, 2));
  let previousId;
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    let request;
    try {
      request = JSON.parse(await fs.readFile(path.join(directory, "request.json"), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    if (request && request.id !== previousId) {
      previousId = request.id;
      try {
        let result;
        if (request.action === "set") result = await api.setAttachment(request.height, request.placement);
        else if (request.action === "clear") result = api.clear();
        else if (request.action === "snapshot") result = api.snapshot();
        else if (request.action === "block-set") result = await api.setBlockPreview(request.strategy);
        else if (request.action === "block-clear") result = api.blockClear();
        else if (request.action === "block-snapshot") result = api.blockSnapshot();
        else if (request.action === "block-action") {
          result = await api.blockAction(request.operation, request.fields);
          if (request.operation === "copy") copiedByTest = result.clipboard;
        }
        else if (request.action === "formula-show") result = await api.showFormula(request.options);
        else if (request.action === "formula-source") result = await api.revealFormula();
        else if (request.action === "formula-snapshot") result = api.formulaSnapshot();
        else if (request.action === "formula-action") {
          result = await api.formulaAction(request.operation, request.fields);
          if (request.operation === "copy") copiedByTest = result.clipboard;
        }
        else if (request.action === "formula-insert") {
          result = await vscode.commands.executeCommand("commentPreviewProbe.formulaInsert");
        }
        else if (request.action === "formula-format") {
          result = await vscode.commands.executeCommand("commentPreviewProbe.formulaFormat");
        }
        else if (request.action === "block-config" || request.action === "formula-config") {
          for (const key of ["fontSize", "lineHeight"]) {
            const value = request[key];
            if (!Number.isFinite(value) || value > 40 || value < 0
                || (key === "fontSize" && value < 10)) {
              throw new Error("Invalid test font setting");
            }
            await vscode.workspace.getConfiguration("editor").update(key, value, vscode.ConfigurationTarget.Global);
          }
          result = formulaMode ? api.formulaSnapshot() : api.blockSnapshot();
        }
        else if (request.action === "finish") {
          if (formulaMode) await api.revealFormula();
          else if (blockMode) api.blockClear();
          else api.clear();
          await restoreClipboard();
          await fs.writeFile(path.join(directory, "response.json"), JSON.stringify({ id: request.id, finished: true }));
          return;
        } else throw new Error("Unknown test action");
        await fs.writeFile(path.join(directory, "response.json"), JSON.stringify({ id: request.id, result }, null, 2));
      } catch (error) {
        await fs.writeFile(path.join(directory, "response.json"), JSON.stringify({ id: request.id, error: error.message }));
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await restoreClipboard();
  throw new Error("Probe timed out before finish command");
}

module.exports = { run };
