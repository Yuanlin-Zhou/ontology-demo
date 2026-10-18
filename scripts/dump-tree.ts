/**
 * Dev tool: prints the tree-sitter AST of a Java file.
 *
 *   node scripts/dump-tree.ts samples/bad/OrderAsyncService.java [--depth 4] [--fields]
 *
 * Used while adding new semantic features, to verify the exact node types and
 * field names produced by the `tree-sitter-java` grammar.
 */
import { readFileSync } from 'node:fs';
import { parseJava, getJavaParserInfo } from '../src/analyzer/java-parser.ts';

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/dump-tree.ts <file.java> [--depth N]');
  process.exit(1);
}

const depth = Number(argValue('--depth') ?? 6);
const code = readFileSync(file, 'utf8');
const info = getJavaParserInfo();
const parsed = parseJava(code, file);

console.log(`language=${info.language} runtime=${info.runtime} grammar=${info.grammar}`);
console.log(`parse errors=${parsed.errors.length}`);

function dump(node: NonNullable<ReturnType<typeof parsed.rootNode.child>>, level: number): void {
  const text = node.text.length > 60 ? `${node.text.slice(0, 57).replace(/\s+/g, ' ')}...` : node.text.replace(/\s+/g, ' ');
  const field = node.parent?.fieldNameForChild(node.parent.children.indexOf(node)) ?? null;
  const missing = node.isMissing ? ' MISSING' : '';
  const error = node.isError ? ' ERROR' : '';
  console.log(
    `${'  '.repeat(level)}${field ? `${field}: ` : ''}${node.type}${missing}${error} [${node.startPosition.row + 1}:${node.startPosition.column + 1}] ${JSON.stringify(text)}`,
  );
  if (level >= depth) {
    if (node.namedChildCount > 0) console.log(`${'  '.repeat(level + 1)}... (${node.namedChildCount} children)`);
    return;
  }
  for (const child of node.children) dump(child, level + 1);
}

dump(parsed.rootNode, 0);
