const { test } = require("node:test");
const assert = require("node:assert/strict");
const M = require("./model.js"), G = require("./geometry.js");
const { parseBlocks } = require("./parser.cjs"), { renderValue } = require("./render.cjs");
const node = (id, x, y = 100) => ({ id, kind: "box", x, y, width: 140, height: 80, text: id });

test("v1 comments stay identical; v2 free endpoints, bends, labels and arrows round-trip in both languages", () => {
  const old = { version: 1, title: "Old", nodes: [node("a", 20), node("b", 400)], edges: [{ id: "e", from: "a", to: "b" }] };
  assert.deepEqual(M.validateScene(old), old);
  assert.ok(M.serialize({ type: "diagram", value: old, id: "old" }).includes("begin v1"));
  const value = { ...old, version: 2, edges: [{ id: "e", from: "a", to: { x: 650, y: 400 }, points: [{ x: 240, y: 250 }], label: "x < y & z", route: "orthogonal", arrow: "both" }] };
  for (const [prefix, language] of [["#", "python"], ["//", "typescript"]]) {
    const encoded = M.serialize({ type: "diagram", value, id: "copy", prefix });
    const parsed = parseBlocks(encoded, language);
    assert.equal(parsed.diagnostics.length, 0); assert.deepEqual(parsed.blocks[0].value, value);
  }
  const image = renderValue("diagram", value);
  assert.ok(image.svg.includes("x &lt; y &amp; z")); assert.ok(image.svg.includes('marker-start="url(#arrow)"'));
});
test("invalid v2 references, coordinates, labels, enum values and too many bends fail closed", () => {
  const base = { version: 2, nodes: [node("a", 0)], edges: [] };
  for (const patch of [{ from: "missing" }, { to: { x: Infinity, y: 2 } }, { to: { x: -1, y: 3 } }, { label: "a\nb" }, { route: "evil" }, { arrow: "evil" }, { points: Array(9).fill({ x: 20, y: 30 }) }, { id: "a" }]) {
    assert.throws(() => M.validateScene({ ...base, edges: [{ id: "e", from: "a", to: { x: 300, y: 300 }, ...patch }] }));
  }
  assert.throws(() => M.validateScene({ ...base, version: 1, edges: [{ id: "e", from: "a", to: { x: 300, y: 300 } }] }));
});
test("free-standing line-only diagrams render and include every endpoint and label in bounds", () => {
  const image = renderValue("diagram", { version: 2, nodes: [], edges: [{ id: "line", from: { x: 50, y: 60 }, to: { x: 240, y: 160 }, label: "standalone", points: [{ x: 90, y: 140 }], arrow: "none" }] });
  assert.ok(image.width > 190 && image.height >= 124); assert.ok(image.svg.includes("standalone"));
  assert.ok(!image.svg.includes('marker-end="url(#arrow)"'));
});
test("orthogonal connectors avoid an intervening node and remain attached when a node moves", () => {
  const nodes = [node("a", 20), node("obstacle", 240, 70), node("b", 500)];
  const edge = { id: "e", from: "a", to: "b", route: "orthogonal" };
  const first = G.route(edge, nodes);
  assert.equal(first.blocked, false); assert.ok(first.points.length >= 4);
  for (let i = 1; i < first.points.length; i++) {
    assert.ok(first.points[i].x === first.points[i - 1].x || first.points[i].y === first.points[i - 1].y);
    assert.equal(G.segmentBlocked(first.points[i - 1], first.points[i], [nodes[1]]), false);
  }
  nodes[2].y = 300; const moved = G.route(edge, nodes);
  assert.notDeepEqual(moved.points.at(-1), first.points.at(-1)); assert.equal(edge.to, "b");
});
test("unroutable lines report the collision instead of pretending to avoid it", () => {
  const nodes = [node("a", 10), node("b", 40)];
  assert.ok(G.collisions(nodes).length);
  const route = G.route({ from: "a", to: "b", route: "orthogonal" }, nodes);
  assert.equal(route.blocked, true);
  const boundary = G.route({ from: "a", to: { x: 0, y: 140 }, route: "orthogonal" }, [node("a", 0)]);
  assert.equal(boundary.blocked, true); assert.ok(boundary.points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
});
test("edge labels choose a free position near their route and report a blocked label honestly", () => {
  const points = [{ x: 0, y: 100 }, { x: 400, y: 100 }], e = { label: "label" };
  const n = { id: "n", x: 140, y: 60, width: 120, height: 40 };
  const placed = G.labelPlacement(e, points, [n]);
  assert.equal(placed.blocked, false); assert.ok(placed.y > 100);
  assert.equal(G.labelPlacement(e, points, [{ ...n, x: 0, y: 0, width: 600, height: 500 }]).blocked, true);
});
test("explicit arrangement respects fixed nodes, measured formula sizes, identity and original input", () => {
  const nodes = [node("fixed", 100), { ...node("formula", 120), width: 210, height: 150 }, node("third", 160)];
  const saved = M.clone(nodes), arranged = G.arrange(nodes, ["formula", "third"]);
  assert.deepEqual(nodes, saved); assert.deepEqual(arranged[0], saved[0]); assert.equal(G.collisions(arranged).length, 0);
  assert.equal(arranged[1].width, 210); assert.deepEqual(arranged.map((n) => n.id), nodes.map((n) => n.id));
});
test("group movement preserves relative spacing, shared bends and attached identities at boundaries", () => {
  const value = { version: 2, nodes: [node("a", 980), node("b", 800)], edges: [{ id: "e", from: "a", to: "b", points: [{ x: 950, y: 90 }] }, { id: "free", from: { x: 300, y: 400 }, to: { x: 500, y: 400 }, points: [{ x: 450, y: 410 }] }] };
  G.move(value, ["a", "b", "e"], 100, 0);
  assert.equal(value.nodes[0].x, 1000); assert.equal(value.nodes[1].x, 820); assert.equal(value.edges[0].points[0].x, 970);
  assert.equal(value.edges[0].from, "a"); assert.equal(value.edges[1].from.x, 300);
  G.move(value, ["free"], 10, -10); assert.deepEqual(value.edges[1].from, { x: 310, y: 390 }); assert.deepEqual(value.edges[1].points[0], { x: 460, y: 400 });
});
