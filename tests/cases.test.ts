/**
 * Dataset consistency tests: the case dataset itself is validated, and every
 * compliant (`good.java`) file must be free of error-severity violations.
 * This is the strongest regression guard of the PoC: it fails whenever a
 * checker starts producing false positives on idiomatic code.
 */
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { RuleEngine, REPOSITORY_ROOT } from '../src/api/engine.ts';
import { loadCases, readCaseFile } from '../eval/cases.ts';

const engine = RuleEngine.load();
const casesDir = join(REPOSITORY_ROOT, 'cases');
const cases = loadCases(casesDir);

describe('evaluation dataset', () => {
  it('contains 21 documented cases with unique ids', () => {
    assert.equal(cases.length, 21);
    assert.equal(new Set(cases.map((testCase) => testCase.id)).size, 21);
  });

  it('references only existing rules and known features', () => {
    const ruleIds = new Set(engine.rules().map((rule) => rule.id));
    const featureIds = new Set(engine.featureCatalog().map((feature) => feature.id));
    for (const testCase of cases) {
      for (const ruleId of [...testCase.expected.rules, ...testCase.expected.optional_rules, ...testCase.expected.violations, ...testCase.expected.compliant_violations]) {
        assert.ok(ruleIds.has(ruleId), `${testCase.id}: unknown rule ${ruleId}`);
      }
      for (const featureId of testCase.expected.features) {
        assert.ok(featureIds.has(featureId), `${testCase.id}: unknown feature ${featureId}`);
      }
    }
  });

  it('every case declares a retrieval target', () => {
    for (const testCase of cases) {
      assert.ok(testCase.files.before !== undefined, `${testCase.id}: before.java missing`);
      assert.ok(testCase.task.length > 5, `${testCase.id}: task is too short`);
    }
  });

  it('retrieves exactly the expected rules for every case', () => {
    for (const testCase of cases) {
      const code = readCaseFile(testCase, 'before');
      assert.ok(code !== undefined);
      const result = engine.retrieve({ code, filePath: testCase.files.before, includeRelated: false });
      const retrieved = new Set(result.rules.map((rule) => rule.id));
      const expected = new Set(testCase.expected.rules);
      const missing = [...expected].filter((ruleId) => !retrieved.has(ruleId));
      const extra = [...retrieved].filter((ruleId) => !expected.has(ruleId));
      assert.deepEqual(missing, [], `${testCase.id}: rules not retrieved`);
      assert.deepEqual(extra, [], `${testCase.id}: unexpected rules retrieved`);
    }
  });

  it('extracts exactly the expected semantic features for every case', () => {
    for (const testCase of cases) {
      const code = readCaseFile(testCase, 'before');
      assert.ok(code !== undefined);
      const analysis = engine.analyze({ code, filePath: testCase.files.before });
      assert.deepEqual(
        [...new Set(analysis.featureIds)].sort(),
        [...new Set(testCase.expected.features)].sort(),
        `${testCase.id}: feature mismatch`,
      );
    }
  });

  it('reports exactly the expected violations for every bad.java', () => {
    for (const testCase of cases) {
      const code = readCaseFile(testCase, 'bad');
      if (code === undefined) continue;
      const result = engine.validate({ code, filePath: testCase.files.bad });
      assert.deepEqual(
        [...new Set(result.violations.map((violation) => violation.rule_id))].sort(),
        [...new Set(testCase.expected.violations)].sort(),
        `${testCase.id}: violation mismatch`,
      );
    }
  });

  it('reports no error-severity violation for any good.java', () => {
    for (const testCase of cases) {
      const code = readCaseFile(testCase, 'good');
      if (code === undefined) continue;
      const result = engine.validate({ code, filePath: testCase.files.good });
      const errors = result.violations.filter((violation) => violation.severity === 'error');
      assert.deepEqual(
        errors.map((violation) => `${violation.rule_id}@${violation.line}`),
        [],
        `${testCase.id}: compliant file reported as error`,
      );
      const reported = [...new Set(result.violations.map((violation) => violation.rule_id))].sort();
      assert.deepEqual(reported, [...new Set(testCase.expected.compliant_violations)].sort(), `${testCase.id}: compliant violations mismatch`);
    }
  });

  it('documents a violated fixture for every rule that can be checked', () => {
    const violated = new Set<string>();
    for (const testCase of cases) for (const ruleId of testCase.expected.violations) violated.add(ruleId);
    for (const caseFile of cases) {
      void caseFile;
    }
    const uncovered = engine
      .repository.checkable()
      .filter((rule) => !violated.has(rule.id))
      .map((rule) => rule.id);
    assert.deepEqual(uncovered, [], `rules without a violating fixture: ${uncovered.join(', ')}`);
  });

  it('keeps the prompt artifacts small', () => {
    const reportPath = join(REPOSITORY_ROOT, 'eval', 'report.json');
    if (!existsSync(reportPath)) return;
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as { strategies: Array<{ strategy: string; avg_context_tokens: number }> };
    const rulesStrategy = report.strategies.find((entry) => entry.strategy === 'rules');
    assert.ok(rulesStrategy !== undefined);
    assert.ok(rulesStrategy.avg_context_tokens < 2500, 'rule payload grew unexpectedly');
  });
});
