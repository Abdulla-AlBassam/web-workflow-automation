// Verify a candidate script for a session from the shell: the path for an
// agent (Claude Code, Codex) working in this repository, which reads BRIEF.md
// in the session folder, writes automation.candidate.mjs beside it and runs
// this until PASS. Same acceptance as the import route and the API loop.
// Exit 0 PASS, 1 REJECTED, 2 usage or a session that cannot be worked on.
//
//   npm run verify -- <session> [answer-file] [--save]
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { checkCandidate, loadEvidence, parseCandidate, saveCandidate } from './candidate.js';
import { appendLog, sessionDir } from './store.js';
import { readBearerViaBrowser } from '../../runner/src/browser-token.js';

const args = process.argv.slice(2);
const save = args.includes('--save');
const [id, file] = args.filter((a) => a !== '--save');
if (!id) {
  console.error('usage: npm run verify -- <session> [answer-file] [--save]\n  answer-file: the model\'s whole reply (.md/.txt), its JSON block (.json), or a script (.mjs/.js) with an optional candidate.json {title, summary, parameters, fixed} beside it.\n  Default: automation.candidate.mjs in the session folder.');
  process.exit(2);
}
const loaded = loadEvidence(id);
if ('error' in loaded) { console.error(loaded.error); process.exit(2); }
const path = file ? resolve(file) : join(sessionDir(id), 'automation.candidate.mjs');
if (!existsSync(path)) { console.error(`no candidate at ${path}`); process.exit(2); }
const text = readFileSync(path, 'utf8');
const sidecar = join(dirname(path), 'candidate.json');
const candidate = /\.(mjs|js)$/.test(path) && existsSync(sidecar)
  ? parseCandidate(JSON.stringify({ ...JSON.parse(readFileSync(sidecar, 'utf8')), source: text }), loaded)
  : parseCandidate(text, loaded);
if ('error' in candidate) { console.log(`REJECTED: ${candidate.error}`); process.exit(1); }

console.log(`verifying ${path} against session "${id}" with ${candidate.parameters.map((p) => `${p.name}="${p.example}"`).join(', ') || 'no parameters'}`);
const v = await checkCandidate(candidate, loaded, readBearerViaBrowser);
if (!v.ok) { console.log(`REJECTED: ${v.reason}`); process.exit(1); }
console.log(`PASS — ${v.note}; ${v.run.rows.length} row(s); columns ${v.columns.join(', ')}; hosts ${v.run.hosts.join(', ') || 'none'}; ${(v.run.ms / 1000).toFixed(1)}s`);
console.log(`first row: ${JSON.stringify(v.run.rows[0]).slice(0, 600)}`);
for (const r of v.robots) console.log(`note: ${r}`);
if (save) {
  saveCandidate(loaded, candidate, v.run, { model: 'external', mode: 'import' }, v.robots);
  appendLog(id, { kind: 'saved', text: `Automation saved from the command line${candidate.title ? ` as "${candidate.title}"` : ''} — ${v.note}; ${v.run.rows.length} row(s) with columns ${v.columns.join(', ')}; parameters ${candidate.parameters.map((p) => p.name).join(', ') || 'none'}; hosts ${v.run.hosts.join(', ') || 'none'}.`, t: Date.now() });
  console.log(`saved as the session's automation (spec.json and automation.mjs in ${sessionDir(id)})`);
} else {
  console.log('add --save to make it the session\'s automation');
}
process.exit(0);
