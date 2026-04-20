/**
 * Tests for `src/serve/errors.js` — friendly error surface for `aweek serve`.
 *
 * AC 8 scope: when the user runs `aweek serve` without a `.aweek/` folder
 * present, we should produce a friendly, actionable multi-line message
 * instead of a raw stack trace. These tests pin down:
 *
 *   1. The thrown Error carries the `ENOAWEEKDIR` code + both the missing
 *      `dataDir` and its parent `projectDir`.
 *   2. The friendly formatter includes the resolved `.aweek/` path and a
 *      next-step hint (init / --project-dir) regardless of which input
 *      shape the caller passes.
 *   3. The predicate accepts only the real error shape — not random
 *      `Error` instances or `null`.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { startServer } from './server.js';

import {
  MISSING_AWEEK_DIR_CODE,
  buildNoAweekDirErrorMessage,
  createNoAweekDirError,
  formatNoAweekDirMessage,
  isNoAweekDirError,
} from './errors.js';

describe('MISSING_AWEEK_DIR_CODE', () => {
  it('is the stable string CLIs and tests branch on', () => {
    assert.equal(MISSING_AWEEK_DIR_CODE, 'ENOAWEEKDIR');
  });
});

describe('buildNoAweekDirErrorMessage()', () => {
  it('produces a single-line message that names the missing path', () => {
    const msg = buildNoAweekDirErrorMessage('/tmp/demo/.aweek');
    assert.ok(!msg.includes('\n'), 'Error.message should stay single-line');
    assert.match(msg, /\/tmp\/demo\/\.aweek/);
    assert.match(msg, /aweek init/);
    assert.match(msg, /--project-dir/);
  });
});

describe('createNoAweekDirError()', () => {
  it('returns an Error tagged with ENOAWEEKDIR and the offending paths', () => {
    const err = createNoAweekDirError('/tmp/demo/.aweek');
    assert.ok(err instanceof Error);
    assert.equal(err.code, MISSING_AWEEK_DIR_CODE);
    assert.equal(err.dataDir, '/tmp/demo/.aweek');
    assert.equal(err.projectDir, resolve('/tmp/demo/.aweek', '..'));
    assert.match(err.message, /\/tmp\/demo\/\.aweek/);
  });
});

describe('formatNoAweekDirMessage()', () => {
  it('emits a friendly multi-line block with the next-step hints', () => {
    const out = formatNoAweekDirMessage({ dataDir: '/tmp/demo/.aweek' });
    const lines = out.split('\n');

    // Headline first so the user sees the problem before the path.
    assert.equal(lines[0], 'No .aweek/ folder found.');

    // The resolved path must appear, indented as a block quote.
    assert.ok(out.includes('/tmp/demo/.aweek'), 'includes the missing path');
    assert.ok(out.includes('  /tmp/demo/.aweek'), 'indents the path for scannability');

    // All three remediation paths should be surfaced.
    assert.match(out, /aweek init/);
    assert.match(out, /--project-dir/);
    assert.match(out, /\/aweek:init/);

    // Block should be multi-line (> 3 lines) but not trailing-newline padded.
    assert.ok(lines.length > 3, 'is multi-line');
    assert.notEqual(out.at(-1), '\n', 'no trailing newline — the CLI decides');
  });

  it('accepts projectDir instead of dataDir and derives the .aweek/ path', () => {
    const out = formatNoAweekDirMessage({ projectDir: '/tmp/demo' });
    // The derived path is /tmp/demo/.aweek regardless of separator conventions.
    assert.ok(
      out.includes(resolve('/tmp/demo', '.aweek')),
      'derives .aweek/ from projectDir',
    );
  });

  it('falls back to process.cwd() when neither dataDir nor projectDir is given', () => {
    const out = formatNoAweekDirMessage({});
    assert.ok(out.includes(resolve(process.cwd(), '.aweek')));
  });

  it('returns a friendly message even when called with no arguments', () => {
    const out = formatNoAweekDirMessage();
    assert.ok(out.startsWith('No .aweek/ folder found.'));
    assert.ok(out.includes(resolve(process.cwd(), '.aweek')));
  });
});

describe('isNoAweekDirError()', () => {
  it('recognises the error shape produced by createNoAweekDirError()', () => {
    const err = createNoAweekDirError('/tmp/demo/.aweek');
    assert.equal(isNoAweekDirError(err), true);
  });

  it('rejects unrelated errors and falsy values', () => {
    assert.equal(isNoAweekDirError(new Error('boom')), false);
    assert.equal(isNoAweekDirError(null), false);
    assert.equal(isNoAweekDirError(undefined), false);
    assert.equal(isNoAweekDirError({ code: 'EADDRINUSE' }), false);
    assert.equal(isNoAweekDirError('ENOAWEEKDIR'), false);
  });

  it('accepts plain error-shaped objects with the right code', () => {
    // Important so callers that re-serialise the error across a process
    // boundary (e.g. JSON-stringified + parsed) still get matched.
    assert.equal(
      isNoAweekDirError({ code: MISSING_AWEEK_DIR_CODE, message: 'x' }),
      true,
    );
  });
});

// ── HTTP routing error cases (new sidebar + tabs layout) ─────────────────────
//
// These integration tests spin up a real server against an empty `.aweek/`
// directory and verify the routing behaviour introduced by the sidebar +
// per-agent tab refactor:
//
//   1. Unknown agent on the JSON API endpoint  → 404 JSON body
//   2. Unknown agent on the HTML shell route   → 200 (renders gracefully)
//   3. Invalid tab query param                 → 200 (falls back to calendar)
//   4. Paths that were never grid-layout
//      endpoints (old-style routes that some
//      clients might still request)            → 404 plain-text
//   5. Non-GET verb on a routed path           → 405
//
// The server is started once per describe block (port 0 so the OS picks a
// free ephemeral port) and closed in `after`.

/** Minimal HTTP GET helper — avoids pulling in undici / node-fetch. */
function httpGet(url, { method = 'GET' } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const parsed = new URL(url);
    import('node:http').then(({ request }) => {
      const r = request(
        {
          method,
          hostname: parsed.hostname,
          port: Number(parsed.port),
          path: parsed.pathname + parsed.search,
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            resolvePromise({
              statusCode: res.statusCode,
              headers: res.headers,
              body: Buffer.concat(chunks).toString('utf-8'),
            });
          });
        },
      );
      r.on('error', rejectPromise);
      r.end();
    }, rejectPromise);
  });
}

describe('HTTP routing — 404 on unknown agent (JSON API endpoint)', () => {
  let handle;
  let base;
  let projectDir;

  before(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'aweek-errors-test-'));
    await mkdir(join(projectDir, '.aweek'), { recursive: true });
    handle = await startServer({ projectDir, port: 0, open: false });
    // Port 0 → OS-assigned port; formatDashboardUrl maps 0.0.0.0 → localhost.
    base = handle.url.replace(/\/$/, '');
  });

  after(async () => {
    await handle.close();
    await rm(projectDir, { recursive: true, force: true });
  });

  it('returns 404 JSON for an unknown agent slug', async () => {
    const res = await httpGet(`${base}/api/agents/no-such-agent/calendar`);
    assert.equal(res.statusCode, 404);
    assert.match(res.headers['content-type'], /application\/json/);
    const body = JSON.parse(res.body);
    assert.equal(body.error, 'Agent not found');
    assert.equal(body.agentId, 'no-such-agent');
  });

  it('includes the unknown agentId verbatim in the JSON error body', async () => {
    const slug = 'oh-my-claudecode-writer';
    const res = await httpGet(`${base}/api/agents/${encodeURIComponent(slug)}/calendar`);
    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.body);
    assert.equal(body.agentId, slug, 'URL-decoded slug is echoed back');
  });

  it('sets Cache-Control: no-store on the 404 JSON response', async () => {
    const res = await httpGet(`${base}/api/agents/ghost/calendar`);
    assert.equal(res.statusCode, 404);
    assert.equal(res.headers['cache-control'], 'no-store');
  });
});

describe('HTTP routing — unknown agent on HTML shell route renders gracefully (200)', () => {
  let handle;
  let base;
  let projectDir;

  before(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'aweek-errors-test-'));
    await mkdir(join(projectDir, '.aweek'), { recursive: true });
    handle = await startServer({ projectDir, port: 0, open: false });
    base = handle.url.replace(/\/$/, '');
  });

  after(async () => {
    await handle.close();
    await rm(projectDir, { recursive: true, force: true });
  });

  it('GET /?agent=unknown returns 200 — unknown slug renders as empty state', async () => {
    const res = await httpGet(`${base}/?agent=totally-unknown-agent`);
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    // Should render the zero-agents empty state (no agents in the temp .aweek/).
    assert.match(res.body, /No agents yet|aweek:hire/i);
  });

  it('GET /?agent=unknown does not leak a stack trace or 500 into the body', async () => {
    const res = await httpGet(`${base}/?agent=totally-unknown-agent`);
    assert.equal(res.statusCode, 200);
    assert.doesNotMatch(res.body, /Internal Server Error/);
    assert.doesNotMatch(res.body, /Error:/);
  });
});

describe('HTTP routing — invalid tab query param falls back to calendar (200)', () => {
  let handle;
  let base;
  let projectDir;

  before(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'aweek-errors-test-'));
    await mkdir(join(projectDir, '.aweek'), { recursive: true });
    handle = await startServer({ projectDir, port: 0, open: false });
    base = handle.url.replace(/\/$/, '');
  });

  after(async () => {
    await handle.close();
    await rm(projectDir, { recursive: true, force: true });
  });

  it('GET /?tab=not-a-tab returns 200 — invalid tab silently falls back to calendar', async () => {
    const res = await httpGet(`${base}/?tab=not-a-tab`);
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/html/);
  });

  it('GET /?tab=CALENDAR (wrong case) returns 200 — tab matching is case-sensitive, falls back', async () => {
    // `resolveActiveTab` does an exact string match; 'CALENDAR' !== 'calendar'.
    const res = await httpGet(`${base}/?tab=CALENDAR`);
    assert.equal(res.statusCode, 200);
  });

  it('GET /?tab= (empty string) returns 200 — blank tab falls back to calendar', async () => {
    const res = await httpGet(`${base}/?tab=`);
    assert.equal(res.statusCode, 200);
  });
});

describe('HTTP routing — removed / never-existed grid-layout endpoint paths return 404', () => {
  let handle;
  let base;
  let projectDir;

  before(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'aweek-errors-test-'));
    await mkdir(join(projectDir, '.aweek'), { recursive: true });
    handle = await startServer({ projectDir, port: 0, open: false });
    base = handle.url.replace(/\/$/, '');
  });

  after(async () => {
    await handle.close();
    await rm(projectDir, { recursive: true, force: true });
  });

  // In the old 2x2 grid layout all content lived in a single GET / response;
  // no dedicated sub-paths were ever routed. Any client (browser bookmark,
  // cURL one-liner, integration test) that tries a sub-path must get a clean
  // 404 rather than accidentally landing on / or silently succeeding.
  const removedPaths = [
    '/agents',
    '/calendar',
    '/budget',
    '/plan',
    '/activity',
    '/strategy',
    '/profile',
    '/api/agents',
    '/api',
  ];

  for (const path of removedPaths) {
    it(`GET ${path} returns 404`, async () => {
      const res = await httpGet(`${base}${path}`);
      assert.equal(res.statusCode, 404, `expected 404 for ${path}`);
      assert.match(res.headers['content-type'], /text\/plain/);
    });
  }
});

describe('HTTP routing — method not allowed on dashboard routes', () => {
  let handle;
  let base;
  let projectDir;

  before(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'aweek-errors-test-'));
    await mkdir(join(projectDir, '.aweek'), { recursive: true });
    handle = await startServer({ projectDir, port: 0, open: false });
    base = handle.url.replace(/\/$/, '');
  });

  after(async () => {
    await handle.close();
    await rm(projectDir, { recursive: true, force: true });
  });

  it('POST / returns 405 Method Not Allowed', async () => {
    const res = await httpGet(`${base}/`, { method: 'POST' });
    assert.equal(res.statusCode, 405);
    assert.equal(res.headers['allow'], 'GET, HEAD');
  });

  it('POST /api/agents/any/calendar returns 405', async () => {
    const res = await httpGet(`${base}/api/agents/any/calendar`, { method: 'POST' });
    assert.equal(res.statusCode, 405);
  });

  it('DELETE /healthz returns 405', async () => {
    const res = await httpGet(`${base}/healthz`, { method: 'DELETE' });
    assert.equal(res.statusCode, 405);
  });
});
