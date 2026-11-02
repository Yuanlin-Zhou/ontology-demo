/** Zero-model-call snapshots of archived generations. Never edits historical evidence. */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { RuleEngine, REPOSITORY_ROOT } from '../src/api/engine.ts';

const output = process.argv[2];
if (!output) throw new Error('Usage: node eval/audit-rule-coverage.ts NEW_OUTPUT.json');
if (existsSync(output)) throw new Error('Refusing to overwrite an existing audit.');
const engine = RuleEngine.load();
const snapshots = [];
for (const experiment of ['2026-10-27-63calls', '2026-11-02-observable-v2']) {
  const root = join('eval/experiments', experiment, 'evidence');
  const historical = JSON.parse(readFileSync(join(root, 'report.json'), 'utf8'));
  for (const strategy of ['baseline', 'rag', 'rules']) {
    for (const file of readdirSync(join(root, 'results', strategy)).filter(f => f.endsWith('.java')).sort()) {
      const source = join(root, 'results', strategy, file);
      const code = readFileSync(source, 'utf8');
      const validation = engine.validate({ code, filePath: source });
      const retrieved = engine.retrieve({ code, filePath: source, tokenBudget: 1200 });
      const original = historical.agent.find((a: { strategy: string; case_id: string }) => a.strategy === strategy && a.case_id === file.replace('.java', ''));
      snapshots.push({ experiment, strategy, case_id: file.replace('.java', ''), source,
        source_sha256: createHash('sha256').update(code).digest('hex'),
        historical: original ? { violations: original.violations, errors: original.errors, violation_rules: original.violation_rules,
          compile: original.compile, test: original.test_check.status } : null,
        validation, retrieval: { selected: retrieved.rules.map(r => r.id), dropped: retrieved.selection?.dropped_rule_ids,
          warnings: retrieved.warnings } });
    }
  }
}
const git = (...args: string[]) => spawnSync('git', args, { cwd: REPOSITORY_ROOT, encoding: 'utf8' }).stdout.trim();
const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
const implementationHashes = Object.fromEntries(['src', 'knowledge'].flatMap(files).sort().map(file =>
  [file, createHash('sha256').update(readFileSync(file)).digest('hex')]));
mkdirSync(dirname(resolve(output)), { recursive: true });
writeFileSync(output, JSON.stringify({ model_requests: 0, generated_at: new Date().toISOString(), revision: git('rev-parse', 'HEAD'),
  working_diff_sha256: createHash('sha256').update(git('diff', 'HEAD')).digest('hex'),
  implementation_sha256: implementationHashes,
  note: 'Static recheck only. Historical compilation, behavior, usage and quality rankings are not recalculated.', snapshots }, null, 2) + '\n');
console.log(`Saved ${snapshots.length} immutable-source snapshots to ${output}`);
