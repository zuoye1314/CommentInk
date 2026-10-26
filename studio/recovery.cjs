const vscode = require("vscode");
const fs = require("node:fs/promises");

function safeUI(input) {
  const result = {};
  if (input?.view && ["x", "y", "width", "height"].every((key) => Number.isFinite(input.view[key]))
      && Math.abs(input.view.x) < 100000 && Math.abs(input.view.y) < 100000
      && input.view.width >= 275 && input.view.width <= 4400
      && Math.abs(input.view.height - input.view.width * 700 / 1100) < .01) result.view = { ...input.view };
  if (Array.isArray(input?.selected)) result.selected = input.selected.filter((id) => typeof id === "string" && /^[\w-]{1,64}$/.test(id)).slice(0, 104);
  if (["select", "pan", "box", "edge", "free", "text", "formula"].includes(input?.tool)) result.tool = input.tool;
  return result;
}
function renamedUri(uri, oldUri, newUri) {
  if (uri.scheme !== oldUri.scheme || uri.authority !== oldUri.authority) return null;
  if (uri.path !== oldUri.path && !uri.path.startsWith(oldUri.path.replace(/\/$/, "") + "/")) return null;
  return newUri.with({ path: newUri.path.replace(/\/$/, "") + uri.path.slice(oldUri.path.replace(/\/$/, "").length), query: uri.query, fragment: uri.fragment });
}
async function assertWritable(doc) {
  if (!doc || doc.isClosed) throw new Error("原文件已关闭或无法访问，草稿仍保留");
  if (doc.isUntitled) return;
  if (vscode.workspace.fs.isWritableFileSystem(doc.uri.scheme) === false) throw new Error("原文件系统只读，可继续编辑或复制草稿，未写入");
  let stat;
  try { stat = await vscode.workspace.fs.stat(doc.uri); }
  catch { throw new Error("原文件已删除或无法访问，草稿仍保留"); }
  if ((stat.permissions || 0) & vscode.FilePermission.Readonly) throw new Error("原文件只读，可继续编辑或复制草稿，未写入");
  if (doc.uri.scheme === "file") {
    // Also respect Unix mode bits when VS Code runs with an elevated account.
    const local = await fs.stat(doc.uri.fsPath);
    if (process.platform !== "win32" && !(local.mode & 0o222)) throw new Error("原文件只读，可继续编辑或复制草稿，未写入");
  }
}
module.exports = { safeUI, renamedUri, assertWritable };
