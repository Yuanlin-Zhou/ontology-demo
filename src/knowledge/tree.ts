import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { FEATURE_IDS } from '../domain/features.ts';
import type { Rule } from '../domain/types.ts';

export interface KnowledgeNode {
  id: string; parent: string | null; title: string; kind: 'group' | 'decision' | 'norm';
  any_features?: string[]; rule_ids?: string[]; content?: string; sources?: string[];
  attributes?: Record<string,Array<string | number | boolean>>;
}
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export class KnowledgeTree {
  readonly hash: string;
  readonly nodes: readonly KnowledgeNode[];
  readonly leaves: readonly KnowledgeNode[];
  constructor(raw: { version: number; nodes: KnowledgeNode[] }, rules: readonly Rule[], root: string) {
    if (raw.version !== 1 || !Array.isArray(raw.nodes) || !raw.nodes.length) throw new Error('Invalid knowledge tree');
    const ids = new Set<string>();
    for (const n of raw.nodes) {
      if (!n.id || ids.has(n.id) || !n.title || !['group','decision','norm'].includes(n.kind)) throw new Error('Invalid/duplicate knowledge node');
      ids.add(n.id);
    }
    const byId = new Map(raw.nodes.map(n => [n.id,n]));
    if (raw.nodes.filter(n => n.parent === null).length !== 1) throw new Error('Tree requires exactly one root');
    const ruleIds = new Set(rules.map(r => r.id));
    const sourceHashes: Record<string,string> = {};
    for (const n of raw.nodes) {
      const seen = new Set([n.id]);
      for (let id = n.parent; id !== null;) {
        const parent = byId.get(id);
        if (!parent || seen.has(id)) throw new Error('Dangling/cyclic knowledge parent');
        seen.add(id); id = parent.parent;
      }
      const children = raw.nodes.filter(c => c.parent === n.id);
      if (n.kind === 'group') { if (!children.length) throw new Error('Empty knowledge group'); continue; }
      if (children.length || !n.content?.trim() || !n.any_features?.length || !n.sources?.length || !Array.isArray(n.rule_ids)) throw new Error('Incomplete knowledge leaf');
      if (n.any_features.some(f => !FEATURE_IDS.includes(f))) throw new Error('Unknown knowledge feature');
      if (n.rule_ids.some(r => !ruleIds.has(r))) throw new Error('Unknown linked rule');
      if(n.attributes&&Object.values(n.attributes).some(v=>!Array.isArray(v)||!v.length))throw new Error('Invalid leaf attribute conditions');
      for (const source of n.sources) {
        if (!['java-thread-pool-summary.md','java-thread-pool-best-practices.md'].includes(source) || !existsSync(resolve(root,source))) throw new Error('Unknown knowledge source');
        sourceHashes[source] = digest(readFileSync(resolve(root,source),'utf8'));
      }
    }
    this.nodes = raw.nodes;
    this.leaves = raw.nodes.filter(n => n.kind !== 'group');
    // Changes to source documents or checker-linked knowledge also invalidate persisted tags.
    this.hash = digest(JSON.stringify({ raw, sourceHashes, rules }));
  }
  leaf(id: string): KnowledgeNode {
    const leaf = this.leaves.find(n => n.id === id);
    if (!leaf) throw new Error(`Unknown/non-leaf knowledge ID: ${id}`);
    return leaf;
  }
  path(id: string): string[] {
    const path: string[] = [];
    let node = this.nodes.find(n => n.id === id);
    if (!node) throw new Error(`Unknown knowledge ID: ${id}`);
    while (node) { path.unshift(node.title); node = this.nodes.find(n => n.id === node!.parent); }
    return path;
  }
  static load(root: string, rules: readonly Rule[]): KnowledgeTree {
    return new KnowledgeTree(JSON.parse(readFileSync(resolve(root,'knowledge-tree/thread-pool.json'),'utf8')), rules, root);
  }
}
