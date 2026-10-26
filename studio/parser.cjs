const crypto = require('node:crypto');
const { parser: python } = require('@lezer/python');
const { parser: javascript } = require('@lezer/javascript');
const { validateFormula, validateScene, toTex } = require('./model.js');
const parsers = { python, javascript, typescript: javascript.configure({ dialect: 'ts' }),
  javascriptreact: javascript.configure({ dialect: 'jsx' }), typescriptreact: javascript.configure({ dialect: 'ts jsx' }) };
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const beginPattern = /^@(math|diagram)[ \t]+begin[ \t]+v(\d+)[ \t]+([\w-]{1,64})[ \t]*$/;
const endPattern = /^@(math|diagram)[ \t]+end[ \t]*$/;
function markerContent(row) {
  if (!row) return '';
  let text = row.content.trimStart();
  // Only C-style block markers may have extra decorative stars. Payload rows
  // never pass through this normalization.
  if (row.style.block?.[0] === '/*') text = text.replace(/^(?:\*[ \t]*)+/, '');
  return text;
}
function prefixIssue(row) {
  const text = markerContent(row);
  const match = /(@(?:math|diagram)[ \t]+(?:begin[ \t]+v\d+[ \t]+[\w-]{1,64}|end))[ \t]*$/.exec(text);
  if (!match || match.index === 0) return;
  const extra = text.slice(0, match.index).trim();
  return `标记前存在非注释装饰内容「${extra.slice(0, 60)}」，请删除这些内容或将说明移到上一行`;
}
function parseCommentRows(text, lexical) {
  const lines = text.split(/\r?\n/), blocks = [], diagnostics = [...(lexical.diagnostics || [])], { rows } = lexical;
  for (const [line, row] of rows) {
    const message = prefixIssue(row);
    if (message) diagnostics.push({ line, message });
  }
  for (let start = 0; start < lines.length; start++) {
    const first = rows.get(start), match = beginPattern.exec(markerContent(first));
    if (!match) continue;
    const [, type, versionText, id] = match, version = Number(versionText);
    let end = start + 1;
    while (end < lines.length && rows.get(end)?.container === first.container
        && !endPattern.test(markerContent(rows.get(end))) && !beginPattern.test(markerContent(rows.get(end)))) end++;
    try {
      if (rows.get(end)?.container !== first.container) throw new Error('注释块未闭合或越过了注释边界');
      if (endPattern.exec(markerContent(rows.get(end)))?.[1] !== type) throw new Error('开始和结束标记缺失或类型不匹配');
      if (![1, 2].includes(version)) throw new Error('未知注释版本，保留原文');
      const body = Array.from({ length: end - start - 1 }, (_, i) => rows.get(start + i + 1)?.content);
      if (!body.length || body.some((s) => typeof s !== 'string')) throw new Error('块内包含非注释内容');
      const bodyText = body.join('\n');
      if (bodyText.length > 64 * 1024) throw new Error('单个图表超过 64 KiB');
      let value, tex;
      if (type === 'math' && version === 1) { tex = bodyText; value = validateFormula({ kind: 'raw', tex }); }
      else {
        const data = JSON.parse(bodyText);
        if (data.version !== version) throw new Error('标记与数据版本不一致');
        value = type === 'math' ? validateFormula(data.formula) : validateScene(data);
        if (type === 'math') tex = toTex(value);
      }
      const identity = lines.slice(start, end + 1).join('\n');
      blocks.push({ id, type, version, start, end, bodyStart: start + 1, bodyCount: body.length, value, tex, identity, fingerprint: hash(identity),
        prefix: first.style.line || (first.style.pythonString ? '' : first.leader.trim()),
        indent: first.leader.match(/^[ \t]*/)[0], commentStyle: first.style, leader: first.leader,
        interior: !!(first.style.block || first.style.pythonString), carrier: first.style.pythonString ? 'python-string' : 'comment' });
      start = end;
    } catch (e) { diagnostics.push({ line: start, id, message: e.message }); }
  }
  const counts = new Map();
  for (const b of blocks) counts.set(b.id, (counts.get(b.id) || 0) + 1);
  return { ...lexical, rows: undefined, blocks: blocks.filter((b) => {
    if (counts.get(b.id) === 1) return true;
    diagnostics.push({ line: b.start, id: b.id, message: '同一文件中标识重复，保留这些块的源码' }); return false;
  }), diagnostics };
}
function parseLegacy(text, language) {
  const parser = parsers[language], blocks = [], diagnostics = [];
  const deadline = Date.now() + 80, work = parser.startParse(text);
  let tree;
  while (!(tree = work.advance())) if (Date.now() > deadline) return { blocks, diagnostics: [{ message: '语法识别超时，保留源码' }] };
  const offsets = [0], lines = text.split(/\r?\n/), rows = new Map();
  for (const match of text.matchAll(/\n/g)) offsets.push(match.index + 1);
  function lineAt(offset) {
    let lo = 0, hi = offsets.length;
    while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (offsets[mid] <= offset) lo = mid; else hi = mid; }
    return lo;
  }
  let syntaxError = false;
  const folds = [], unsafeLines = new Set();
  tree.iterate({ enter(node) {
    if (node.type.isError) syntaxError = true;
    if (/String|BlockComment/.test(node.name)) {
      for (let line = lineAt(node.from) + 1; line <= lineAt(Math.max(node.from, node.to - 1)); line++) unsafeLines.add(line);
    }
    if (language === 'python' && ['String', 'FormatString'].includes(node.name)) {
      const literal = text.slice(node.from, node.to), opening = /^([rubf]*)("""|''')/i.exec(literal);
      if (opening && literal.endsWith(opening[2])) {
        const a = lineAt(node.from + opening[0].length), z = lineAt(node.to - 3);
        const inner = literal.slice(opening[0].length, -3), trimmed = inner.trim();
        // A whole explicitly marked literal opts in. Ordinary prose, strings
        // containing commented examples, interpolation and bytes stay distinct.
        if (/^@(math|diagram)[ \t]+begin\b/.test(trimmed) && /@(math|diagram)[ \t]+end$/.test(trimmed)) {
          if (/[bf]/i.test(opening[1])) diagnostics.push({ line: a, message: 'Python 三引号预览暂不支持 f 字符串或 bytes；请使用普通/r 三引号或 # 注释' });
          else if (text.slice(node.from + opening[0].length, offsets[a + 1] ?? text.length).trim()
              || text.slice(offsets[z], node.to - 3).trim()) diagnostics.push({ line: a, message: '三引号模式的标记和引号需分别放在独立行' });
          else for (let line = a + 1; line < z; line++) {
            const leader = lines[line].match(/^[ \t]*/)[0];
            rows.set(line, { content: lines[line].slice(leader.length), leader, container: `python-string:${node.from}`,
              style: { pythonString: opening[2], stringPrefix: opening[1] } });
          }
        }
      }
      return false;
    }
    if (['Body', 'Block', 'ClassBody', 'ObjectExpression', 'ArrayExpression', 'DictionaryExpression', 'TupleExpression', 'ArgList'].includes(node.name)) {
      const start = lineAt(node.from); let end = lineAt(Math.max(node.from, node.to - 1));
      if (/^\s*[}\])]\s*;?\s*$/.test(text.slice(offsets[end], offsets[end + 1] || text.length))) end--;
      if (end > start) folds.push({ start, end });
    }
    if (node.name !== 'Comment' && node.name !== 'LineComment') return;
    const line = lineAt(node.from), indent = text.slice(offsets[line], node.from), prefix = language === 'python' ? '#' : '//';
    const content = text.slice(node.from, node.to).replace(/\r$/, '');
    if (!unsafeLines.has(line) && /^[ \t]*$/.test(indent) && content.startsWith(prefix)) {
      const space = content[prefix.length] === ' ' ? ' ' : '', leader = indent + prefix + space;
      rows.set(line, { content: content.slice(prefix.length + space.length), leader, container: 'line', style: { line: prefix } });
    }
  } });
  // Keep the parser's recovery guard: malformed host syntax cannot authorize edits.
  if (syntaxError) return { blocks, diagnostics: [...diagnostics, { message: '文件存在语法错误，暂时保留源码以避免误识别' }] };
  return parseCommentRows(text, { rows, diagnostics, folds, unsafeLines: [...unsafeLines] });
}
function parseBlocks(text, language) {
  if (text.length > 1024 * 1024) return { blocks: [], diagnostics: [{ message: '文件超过 1 MiB，保留源码' }] };
  const old = parsers[language] ? parseLegacy(text, language) : null;
  if (old && !old.unsafeLines) return old;
  try {
    const { tokenizeComments } = require('./comment-languages.cjs');
    const lexical = language === 'python' ? null : tokenizeComments(text, language);
    if (!lexical) return old || { blocks: [], diagnostics: [{ message: '此文件类型的注释识别尚未加载，请重新运行注释画布命令。' }] };
    const parsed = parseCommentRows(text, lexical);
    parsed.folds = old?.folds || parsed.folds;
    return parsed;
  } catch (e) { return { blocks: [], diagnostics: [{ message: e.message }] }; }
}
module.exports = { parseBlocks, hash };
