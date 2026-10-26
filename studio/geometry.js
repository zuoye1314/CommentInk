(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CommentStudioGeometry = factory();
})(globalThis, function () {
  const bounds = { width: 1600, height: 1100 };
  const center = (n) => ({ x: n.x + n.width / 2, y: n.y + n.height / 2 });
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const same = (a, b) => Math.abs(a.x - b.x) < .01 && Math.abs(a.y - b.y) < .01;
  const clampPoint = (p) => ({ x: Math.round(Math.max(0, Math.min(bounds.width, p.x))), y: Math.round(Math.max(0, Math.min(bounds.height, p.y))) });
  function attachment(n, toward) {
    const c = center(n), dx = toward.x - c.x, dy = toward.y - c.y;
    if (!dx && !dy) return { x: c.x + n.width / 2, y: c.y };
    const t = Math.min(dx ? n.width / 2 / Math.abs(dx) : Infinity, dy ? n.height / 2 / Math.abs(dy) : Infinity);
    return { x: c.x + dx * t, y: c.y + dy * t };
  }
  const expanded = (n, gap) => ({ x: n.x - gap, y: n.y - gap, width: n.width + 2 * gap, height: n.height + 2 * gap });
  function overlaps(a, b, gap = 0) {
    return a.x < b.x + b.width + gap && a.x + a.width + gap > b.x && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;
  }
  function collisions(nodes) {
    const pairs = [];
    for (let a = 0; a < nodes.length; a++) for (let b = a + 1; b < nodes.length; b++) if (overlaps(nodes[a], nodes[b])) pairs.push([nodes[a].id, nodes[b].id]);
    return pairs;
  }
  function segmentBlocked(a, b, rectangles) {
    // Liang–Barsky against open interiors, also handles arbitrary straight lines.
    return rectangles.some((r) => {
      let lo = 0, hi = 1;
      for (const [p, d, min, max] of [[a.x, b.x - a.x, r.x + .01, r.x + r.width - .01], [a.y, b.y - a.y, r.y + .01, r.y + r.height - .01]]) {
        if (!d) { if (p <= min || p >= max) return false; }
        else { const t1 = (min - p) / d, t2 = (max - p) / d; lo = Math.max(lo, Math.min(t1, t2)); hi = Math.min(hi, Math.max(t1, t2)); if (lo > hi) return false; }
      }
      return hi > 0 && lo < 1;
    });
  }
  function simplify(points) {
    const result = [];
    for (const p of points) {
      if (result.length && same(p, result.at(-1))) continue;
      while (result.length > 1) {
        const a = result.at(-2), b = result.at(-1);
        if (Math.abs((b.x - a.x) * (p.y - b.y) - (b.y - a.y) * (p.x - b.x)) > .01
            || (b.x - a.x) * (p.x - b.x) + (b.y - a.y) * (p.y - b.y) < 0) break;
        result.pop();
      }
      result.push(p);
    }
    return result;
  }
  function orthogonal(a, b, obstacles) {
    if ([a, b].some((p) => p.x < 0 || p.y < 0 || p.x > bounds.width || p.y > bounds.height)) return null;
    const xs = [...new Set([a.x, b.x, 0, bounds.width, ...obstacles.flatMap((r) => [r.x, r.x + r.width])])].filter((x) => x >= 0 && x <= bounds.width).sort((x, y) => x - y);
    const ys = [...new Set([a.y, b.y, 0, bounds.height, ...obstacles.flatMap((r) => [r.y, r.y + r.height])])].filter((y) => y >= 0 && y <= bounds.height).sort((x, y) => x - y);
    const key = (x, y) => y * xs.length + x;
    const start = key(xs.indexOf(a.x), ys.indexOf(a.y)), goal = key(xs.indexOf(b.x), ys.indexOf(b.y));
    const costs = new Map([[start, 0]]), previous = new Map(), closed = new Set(), open = new Set([start]);
    const point = (i) => ({ x: xs[i % xs.length], y: ys[Math.floor(i / xs.length)] });
    while (open.size) {
      let current, score = Infinity;
      for (const i of open) { const s = costs.get(i) + Math.abs(point(i).x - b.x) + Math.abs(point(i).y - b.y); if (s < score) { current = i; score = s; } }
      if (current === goal) {
        const path = [point(goal)]; let i = goal;
        while (previous.has(i)) { i = previous.get(i); path.push(point(i)); }
        return simplify(path.reverse());
      }
      open.delete(current); closed.add(current);
      const x = current % xs.length, y = Math.floor(current / xs.length);
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        if (nx < 0 || nx >= xs.length || ny < 0 || ny >= ys.length) continue;
        const next = key(nx, ny);
        if (closed.has(next) || segmentBlocked(point(current), point(next), obstacles)) continue;
        const cost = costs.get(current) + distance(point(current), point(next));
        if (cost < (costs.get(next) ?? Infinity)) { costs.set(next, cost); previous.set(next, current); open.add(next); }
      }
    }
    return null;
  }
  function route(edge, nodes) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const source = typeof edge.from === "string" ? byId.get(edge.from) : null, dest = typeof edge.to === "string" ? byId.get(edge.to) : null;
    const a = source ? center(source) : edge.from, b = dest ? center(dest) : edge.to;
    const bends = edge.points || [];
    const start = source ? attachment(source, bends[0] || b) : a, end = dest ? attachment(dest, bends.at(-1) || a) : b;
    const otherNodes = nodes.filter((n) => n !== source && n !== dest);
    if (edge.route !== "orthogonal") {
      const points = [start, ...bends, end];
      return { points, blocked: points.slice(1).some((p, i) => segmentBlocked(points[i], p, otherNodes)) };
    }
    const port = (n, p) => {
      if (!n) return p;
      if (Math.abs(p.x - n.x) < .01) return { x: p.x - 12, y: p.y };
      if (Math.abs(p.x - n.x - n.width) < .01) return { x: p.x + 12, y: p.y };
      return { x: p.x, y: p.y + (Math.abs(p.y - n.y) < .01 ? -12 : 12) };
    };
    const stops = [port(source, start), ...bends, port(dest, end)], obstacles = nodes.map((n) => expanded(n, 10));
    let points = [start], blocked = false;
    for (let i = 1; i < stops.length; i++) {
      const path = orthogonal(stops[i - 1], stops[i], obstacles);
      if (path) points.push(...path);
      else { blocked = true; points.push(stops[i - 1], { x: stops[i].x, y: stops[i - 1].y }, stops[i]); }
    }
    points.push(end);
    // Includes endpoint stubs: overlapping nodes can make even a stub invalid.
    const simplified = simplify(points);
    blocked ||= simplified.slice(1).some((p, i) => segmentBlocked(simplified[i], p, otherNodes));
    return { points: simplified, blocked };
  }
  const pathData = (points) => points.map((p, i) => `${i ? "L" : "M"}${p.x} ${p.y}`).join(" ");
  function midpoint(points) {
    const length = points.slice(1).reduce((sum, p, i) => sum + distance(points[i], p), 0);
    let remaining = length / 2;
    for (let i = 1; i < points.length; i++) { const d = distance(points[i - 1], points[i]); if (remaining <= d && d) {
      return { x: points[i - 1].x + (points[i].x - points[i - 1].x) * remaining / d, y: points[i - 1].y + (points[i].y - points[i - 1].y) * remaining / d };
    } remaining -= d; }
    return points[0];
  }
  function labelPlacement(edge, points, nodes, fontSize = 20) {
    const width = [...(edge.label || "")].length * fontSize + 12, height = fontSize * 1.4;
    const mid = midpoint(points), anchors = [mid];
    for (let i = 1; i < points.length; i++) anchors.push({ x: (points[i - 1].x + points[i].x) / 2, y: (points[i - 1].y + points[i].y) / 2 });
    const candidates = anchors.flatMap((p) => [-8, fontSize + 12].map((offset) => ({ x: p.x, y: p.y + offset, width, height })));
    const collides = (p) => nodes.some((n) => overlaps({ x: p.x - width / 2, y: p.y - fontSize, width, height }, n, 5));
    const chosen = candidates.find((p) => !collides(p)) || candidates[0];
    return { ...chosen, blocked: Boolean(edge.label) && collides(chosen) };
  }
  function arrange(nodes, movableIds) {
    const ids = new Set(movableIds), fixed = nodes.filter((n) => !ids.has(n.id)), positions = new Map();
    for (const node of nodes.filter((n) => ids.has(n.id))) {
      const candidates = [{ x: node.x, y: node.y }];
      for (let y = 0; y <= 600; y += 20) for (let x = 0; x <= 1000; x += 20) candidates.push({ x, y });
      candidates.sort((a, b) => distance(a, node) - distance(b, node) || a.y - b.y || a.x - b.x);
      const p = candidates.find((p) => !fixed.some((n) => overlaps({ ...node, ...p }, n, 16)));
      if (!p) return null;
      const moved = { ...node, ...p }; fixed.push(moved); positions.set(node.id, moved);
    }
    return nodes.map((n) => positions.get(n.id) || { ...n });
  }
  function move(scene, ids, dx, dy) {
    const selected = new Set(ids), points = [];
    for (const n of scene.nodes) if (selected.has(n.id)) points.push({ x: n.x, y: n.y, maxX: 1000, maxY: 600 });
    for (const e of scene.edges) {
      const moving = selected.has(e.id), together = selected.has(e.from) && selected.has(e.to);
      for (const p of [...(moving ? [e.from, e.to] : []), ...(moving || together ? e.points || [] : [])]) if (typeof p !== "string") points.push({ ...p, maxX: 1600, maxY: 1100 });
    }
    if (points.length) {
      dx = Math.max(-Math.min(...points.map((p) => p.x)), Math.min(dx, ...points.map((p) => p.maxX - p.x)));
      dy = Math.max(-Math.min(...points.map((p) => p.y)), Math.min(dy, ...points.map((p) => p.maxY - p.y)));
    }
    for (const n of scene.nodes) if (selected.has(n.id)) { n.x += dx; n.y += dy; }
    for (const e of scene.edges) {
      if (selected.has(e.id)) { for (const side of ["from", "to"]) if (typeof e[side] !== "string") { e[side].x += dx; e[side].y += dy; } }
      if (selected.has(e.id) || (selected.has(e.from) && selected.has(e.to))) for (const p of e.points || []) { p.x = Math.max(0, Math.min(1600, p.x + dx)); p.y = Math.max(0, Math.min(1100, p.y + dy)); }
    }
  }
  return { bounds, center, attachment, overlaps, collisions, segmentBlocked, route, pathData, midpoint, labelPlacement, arrange, move, clampPoint, simplify };
});
