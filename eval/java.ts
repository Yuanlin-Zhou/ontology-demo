/** Real, bounded Java compilation and execution. Never rewrites generated code. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseJava } from '../src/analyzer/java-parser.ts';
import { boundedDiagnostics } from '../src/utils/diagnostics.ts';

export type CheckStatus = 'ok' | 'failed' | 'unavailable' | 'timeout' | 'not_run';
export interface JavaCheck { status: CheckStatus; detail: string }
export interface JavaOptions {
  javac?: string;
  java?: string;
  release?: number;
  classpath?: string[];
  timeoutMs?: number;
  /** Trusted, repository-owned Java main; not supplied by the model. */
  testSource?: string;
  testClass?: string;
  testArgs?: string[];
}

export function javaIdentity(code: string): { name: string; qualifiedName: string } | undefined {
  const root = parseJava(code).rootNode;
  const types = root.namedChildren.filter(n => /^(class|record|enum|interface)_declaration$/.test(n.type));
  const primary = types.find(n => n.children.some(c => c.type === 'modifiers' && /\bpublic\b/.test(c.text))) ?? types[0];
  const name = primary?.childForFieldName('name')?.text;
  if (!name) return undefined;
  const pkg = root.namedChildren.find(n => n.type === 'package_declaration');
  const packageName = pkg?.namedChildren.find(n => n.type === 'scoped_identifier' || n.type === 'identifier')?.text;
  return { name, qualifiedName: packageName ? `${packageName}.${name}` : name };
}

function execute(command: string, args: string[], cwd: string, timeoutMs: number, allowUnavailable = false): JavaCheck {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error?.message ?? ''}`;
  const detail = boundedDiagnostics(output);
  if (result.error && 'code' in result.error && ['ENOENT', 'EACCES', 'EPERM'].includes(String(result.error.code))) return { status: 'unavailable', detail };
  if (result.error && 'code' in result.error && result.error.code === 'ETIMEDOUT') return { status: 'timeout', detail };
  if (allowUnavailable && result.status === 77 && output.includes('UNAVAILABLE_ADAPTER:')) return { status: 'unavailable', detail };
  return { status: result.status === 0 && !result.error ? 'ok' : 'failed', detail };
}

export function checkJava(file: string, options: JavaOptions = {}): { compile: JavaCheck; tests: JavaCheck } {
  const code = readFileSync(file, 'utf8');
  const identity = javaIdentity(code);
  const notRun: JavaCheck = { status: 'not_run', detail: 'No executable acceptance test configured.' };
  if (!identity) return { compile: { status: 'failed', detail: 'No top-level Java type.' }, tests: notRun };
  const dir = mkdtempSync(join(tmpdir(), 'rule-engine-java-'));
  const timeout = options.timeoutMs ?? 10000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || !Number.isSafeInteger(options.release ?? 21) || (options.release ?? 21) < 8) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error('Java timeout must be a positive integer and release must be >= 8.');
  }
  try {
    const classes = join(dir, 'classes');
    mkdirSync(classes);
    const source = join(dir, `${identity.name}.java`);
    writeFileSync(source, code);
    const cp = options.classpath ?? [];
    // Explicit classpath and disabled annotation processors prevent implicit host dependencies.
    // javac also starts a JVM; bound its heap/worker count like the runtime to avoid host-CPU oversubscription.
    const flags = ['-J-Xmx128m', '-J-XX:ActiveProcessorCount=2', '-encoding', 'UTF-8', '-proc:none', '--release', String(options.release ?? 21), '-classpath', cp.length ? cp.join(delimiter) : classes, '-d', classes];
    const compile = execute(options.javac ?? 'javac', [...flags, source], dir, timeout);
    if (compile.status !== 'ok') return { compile, tests: { status: 'not_run', detail: 'Skipped because compilation did not succeed.' } };
    if (!options.testSource || !options.testClass) return { compile, tests: notRun };
    const testFile = join(dir, `${options.testClass.split('.').at(-1)}.java`);
    writeFileSync(testFile, readFileSync(options.testSource, 'utf8'));
    const testCompile = execute(options.javac ?? 'javac', [...flags, '-classpath', [classes, ...cp].join(delimiter), testFile], dir, timeout);
    if (testCompile.status !== 'ok') return { compile, tests: { ...testCompile, detail: `Acceptance test compilation: ${testCompile.detail}` } };
    const tests = execute(options.java ?? 'java', ['-Xmx128m', '-XX:ActiveProcessorCount=2', '-ea', '-cp', [classes, ...cp].join(delimiter), options.testClass, identity.qualifiedName, ...(options.testArgs ?? [])], dir, timeout, true);
    return { compile, tests };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
