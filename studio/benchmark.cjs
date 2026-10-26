// Focused local measurements, not a UI latency or release-wide performance claim.
const { performance } = require("node:perf_hooks");
const os = require("node:os");
const fs = require("node:fs/promises");
const assert = require("node:assert/strict");
const M = require("./model.js");
const { parseBlocks } = require("./parser.cjs");
const { RenderPool } = require("./render-pool.cjs");
const formula = { kind: "fraction", numerator: M.token("x-μ"), denominator: { kind: "sqrt", body: {
  kind: "sequence", items: [{ kind: "power", base: M.token("σ"), exponent: M.token("2") }, M.token("+ε")],
} } };
const stats = (samples) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return { count: sorted.length, medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], maxMs: sorted.at(-1) };
};
async function main() {
  const result = { at: new Date().toISOString(), environment: { platform: process.platform, node: process.version,
    cpu: os.cpus()[0].model }, parsing: {}, rendering: {} };
  for (const [language, prefix] of [["python", "#"], ["typescript", "//"]]) {
    let source = Array.from({ length: 20 }, (_, i) => M.serialize({ type: "math", id: `f${i}`, value: formula, prefix })).join("\n") + "\n";
    const remaining = 5000 - source.split("\n").length;
    source += Array.from({ length: remaining }, (_, i) => language === "python" ? `value_${i} = ${i}` : `const value_${i} = ${i};`).join("\n") + "\n";
    const samples = [], failures = [];
    for (let i = 0; i < 100; i++) {
      const start = performance.now(); const parsed = parseBlocks(source + `${prefix} change ${i}\n`, language);
      samples.push(performance.now() - start);
      if (parsed.blocks.length !== 20 || parsed.diagnostics.length) failures.push({ iteration: i, diagnostics: parsed.diagnostics });
    }
    result.parsing[language] = { ...stats(samples), lines: source.split("\n").length, bytes: Buffer.byteLength(source), failures };
  }
  let encoded = M.serialize({ type: "math", id: "roundtrip", value: formula, prefix: "//" });
  for (let i = 0; i < 100; i++) {
    const decoded = parseBlocks(encoded, "typescript").blocks[0];
    assert.deepEqual(decoded.value, formula);
    encoded = M.serialize({ type: "math", id: "roundtrip", value: decoded.value, prefix: "//" });
  }
  result.roundTrips = 100;
  const pool = new RenderPool();
  try {
    const start = performance.now(); await pool.render("math", formula, { color: "#ffffff", fontSize: 20 });
    result.rendering.firstWorkerRequestMs = performance.now() - start;
    const samples = [];
    for (let i = 0; i < 100; i++) {
      const value = M.clone(formula); value.numerator.value += String(i);
      const begin = performance.now(); await pool.render("math", value, { color: "#ffffff", fontSize: 20 });
      samples.push(performance.now() - begin);
    }
    result.rendering.warmUniqueRequests = stats(samples);
    result.rendering.cacheEntries = pool.cache.size; result.rendering.cacheBytes = pool.cacheBytes;
    assert.ok(pool.cache.size <= 32 && pool.cacheBytes <= 8 * 1024 * 1024);
  } finally { pool.dispose(); }
  console.log(JSON.stringify(result, null, 2));
  if (process.argv[2]) await fs.writeFile(process.argv[2], JSON.stringify(result, null, 2));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
