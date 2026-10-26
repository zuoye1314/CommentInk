(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CommentStudioModel = factory();
})(globalThis, function () {
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const token = (value = "") => ({ kind: "token", value });
  function template(kind) {
    const empty = () => token();
    if (kind === "fraction") return { kind, numerator: empty(), denominator: empty() };
    if (kind === "sqrt") return { kind, body: empty() };
    if (kind === "power") return { kind, base: empty(), exponent: empty() };
    if (kind === "sum") return { kind, lower: token("i=1"), upper: token("n"), body: empty() };
    if (kind === "integral") return { kind, lower: token("0"), upper: token("1"), body: empty(), variable: token("x") };
    if (kind === "matrix") return { kind, cells: [[empty(), empty()], [empty(), empty()]] };
    if (kind === "sequence") return { kind, items: [empty(), empty()] };
    return empty();
  }
  function validateFormula(input, { draft = false } = {}) {
    let count = 0;
    function visit(node, depth = 0) {
      if (++count > 256 || depth > 12 || !node || typeof node !== "object") throw new Error("公式结构过大或无效");
      if (node.kind === "token") {
        if (typeof node.value !== "string" || node.value.length > 100
            || (!draft && /[\\{}$%#&\r\n]/.test(node.value))) throw new Error("公式输入包含不支持的字符，请使用模板或 LaTeX 模式");
        return { kind: "token", value: node.value };
      }
      if (node.kind === "raw") {
        const tex = typeof node.tex === "string" ? node.tex : Array.isArray(node.texLines)
          && node.texLines.length <= 256 && node.texLines.every((line) => typeof line === "string") ? node.texLines.join("\n") : null;
        if (typeof tex !== "string" || (!draft && !tex.trim()) || tex.length > 8192 || (node.tex !== undefined && node.texLines !== undefined)) throw new Error("LaTeX 内容无效");
        return { kind: "raw", tex };
      }
      const fields = { fraction: ["numerator", "denominator"], sqrt: ["body"], power: ["base", "exponent"],
        sum: ["lower", "upper", "body"], integral: ["lower", "upper", "body", "variable"] }[node.kind];
      if (fields) return Object.fromEntries([["kind", node.kind], ...fields.map((key) => [key, visit(node[key], depth + 1)])]);
      if (node.kind === "sequence" && Array.isArray(node.items) && node.items.length > 0 && node.items.length <= 24) {
        return { kind: "sequence", items: node.items.map((item) => visit(item, depth + 1)) };
      }
      if (node.kind === "matrix" && Array.isArray(node.cells) && node.cells.length > 0 && node.cells.length <= 4
          && node.cells.every((row) => Array.isArray(row) && row.length === node.cells[0].length && row.length > 0 && row.length <= 4)) {
        return { kind: "matrix", cells: node.cells.map((row) => row.map((cell) => visit(cell, depth + 1))) };
      }
      throw new Error("未知的公式模板");
    }
    return visit(input);
  }
  function toTex(input) {
    const node = validateFormula(input);
    const tex = (n) => {
      if (n.kind === "token") return n.value.trim() || "\\square";
      if (n.kind === "raw") return n.tex;
      if (n.kind === "fraction") return `\\frac{${tex(n.numerator)}}{${tex(n.denominator)}}`;
      if (n.kind === "sqrt") return `\\sqrt{${tex(n.body)}}`;
      if (n.kind === "power") return `{${tex(n.base)}}^{${tex(n.exponent)}}`;
      if (n.kind === "sum") return `\\sum_{${tex(n.lower)}}^{${tex(n.upper)}} ${tex(n.body)}`;
      if (n.kind === "integral") return `\\int_{${tex(n.lower)}}^{${tex(n.upper)}} ${tex(n.body)}\\,d${tex(n.variable)}`;
      if (n.kind === "matrix") return `\\begin{pmatrix}${n.cells.map((row) => row.map(tex).join("&")).join("\\\\")}\\end{pmatrix}`;
      return n.items.map(tex).join(" ");
    };
    return tex(node);
  }
  function validateScene(input, { draft = false } = {}) {
    if (!input || ![1, 2].includes(input.version) || !Array.isArray(input.nodes) || !Array.isArray(input.edges)
        || input.nodes.length > 40 || input.edges.length > 64) throw new Error("图表版本或大小不支持");
    const ids = new Set();
    const nodes = input.nodes.map((n) => {
      if (!n || typeof n.id !== "string" || !/^[\w-]{1,64}$/.test(n.id) || ids.has(n.id) || !["box", "text", "formula"].includes(n.kind)) throw new Error("节点标识或类型无效");
      ids.add(n.id);
      for (const [key, max] of [["x", 1000], ["y", 600], ["width", 600], ["height", 500]]) {
        if (!Number.isFinite(n[key]) || n[key] < (key === "width" || key === "height" ? 20 : 0) || n[key] > max) throw new Error("节点位置或尺寸超出范围");
      }
      if (typeof n.text !== "string" || n.text.length > 120) throw new Error("节点文字过长");
      const value = { id: n.id, kind: n.kind, x: Math.round(n.x), y: Math.round(n.y),
        width: Math.round(n.width), height: Math.round(n.height), text: n.text };
      if (n.formula !== undefined) value.formula = validateFormula(n.formula, { draft });
      if (n.kind === "formula" && !n.formula) throw new Error("公式节点缺少内容");
      return value;
    });
    const edgeIds = new Set();
    const point = (p) => {
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.x > 1600 || p.y < 0 || p.y > 1100) throw new Error("连线坐标无效");
      return { x: Math.round(p.x), y: Math.round(p.y) };
    };
    const endpoint = (p) => typeof p === "string" && ids.has(p) ? p : input.version === 2 ? point(p) : (() => { throw new Error("连线引用无效"); })();
    const edges = input.edges.map((e) => {
      if (!e || typeof e.id !== "string" || !/^[\w-]{1,64}$/.test(e.id) || edgeIds.has(e.id) || (input.version === 2 && ids.has(e.id)) || e.from === e.to) throw new Error("连线引用无效");
      edgeIds.add(e.id);
      const result = { id: e.id, from: endpoint(e.from), to: endpoint(e.to) };
      if (input.version === 2) {
        if (e.label !== undefined) {
          if (typeof e.label !== "string" || e.label.length > 120 || /[\r\n]/.test(e.label)) throw new Error("连线标签无效");
          result.label = e.label;
        }
        if (e.route !== undefined) { if (!["straight", "orthogonal"].includes(e.route)) throw new Error("连线路径无效"); result.route = e.route; }
        if (e.arrow !== undefined) { if (!["none", "end", "both"].includes(e.arrow)) throw new Error("连线箭头无效"); result.arrow = e.arrow; }
        if (e.points !== undefined) {
          if (!Array.isArray(e.points) || e.points.length > 8) throw new Error("转折点最多 8 个");
          result.points = e.points.map(point);
        }
      } else if (["label", "route", "arrow", "points"].some((key) => e[key] !== undefined)) throw new Error("新增连线属性需要图表 v2，原数据已保留");
      return result;
    });
    if (input.title !== undefined && (typeof input.title !== "string" || input.title.length > 80)) throw new Error("图表标题无效");
    return { version: input.version, title: input.title ?? "图表", nodes, edges };
  }
  // Break only between JSON tokens: escaped quotes, TeX and labels stay intact.
  // Keep the existing schema readable and portable rather than encoding it.
  function compactRows(value, width = 120) {
    const tokens = JSON.stringify(value).match(/"(?:\\.|[^"\\])*"|[{}\[\],:]|[^"{}\[\],:\s]+/g);
    const rows = []; let row = "";
    for (const token of tokens) {
      if (row && row.length + token.length > width) { rows.push(row); row = ""; }
      row += token;
    }
    if (row) rows.push(row);
    return rows;
  }
  function serialize({ type, id, value, indent = "", prefix = "#", eol = "\n", minimumBodyLines = 0 }) {
    if (!/^[\w-]{1,64}$/.test(id) || !["#", "//"].includes(prefix) || !/^[ \t]*$/.test(indent)) throw new Error("注释包装无效");
    const diagram = type === "diagram";
    const body = diagram ? validateScene(value) : { version: 2, formula: validateFormula(value) };
    function encodeRaw(data) {
      if (!data || typeof data !== "object") return data;
      if (data.kind === "raw") return { kind: "raw", texLines: data.tex.split("\n") };
      if (Array.isArray(data)) return data.map(encodeRaw);
      return Object.fromEntries(Object.entries(data).map(([key, v]) => [key, encodeRaw(v)]));
    }
    if (!Number.isInteger(minimumBodyLines) || minimumBodyLines < 0 || minimumBodyLines > 256) throw new Error("预览占位行数无效");
    const rows = compactRows(encodeRaw(body));
    while (rows.length < minimumBodyLines) rows.push("");
    return [`@${diagram ? "diagram" : "math"} begin v${diagram ? body.version : 2} ${id}`,
      ...rows, `@${diagram ? "diagram" : "math"} end`]
      .map((line) => `${indent}${prefix}${line ? ' ' + line : ''}`).join(eol);
  }
  return { clone, token, template, validateFormula, validateScene, toTex, serialize, compactRows };
});
