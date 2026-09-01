import { readFileSync } from 'node:fs';
import { run } from './run.js';
import { readBearerViaBrowser } from './browser-token.js';

// Usage: tsx runner/src/cli.ts <spec.json> key=value [key=value ...]
const [specPath, ...pairs] = process.argv.slice(2);
if (!specPath) {
  console.error('usage: cli <spec.json> param=value ...');
  process.exit(2);
}

const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const params = Object.fromEntries(pairs.map((p) => {
  const i = p.indexOf('=');
  return [p.slice(0, i), p.slice(i + 1)];
}));

console.log(`running "${spec.name}" with ${JSON.stringify(params)}\n`);
const result = await run(spec, params, { readToken: readBearerViaBrowser });

for (const s of result.steps) console.log(`  ✓ ${s.id} (${s.type}): ${s.detail}`);
console.log();
if (result.ok) {
  console.log('OUTCOME OK —', result.outcome?.expected);
  for (const [k, v] of Object.entries(result.extracted ?? {})) {
    const summary = v && typeof v === 'object' && 'count' in (v as any) ? `${(v as any).count} records` : JSON.stringify(v);
    console.log(`  ${k}: ${summary}`);
  }
} else {
  console.log('STOPPED —', result.stoppedReason);
}
process.exit(result.ok ? 0 : 1);
