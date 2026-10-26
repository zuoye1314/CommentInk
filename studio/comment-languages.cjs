// Read language contributions through the public extension manifest API. No
// workspace grammar/code is executed, and no workbench DOM is inspected.
const fs = require('node:fs/promises');
const path = require('node:path');
const tm = require('vscode-textmate');
const onig = require('vscode-oniguruma');
const jsonc = require('jsonc-parser');
const sources = new Map(), scopes = new Map(), engines = new Map(), loading = new Map();
const legacy = { python: '#', javascript: '//', typescript: '//', javascriptreact: '//', typescriptreact: '//' };
let registry, wasm;
const excluded = new Set(['json', 'plaintext', 'log', 'diff', 'git-commit', 'git-rebase', 'csv', 'tsv']);
function configureLanguages(extensions) {
  for (const extension of extensions) {
    const root = extension.extensionPath, contributes = extension.packageJSON?.contributes;
    if (!root || !contributes) continue;
    for (const grammar of contributes.grammars || []) {
      if (typeof grammar.scopeName !== 'string' || typeof grammar.path !== 'string') continue;
      scopes.set(grammar.scopeName, { root, file: grammar.path });
      if (grammar.language && !excluded.has(grammar.language)) {
        const old = sources.get(grammar.language) || {};
        sources.set(grammar.language, { ...old, scope: grammar.scopeName, label: old.label || grammar.language });
      }
    }
    for (const language of contributes.languages || []) if (language.configuration && !excluded.has(language.id)) {
      sources.set(language.id, { ...sources.get(language.id), root, file: language.configuration, label: language.aliases?.[0] || language.id });
    }
  }
}
async function readContribution(root, file) {
  const resolved = path.resolve(root, file);
  if (!resolved.startsWith(path.resolve(root) + path.sep)) throw new Error('语言资源路径无效');
  if ((await fs.stat(resolved)).size > 8 * 1024 * 1024) throw new Error('语言资源过大');
  return { text: await fs.readFile(resolved, 'utf8'), file: resolved };
}
function languageIds() { return [...new Set([...Object.keys(legacy), ...sources.keys()])]; }
function languageStyle(language) {
  return engines.get(language)?.style || (legacy[language] ? { line: legacy[language], block: language === 'python' ? undefined : ['/*', '*/'] } : undefined);
}
function languageReady(language) { return language === 'python' || engines.has(language); }
async function ensureLanguage(language) {
  if (languageReady(language)) return languageStyle(language);
  if (loading.has(language)) return loading.get(language);
  const promise = (async () => {
    const source = sources.get(language);
    if (!source?.root || !source.scope) throw new Error(language === 'json' ? 'JSON 不允许注释；请使用 JSON with Comments（JSONC）或其他支持注释的语言。' : `当前语言「${source?.label || language}」没有可用的注释语法；请检查右下角语言模式或安装对应语言支持。`);
    const config = jsonc.parse((await readContribution(source.root, source.file)).text);
    const comments = config?.comments || {}, style = {};
    const lineComment = typeof comments.lineComment === 'object' ? comments.lineComment?.comment : comments.lineComment;
    if (typeof lineComment === 'string' && lineComment.trim().length <= 8) { style.line = lineComment.trimEnd(); style.noIndent = !!comments.lineComment?.noIndent; }
    if (Array.isArray(comments.blockComment) && comments.blockComment.length === 2
        && comments.blockComment.every((s) => typeof s === 'string' && s.length >= 2 && s.length <= 12 && !/[\r\n]/.test(s))) style.block = comments.blockComment;
    if (!style.line && !style.block) throw new Error(`当前语言「${source.label}」未声明可用的注释语法，未修改文件。`);
    if (!registry) {
      wasm ||= fs.readFile(require.resolve('vscode-oniguruma/release/onig.wasm')).then((bytes) => onig.loadWASM(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
      registry = new tm.Registry({
        onigLib: wasm.then(() => ({ createOnigScanner: (s) => new onig.OnigScanner(s), createOnigString: (s) => new onig.OnigString(s) })),
        loadGrammar: async (scope) => {
          const entry = scopes.get(scope); if (!entry) return null;
          const raw = await readContribution(entry.root, entry.file); return tm.parseRawGrammar(raw.text, raw.file);
        },
      });
    }
    const grammar = await registry.loadGrammar(source.scope);
    if (!grammar) throw new Error(`无法加载「${source.label}」注释语法，未修改文件。`);
    engines.set(language, { grammar, style }); return style;
  })();
  loading.set(language, promise);
  try { return await promise; } catch (e) { loading.delete(language); throw e; }
}
function commentToken(token) {
  const comment = token.scopes.findIndex((s) => /^comment(?:\.|$)/.test(s));
  const string = token.scopes.findIndex((s) => /^string(?:\.|$)/.test(s));
  return comment >= 0 && (string < 0 || string > comment);
}
function tokenizeComments(text, language) {
  const engine = engines.get(language);
  if (!engine) return null;
  const { grammar, style } = engine, lines = text.split(/\r?\n/), starts = [0], spans = [], byLine = new Map(), unsafe = new Set();
  for (const m of text.matchAll(/\n/g)) starts.push(m.index + 1);
  const deadline = Date.now() + 250;
  let stack = tm.INITIAL;
  for (let line = 0; line < lines.length; line++) {
    const raw = lines[line], first = raw.search(/\S/), result = grammar.tokenizeLine(raw, stack, 25); stack = result.ruleStack;
    if (result.stoppedEarly || Date.now() > deadline) throw new Error('注释语法识别超时，保留源码；可尝试较小的文件。');
    if (line && /\\\s*$/.test(lines[line - 1]) && ['c', 'cpp', 'cuda-cpp', 'objective-c', 'objective-cpp', 'shellscript', 'makefile'].includes(language)) unsafe.add(line);
    if (language === 'php' && (/<\?(?:php|=)?|\?>/.test(raw) || !result.tokens.some((t) => t.scopes.some((s) => s === 'source.php' || /^meta\.embedded.*\.php$/.test(s))))) unsafe.add(line);
    if (['html', 'xml', 'markdown'].includes(language) && result.tokens.some((t) => t.scopes.some((s) => /^source\.(?:js|css|ts|python|ruby|php)(?:\.|$)/.test(s)))) unsafe.add(line);
    for (const t of result.tokens) {
      const start = Math.min(t.startIndex, raw.length), end = Math.min(t.endIndex, raw.length);
      if (commentToken(t)) {
        const block = t.scopes.some((s) => /^comment\.block(?:\.|$)/.test(s));
        const kind = block ? 'block' : style.line && (t.scopes.some((s) => /^comment\.line(?:\.|$)/.test(s)) || raw.trimStart().startsWith(style.line)) ? 'line' : 'block';
        const span = { start: starts[line] + start, end: starts[line] + end, line, kind }; spans.push(span);
        if (!byLine.has(line)) byLine.set(line, []); byLine.get(line).push(span);
      } else if (t.scopes.some((s) => /^string(?:\.|$)/.test(s)) && start <= Math.max(0, first)) unsafe.add(line);
    }
  }
  const containers = [], rows = new Map(), contexts = [];
  let active, depth = 0;
  const nested = ['rust', 'swift', 'kotlin', 'scala', 'haskell', 'fsharp', 'julia', 'sql'].includes(language);
  for (const span of spans) {
    if (span.kind !== 'block' || !style.block) continue;
    let pos = span.start;
    while (pos < span.end) {
      if (!active) {
        let [open, close] = style.block, at;
        if (language === 'lua') {
          const m = /--\[(=*)\[/.exec(text.slice(pos, span.end));
          if (!m) break; open = m[0]; close = ']' + m[1] + ']'; at = pos + m.index;
        } else { const local = text.slice(pos, span.end).indexOf(open); at = local < 0 ? -1 : pos + local; }
        if (at < 0 || at >= span.end) break;
        active = { start: at, kind: 'block', open, close }; depth = 1; pos = at + open.length;
      } else {
        const { open, close } = active;
        const segment = text.slice(pos, span.end), endAt = segment.indexOf(close), nextAt = nested ? segment.indexOf(open) : -1;
        const end = endAt < 0 ? -1 : pos + endAt, next = nextAt < 0 ? -1 : pos + nextAt;
        if (next >= 0 && next < span.end && (end < 0 || next < end)) { depth++; pos = next + open.length; }
        else if (end >= 0 && end < span.end) {
          depth--; pos = end + close.length;
          if (!depth) { containers.push({ ...active, end: pos, key: `block:${active.start}` }); active = undefined; }
        } else break;
      }
    }
  }
  let containerIndex = 0;
  for (let line = 0; line < lines.length; line++) {
    if (!(line % 128) && Date.now() > deadline) throw new Error('注释语法识别超时，保留源码；可尝试较小的文件。');
    const raw = lines[line], offset = starts[line], indent = raw.match(/^[ \t]*/)[0];
    while (containers[containerIndex]?.end <= offset) containerIndex++;
    const candidate = containers[containerIndex];
    const inside = candidate?.start < offset && candidate.end > offset ? candidate : undefined;
    if (active && active.start < offset) unsafe.add(line);
    if (inside) {
      const closing = raw.trimStart().startsWith(inside.close);
      const star = inside.open === '/*' && /^\s*\*(?!\/)/.test(raw);
      const leader = star ? raw.match(/^[ \t]*\* ?/)[0] : closing && inside.open === '/*' ? indent + '* ' : indent;
      contexts[line] = { kind: 'block', open: inside.open, close: inside.close, leader };
      // Delimiters must be on their own rows; never absorb surrounding code.
      if (inside.end > offset + raw.length && !closing) rows.set(line, { content: raw.slice(leader.length), leader, container: inside.key, style: { block: [inside.open, inside.close] } });
      continue;
    }
    contexts[line] = { kind: 'outside' };
    const prefix = style.line;
    if (prefix && raw.slice(indent.length).startsWith(prefix)) {
      const start = offset + indent.length;
      const pieces = (byLine.get(line) || []).filter((s) => s.kind === 'line');
      if (pieces.some((s) => s.start <= start + (language === 'bat' ? 1 : 0) && s.end > start) && pieces.some((s) => s.end >= offset + raw.length)) {
        const after = indent.length + prefix.length, leader = raw.slice(0, after + (raw[after] === ' ' ? 1 : 0));
        rows.set(line, { content: raw.slice(leader.length), leader, container: 'line', style: { line: prefix } });
      }
    }
  }
  return { rows, contexts, unsafeLines: [...unsafe], folds: [] };
}
module.exports = { configureLanguages, ensureLanguage, languageIds, languageStyle, languageReady, tokenizeComments };
