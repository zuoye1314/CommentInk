/* global acquireVsCodeApi, CommentStudioModel, CommentStudioGeometry */
(() => {
  const api = acquireVsCodeApi(), M = CommentStudioModel, G = CommentStudioGeometry, $ = (id) => document.getElementById(id);
  let type, value, target, selected, tool = "select", edgeStart, focusedPath = [], advanced = false;
  let sessionToken, draftId, draftRevision = 0, blockingNotice, spaceHeld = false, selectedIds = new Set(), view = { x: 0, y: 0, width: 1100, height: 700 };
  let request = 0, lastRender = 0, timer, drag, lastTap, inputBefore, measurements = new Map();
  const undo = [], redo = [], actions = new Map();
  const id = () => `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const saved = api.getState();
  function notice(text, error = false) { $("status").textContent = blockingNotice || text; $("status").classList.toggle("error", Boolean(blockingNotice) || error); }
  function persist() {
    if (!type || !value) return;
    const ui = { view, selected: [...selectedIds], tool };
    const state = { type, value, target, ui, draftId, revision: ++draftRevision };
    api.setState(state);
    if (sessionToken) api.postMessage({ action: "draft", value, ui, revision: draftRevision, request: ++request, sessionToken });
  }
  function saveView() { persist(); }
  function upgrade() { value.version = 2; }
  function selection(ids) {
    selectedIds = new Set(ids); selectNode([...selectedIds][0]);
  }
  function send(action, draft = value) {
    const sequence = ++request; actions.set(sequence, action);
    api.postMessage({ action, value: draft, request: sequence, copyLanguage: $("copy-language").value, sessionToken }); return sequence;
  }
  function changed() {
    persist(); clearTimeout(timer);
    notice("正在排版草稿…");
    timer = setTimeout(() => { lastRender = send("render"); }, 90);
  }
  function remember(before) {
    if (JSON.stringify(before) !== JSON.stringify(value)) {
      undo.push(before); if (undo.length > 80) undo.shift(); redo.length = 0;
    }
  }
  function edit(operation, redraw = true) {
    const before = M.clone(value); operation(); remember(before);
    if (redraw) redrawAll(); changed();
  }
  function history(direction) {
    const from = direction === "undo" ? undo : redo, to = direction === "undo" ? redo : undo;
    if (!from.length) return;
    to.push(M.clone(value)); value = from.pop(); selection([]); focusedPath = []; advanced = false;
    measurements.clear(); redrawAll(); changed();
  }
  function formula() { return type === "math" ? value : value.nodes.find((n) => n.id === selected)?.formula; }
  function setFormula(next) {
    if (type === "math") value = next;
    else { const node = value.nodes.find((n) => n.id === selected); if (node) node.formula = next; }
  }
  function atPath(path) { let node = formula(); for (const part of path) node = node?.[part]; return node; }
  function selectNode(id) { if (!selectedIds.has(id)) selectedIds = new Set(id ? [id] : []); if (selected !== id) { focusedPath = []; advanced = false; } selected = id; }
  function replacePath(path, node) {
    if (!path.length) setFormula(node);
    else { const parent = atPath(path.slice(0, -1)); parent[path.at(-1)] = node; }
  }
  function matrixPath() {
    let path = [...focusedPath];
    while (true) {
      if (atPath(path)?.kind === "matrix") return path;
      if (!path.length) return null;
      path.pop();
    }
  }
  function matrixControls() {
    const path = matrixPath();
    $("matrix-row").hidden = $("matrix-col").hidden = path === null || advanced;
  }
  function span(className, ...children) {
    const element = document.createElement("span"); element.className = className;
    element.append(...children); return element;
  }
  const names = { numerator: "分子", denominator: "分母", body: "内容", base: "底数", exponent: "上标", lower: "下限", upper: "上限", variable: "积分变量", cells: "矩阵", items: "并列项" };
  function field(node, path = [], label = "公式") {
    if (node.kind === "token") {
      const input = document.createElement("input"); input.className = "atom"; input.value = node.value;
      input.maxLength = 100; input.setAttribute("aria-label", label); input.dataset.path = JSON.stringify(path);
      input.addEventListener("focus", () => { focusedPath = path; inputBefore = M.clone(value); matrixControls(); });
      input.addEventListener("input", () => { atPath(path).value = input.value; changed(); });
      input.addEventListener("blur", () => { if (inputBefore) remember(inputBefore); inputBefore = undefined; });
      return input;
    }
    const child = (key) => field(node[key], [...path, key], names[key] || key);
    if (node.kind === "fraction") return span("fraction", span("numerator", child("numerator")), span("denominator", child("denominator")));
    if (node.kind === "sqrt") return span("expression sqrt", span("radical", "√"), span("radicand", child("body")));
    if (node.kind === "power") return span("expression power", child("base"), span("exponent", child("exponent")));
    if (node.kind === "sum" || node.kind === "integral") {
      return span("expression", span("limits", child("upper"), span("operator", node.kind === "sum" ? "∑" : "∫"), child("lower")),
        child("body"), ...(node.kind === "integral" ? [span("", "d"), child("variable")] : []));
    }
    if (node.kind === "matrix") {
      const matrix = span("matrix"); matrix.style.gridTemplateColumns = `repeat(${node.cells[0].length},auto)`;
      node.cells.forEach((row, r) => row.forEach((cell, c) => matrix.append(field(cell, [...path, "cells", r, c], `矩阵第${r + 1}行第${c + 1}列`))));
      return matrix;
    }
    if (node.kind === "sequence") return span("expression", ...node.items.map((item, i) => field(item, [...path, "items", i], `并列项${i + 1}`)));
    return span("raw-hint", "此公式保留原始 LaTeX，请在源码框中编辑。");
  }
  function renderFields() {
    const root = formula(); $("formula-fields").replaceChildren();
    if (!root) return;
    if (root.kind === "raw") advanced = true;
    $("latex").hidden = !advanced; $("formula-fields").hidden = advanced;
    $("advanced").textContent = advanced ? "模板" : "LaTeX";
    if (advanced) $("latex").value = root.kind === "raw" ? root.tex : M.toTex(root);
    else $("formula-fields").append(field(root));
    matrixControls();
  }
  function openFormula() {
    if (!formula()) return;
    $("formula-editor").hidden = false; focusedPath = []; advanced = formula().kind === "raw"; renderFields();
  }
  document.querySelectorAll("[data-template]").forEach((button) => button.addEventListener("click", () => {
    if (formula()?.kind === "raw") { notice("高级 LaTeX 暂不能无损转换为模板，原文已保留。", true); return; }
    const next = M.template(button.dataset.template);
    edit(() => {
      const current = atPath(focusedPath);
      if (current?.kind === "token" && current.value) {
        const first = { fraction: "numerator", sqrt: "body", power: "base", sum: "body", integral: "body" }[next.kind];
        if (first) next[first] = current;
        else if (next.kind === "sequence") next.items[0] = current;
      }
      replacePath(focusedPath, next);
    });
    renderFields();
  }));
  for (const dimension of ["row", "col"]) $("matrix-" + dimension).addEventListener("click", () => {
    const path = matrixPath(); if (path === null) return;
    const matrix = atPath(path);
    if ((dimension === "row" ? matrix.cells.length : matrix.cells[0].length) >= 4) { notice("当前模板最多支持 4×4 矩阵。", true); return; }
    edit(() => {
      if (dimension === "row") matrix.cells.push(matrix.cells[0].map(() => M.token()));
      else matrix.cells.forEach((row) => row.push(M.token()));
    });
    focusedPath = path; renderFields();
  });
  $("advanced").addEventListener("click", () => {
    if (advanced && formula()?.kind === "raw") { notice("当前高级公式暂不能反向转换为模板；可以撤销或保留 LaTeX。", true); return; }
    if (!advanced) {
      try { M.toTex(formula()); }
      catch (error) { notice("当前模板输入暂不完整，请先修正输入；草稿仍保留。", true); return; }
    }
    advanced = !advanced; renderFields();
  });
  $("latex").addEventListener("focus", () => { inputBefore = M.clone(value); });
  $("latex").addEventListener("input", () => { setFormula({ kind: "raw", tex: $("latex").value }); changed(); });
  $("latex").addEventListener("blur", () => { if (inputBefore) remember(inputBefore); inputBefore = undefined; });
  $("close-formula").addEventListener("click", () => { $("formula-editor").hidden = true; });
  $("edit-formula").addEventListener("click", () => {
    const node = value.nodes.find((n) => n.id === selected);
    if (!node.formula) edit(() => { node.formula = M.template("fraction"); });
    openFormula();
  });
  $("label").addEventListener("focus", () => { inputBefore = M.clone(value); });
  $("label").addEventListener("input", () => {
    const node = value.nodes.find((n) => n.id === selected), edge = value.edges.find((e) => e.id === selected);
    if (node) node.text = $("label").value;
    else if (edge) { upgrade(); edge.label = $("label").value; }
    else return;
    canvas(); changed();
  });
  $("label").addEventListener("blur", () => { if (inputBefore) remember(inputBefore); inputBefore = undefined; });
  function removeSelected() {
    if (!selectedIds.size) return;
    edit(() => { value.nodes = value.nodes.filter((n) => !selectedIds.has(n.id));
      value.edges = value.edges.filter((e) => !selectedIds.has(e.id) && !selectedIds.has(e.from) && !selectedIds.has(e.to)); });
    selection([]); redrawAll();
  }
  $("remove").addEventListener("click", removeSelected);
  $("delete-selection").addEventListener("click", removeSelected);
  function duplicateSelected() {
    const nodes = value.nodes.filter((n) => selectedIds.has(n.id)),
      edges = value.edges.filter((e) => selectedIds.has(e.id) || (selectedIds.has(e.from) && selectedIds.has(e.to)));
    if (!nodes.length && !edges.length) return;
    if (value.nodes.length + nodes.length > 40 || value.edges.length + edges.length > 64) { notice("最多 40 个节点和 64 条连线。", true); return; }
    edit(() => {
      const ids = new Map([...nodes, ...edges].map((n) => [n.id, id()]));
      const newNodes = M.clone(nodes).map((n) => ({ ...n, id: ids.get(n.id) }));
      const newEdges = M.clone(edges).map((e) => ({ ...e, id: ids.get(e.id), from: ids.get(e.from) || e.from, to: ids.get(e.to) || e.to }));
      value.nodes.push(...newNodes); value.edges.push(...newEdges);
      selection([...newNodes, ...newEdges].map((n) => n.id)); G.move(value, [...selectedIds], 24, 24);
    });
  }
  $("duplicate").addEventListener("click", duplicateSelected);
  for (const axis of ["left", "top"]) $("align-" + axis).addEventListener("click", () => {
    const nodes = value.nodes.filter((n) => selectedIds.has(n.id)); if (nodes.length < 2) return;
    const key = axis === "left" ? "x" : "y", pos = Math.min(...nodes.map((n) => n[key]));
    edit(() => { for (const n of nodes) n[key] = pos; });
  });
  for (const [element, key] of [["edge-route", "route"], ["edge-arrow", "arrow"]]) $(element).addEventListener("change", () => {
    const edge = value.edges.find((e) => e.id === selected); if (!edge) return;
    edit(() => { upgrade(); edge[key] = $(element).value; });
  });
  $("clear-bends").addEventListener("click", () => edit(() => { const edge = value.edges.find((e) => e.id === selected); if (edge) { upgrade(); edge.points = []; } }));
  $("arrange").addEventListener("click", () => {
    const shown = value.nodes.map(displayNode);
    const chosen = shown.filter((n) => selectedIds.has(n.id)), movable = chosen.length ? chosen : shown;
    const result = G.arrange(shown, movable.map((n) => n.id));
    if (!result || result.some((n) => n.width > 600 || n.height > 500)) { notice("当前空间不足以避让；请缩短文字、调整公式或减少对象。草稿未改变。", true); return; }
    edit(() => {
      value.nodes = result.map(({ formulaSvg, labelFontSize, ...n }) => n);
      for (const e of value.edges) if (G.route(e, result).blocked) { upgrade(); e.route = "orthogonal"; }
    });
  });
  $("undo").addEventListener("click", () => history("undo")); $("redo").addEventListener("click", () => history("redo"));
  $("copy").addEventListener("click", () => { blockingNotice = undefined; send("copy"); }); $("apply").addEventListener("click", () => {
    blockingNotice = undefined;
    document.querySelectorAll("button,input,textarea,select").forEach((element) => { element.disabled = true; });
    notice("正在应用到注释…"); send("apply");
  });
  function setTool(next) {
    tool = next; edgeStart = undefined; lastTap = undefined;
    document.querySelectorAll("[data-tool]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.tool === tool)));
    $("canvas").style.cursor = tool === "pan" ? "grab" : tool === "select" ? "default" : "crosshair";
    notice(tool === "edge" ? "依次点击起点和终点节点。" : tool === "free" ? "拖动绘制自由线；端点吸附节点，Alt 保持自由。双击线段添加转折点。" : "");
    if (value) persist();
  }
  document.querySelectorAll("[data-tool]").forEach((button) => button.addEventListener("click", () => setTool(button.dataset.tool)));
  const svg = (name, attrs = {}, text) => {
    const element = document.createElementNS("http://www.w3.org/2000/svg", name);
    for (const [key, v] of Object.entries(attrs)) element.setAttribute(key, String(v));
    if (text !== undefined) element.textContent = text;
    return element;
  };
  function displayNode(node) {
    const measured = measurements.get(node.id);
    return { ...node, width: Math.max(node.width, measured?.width || 0), height: Math.max(node.height, measured?.height || 0),
      formulaSvg: measured?.formulaSvg, labelFontSize: measured?.labelFontSize || 20 };
  }
  function canvas() {
    if (type !== "diagram") return;
    const root = $("canvas"); root.replaceChildren();
    root.setAttribute("viewBox", `${view.x} ${view.y} ${view.width} ${view.height}`);
    $("zoom-reset").textContent = `${Math.round(1100 / view.width * 100)}%`;
    root.dataset.selected = [...selectedIds].join(",");
    const shown = value.nodes.map(displayNode), pairs = G.collisions(shown), colliding = new Set(pairs.flat()), blocked = [];
    $("selection-bar").hidden = !selectedIds.size;
    $("selection-count").textContent = `已选 ${selectedIds.size} 项`;
    $("align-left").hidden = $("align-top").hidden = shown.filter((n) => selectedIds.has(n.id)).length < 2;
    const defs = svg("defs"), marker = svg("marker", { id: "arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" });
    marker.append(svg("path", { d: "M0 0L10 5L0 10z", fill: "currentColor" })); defs.append(marker); root.append(defs);
    const nodes = new Map(shown.map((n) => [n.id, n]));
    for (const edge of value.edges) {
      const routed = G.route(edge, shown), p = G.labelPlacement(edge, routed.points, shown), selectedEdge = selectedIds.has(edge.id), conflict = routed.blocked || p.blocked;
      if (conflict) blocked.push(edge.id);
      const group = svg("g", { "data-edge": edge.id, class: `edge ${selectedEdge ? "selected" : ""} ${conflict ? "collision" : ""}` });
      group.append(svg("path", { d: G.pathData(routed.points), stroke: "transparent", "stroke-width": 14 * view.width / 1100, fill: "none", class: "edge-hit" }));
      const line = svg("path", { d: G.pathData(routed.points), stroke: "currentColor", "stroke-width": selectedEdge ? 2.5 : 1.5, fill: "none", "pointer-events": "none" });
      if (edge.arrow !== "none") line.setAttribute("marker-end", "url(#arrow)");
      if (edge.arrow === "both") line.setAttribute("marker-start", "url(#arrow)");
      group.append(line);
      if (edge.label) group.append(svg("text", { x: p.x, y: p.y, "text-anchor": "middle", "font-size": 20, fill: "currentColor", class: "edge-label" }, edge.label));
      root.append(group);
    }
    for (const node of nodes.values()) {
      const group = svg("g", { class: `node ${selectedIds.has(node.id) ? "selected" : ""} ${colliding.has(node.id) ? "collision" : ""}`, "data-node": node.id,
        tabindex: 0, role: "button", "aria-label": node.text || "公式节点" });
      group.append(svg("rect", { x: node.x, y: node.y, width: node.width, height: node.height, rx: 4,
        stroke: node.kind === "box" || selectedIds.has(node.id) ? "currentColor" : "none", fill: "transparent" }));
      if (node.text) group.append(svg("text", { x: node.x + node.width / 2, y: node.y + (node.formula ? 24 : node.height / 2 + 5),
        "text-anchor": "middle", "font-size": node.labelFontSize, fill: "currentColor" }, node.text));
      if (node.formulaSvg?.startsWith("data:")) throw new Error("Unexpected formula encoding");
      if (node.formulaSvg) {
        const encoded = btoa(unescape(encodeURIComponent(node.formulaSvg)));
        group.append(svg("image", { x: node.x + 12, y: node.y + (node.text ? 36 : 12), width: node.width - 24,
          height: node.height - (node.text ? 48 : 24), href: `data:image/svg+xml;base64,${encoded}`, "pointer-events": "none" }));
      }
      if (selectedIds.size === 1 && selected === node.id) group.append(svg("rect", { x: node.x + node.width - 9, y: node.y + node.height - 9,
        width: 9, height: 9, fill: "currentColor", "data-resize": node.id }));
      root.append(group);
    }
    for (const edge of value.edges.filter((e) => selectedIds.has(e.id))) {
      const routed = G.route(edge, shown);
      for (const [handle, p] of [["from", routed.points[0]], ...(edge.points || []).map((p, i) => [String(i), p]), ["to", routed.points.at(-1)]]) {
        root.append(svg("circle", { cx: p.x, cy: p.y, r: 6 * view.width / 1100, class: "edge-handle", "data-handle": handle, "data-owner": edge.id, fill: "var(--vscode-editor-background,#202020)", stroke: "var(--vscode-focusBorder,#69b)", "stroke-width": 2 }));
      }
    }
    $("collision-bar").hidden = !pairs.length && !blocked.length;
    $("collision-count").textContent = `${pairs.length ? `${pairs.length} 处对象重叠` : ""}${pairs.length && blocked.length ? "；" : ""}${blocked.length ? `${blocked.length} 条连线或标签与对象冲突` : ""}`;
    $("empty").hidden = value.nodes.length + value.edges.length > 0;
  }
  function redrawAll() {
    document.body.dataset.mode = type;
    $("diagram").hidden = type !== "diagram"; $("math").hidden = type !== "math"; $("tools").hidden = type !== "diagram";
    $("close-formula").hidden = type === "math";
    const node = type === "diagram" && selectedIds.size === 1 && value.nodes.find((n) => n.id === selected);
    const edge = type === "diagram" && selectedIds.size === 1 && value.edges.find((e) => e.id === selected);
    $("properties").hidden = !node && !edge; $("formula-editor").hidden = type !== "math" && (!node || !node.formula);
    $("edit-formula").hidden = !node;
    $("route-row").hidden = $("arrow-row").hidden = $("clear-bends").hidden = !edge;
    $("label-caption").textContent = edge ? "连线标签" : "文字";
    if (node || edge) $("label").value = node ? node.text : edge.label || "";
    if (edge) { $("edge-route").value = edge.route || "straight"; $("edge-arrow").value = edge.arrow || "end"; }
    if (type === "math" || node?.formula) renderFields();
    canvas();
  }
  function point(event, clamp = true) {
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform($("canvas").getScreenCTM().inverse());
    return clamp ? G.clampPoint(p) : { x: p.x, y: p.y };
  }
  function zoom(factor, anchor = { x: view.x + view.width / 2, y: view.y + view.height / 2 }) {
    const width = Math.max(275, Math.min(4400, view.width / factor)), ratio = width / view.width;
    view = { x: anchor.x - (anchor.x - view.x) * ratio, y: anchor.y - (anchor.y - view.y) * ratio, width, height: width * 700 / 1100 };
    canvas(); saveView();
  }
  $("zoom-in").addEventListener("click", () => zoom(1.25));
  $("zoom-out").addEventListener("click", () => zoom(.8));
  $("zoom-reset").addEventListener("click", () => { view = { x: 0, y: 0, width: 1100, height: 700 }; canvas(); saveView(); });
  $("zoom-fit").addEventListener("click", () => {
    const nodes = value.nodes.map(displayNode), points = nodes.flatMap((n) => [{ x: n.x, y: n.y }, { x: n.x + n.width, y: n.y + n.height }]);
    for (const e of value.edges) {
      const route = G.route(e, nodes).points; points.push(...route);
      if (e.label) { const p = G.labelPlacement(e, route, nodes); points.push({ x: p.x - p.width / 2, y: p.y - 20 }, { x: p.x + p.width / 2, y: p.y + 8 }); }
    }
    if (!points.length) { $("zoom-reset").click(); return; }
    const minX = Math.min(...points.map((p) => p.x)) - 60, minY = Math.min(...points.map((p) => p.y)) - 60;
    const w = Math.max(275, Math.max(...points.map((p) => p.x)) - minX + 60), h = Math.max(...points.map((p) => p.y)) - minY + 60;
    const width = Math.min(4400, Math.max(w, h * 1100 / 700));
    view = { x: minX - (width - w) / 2, y: minY - (width * 700 / 1100 - h) / 2, width, height: width * 700 / 1100 };
    canvas(); saveView();
  });
  $("canvas").addEventListener("wheel", (event) => {
    event.preventDefault();
    if (drag) return;
    if (event.ctrlKey || event.metaKey) zoom(Math.exp(-Math.max(-100, Math.min(100, event.deltaY)) * .004), point(event, false));
    else {
      const scale = 1 / $("canvas").getScreenCTM().a;
      view.x += (event.shiftKey ? event.deltaY : event.deltaX) * scale;
      view.y += (event.shiftKey ? event.deltaX : event.deltaY) * scale;
      canvas(); saveView();
    }
  }, { passive: false });
  function nodeAt(p) { return [...value.nodes].reverse().map(displayNode).find((n) => p.x >= n.x && p.x <= n.x + n.width && p.y >= n.y && p.y <= n.y + n.height); }
  function edgeAt(p) {
    const nodes = value.nodes.map(displayNode), tolerance = 9 * view.width / 1100;
    return [...value.edges].reverse().find((edge) => {
      const points = G.route(edge, nodes).points;
      return points.slice(1).some((b, i) => {
        const a = points[i], dx = b.x - a.x, dy = b.y - a.y;
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
        return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy) <= tolerance;
      });
    });
  }
  function snapped(p, event) { return !event.altKey && nodeAt(p) ? nodeAt(p).id : G.clampPoint(p); }
  function cancelGesture() {
    if (drag?.before) value = drag.before;
    if (drag?.view) view = drag.view;
    drag = undefined; edgeStart = undefined; redrawAll(); persist();
  }
  $("canvas").addEventListener("pointerdown", (event) => {
    if (event.button !== 0 && event.button !== 1) return;
    if (event.button === 1) event.preventDefault(); $("canvas").focus({ preventScroll: true });
    const nodeId = event.target.closest("[data-node]")?.dataset.node, edgeId = event.target.closest("[data-edge]")?.dataset.edge;
    const node = value.nodes.find((n) => n.id === nodeId), start = point(event);
    if (event.button === 1 || tool === "pan" || spaceHeld) {
      drag = { kind: "pan", view: { ...view }, clientX: event.clientX, clientY: event.clientY, scale: $("canvas").getScreenCTM().a };
    } else if (event.target.hasAttribute("data-handle") && tool === "select") {
      drag = { kind: "handle", edgeId: event.target.dataset.owner, handle: event.target.dataset.handle, before: M.clone(value) };
    } else if (tool === "edge") {
      if (!node) { edgeStart = undefined; return; }
      if (!edgeStart) { edgeStart = node.id; notice("再点击终点节点。"); }
      else if (edgeStart !== node.id) {
        if (value.edges.length >= 64) { notice("最多 64 条连线。", true); return; }
        edit(() => value.edges.push({ id: id(), from: edgeStart, to: node.id })); edgeStart = undefined; notice("连线已添加。");
      }
      return;
    } else if (tool === "free") drag = { kind: "free", start, from: snapped(start, event), before: M.clone(value) };
    else if (tool === "formula" && node) {
      selection([node.id]); if (!node.formula) edit(() => { node.formula = M.template("fraction"); });
      redrawAll(); openFormula(); return;
    } else if (tool === "select" && (node || edgeId)) {
      const chosen = nodeId || edgeId;
      if (event.shiftKey) { const next = new Set(selectedIds); next.has(chosen) ? next.delete(chosen) : next.add(chosen); selection([...next]); redrawAll(); persist(); return; }
      if (!selectedIds.has(chosen)) selection([chosen]);
      const shown = node && displayNode(node);
      drag = { kind: event.target.hasAttribute("data-resize") ? "resize" : "move", start, before: M.clone(value), nodeId,
        ids: [...selectedIds], width: shown?.width, height: shown?.height };
      redrawAll();
    } else if (["box", "text", "formula"].includes(tool)) drag = { kind: "new", tool, start, before: M.clone(value) };
    else { drag = { kind: "marquee", start, previous: event.shiftKey ? [...selectedIds] : [] }; if (!event.shiftKey) selection([]); redrawAll(); }
    if (drag) $("canvas").setPointerCapture(event.pointerId);
  });
  $("canvas").addEventListener("pointermove", (event) => {
    if (!drag) return;
    if (drag.kind === "pan") {
      view = { ...drag.view, x: drag.view.x - (event.clientX - drag.clientX) / drag.scale, y: drag.view.y - (event.clientY - drag.clientY) / drag.scale }; canvas(); return;
    }
    const p = point(event);
    if (["new", "marquee", "free"].includes(drag.kind)) {
      $("canvas").querySelector("[data-ghost]")?.remove();
      if (drag.kind === "free") $("canvas").append(svg("path", { "data-ghost": true, d: G.pathData([drag.start, p]), stroke: "currentColor", fill: "none", "stroke-dasharray": "5 4", "pointer-events": "none" }));
      else $("canvas").append(svg("rect", { "data-ghost": true, x: Math.min(p.x, drag.start.x), y: Math.min(p.y, drag.start.y), width: Math.abs(p.x - drag.start.x), height: Math.abs(p.y - drag.start.y), stroke: "currentColor", fill: "none", "stroke-dasharray": "5 4", "pointer-events": "none" }));
      return;
    }
    value = M.clone(drag.before);
    if (drag.kind === "handle") {
      upgrade(); const edge = value.edges.find((e) => e.id === drag.edgeId);
      if (["from", "to"].includes(drag.handle)) edge[drag.handle] = snapped(p, event);
      else edge.points[Number(drag.handle)] = p;
      if (typeof edge.from === "string" && edge.from === edge.to) { value = M.clone(drag.before); return; }
    } else if (drag.kind === "move") G.move(value, drag.ids, Math.round(p.x - drag.start.x), Math.round(p.y - drag.start.y));
    else { const node = value.nodes.find((n) => n.id === drag.nodeId); node.width = Math.max(40, Math.min(600, Math.round(drag.width + p.x - drag.start.x))); node.height = Math.max(40, Math.min(500, Math.round(drag.height + p.y - drag.start.y))); }
    canvas();
  });
  $("canvas").addEventListener("pointerup", (event) => {
    if (!drag) return;
    const current = drag; drag = undefined;
    if (current.kind === "pan") { saveView(); return; }
    const p = point(event);
    if (current.kind === "marquee") {
      const rectangle = { x: Math.min(p.x, current.start.x), y: Math.min(p.y, current.start.y), width: Math.abs(p.x - current.start.x), height: Math.abs(p.y - current.start.y) };
      const nodes = value.nodes.map(displayNode), ids = nodes.filter((n) => G.overlaps(n, rectangle)).map((n) => n.id);
      for (const e of value.edges) if (G.route(e, nodes).points.every((p) => p.x >= rectangle.x && p.x <= rectangle.x + rectangle.width && p.y >= rectangle.y && p.y <= rectangle.y + rectangle.height)) ids.push(e.id);
      selection([...current.previous, ...ids]); redrawAll(); persist(); return;
    }
    if (current.kind === "free") {
      if (Math.hypot(p.x - current.start.x, p.y - current.start.y) < 5) { canvas(); return; }
      const to = snapped(p, event);
      if (value.edges.length >= 64 || (typeof to === "string" && to === current.from)) { notice("请选择不同的端点，最多 64 条连线。", true); canvas(); return; }
      upgrade(); const edge = { id: id(), from: current.from, to, points: [], route: "straight", arrow: "end", label: "" }; value.edges.push(edge); selection([edge.id]);
    } else if (current.kind === "new") {
      if (value.nodes.length >= 40) { notice("最多 40 个节点。", true); canvas(); return; }
      const kind = current.tool;
      const node = { id: id(), kind, x: Math.min(1000, Math.round(Math.min(p.x, current.start.x))), y: Math.min(600, Math.round(Math.min(p.y, current.start.y))),
        width: Math.min(600, Math.max(140, Math.round(Math.abs(p.x - current.start.x)))), height: Math.min(500, Math.max(64, Math.round(Math.abs(p.y - current.start.y)))), text: kind === "formula" ? "" : "文字" };
      if (kind === "formula") node.formula = M.template("fraction"); value.nodes.push(node); selection([node.id]);
    }
    remember(current.before); redrawAll(); changed();
    const near = current.start ? Math.hypot(p.x - current.start.x, p.y - current.start.y) < 4 : JSON.stringify(current.before) === JSON.stringify(value);
    if (tool === "select" && near && ["move", "handle"].includes(current.kind)) {
      const key = current.kind === "handle" ? `${current.edgeId}:${current.handle}` : nodeAt(p)?.id || edgeAt(p)?.id;
      if (key && lastTap?.key === key && event.timeStamp - lastTap.time < 500 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 8 * view.width / 1100) {
        lastTap = undefined; activateAt(p, current.kind === "handle" ? current.edgeId : undefined, current.handle);
      } else lastTap = { key, time: event.timeStamp, ...p };
    } else lastTap = undefined;
  });
  $("canvas").addEventListener("pointercancel", cancelGesture);
  function activateAt(location, owner, handle) {
    // A redraw during the first click replaces SVG children; browser dblclick
    // can then target the persistent SVG root. Resolve against model geometry.
    if (!owner) for (const edge of value.edges.filter((e) => selectedIds.has(e.id))) {
      const index = (edge.points || []).findIndex((p) => Math.hypot(p.x - location.x, p.y - location.y) < 8 * view.width / 1100);
      if (index >= 0) { owner = edge.id; handle = String(index); break; }
    }
    if (owner && /^\d+$/.test(handle)) { edit(() => { value.edges.find((e) => e.id === owner).points.splice(Number(handle), 1); }); return; }
    const edgeId = !nodeAt(location) && edgeAt(location)?.id;
    if (edgeId) {
      selection([edgeId]); const edge = value.edges.find((e) => e.id === edgeId);
      if ((edge.points || []).length >= 8) { notice("最多 8 个转折点。", true); return; }
      const p = location, nodes = value.nodes.map(displayNode), routed = G.route(edge, nodes);
      const stops = [routed.points[0], ...(edge.points || []), routed.points.at(-1)];
      let best = 0, distance = Infinity;
      for (let i = 0; i < stops.length - 1; i++) { const a = stops[i], b = stops[i + 1], dx = b.x - a.x, dy = b.y - a.y;
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
        const d = Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy); if (d < distance) { best = i; distance = d; }
      }
      edit(() => { upgrade(); (edge.points ||= []).splice(best, 0, p); }); return;
    }
    selection([nodeAt(location)?.id].filter(Boolean));
    if (!selected) return; redrawAll(); if (formula()) openFormula(); else $("label").focus();
  }
  document.addEventListener("keydown", (event) => {
    if (event.isComposing || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
    if (event.key === "Escape") { cancelGesture(); return; }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); if (drag) cancelGesture(); history(event.shiftKey ? "redo" : "undo"); return; }
    if (type !== "diagram") return;
    if (event.code === "Space") { event.preventDefault(); spaceHeld = true; return; }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") { event.preventDefault(); selection([...value.nodes, ...value.edges].map((n) => n.id)); redrawAll(); persist(); return; }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d") { event.preventDefault(); duplicateSelected(); return; }
    if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); removeSelected(); }
    if (event.key === "Enter" && event.target.dataset.node) { selection([event.target.dataset.node]); redrawAll(); $("label").focus(); }
    if (/^Arrow/.test(event.key) && selectedIds.size) {
      event.preventDefault(); const step = event.shiftKey ? 10 : 1;
      edit(() => G.move(value, [...selectedIds], event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0, event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0));
    }
  });
  document.addEventListener("keyup", (event) => { if (event.code === "Space") spaceHeld = false; });
  window.addEventListener("blur", () => { spaceHeld = false; if (drag) cancelGesture(); });
  window.addEventListener("message", (event) => {
    const message = event.data;
    try {
      if (message.action === "init") {
        if (message.carrier === 'python-string') $("hint").textContent = 'Python 多行字符串模式：应用会更新字符串中的标记内容。';
        type = message.type; target = message.target; sessionToken = message.sessionToken; draftId = message.draftId; draftRevision = Math.max(saved?.revision || 0, message.revision || 0);
        value = saved && saved.draftId === draftId && saved.type === type && (saved.revision || 0) >= (message.revision || 0) ? saved.value : message.value;
        value = type === "math" ? M.validateFormula(value, { draft: true }) : M.validateScene(value, { draft: true });
        const ui = (saved?.draftId === draftId && (saved.revision || 0) >= (message.revision || 0) ? saved.ui : message.ui);
        if (ui?.view && [ui.view.x, ui.view.y, ui.view.width, ui.view.height].every(Number.isFinite)
            && ui.view.width >= 275 && ui.view.width <= 4400) view = ui.view;
        if (type === "diagram") selection((ui?.selected || []).filter((id) => [...value.nodes, ...value.edges].some((n) => n.id === id)));
        setTool(["select", "pan", "box", "edge", "free", "text", "formula"].includes(ui?.tool) ? ui.tool : "select");
        redrawAll(); if (message.error) blockingNotice = message.error; changed(); if (message.error) notice(message.error, true);
      } else if (message.action === "rendered" && message.request === lastRender) {
        if (type === "math") { $("math-preview").src = message.svg; $("math-preview").hidden = false; $("math-preview").alt = "当前公式排版"; }
        else { measurements = new Map((message.nodes || []).map((n) => [n.id, n])); canvas(); }
        notice(target?.commentStyle?.pythonString ? '草稿已预览，点击应用才会更新字符串内容。' : "草稿已预览，点击应用才会修改注释。");
      } else if (message.action === "error") {
        if (["apply", "copy"].includes(message.operation || actions.get(message.request))) blockingNotice = message.text;
        if ((message.operation || actions.get(message.request)) === "apply") document.querySelectorAll("button,input,textarea,select").forEach((element) => { element.disabled = false; });
        if (actions.get(message.request) !== "render" || message.request === lastRender) {
          notice((actions.get(message.request) === "render" ? "预览未更新：" : "") + message.text, true);
          if (type === "math") $("math-preview").alt = "上次有效公式预览（未更新）";
        }
      } else if (message.action === "target") { target = message.target; persist(); notice(message.text || "目标文件已更新；草稿未写入。"); }
      else if (message.action === "notice") notice(message.text);
      if (actions.size > 100) for (const key of [...actions.keys()].slice(0, 50)) actions.delete(key);
    } catch (error) { notice(error.message, true); }
  });
  send("ready", null);
})();
