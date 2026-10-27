/** Independent labels stay fixed even when the engine disagrees. */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RuleEngine, REPOSITORY_ROOT } from '../src/api/engine.ts';
import { markdownTable, percent } from './metrics.ts';
export interface BoundaryFixture { id: string; rule: string; violation: boolean; code: string; reason: string; known_limitation?: boolean; support?: string }
export function evaluateBoundaries() {
  const engine = RuleEngine.load();
  const fixtures = JSON.parse(readFileSync(join(REPOSITORY_ROOT, 'eval/fixtures/boundaries.json'), 'utf8')) as BoundaryFixture[];
  const results = fixtures.map(f => {
    const r = engine.validate({ code: f.code });
    const detected = r.violations.some(v => v.rule_id === f.rule);
    return { id: f.id, rule: f.rule, expected: f.violation, detected, correct: detected === f.violation, known_limitation: f.known_limitation ?? false, reason: f.reason };
  });
  const realCode = readFileSync(join(REPOSITORY_ROOT, 'eval/fixtures/real-world/BasicThreadFactory.java'), 'utf8');
  const real = engine.validate({ code: realCode });
  // Apache BasicThreadFactory supports namingPattern but intentionally permits its absence.
  // This corpus is a compatibility probe, not a claim that Apache adopts our enterprise rules.
  const realWorld = { source: 'Apache Commons Lang 3.17.0 BasicThreadFactory', parse_errors: real.stats.parse_errors, features: real.features, violations: real.violations };
  const tp = results.filter(r => r.expected && r.detected).length;
  const fp = results.filter(r => !r.expected && r.detected).length;
  const fn = results.filter(r => r.expected && !r.detected).length;
  const tn = results.filter(r => !r.expected && !r.detected).length;
  return { results, realWorld, metrics: { tp, fp, fn, tn, precision: tp / (tp + fp || 1), recall: tp / (tp + fn || 1), false_positive_rate: fp / (fp + tn || 1) } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const out = resolve(process.argv[2] ?? '.eval-cache/boundaries');
  mkdirSync(out, { recursive: true });
  const report = evaluateBoundaries();
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  writeFileSync(join(out, 'report.md'), '# Independent boundary evaluation\n\n' + markdownTable(['Case', 'Rule', 'Expected violation', 'Detected', 'Known limitation'], report.results.map(r => [r.id, r.rule, String(r.expected), String(r.detected), String(r.known_limitation)])) + `\n\nPrecision ${percent(report.metrics.precision)}; recall ${percent(report.metrics.recall)}; false positive rate ${percent(report.metrics.false_positive_rate)}. Labels are human-authored; known limitations remain in the denominator. Each case tests one named rule, not complete-file compliance.\n\nApache BasicThreadFactory compatibility probe: ${report.realWorld.parse_errors} parse errors; ${report.realWorld.violations.length} enterprise-rule findings. Upstream code is not labeled enterprise-compliant. See fixtures/real-world/README.md for provenance.\n`);
  console.log(JSON.stringify(report.metrics));
  if (report.results.some(r => !r.correct && !r.known_limitation)) process.exitCode = 1;
}
