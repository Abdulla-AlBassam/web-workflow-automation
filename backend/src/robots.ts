// robots.txt, read and reported, never enforced: a low-volume tool run by
// hand is the operator's call, but a disallow they never saw is not a call
// they made. Used on the acceptance run (the URLs a script actually
// contacted) and in the brief (the pages the operator visited), so both the
// operator and the model see it.
import { cleanHeaders } from '../../runner/src/script.js';

const TIMEOUT_MS = 8_000;

type Rule = { allow: boolean; pattern: string };

// The rules that apply to every agent (`User-agent: *`), in the file's order.
function parse(text: string): Rule[] {
  const rules: Rule[] = [];
  let forAll = false;
  let inAgents = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'user-agent') {
      // Consecutive user-agent lines share one group; a rule line ends the list.
      if (!inAgents) forAll = false;
      inAgents = true;
      if (value === '*') forAll = true;
      continue;
    }
    inAgents = false;
    if (!forAll || (key !== 'allow' && key !== 'disallow') || !value) continue;
    rules.push({ allow: key === 'allow', pattern: value });
  }
  return rules;
}

function matches(pattern: string, path: string): boolean {
  const esc = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${esc.endsWith('\\$') ? esc.slice(0, -2) + '$' : esc}`).test(path);
}

// Longest matching rule wins, as the crawlers read it; ties go to Allow.
function disallowedBy(rules: Rule[], path: string): string | undefined {
  let best: Rule | undefined;
  for (const r of rules) {
    if (!matches(r.pattern, path)) continue;
    if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow)) best = r;
  }
  return best && !best.allow ? best.pattern : undefined;
}

// url → the rule that disallows it for all agents; absent when allowed, when
// there is no robots.txt, or when it could not be read.
export async function robotsCheck(urls: string[]): Promise<Map<string, string>> {
  const hits = new Map<string, string>();
  const byOrigin = new Map<string, URL[]>();
  for (const s of urls) {
    let u: URL;
    try { u = new URL(s); } catch { continue; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
    byOrigin.set(u.origin, [...(byOrigin.get(u.origin) ?? []), u]);
  }
  for (const [origin, list] of byOrigin) {
    let rules: Rule[];
    try {
      const res = await fetch(`${origin}/robots.txt`, { headers: cleanHeaders({}), signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok || !/text\/plain/.test(res.headers.get('content-type') ?? 'text/plain')) continue;
      rules = parse((await res.text()).slice(0, 512 * 1024));
    } catch {
      continue;
    }
    for (const u of list) {
      const rule = disallowedBy(rules, u.pathname + u.search);
      if (rule) hits.set(u.href, rule);
    }
  }
  return hits;
}

// One line per host and rule, naming a URL the automation reaches under it.
export function robotsNotes(hits: Map<string, string>): string[] {
  const seen = new Map<string, string>();
  for (const [href, rule] of hits) {
    const key = `${new URL(href).host} ${rule}`;
    if (!seen.has(key)) seen.set(key, `robots.txt on ${new URL(href).host} disallows ${rule} for all agents; this automation fetches ${href.slice(0, 160)}. It ran anyway: the site's terms are yours to check.`);
  }
  return [...seen.values()];
}
