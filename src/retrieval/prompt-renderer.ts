/**
 * Prompt renderer for the first agent experiment (01-phase1 §9).
 *
 * A rendered prompt = 原始任务 + Applicable Engineering Rules (+ optional code),
 * which is what the baseline / RAG / rule-retrieval comparison feeds to Cline.
 */
import type { FeatureId, RetrievalStrategy, RetrievedChunk, RetrievedRule } from '../domain/types.ts';
import { ruleContext, chunkContext } from './knowledge-payload.ts';
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
  warnings?: string[];
  dropped_rule_ids?: string[];
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

  sections.push('## 交付要求\n保持原始业务行为、类名和公开接口；只做任务及适用规范要求的必要修改。先保证代码可编译、功能正确，再核对适用规则。\n使用目标运行环境真实存在的 API 和已声明的依赖，不臆造方法、不为满足规范添加无关业务。规范中的代码片段仅作示意，应按实际接收者类型选择正确 API。\n返回完整 Java 源码；不要通过删除业务逻辑、空实现或改变接口来消除违规。');

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
      const context = chunkContext(chunks);
      sections.push(context);
      return estimateTokens(context);
    }
    case 'rules': {
      const context = ruleContext(input.rules ?? []);
      if (context) sections.push(context);
      return estimateTokens(context);
    }
    default:
      return 0;
  }
}
