// The project's .env, as the shell would read the simple form: KEY=value per
// line, blanks and comment lines skipped, everything after the first `=` kept.
// Quotes around a value are the file's syntax, not part of the secret: an
// unstripped quote turns an API key into a key with a quote in it, and the
// only symptom is a 401.
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    const value = m[2].trim();
    const quoted = value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0];
    out[m[1]] = quoted ? value.slice(1, -1) : value;
  }
  return out;
}
