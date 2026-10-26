const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('./model.js');
const { parseBlocks } = require('./parser.cjs');
const { serializeComment } = require('./comment-format.cjs');
const { renderValue } = require('./render.cjs');
const { fitInline } = require('./inline-layout.cjs');
const matrix = {kind:'matrix',cells:[[1,3],[4,7]].map((row)=>row.map((n)=>M.token(String(n))))};
const scene = (y) => ({version:1,title:'Flow',nodes:[
  {id:'a',kind:'box',x:20,y:0,width:120,height:40,text:'输入'},
  {id:'b',kind:'box',x:200,y,width:120,height:40,text:'输出'},
],edges:[{id:'e',from:'a',to:'b'}]});
test('compact matrix uses a few readable JSON lines and preserves the editable tree',()=>{
  const text=M.serialize({type:'math',id:'m',value:matrix});
  assert.ok(text.split('\n').length<=6);
  assert.deepEqual(parseBlocks(text,'python').blocks[0].value,matrix);
  assert.equal(M.serialize({type:'math',id:'m',value:parseBlocks(text,'python').blocks[0].value}),text);
});
test('token wrapping never splits escapes, labels, TeX or unicode inside JSON strings',()=>{
  const value={kind:'raw',tex:String.raw`\frac{a}{b} + \text{a \" quote}`+'\n'+'中文'.repeat(60)};
  const text=M.serialize({type:'math',id:'raw',value});
  assert.deepEqual(parseBlocks(text,'python').blocks[0].value,value);
  for(const input of [true,false,null,12,-1.25,{x:'},:]\\"',y:[true,123,null]}])
    assert.deepEqual(JSON.parse(M.compactRows(input,8).join('\n')),input);
});
test('same simple graph topology takes different minimal real row counts for different heights',()=>{
  const counts=[];
  for(const y of [0,400]){
    const value=scene(y),metrics={fontSize:20,lineHeight:19};
    const required=Math.ceil(fitInline(renderValue('diagram',value,metrics),20).height/19);
    const compact=parseBlocks(M.serialize({type:'diagram',id:'d',value}),'python').blocks[0].bodyCount;
    const text=M.serialize({type:'diagram',id:'d',value,minimumBodyLines:required});
    const b=parseBlocks(text,'python').blocks[0];
    assert.equal(b.bodyCount,Math.max(compact,required));
    assert.deepEqual(b.value,value);counts.push(b.bodyCount);
    assert.ok(!text.split('\n').some((line)=>/[ \t]$/.test(line)));
  }
  assert.ok(counts[1]>counts[0]);
});
test('padding is valid in indented Python and TS and does not change raw TeX',()=>{
  const value={kind:'raw',tex:'\\frac{x}{y}\n+z'};
  for(const [prefix,language] of [['#','python'],['//','typescript']]){
    const text=M.serialize({type:'math',id:'m',value,prefix,indent:'    ',eol:'\r\n',minimumBodyLines:12});
    const source=language==='python'?'def f():\r\n'+text+'\r\n    pass\r\n':'function f(){\r\n'+text+'\r\n}\r\n';
    const b=parseBlocks(source,language).blocks[0];assert.equal(b.bodyCount,12);assert.deepEqual(b.value,value);
    const trimmed=source.split('\r\n').map((s)=>s.trimEnd()).join('\r\n');assert.deepEqual(parseBlocks(trimmed,language).blocks[0].value,value);
  }
});
test('compact and padded host comment wrappers preserve delimiter escaping without trailing whitespace',()=>{
  const value={kind:'raw',tex:'x */ <!-- --> -- \\sqrt{y}'};
  for(const style of [{line:'#'},{block:['/*','*/']},{block:['<!--','-->']}]){
    const text=serializeComment({type:'math',id:'m',value,style,minimumBodyLines:15});
    assert.ok(!text.split('\n').some((s)=>/[ \t]$/.test(s)));
    const rows=text.split('\n').filter((s)=>!['/*','*/','<!--','-->'].includes(s.trim())).map((s)=>s.replace(/^(?:#| \*) ?|^ /,''));
    assert.deepEqual(M.validateFormula(JSON.parse(rows.slice(1,-1).join('\n')).formula),value);
  }
});
test('legacy pretty JSON stays readable without migration; compact serialization removes old excess rows',()=>{
  const legacy=['# @math begin v2 old',...JSON.stringify({version:2,formula:matrix},null,2).split('\n').map((s)=>'# '+s),'# @math end'].join('\n');
  const parsed=parseBlocks(legacy,'python').blocks[0];assert.deepEqual(parsed.value,matrix);
  const compact=M.serialize({type:'math',id:parsed.id,value:parsed.value,minimumBodyLines:5});
  assert.ok(compact.split('\n').length<legacy.split('\n').length/2);
  assert.deepEqual(parseBlocks(compact,'python').blocks[0].value,matrix);
});
