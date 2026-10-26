const vscode = require("vscode");
const crypto = require("node:crypto");
const { createBlockProbe } = require("./block-probe.cjs");
const { createFormulaProbe } = require("./formula-probe.cjs");
const { createStudio } = require("./studio/index.cjs");

function activate(context) {
  let editor;
  let decoration;
  let initialText;
  let mode = { height: 0, placement: "after" };

  async function openFixture() {
    const uri = vscode.Uri.joinPath(context.extensionUri, "fixture.js");
    const document = await vscode.workspace.openTextDocument(uri);
    initialText = document.getText();
    editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    return snapshot();
  }

  function snapshot() {
    const document = editor.document;
    const text = document.getText();
    return {
      vscodeVersion: vscode.version,
      height: mode.height,
      placement: mode.placement,
      uri: document.uri.toString(),
      version: document.version,
      isDirty: document.isDirty,
      sourceUnchanged: text === initialText,
      sourceHash: crypto.createHash("sha256").update(text).digest("hex"),
      lineCount: document.lineCount,
      selection: [editor.selection.active.line, editor.selection.active.character],
    };
  }

  function clear() {
    if (decoration) decoration.dispose();
    decoration = undefined;
    mode = { height: 0, placement: "after" };
    return snapshot();
  }

  async function setAttachment(height, placement = "after") {
    if (![20, 80, 180].includes(height) || !["before", "after"].includes(placement)) {
      throw new Error("Unsupported probe configuration");
    }
    if (!editor) await openFixture();
    clear();
    const markerLine = editor.document.getText().split(/\r?\n/)
      .findIndex((line) => line.includes("@comment-diagram probe"));
    if (markerLine < 0) throw new Error("Fixture marker missing");
    const position = placement === "after"
      ? editor.document.lineAt(markerLine).range.end
      : new vscode.Position(markerLine, 0);
    decoration = vscode.window.createTextEditorDecorationType({
      [placement]: {
        contentIconPath: vscode.Uri.joinPath(context.extensionUri, "diagram.svg"),
        height: `${height}px`,
        width: "420px",
        margin: "0 8px",
      },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
    mode = { height, placement };
    editor.setDecorations(decoration, [new vscode.Range(position, position)]);
    return snapshot();
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("commentPreviewProbe.show", () => setAttachment(180)),
    vscode.commands.registerCommand("commentPreviewProbe.clear", clear),
    { dispose() { if (decoration) decoration.dispose(); } },
  );
  return { openFixture, setAttachment, clear, snapshot,
    ...createBlockProbe(context), ...createFormulaProbe(context), ...createStudio(context) };
}

module.exports = { activate };
