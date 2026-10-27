/** Single serialization shared by budget selection and prompt rendering. */
import type { RetrievedRule, RetrievedChunk } from '../domain/types.ts';
export function renderRule(rule: RetrievedRule): string {
  const conditional = rule.via === 'related' ? `\n关联建议（来自 ${rule.via_rule}；仅在实现涉及该场景时适用）：` : '';
  return `[${rule.id}] ${rule.name} (${rule.severity}/${rule.priority})${conditional}\n${rule.content}${rule.rationale ? '\n理由：' + rule.rationale : ''}`;
}
export function ruleContext(rules: readonly RetrievedRule[]): string {
  return rules.length ? `## Applicable Engineering Rules\n${rules.map(renderRule).join('\n\n')}` : '';
}
export function chunkContext(chunks: readonly RetrievedChunk[]): string {
  return chunks.length ? `## Retrieved Knowledge (RAG)\n${chunks.map(c => `### ${c.heading} (source: ${c.source})\n${c.text}`).join('\n\n')}` : '';
}
export function nonNegativeLimit(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new Error(`${name} must be a nonnegative integer`);
}
