import ts from 'typescript';
import { readFileSync } from 'node:fs';
let next=0;
export async function loadTs(path,bindings={}) {
 const key='__testBindings'+next++;
 globalThis[key]=bindings;
 const source=readFileSync(new URL('../../'+path,import.meta.url),'utf8');
 const transformed=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext},transformers:{before:[ctx=>root=>ts.visitNode(root,function visit(node){if(ts.isImportDeclaration(node))return undefined;return ts.visitEachChild(node,visit,ctx);})]}}).outputText;
 const names=Object.keys(bindings);
 const prelude=names.length?`const {${names.join(',')}}=globalThis.${key};\n`:'';
 const mod=await import('data:text/javascript;base64,'+Buffer.from(prelude+transformed).toString('base64'));
 delete globalThis[key];
 return mod;
}
