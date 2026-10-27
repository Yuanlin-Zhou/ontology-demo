/** Keep both context and the final exception when noisy logs exceed the feedback budget. */
export function boundedDiagnostics(value: string, limit = 12000): string {
  if (value.length <= limit) return value;
  // Deep recursive stacks can bury their exception header between log spam and stack frames.
  const errors = value.split('\n').filter(line => /^(?:Exception in thread |Caused by: |[\w.$]*(?:Exception|Error)(?::|$)|.*:\d+: error:)/.test(line))
    .slice(0, 20).join('\n').slice(0, 2000);
  const marker = '\n[... diagnostics truncated ...]\n' + (errors ? errors + '\n' : '');
  const head = Math.floor((limit - marker.length) / 3);
  return value.slice(0, head) + marker + value.slice(-(limit - marker.length - head));
}
