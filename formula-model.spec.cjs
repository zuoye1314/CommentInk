const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parseFormula, makeTiles } = require("./formula-model.cjs");
const { renderFormula } = require("./formula-renderer.cjs");
const { resolveLineHeight } = require("./formula-layout.cjs");
const { reflowFormula, visualSignature } = require("./formula-reflow.cjs");
const fixture = fs.readFileSync(path.join(__dirname, "formula-fixture.py"), "utf8");

test("surrounding annotations can change without changing formula identity", () => {
  const before = parseFormula(fixture);
  const after = parseFormula("# inserted annotation\r\n" + fixture.replace(/\n/g, "\r\n"));
  assert.equal(after.identity, before.identity);
  assert.equal(after.fingerprint, before.fingerprint);
  assert.equal(after.start, before.start + 1);
});
test("JS line comments preserve standalone TeX without a graph model", () => {
  const parsed = parseFormula("// @math begin v1 f\n// \\frac{a}{b}\n// @math end");
  assert.equal(parsed.tex, String.raw`\frac{a}{b}`);
  assert.equal(parsed.bodyCount, 1);
});
test("malformed boundaries or code mixed into a formula are rejected", () => {
  assert.throws(() => parseFormula("# @math begin v1 x\nprint(1)\n# @math end"));
  assert.throws(() => parseFormula("# @math begin v1 x\n# a+b"));
  assert.throws(() => parseFormula(fixture + fixture));
});
test("real integral renders as self contained vector paths", () => {
  const result = renderFormula(parseFormula(fixture).tex);
  assert.ok(result.svg.includes("<path"));
  assert.ok(result.svg.includes('data-mml-node="munderover"'));
  assert.ok(result.width > result.height && result.height > 30);
  assert.ok(!result.svg.includes("<text"));
  assert.ok(!/(?:href|src)="https?:/.test(result.svg));
  assert.ok(makeTiles(result, 22).length <= parseFormula(fixture).bodyCount);
});
test("nested fraction and matrix retain mathematical structure", () => {
  const fraction = renderFormula(String.raw`\frac{1}{\sqrt{1+\frac{x^2}{y}}}`);
  const matrix = renderFormula(String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`);
  assert.ok(fraction.svg.includes('data-mml-node="mfrac"'));
  assert.ok(fraction.svg.includes('data-mml-node="msqrt"'));
  assert.ok(matrix.svg.includes('data-mml-node="mtable"'));
});
test("invalid TeX and commands capable of external loading are rejected", () => {
  for (const tex of [String.raw`\unknowncommand{x}`, String.raw`\frac{a}`, String.raw`\require{html}`,
    String.raw`\href{https://example.com}{x}`, String.raw`\def\x{\x}\x`]) {
    assert.throws(() => renderFormula(tex));
  }
});
test("font size changes measured bounds and unresolved line height cannot reach tiling", () => {
  const small = renderFormula(String.raw`\frac{x}{y}`, { fontSize: 16 });
  const large = renderFormula(String.raw`\frac{x}{y}`, { fontSize: 28 });
  assert.ok(large.width > small.width && large.height > small.height);
  assert.throws(() => makeTiles(small, 0));
});
test("automatic line height follows the checked desktop platform rules and rounding", () => {
  for (const [platform, fontSize, expected] of [
    ["linux", 14, 19], ["linux", 20, 27], ["linux", 13.5, 18],
    ["win32", 14, 19], ["darwin", 14, 21], ["darwin", 6, 9],
  ]) {
    const result = resolveLineHeight({ platform, fontSize, lineHeight: 0 });
    assert.equal(result.lineHeight, expected);
    assert.equal(result.lineHeightMode, "automatic");
  }
});
test("fractional pixels and relative line-height settings resolve before SVG slicing", () => {
  assert.equal(resolveLineHeight({ fontSize: 14, lineHeight: 1.5 }).lineHeight, 21);
  assert.equal(resolveLineHeight({ fontSize: 14, lineHeight: 22.5 }).lineHeight, 23);
  assert.equal(resolveLineHeight({ fontSize: 6, lineHeight: 0.1 }).lineHeight, 8);
  const rendered = renderFormula(String.raw`\frac{x}{y}`);
  const { lineHeight } = resolveLineHeight({ fontSize: 14, lineHeight: 0 });
  const tiles = makeTiles(rendered, lineHeight);
  assert.ok(tiles.every((tile) => tile.height === 19));
  assert.equal(tiles.length, Math.ceil(rendered.height / 19));
});
test("unchecked automatic rules and malformed settings do not silently guess metrics", () => {
  assert.throws(() => resolveLineHeight({ version: "1.143.0" }));
  assert.throws(() => resolveLineHeight({ platform: "unknown" }));
  for (const lineHeight of [-1, Infinity, NaN, "0", 151]) {
    assert.throws(() => resolveLineHeight({ lineHeight }));
  }
  assert.equal(resolveLineHeight({ version: "1.143.0", lineHeight: 22 }).lineHeight, 22);
});
test("one-line high math can explicitly reflow into non-empty lines with identical glyphs/layout", () => {
  const original = String.raw`f(x)=\frac{\displaystyle\int_0^x\frac{\sin(t)}{1+t^2}\,dt}{\sqrt{\displaystyle\sum_{k=1}^n\frac{x_k^2}{k+1}}}`;
  const before = renderFormula(original);
  const minimumLines = Math.ceil(before.height / 19);
  const plan = reflowFormula(original, { minimumLines });
  assert.equal(plan.lines, minimumLines);
  assert.equal(plan.tex.replace(/\n/g, ""), original);
  assert.ok(plan.tex.split("\n").every((line) => line.trim()));
  assert.equal(visualSignature(renderFormula(plan.tex).svg), visualSignature(before.svg));
  assert.equal(reflowFormula(plan.tex, { minimumLines }).changed, false);
});
test("formatting preserves text labels and declines formulas without enough safe breakpoints", () => {
  const tex = String.raw`\frac{\text{do not break words}+a}{b+c}`;
  const plan = reflowFormula(tex, { minimumLines: 4 });
  assert.equal(visualSignature(renderFormula(plan.tex).svg), visualSignature(renderFormula(tex).svg));
  assert.throws(() => reflowFormula(String.raw`\sum`, { minimumLines: 8 }));
  assert.throws(() => reflowFormula("x% comment\n+y", { minimumLines: 4 }));
});
