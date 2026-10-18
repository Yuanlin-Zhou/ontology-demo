/** Dev tool: prints the semantic feature catalog size (consistency check). */
import { FEATURE_CATALOG } from '../src/domain/features.ts';

console.log(`features=${FEATURE_CATALOG.length}`);
console.log(FEATURE_CATALOG.map((feature) => feature.id).join('\n'));
