/** Structural public API guard, independent of compilation and task completion. */
import { parseJava, type JavaSyntaxNode } from '../src/analyzer/java-parser.ts';
import { javaIdentity, type JavaCheck } from './java.ts';
const normalize = (type: string): string => type.replace(/\s+/g, '').replace(/(?:[a-z_$][\w$]*\.)+([A-Z][\w$]*)/g, '$1');
function publicApi(code: string) {
  const identity = javaIdentity(code);
  const parsed = parseJava(code);
  if (!identity || parsed.errors.length) return undefined;
  const primary = parsed.rootNode.namedChildren.find(n => n.childForFieldName('name')?.text === identity.name);
  const body = primary?.childForFieldName('body');
  if (!body) return undefined;
  const modifiers = (node: JavaSyntaxNode) => node.namedChildren.find(n => n.type === 'modifiers')?.text ?? '';
  const parameters = (node: JavaSyntaxNode) => (node.childForFieldName('parameters')?.namedChildren ?? [])
    .filter(p => ['formal_parameter','spread_parameter'].includes(p.type)).map(p => normalize(p.childForFieldName('type')?.text ?? p.text));
  const constructors = body.namedChildren.filter(n => n.type === 'constructor_declaration');
  const methods = body.namedChildren.filter(n => n.type === 'method_declaration' && /\bpublic\b/.test(modifiers(n))).map(n => ({
    key: `${n.childForFieldName('name')?.text}(${parameters(n).join(',')})`,
    returns: normalize(n.childForFieldName('type')?.text ?? ''), static: /\bstatic\b/.test(modifiers(n)),
  }));
  return { identity: identity.qualifiedName, methods,
    constructors: constructors.filter(n => /\bpublic\b/.test(modifiers(n))).map(n => parameters(n).join(',')),
    implicitPublicConstructor: constructors.length === 0 && /\bpublic\b/.test(primary ? modifiers(primary) : '') };
}
export function checkPublicApi(before: string, after: string): JavaCheck {
  const expected = publicApi(before), actual = publicApi(after);
  if (!expected || !actual) return { status:'unavailable', detail:'Cannot compare public API of invalid or unsupported Java source.' };
  const issues: string[] = [];
  if (expected.identity !== actual.identity) issues.push(`Preserve original class/package ${expected.identity}`);
  for (const method of expected.methods) {
    const found = actual.methods.find(m => m.key === method.key);
    if (!found) issues.push(`Restore public method ${method.key}: ${method.returns}`);
    else if (found.returns !== method.returns || found.static !== method.static) issues.push(`Preserve return type/static modifier of ${method.key}: ${method.returns}, static=${method.static}`);
  }
  const constructors = expected.implicitPublicConstructor ? ['', ...expected.constructors] : expected.constructors;
  for (const signature of constructors) if (!actual.constructors.includes(signature) && !(signature === '' && actual.implicitPublicConstructor)) {
    issues.push(`Restore public constructor (${signature})`);
  }
  return { status:issues.length?'failed':'ok', detail:issues.join('\n') };
}
