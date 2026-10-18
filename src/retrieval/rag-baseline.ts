/**
 * Naive RAG baseline used by the Phase 1 comparison (01-phase1 §10).
 *
 * The two knowledge documents (`java-thread-pool-summary.md`,
 * `java-thread-pool-best-practices.md`) are split into heading scoped chunks and
 * ranked with BM25. This is deliberately "普通 RAG": plain text chunks, no
 * semantic features, no rule applicability.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { RetrievedChunk } from '../domain/types.ts';
import { estimateTokens } from './token-estimator.ts';

export interface RagOptions {
  /** Maximum number of chunks returned (default 5). */
  topK?: number;
  /** Soft token budget; chunks are added until the budget is exhausted. */
  tokenBudget?: number;
  /** Chunk size cap in characters (default 900). */
  chunkSize?: number;
}

interface Chunk {
  source: string;
  heading: string;
  text: string;
  tokens: Map<string, number>;
  length: number;
}

interface Index {
  chunks: Chunk[];
  df: Map<string, number>;
  avgLength: number;
  documents: string[];
}

const K1 = 1.5;
const B = 0.75;

export class RagBaseline {
  readonly corpusDir: string;
  private index: Index | null = null;

  constructor(corpusDir: string) {
    this.corpusDir = corpusDir;
  }

  /** Lazily builds the chunk index from the markdown corpus. */
  private ensureIndex(): Index {
    if (this.index !== null) return this.index;
    const chunks: Chunk[] = [];
    const documents: string[] = [];
    for (const file of listMarkdownFiles(this.corpusDir)) {
      documents.push(basename(file));
      chunks.push(...chunkMarkdown(readFileSync(file, 'utf8'), basename(file)));
    }
    const df = new Map<string, number>();
    for (const chunk of chunks) {
      for (const token of chunk.tokens.keys()) df.set(token, (df.get(token) ?? 0) + 1);
    }
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    this.index = { chunks, df, avgLength: chunks.length === 0 ? 0 : totalLength / chunks.length, documents };
    return this.index;
  }

  /** Documents (file names) that form the corpus. */
  corpus(): string[] {
    return this.ensureIndex().documents;
  }

  /** Ranks corpus chunks for a query. */
  retrieve(query: string, options: RagOptions = {}): RetrievedChunk[] {
    const index = this.ensureIndex();
    const topK = options.topK ?? 5;
    const chunkSize = options.chunkSize ?? 900;
    const queryTokens = [...new Set(tokenize(query))];
    const scored = index.chunks
      .map((chunk) => ({ chunk, score: bm25(chunk, queryTokens, index) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);

    const picked: RetrievedChunk[] = [];
    let usedTokens = 0;
    for (const entry of scored) {
      if (picked.length >= topK) break;
      const text = entry.chunk.text.length > chunkSize ? `${entry.chunk.text.slice(0, chunkSize)}...` : entry.chunk.text;
      const tokens = estimateTokens(text);
      if (options.tokenBudget !== undefined && picked.length > 0 && usedTokens + tokens > options.tokenBudget) continue;
      picked.push({
        source: entry.chunk.source,
        heading: entry.chunk.heading,
        text,
        score: Number(entry.score.toFixed(4)),
        estimated_tokens: tokens,
      });
      usedTokens += tokens;
    }
    return picked;
  }
}

function bm25(chunk: Chunk, queryTokens: readonly string[], index: Index): number {
  if (index.avgLength === 0) return 0;
  let score = 0;
  for (const token of queryTokens) {
    const tf = chunk.tokens.get(token);
    if (tf === undefined) continue;
    const df = index.df.get(token) ?? 1;
    const idf = Math.log(1 + (index.chunks.length - df + 0.5) / (df + 0.5));
    const denominator = tf + K1 * (1 - B + (B * chunk.length) / index.avgLength);
    score += idf * ((tf * (K1 + 1)) / denominator);
  }
  return score;
}

function listMarkdownFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => /\.md$/i.test(entry))
    .map((entry) => join(dir, entry))
    .filter((file) => statSync(file).isFile())
    .sort();
}
/** Splits a markdown document into heading scoped chunks. */
function chunkMarkdown(content: string, source: string, maxChars = 1200): Chunk[] {
  const lines = content.split(/\r?\n/);
  const sections: Array<{ heading: string; text: string }> = [];
  let heading = basename(source);
  let body: string[] = [];
  const flush = (): void => {
    const text = body.join('\n').trim();
    if (text.length > 0) sections.push({ heading, text });
    body = [];
  };
  for (const line of lines) {
    const match = /^(#{2,4})\s+(.*)$/.exec(line);
    if (match !== null) {
      flush();
      heading = `${basename(source)} § ${(match[2] ?? '').trim()}`;
      continue;
    }
    body.push(line);
  }
  flush();

  const out: Chunk[] = [];
  for (const section of sections) {
    for (const part of splitLong(section.text, maxChars)) {
      const tokens = new Map<string, number>();
      const list = tokenize(part);
      for (const token of list) tokens.set(token, (tokens.get(token) ?? 0) + 1);
      out.push({ source, heading: section.heading, text: part, tokens, length: list.length });
    }
  }
  return out;
}

function splitLong(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    parts.push(text.slice(cursor, cursor + maxChars));
    cursor += maxChars - 100;
  }
  return parts;
}

/** Tokenizer: ASCII words plus CJK unigrams/bigrams (no external dependency). */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  for (const match of lower.matchAll(/[a-z0-9_#$@./-]{2,}/g)) tokens.push(match[0]);
  for (const run of lower.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (let index = 0; index < run.length; index += 1) tokens.push(run[index] ?? '');
    for (let index = 0; index + 1 < run.length; index += 1) tokens.push(run.slice(index, index + 2));
  }
  return tokens.filter((token) => token.length > 0);
}
