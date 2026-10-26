const { test } = require('node:test'), assert = require('node:assert/strict');
const { previewSelections } = require('./preview-navigation.cjs');
const selection = (a, c = a, ac = 0, cc = ac) => ({ anchor: { line: a, character: ac }, active: { line: c, character: cc } });
const blocks = [{ start: 10, end: 20 }];
test('inside cursor chooses nearest block boundary instead of distant EOF', () => {
  for (const [line, expected] of [[10, 9], [14, 9], [15, 9], [16, 21], [20, 21]])
    assert.equal(previewSelections([selection(line)], blocks, 500).selections[0].active.line, expected);
});
test('document start/end and adjacent blocks never produce a hidden or invalid position', () => {
  assert.equal(previewSelections([selection(2)], [{ start: 0, end: 5 }], 100).selections[0].active.line, 6);
  assert.equal(previewSelections([selection(99)], [{ start: 90, end: 99 }], 100).selections[0].active.line, 89);
  assert.equal(previewSelections([selection(19)], [...blocks, { start: 21, end: 30 }], 100).selections[0].active.line, 9);
});
test('unaffected ranges retain direction and characters; multi-cursor order is preserved', () => {
  const outside = selection(8, 2, 4, 1), inside = selection(18), after = selection(45, 45, 7);
  const result = previewSelections([outside, inside, after], blocks, 500).selections;
  assert.equal(result.length, 3); assert.equal(result[0], outside); assert.equal(result[2], after);
  assert.deepEqual(result[1], selection(21));
});
test('a crossing range collapses to its visible active end without moving it', () => {
  for (const range of [selection(5, 25, 1, 3), selection(25, 5, 3, 1)]) {
    const next = previewSelections([range], blocks, 100).selections[0];
    assert.deepEqual(next.active, range.active); assert.deepEqual(next.anchor, range.active);
  }
});
test('whole-document data has no safe position and fails without mutating selections', () => {
  const input = [selection(2)]; const saved = JSON.stringify(input);
  assert.throws(() => previewSelections(input, [{ start: 0, end: 4 }], 5), /没有可放置光标/);
  assert.equal(JSON.stringify(input), saved);
});
