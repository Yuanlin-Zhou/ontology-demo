/** Extract transport formatting only. Java source is never repaired or concatenated. */
import { sha256 } from './acceptance.ts';

export interface ExtractedJava {
  code: string;
  format: 'plain' | 'single_fenced_block';
  raw_sha256: string;
  source_sha256: string;
}

export function extractJavaSource(raw: string): ExtractedJava {
  if (!raw.trim()) throw new Error('Model returned empty source.');
  let code = raw;
  let format: ExtractedJava['format'] = 'plain';
  if (raw.trimStart().startsWith('```')) {
    const match = raw.match(/^\s*```(?:java)?[\t ]*\r?\n([\s\S]*?)\r?\n```[\t ]*\s*$/i);
    if (!match || /^\s*```/m.test(match[1] ?? '')) {
      throw new Error('Expected exactly one complete Java code block without surrounding explanation.');
    }
    code = match[1]!;
    format = 'single_fenced_block';
  } else if (/^[\t ]*```/m.test(raw)) {
    throw new Error('Explanations or multiple code blocks cannot be extracted unambiguously.');
  }
  if (!code.trim()) throw new Error('Java code block is empty.');
  return { code, format, raw_sha256: sha256(raw), source_sha256: sha256(code) };
}
