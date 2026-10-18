/**
 * Small, dependency free helpers around tree-sitter Java nodes.
 */
import type { JavaSyntaxNode } from './java-parser.ts';

export function childForField(node: JavaSyntaxNode | null, field: string): JavaSyntaxNode | null {
  if (node === null) return null;
  return node.childForFieldName(field);
}

export function textOf(node: JavaSyntaxNode | null | undefined): string {
  return node === null || node === undefined ? '' : node.text;
}

/** Whitespace-normalised, single-line text used in messages. */
export function compactText(node: JavaSyntaxNode | null | undefined, maxLength = 160): string {
  const text = textOf(node).replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

export function fieldText(node: JavaSyntaxNode | null | undefined, field: string): string {
  return textOf(childForField(node ?? null, field));
}

/** Positional arguments of an `argument_list` node (empty when null). */
export function argumentsOf(argumentList: JavaSyntaxNode | null | undefined): JavaSyntaxNode[] {
  if (argumentList === null || argumentList === undefined) return [];
  return argumentList.namedChildren.filter((child) => child.type !== 'comment');
}

/** The `arguments` field of an invocation / object creation. */
export function callArguments(callNode: JavaSyntaxNode): JavaSyntaxNode[] {
  return argumentsOf(childForField(callNode, 'arguments'));
}

/** `new Foo(...)`: simple name of the constructed type (generics stripped). */
export function typeNameOf(creation: JavaSyntaxNode): string {
  const type = childForField(creation, 'type');
  if (type === null) return '';
  return lastIdentifier(type.text.replace(/<[\s\S]*$/, '').trim());
}

export function methodNameOf(invocation: JavaSyntaxNode): string {
  return fieldText(invocation, 'name');
}

/** The receiver (`object` field) of a method invocation, if any. */
export function receiverOf(invocation: JavaSyntaxNode): JavaSyntaxNode | null {
  return childForField(invocation, 'object');
}

/** Simple name of an arbitrary expression: `a.b.c` -> `c`. */
export function lastIdentifier(text: string): string {
  const trimmed = text.trim();
  const parts = trimmed.split('.');
  const last = parts[parts.length - 1] ?? trimmed;
  return last.trim();
}

/** Last identifier of a receiver expression: `this.pool` -> `pool`, `svc.getPool()` -> `getPool()`. */
export function receiverName(receiver: JavaSyntaxNode | null): string {
  if (receiver === null) return '';
  if (receiver.type === 'field_access') {
    return (childForField(receiver, 'field')?.text ?? '').trim();
  }
  if (receiver.type === 'method_invocation') {
    return `${childForField(receiver, 'name')?.text.trim() ?? ''}()`;
  }
  if (receiver.type === 'parenthesized_expression') {
    return receiver.text.replace(/[()]/g, '').trim();
  }
  return lastIdentifier(receiver.text);
}

/** Pre-order walk over all children. */
export function walk(node: JavaSyntaxNode, visit: (node: JavaSyntaxNode) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}

/** Ancestors of a node, closest first. */
export function ancestorsOf(node: JavaSyntaxNode): JavaSyntaxNode[] {
  const out: JavaSyntaxNode[] = [];
  let current = node.parent;
  while (current !== null && current !== undefined) {
    out.push(current);
    current = current.parent;
  }
  return out;
}

export function closestAncestor(node: JavaSyntaxNode, types: readonly string[]): JavaSyntaxNode | null {
  const wanted = new Set(types);
  let current = node.parent;
  while (current !== null && current !== undefined) {
    if (wanted.has(current.type)) return current;
    current = current.parent;
  }
  return null;
}

/** All ancestors matching one of the given types, closest first. */
export function ancestorsOfType(node: JavaSyntaxNode, types: readonly string[]): JavaSyntaxNode[] {
  const wanted = new Set(types);
  return ancestorsOf(node).filter((ancestor) => wanted.has(ancestor.type));
}

export function hasAncestorType(node: JavaSyntaxNode, types: readonly string[]): boolean {
  return closestAncestor(node, types) !== null;
}

/** The enclosing method / constructor / lambda of a node, when any. */
export function enclosingCallable(node: JavaSyntaxNode): JavaSyntaxNode | null {
  return closestAncestor(node, [
    'method_declaration',
    'constructor_declaration',
    'compact_constructor_declaration',
    'lambda_expression',
  ]);
}

/** True when `node` sits inside a `finally` block. */
export function isInFinally(node: JavaSyntaxNode): boolean {
  return hasAncestorType(node, ['finally_clause']);
}

/** True when `node` sits inside a `catch_clause`. */
export function isInCatch(node: JavaSyntaxNode): boolean {
  return hasAncestorType(node, ['catch_clause']);
}

/**
 * Names of the exception types caught by a `try_statement` (multi-catch aware).
 */
export function caughtTypesOfTry(tryNode: JavaSyntaxNode): string[] {
  const names: string[] = [];
  for (const child of tryNode.namedChildren) {
    if (child.type !== 'catch_clause') continue;
    const parameter = child.namedChildren.find((c) => c.type === 'catch_formal_parameter');
    if (parameter === undefined) continue;
    const typeNode =
      parameter.childForFieldName('type') ??
      parameter.namedChildren.find((c) => c.type === 'catch_type' || c.type.endsWith('_type'));
    if (typeNode === null || typeNode === undefined) continue;
    for (const part of typeNode.text.split('|')) {
      const name = lastIdentifier(part);
      if (name.length > 0) names.push(name);
    }
  }
  return names;
}

/** Declared type text of a variable declarator / formal parameter (`ExecutorService`). */
export function declaredTypeOf(declarator: JavaSyntaxNode): string {
  const parent = declarator.parent;
  if (parent === null || parent === undefined) return '';
  return fieldText(parent, 'type');
}

/** Simple names of the generic type arguments of a declared type. */
export function genericArguments(typeText: string): string[] {
  const start = typeText.indexOf('<');
  const end = typeText.lastIndexOf('>');
  if (start < 0 || end < start) return [];
  return typeText
    .slice(start + 1, end)
    .split(',')
    .map((part) => lastIdentifier(part.replace(/<[^>]*>/g, '')))
    .filter((part) => part.length > 0);
}

/** Enclosing `try_statement`, when any. */
export function enclosingTry(node: JavaSyntaxNode): JavaSyntaxNode | null {
  return closestAncestor(node, ['try_statement', 'try_with_resources_statement']);
}

/** Recursively collects nodes of the given types below `node` (including itself). */
export function descendants(node: JavaSyntaxNode, types: readonly string[]): JavaSyntaxNode[] {
  const out: JavaSyntaxNode[] = [];
  walk(node, (current) => {
    if (types.includes(current.type)) out.push(current);
  });
  return out;
}
