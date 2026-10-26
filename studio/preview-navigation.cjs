// Keep native cursors out of data that is about to become invisible. Existing
// outside selections keep their direction, characters and multi-cursor order.
function previewSelections(selections, blocks, lineCount) {
  const spans = [];
  for (const b of [...blocks].sort((a, b) => a.start - b.start)) {
    const last = spans[spans.length - 1];
    if (last && b.start <= last.end + 1) last.end = Math.max(last.end, b.end);
    else spans.push({ start: b.start, end: b.end });
  }
  let focusLine;
  const next = selections.map((selection) => {
    const { anchor, active } = selection;
    const start = Math.min(anchor.line, active.line), end = Math.max(anchor.line, active.line);
    const touched = blocks.find((b) => start <= b.end && end >= b.start);
    if (!touched) return selection;
    focusLine ??= touched.start;
    const span = spans.find((b) => active.line >= b.start && active.line <= b.end);
    let position = active;
    if (span) {
      const before = span.start - 1, after = span.end + 1;
      if (before < 0 && after >= lineCount) throw new Error('注释块之外没有可放置光标的行；请先在块外添加文字或换行，再预览。');
      const line = before < 0 ? after : after >= lineCount ? before
        : active.line - before <= after - active.line ? before : after;
      position = { line, character: 0 };
    }
    return { anchor: position, active: position };
  });
  return { selections: next, focusLine };
}
module.exports = { previewSelections };
