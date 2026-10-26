// A conservative bounded width avoids inaccessible horizontal overflow in the
// tested 700px window / 1200px split layout. This does not read workbench DOM or
// claim to measure every possible editor viewport.
function fitInline(rendered, fontSize, maxWidth = 480) {
  if (rendered.width <= maxWidth) return { ...rendered, scale: 1 };
  const scale = maxWidth / rendered.width;
  if (fontSize * scale < 14) throw new Error("图表或公式太宽，缩放后会难以阅读；请在画布中调整布局，源码已保留");
  const width = maxWidth, height = Math.ceil(rendered.height * scale);
  const inner = `<g transform="scale(${scale})">${rendered.inner}</g>`;
  return { ...rendered, width, height, inner, scale, originalWidth: rendered.width,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${inner}</svg>` };
}
// Source rows can be physically empty, so their native text positions cannot
// supply a common indentation anchor. Resolve tabs in the marker's indent.
function indentColumns(indent, tabSize = 4) {
  let column = 0;
  for (const char of indent) column = char === '\t' ? column + tabSize - column % tabSize : column + 1;
  return column;
}
module.exports = { fitInline, indentColumns };
