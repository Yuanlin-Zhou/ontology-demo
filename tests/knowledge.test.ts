/**
 * Knowledge base tests: rule repository integrity and the rule matcher.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DEFAULT_KNOWLEDGE_DIR } from '../src/api/engine.ts';
import { isApplicable, matchRules } from '../src/matcher/rule-matcher.ts';
import { RuleRepository, RuleValidationError } from '../src/matcher/rule-repository.ts';

const repository = RuleRepository.load({ knowledgeDir: DEFAULT_KNOWLEDGE_DIR });

describe('rule repository', () => {
  it('loads the thread pool atomic rules', () => {
    assert.equal(repository.rules.length, 26);
    assert.equal(new Set(repository.rules.map((rule) => rule.id)).size, 26);
  });

  it('every rule has an id, applicability, content and references', () => {
    for (const rule of repository.rules) {
      assert.match(rule.id, /^TP-(CREATE|CONFIG|SUBMIT|REJECT|SHUTDOWN|MONITOR)-\d{3}$/, rule.id);
      assert.ok(rule.content.length > 20, `${rule.id}: content is too short`);
      assert.ok(rule.description.length > 5, `${rule.id}: description is too short`);
      assert.ok((rule.references ?? []).length > 0, `${rule.id}: knowledge reference missing`);
      const applicability = rule.applies_when;
      assert.ok(
        (applicability.features?.length ?? 0) + (applicability.any_features?.length ?? 0) + (applicability.none_features?.length ?? 0) > 0,
        `${rule.id}: applies_when must be defined`,
      );
    }
  });

  it('every rule carries positive and negative examples', () => {
    for (const rule of repository.checkable()) {
      assert.ok((rule.examples?.positive?.length ?? 0) > 0, `${rule.id}: missing positive example`);
      assert.ok((rule.examples?.negative?.length ?? 0) > 0, `${rule.id}: missing negative example`);
    }
  });

  it('rejects rules with unknown features', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rule-engine-'));
    writeFileSync(
      join(dir, 'broken.yaml'),
      [
        'id: TP-TEST-001',
        'name: broken',
        'domain: [java]',
        'applies_when:',
        '  features: [THREAD_POOL.NOT_A_FEATURE]',
        'description: broken rule',
        'content: broken rule content',
        'severity: error',
        'priority: high',
      ].join('\n'),
      'utf8',
    );
    assert.throws(() => RuleRepository.load({ knowledgeDir: dir }), RuleValidationError);
  });

  it('rejects duplicate rule ids', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rule-engine-'));
    const rule = (suffix: string): string =>
      [
        `id: TP-TEST-00${suffix}`,
        `name: duplicate ${suffix}`,
        'domain: [java]',
        'applies_when:',
        '  features: [THREAD_POOL.CREATE]',
        `description: rule ${suffix}`,
        `content: content ${suffix}`,
        'severity: error',
        'priority: high',
      ].join('\n');
    writeFileSync(join(dir, 'a.yaml'), rule('1'), 'utf8');
    writeFileSync(join(dir, 'b.yaml'), rule('1'), 'utf8');
    assert.throws(() => RuleRepository.load({ knowledgeDir: dir }), (error: Error) => error.message.includes('id 重复'));
  });
});

describe('rule matcher', () => {
  it('applies AND semantics for `features`', () => {
    const rule = repository.get('TP-CONFIG-003');
    assert.ok(rule !== undefined);
    assert.equal(isApplicable(rule, new Set(['THREAD_POOL.CONFIG.MAX_SIZE'])), false);
    assert.equal(isApplicable(rule, new Set(['THREAD_POOL.CONFIG.MAX_SIZE', 'THREAD_POOL.CONFIG.KEEP_ALIVE'])), true);
  });

  it('applies OR semantics for `any_features`', () => {
    const rule = repository.get('TP-CREATE-003');
    assert.ok(rule !== undefined);
    assert.equal(isApplicable(rule, new Set(['THREAD_POOL.CREATE'])), true);
    assert.equal(isApplicable(rule, new Set(['THREAD_POOL.SCHEDULED'])), true);
    assert.equal(isApplicable(rule, new Set(['THREAD_POOL.SUBMIT'])), false);
  });

  it('maps code semantics to the documented rule set', () => {
    const result = matchRules(repository, ['THREAD_POOL.CREATE', 'THREAD_POOL.SUBMIT'], { includeRelated: false });
    const ids = result.rules.map((rule) => rule.id);
    assert.deepEqual(ids, [
      'TP-CREATE-001',
      'TP-REJECT-001',
      'TP-SHUTDOWN-001',
      'TP-CREATE-003',
      'TP-REJECT-003',
      'TP-SUBMIT-001',
      'TP-MONITOR-001',
    ]);
    assert.equal(result.rules[0]?.priority, 'critical');
    assert.deepEqual(result.rules[0]?.matched_features, ['THREAD_POOL.CREATE']);
  });

  it('pulls in related rules when requested', () => {
    const result = matchRules(repository, ['THREAD_POOL.CONFIG.REJECTION'], { includeRelated: true });
    const viaRelated = result.rules.filter((rule) => rule.via === 'related');
    assert.ok(viaRelated.length > 0);
    for (const rule of viaRelated) assert.ok(rule.via_rule !== undefined);
  });

  it('trims the payload to the token budget', () => {
    const result = matchRules(repository, ['THREAD_POOL.CREATE'], { includeRelated: false, tokenBudget: 100 });
    assert.ok(result.rules.length >= 1, 'at least one rule is always kept');
    assert.ok(result.estimatedTokens <= 400, `unexpected payload size ${result.estimatedTokens}`);
    assert.equal(result.truncated, true);
  });

  it('honours maxRules', () => {
    const result = matchRules(repository, ['THREAD_POOL.CREATE', 'THREAD_POOL.SUBMIT'], { includeRelated: false, maxRules: 2 });
    assert.equal(result.rules.length, 2);
    assert.equal(result.truncated, true);
  });
});
