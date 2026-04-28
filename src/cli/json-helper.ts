/**
 * `aweek json` — minimal JSON parsing primitives for the skill markdown
 * that pre-existed as a `jq` dependency. Exposing these as a built-in
 * subcommand lets us drop `jq` from the install prereqs while keeping
 * the `skills/init/SKILL.md` bash readable.
 *
 * Three operations cover every prior `jq` invocation:
 *
 *   - `aweek json get <path>` — read JSON from stdin and emit the field
 *     at <path>. Scalars print raw; objects/arrays print as JSON.
 *     Replaces `jq -r '.field' <<<"$X"` (scalars) and
 *     `jq '.field' <<<"$X"` (objects).
 *
 *   - `aweek json wrap <key>` — read JSON from stdin and emit
 *     `{ <key>: stdin }`. Replaces `jq -n --argjson k "$X" '{k: $k}'`.
 *
 *   - `aweek json compose key=value...` — build a JSON object from
 *     shell-style `key=value` pairs. Each value is `JSON.parse`d, falling
 *     back to plain string if that throws. Replaces multi-arg
 *     `jq -n --arg / --argjson` compositions.
 */

export function getAtPath(json: string, path: string): string {
  const obj: unknown = JSON.parse(json);
  const parts = path.split('.').filter(Boolean);
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return '';
    cur = (cur as Record<string, unknown>)[p];
  }
  if (cur === undefined || cur === null) return '';
  if (typeof cur === 'string') return cur;
  if (typeof cur === 'number' || typeof cur === 'boolean') return String(cur);
  return JSON.stringify(cur);
}

export function wrapUnderKey(json: string, key: string): string {
  const value: unknown = JSON.parse(json);
  return JSON.stringify({ [key]: value });
}

export function composeKeyValues(args: string[]): string {
  const out: Record<string, unknown> = {};
  for (const arg of args) {
    const idx = arg.indexOf('=');
    if (idx < 0) {
      throw Object.assign(
        new Error(
          `aweek json compose: bad arg "${arg}", expected key=value`,
        ),
        { code: 'EUSAGE' },
      );
    }
    const key = arg.slice(0, idx);
    const valStr = arg.slice(idx + 1);
    try {
      out[key] = JSON.parse(valStr);
    } catch {
      out[key] = valStr;
    }
  }
  return JSON.stringify(out);
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      resolve(data);
    });
    process.stdin.on('error', reject);
  });
}

const HELP = `Usage:
  aweek json get <path>           Read JSON from stdin; emit field at <path>.
                                  Scalars print raw, objects print as JSON.
  aweek json wrap <key>           Read JSON from stdin; emit { <key>: stdin }.
  aweek json compose key=value... Build a JSON object from key=value pairs.
                                  Each value is JSON-parsed (falling back
                                  to plain string).
`.trim();

export async function runJsonCli(args: string[]): Promise<void> {
  const op = args[0];
  switch (op) {
    case 'get': {
      const path = args[1];
      if (!path) {
        throw Object.assign(
          new Error('aweek json get <path>: path is required'),
          { code: 'EUSAGE' },
        );
      }
      const stdin = await readStdin();
      if (!stdin.trim()) {
        throw Object.assign(
          new Error('aweek json get: empty stdin'),
          { code: 'EUSAGE' },
        );
      }
      process.stdout.write(getAtPath(stdin, path));
      process.stdout.write('\n');
      return;
    }
    case 'wrap': {
      const key = args[1];
      if (!key) {
        throw Object.assign(
          new Error('aweek json wrap <key>: key is required'),
          { code: 'EUSAGE' },
        );
      }
      const stdin = await readStdin();
      if (!stdin.trim()) {
        throw Object.assign(
          new Error('aweek json wrap: empty stdin'),
          { code: 'EUSAGE' },
        );
      }
      process.stdout.write(wrapUnderKey(stdin, key));
      process.stdout.write('\n');
      return;
    }
    case 'compose': {
      process.stdout.write(composeKeyValues(args.slice(1)));
      process.stdout.write('\n');
      return;
    }
    case '--help':
    case '-h':
    case undefined: {
      console.log(HELP);
      return;
    }
    default:
      throw Object.assign(
        new Error(`aweek json: unknown operation "${op}"`),
        { code: 'EUSAGE' },
      );
  }
}
