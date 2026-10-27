import { strict as assert } from 'node:assert';
import { it } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readTaskReview, sha256, TASK_CRITERIA, type TaskReview } from '../eval/acceptance.ts';

it('keeps reviewed-but-unverifiable criteria unconfirmed and preserves definite failures', () => {
  const dir=mkdtempSync(join(tmpdir(),'task-review-evidence-'));
  try {
    const file=join(dir,'review.json'),source='class A {}';
    const review:TaskReview={source_sha256:sha256(source),reviewer:'Agent source review',criteria:TASK_CRITERIA['CASE-001']!.map(criterion=>({criterion,passed:true,evidence:'Concrete source and assertion evidence'}))};
    review.criteria[0]={criterion:TASK_CRITERIA['CASE-001']![0]!,passed:null,verdict:'unverifiable',evidence:'sendRemote body has no observable effect; dispatch alone does not prove delivery'};
    const check=()=>{writeFileSync(file,JSON.stringify(review));return readTaskReview(file,source,'CASE-001');};
    assert.equal(check().status,'not_run');assert.match(check().detail,/Reviewed by.*evidence insufficient/);
    review.criteria[1]!.passed=false;review.criteria[1]!.evidence='Task exceptions escape into caller';
    assert.equal(check().status,'failed');assert.match(check().detail,/exceptions escape/);
    review.criteria[1]!.passed=true;
    delete review.criteria[0]!.verdict;
    assert.match(check().detail,/Invalid, incomplete or stale/);
    review.criteria[0]!.verdict='unverifiable';review.criteria[0]!.evidence='';
    assert.match(check().detail,/Invalid, incomplete or stale/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
