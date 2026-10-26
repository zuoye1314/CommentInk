// The extension only decorates this file. Its source must stay unchanged.
function layoutProbe(x) {
  const BEFORE_PROBE = "CODE BEFORE THE IMAGE MUST REMAIN VISIBLE";
  // @comment-diagram probe
  const AFTER_PROBE = "CODE AFTER THE IMAGE MUST REMAIN VISIBLE";
  const NEIGHBOR_02 = x + 2;
  const NEIGHBOR_03 = x + 3;
  const NEIGHBOR_04 = x + 4;
  const NEIGHBOR_05 = x + 5;
  const NEIGHBOR_06 = x + 6;
  const NEIGHBOR_07 = x + 7;
  const NEIGHBOR_08 = x + 8;
  const NEIGHBOR_09 = x + 9;
  const NEIGHBOR_10 = x + 10;
  const NEIGHBOR_11 = x + 11;
  const NEIGHBOR_12 = x + 12;
  return { BEFORE_PROBE, AFTER_PROBE, NEIGHBOR_02, NEIGHBOR_03,
    NEIGHBOR_04, NEIGHBOR_05, NEIGHBOR_06, NEIGHBOR_07, NEIGHBOR_08,
    NEIGHBOR_09, NEIGHBOR_10, NEIGHBOR_11, NEIGHBOR_12 };
}
