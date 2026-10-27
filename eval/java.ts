/** Real javac / isolated JVM verification. Harnesses are trusted repository fixtures. */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { REPOSITORY_ROOT } from '../src/api/engine.ts';

export interface JavaVerification {
  compile: 'ok' | 'failed' | 'unavailable';
  behavior: 'passed' | 'failed' | 'unavailable';
  diagnostics: string;
}
export interface JavaContract {
  source: string;
  harness?: string;
  main?: string;
  support?: string[];
}
export function javaTool(name: 'java' | 'javac'): string {
  for (const home of [process.env['JAVA_HOME'], join(REPOSITORY_ROOT, '.tools/jdk')]) {
    if (home && existsSync(join(home, 'bin', name))) return join(home, 'bin', name);
  }
  return name;
}
export function verifyJava(code: string, contract?: JavaContract): JavaVerification {
  const version = spawnSync(javaTool('javac'), ['-version'], { encoding: 'utf8', timeout: 5000 });
  if (version.status !== 0) return { compile: 'unavailable', behavior: 'unavailable', diagnostics: 'javac unavailable; run npm run setup:java' };
  const dir = mkdtempSync(join(tmpdir(), 'rule-engine-java-'));
  try {
    const className = code.match(/\bpublic\s+(?:(?:final|abstract)\s+)?(?:class|record|interface|enum)\s+(\w+)/)?.[1] ?? 'Generated';
    const source = join(dir, contract?.source ?? `${className}.java`);
    mkdirSync(resolve(source, '..'), { recursive: true });
    writeFileSync(source, code);
    const sources = [source];
    for (const file of [...(contract?.support ?? []), ...(contract?.harness ? [contract.harness] : [])]) {
      const dest = join(dir, basename(file));
      writeFileSync(dest, readFileSync(file));
      sources.push(dest);
    }
    const classes = join(dir, 'classes');
    mkdirSync(classes);
    // Do not pass API credentials, proxy configuration or JAVA_TOOL_OPTIONS to generated code.
    const env = { PATH: process.env['PATH'] ?? '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: dir, TMPDIR: dir };
    const compiled = spawnSync(javaTool('javac'), ['-J-Xmx256m', '--release', '21', '-encoding', 'UTF-8', '-proc:none', '-d', classes, ...sources],
      { cwd: dir, env, encoding: 'utf8', timeout: 20000, maxBuffer: 128 * 1024 });
    if (compiled.status !== 0) return { compile: 'failed', behavior: 'unavailable', diagnostics: String(compiled.error?.message ?? compiled.stderr).slice(0, 8000) };
    if (!contract?.main || !contract.harness) return { compile: 'ok', behavior: 'unavailable', diagnostics: 'No behavioral contract provided' };
    const result = spawnSync(javaTool('java'), ['-Xmx128m', '-XX:ActiveProcessorCount=2', '-ea', '-cp', classes, contract.main],
      { cwd: dir, env, encoding: 'utf8', timeout: 12000, maxBuffer: 128 * 1024 });
    return { compile: 'ok', behavior: result.status === 0 ? 'passed' : 'failed', diagnostics: String(result.error?.message ?? `${result.stdout}\n${result.stderr}`).slice(0, 8000) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
