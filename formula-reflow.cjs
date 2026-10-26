const { renderFormula } = require("./formula-renderer.cjs");

// MathJax embeds original TeX in non-rendering data-latex attributes. Those
// necessarily change during formatting; keep every glyph/path/layout attribute.
const visualSignature = (svg) => svg.replace(/\sdata-latex(?:-[\w-]+)?="[^"]*"/g, "");

// Explicit source formatting, never called by plain preview. Insert only
// non-empty TeX line breaks and accept each break only if all MathJax SVG
// glyphs/layout are identical. Commands stay intact; failures do not apply edits.
function reflowFormula(tex, { minimumLines, fontSize = 20, color = "#d4d4d4" } = {}) {
  if (!Number.isInteger(minimumLines) || minimumLines < 1 || minimumLines > 75) {
    throw new Error("Invalid formula formatting line count");
  }
  const reference = visualSignature(renderFormula(tex, { fontSize, color }).svg);
  const originalLines = tex.split("\n").length;
  if (originalLines >= minimumLines) return { tex, changed: false, originalLines, lines: originalLines };
  const tokens = Array.from(tex.matchAll(/\\(?:[A-Za-z]+|[\s\S])|[\s\S]/gu));
  if (tokens.some((token) => token[0] === "%")) {
    throw new Error("TeX comments need manual source formatting");
  }
  const candidates = new Set(tokens.slice(1).map((token) => token.index)
    .filter((index) => !/[\r\n]/.test(tex[index - 1]) && !/\s/.test(tex[index])
      && (/[{=+,&}]/.test(tex[index - 1]) || tex[index] === "}"
        || (tex[index] === "\\" && !/[_^]/.test(tex[index - 1])))));
  const breaks = new Set();
  const existingBreaks = Array.from(tex.matchAll(/\n/g), (match) => match.index);
  function output() {
    const positions = [...breaks].sort((a, b) => a - b);
    let from = 0, result = "";
    for (const at of positions) { result += tex.slice(from, at) + "\n"; from = at; }
    return result + tex.slice(from);
  }
  const deadline = Date.now() + 750;
  let attempts = 0;
  while (originalLines + breaks.size < minimumLines && candidates.size && attempts < 256 && Date.now() < deadline) {
    const edges = [0, ...existingBreaks, ...breaks, tex.length].sort((a, b) => a - b);
    function score(at) {
      const right = edges.findIndex((edge) => edge > at);
      return Math.min(at - edges[right - 1], edges[right] - at);
    }
    // Split the longest remaining span near its middle, rather than create a
    // stack of tiny lines followed by one long line that can soft-wrap.
    const at = [...candidates].sort((a, b) => score(b) - score(a) || a - b)[0];
    candidates.delete(at);
    breaks.add(at);
    attempts++;
    const candidate = output();
    try {
      if (candidate.split("\n").some((line) => !line.trim())
          || visualSignature(renderFormula(candidate, { fontSize, color }).svg) !== reference) breaks.delete(at);
    } catch { breaks.delete(at); }
  }
  if (originalLines + breaks.size < minimumLines) {
    throw new Error("Cannot create enough non-empty TeX lines with identical rendering; source preserved");
  }
  return { tex: output(), changed: true, originalLines, lines: originalLines + breaks.size };
}

module.exports = { reflowFormula, visualSignature };
