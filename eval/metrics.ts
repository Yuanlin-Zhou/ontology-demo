/**
 * Metrics used by the Phase 1 evaluation (01-phase1 §10).
 */
export interface SetMetrics {
  /** |retrieved ∩ expected| / |retrieved| */
  precision: number;
  /** |retrieved ∩ expected| / |expected| */
  recall: number;
  f1: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
}

/**
 * Set based precision / recall. `ignored` items are neither counted as false
 * positives nor as misses (used for `optional_rules`).
 */
export function setMetrics(retrieved: readonly string[], expected: readonly string[], ignored: readonly string[] = []): SetMetrics {
  const ignore = new Set(ignored);
  const expectedSet = new Set(expected.filter((item) => !ignore.has(item)));
  const retrievedSet = new Set(retrieved.filter((item) => !ignore.has(item)));
  let truePositives = 0;
  for (const item of retrievedSet) if (expectedSet.has(item)) truePositives += 1;
  const falsePositives = retrievedSet.size - truePositives;
  const falseNegatives = expectedSet.size - truePositives;
  const precision = retrievedSet.size === 0 ? (expectedSet.size === 0 ? 1 : 0) : truePositives / retrievedSet.size;
  const recall = expectedSet.size === 0 ? 1 : truePositives / expectedSet.size;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1, truePositives, falsePositives, falseNegatives };
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

export function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function percent(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

/** Renders a markdown table. */
export function markdownTable(headers: readonly string[], rows: ReadonlyArray<readonly string[]>): string {
  const head = `| ${headers.join(' | ')} |`;
  const separator = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
  return [head, separator, body].join('\n');
}
