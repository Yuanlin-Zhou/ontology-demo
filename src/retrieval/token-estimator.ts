/**
 * Dependency-free token estimator used for the "Context Token Cost" metric of
 * the Phase 1 evaluation (01-phase1 §10).
 *
 * Heuristic: CJK characters count as ~1 token each, everything else as
 * 1 token per 4 characters (typical for BPE tokenizers on code / English).
 */
const CJK_PATTERN = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/g;

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  const cjk = text.match(CJK_PATTERN)?.length ?? 0;
  const rest = text.replace(CJK_PATTERN, ' ');
  const restTokens = Math.ceil(rest.trim().length / 4);
  return cjk + restTokens;
}

/** Formats a byte/character scale token count for reports. */
export function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}
