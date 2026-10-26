const { parentPort } = require("node:worker_threads");
const { renderValue } = require("./render.cjs");
const { reflowFormula } = require("../formula-reflow.cjs");
parentPort.on("message", ({ id, type, value, options }) => {
  try { parentPort.postMessage({ id, result: type === "reflow" ? reflowFormula(value.tex, options) : renderValue(type, value, options) }); }
  catch (error) { parentPort.postMessage({ id, error: error.message }); }
});
