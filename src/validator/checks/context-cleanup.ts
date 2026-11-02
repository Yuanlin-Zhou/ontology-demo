/** Bounded explicit-path cleanup recognition. Deferred callbacks are never cleanup evidence. */
import { callArguments, childForField, methodNameOf, receiverOf } from '../../analyzer/ast-utils.ts';
import { enclosing, JavaSymbols } from '../../analyzer/java-symbols.ts';
import type { JavaSyntaxNode } from '../../analyzer/java-parser.ts';

interface State { clean: boolean; exited: boolean }
const DEFERRED = ['lambda_expression', 'method_declaration', 'constructor_declaration', 'class_body'];

export function guaranteedContextCleanup(body: JavaSyntaxNode, symbols: JavaSymbols,
  matches: (receiver: JavaSyntaxNode | null) => boolean, previous: Set<number>, depth = 0): boolean {
  const expression = (node: JavaSyntaxNode, state: State): State => {
    if (DEFERRED.includes(node.type)) return state;
    for (const child of node.namedChildren) state = expression(child, state);
    if (node.type !== 'method_invocation') return state;
    const method = methodNameOf(node);
    if (matches(receiverOf(node))) {
      if (['remove', 'clear'].includes(method)) return { ...state, clean: true };
      if (['set', 'put'].includes(method)) {
        const value = symbols.lookup(callArguments(node)[0] ?? null);
        return { ...state, clean: method === 'set' && !!value && previous.has(value.id) };
      }
    }
    const helper = depth === 0 ? symbols.method(node) : undefined;
    if (helper && /\bprivate\b/.test(helper.namedChildren.find(n => n.type === 'modifiers')?.text ?? '')) {
      const params = childForField(helper, 'parameters')?.namedChildren ?? [];
      const mapped = new Set<number>();
      for (const [i, arg] of callArguments(node).entries()) {
        const symbol = symbols.lookup(arg);
        const parameter = params[i];
        if (symbol && previous.has(symbol.id) && parameter) mapped.add(parameter.id);
      }
      const helperBody = childForField(helper, 'body');
      if (helperBody && guaranteedContextCleanup(helperBody, symbols, matches, mapped, depth + 1)) return { ...state, clean: true };
    }
    return state;
  };
  const visit = (node: JavaSyntaxNode, states: State[]): State[] => {
    if (states.length > 32) return [{ clean: false, exited: false }];
    const ended = states.filter(s => s.exited);
    const active = states.filter(s => !s.exited);
    if (!active.length) return states;
    if (['block', 'finally_clause'].includes(node.type)) {
      let result = active;
      for (const child of node.namedChildren) result = visit(child, result);
      return [...ended, ...result];
    }
    if (node.type === 'if_statement') {
      const condition = childForField(node, 'condition');
      const input = condition ? active.map(s => expression(condition, s)) : active;
      const yes = childForField(node, 'consequence');
      const no = childForField(node, 'alternative');
      return [...ended, ...(yes ? visit(yes, input) : input), ...(no ? visit(no, input) : input)];
    }
    if (['try_statement', 'try_with_resources_statement'].includes(node.type)) {
      const block = childForField(node, 'body');
      let paths = block ? visit(block, active) : active;
      // A catch may be entered before cleanup. Do not infer implicit exception ordering.
      for (const caught of node.namedChildren.filter(n => n.type === 'catch_clause')) {
        const caughtBody = childForField(caught, 'body');
        if (caughtBody) paths.push(...visit(caughtBody, active));
      }
      const final = node.namedChildren.find(n => n.type === 'finally_clause');
      if (final) paths = paths.flatMap(s => visit(final, [{ ...s, exited: false }]).map(t => ({ ...t, exited: s.exited || t.exited })));
      return [...ended, ...paths];
    }
    if (DEFERRED.includes(node.type)) return states;
    if (['for_statement', 'enhanced_for_statement', 'while_statement', 'do_statement', 'switch_expression', 'switch_statement'].includes(node.type)) {
      return [...ended, ...active.map(s => ({ ...s, clean: false }))];
    }
    return [...ended, ...active.map(s => ({ ...expression(node, s),
      exited: ['return_statement', 'throw_statement', 'break_statement', 'continue_statement'].includes(node.type) }))];
  };
  const result = visit(body, [{ clean: false, exited: false }]);
  return result.length > 0 && result.every(s => s.clean);
}

/** Only stable local snapshots of this ThreadLocal.get(), captured before the write. */
export function previousContextSymbols(write: JavaSyntaxNode, symbols: JavaSymbols,
  matches: (receiver: JavaSyntaxNode | null) => boolean): Set<number> {
  return new Set(symbols.symbols.filter(s => {
    const value = s.value;
    return !s.field && s.declaration.startIndex < write.startIndex && value?.type === 'method_invocation' &&
      methodNameOf(value) === 'get' && matches(receiverOf(value)) &&
      enclosing(s.declaration, ['method_declaration', 'constructor_declaration', 'lambda_expression'])?.id ===
        enclosing(write, ['method_declaration', 'constructor_declaration', 'lambda_expression'])?.id &&
      !symbols.nodes.some(n => n.type === 'method_invocation' && n.startIndex > s.declaration.endIndex &&
        n.startIndex < write.startIndex && ['set', 'remove'].includes(methodNameOf(n)) && matches(receiverOf(n))) &&
      !symbols.nodes.some(n => ['assignment_expression', 'update_expression'].includes(n.type) &&
        symbols.lookup(childForField(n, 'left') ?? n.namedChildren[0] ?? null)?.id === s.id);
  }).map(s => s.id));
}
