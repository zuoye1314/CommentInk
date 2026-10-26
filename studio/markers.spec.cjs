const {test,before}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {execFileSync}=require('node:child_process'),L=require('./comment-languages.cjs'),{parseBlocks}=require('./parser.cjs'),{serializeComment}=require('./comment-format.cjs');
before(async()=>{
 const root='/usr/share/code/resources/app/extensions';
 L.configureLanguages(fs.readdirSync(root).flatMap(n=>{try{return [{extensionPath:path.join(root,n),packageJSON:JSON.parse(fs.readFileSync(path.join(root,n,'package.json')))}];}catch{return [];}}));
 for(const id of ['c','javascript','html','lua','sql','powershell','fsharp'])await L.ensureLanguage(id);
});
const value={kind:'raw',tex:String.raw`a*b+\frac{x}{y}`},data=JSON.stringify({version:2,formula:{kind:'raw',texLines:[value.tex]}});
const body=(a='@math begin v2 target',z='@math end')=>[a,data,'','','','','','','',z];
const c=(a,z)=>['/*',...body(a,z).map(s=>' * '+s),'*/','int after = 1;'].join('\n');
test('C marker-only decoration normalization accepts bare, repeated stars, spaces and tabs',()=>{
 for(const prefix of ['',' ','\t','*','** ','* \t*\t','  **\t']){
  const source=c(prefix+'@math\tbegin\tv2\ttarget',prefix+'@math\tend');const p=parseBlocks(source,'c');
  assert.equal(p.blocks.length,1,JSON.stringify(p.diagnostics));assert.deepEqual(p.blocks[0].value,value);
 }
 const p=parseBlocks(['/*',...body(),'*/'].join('\n'),'c');assert.deepEqual(p.blocks[0].value,value);
});
test('illegal begin and end prefixes produce located diagnostics and preserve independent siblings',()=>{
 for(const begin of [true,false]){
  const source=c(begin?'4324 @math begin v2 target':undefined,begin?undefined:'说明 @math end')+'\n'+c('@math begin v2 sibling');
  const p=parseBlocks(source,'c');assert.deepEqual(p.blocks.map(b=>b.id),['sibling']);
  assert.ok(p.diagnostics.some(d=>d.line===(begin?1:10)&&/非注释装饰内容/.test(d.message)),JSON.stringify(p.diagnostics));
 }
});
test('each language strips only its real comment syntax',()=>{
 for(const [id,style] of [['python',{line:'#'}],['javascript',{line:'//'}],['html',{block:['<!--','-->']}],['lua',{block:['--[[',']]']}],['sql',{line:'--'}],['powershell',{block:['<#','#>']}],['fsharp',{block:['(*','*)']}]] ){
  let source=serializeComment({type:'math',id:'target',value,style,minimumBodyLines:12});
  source=source.replace('@math begin','\t@math\tbegin').replace('@math end','\t@math\tend');
  assert.deepEqual(parseBlocks(source,id).blocks[0]?.value,value,id);
 }
 assert.equal(parseBlocks('#@math begin v2 target\n#'+data+'\n#@math end','python').blocks.length,1);
 const wrong=parseBlocks('<!--\n// @math begin v2 target\n'+data+'\n@math end\n-->','html');assert.equal(wrong.blocks.length,0);assert.match(wrong.diagnostics[0].message,/非注释装饰/);
});
test('ordinary mentions and payload math symbols are not normalized or diagnosed',()=>{
 const p=parseBlocks(c()+'\n// 使用 @math 可以写公式\nconst char *s = "4324 @math end";','c');
 assert.deepEqual(p.blocks[0].value,value);assert.equal(p.diagnostics.length,0);
 const star=parseBlocks('/*\n** @math begin v1 raw\n * x*y\n** @math end\n*/','c');assert.equal(star.blocks[0].tex,'x*y');
});
function literal({prefix='',quote='"""',indent='',eol='\n',type='math'}={}){
 const rows=type==='math'?body():['@diagram begin v1 target',JSON.stringify({version:1,title:'Flow',nodes:[],edges:[]}),...Array(8).fill(''),'@diagram end'];
 return ['# before','def f():',indent+'    '+prefix+quote,...rows.map(s=>indent+'    '+s),indent+'    '+quote,indent+'    return 42',''].join(eol);
}
test('marked plain, raw and unicode triple literals default to separate carrier mode',()=>{
 for(const prefix of ['','r','R','u'])for(const quote of ['"""',"'''"])for(const eol of ['\n','\r\n']){
  const source=literal({prefix,quote,eol}),p=parseBlocks(source,'python');assert.equal(p.blocks.length,1,JSON.stringify(p.diagnostics));
  const b=p.blocks[0];assert.equal(b.carrier,'python-string');assert.equal(b.commentStyle.pythonString,quote);assert.deepEqual(b.value,value);assert.equal(b.indent,'    ');
 }
 assert.equal(parseBlocks(literal({type:'diagram'}),'python').blocks[0].type,'diagram');
});
test('assignment strings are recognized without changing surrounding code or ordinary text',()=>{
 const source='value = r"""\n'+body().join('\n')+'\n"""\nanswer=42\n';
 assert.equal(parseBlocks(source,'python').blocks[0].carrier,'python-string');
 for(const source of ['x="""\nnormal prose\n'+body().join('\n')+'\n"""','x="""\n'+body().map(s=>'# '+s).join('\n')+'\n"""','x="""ordinary prose"""']){
  const p=parseBlocks(source,'python');assert.equal(p.blocks.length,0);assert.equal(p.diagnostics.length,0);
 }
});
test('f/bytes marked literals and inline quote boundaries give actionable diagnostics',()=>{
 for(const prefix of ['f','b','rb','fr']){
  const source=prefix+'"""\n@math begin v1 target\nx\n@math end\n"""\n';const p=parseBlocks(source,'python');
  assert.equal(p.blocks.length,0);assert.match(p.diagnostics[0].message,/f 字符串或 bytes/);
 }
 const p=parseBlocks('"""@math begin v1 target\nx\n@math end"""','python');assert.equal(p.blocks.length,0);assert.match(p.diagnostics[0].message,/独立行/);
});
test('explicit updates preserve quote enclosure, host syntax and every formula token',()=>{
 const changed={kind:'raw',tex:"a'''b\"\"\"c\\d"};
 for(const prefix of ['','r'])for(const quote of ['"""',"'''"]){
  const source=literal({prefix,quote}),b=parseBlocks(source,'python').blocks[0],lines=source.split('\n');
  const inner=serializeComment({type:'math',id:b.id,value:changed,style:b.commentStyle,interior:true,leader:b.leader,minimumBodyLines:10});
  const updated=[...lines.slice(0,b.start),inner,...lines.slice(b.end+1)].join('\n');
  assert.deepEqual(parseBlocks(updated,'python').blocks[0]?.value,changed);assert.ok(updated.startsWith(lines.slice(0,b.start).join('\n')+'\n'));
  assert.ok(updated.endsWith('\n'+lines.slice(b.end+1).join('\n')));
  const directory=fs.mkdtempSync('/tmp/inscribe-python-syntax-');
  try { const file=path.join(directory,'sample.py');fs.writeFileSync(file,updated);execFileSync('python3',['-c','import ast,sys; ast.parse(open(sys.argv[1]).read())',file],{timeout:10000}); } finally {fs.rmSync(directory,{recursive:true});}
 }
 assert.throws(()=>serializeComment({type:'math',id:'x',value,style:{pythonString:'"""'}}),/已有标记/);
});
test('mixed comment/string blocks, duplicate IDs and unmatched types remain isolated',()=>{
 const real=serializeComment({type:'math',id:'real',value,style:{line:'#'}});
 assert.deepEqual(parseBlocks(real+'\n'+literal(),'python').blocks.map(b=>b.id),['real','target']);
 assert.equal(parseBlocks(literal()+'\n'+literal(),'python').blocks.length,0);
 const p=parseBlocks(c('@math begin v2 target','@diagram end'),'c');assert.equal(p.blocks.length,0);assert.match(p.diagnostics[0].message,/类型不匹配/);
});
