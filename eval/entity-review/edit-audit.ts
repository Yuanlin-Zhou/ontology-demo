/** Descriptive rule-category changes. Never turns policy conflicts into automatic passes. */
import { RuleEngine } from '../../src/api/engine.ts';
import { digest } from '../../src/knowledge/tree.ts';

export function auditEditCategories(before:string,after:string,rejectionContract:'propagate'|'preserve') {
  if(!['propagate','preserve'].includes(rejectionContract))throw new Error('Explicit rejection contract required');
  const engine=RuleEngine.load(),initial=engine.validate({code:before}),modified=engine.validate({code:after});
  const counts=(values:typeof initial.violations)=>Object.fromEntries([...new Set(values.map(v=>v.rule_id))].map(id=>[id,values.filter(v=>v.rule_id===id).length]));
  const a=counts(initial.violations),b=counts(modified.violations);
  return {model_requests:0,input_hash:digest(before),output_hash:digest(after),initial,modified,
    disappeared_rule_categories:Object.keys(a).filter(id=>!b[id]),new_rule_categories:Object.keys(b).filter(id=>!a[id]),
    shared_rule_categories:Object.keys(a).filter(id=>b[id]),initial_counts:a,modified_counts:b,
    policy_flags:modified.violations.filter(v=>v.rule_id==='TP-REJECT-003').map(v=>({rule_id:v.rule_id,line:v.line,
      disposition:'requires_policy_review',reason:rejectionContract==='propagate'?'Task requires caller-visible rejection; no local catch alone does not establish task failure. Local catch/log/rethrow can satisfy both policies.':'Task preserves existing submission policy; compare source before attributing a new defect.'})),
    introduced_defect_count:null,full_task_completion_rate:null,
    note:'Rule-category appearance/disappearance is not exact defect attribution. Same counts can hide a fixed and a newly introduced instance. Raw findings are retained; compiler/behavior/domain review remain separate.'};
}
