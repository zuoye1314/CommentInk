const { test } = require("node:test");
const assert = require("node:assert/strict");
const M = require("./model.js");
const { parseBlocks } = require("./parser.cjs");
const { renderValue } = require("./render.cjs");
const { RenderPool } = require("./render-pool.cjs");
const { fitInline } = require("./inline-layout.cjs");
const block = (id, prefix = "#") => `${prefix} @math begin v1 ${id}\n${prefix} \\frac{a}{b}\n${prefix} @math end\n`;
const fraction = () => ({ kind: "fraction", numerator: M.token("x-μ"), denominator: M.token("σ") });

test("Python triple/raw/f strings cannot impersonate comments; actual blocks remain distinct", () => {
  for (const prefix of ["", "r", "f", "fr", "b"]) {
    const source = `${prefix}\"\"\"\n${block("fake")}\"\"\"\n${block("real")}`;
    assert.deepEqual(parseBlocks(source, "python").blocks.map((b) => b.id), ["real"]);
  }
});
test("JS/TS template strings, regexes and block comments cannot impersonate line comments", () => {
  for (const language of ["javascript", "typescript", "javascriptreact", "typescriptreact"]) {
    const source = `const s=\`\n${block("fake", "//")}\`;\n/*\n${block("fake2", "//")}*/\nconst re=/[\\/]/;\n${block("real", "//")}`;
    assert.deepEqual(parseBlocks(source, language).blocks.map((b) => b.id), ["real"]);
  }
});
test("malformed syntax fails closed and duplicate IDs do not affect a different valid block", () => {
  assert.equal(parseBlocks(`\"\"\"\n${block("fake")}`, "python").blocks.length, 0);
  const parsed = parseBlocks(block("same") + block("same") + block("different"), "python");
  assert.deepEqual(parsed.blocks.map((b) => b.id), ["different"]);
  assert.equal(parsed.diagnostics.length, 2);
});
test("multiple blocks, CRLF/indentation, unsupported versions and malformed blocks are independent", () => {
  const source = (block("a") + block("unknown").replace("v1", "v99") + block("b")).replaceAll("\n", "\r\n");
  assert.deepEqual(parseBlocks(source, "python").blocks.map((b) => b.id), ["a", "b"]);
  assert.equal(parseBlocks(source, "python").diagnostics.length, 1);
  assert.equal(parseBlocks("def f():\n" + block("x").split("\n").filter(Boolean).map((l) => "    " + l).join("\n") + "\n    pass\n", "python").blocks[0].indent, "    ");
});
test("source insertion is prohibited inside multiline strings and block comments", () => {
  assert.ok(parseBlocks('x="""\ninside\n"""\n', "python").unsafeLines.includes(1));
  assert.ok(parseBlocks('/*\ninside\n*/\n', "javascript").unsafeLines.includes(1));
});
test("all graphical math templates generate real math and nest without learning a DSL", () => {
  for (const kind of ["fraction", "sqrt", "power", "sum", "integral", "matrix", "sequence"]) {
    const formula = M.template(kind);
    assert.ok(renderValue("math", formula, {}).svg.includes("<path"));
  }
  const value = fraction(); value.denominator = { kind: "sqrt", body: M.token("σ+ε") };
  assert.ok(M.toTex(value).includes("\\sqrt"));
  assert.ok(renderValue("math", value, {}).svg.includes('data-mml-node="msqrt"'));
});
test("structured formulas and raw TeX round-trip through standalone comments without caches", () => {
  for (const value of [fraction(), { kind: "raw", tex: String.raw`\frac{a}{\sqrt{b}}` }]) {
    for (const prefix of ["#", "//"]) {
      const source = M.serialize({ type: "math", id: "sample", value, indent: "    ", prefix, eol: "\r\n" });
      const wrapped = prefix === "#" ? "def f():\r\n" + source + "\r\n    pass\r\n" : "function f(){\r\n" + source + "\r\n}\r\n";
      const parsed = parseBlocks(wrapped, prefix === "#" ? "python" : "typescript");
      assert.equal(parsed.blocks.length, 1);
      assert.deepEqual(parsed.blocks[0].value, value);
      assert.equal(parsed.blocks[0].tex, M.toTex(value));
    }
  }
});
test("diagram move preserves edge identity and formula/label layout; XML labels are escaped", () => {
  const scene = { version: 1, title: "Flow", nodes: [
    { id: "a", kind: "box", x: 0, y: 0, width: 120, height: 64, text: "<script>" },
    { id: "b", kind: "box", x: 250, y: 0, width: 120, height: 64, text: "Normalize", formula: fraction() },
  ], edges: [{ id: "e", from: "a", to: "b" }] };
  const initial = renderValue("diagram", scene, {});
  assert.ok(!initial.svg.includes("<script>"));
  assert.ok(initial.svg.includes("&lt;script&gt;"));
  assert.ok(initial.nodes[1].height > scene.nodes[1].height);
  scene.nodes[1].y += 100;
  const moved = renderValue("diagram", scene, {});
  assert.notEqual(moved.svg, initial.svg);
  assert.deepEqual(scene.edges, [{ id: "e", from: "a", to: "b" }]);
  const parsed = parseBlocks(M.serialize({ type: "diagram", id: "diagram", value: scene }), "python");
  assert.deepEqual(parsed.blocks[0].value, scene);
});
test("invalid model references, depth, numbers and unexpected formula commands are rejected", () => {
  assert.throws(() => M.validateFormula({ kind: "token", value: String.raw`\href{x}` }));
  let root = M.token("x"); for (let i = 0; i < 15; i++) root = { kind: "sqrt", body: root };
  assert.throws(() => M.validateFormula(root));
  assert.throws(() => M.validateScene({ version: 1, nodes: [], edges: [{ id: "x", from: "a", to: "b" }] }));
  assert.throws(() => renderValue("math", { kind: "raw", tex: String.raw`\require{html}` }, {}));
});
test("worker renderer returns correct vectors, caches within bounds and is disposed", async () => {
  const pool = new RenderPool();
  try {
    const result = await pool.render("math", fraction(), { color: "#ffffff", fontSize: 20 });
    assert.ok(result.svg.includes("<path"));
    assert.equal(await pool.render("math", fraction(), { color: "#ffffff", fontSize: 20 }), result);
    await assert.rejects(pool.render("math", { kind: "raw", tex: String.raw`\invalidcommand` }, {}));
    const plan = await pool.render("reflow", { tex: String.raw`\frac{a+b}{\sqrt{c+d}}` }, { minimumLines: 4 });
    assert.equal(plan.lines, 4);
    assert.ok(pool.cacheBytes < 8 * 1024 * 1024);
  } finally { pool.dispose(); }
});
test("a timed-out rendering worker is terminated and the next request can recover", async () => {
  const pool = new RenderPool({ timeoutMs: 1 });
  try {
    await assert.rejects(pool.render("math", fraction(), {}), /超时/);
    pool.timeoutMs = 1500;
    assert.ok((await pool.render("math", fraction(), {})).svg.includes("<path"));
  } finally { pool.dispose(); }
});
test("inline width is bounded without silently shrinking text below a readable size", () => {
  const input = { width: 640, height: 200, inner: "<path/>" };
  const fit = fitInline(input, 20);
  assert.equal(fit.width, 480); assert.equal(fit.height, 150); assert.equal(fit.scale, .75);
  assert.equal(input.width, 640);
  assert.throws(() => fitInline({ ...input, width: 1000 }, 20), /难以阅读/);
});
test("incomplete drafts can be restored but are rejected as committed math", () => {
  assert.deepEqual(M.validateFormula({ kind: "raw", tex: "" }, { draft: true }), { kind: "raw", tex: "" });
  assert.throws(() => M.validateFormula({ kind: "raw", tex: "" }));
  assert.deepEqual(M.validateFormula(M.token("\\"), { draft: true }), M.token("\\"));
  assert.throws(() => M.validateFormula(M.token("\\")));
});
test("a tall numeric matrix remains well-formed SVG, including nested delimiter SVGs", () => {
  const { DOMParser } = require("@xmldom/xmldom");
  const matrix = { kind: "matrix", cells: [[11, 12, 13], [21, 22, 23], [31, 32, 33]].map((row) => row.map((n) => M.token(String(n)))) };
  const result = renderValue("math", matrix, {});
  const parsed = new DOMParser().parseFromString(result.svg, "image/svg+xml");
  assert.ok(parsed.getElementsByTagName("svg").length > 2);
  assert.ok(result.svg.includes('data-mml-node="mtable"'));
});

test("visual indentation expands tabs consistently without depending on payload row length", () => {
  const { indentColumns } = require("./inline-layout.cjs");
  assert.equal(indentColumns(""), 0);
  assert.equal(indentColumns("    "), 4);
  assert.equal(indentColumns("\t ", 4), 5);
  assert.equal(indentColumns(" \t ", 8), 9);
  assert.equal(indentColumns("\t\t", 8), 16);
});
