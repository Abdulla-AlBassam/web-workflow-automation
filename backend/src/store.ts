import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Meta = {
  session: string;
  name?: string;
  // What the operator asked Maximum Effort Mode for, kept with the session.
  goal?: string;
  // When a brief was last exported for an external model.
  briefAt?: number;
  hosts: string[];
  startedAt: number;
  stoppedAt?: number;
  lastEventAt?: number;
  count: number;
  dropped: number;
};

const DATA_DIR = process.env.DATA_DIR ?? join(import.meta.dirname, '../data');

const dir = (session: string) => join(DATA_DIR, session);
const metaPath = (session: string) => join(dir(session), 'meta.json');
const eventsPath = (session: string) => join(dir(session), 'events.jsonl');
const specPath = (session: string) => join(dir(session), 'spec.json');

export function sessionDir(session: string): string {
  return dir(session);
}

// Session scripts (runner/src/script.ts) live beside the spec that names them.
export const SCRIPT_FILE = 'automation.mjs';

// The brief for an external model, written beside the recording it describes
// so an agent pointed at the folder finds the prompt and the evidence together.
export const BRIEF_FILE = 'BRIEF.md';

export function saveBrief(session: string, markdown: string) {
  writeFileSync(join(dir(session), BRIEF_FILE), markdown);
}

export function saveScript(session: string, file: string, source: string) {
  writeFileSync(join(dir(session), file), source);
}

export function getScript(session: string, file: string): string | undefined {
  const p = join(dir(session), file);
  return existsSync(p) ? readFileSync(p, 'utf8') : undefined;
}

export function deleteScript(session: string, file: string) {
  const p = join(dir(session), file);
  if (existsSync(p)) unlinkSync(p);
}

export function saveSpec(session: string, spec: unknown) {
  writeFileSync(specPath(session), JSON.stringify(spec, null, 2));
}

export function getSpec(session: string): unknown | undefined {
  if (!existsSync(specPath(session))) return undefined;
  return JSON.parse(readFileSync(specPath(session), 'utf8'));
}

export function createSession(session: string, hosts: string[], startedAt: number): boolean {
  if (existsSync(dir(session))) return false;
  mkdirSync(dir(session), { recursive: true });
  const meta: Meta = { session, hosts, startedAt, count: 0, dropped: 0 };
  writeFileSync(metaPath(session), JSON.stringify(meta, null, 2));
  return true;
}

export function getMeta(session: string): Meta | undefined {
  if (!existsSync(metaPath(session))) return undefined;
  return JSON.parse(readFileSync(metaPath(session), 'utf8'));
}

export function saveMeta(meta: Meta) {
  writeFileSync(metaPath(meta.session), JSON.stringify(meta, null, 2));
}

export function appendEvents(session: string, items: object[]) {
  const lines = items.map((e) => JSON.stringify(e)).join('\n') + '\n';
  appendFileSync(eventsPath(session), lines);
}

export function readEvents(session: string): Record<string, unknown>[] {
  if (!existsSync(eventsPath(session))) return [];
  return readFileSync(eventsPath(session), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// Maximum Effort Mode's conversation with the operator, one line per entry,
// so the session page can show it again after a reload.
export const EFFORT_LOG = 'effort.jsonl';

export function appendLog(session: string, entry: object) {
  appendFileSync(join(dir(session), EFFORT_LOG), JSON.stringify(entry) + '\n');
}

export function readLog(session: string): Record<string, unknown>[] {
  const p = join(dir(session), EFFORT_LOG);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

export function listSessions(): Meta[] {
  if (!existsSync(DATA_DIR)) return [];
  return readdirSync(DATA_DIR)
    .map(getMeta)
    .filter((m): m is Meta => m !== undefined)
    .sort((a, b) => b.startedAt - a.startedAt);
}

export function status(meta: Meta): 'complete' | 'recording' | 'interrupted' {
  if (meta.stoppedAt) return 'complete';
  const last = meta.lastEventAt ?? meta.startedAt;
  return Date.now() - last < 60_000 ? 'recording' : 'interrupted';
}
