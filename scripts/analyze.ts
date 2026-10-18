/**
 * Dev tool: prints the structured model and the semantic features of a Java file.
 *
 *   node scripts/analyze.ts samples/bad/OrderAsyncService.java [--model]
 */
import { analyzeJavaFile } from '../src/analyzer/model-builder.ts';
import { detectFeatures, featureIdsOf } from '../src/analyzer/feature-detector.ts';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/analyze.ts <file.java> [--model]');
  process.exit(1);
}

const { model } = analyzeJavaFile(file);
const hits = detectFeatures(model);

console.log(`file: ${model.filePath}`);
console.log(`classes: ${model.classNames.join(', ') || '-'} | parse errors: ${model.parseErrors.length}`);
console.log(
  `pools=${model.pools.length} executors=${model.executors.length} submits=${model.submits.length} shutdowns=${model.shutdowns.length} ` +
    `futureGets=${model.futureGets.length} asyncs=${model.asyncs.length} threadLocals=${model.threadLocals.length} monitors=${model.monitors.length} ` +
    `customImpls=${model.customImpls.length} interruptCatches=${model.interruptCatches.length}`,
);

if (process.argv.includes('--model')) {
  console.log(JSON.stringify(model, (key, value) => (key === 'node' ? undefined : value), 2));
}

console.log('\nfeatures:');
for (const id of featureIdsOf(hits)) {
  const list = hits.filter((item) => item.feature === id);
  console.log(`  ${id}  x${list.length}`);
  for (const item of list.slice(0, 4)) {
    console.log(`      L${item.startLine}:${item.startColumn} [${item.confidence}] ${JSON.stringify(item.attributes)} :: ${item.snippet}`);
  }
}
