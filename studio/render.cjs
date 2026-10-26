const { renderFormula } = require("../formula-renderer.cjs");
const { validateScene, toTex } = require("./model.js");
const G = require("./geometry.js");
const escape = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));

function renderValue(type, value, { color = "#d4d4d4", fontSize = 20 } = {}) {
  if (!/^#[\da-f]{6}$/i.test(color) || !Number.isFinite(fontSize) || fontSize < 10 || fontSize > 40) throw new Error("渲染样式无效");
  if (type === "math") return renderFormula(toTex(value), { color, fontSize });
  const scene = validateScene(value);
  if (!scene.nodes.length && !scene.edges.length) throw new Error("请先在画布上添加内容");
  const nodes = scene.nodes.map((n) => {
    const formula = n.formula ? renderFormula(toTex(n.formula), { color, fontSize }) : null;
    const labelWidth = [...n.text].length * fontSize + 24;
    return { ...n, width: Math.max(n.width, labelWidth, formula ? formula.width + 24 : 0),
      height: Math.max(n.height, formula ? formula.height + (n.text ? 48 : 24) : 40), formulaRender: formula };
  });
  const routes = scene.edges.map((e) => { const r = G.route(e, nodes); const label = G.labelPlacement(e, r.points, nodes, fontSize);
    return { edge: e, ...r, label, blocked: r.blocked || label.blocked }; });
  const extents = nodes.map((n) => ({ x: n.x, y: n.y, width: n.width, height: n.height }));
  for (const r of routes) {
    extents.push(...r.points.map((p) => ({ ...p, width: 0, height: 0 })));
    if (r.edge.label) { const p = r.label;
      extents.push({ x: p.x - p.width / 2, y: p.y - fontSize, width: p.width, height: p.height }); }
  }
  const minX = Math.min(...extents.map((n) => n.x)) - 12, minY = Math.min(...extents.map((n) => n.y)) - 12;
  const width = Math.ceil(Math.max(...extents.map((n) => n.x + n.width)) - minX + 12);
  const height = Math.ceil(Math.max(...extents.map((n) => n.y + n.height)) - minY + 12);
  if (width > 1200 || height > 800) throw new Error("图表超过 1200×800 显示范围，请缩小布局范围");
  const edges = routes.map(({ edge, points, label: p }) => {
    const arrow = edge.arrow || "end";
    const markers = (arrow !== "none" ? ' marker-end="url(#arrow)"' : "") + (arrow === "both" ? ' marker-start="url(#arrow)"' : "");
    return `<path d="${G.pathData(points)}" fill="none" stroke="${color}" stroke-width="1.5"${markers}/>`
      + (edge.label ? `<text x="${p.x}" y="${p.y}" text-anchor="middle" font-family="sans-serif" font-size="${fontSize}" fill="${color}">${escape(edge.label)}</text>` : "");
  }).join("");
  const shapes = nodes.map((n) => {
    const shape = n.kind === "box" ? `<rect x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" rx="4" fill="none" stroke="${color}" stroke-width="1.5"/>` : "";
    const label = n.text ? `<text x="${n.x + n.width / 2}" y="${n.y + (n.formulaRender ? 24 : n.height / 2 + 5)}" text-anchor="middle" font-size="${fontSize}" font-family="sans-serif" fill="${color}">${escape(n.text)}</text>` : "";
    const formula = n.formulaRender ? `<g transform="translate(${n.x + (n.width - n.formulaRender.width) / 2},${n.y + (n.text ? 36 : 12)})">${n.formulaRender.inner}</g>` : "";
    return shape + label + formula;
  }).join("");
  const inner = `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${color}"/></marker></defs><g transform="translate(${-minX},${-minY})">${edges}${shapes}</g>`;
  return { width, height, inner,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${inner}</svg>`,
    nodes: nodes.map(({ formulaRender, ...n }) => ({ ...n, labelFontSize: fontSize, formulaSvg: formulaRender?.svg })),
    collisions: G.collisions(nodes), blockedEdges: routes.filter((r) => r.blocked).map((r) => r.edge.id) };
}
module.exports = { renderValue };
