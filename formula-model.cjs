const crypto = require("node:crypto");

// Deliberately small prototype grammar: standalone Python/JS line comments.
function parseFormula(text) {
  const lines = text.split(/\r?\n/);
  const headers = lines.map((line, index) => ({ index,
    match: line.match(/^(\s*)(#|\/\/) @math begin v1 ([a-zA-Z0-9_-]+)\s*$/) }))
    .filter((entry) => entry.match);
  if (headers.length !== 1) throw new Error("Expected one standalone formula block");
  const { index: start, match } = headers[0];
  const [, indent, prefix, id] = match;
  const end = lines.findIndex((line, index) => index > start
    && line === `${indent}${prefix} @math end`);
  if (end <= start + 1) throw new Error("Formula end marker or body missing");
  const body = lines.slice(start + 1, end);
  const leader = `${indent}${prefix} `;
  if (body.some((line) => !line.startsWith(leader))) throw new Error("Formula body must contain only matching line comments");
  const tex = body.map((line) => line.slice(leader.length)).join("\n");
  if (!tex.trim() || tex.length > 8192) throw new Error("Formula is empty or exceeds the prototype limit");
  return { id, start, end, bodyStart: start + 1, bodyEnd: end - 1,
    bodyCount: body.length, indent, prefix, tex,
    identity: lines.slice(start, end + 1).join("\n"),
    fingerprint: crypto.createHash("sha256").update(tex).digest("hex") };
}

function makeTiles(rendered, lineHeight) {
  if (!Number.isInteger(lineHeight) || lineHeight < 8 || lineHeight > 800) {
    throw new Error("Formula tiles require a resolved pixel line height");
  }
  const count = Math.ceil(rendered.height / lineHeight);
  return Array.from({ length: count }, (_, index) => ({
    index, width: rendered.width, height: lineHeight,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${rendered.width}" height="${lineHeight}" viewBox="0 ${index * lineHeight} ${rendered.width} ${lineHeight}" overflow="hidden">${rendered.inner}</svg>`,
  }));
}

module.exports = { parseFormula, makeTiles };
