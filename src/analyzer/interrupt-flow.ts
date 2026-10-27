/** Bounded, synchronous statement analysis for catch/finally interrupt restoration.
 * Unknown control flow is not treated as proof. This is not a Java exception/type solver.
 */
import type { JavaSyntaxNode } from './java-parser.ts';
import { JavaSymbols } from './java-symbols.ts';
import { childForField, methodNameOf, receiverOf } from './ast-utils.ts';

type Exit = 'normal' | 'return' | 'throw';
interface Path {
  flags: Map<number, boolean | undefined>;
  restored: boolean;
  rethrows: boolean;
  exit: Exit;
  unknown: boolean;
}
const MAX_PATHS=32;
const fork=(p:Path):Path=>({...p,flags:new Map(p.flags)});
const children=(n:JavaSyntaxNode)=>n.namedChildren.filter(c=>!['line_comment','block_comment'].includes(c.type));
const currentThread=(n:JavaSyntaxNode|null)=>/^(?:java\.lang\.)?Thread\.currentThread\(\)$/.test(n?.text.replace(/\s+/g,'')??'');

export function interruptRestored(caught:JavaSyntaxNode,symbols:JavaSymbols):boolean {
  const parameter=caught.namedChildren.find(n=>n.type==='catch_formal_parameter');
  const caughtName=parameter?.childForFieldName('name');
  const exceptionId=symbols.lookup(caughtName??null)?.id;
  const bool=(n:JavaSyntaxNode|null,p:Path):boolean|undefined=>{
    if(!n)return undefined;
    if(n.type==='parenthesized_expression')return bool(n.namedChildren[0]??null,p);
    if(n.text==='true')return true;if(n.text==='false')return false;
    if(n.type==='identifier'){
      const s=symbols.lookup(n);
      return s&&!s.field&&s.type==='boolean'?p.flags.get(s.id):undefined;
    }
    if(n.type==='unary_expression'&&n.children[0]?.text==='!'){
      const v=bool(n.namedChildren[0]??null,p);return v===undefined?undefined:!v;
    }
    return undefined;
  };
  const expression=(n:JavaSyntaxNode,p:Path):void=>{
    // Function/class bodies are deferred, not part of this thread's restoration.
    if(['lambda_expression','class_body','method_declaration','constructor_declaration'].includes(n.type))return;
    if(['ternary_expression','binary_expression'].includes(n.type)){
      // Short-circuit/conditional side effects require more than a tree walk.
      const effects=symbols.nodes.some(c=>c.startIndex>=n.startIndex&&c.endIndex<=n.endIndex&&(c.type==='assignment_expression'||c.type==='method_invocation'&&['interrupt','interrupted'].includes(methodNameOf(c))));
      if(effects)p.unknown=true;return;
    }
    if(n.type==='assignment_expression'){
      const left=childForField(n,'left');const right=childForField(n,'right');
      const s=symbols.lookup(left);
      const value=bool(right,p);
      if(right)expression(right,p);
      if(s&&!s.field&&s.type==='boolean')p.flags.set(s.id,n.children.some(c=>c.text==='=')?value:undefined);
      return;
    }
    if(n.type==='object_creation_expression'){
      const args=childForField(n,'arguments');if(args)for(const c of children(args))expression(c,p);return;
    }
    for(const c of children(n))expression(c,p);
    if(n.type==='method_invocation'){
      if(methodNameOf(n)==='interrupt'&&currentThread(receiverOf(n)))p.restored=true;
      if(methodNameOf(n)==='interrupted'&&/^(?:java\.lang\.)?Thread$/.test(receiverOf(n)?.text??''))p.restored=false;
    }
  };
  const statements=(nodes:JavaSyntaxNode[],paths:Path[]):Path[]=>{
    for(const n of nodes){
      paths=paths.flatMap(p=>p.exit==='normal'?statement(n,p):[p]);
      if(paths.length>MAX_PATHS)return [{...fork(paths[0]!),unknown:true,restored:false,rethrows:false}];
    }
    return paths;
  };
  const statement=(n:JavaSyntaxNode,p:Path):Path[]=>{
    if(n.type==='block'||n.type==='finally_clause')return statements(children(n),[p]);
    if(n.type==='if_statement'){
      const condition=childForField(n,'condition');const v=bool(condition,p);
      if(condition)expression(condition,p);
      const yes=childForField(n,'consequence'),no=childForField(n,'alternative');
      return [...(v!==false?(yes?statement(yes,fork(p)):[fork(p)]):[]),...(v!==true?(no?statement(no,fork(p)):[fork(p)]):[])];
    }
    if(n.type==='try_statement'){
      const body=childForField(n,'body');
      const paths=body?statement(body,fork(p)):[fork(p)];
      for(const clause of n.namedChildren.filter(c=>c.type==='catch_clause')){
        const entry=fork(p);
        // Exceptions may occur before any assignment in the try body completes.
        for(const candidate of symbols.nodes.filter(c=>body&&c.startIndex>=body.startIndex&&c.endIndex<=body.endIndex)){
          if(candidate.type==='assignment_expression'){
            const s=symbols.lookup(childForField(candidate,'left'));if(s)entry.flags.set(s.id,undefined);
          }
          if(candidate.type==='method_invocation'&&methodNameOf(candidate)==='interrupted'&&/^(?:java\.lang\.)?Thread$/.test(receiverOf(candidate)?.text??''))entry.restored=false;
        }
        // Blocking operations clear the flag when throwing InterruptedException.
        const type=clause.namedChildren.find(c=>c.type==='catch_formal_parameter')?.namedChildren.find(c=>c.type==='catch_type')?.text??'';
        if(type.split('|').some(t=>['InterruptedException','Exception','Throwable'].includes(t.trim().split('.').at(-1)??'')))entry.restored=false;
        const handler=childForField(clause,'body');paths.push(...(handler?statement(handler,entry):[entry]));
      }
      return withFinally(paths,n.namedChildren.find(c=>c.type==='finally_clause'));
    }
    if(n.type==='local_variable_declaration'){
      for(const d of n.namedChildren.filter(c=>c.type==='variable_declarator')){
        const value=childForField(d,'value');const symbol=symbols.lookup(childForField(d,'name'));
        const v=bool(value,p);if(value)expression(value,p);
        if(symbol&&!symbol.field&&symbol.type==='boolean')p.flags.set(symbol.id,v);
      }
      return [p];
    }
    if(n.type==='expression_statement'){
      for(const e of children(n))expression(e,p);return [p];
    }
    if(n.type==='return_statement'||n.type==='throw_statement'){
      const value=n.namedChildren[0];if(value)expression(value,p);
      p.exit=n.type==='return_statement'?'return':'throw';
      p.rethrows=n.type==='throw_statement'&&exceptionId!==undefined&&symbols.lookup(value??null)?.id===exceptionId;
      return [p];
    }
    if(['for_statement','enhanced_for_statement','while_statement','do_statement'].includes(n.type)){
      // Cleanup loops may precede a definite restore. Never credit a restore in a loop:
      // it may execute zero times, and assignments may differ on later iterations.
      const scan=(part:JavaSyntaxNode):void=>{
        if(['lambda_expression','class_body'].includes(part.type))return;
        if(['return_statement','throw_statement','break_statement','continue_statement','try_statement','try_with_resources_statement'].includes(part.type))p.unknown=true;
        if(part.type==='assignment_expression'){
          const s=symbols.lookup(childForField(part,'left'));if(s)p.flags.set(s.id,undefined);
        }
        if(part.type==='method_invocation'&&methodNameOf(part)==='interrupted'&&/^(?:java\.lang\.)?Thread$/.test(receiverOf(part)?.text??''))p.restored=false;
        for(const c of children(part))scan(c);
      };
      scan(n);return [p];
    }
    if(['empty_statement','class_declaration'].includes(n.type))return [p];
    p.unknown=true;return [p];
  };
  const withFinally=(paths:Path[],final:JavaSyntaxNode|undefined):Path[]=>!final?paths:paths.flatMap(p=>{
    const previous={exit:p.exit,rethrows:p.rethrows};
    return statement(final,{...fork(p),exit:'normal',rethrows:false}).map(result=>result.exit==='normal'?{...result,...previous}:result);
  });
  const body=childForField(caught,'body');if(!body)return false;
  let paths=statements(children(body),[{flags:new Map(),restored:false,rethrows:false,exit:'normal',unknown:false}]);
  paths=withFinally(paths,caught.parent?.namedChildren.find(n=>n.type==='finally_clause'));
  const proven=(items:Path[])=>items.length>0&&items.every(p=>!p.unknown&&(p.restored||p.rethrows));
  if(proven(paths))return true;

  // A retry catch may defer restoration until the finally surrounding its loop.
  // Only carry local boolean flags that cannot become false in any later iteration.
  // Do not infer successful termination, or credit an interrupt call inside the loop.
  const innerTry=caught.parent;
  const loopBody=innerTry?.parent;
  const loop=loopBody?.parent;
  const outerBody=loop?.parent;
  const outerTry=outerBody?.parent;
  if(loopBody?.type!=='block'||!loop||!['while_statement','for_statement','do_statement'].includes(loop.type)||
      childForField(loop,'body')?.id!==loopBody.id||outerBody?.type!=='block'||outerTry?.type!=='try_statement'||
      childForField(outerTry,'body')?.id!==outerBody.id||outerTry.namedChildren.some(n=>n.type==='catch_clause'))return false;
  const final=outerTry.namedChildren.find(n=>n.type==='finally_clause');
  if(!final)return false;
  const loopNodes=symbols.nodes.filter(n=>n.startIndex>=loop.startIndex&&n.endIndex<=loop.endIndex);
  const summarized=paths.map(path=>{
    const p=fork(path);
    if(p.exit!=='normal')return p;
    for(const [id,value] of p.flags){
      const monotone=value===true&&loopNodes.every(n=>{
        if(n.type!=='assignment_expression')return true;
        if(symbols.lookup(childForField(n,'left'))?.id!==id)return true;
        return n.children.some(c=>c.text==='=')&&childForField(n,'right')?.text==='true';
      });
      if(!monotone)p.flags.set(id,undefined);
    }
    // A future blocking call/catch can clear the JVM flag. The enclosing finally
    // must reestablish it using the invariant local flag instead.
    p.restored=false;p.rethrows=false;
    return p;
  });
  const afterLoop=children(outerBody).filter(n=>n.startIndex>=loop.endIndex);
  return proven(withFinally(statements(afterLoop,summarized),final));
}
