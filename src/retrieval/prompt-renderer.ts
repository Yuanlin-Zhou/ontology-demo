/**
 * Prompt renderer for the first agent experiment (01-phase1 §9).
 *
 * A rendered prompt = 原始任务 + Applicable Engineering Rules (+ optional code),
 * which is what the baseline / RAG / rule-retrieval comparison feeds to Cline.
 */
import type { FeatureId, RetrievalStrategy, RetrievedChunk, RetrievedRule } from '../domain/types.ts';
import { estimateTokens } from './token-estimator.ts';

export interface PromptInput {
  task: string;
  strategy: RetrievalStrategy;
  /** Case id, used when writing prompt files during the evaluation. */
  caseId?: string;
  filePath?: string;
  code?: string;
  /** Include the current code in the prompt (default true). */
  includeCode?: boolean;
  features?: readonly FeatureId[];
  rules?: readonly RetrievedRule[];
  chunks?: readonly RetrievedChunk[];
}

export interface RenderPromptResult {
  prompt: string;
  estimated_tokens: number;
  /** Token cost of the injected knowledge (rules / chunks), i.e. Context Token Cost. */
  context_tokens: number;
  features?: FeatureId[];
  rule_ids?: string[];
  chunks?: RetrievedChunk[];
}

export function renderPrompt(input: PromptInput): RenderPromptResult {
  const includeCode = input.includeCode ?? true;
  const sections: string[] = [];

  if (input.caseId !== undefined) sections.push(`## Case\n${input.caseId}`);
  sections.push(`## 原始任务\n${input.task.trim()}`);

  const contextTokens = renderKnowledge(input, sections);

  if (includeCode && input.code !== undefined && input.code.trim().length > 0) {
    const label = input.filePath === undefined ? '当前代码' : `当前代码 (${input.filePath})`;
    sections.push(`## ${label}\n\`\`\`java\n${input.code.trim()}\n\`\`\``);
  }

  sections.push('## 要求\n请完成任务并严格遵循以上工程规范；如规范与实现冲突，请说明取舍原因。');

  const prompt = sections.join('\n\n');
  const result: RenderPromptResult = {
    prompt,
    estimated_tokens: estimateTokens(prompt),
    context_tokens: contextTokens,
  };
  if (input.features !== undefined) result.features = [...input.features];
  if (input.rules !== undefined) result.rule_ids = input.rules.map((rule) => rule.id);
  if (input.chunks !== undefined) result.chunks = [...input.chunks];
  return result;
}

function renderKnowledge(input: PromptInput, sections: string[]): number {
  switch (input.strategy) {
    case 'baseline':
      return 0;
    case 'rag': {
      const chunks = input.chunks ?? [];
      if (chunks.length === 0) return 0;
      const body = chunks
        .map((chunk) => `### ${chunk.heading} (source: ${chunk.source}, score=${chunk.score})\n${chunk.text}`)
        .join('\n\n');
      sections.push(`## Retrieved Knowledge (RAG)\n${body}`);
      return chunks.reduce((total, chunk) => total + chunk.estimated_tokens, 0);
    }
    case 'rules': {
      const rules = input.rules ?? [];
      if (rules.length === 0) return 0;
      const features =
        input.features === undefined || input.features.length === 0
          ? ''
          : `检测到的语义特征：\n${input.features.map((feature) => `- ${feature}`).join('\n')}\n\n`;
      const body = rules
        .map((rule) => {
          const related = rule.related_rules.length > 0 ? `\nRelated rules: ${rule.related_rules.join(', ')}` : '';
          return `[${rule.id}] ${rule.name} (${rule.severity}/${rule.priority})\n${rule.content}${related}`;
        })
        .join('\n\n');
      sections.push(`## Applicable Engineering Rules\n${features}${body}`);
      return rules.reduce((total, rule) => total + rule.estimated_tokens, 0);
    }
    default:
      return 0;
  }
}
