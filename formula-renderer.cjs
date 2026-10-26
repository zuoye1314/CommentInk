let engine;

function getEngine() {
  if (engine) return engine;
  const { mathjax } = require("@mathjax/src/js/mathjax.js");
  const { TeX } = require("@mathjax/src/js/input/tex.js");
  const { SVG } = require("@mathjax/src/js/output/svg.js");
  const { liteAdaptor } = require("@mathjax/src/js/adaptors/liteAdaptor.js");
  const { RegisterHTMLHandler } = require("@mathjax/src/js/handlers/html.js");
  const { MathJaxTexFont } = require("@mathjax/mathjax-tex-font/js/svg.js");
  require("@mathjax/src/js/input/tex/base/BaseConfiguration.js");
  require("@mathjax/src/js/input/tex/ams/AmsConfiguration.js");
  const adaptor = liteAdaptor();
  RegisterHTMLHandler(adaptor);
  const input = new TeX({ packages: ["base", "ams"], maxBuffer: 8192,
    formatError(_jax, error) { throw new Error(error.message); } });
  const output = new SVG({ fontData: MathJaxTexFont, fontCache: "none" });
  const document = mathjax.document("", { InputJax: input, OutputJax: output });
  engine = { adaptor, document };
  return engine;
}

function renderFormula(tex, { fontSize = 20, color = "#d4d4d4" } = {}) {
  if (!tex.trim() || tex.length > 8192) throw new Error("Invalid formula size");
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error("Invalid formula color");
  if (!Number.isFinite(fontSize) || fontSize < 10 || fontSize > 40) throw new Error("Invalid formula font size");
  // This prototype only enables base and AMS math. No dynamic packages, HTML,
  // external resources or user-defined macros are loaded.
  if (/\\(?:require|href|url|includegraphics|html\w*|def|gdef|newcommand|renewcommand)\b/.test(tex)) {
    throw new Error("This command is not supported by the offline formula prototype");
  }
  const { adaptor, document } = getEngine();
  const container = document.convert(tex, { display: true, em: fontSize,
    ex: fontSize / 2, containerWidth: 1000 });
  const source = adaptor.outerHTML(container);
  // Tall delimiters/matrices contain nested <svg> elements. A non-greedy
  // regular expression stops at the first nested closing tag and truncates
  // the output. Read the actual root and all its children from the adaptor.
  const svgNode = adaptor.childNodes(container).find((node) => adaptor.kind(node) === "svg");
  if (!svgNode || source.includes("data-mjx-error")) throw new Error("Formula could not be typeset");
  const viewBox = (adaptor.getAttribute(svgNode, "viewBox") || "").split(/\s+/).map(Number);
  if (viewBox.length !== 4 || viewBox.some((number) => !Number.isFinite(number))) {
    throw new Error("Invalid formula bounds");
  }
  const scale = fontSize / 1000;
  const width = Math.ceil(viewBox[2] * scale) + 8;
  const height = Math.ceil(viewBox[3] * scale) + 8;
  if (width > 1000 || height > 600) throw new Error("Formula exceeds the prototype display limit");
  const inner = `<svg x="4" y="4" width="${viewBox[2] * scale}" height="${viewBox[3] * scale}" viewBox="${viewBox.join(" ")}" style="color:${color}" fill="${color}">${adaptor.innerHTML(svgNode)}</svg>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${inner}</svg>`;
  return { width, height, inner, svg, fontSize, engine: "MathJax", viewBox };
}

module.exports = { renderFormula };
