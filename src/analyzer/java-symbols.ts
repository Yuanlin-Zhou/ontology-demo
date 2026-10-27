/** Lexical, file-local symbols. Deliberately stops at ambiguous writes or external calls. */
import { childForField, methodNameOf, receiverOf, typeNameOf, walk } from './ast-utils.ts';
import type { JavaSyntaxNode } from './java-parser.ts';

export interface JavaSymbol {
  id: number;
  name: string;
  type: string;
  declaration: JavaSyntaxNode;
  scope: JavaSyntaxNode;
  field: boolean;
  value: JavaSyntaxNode | null;
}
const CLASS_BODIES = ['class_body', 'enum_body', 'interface_body'];
const CALLABLES = ['method_declaration', 'constructor_declaration', 'lambda_expression'];
export function enclosing(node: JavaSyntaxNode, types: readonly string[]): JavaSyntaxNode | undefined {
  for (let current = node.parent; current; current = current.parent) if (types.includes(current.type)) return current;
  return undefined;
}
export function isWithin(node: JavaSyntaxNode, parent: JavaSyntaxNode): boolean {
  return node.startIndex >= parent.startIndex && node.endIndex <= parent.endIndex;
}

export class JavaSymbols {
  readonly symbols: JavaSymbol[] = [];
  readonly nodes: JavaSyntaxNode[] = [];
  constructor(root: JavaSyntaxNode) {
    walk(root, node => this.nodes.push(node));
    for (const node of this.nodes) {
      if (!['variable_declarator', 'formal_parameter', 'spread_parameter', 'catch_formal_parameter'].includes(node.type)) continue;
      const field = node.parent?.type === 'field_declaration';
      const scope = enclosing(node, field ? CLASS_BODIES : ['block', ...CALLABLES, 'catch_clause', 'for_statement', 'enhanced_for_statement']);
      const name = childForField(node, 'name')?.text;
      if (!scope || !name) continue;
      this.symbols.push({ id: node.id, name, type: childForField(node, 'type')?.text ?? childForField(node.parent, 'type')?.text ?? '',
        declaration: node, scope, field, value: childForField(node, 'value') });
    }
    for (const lambda of this.nodes.filter(n => n.type === 'lambda_expression')) {
      const parameters = childForField(lambda, 'parameters');
      const inferred = parameters?.type === 'identifier' ? [parameters] : parameters?.type === 'inferred_parameters' ? parameters.namedChildren.filter(n => n.type === 'identifier') : [];
      for (const parameter of inferred) this.symbols.push({id:parameter.id,name:parameter.text,type:'',declaration:parameter,scope:lambda,field:false,value:null});
    }
  }
  lookup(expression: JavaSyntaxNode | null, at: JavaSyntaxNode = expression!): JavaSymbol | undefined {
    if (!expression) return undefined;
    if (expression.type === 'parenthesized_expression') return this.lookup(expression.namedChildren[0] ?? null, at);
    if (expression.type === 'method_invocation' && methodNameOf(expression) === 'getThreadPoolExecutor') return this.lookup(receiverOf(expression), at);
    const explicit = expression.type === 'field_access';
    if (explicit) {
      const receiver = childForField(expression, 'object')?.text;
      const owner = enclosing(at, CLASS_BODIES);
      const className = owner?.parent?.childForFieldName('name')?.text;
      if (receiver !== 'this' && receiver !== className) return undefined;
    } else if (expression.type !== 'identifier') return undefined;
    const name = explicit ? childForField(expression, 'field')?.text : expression.text;
    return this.symbols.filter(s => s.name === name && (!explicit || s.field) && isWithin(at, s.scope) &&
      (s.field || s.declaration.startIndex <= at.startIndex))
      .sort((a, b) => (a.scope.endIndex - a.scope.startIndex) - (b.scope.endIndex - b.scope.startIndex) || b.declaration.startIndex - a.declaration.startIndex)[0];
  }
  method(call: JavaSyntaxNode): JavaSyntaxNode | undefined {
    const owner = enclosing(call, CLASS_BODIES);
    const receiver = receiverOf(call)?.text;
    const className = owner?.parent?.childForFieldName('name')?.text;
    if (receiver && receiver !== 'this' && receiver !== className) return undefined;
    const candidates = this.nodes.filter(n => n.type === 'method_declaration' && enclosing(n, CLASS_BODIES)?.id === owner?.id &&
      childForField(n, 'name')?.text === methodNameOf(call));
    return candidates.length === 1 ? candidates[0] : undefined;
  }
  /** Resolve only immutable/single-assignment aliases and one unambiguous local factory. */
  origin(expression: JavaSyntaxNode | null, seen = new Set<number>()): JavaSyntaxNode | undefined {
    if (!expression || seen.has(expression.id) || seen.size > 12) return undefined;
    seen.add(expression.id);
    if (expression.type === 'parenthesized_expression') return this.origin(expression.namedChildren[0] ?? null, seen);
    if (['object_creation_expression', 'lambda_expression'].includes(expression.type)) return expression;
    if (expression.type === 'method_invocation') {
      const receiver = receiverOf(expression)?.text;
      if ((receiver === 'Executors' || receiver === 'java.util.concurrent.Executors') && /^new/.test(methodNameOf(expression))) return expression;
      if (methodNameOf(expression) === 'getThreadPoolExecutor') return this.origin(receiverOf(expression), seen);
      const method = this.method(expression);
      if (!method) return undefined;
      const returns = this.nodes.filter(n => n.type === 'return_statement' && enclosing(n, CALLABLES)?.id === method.id);
      return returns.length === 1 ? this.origin(returns[0]!.namedChildren[0] ?? null, seen) : undefined;
    }
    const symbol = this.lookup(expression);
    if (!symbol) return undefined;
    const writes = this.nodes.filter(n => n.type === 'assignment_expression' && this.lookup(childForField(n, 'left'), n)?.id === symbol.id);
    if (symbol.value && writes.length === 0) return this.origin(symbol.value, seen);
    if (!symbol.value && writes.length === 1) {
      const method = enclosing(writes[0]!, ['constructor_declaration', 'method_declaration']);
      if (method?.type === 'constructor_declaration' || /@(?:[\w.]+\.)?Bean\b/.test(method?.namedChildren.find(n => n.type === 'modifiers')?.text ?? '')) return this.origin(childForField(writes[0]!, 'right'), seen);
    }
    // A final field can have one assignment in each alternative constructor.
    // Associate it only when every immediate constructor path resolves to the same creation site.
    if(!symbol.value && symbol.field && writes.length>1 &&
        /\bfinal\b/.test(symbol.declaration.parent?.namedChildren.find(n=>n.type==='modifiers')?.text??'') &&
        writes.every(w=>enclosing(w,CALLABLES)?.type==='constructor_declaration')){
      const origins=writes.map(w=>this.origin(childForField(w,'right'),new Set(seen)));
      if(origins[0] && origins.every(o=>o?.id===origins[0]!.id))return origins[0];
    }
    return undefined;
  }
  integer(expression: JavaSyntaxNode | null, seen = new Set<number>()): number | undefined {
    if (!expression || seen.has(expression.id) || seen.size > 12) return undefined;
    seen.add(expression.id);
    const text = expression.text.replace(/_/g, '').replace(/[lL]$/, '');
    if (/^(?:java\.lang\.)?Integer\.MAX_VALUE$/.test(text)) return 2147483647;
    if (/^-?\d+$/.test(text)) return Number(text);
    if (expression.type === 'parenthesized_expression') return this.integer(expression.namedChildren[0] ?? null, seen);
    const symbol = this.lookup(expression);
    // Constants only; mutable configuration needs a runtime check.
    if (!symbol || !/\bfinal\b/.test(symbol.declaration.parent?.text.split('=')[0] ?? '')) return undefined;
    return this.integer(symbol.value, seen);
  }
  typeOf(expression: JavaSyntaxNode | null): string {
    if (!expression) return '';
    return this.lookup(expression)?.type ?? (expression.type === 'object_creation_expression' ? typeNameOf(expression) : '');
  }
}
