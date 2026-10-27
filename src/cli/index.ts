#!/usr/bin/env node
/**
 * Command line interface of the Knowledge Rule Engine.
 *
 *   rule-engine retrieve --file X.java [--task "..."] [--format json|prompt|text]
 *   rule-engine validate --file X.java [--rules TP-A-001,TP-B-002] [--format json|text]
 *   rule-engine features --file X.java [--format json|text]
 *   rule-engine rules [--domain thread_pool] [--json]
 *   rule-engine prompt   --file X.java --task "..." [--strategy rules|rag|baseline] [--out DIR]
 *   rule-engine eval     [--cases cases] [--out eval] [--emit-prompts] [--agent-results]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { RuleEngine, REPOSITORY_ROOT } from '../api/engine.ts';
import type { RetrieveResult, ValidateResult } from '../domain/types.ts';
import { runEvaluation, writeReport } from '../../eval/runner.ts';

interface Args {
  command: string;
  file?: string;
  task?: string;
  format: 'text' | 'json' | 'prompt';
  rules?: string[];
  strategy: 'rules' | 'rag' | 'baseline';
  domain?: string;
  json: boolean;
  out?: string;
  cases?: string;
  budgetTokens?: number;
  maxRules?: number;
  topK?: number;
  includeRelated: boolean;
  includeRationale: boolean;
  emitPrompts: boolean;
  agentResults: boolean;
  strategies?: string[];
  quiet: boolean;
  javac?: string;
  java?: string;
  classpath?: string;
  release?: number;
  timeoutMs?: number;
  caseIds?: string[];
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    command: argv[0] ?? 'help',
    format: 'text',
    strategy: 'rules',
    json: false,
    includeRelated: false,
    includeRationale: false,
    emitPrompts: false,
    agentResults: false,
    quiet: false,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    const value = argv[index + 1];
    switch (token) {
      case '--file':
      case '-f':
        args.file = value;
        index += 1;
        break;
      case '--task':
      case '-t':
        args.task = value;
        index += 1;
        break;
      case '--format':
        args.format = (value ?? 'text') as Args['format'];
        index += 1;
        break;
      case '--rules':
        args.rules = (value ?? '').split(',').map((item) => item.trim()).filter((item) => item.length > 0);
        index += 1;
        break;
      case '--strategy':
        args.strategy = (value ?? 'rules') as Args['strategy'];
        index += 1;
        break;
      case '--strategies':
        args.strategies = (value ?? '').split(',').map((item) => item.trim()).filter((item) => item.length > 0);
        index += 1;
        break;
      case '--domain':
        args.domain = value;
        index += 1;
        break;
      case '--out':
        args.out = value;
        index += 1;
        break;
      case '--cases':
        args.cases = value;
        index += 1;
        break;
      case '--budget-tokens':
        args.budgetTokens = Number(value);
        index += 1;
        break;
      case '--max-rules':
        args.maxRules = Number(value);
        index += 1;
        break;
      case '--top-k':
        args.topK = Number(value);
        index += 1;
        break;
      case '--related':
        args.includeRelated = true;
        break;
      case '--no-related':
        args.includeRelated = false;
        break;
      case '--rationale':
        args.includeRationale = true;
        break;
      case '--json':
        args.json = true;
        break;
      case '--emit-prompts':
        args.emitPrompts = true;
        break;
      case '--agent-results':
        args.agentResults = true;
        break;
      case '--javac': args.javac = value; index += 1; break;
      case '--java': args.java = value; index += 1; break;
      case '--classpath': args.classpath = value; index += 1; break;
      case '--release': args.release = Number(value); index += 1; break;
      case '--timeout-ms': args.timeoutMs = Number(value); index += 1; break;
      case '--case-ids':
        args.caseIds = [...new Set((value ?? '').split(',').map(id => id.trim()).filter(Boolean))];
        if (!args.caseIds.length) fail('--case-ids requires at least one case ID');
        index += 1;
        break;
      case '--quiet':
        args.quiet = true;
        break;
      default:
        break;
    }
  }
  return args;
}
function readCode(args: Args): { code: string; file: string } {
  if (args.file === undefined) fail('缺少 --file <path.java>');
  const file = resolve(args.file);
  if (!existsSync(file)) fail(`文件不存在: ${file}`);
  return { code: readFileSync(file, 'utf8'), file };
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(2);
}

function help(): void {
  console.log(`Knowledge Rule Engine (Phase 1 PoC)

用法:
  rule-engine retrieve --file <X.java> [--task "..."] [--format text|json|prompt] [--no-related] [--rationale] [--max-rules N] [--budget-tokens N]
  rule-engine validate --file <X.java> [--rules ID1,ID2] [--format text|json]
  rule-engine features --file <X.java> [--format text|json]
  rule-engine rules [--domain thread_pool] [--json]
  rule-engine prompt   --file <X.java> --task "..." [--strategy rules|rag|baseline] [--out <dir>]
  rule-engine eval     [--cases cases] [--out eval] [--emit-prompts] [--agent-results] [--budget-tokens N]
                   [--javac PATH] [--java PATH] [--release 21] [--classpath PATHS] [--timeout-ms 10000]
                   [--case-ids CASE-012,CASE-019]

示例:
  rule-engine retrieve --file samples/bad/OrderAsyncService.java --format json
  rule-engine validate --file samples/bad/OrderAsyncService.java
  rule-engine eval --emit-prompts
`);
}

function printRetrieveText(result: RetrieveResult): void {
  console.log(`file: ${result.file_path}`);
  console.log(`features (${result.features.length}): ${result.features.join(', ') || '-'}`);
  console.log(
    `rules ${result.stats.matched_rules}/${result.stats.candidate_rules} | ~${result.stats.estimated_tokens} tokens | ${result.stats.analyze_ms}ms`,
  );
  for (const rule of result.rules) {
    const via = rule.via === 'related' ? ` (related of ${rule.via_rule ?? '?'})` : '';
    console.log(`  [${rule.id}] ${rule.name} — ${rule.severity}/${rule.priority}${via}`);
    console.log(`      matched: ${rule.matched_features.join(', ') || '-'} | ~${rule.estimated_tokens} tokens`);
  }
  for (const warning of result.warnings) console.log(`  warning: ${warning}`);
}

function printValidateText(result: ValidateResult): void {
  console.log(`file: ${result.file_path}`);
  console.log(`status: ${result.status ?? 'unknown'}`);
  console.log(`checked ${result.stats.checked_rules} rules | violations ${result.stats.violations}`);
  for (const violation of result.violations) {
    console.log(`  [${violation.severity}] ${violation.rule_id} L${violation.line}:${violation.column} ${violation.message}`);
    console.log(`      snippet: ${violation.snippet}`);
    console.log(`      fix: ${violation.suggestion}`);
  }
  for (const warning of result.warnings) console.log(`  warning: ${warning}`);
}

function describeApplicability(applicability: { features?: string[]; any_features?: string[]; none_features?: string[] }): string {
  const parts: string[] = [];
  if (applicability.features !== undefined) parts.push(`all(${applicability.features.join('&')})`);
  if (applicability.any_features !== undefined) parts.push(`any(${applicability.any_features.join('|')})`);
  if (applicability.none_features !== undefined) parts.push(`none(${applicability.none_features.join('|')})`);
  return parts.join(' + ') || '-';
}
function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const engine = RuleEngine.load();

  switch (args.command) {
    case 'retrieve': {
      const { code, file } = readCode(args);
      const result = engine.retrieve({
        code,
        filePath: file,
        ...(args.task === undefined ? {} : { task: args.task }),
        includeRelated: args.includeRelated,
        includeRationale: args.includeRationale,
        ...(args.maxRules === undefined ? {} : { maxRules: args.maxRules }),
        ...(args.budgetTokens === undefined ? {} : { tokenBudget: args.budgetTokens }),
      });
      if (args.format === 'json' || args.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (args.format === 'prompt') {
        console.log(
          engine.renderPrompt({
            task: args.task ?? '请根据当前代码完成任务',
            strategy: 'rules', code, filePath: file, features: result.features, rules: result.rules,
          }).prompt,
        );
      } else {
        printRetrieveText(result);
      }
      return;
    }
    case 'validate': {
      const { code, file } = readCode(args);
      const result = engine.validate({ code, filePath: file, ...(args.rules === undefined ? {} : { ruleIds: args.rules }) });
      if (args.format === 'json' || args.json) console.log(JSON.stringify(result, null, 2));
      else printValidateText(result);
      if (result.status === 'invalid' || result.status === 'partial') process.exitCode = 2;
      else if (result.violations.some((violation) => violation.severity === 'error')) process.exitCode = 1;
      return;
    }
    case 'features': {
      const { code, file } = readCode(args);
      const analysis = engine.analyze({ code, filePath: file });
      if (args.format === 'json' || args.json) {
        console.log(JSON.stringify({ file_path: file, features: analysis.featureIds, details: analysis.features }, null, 2));
        return;
      }
      console.log(`file: ${file}`);
      for (const feature of analysis.features) {
        console.log(`  ${feature.id} x${feature.hits} [${feature.confidence}] ${feature.description}`);
        for (const evidence of feature.evidence) console.log(`      L${evidence.startLine}:${evidence.startColumn} ${evidence.snippet}`);
      }
      return;
    }
    case 'rules': {
      const rules = args.domain === undefined ? engine.rules() : engine.repository.byDomain('java', args.domain);
      if (args.json || args.format === 'json') {
        console.log(JSON.stringify(rules, null, 2));
        return;
      }
      console.log(`${rules.length} rules`);
      for (const rule of rules) {
        console.log(`  [${rule.id}] ${rule.name} — ${rule.severity}/${rule.priority} | applies_when: ${describeApplicability(rule.applies_when)}`);
      }
      return;
    }
    case 'prompt': {
      const { code, file } = readCode(args);
      if (args.task === undefined) fail('prompt 需要 --task "..."');
      const rendered = engine.buildPrompt({
        task: args.task,
        strategy: args.strategy,
        code,
        filePath: file,
        ...(args.budgetTokens === undefined ? {} : { tokenBudget: args.budgetTokens }),
        ...(args.topK === undefined ? {} : { topK: args.topK }),
      });
      for (const warning of rendered.warnings ?? []) console.error(`warning: ${warning}`);
      if (args.out === undefined) {
        console.log(rendered.prompt);
        return;
      }
      mkdirSync(args.out, { recursive: true });
      const path = resolve(args.out, `prompt-${args.strategy}.md`);
      writeFileSync(path, `${rendered.prompt}\n`, 'utf8');
      if (!args.quiet) console.log(`written: ${path} (~${rendered.estimated_tokens} tokens, knowledge ~${rendered.context_tokens} tokens)`);
      return;
    }
    case 'eval': {
      const outputDir = resolve(args.out ?? resolve(REPOSITORY_ROOT, 'eval'));
      const report = runEvaluation({
        casesDir: resolve(args.cases ?? resolve(REPOSITORY_ROOT, 'cases')),
        outputDir,
        ...(args.strategies === undefined ? {} : { strategies: args.strategies as Array<'baseline' | 'rag' | 'rules'> }),
        tokenBudget: args.budgetTokens ?? 1200,
        topK: args.topK ?? 5,
        emitPrompts: args.emitPrompts,
        evaluateAgentResults: args.agentResults,
        engine,
        ...(args.caseIds === undefined ? {} : { caseIds: args.caseIds }),
        java: {
          ...(args.javac === undefined ? {} : { javac: args.javac }),
          ...(args.java === undefined ? {} : { java: args.java }),
          ...(args.classpath === undefined ? {} : { classpath: args.classpath.split(delimiter).map(p => resolve(p)) }),
          ...(args.release === undefined ? {} : { release: args.release }),
          ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
        },
      });
      const { markdownPath, jsonPath } = writeReport(report, outputDir);
      console.log(`report: ${markdownPath}`);
      console.log(`report: ${jsonPath}`);
      for (const entry of report.strategies) {
        const metrics = entry.rule_retrieval_applicable
          ? `rule P/R/F1 = ${entry.rule_precision}/${entry.rule_recall}/${entry.rule_f1}` +
            ` | feature P/R/F1 = ${entry.feature_precision}/${entry.feature_recall}/${entry.feature_f1}`
          : `rule/feature metrics = n/a${entry.reference_recall === undefined ? '' : ` | ref recall = ${entry.reference_recall}`}`;
        console.log(
          `  ${entry.strategy.padEnd(8)} ${metrics}` +
            ` | avg context tokens = ${entry.avg_context_tokens}` +
            ` (budgeted ${entry.avg_context_tokens_budgeted}) | avg rules = ${entry.avg_retrieved_rules}`,
        );
      }
      return;
    }
    case 'help':
    case '--help':
    case '-h':
      help();
      return;
    default:
      fail(`未知命令: ${args.command}（可用: retrieve | validate | features | rules | prompt | eval | help）`);
  }
}

main();
