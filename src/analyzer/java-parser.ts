/**
 * Java parser front-end: tree-sitter + tree-sitter-java.
 *
 * The parser instance is created once and reused (tree-sitter parsers are
 * stateful but not thread safe; the engine uses one parser per process).
 */
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import type { Evidence } from '../domain/types.ts';

export type JavaSyntaxNode = Parser.SyntaxNode;
export type JavaTree = Parser.Tree;

export interface JavaParseError {
  message: string;
  line: number;
  column: number;
  snippet: string;
}

export interface ParsedJavaFile {
  filePath: string;
  code: string;
  /** Code split into lines (1-based accessor: `lineAt`). */
  lines: string[];
  tree: JavaTree;
  rootNode: JavaSyntaxNode;
  errors: JavaParseError[];
}

export class JavaParserError extends Error {
  override name = 'JavaParserError';
}

let cachedParser: Parser | null = null;

/** Returns the shared Java parser (language is registered lazily). */
export function getJavaParser(): Parser {
  if (cachedParser === null) {
    const parser = new Parser();
    parser.setLanguage(Java);
    cachedParser = parser;
  }
  return cachedParser;
}

export function getJavaParserInfo(): { language: string; runtime: string; grammar: string } {
  return { language: 'java', runtime: `tree-sitter@${'0.21.1'}`, grammar: 'tree-sitter-java@0.23.5' };
}

export function lineAt(lines: string[], line: number): string {
  return lines[line - 1] ?? '';
}

/** Parses Java source into a tree-sitter tree; never throws on syntax errors. */
export function parseJava(code: string, filePath = '<inline>.java'): ParsedJavaFile {
  const parser = getJavaParser();
  let tree: JavaTree;
  try {
    tree = parser.parse(code);
  } catch (cause) {
    throw new JavaParserError(`failed to parse ${filePath}: ${(cause as Error).message}`);
  }
  const lines = code.split(/\r?\n/);
  return {
    filePath,
    code,
    lines,
    tree,
    rootNode: tree.rootNode,
    errors: collectParseErrors(tree.rootNode, lines),
  };
}

/** Collects ERROR / MISSING nodes as warnings (the analyzer stays usable). */
function collectParseErrors(root: JavaSyntaxNode, lines: string[]): JavaParseError[] {
  const errors: JavaParseError[] = [];
  const visit = (node: JavaSyntaxNode): void => {
    if (node.isError || node.isMissing) {
      errors.push({
        message: node.isMissing ? `missing ${node.type}` : `syntax error near '${firstLine(node.text)}'`,
        line: node.startPosition.row + 1,
        column: node.startPosition.column + 1,
        snippet: firstLine(lineAt(lines, node.startPosition.row + 1)),
      });
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
  return errors;
}

function firstLine(text: string): string {
  const [line] = text.split(/\r?\n/);
  return (line ?? '').trim();
}

/** Builds the evidence record (span + snippet) for an AST node. */
export function evidenceOf(node: JavaSyntaxNode, lines: string[], symbol?: string): Evidence {
  const span: Evidence = {
    startLine: node.startPosition.row + 1,
    startColumn: node.startPosition.column + 1,
    endLine: node.endPosition.row + 1,
    endColumn: node.endPosition.column + 1,
    snippet: firstLine(lineAt(lines, node.startPosition.row + 1)),
  };
  if (symbol !== undefined) span.symbol = symbol;
  return span;
}
