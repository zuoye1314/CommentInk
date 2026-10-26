const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const L = require('./comment-languages.cjs'), { serializeComment } = require('./comment-format.cjs'), { parseBlocks } = require('./parser.cjs');
const root = process.env.COMMENT_VSCODE_EXTENSIONS || '/usr/share/code/resources/app/extensions';
const ids = ['c', 'cpp', 'csharp', 'java', 'go', 'rust', 'dart', 'swift', 'objective-c', 'javascript', 'typescript', 'javascriptreact', 'typescriptreact', 'python', 'ruby', 'shellscript', 'powershell', 'php', 'lua', 'sql', 'r', 'html', 'xml', 'css', 'scss', 'less', 'yaml', 'makefile', 'dockerfile', 'perl', 'markdown', 'jsonc', 'bat', 'ini', 'latex', 'julia', 'clojure', 'fsharp', 'groovy'];
before(async () => {
  L.configureLanguages(fs.readdirSync(root).flatMap((n) => { try { return [{ extensionPath: path.join(root, n), packageJSON: JSON.parse(fs.readFileSync(path.join(root, n, 'package.json'))) }]; } catch { return []; } }));
  for (const id of ids) await L.ensureLanguage(id);
});
const value = { kind: 'token', value: 'x*/y<!--z-->w--q/*r' };
function encoded(language, style, input = value) {
  return (language === 'php' ? '<?php\n' : '') + serializeComment({ type: 'math', id: 'math', value: input, style, eol: '\r\n', minimumBodyLines:12 }) + '\r\n';
}
for (const id of ids) test(`${id}: native comment form round-trips JSON and terminator-like label text`, () => {
  const source = encoded(id, L.languageStyle(id)), parsed = parseBlocks(source, id);
  assert.equal(parsed.blocks.length, 1, JSON.stringify(parsed.diagnostics)); assert.deepEqual(parsed.blocks[0].value, value);
  assert.equal(source.slice(source.indexOf(parsed.blocks[0].identity.split('\n')[0])).length > 0, true);
});
for (const id of ids.filter((s) => !['python', 'shellscript', 'r', 'yaml', 'makefile', 'dockerfile', 'perl', 'bat', 'ini', 'latex', 'clojure'].includes(s))) test(`${id}: block comments retain enclosure and decode escaped terminators`, () => {
  const style = { block: L.languageStyle(id).block };
  const source = encoded(id, style), parsed = parseBlocks(source, id);
  assert.equal(parsed.blocks.length, 1, JSON.stringify(parsed.diagnostics)); assert.deepEqual(parsed.blocks[0].value, value); assert.ok(parsed.blocks[0].interior);
  assert.equal(typeof parsed.blocks[0].prefix, 'string');
  const b = parsed.blocks[0], lines = source.split(/\r?\n/), changed = { kind: 'token', value: 'z' };
  const updated = [...lines.slice(0, b.start), serializeComment({ type: 'math', id: b.id, value: changed, style, leader: b.leader, interior: true }), ...lines.slice(b.end + 1)].join('\n');
  assert.deepEqual(parseBlocks(updated, id).blocks[0].value, changed);
  assert.equal(updated.split(style.block[0]).length, 2); assert.equal(updated.split(style.block[1]).length, 2);
});
test('C comment insertion retains both styles and compiles without treating payload as code', () => {
  const style = { block: ['/*', '*/'] }, payload = serializeComment({ type: 'math', id: 'in', value, style, interior: true, leader: ' * ' });
  const source = '#include <stddef.h>\n/* BEFORE\n' + payload + '\n * AFTER\n */\nint add(int a, int b) { return a + b; }\n';
  const directory = fs.mkdtempSync('/tmp/comment-c-syntax-');
  try { const file = path.join(directory, 'comment.c'); fs.writeFileSync(file, source); execFileSync('gcc', ['-std=c11', '-fsyntax-only', file], { timeout: 10000 }); } finally { fs.rmSync(directory, { recursive: true }); }
  const p = parseBlocks(source, 'c'); assert.equal(p.blocks.length, 1); assert.ok(p.contexts[2].kind === 'block');
  assert.deepEqual(p.blocks[0].value, value); assert.ok(source.startsWith('#include <stddef.h>\n/* BEFORE\n')); assert.ok(source.endsWith('int add(int a, int b) { return a + b; }\n'));
});
test('C escaped strings, C++ raw strings, Java text blocks and shell heredocs cannot impersonate comments', () => {
  const fake = '// @math begin v1 fake\n// x\n// @math end';
  const cases = [
    ['c', 'const char *s = "a\\\n' + fake.replaceAll('\n', '\\\n') + '";\n'],
    ['cpp', 'const char *s = R"tag(\n' + fake + '\n)tag";\n'],
    ['java', 'class A { String s = """\n' + fake + '\n"""; }\n'],
    ['shellscript', "cat <<'END'\n# @math begin v1 fake\n# x\n# @math end\nEND\n"],
    ['ruby', "s = <<'END'\n# @math begin v1 fake\n# x\n# @math end\nEND\n"],
    ['powershell', "$s = @'\n# @math begin v1 fake\n# x\n# @math end\n'@\n"],
    ['lua', 'local s = [[\n-- @math begin v1 fake\n-- x\n-- @math end\n]]\n'],
  ];
  for (const [id, prefix] of cases) {
    const p = parseBlocks(prefix + encoded(id, L.languageStyle(id), { kind: 'token', value: 'real' }), id);
    assert.deepEqual(p.blocks.map((b) => b.id), ['math'], id); assert.ok(p.unsafeLines.includes(1), id);
  }
});
test('nested comments, unclosed comments, macro continuations and host-language boundaries remain protected', () => {
  const nested = '/* outer\n/* inner */\n * PLACE\n */\n';
  for (const id of ['rust', 'swift']) assert.equal(parseBlocks(nested, id).contexts[2].kind, 'block');
  assert.ok(parseBlocks('/* unclosed\nPLACE\n', 'c').unsafeLines.includes(1));
  assert.ok(parseBlocks('#define X \\\n 1\n', 'c').unsafeLines.includes(1));
  assert.ok(parseBlocks('<html>\noutside\n<?php\n$x=1;\n?>\n', 'php').unsafeLines.includes(1));
  assert.ok(parseBlocks('<script>\nlet x=1;\n</script>\n', 'html').unsafeLines.includes(1));
});
test('a block may not consume a marker from another physical comment container', () => {
  const p = parseBlocks('/*\n * @math begin v1 x\n * x\n */\n/*\n * @math end\n */\n', 'c');
  assert.equal(p.blocks.length, 0); assert.match(p.diagnostics[0].message, /边界|闭合/);
});
test('Lua long-bracket comment levels keep their actual delimiter and never turn payload into a long string', () => {
  const style = { block: ['--[=[', ']=]'] }, source = encoded('lua', style);
  const p = parseBlocks(source, 'lua'); assert.equal(p.blocks.length, 1); assert.deepEqual(p.blocks[0].value, value);
  assert.deepEqual(p.blocks[0].commentStyle.block, style.block);
});
test('strict JSON and unconfigured language modes fail with an actionable explanation', async () => {
  await assert.rejects(L.ensureLanguage('json'), /不允许注释/); await assert.rejects(L.ensureLanguage('plaintext'), /语言模式/);
});
module.exports = { ids };
