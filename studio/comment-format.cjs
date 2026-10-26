const { serialize } = require('./model.js');
// Payload stays canonical JSON. Escape comment delimiters *inside JSON strings*
// so that labels such as */ or --> cannot terminate the host comment.
function serializeComment({ type, id, value, style, indent = '', leader, interior = false, eol = '\n', minimumBodyLines = 0 }) {
  if (!style || !/^[ \t]*$/.test(indent) || (leader !== undefined && /[\r\n]/.test(leader))) throw new Error('注释包装无效');
  const lines = serialize({ type, id, value, prefix: '//', eol: '\n', minimumBodyLines }).split('\n').map((s) => s.slice(3));
  if (style.line && !interior) return lines.map((s) => `${style.noIndent ? '' : indent}${style.line}${s ? ' ' + s : ''}`).join(eol);
  if (style.pythonString) {
    if (!interior || !['"""', "'''"].includes(style.pythonString) || !/^[ \t]*$/.test(leader ?? indent)) throw new Error('三引号模式只允许更新已有标记块');
    const delimiter = style.pythonString;
    const escaped = '\\u' + delimiter.charCodeAt(0).toString(16).padStart(4, '0') + delimiter.slice(1);
    for (let i = 1; i < lines.length - 1; i++) lines[i] = lines[i].replaceAll(delimiter, escaped);
    return lines.map(s => s ? (leader ?? indent) + s : '').join(eol);
  }
  if (!style.block) throw new Error('当前位置不支持块注释写入');
  const [open, close] = style.block;
  if (open === '=begin' && !interior) indent = '';
  for (let i = 1; i < lines.length - 1; i++) for (const delimiter of [...new Set([open, close, ...(open === '<!--' ? ['--'] : [])])]) {
    const escaped = '\\u' + delimiter.charCodeAt(0).toString(16).padStart(4, '0') + delimiter.slice(1);
    lines[i] = lines[i].replaceAll(delimiter, escaped);
  }
  const prefix = leader ?? (open === '/*' ? indent + ' * ' : indent + ' ');
  const content = lines.map((s) => s ? prefix + s : prefix.trimEnd()).join(eol);
  return interior ? content : `${indent}${open}${eol}${content}${eol}${indent}${close}`;
}
module.exports = { serializeComment };
