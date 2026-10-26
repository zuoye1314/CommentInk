// Real payload lines provide the space; the probe never inserts padding lines.
function boundedDiagramProbe(x) {
  const BEFORE_BLOCK = "CODE BEFORE THE COMMENT BLOCK";
  // @comment-diagram begin v1 standardization
  // title: Standardization
  // summary: x -> z; z = (x - mu) / sigma
  // data:
  // {
  //   "schemaVersion": 1,
  //   "id": "standardization",
  //   "nodes": [
  //     {"id":"input","x":20,"y":55,"width":104,"height":82,"label":"x"},
  //     {"id":"normalize","x":225,"y":55,"width":175,"height":82,"label":"z"}
  //   ],
  //   "edges": [
  //     {"id":"input-output","from":"input","to":"normalize"}
  //   ],
  //   "formulas": [
  //     {"id":"density","owner":"normalize","tex":"z=\\frac{x-\\mu}{\\sigma}"}
  //   ]
  // }
  // @comment-diagram end
  const AFTER_BLOCK = "CODE AFTER THE COMMENT BLOCK";
  return x + BEFORE_BLOCK.length + AFTER_BLOCK.length;
}

// Content below the diagram allows scrolling its anchor out of the viewport.
function tailForScroll(value) {
  const step01 = value + 1;
  const step02 = step01 + 2;
  const step03 = step02 + 3;
  const step04 = step03 + 4;
  const step05 = step04 + 5;
  const step06 = step05 + 6;
  const step07 = step06 + 7;
  const step08 = step07 + 8;
  const step09 = step08 + 9;
  const step10 = step09 + 10;
  const step11 = step10 + 11;
  const step12 = step11 + 12;
  const step13 = step12 + 13;
  const step14 = step13 + 14;
  const step15 = step14 + 15;
  const step16 = step15 + 16;
  const step17 = step16 + 17;
  const step18 = step17 + 18;
  const step19 = step18 + 19;
  const step20 = step19 + 20;
  const step21 = step20 + 21;
  const step22 = step21 + 22;
  const step23 = step22 + 23;
  const step24 = step23 + 24;
  const step25 = step24 + 25;
  const step26 = step25 + 26;
  const step27 = step26 + 27;
  const step28 = step27 + 28;
  const step29 = step28 + 29;
  const step30 = step29 + 30;
  return step30;
}
