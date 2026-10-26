const vscode = require("vscode");
const crypto = require("node:crypto");

function createBlockProbe(context) {
  let editor;
  let initialText;
  let types = [];
  let state = { preview: false, reason: "initial", strategy: "whole" };
  let tileGeneration = 0;

  function bounds() {
    const lines = editor.document.getText().split(/\r?\n/);
    const start = lines.findIndex((line) => line.includes("@comment-diagram begin"));
    const end = lines.findIndex((line) => line.includes("@comment-diagram end"));
    if (start < 0 || end <= start) throw new Error("Invalid block fixture");
    return { start, end, bodyStart: start + 1, bodyEnd: end - 1 };
  }

  function blockSnapshot() {
    const text = editor.document.getText();
    return {
      ...state, bounds: bounds(), vscodeVersion: vscode.version,
      sourceUnchanged: text === initialText,
      sourceHash: crypto.createHash("sha256").update(text).digest("hex"),
      version: editor.document.version, isDirty: editor.document.isDirty,
      lineCount: editor.document.lineCount,
      selection: [editor.selection.start.line, editor.selection.start.character,
        editor.selection.end.line, editor.selection.end.character],
      selectedText: editor.document.getText(editor.selection),
      visibleRanges: editor.visibleRanges.map((range) => [range.start.line, range.end.line]),
    };
  }

  function blockClear(reason = "explicit") {
    ++tileGeneration;
    for (const type of types) type.dispose();
    types = [];
    state = { ...state, preview: false, reason };
    return editor ? blockSnapshot() : state;
  }

  async function openBlockFixture() {
    blockClear();
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(context.extensionUri, "multiline-fixture.js"));
    initialText = document.getText();
    editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    editor.revealRange(new vscode.Range(0, 0, 0, 0), vscode.TextEditorRevealType.AtTop);
    return blockSnapshot();
  }

  async function setBlockPreview(strategy = "whole") {
    if (!["whole", "tiles"].includes(strategy)) throw new Error("Unknown block preview strategy");
    if (!editor) await openBlockFixture();
    blockClear();
    const generation = ++tileGeneration;
    const b = bounds();
    const selected = editor.selection;
    if (selected.start.line <= b.bodyEnd && selected.end.line >= b.bodyStart) {
      editor.selection = new vscode.Selection(b.start - 1, 0, b.start - 1, 0);
    }
    const hidden = vscode.window.createTextEditorDecorationType({ color: "transparent" });
    types.push(hidden);
    editor.setDecorations(hidden, [new vscode.Range(b.bodyStart, 0, b.bodyEnd,
      editor.document.lineAt(b.bodyEnd).text.length)]);
    const lineHeight = vscode.workspace.getConfiguration("editor", editor.document).get("lineHeight");
    if (strategy === "tiles" && (!Number.isInteger(lineHeight) || lineHeight < 10 || lineHeight > 40)) {
      blockClear("explicit-line-height-required");
      return blockSnapshot();
    }
    const count = strategy === "tiles" ? Math.ceil(180 / lineHeight) : 1;
    if (count > b.bodyEnd - b.bodyStart + 1) {
      blockClear("insufficient-existing-comment-lines");
      return blockSnapshot();
    }
    let original;
    if (strategy === "tiles") {
      original = new TextDecoder().decode(await vscode.workspace.fs.readFile(
        vscode.Uri.joinPath(context.extensionUri, "diagram.svg")));
    }
    for (let index = 0; index < count; index++) {
      let uri = vscode.Uri.joinPath(context.extensionUri, "diagram.svg");
      if (strategy === "tiles") {
        const source = original.replace('width="420" height="180" viewBox="0 0 420 180"',
          `width="420" height="${lineHeight}" viewBox="0 ${index * lineHeight} 420 ${lineHeight}"`);
        // globalStorageUri can use vscode-userdata:, which is not an image URL
        // in the workbench. Embed these small, generated local SVG tiles instead.
        uri = vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(source).toString("base64")}`);
      }
      if (generation !== tileGeneration) return blockSnapshot();
      const height = strategy === "tiles" ? lineHeight : 180;
      const image = vscode.window.createTextEditorDecorationType({
        before: { contentIconPath: uri, width: "420px", height: `${height}px`, margin: "0" },
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      });
      types.push(image);
      const at = new vscode.Position(b.bodyStart + index, 0);
      editor.setDecorations(image, [new vscode.Range(at, at)]);
    }
    state = { preview: true, reason: "explicit", strategy, lineHeight, tileCount: count };
    return blockSnapshot();
  }

  async function blockAction(action, fields = {}) {
    const b = bounds();
    if (action === "fold" || action === "unfold") {
      editor.selection = new vscode.Selection(b.start, 0, b.start, 0);
      await vscode.commands.executeCommand(`editor.${action}`, { selectionLines: [b.start] });
    } else if (action === "scroll") {
      editor.revealRange(new vscode.Range(fields.line, 0, fields.line, 0), vscode.TextEditorRevealType.AtTop);
    } else if (action === "select") {
      const from = fields.from || [b.start, 0];
      const to = fields.to || [b.end, editor.document.lineAt(b.end).text.length];
      editor.selection = new vscode.Selection(from[0], from[1], to[0], to[1]);
    } else if (action === "wrap") {
      await vscode.commands.executeCommand("editor.action.toggleWordWrap");
    } else if (action === "edit") {
      const at = editor.document.lineAt(b.bodyStart + 1).range.end;
      await editor.edit((builder) => builder.insert(at, " EDIT_PROBE"));
    } else if (action === "undo") {
      await vscode.commands.executeCommand("undo");
    } else if (action === "copy") {
      await vscode.commands.executeCommand("editor.action.clipboardCopyAction");
      return { ...blockSnapshot(), clipboard: await vscode.env.clipboard.readText() };
    } else throw new Error("Unknown block action");
    // Selection events are asynchronous relative to Selection assignment.
    await new Promise((resolve) => setTimeout(resolve, 100));
    return blockSnapshot();
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("commentPreviewProbe.blockWhole", async () => {
      await openBlockFixture();
      return setBlockPreview("whole");
    }),
    vscode.commands.registerCommand("commentPreviewProbe.blockTiles", async () => {
      await openBlockFixture();
      const result = await setBlockPreview("tiles");
      if (result.reason === "explicit-line-height-required") {
        vscode.window.showInformationMessage("此验证原型需要显式设置 10～40 像素的编辑器行高，当前保留源码显示。");
      }
      return result;
    }),
    vscode.commands.registerCommand("commentPreviewProbe.blockClear", () => blockClear()),
    { dispose: () => blockClear("disposed") },
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (!state.preview || event.textEditor !== editor) return;
      const b = bounds();
      if (event.selections.some((selection) => selection.start.line <= b.bodyEnd
          && selection.end.line >= b.bodyStart)) blockClear("selection-entered-source");
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (editor && event.document === editor.document && state.preview) blockClear("source-changed");
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (state.preview && state.strategy === "tiles" && event.affectsConfiguration("editor.lineHeight")) {
        // Conservative fallback: never keep tiles at a stale height.
        ++tileGeneration;
        blockClear("line-height-changed");
      }
    }),
    vscode.languages.registerFoldingRangeProvider(
      { scheme: "file", pattern: "**/multiline-fixture.js" }, {
        provideFoldingRanges(document) {
          const lines = document.getText().split(/\r?\n/);
          const start = lines.findIndex((line) => line.includes("@comment-diagram begin"));
          const end = lines.findIndex((line) => line.includes("@comment-diagram end"));
          return start >= 0 && end > start
            ? [new vscode.FoldingRange(start, end, vscode.FoldingRangeKind.Region)] : [];
        },
      }),
  );
  return { openBlockFixture, setBlockPreview, blockSnapshot, blockClear, blockAction };
}

module.exports = { createBlockProbe };
