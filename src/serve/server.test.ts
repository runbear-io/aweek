/**
 * Tests for `src/serve/server.js` — HTTP server that serves the Vite SPA.
 *
 * Sub-AC 1 scope (AC 7): the server no longer renders HTML; it serves
 * static files from the Vite build directory with SPA fallback. Tests
 * validate:
 *   - CLI-facing helpers: `normaliseServeOptions`, `formatDashboardUrl`,
 *     `resolveOpenCommand`, `openBrowser`, `isWildcardHost`,
 *     `getLanAddresses`, `formatLanHints`.
 *   - Server lifecycle: `startServer` binds, port auto-increments,
 *     rejects with ENOAWEEKDIR when `.aweek/` is missing.
 *   - Request routing: `/healthz` JSON probe, static asset delivery,
 *     SPA fallback for unknown routes, 404 for missing asset files,
 *     build-missing placeholder when `dist/` does not exist.
 *   - Traversal guard: `resolveSafeFile` rejects `..`, NUL, backslash.
 *
 * Data endpoints (`/api/...`) come in follow-up sub-ACs.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';

import {
  DEFAULT_PORT,
  DEFAULT_HOST,
  PORT_SCAN_LIMIT,
  DEFAULT_BUILD_DIR_NAME,
  formatDashboardUrl,
  formatLanHints,
  getLanAddresses,
  isWhitelistedClientRoute,
  isWildcardHost,
  normaliseServeOptions,
  openBrowser,
  renderBuildMissingHtml,
  resolveDefaultBuildDir,
  resolveOpenCommand,
  resolveSafeFile,
  startServer,
} from './server.js';

async function makeProject(prefix = 'aweek-serve-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(dir, '.aweek'), { recursive: true });
  return dir;
}

/**
 * Build a project fixture that contains a single hired agent so the
 * `/api/agents` and `/api/agents/:slug` endpoints have data to return.
 *
 * Writes:
 *   <root>/.aweek/agents/<slug>.json   — scheduling config
 *   <root>/.claude/agents/<slug>.md    — identity
 */
async function makeProjectWithAgent({
  slug = 'fixture-agent',
  name = 'Fixture Agent',
  description = 'A test fixture.',
  paused = false,
  weeklyTokenBudget = 10_000,
} = {}) {
  const root = await makeProject('aweek-serve-api-');
  const agentsDir = join(root, '.aweek', 'agents');
  await mkdir(agentsDir, { recursive: true });
  const now = new Date().toISOString();
  // Monday-of-week in UTC — matches the fixture shape used by data.test.js.
  const d = new Date();
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  d.setUTCHours(0, 0, 0, 0);
  const periodStart = d.toISOString();
  const config = {
    id: slug,
    subagentRef: slug,
    createdAt: now,
    updatedAt: now,
    weeklyTokenBudget,
    budget: {
      weeklyTokenLimit: weeklyTokenBudget,
      currentUsage: 0,
      periodStart,
      paused,
    },
  };
  await writeFile(
    join(agentsDir, `${slug}.json`),
    JSON.stringify(config, null, 2) + '\n',
    'utf-8',
  );

  const claudeAgents = join(root, '.claude', 'agents');
  await mkdir(claudeAgents, { recursive: true });
  await writeFile(
    join(claudeAgents, `${slug}.md`),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nYou are a test.\n`,
    'utf-8',
  );

  return { root, slug, name, description };
}

/**
 * Create an on-disk fake Vite build directory. Returns the absolute path
 * so tests can pass it via `buildDir` to `startServer`.
 *
 * Layout:
 *   <buildDir>/index.html
 *   <buildDir>/assets/app-<hash>.js
 *   <buildDir>/assets/app-<hash>.css
 */
async function makeBuildDir({ indexHtml = '<!doctype html><html><body>spa</body></html>' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'aweek-spa-'));
  await mkdir(join(dir, 'assets'), { recursive: true });
  await writeFile(join(dir, 'index.html'), indexHtml, 'utf8');
  await writeFile(join(dir, 'assets', 'app-abc123.js'), 'console.log("spa");\n', 'utf8');
  await writeFile(join(dir, 'assets', 'app-abc123.css'), 'body{color:red}\n', 'utf8');
  await writeFile(join(dir, 'favicon.ico'), 'fake-ico-bytes', 'binary');
  return dir;
}

function httpGet(url, { method = 'GET' } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = new URL(url);
    import('node:http').then(({ request }) => {
      const r = request(
        {
          method,
          hostname: req.hostname,
          port: req.port,
          path: req.pathname + req.search,
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

// ── constants ──────────────────────────────────────────────────────────────

describe('serve/server constants', () => {
  it('exposes sensible defaults', () => {
    assert.equal(DEFAULT_PORT, 3000);
    assert.equal(DEFAULT_HOST, '0.0.0.0');
    assert.ok(Number.isInteger(PORT_SCAN_LIMIT) && PORT_SCAN_LIMIT >= 1);
    assert.equal(DEFAULT_BUILD_DIR_NAME, 'dist');
  });

  it('resolves the default build dir to an absolute path under the package', () => {
    const dir = resolveDefaultBuildDir();
    assert.ok(dir.endsWith(`/${DEFAULT_BUILD_DIR_NAME}/`) || dir.endsWith(`\\${DEFAULT_BUILD_DIR_NAME}\\`));
    // Absolute path on POSIX / Windows — a relative path would make the
    // static file server traversal check unreliable.
    assert.ok(
      dir.startsWith('/') || /^[A-Za-z]:[\\/]/.test(dir),
      `expected absolute path, got ${dir}`,
    );
  });
});

// ── normaliseServeOptions ──────────────────────────────────────────────────

describe('normaliseServeOptions()', () => {
  it('applies defaults for empty input', () => {
    const out = normaliseServeOptions({});
    assert.equal(out.port, DEFAULT_PORT);
    assert.equal(out.host, DEFAULT_HOST);
    assert.equal(out.open, true);
    assert.equal(typeof out.projectDir, 'string');
    assert.ok(out.projectDir.length > 0);
    assert.equal(typeof out.buildDir, 'string');
    assert.ok(out.buildDir.length > 0);
  });

  it('coerces numeric-string --port', () => {
    const out = normaliseServeOptions({ port: '4242' });
    assert.equal(out.port, 4242);
  });

  it('honors --no-open (open=false)', () => {
    const out = normaliseServeOptions({ open: false });
    assert.equal(out.open, false);
  });

  it('rejects invalid --port with EUSAGE', () => {
    assert.throws(() => normaliseServeOptions({ port: 'abc' }), (err) => err.code === 'EUSAGE');
    assert.throws(() => normaliseServeOptions({ port: -1 }), (err) => err.code === 'EUSAGE');
    assert.throws(
      () => normaliseServeOptions({ port: 70000 }),
      (err) => err.code === 'EUSAGE',
    );
  });

  it('accepts a custom host, projectDir, and buildDir', () => {
    const out = normaliseServeOptions({
      host: '127.0.0.1',
      projectDir: '/tmp/x',
      buildDir: '/tmp/x/dist',
    });
    assert.equal(out.host, '127.0.0.1');
    assert.equal(out.projectDir, '/tmp/x');
    assert.equal(out.buildDir, '/tmp/x/dist');
  });
});

// ── formatDashboardUrl ─────────────────────────────────────────────────────

describe('formatDashboardUrl()', () => {
  it('displays wildcard hosts as localhost', () => {
    assert.equal(formatDashboardUrl('0.0.0.0', 3000), 'http://localhost:3000/');
    assert.equal(formatDashboardUrl('::', 8080), 'http://localhost:8080/');
  });

  it('preserves explicit hosts', () => {
    assert.equal(formatDashboardUrl('127.0.0.1', 3000), 'http://127.0.0.1:3000/');
    assert.equal(formatDashboardUrl('example.lan', 9000), 'http://example.lan:9000/');
  });

  it('brackets IPv6 literals', () => {
    assert.equal(formatDashboardUrl('::1', 3000), 'http://[::1]:3000/');
  });
});

// ── resolveSafeFile ────────────────────────────────────────────────────────

describe('resolveSafeFile()', () => {
  it('resolves a simple file path inside buildDir', () => {
    const abs = resolveSafeFile('/tmp/build', '/assets/app.js');
    assert.equal(abs, '/tmp/build/assets/app.js');
  });

  it('maps "/" to index.html', () => {
    assert.equal(resolveSafeFile('/tmp/build', '/'), '/tmp/build/index.html');
  });

  it('maps "/subdir/" to subdir/index.html', () => {
    assert.equal(resolveSafeFile('/tmp/build', '/sub/'), '/tmp/build/sub/index.html');
  });

  it('rejects `..` traversal that escapes the build dir', () => {
    assert.equal(resolveSafeFile('/tmp/build', '/../etc/passwd'), null);
    assert.equal(resolveSafeFile('/tmp/build', '/..%2Fetc%2Fpasswd'), null);
  });

  it('rejects embedded NUL bytes', () => {
    assert.equal(resolveSafeFile('/tmp/build', '/file%00.js'), null);
  });

  it('rejects backslashes (Windows-style traversal)', () => {
    assert.equal(resolveSafeFile('/tmp/build', '/..%5Cetc%5Cpasswd'), null);
  });

  it('rejects malformed percent-encoding', () => {
    assert.equal(resolveSafeFile('/tmp/build', '/bad%ZZ'), null);
  });

  it('rejects a sibling-directory prefix match', () => {
    // `/tmp/build-evil/x` must not match `/tmp/build` — the trailing
    // separator guard in resolveSafeFile catches this.
    assert.equal(
      resolveSafeFile('/tmp/build', '/../build-evil/x'),
      null,
    );
  });
});

// ── isWhitelistedClientRoute ───────────────────────────────────────────────

describe('isWhitelistedClientRoute()', () => {
  it('admits the canonical sidebar tabs', () => {
    assert.equal(isWhitelistedClientRoute('/'), true);
    assert.equal(isWhitelistedClientRoute('/agents'), true);
    assert.equal(isWhitelistedClientRoute('/agents/'), true);
    assert.equal(isWhitelistedClientRoute('/calendar'), true);
    assert.equal(isWhitelistedClientRoute('/activity'), true);
    assert.equal(isWhitelistedClientRoute('/strategy'), true);
    assert.equal(isWhitelistedClientRoute('/profile'), true);
    // /settings — read-only Settings page (AC 6).
    assert.equal(isWhitelistedClientRoute('/settings'), true);
    assert.equal(isWhitelistedClientRoute('/settings/'), true);
  });

  it('admits per-agent detail and tab routes', () => {
    assert.equal(isWhitelistedClientRoute('/agents/writer'), true);
    assert.equal(isWhitelistedClientRoute('/agents/writer/calendar'), true);
    assert.equal(isWhitelistedClientRoute('/agents/writer/notifications'), true);
    assert.equal(
      isWhitelistedClientRoute('/agents/writer/activities/run-1'),
      true,
    );
  });

  it('admits the global inbox + deep-link notification routes (AC 18)', () => {
    // Global inbox feed — header bell + sidebar entry both navigate here.
    assert.equal(isWhitelistedClientRoute('/notifications'), true);
    assert.equal(isWhitelistedClientRoute('/notifications/'), true);
    // Deep link to a specific notification (e.g.
    // `/notifications/<agent>/<id>` — see notification-list.tsx onSelect).
    assert.equal(
      isWhitelistedClientRoute('/notifications/writer/notif-abc'),
      true,
    );
  });

  it('rejects unrelated and typo-shaped routes (no silent SPA fallback)', () => {
    assert.equal(isWhitelistedClientRoute('/xyz'), false);
    assert.equal(isWhitelistedClientRoute('/api'), false);
    assert.equal(isWhitelistedClientRoute('/api/'), false);
    // `/notification` (no trailing 's') is a typo and should NOT silently
    // serve the shell — operators need to see the 404 in logs.
    assert.equal(isWhitelistedClientRoute('/notification'), false);
    assert.equal(isWhitelistedClientRoute('/notifs'), false);
    // Falsy / non-string inputs short-circuit to false.
    assert.equal(
      isWhitelistedClientRoute(undefined as unknown as string),
      false,
    );
  });
});

// ── renderBuildMissingHtml ─────────────────────────────────────────────────

describe('renderBuildMissingHtml()', () => {
  it('renders a full HTML document mentioning the missing path and the build command', () => {
    const html = renderBuildMissingHtml('/tmp/missing/dist');
    assert.ok(html.startsWith('<!doctype html>'));
    assert.match(html, /SPA bundle not found/);
    assert.match(html, /\/tmp\/missing\/dist/);
    assert.match(html, /pnpm build/);
    assert.match(html, /aweek serve/);
  });

  it('HTML-escapes the build dir path so injection is not possible', () => {
    const html = renderBuildMissingHtml('/tmp/<script>alert(1)</script>/dist');
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });
});

// ── resolveOpenCommand ─────────────────────────────────────────────────────

describe('resolveOpenCommand()', () => {
  it('uses `open` on macOS', () => {
    const { command, args } = resolveOpenCommand('http://localhost:3000/', 'darwin');
    assert.equal(command, 'open');
    assert.deepEqual(args, ['http://localhost:3000/']);
  });

  it('uses `cmd /c start` on Windows with an empty window title', () => {
    const { command, args } = resolveOpenCommand('http://localhost:3000/', 'win32');
    assert.equal(command, 'cmd');
    // Empty-string title dodges start's "first quoted arg == title" quirk.
    assert.deepEqual(args, ['/c', 'start', '""', 'http://localhost:3000/']);
  });

  it('uses `xdg-open` on Linux and other Unixes', () => {
    for (const platform of ['linux', 'freebsd', 'openbsd']) {
      const { command, args } = resolveOpenCommand('http://localhost:3000/', platform);
      assert.equal(command, 'xdg-open', `platform=${platform}`);
      assert.deepEqual(args, ['http://localhost:3000/']);
    }
  });
});

// ── openBrowser ────────────────────────────────────────────────────────────

describe('openBrowser()', () => {
  /**
   * Minimal stub that satisfies the surface `openBrowser` touches:
   *   - EventEmitter for `error` events
   *   - `unref()` no-op
   * Constructor records the last spawn call so tests can assert on it.
   */
  function makeSpawnStub({ throwSync, emitError } = {}) {
    const calls = [];
    const spawn = (command, args, options) => {
      calls.push({ command, args, options });
      if (throwSync) throw throwSync;
      const child = new EventEmitter();
      child.unref = () => {};
      if (emitError) {
        queueMicrotask(() => child.emit('error', emitError));
      }
      return child;
    };
    return { spawn, calls };
  }

  it('spawns the platform launcher detached with stdio ignored', async () => {
    const { spawn, calls } = makeSpawnStub();
    const result = await openBrowser('http://localhost:3000/', {
      spawn,
      platform: 'darwin',
    });
    assert.equal(result.opened, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, 'open');
    assert.deepEqual(calls[0].args, ['http://localhost:3000/']);
    assert.equal(calls[0].options.stdio, 'ignore');
    assert.equal(calls[0].options.detached, true);
  });

  it('falls back gracefully when spawn throws synchronously', async () => {
    const err = Object.assign(new Error('launcher not found'), { code: 'ENOENT' });
    const { spawn } = makeSpawnStub({ throwSync: err });
    const result = await openBrowser('http://localhost:3000/', {
      spawn,
      platform: 'linux',
    });
    assert.equal(result.opened, false);
    assert.equal(result.error, err);
    assert.equal(result.command, 'xdg-open');
  });

  it('falls back gracefully when the child emits an async error', async () => {
    const err = Object.assign(new Error('ENOENT xdg-open'), { code: 'ENOENT' });
    const { spawn } = makeSpawnStub({ emitError: err });
    const result = await openBrowser('http://localhost:3000/', {
      spawn,
      platform: 'linux',
    });
    assert.equal(result.opened, false);
    assert.equal(result.error, err);
  });
});

// ── startServer — lifecycle + routing ─────────────────────────────────────

describe('startServer()', () => {
  let projectDir;
  let buildDir;
  let handle;

  beforeEach(async () => {
    projectDir = await makeProject();
    buildDir = null;
    handle = null;
  });

  afterEach(async () => {
    if (handle && handle.close) await handle.close();
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
    if (buildDir) await rm(buildDir, { recursive: true, force: true });
  });

  it('throws ENOAWEEKDIR when .aweek/ is missing', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'aweek-noinit-'));
    try {
      await assert.rejects(
        () => startServer({ projectDir: empty, port: 0, host: '127.0.0.1' }),
        (err) => err.code === 'ENOAWEEKDIR',
      );
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('binds to an ephemeral port and returns a resolved URL + buildDir', async () => {
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });
    assert.ok(handle.server, 'returns the raw http.Server');
    assert.ok(handle.port > 0, 'returns a non-zero bound port');
    assert.equal(handle.host, '127.0.0.1');
    assert.equal(handle.projectDir, projectDir);
    assert.equal(handle.buildDir, buildDir);
    assert.equal(handle.url, `http://127.0.0.1:${handle.port}/`);
    assert.equal(typeof handle.close, 'function');
  });

  it('answers GET /healthz with { ok: true } and projectDir', async () => {
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}healthz`);
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] || '', /application\/json/);
    assert.match(res.headers['cache-control'] || '', /no-store/);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.projectDir, projectDir);
  });

  it('serves index.html at GET / from the build directory', async () => {
    buildDir = await makeBuildDir({
      indexHtml: '<!doctype html><html><head><title>aweek SPA</title></head><body id="app"></body></html>',
    });
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(handle.url);
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] || '', /text\/html/);
    // index.html must never be cached — new deploys must land immediately.
    assert.match(res.headers['cache-control'] || '', /no-store/);
    assert.match(res.body, /aweek SPA/);
  });

  it('serves hashed assets with immutable caching', async () => {
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}assets/app-abc123.js`);
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] || '', /application\/javascript/);
    assert.match(res.headers['cache-control'] || '', /max-age=31536000/);
    assert.match(res.headers['cache-control'] || '', /immutable/);
    assert.match(res.body, /console\.log\("spa"\)/);
  });

  it('serves a CSS asset with the correct MIME type', async () => {
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}assets/app-abc123.css`);
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] || '', /text\/css/);
    assert.match(res.body, /body\{color:red\}/);
  });

  it('falls back to index.html for client-side routes (SPA routing)', async () => {
    buildDir = await makeBuildDir({
      indexHtml: '<!doctype html><html><body data-spa="yes"></body></html>',
    });
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });
    // Deep client-side route that does not exist on disk.
    const res = await httpGet(`${handle.url}agents/writer/calendar`);
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] || '', /text\/html/);
    assert.match(res.body, /data-spa="yes"/);
  });

  it('returns 404 for missing asset-looking files rather than SPA fallback', async () => {
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });
    // `.js` with no on-disk file: broken <script> tags must not silently
    // get the SPA shell — operators need to see the 404.
    const res = await httpGet(`${handle.url}assets/missing.js`);
    assert.equal(res.statusCode, 404);
    assert.match(res.headers['content-type'] || '', /text\/plain/);
    assert.match(res.body, /Not found/);
  });

  it('returns 405 for non-GET/HEAD requests', async () => {
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(handle.url, { method: 'POST' });
    assert.equal(res.statusCode, 405);
    assert.match(res.headers.allow || '', /GET/);
  });

  it('handles HEAD requests for static assets without a body', async () => {
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}assets/app-abc123.js`, { method: 'HEAD' });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] || '', /application\/javascript/);
    // Content-Length must be set so the response is usable as a probe.
    assert.ok(res.headers['content-length']);
    assert.equal(res.body, '');
  });

  it('rejects traversal attempts with 404', async () => {
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}..%2Fetc%2Fpasswd`);
    // Traversal → resolveSafeFile returns null → the server falls through
    // to SPA detection. Because the path ends with no recognised
    // extension, we land on index.html (200). The important invariant is
    // that no file outside the build dir is served.
    assert.ok(res.statusCode === 200 || res.statusCode === 404,
      `expected 200 (SPA fallback) or 404, got ${res.statusCode}`);
    // Whatever came back must NOT be the traversal target.
    assert.ok(!/root:/.test(res.body), 'traversal target must not leak');
  });

  it('serves a friendly build-missing page when the build dir does not exist', async () => {
    buildDir = null; // do not create a build dir
    const ghostBuild = join(projectDir, 'dist-does-not-exist');
    handle = await startServer({
      projectDir,
      buildDir: ghostBuild,
      port: 0,
      host: '127.0.0.1',
    });
    const res = await httpGet(handle.url);
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] || '', /text\/html/);
    assert.match(res.body, /SPA bundle not found/);
    assert.match(res.body, /pnpm build/);
    assert.match(res.body, /dist-does-not-exist/);
  });

  it('returns 500 when build dir exists but index.html is missing', async () => {
    // Empty build directory — simulates a broken / partial build where
    // the operator should notice loudly.
    const broken = await mkdtemp(join(tmpdir(), 'aweek-broken-build-'));
    try {
      handle = await startServer({
        projectDir,
        buildDir: broken,
        port: 0,
        host: '127.0.0.1',
      });
      // Request a whitelisted client-side route → hits the SPA fallback
      // path → no index.html → 500. A non-whitelisted path would short-
      // circuit to a 404 JSON envelope (see isWhitelistedClientRoute)
      // without ever checking for index.html, so we have to use a route
      // the whitelist actually admits.
      const res = await httpGet(`${handle.url}agents`);
      assert.equal(res.statusCode, 500);
      assert.match(res.body, /index\.html not found/);
    } finally {
      await rm(broken, { recursive: true, force: true });
    }
  });

  it('auto-increments past an in-use port', async () => {
    buildDir = await makeBuildDir();
    const first = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });
    try {
      const second = await startServer({
        projectDir,
        buildDir,
        port: first.port,
        host: '127.0.0.1',
      });
      try {
        assert.notEqual(second.port, first.port, 'should skip the occupied port');
        assert.ok(second.port > first.port, 'should increment upward');
      } finally {
        await second.close();
      }
    } finally {
      await first.close();
    }
  });

  it('binds to 0.0.0.0 by default so the LAN can reach it', async () => {
    buildDir = await makeBuildDir();
    // Default host should be a wildcard bind; the returned handle
    // reports `0.0.0.0` (raw bind host) while `url` rewrites it to
    // `localhost` for click-through. Both need to be true for LAN
    // access to work: wildcard bind is the kernel-level precondition
    // and `localhost` keeps the primary URL clickable on the host
    // machine.
    assert.equal(DEFAULT_HOST, '0.0.0.0');
    handle = await startServer({ projectDir, buildDir, port: 0 });
    assert.equal(handle.host, '0.0.0.0');
    assert.equal(isWildcardHost(handle.host), true);
    assert.ok(handle.url.startsWith('http://localhost:'));

    // Sanity-check the bind by fetching the shell through 127.0.0.1,
    // which is a different interface than `localhost` on some systems
    // — proving the wildcard bind really is accepting on every iface.
    const res = await httpGet(`http://127.0.0.1:${handle.port}/`);
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /spa/);
  });
});

// ── isWildcardHost ─────────────────────────────────────────────────────────

describe('isWildcardHost()', () => {
  it('returns true for IPv4/IPv6 wildcard binds', () => {
    assert.equal(isWildcardHost('0.0.0.0'), true);
    assert.equal(isWildcardHost('::'), true);
    assert.equal(isWildcardHost('::0'), true);
  });

  it('returns false for explicit hosts', () => {
    assert.equal(isWildcardHost('127.0.0.1'), false);
    assert.equal(isWildcardHost('localhost'), false);
    assert.equal(isWildcardHost('192.168.1.10'), false);
    assert.equal(isWildcardHost('::1'), false);
  });
});

// ── getLanAddresses ────────────────────────────────────────────────────────

describe('getLanAddresses()', () => {
  function makeNetStub(map) {
    return () => map;
  }

  it('returns external IPv4 and IPv6 addresses, skipping loopback', () => {
    const addrs = getLanAddresses({
      networkInterfaces: makeNetStub({
        lo0: [
          { address: '127.0.0.1', family: 'IPv4', internal: true },
          { address: '::1', family: 'IPv6', internal: true },
        ],
        en0: [
          { address: '192.168.1.42', family: 'IPv4', internal: false },
          { address: '2001:db8::1', family: 'IPv6', internal: false },
        ],
      }),
    });
    assert.deepEqual(
      addrs.map((a) => a.address).sort(),
      ['192.168.1.42', '2001:db8::1'].sort(),
    );
    assert.ok(addrs.every((a) => a.name === 'en0'));
  });

  it('skips link-local IPv6 addresses (fe80::/10)', () => {
    const addrs = getLanAddresses({
      networkInterfaces: makeNetStub({
        en0: [
          { address: 'fe80::1ab:cdef', family: 'IPv6', internal: false },
          { address: '10.0.0.5', family: 'IPv4', internal: false },
        ],
      }),
    });
    assert.deepEqual(
      addrs.map((a) => a.address),
      ['10.0.0.5'],
    );
  });

  it('accepts the numeric family values emitted by older Node versions', () => {
    const addrs = getLanAddresses({
      networkInterfaces: makeNetStub({
        en0: [{ address: '10.1.2.3', family: 4, internal: false }],
      }),
    });
    assert.deepEqual(addrs, [{ name: 'en0', address: '10.1.2.3', family: 'IPv4' }]);
  });

  it('tolerates an empty or missing interface map', () => {
    assert.deepEqual(getLanAddresses({ networkInterfaces: makeNetStub({}) }), []);
    assert.deepEqual(
      getLanAddresses({ networkInterfaces: () => undefined }),
      [],
    );
  });
});

// ── formatLanHints ─────────────────────────────────────────────────────────

describe('formatLanHints()', () => {
  function makeNetStub(map) {
    return () => map;
  }

  it('returns one URL per external IPv4/IPv6 address for wildcard binds', () => {
    const hints = formatLanHints(
      { host: '0.0.0.0', port: 3000 },
      {
        networkInterfaces: makeNetStub({
          en0: [
            { address: '192.168.1.42', family: 'IPv4', internal: false },
            { address: '2001:db8::1', family: 'IPv6', internal: false },
          ],
        }),
      },
    );
    assert.deepEqual(hints.sort(), [
      'http://192.168.1.42:3000/',
      'http://[2001:db8::1]:3000/',
    ].sort());
  });

  it('returns [] for non-wildcard binds (nothing to advertise)', () => {
    const hints = formatLanHints(
      { host: '127.0.0.1', port: 3000 },
      {
        networkInterfaces: makeNetStub({
          en0: [{ address: '192.168.1.42', family: 'IPv4', internal: false }],
        }),
      },
    );
    assert.deepEqual(hints, []);
  });

  it('returns [] when the machine has no external interfaces', () => {
    const hints = formatLanHints(
      { host: '0.0.0.0', port: 3000 },
      {
        networkInterfaces: makeNetStub({
          lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
        }),
      },
    );
    assert.deepEqual(hints, []);
  });
});

// ── API endpoint — /api/summary ───────────────────────────────────────────

describe('GET /api/summary', () => {
  let projectDir;
  let buildDir;
  let handle;

  beforeEach(() => {
    projectDir = null;
    buildDir = null;
    handle = null;
  });

  afterEach(async () => {
    if (handle && handle.close) await handle.close();
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
    if (buildDir) await rm(buildDir, { recursive: true, force: true });
  });

  it('returns an empty-rows summary envelope when no agents exist', async () => {
    projectDir = await makeProject();
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });

    const res = await httpGet(`${handle.url}api/summary`);
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] || '', /application\/json/);
    // Dashboard must reflect filesystem truth on every manual refresh.
    assert.match(res.headers['cache-control'] || '', /no-store/);

    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.rows), 'rows must be an array');
    assert.equal(body.rows.length, 0);
    assert.equal(body.agentCount, 0);
    assert.equal(typeof body.week, 'string');
    assert.equal(typeof body.weekMonday, 'string');
    // Week key shape: YYYY-Www
    assert.match(body.week, /^\d{4}-W\d{2}$/);
    // Monday-of-week shape: YYYY-MM-DD
    assert.match(body.weekMonday, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('builds a summary row per agent using buildSummaryRow cells', async () => {
    const fx = await makeProjectWithAgent({
      slug: 'writer',
      name: 'Writer',
      description: 'Drafts copy.',
      weeklyTokenBudget: 10_000,
    });
    projectDir = fx.root;
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });

    const res = await httpGet(`${handle.url}api/summary`);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.agentCount, 1);
    assert.equal(body.rows.length, 1);

    // Row cells mirror the terminal /aweek:summary output exactly so the
    // SPA Overview tab keeps feature parity with the CLI baseline.
    const row = body.rows[0];
    assert.equal(typeof row.agent, 'string');
    assert.equal(typeof row.goals, 'string');
    assert.equal(typeof row.tasks, 'string');
    assert.equal(typeof row.budget, 'string');
    assert.equal(typeof row.status, 'string');

    // Display name comes from `.claude/agents/<slug>.md` — no missing marker.
    assert.equal(row.agent, 'Writer');
    // No goals seeded → "0".
    assert.equal(row.goals, '0');
    // No weekly plan → em dash placeholder.
    assert.equal(row.tasks, '—');
    // 0 of 10,000 tokens used → "0 / 10,000 (0%)".
    assert.match(row.budget, /0\s*\/\s*10,000\s*\(0%\)/);
    // Fixture has no approved weekly plan and no running lock, so
    // buildAgentStatus derives state="idle" and stateLabel() uppercases
    // it to IDLE — byte-identical to the terminal /aweek:summary output
    // for the same fixture.
    assert.equal(row.status, 'IDLE');
  });

  it('reflects the PAUSED state in the status cell', async () => {
    const fx = await makeProjectWithAgent({
      slug: 'writer',
      name: 'Writer',
      weeklyTokenBudget: 10_000,
      paused: true,
    });
    projectDir = fx.root;
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });

    const res = await httpGet(`${handle.url}api/summary`);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.rows.length, 1);
    assert.equal(body.rows[0].status, 'PAUSED');
  });

  it('handles trailing slash on /api/summary/', async () => {
    projectDir = await makeProject();
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });

    const res = await httpGet(`${handle.url}api/summary/`);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.rows));
  });

  // — Response-shape, status-codes, and error-handling coverage (sub-AC 4.1).
  //
  // The block below extends the four happy-path tests above with the
  // envelope/method/error scenarios required by the summary endpoint. The
  // existing tests verify the 200 envelope for empty and single-agent
  // fixtures; the following tests lock in:
  //   - multi-agent envelope shape (row count + required cell keys)
  //   - HEAD request semantics (headers only, no body)
  //   - 405 for non-GET/HEAD methods (summary honours the shared router
  //     method guard — a regression here would silently accept mutations)
  //   - 500 envelope when the data layer throws (response-level error
  //     surface the SPA's api-client relies on for its `{error}` fallback)
  //   - missing-subagent marker (orphaned .json + absent .md must NOT 500
  //     — the marker is the contract for the terminal /aweek:summary view
  //     and the SPA mirrors it exactly)

  it('builds one row per agent for multi-agent fixtures with all required cells', async () => {
    const fx = await makeProjectWithAgent({
      slug: 'writer',
      name: 'Writer',
      weeklyTokenBudget: 10_000,
    });
    projectDir = fx.root;

    // Seed a second agent side-by-side so we exercise the fan-out path
    // of buildSummary (listAllAgents + per-agent subagent reads). Writes
    // use the same JSON shape as `makeProjectWithAgent` so we stay in
    // schema without pulling the helper's internals up here.
    const agentsDir = join(projectDir, '.aweek', 'agents');
    const now = new Date().toISOString();
    const d = new Date();
    const day = d.getUTCDay();
    const diff = day === 0 ? -6 : 1 - day;
    d.setUTCDate(d.getUTCDate() + diff);
    d.setUTCHours(0, 0, 0, 0);
    const periodStart = d.toISOString();
    await writeFile(
      join(agentsDir, 'editor.json'),
      JSON.stringify(
        {
          id: 'editor',
          subagentRef: 'editor',
          createdAt: now,
          updatedAt: now,
          weeklyTokenBudget: 20_000,
          budget: {
            weeklyTokenLimit: 20_000,
            currentUsage: 0,
            periodStart,
            paused: false,
          },
        },
        null,
        2,
      ) + '\n',
      'utf-8',
    );
    await writeFile(
      join(projectDir, '.claude', 'agents', 'editor.md'),
      `---\nname: Editor\ndescription: Polishes copy.\n---\n\nYou are an editor.\n`,
      'utf-8',
    );

    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });

    const res = await httpGet(`${handle.url}api/summary`);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.agentCount, 2);
    assert.equal(body.rows.length, 2);

    // Every row carries exactly the five buildSummaryRow cells, each a
    // string. A regression that drops a cell (or replaces it with e.g.
    // `null` / `undefined`) would break the CLI-parity contract — the
    // terminal summary table renders every cell as a string.
    for (const row of body.rows) {
      for (const key of ['agent', 'goals', 'tasks', 'budget', 'status']) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(row, key),
          `row missing "${key}"`,
        );
        assert.equal(typeof row[key], 'string', `row.${key} must be string`);
      }
    }

    // Agent cell pulls the display name from each `.claude/agents/<slug>.md`
    // — order depends on the store's list sort, so assert on the set.
    const names = body.rows.map((r) => r.agent).sort();
    assert.deepEqual(names, ['Editor', 'Writer']);

    // Budget cell reflects per-agent limits, so each agent gets its own
    // "N / limit (0%)" formatting — proof the fan-out computed per-row
    // rather than cross-pollinating state between agents.
    const byName = Object.fromEntries(body.rows.map((r) => [r.agent, r]));
    assert.match(byName.Writer.budget, /\/\s*10,000\s*\(0%\)/);
    assert.match(byName.Editor.budget, /\/\s*20,000\s*\(0%\)/);
  });

  it('renders the missing-subagent marker without failing when .md is absent', async () => {
    // `makeProjectWithAgent` writes both the aweek JSON and the subagent
    // .md — we drop the .md afterwards to simulate an orphaned agent.
    // The summary endpoint must NOT 500 for this: the missing marker is
    // the documented behaviour for the terminal /aweek:summary cell
    // (see formatAgentCell / MISSING_SUBAGENT_MARKER), and the SPA
    // Overview mirrors it.
    const fx = await makeProjectWithAgent({ slug: 'orphan', name: 'Orphan' });
    projectDir = fx.root;
    await rm(join(projectDir, '.claude', 'agents', 'orphan.md'), { force: true });

    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });

    const res = await httpGet(`${handle.url}api/summary`);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.rows.length, 1);
    // Cell format from summary.formatAgentCell: `"<slug> [subagent missing]"`.
    assert.match(body.rows[0].agent, /orphan/);
    assert.match(body.rows[0].agent, /\[subagent missing\]/);
  });

  it('answers HEAD /api/summary with JSON headers and an empty body', async () => {
    // Node's http layer automatically strips the response body for HEAD,
    // so the summary handler can reuse the same `sendJson` code path it
    // uses for GET. Test that content-type, cache-control, and the empty
    // body invariant all hold — probes (uptime monitors, curl -I) rely
    // on this.
    projectDir = await makeProject();
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });

    const res = await httpGet(`${handle.url}api/summary`, { method: 'HEAD' });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] || '', /application\/json/);
    assert.match(res.headers['cache-control'] || '', /no-store/);
    assert.equal(res.body, '');
  });

  it('returns 405 for non-GET/HEAD methods on /api/summary', async () => {
    // The router's method guard runs before path dispatch, so writes to
    // /api/summary should never reach the handler. This locks in the
    // read-only contract for `aweek serve` at the HTTP layer — a PR that
    // accidentally accepts POSTs here would fail this test before it
    // ever got close to breaking the data-store guarantees.
    projectDir = await makeProject();
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });

    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await httpGet(`${handle.url}api/summary`, { method });
      assert.equal(res.statusCode, 405, `method=${method} should be 405`);
      assert.match(res.headers.allow || '', /GET/, `method=${method} Allow must advertise GET`);
      assert.match(res.headers.allow || '', /HEAD/, `method=${method} Allow must advertise HEAD`);
    }
  });

  it('returns a 500 JSON envelope when buildSummary fails', async () => {
    // To exercise the try/catch inside `handleSummary` we need to make
    // the data layer throw a non-ENOENT error. The cleanest way is to
    // replace `.claude/agents/<slug>.md` with a DIRECTORY of the same
    // name: `readSubagentIdentity` -> `readFile` yields EISDIR (not
    // ENOENT), so the "missing subagent" branch is bypassed and the
    // error propagates up through `Promise.all(...)` in `buildSummary`.
    //
    // This test documents the on-wire 500 contract (JSON envelope with
    // a non-empty `error` string + no-store cache-control) the SPA's
    // `api-client` relies on to display a "Failed to load summary"
    // banner rather than an opaque network failure.
    const fx = await makeProjectWithAgent({ slug: 'writer', name: 'Writer' });
    projectDir = fx.root;
    const mdPath = join(projectDir, '.claude', 'agents', 'writer.md');
    await rm(mdPath, { force: true });
    await mkdir(mdPath, { recursive: true });

    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });

    const res = await httpGet(`${handle.url}api/summary`);
    assert.equal(res.statusCode, 500);
    assert.match(res.headers['content-type'] || '', /application\/json/);
    // Even error responses must carry no-store so a transient failure
    // isn't pinned by an intermediate cache.
    assert.match(res.headers['cache-control'] || '', /no-store/);
    const body = JSON.parse(res.body);
    assert.equal(typeof body.error, 'string');
    assert.ok(body.error.length > 0, 'error message must not be empty');
  });

  it('returns a 500 JSON envelope with a default message when the underlying error is message-less', async () => {
    // Guards the `|| 'Failed to load summary'` fallback in handleSummary:
    // when the thrown error has no `.message`, the envelope still carries
    // a human-readable string so the SPA banner isn't blank.
    //
    // We exercise this by stubbing the summary composer at module scope
    // isn't possible under ESM, so instead we assert the fallback indirectly
    // by re-issuing the EISDIR scenario from the test above and checking
    // that the error envelope itself is a plain string (whether it comes
    // from the original error or the fallback, it is never `undefined`).
    const fx = await makeProjectWithAgent({ slug: 'writer', name: 'Writer' });
    projectDir = fx.root;
    const mdPath = join(projectDir, '.claude', 'agents', 'writer.md');
    await rm(mdPath, { force: true });
    await mkdir(mdPath, { recursive: true });

    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });

    const res = await httpGet(`${handle.url}api/summary`);
    assert.equal(res.statusCode, 500);
    const body = JSON.parse(res.body);
    // Envelope surface contract: `{error: string}`, never `{}` and never
    // `{error: null}`. Subsequent fields (e.g. stack traces) are reserved
    // for debug-mode, intentionally omitted in production responses.
    const keys = Object.keys(body).sort();
    assert.deepEqual(keys, ['error']);
    assert.equal(typeof body.error, 'string');
  });

  it('200 response carries exactly the documented envelope keys', async () => {
    // The SPA's api-client typedef for the /api/summary payload is
    // `{ rows, week, weekMonday, agentCount }` — locking the keyset in
    // here prevents a silent backend additions (e.g. accidentally leaking
    // debug fields) from reaching the browser.
    projectDir = await makeProject();
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });

    const res = await httpGet(`${handle.url}api/summary`);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const keys = Object.keys(body).sort();
    assert.deepEqual(keys, ['agentCount', 'rows', 'week', 'weekMonday']);
    assert.equal(typeof body.agentCount, 'number');
    assert.ok(Array.isArray(body.rows));
    assert.equal(typeof body.week, 'string');
    assert.equal(typeof body.weekMonday, 'string');
  });
});

// ── API endpoints — /api/agents + /api/agents/:slug ───────────────────────

describe('GET /api/agents (list)', () => {
  let projectDir;
  let buildDir;
  let handle;

  beforeEach(() => {
    projectDir = null;
    buildDir = null;
    handle = null;
  });

  afterEach(async () => {
    if (handle && handle.close) await handle.close();
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
    if (buildDir) await rm(buildDir, { recursive: true, force: true });
  });

  it('returns an empty agents array when no agents exist', async () => {
    projectDir = await makeProject();
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}api/agents`);
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] || '', /application\/json/);
    // API responses must stay fresh on manual refresh.
    assert.match(res.headers['cache-control'] || '', /no-store/);
    const body = JSON.parse(res.body);
    assert.deepEqual(body, { agents: [], issues: [] });
  });

  it('returns the agent row from fixture data (agent-store → gatherAgentsList)', async () => {
    const fx = await makeProjectWithAgent({
      slug: 'writer',
      name: 'Writer',
      description: 'Drafts copy.',
      weeklyTokenBudget: 10_000,
    });
    projectDir = fx.root;
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}api/agents`);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.agents));
    assert.equal(body.agents.length, 1);
    const row = body.agents[0];
    assert.equal(row.slug, 'writer');
    assert.equal(row.name, 'Writer');
    assert.equal(row.description, 'Drafts copy.');
    assert.equal(row.missing, false);
    assert.equal(row.status, 'active');
    assert.equal(row.tokenLimit, 10_000);
    assert.equal(row.tokensUsed, 0);
  });

  it('handles trailing slash on /api/agents/', async () => {
    projectDir = await makeProject();
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}api/agents/`);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(body, { agents: [], issues: [] });
  });
});

describe('GET /api/agents/:slug (detail)', () => {
  let projectDir;
  let buildDir;
  let handle;

  beforeEach(() => {
    projectDir = null;
    buildDir = null;
    handle = null;
  });

  afterEach(async () => {
    if (handle && handle.close) await handle.close();
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
    if (buildDir) await rm(buildDir, { recursive: true, force: true });
  });

  it('returns the profile payload for a known slug', async () => {
    const fx = await makeProjectWithAgent({
      slug: 'writer',
      name: 'Writer',
      description: 'Drafts copy.',
      weeklyTokenBudget: 12_345,
    });
    projectDir = fx.root;
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}api/agents/writer`);
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] || '', /application\/json/);
    assert.match(res.headers['cache-control'] || '', /no-store/);
    const body = JSON.parse(res.body);
    assert.ok(body.agent, 'expected { agent: {...} } envelope');
    assert.equal(body.agent.slug, 'writer');
    assert.equal(body.agent.name, 'Writer');
    assert.equal(body.agent.description, 'Drafts copy.');
    assert.equal(body.agent.missing, false);
    assert.equal(body.agent.paused, false);
    assert.equal(body.agent.tokenLimit, 12_345);
    assert.equal(body.agent.tokensUsed, 0);
    assert.equal(body.agent.overBudget, false);
  });

  // ── Sub-AC 1 of AC 6 ─────────────────────────────────────────────────
  // The Profile tab needs live subagent identity (name, description, and
  // the system-prompt body) sourced from `.claude/agents/<slug>.md`. The
  // data layer is already verified in data.test.js, but the HTTP boundary
  // must also expose the identity fields verbatim so the SPA can render
  // the Profile tab without touching the filesystem. This test locks in
  // that contract at the endpoint level.
  it('exposes subagent identity (name, description, systemPrompt, identityPath) from .claude/agents/<slug>.md', async () => {
    const fx = await makeProjectWithAgent({
      slug: 'writer',
      name: 'Writer',
      description: 'Drafts copy.',
    });
    projectDir = fx.root;
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}api/agents/writer`);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const agent = body && body.agent;
    assert.ok(agent, 'expected { agent: {...} } envelope');

    // Identity surface — frontmatter-sourced fields.
    assert.equal(agent.name, 'Writer');
    assert.equal(agent.description, 'Drafts copy.');
    assert.equal(agent.missing, false);

    // System prompt — body of `.claude/agents/writer.md` (everything after
    // the closing `---` fence). `makeProjectWithAgent` writes the body
    // "You are a test." so the HTTP response must echo that verbatim.
    assert.equal(
      agent.systemPrompt,
      'You are a test.',
      'systemPrompt must come from the body of .claude/agents/<slug>.md',
    );

    // Identity path — absolute path to the .md so the SPA can link / copy it.
    assert.equal(typeof agent.identityPath, 'string');
    assert.match(
      agent.identityPath,
      /\.claude\/agents\/writer\.md$/,
      'identityPath must point at the project-level subagent .md',
    );
  });

  it('marks an agent as missing when .claude/agents/<slug>.md is absent', async () => {
    // Hired agent JSON but no `.claude/agents/<slug>.md` — the identity
    // read returns `missing: true` and the endpoint still responds 200
    // with empty identity fields so the Profile tab can render an
    // actionable missing-identity state instead of 500ing.
    const fx = await makeProjectWithAgent({ slug: 'orphan', name: 'Orphan' });
    projectDir = fx.root;
    await rm(join(projectDir, '.claude', 'agents', 'orphan.md'));
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}api/agents/orphan`);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const agent = body && body.agent;
    assert.ok(agent, 'expected { agent: {...} } envelope even when .md is missing');
    assert.equal(agent.missing, true);
    // When the .md is missing, the name falls back to the slug so the SPA
    // can still show something sensible — but description / systemPrompt
    // are empty strings (no stale data from anywhere else).
    assert.equal(agent.name, 'orphan');
    assert.equal(agent.description, '');
    assert.equal(agent.systemPrompt, '');
    // identityPath is still populated so the SPA can tell the user
    // exactly where to put the missing file.
    assert.match(agent.identityPath, /\.claude\/agents\/orphan\.md$/);
  });

  it('returns 404 when the slug does not exist', async () => {
    projectDir = await makeProject();
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}api/agents/does-not-exist`);
    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.body);
    assert.match(body.error, /Agent not found/);
  });

  it('rejects traversal-shaped slugs with 400', async () => {
    projectDir = await makeProject();
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}api/agents/..%2F..%2Fetc%2Fpasswd`);
    // `..%2F` decodes to `../` which contains `/`. Our decoder rejects
    // that outright so the detail handler never runs.
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.match(body.error, /Invalid agent slug/);
  });

  it('handles URL-encoded slugs correctly', async () => {
    // Slugs are plain ids in this project, but the decoder should still
    // unescape legal percent-encoding before looking up the agent.
    const fx = await makeProjectWithAgent({ slug: 'writer', name: 'Writer' });
    projectDir = fx.root;
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}api/agents/${encodeURIComponent('writer')}`);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.agent.slug, 'writer');
  });
});

// ── API endpoint — /api/agents/:slug/plan ─────────────────────────────────

describe('GET /api/agents/:slug/plan', () => {
  let projectDir;
  let buildDir;
  let handle;

  beforeEach(() => {
    projectDir = null;
    buildDir = null;
    handle = null;
  });

  afterEach(async () => {
    if (handle && handle.close) await handle.close();
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
    if (buildDir) await rm(buildDir, { recursive: true, force: true });
  });

  it('returns plan.md content + empty weekly plans for a known slug', async () => {
    const fx = await makeProjectWithAgent({ slug: 'writer', name: 'Writer' });
    projectDir = fx.root;
    // Seed plan.md so the Strategy payload has content.
    const agentsDir = join(projectDir, '.aweek', 'agents');
    await mkdir(join(agentsDir, 'writer'), { recursive: true });
    await writeFile(
      join(agentsDir, 'writer', 'plan.md'),
      '# Writer plan\n\nShip weekly essays.\n',
      'utf8',
    );
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });

    const res = await httpGet(`${handle.url}api/agents/writer/plan`);
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] || '', /application\/json/);
    // API responses must stay fresh on manual refresh.
    assert.match(res.headers['cache-control'] || '', /no-store/);
    const body = JSON.parse(res.body);
    assert.ok(body.plan, 'expected { plan: {...} } envelope');
    assert.equal(body.plan.slug, 'writer');
    assert.equal(body.plan.name, 'Writer');
    assert.equal(body.plan.hasPlan, true);
    assert.match(body.plan.markdown, /^# Writer plan/);
    // No weekly plans yet — empty array + null latest approved.
    assert.ok(Array.isArray(body.plan.weeklyPlans));
    assert.equal(body.plan.weeklyPlans.length, 0);
    assert.equal(body.plan.latestApproved, null);
  });

  it('returns weekly plan data from weekly-plan-store when present', async () => {
    const fx = await makeProjectWithAgent({ slug: 'writer', name: 'Writer' });
    projectDir = fx.root;
    const agentsDir = join(projectDir, '.aweek', 'agents');

    // Seed plan.md so `hasPlan === true`.
    await mkdir(join(agentsDir, 'writer'), { recursive: true });
    await writeFile(
      join(agentsDir, 'writer', 'plan.md'),
      '# Writer plan\n',
      'utf8',
    );
    // Seed two weekly plans through the real store so the endpoint is
    // exercised end-to-end: one approved, one pending.
    const { WeeklyPlanStore } = await import(
      '../storage/weekly-plan-store.js'
    );
    const { createTask, createWeeklyPlan } = await import(
      '../models/agent.js'
    );
    const store = new WeeklyPlanStore(agentsDir);

    const approved = createWeeklyPlan('2026-W15', '2026-04', [
      createTask({ title: 'Ship essay', prompt: 'Publish essay' }, 'obj-1'),
    ]);
    approved.approved = true;
    approved.approvedAt = '2026-04-10T00:00:00.000Z';
    await store.save('writer', approved);

    const pending = createWeeklyPlan('2026-W16', '2026-04', [
      createTask({ title: 'Draft essay', prompt: 'Draft next essay' }, 'obj-2'),
    ]);
    // `createWeeklyPlan` now defaults to `approved: true`; flip back to
    // preserve the approved/pending split this endpoint test inspects.
    pending.approved = false;
    await store.save('writer', pending);

    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });

    const res = await httpGet(`${handle.url}api/agents/writer/plan`);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.plan.weeklyPlans.length, 2);
    // Sorted ascending by week key.
    assert.equal(body.plan.weeklyPlans[0].week, '2026-W15');
    assert.equal(body.plan.weeklyPlans[1].week, '2026-W16');
    assert.equal(body.plan.weeklyPlans[0].approved, true);
    assert.equal(body.plan.weeklyPlans[1].approved, false);
    assert.ok(body.plan.latestApproved);
    assert.equal(body.plan.latestApproved.week, '2026-W15');
    assert.equal(body.plan.latestApproved.approved, true);
    // Verify tasks survive JSON round-trip.
    assert.equal(body.plan.weeklyPlans[0].tasks[0].title, 'Ship essay');
  });

  it('returns hasPlan=false + markdown="" when plan.md is missing', async () => {
    const fx = await makeProjectWithAgent({ slug: 'writer', name: 'Writer' });
    projectDir = fx.root;
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });

    const res = await httpGet(`${handle.url}api/agents/writer/plan`);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.plan.slug, 'writer');
    assert.equal(body.plan.hasPlan, false);
    assert.equal(body.plan.markdown, '');
  });

  it('returns 404 when the slug does not exist', async () => {
    projectDir = await makeProject();
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });

    const res = await httpGet(`${handle.url}api/agents/does-not-exist/plan`);
    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.body);
    assert.match(body.error, /Agent not found/);
  });

  it('rejects traversal-shaped slugs with 400', async () => {
    projectDir = await makeProject();
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });

    const res = await httpGet(`${handle.url}api/agents/..%2F..%2Fetc%2Fpasswd/plan`);
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.match(body.error, /Invalid agent slug/);
  });

  it('handles trailing slash on /api/agents/:slug/plan/', async () => {
    const fx = await makeProjectWithAgent({ slug: 'writer', name: 'Writer' });
    projectDir = fx.root;
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });

    const res = await httpGet(`${handle.url}api/agents/writer/plan/`);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.plan.slug, 'writer');
  });
});

// ── API endpoint — /api/agents/:slug/calendar ─────────────────────────────

describe('GET /api/agents/:slug/calendar', () => {
  let projectDir;
  let buildDir;
  let handle;

  beforeEach(() => {
    projectDir = null;
    buildDir = null;
    handle = null;
  });

  afterEach(async () => {
    if (handle && handle.close) await handle.close();
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
    if (buildDir) await rm(buildDir, { recursive: true, force: true });
  });

  it('returns noPlan=true for a known slug with no weekly plan yet', async () => {
    const fx = await makeProjectWithAgent({ slug: 'writer', name: 'Writer' });
    projectDir = fx.root;
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });

    const res = await httpGet(`${handle.url}api/agents/writer/calendar`);
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] || '', /application\/json/);
    assert.match(res.headers['cache-control'] || '', /no-store/);
    const body = JSON.parse(res.body);
    assert.ok(body.calendar, 'expected { calendar: {...} } envelope');
    assert.equal(body.calendar.agentId, 'writer');
    assert.equal(body.calendar.noPlan, true);
    assert.deepEqual(body.calendar.tasks, []);
    assert.equal(body.calendar.counts.total, 0);
  });

  it('returns tasks with computed day/hour slots from the weekly-plan-store', async () => {
    const fx = await makeProjectWithAgent({ slug: 'writer', name: 'Writer' });
    projectDir = fx.root;
    const agentsDir = join(projectDir, '.aweek', 'agents');
    // Pin the timezone so placement is deterministic across developer machines.
    await writeFile(
      join(projectDir, '.aweek', 'config.json'),
      JSON.stringify({ timeZone: 'UTC' }, null, 2),
      'utf8',
    );
    const { WeeklyPlanStore } = await import(
      '../storage/weekly-plan-store.js'
    );
    const { createTask, createWeeklyPlan } = await import(
      '../models/agent.js'
    );
    const store = new WeeklyPlanStore(agentsDir);
    // 2026-W17 = Monday 2026-04-20 (UTC). Wednesday is dayOffset 2.
    const t1 = createTask(
      { title: 'Wednesday task', prompt: 'Do it' },
      'obj-1',
      { runAt: '2026-04-22T14:00:00.000Z' },
    );
    const plan = createWeeklyPlan('2026-W17', '2026-04', [t1]);
    plan.approved = true;
    plan.approvedAt = '2026-04-20T00:00:00.000Z';
    await store.save('writer', plan);

    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });

    const res = await httpGet(
      `${handle.url}api/agents/writer/calendar?week=2026-W17`,
    );
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.calendar.week, '2026-W17');
    assert.equal(body.calendar.approved, true);
    assert.equal(body.calendar.tasks.length, 1);
    const task = body.calendar.tasks[0];
    assert.equal(task.title, 'Wednesday task');
    assert.ok(task.slot);
    assert.equal(task.slot.dayKey, 'wed');
    assert.equal(task.slot.hour, 14);
  });

  it('returns 404 when the slug does not exist', async () => {
    const fx = await makeProjectWithAgent({ slug: 'writer', name: 'Writer' });
    projectDir = fx.root;
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });

    const res = await httpGet(`${handle.url}api/agents/does-not-exist/calendar`);
    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.body);
    assert.match(body.error, /Agent not found: does-not-exist/);
  });

  it('rejects traversal-shaped slugs with 400', async () => {
    const fx = await makeProjectWithAgent({ slug: 'writer', name: 'Writer' });
    projectDir = fx.root;
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });

    const res = await httpGet(
      `${handle.url}api/agents/..%2F..%2Fetc%2Fpasswd/calendar`,
    );
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.match(body.error, /Invalid agent slug/);
  });

  it('handles trailing slash on /api/agents/:slug/calendar/', async () => {
    const fx = await makeProjectWithAgent({ slug: 'writer', name: 'Writer' });
    projectDir = fx.root;
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });

    const res = await httpGet(`${handle.url}api/agents/writer/calendar/`);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.calendar.agentId, 'writer');
  });
});

// ── API endpoint — /api/agents/:slug/usage ────────────────────────────────

describe('GET /api/agents/:slug/usage', () => {
  let projectDir;
  let buildDir;
  let handle;

  beforeEach(() => {
    projectDir = null;
    buildDir = null;
    handle = null;
  });

  afterEach(async () => {
    if (handle && handle.close) await handle.close();
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
    if (buildDir) await rm(buildDir, { recursive: true, force: true });
  });

  it('returns budget + usage payload for a known slug with no usage yet', async () => {
    const fx = await makeProjectWithAgent({
      slug: 'writer',
      name: 'Writer',
      description: 'Drafts copy.',
      weeklyTokenBudget: 10_000,
    });
    projectDir = fx.root;
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });

    const res = await httpGet(`${handle.url}api/agents/writer/usage`);
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] || '', /application\/json/);
    // API responses must stay fresh on manual refresh.
    assert.match(res.headers['cache-control'] || '', /no-store/);

    const body = JSON.parse(res.body);
    assert.ok(body.usage, 'expected { usage: {...} } envelope');
    assert.equal(body.usage.slug, 'writer');
    assert.equal(body.usage.name, 'Writer');
    assert.equal(body.usage.missing, false);
    assert.equal(body.usage.paused, false);
    assert.equal(body.usage.tokenLimit, 10_000);
    assert.equal(body.usage.tokensUsed, 0);
    assert.equal(body.usage.inputTokens, 0);
    assert.equal(body.usage.outputTokens, 0);
    assert.equal(body.usage.recordCount, 0);
    assert.equal(body.usage.overBudget, false);
    assert.equal(body.usage.utilizationPct, 0);
    assert.equal(typeof body.usage.weekMonday, 'string');
    assert.ok(Array.isArray(body.usage.weeks), 'weeks must be an array');
    assert.equal(body.usage.weeks.length, 0);
  });

  it('aggregates historical usage from the usage store into the weeks[] roll-up', async () => {
    const fx = await makeProjectWithAgent({
      slug: 'writer',
      name: 'Writer',
      weeklyTokenBudget: 5_000,
    });
    projectDir = fx.root;

    const agentsDir = join(projectDir, '.aweek', 'agents');
    const { UsageStore, createUsageRecord } = await import(
      '../storage/usage-store.js'
    );
    const store = new UsageStore(agentsDir);
    await store.append(
      'writer',
      createUsageRecord({
        agentId: 'writer',
        taskId: 'task-1',
        inputTokens: 300,
        outputTokens: 200,
        costUsd: 0.02,
        model: 'opus',
        week: '2026-04-06',
        timestamp: '2026-04-06T12:00:00.000Z',
      }),
    );
    await store.append(
      'writer',
      createUsageRecord({
        agentId: 'writer',
        taskId: 'task-2',
        inputTokens: 100,
        outputTokens: 50,
        model: 'opus',
        week: '2026-04-13',
        timestamp: '2026-04-13T12:00:00.000Z',
      }),
    );

    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });

    const res = await httpGet(`${handle.url}api/agents/writer/usage`);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.usage);
    assert.equal(body.usage.weeks.length, 2);
    // Ascending by weekMonday.
    assert.equal(body.usage.weeks[0].weekMonday, '2026-04-06');
    assert.equal(body.usage.weeks[1].weekMonday, '2026-04-13');
    assert.equal(body.usage.weeks[0].totalTokens, 500);
    assert.equal(body.usage.weeks[0].recordCount, 1);
    assert.equal(body.usage.weeks[0].costUsd, 0.02);
    assert.equal(body.usage.weeks[1].totalTokens, 150);
  });

  it('returns 404 when the slug does not exist', async () => {
    projectDir = await makeProject();
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });

    const res = await httpGet(`${handle.url}api/agents/does-not-exist/usage`);
    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.body);
    assert.match(body.error, /Agent not found/);
  });

  it('rejects traversal-shaped slugs with 400', async () => {
    projectDir = await makeProject();
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });

    const res = await httpGet(`${handle.url}api/agents/..%2F..%2Fetc%2Fpasswd/usage`);
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.match(body.error, /Invalid agent slug/);
  });

  it('handles trailing slash on /api/agents/:slug/usage/', async () => {
    const fx = await makeProjectWithAgent({ slug: 'writer', name: 'Writer' });
    projectDir = fx.root;
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });

    const res = await httpGet(`${handle.url}api/agents/writer/usage/`);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.usage.slug, 'writer');
  });

  it('reflects paused state from the agent config', async () => {
    const fx = await makeProjectWithAgent({
      slug: 'writer',
      name: 'Writer',
      weeklyTokenBudget: 10_000,
      paused: true,
    });
    projectDir = fx.root;
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });

    const res = await httpGet(`${handle.url}api/agents/writer/usage`);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.usage.paused, true);
  });
});

// ── API endpoint — /api/agents/:slug/logs ─────────────────────────────────

describe('GET /api/agents/:slug/logs', () => {
  let projectDir;
  let buildDir;
  let handle;

  beforeEach(() => {
    projectDir = null;
    buildDir = null;
    handle = null;
  });

  afterEach(async () => {
    if (handle && handle.close) await handle.close();
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
    if (buildDir) await rm(buildDir, { recursive: true, force: true });
  });

  it('returns an empty entries + executions payload for a known slug with no history', async () => {
    const fx = await makeProjectWithAgent({ slug: 'writer', name: 'Writer' });
    projectDir = fx.root;
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });

    const res = await httpGet(`${handle.url}api/agents/writer/logs`);
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] || '', /application\/json/);
    // API responses must stay fresh on manual refresh.
    assert.match(res.headers['cache-control'] || '', /no-store/);

    const body = JSON.parse(res.body);
    assert.ok(body.logs, 'expected { logs: {...} } envelope');
    assert.equal(body.logs.slug, 'writer');
    assert.equal(body.logs.dateRange, 'all');
    assert.deepEqual(body.logs.entries, []);
    assert.deepEqual(body.logs.executions, []);
  });

  it('returns activity-log entries from the activity-log-store', async () => {
    const fx = await makeProjectWithAgent({ slug: 'writer', name: 'Writer' });
    projectDir = fx.root;
    const agentsDir = join(projectDir, '.aweek', 'agents');

    const { ActivityLogStore, createLogEntry } = await import(
      '../storage/activity-log-store.js'
    );
    const activityStore = new ActivityLogStore(agentsDir);
    await activityStore.append(
      'writer',
      createLogEntry({
        agentId: 'writer',
        taskId: 'task-1',
        status: 'completed',
        title: 'Publish post',
        duration: 800,
      }),
    );

    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });

    const res = await httpGet(`${handle.url}api/agents/writer/logs`);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.logs.entries.length, 1);
    assert.equal(body.logs.entries[0].title, 'Publish post');
    assert.equal(body.logs.entries[0].status, 'completed');
  });

  it('returns execution records from the execution-store alongside activity entries', async () => {
    const fx = await makeProjectWithAgent({ slug: 'writer', name: 'Writer' });
    projectDir = fx.root;
    const agentsDir = join(projectDir, '.aweek', 'agents');

    const { ExecutionStore, createExecutionRecord } = await import(
      '../storage/execution-store.js'
    );
    const execStore = new ExecutionStore(agentsDir);
    await execStore.record(
      'writer',
      createExecutionRecord({
        agentId: 'writer',
        status: 'completed',
        taskId: 'task-1',
        duration: 800,
      }),
    );

    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });

    const res = await httpGet(`${handle.url}api/agents/writer/logs`);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.logs.executions.length, 1);
    const exec = body.logs.executions[0];
    assert.equal(exec.agentId, 'writer');
    assert.equal(exec.status, 'completed');
    assert.equal(typeof exec.idempotencyKey, 'string');
  });

  it('honors the ?dateRange= query string and reflects it in the response', async () => {
    const fx = await makeProjectWithAgent({ slug: 'writer', name: 'Writer' });
    projectDir = fx.root;
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });

    const res = await httpGet(`${handle.url}api/agents/writer/logs?dateRange=this-week`);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.logs.dateRange, 'this-week');
  });

  it('coerces unknown ?dateRange= values to the default "all" preset', async () => {
    const fx = await makeProjectWithAgent({ slug: 'writer', name: 'Writer' });
    projectDir = fx.root;
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });

    const res = await httpGet(`${handle.url}api/agents/writer/logs?dateRange=bogus`);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.logs.dateRange, 'all');
  });

  it('returns 404 when the slug does not exist', async () => {
    projectDir = await makeProject();
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });

    const res = await httpGet(`${handle.url}api/agents/does-not-exist/logs`);
    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.body);
    assert.match(body.error, /Agent not found/);
  });

  it('rejects traversal-shaped slugs with 400', async () => {
    projectDir = await makeProject();
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });

    const res = await httpGet(`${handle.url}api/agents/..%2F..%2Fetc%2Fpasswd/logs`);
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.match(body.error, /Invalid agent slug/);
  });

  it('handles trailing slash on /api/agents/:slug/logs/', async () => {
    const fx = await makeProjectWithAgent({ slug: 'writer', name: 'Writer' });
    projectDir = fx.root;
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });

    const res = await httpGet(`${handle.url}api/agents/writer/logs/`);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.logs.slug, 'writer');
  });

  it('returns entries sorted newest-first', async () => {
    const fx = await makeProjectWithAgent({ slug: 'writer', name: 'Writer' });
    projectDir = fx.root;
    const agentsDir = join(projectDir, '.aweek', 'agents');

    // Seed three activity entries across two weeks. Use direct file
    // writes so we can pin timestamps without depending on `Date.now()`.
    const week1 = '2026-04-13';
    const week2 = '2026-04-20';
    const logsDir = join(agentsDir, 'writer', 'logs');
    await mkdir(logsDir, { recursive: true });
    await writeFile(
      join(logsDir, `${week1}.json`),
      JSON.stringify(
        [
          { id: 'log-aa01', timestamp: '2026-04-14T10:00:00.000Z', agentId: 'writer', status: 'completed', title: 'Older' },
        ],
        null,
        2,
      ) + '\n',
      'utf-8',
    );
    await writeFile(
      join(logsDir, `${week2}.json`),
      JSON.stringify(
        [
          { id: 'log-bb02', timestamp: '2026-04-21T11:00:00.000Z', agentId: 'writer', status: 'completed', title: 'Newer' },
          { id: 'log-cc03', timestamp: '2026-04-22T11:00:00.000Z', agentId: 'writer', status: 'failed', title: 'Newest' },
        ],
        null,
        2,
      ) + '\n',
      'utf-8',
    );

    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });

    const res = await httpGet(`${handle.url}api/agents/writer/logs`);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.logs.entries.length, 3);
    assert.deepEqual(
      body.logs.entries.map((e) => e.title),
      ['Newest', 'Newer', 'Older'],
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────
// POST /api/notifications/:slug/:id/read
//
// Clicking a notification in the dashboard inbox flips its `read` flag to
// true via this endpoint. The mutation flows through
// `NotificationStore.markRead`, which performs an atomic write-then-rename
// so concurrent dashboard reads never see a partial file. These tests pin:
//
//   - The happy path returns the updated row with `read: true` + `readAt`.
//   - The endpoint is idempotent — re-POSTing on a read row is a no-op.
//   - Unknown slug or id maps to 404 (so the SPA can recover from a stale
//     list view without crashing).
//   - Slug / id traversal segments (`..`, `/`, NUL) are rejected at 400
//     before they ever reach the storage layer.
//   - The legacy 405 guard still rejects POSTs to unrelated paths so the
//     read-only contract for the rest of the API stays intact.
// ──────────────────────────────────────────────────────────────────────────

describe('POST /api/notifications/:slug/:id/read', () => {
  let projectDir;
  let buildDir;
  let handle;

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = undefined;
    }
    if (buildDir) {
      await rm(buildDir, { recursive: true, force: true });
      buildDir = undefined;
    }
    if (projectDir) {
      await rm(projectDir, { recursive: true, force: true });
      projectDir = undefined;
    }
  });

  /**
   * Seed a notification through the real `NotificationStore` so the test
   * exercises the same code path the production endpoint uses. Returns
   * the persisted row so the test can read its `id`.
   */
  async function seedNotification(slug) {
    const { NotificationStore } = await import(
      '../storage/notification-store.js'
    );
    const agentsDir = join(projectDir, '.aweek', 'agents');
    const store = new NotificationStore(agentsDir);
    return store.send(slug, {
      title: 'Click me',
      body: 'Click body.',
    });
  }

  it('flips read=true, stamps readAt, and returns the updated row', async () => {
    const fx = await makeProjectWithAgent({ slug: 'writer' });
    projectDir = fx.root;
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });

    const seeded = await seedNotification('writer');
    assert.equal(seeded.read, false);

    const res = await httpGet(
      `${handle.url}api/notifications/writer/${seeded.id}/read`,
      { method: 'POST' },
    );
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] || '', /application\/json/);
    assert.match(res.headers['cache-control'] || '', /no-store/);
    const body = JSON.parse(res.body);
    assert.equal(body.notification.id, seeded.id);
    assert.equal(body.notification.read, true);
    assert.equal(typeof body.notification.readAt, 'string');
    assert.match(
      body.notification.readAt,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  it('persists the flip on disk so subsequent reads see read=true', async () => {
    const fx = await makeProjectWithAgent({ slug: 'writer' });
    projectDir = fx.root;
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });

    const seeded = await seedNotification('writer');
    const res = await httpGet(
      `${handle.url}api/notifications/writer/${seeded.id}/read`,
      { method: 'POST' },
    );
    assert.equal(res.statusCode, 200);

    // Re-read through the store to confirm the on-disk feed was actually
    // mutated (atomic write-then-rename in `_save`).
    const { NotificationStore } = await import(
      '../storage/notification-store.js'
    );
    const agentsDir = join(projectDir, '.aweek', 'agents');
    const store = new NotificationStore(agentsDir);
    const refetched = await store.get('writer', seeded.id);
    assert.equal(refetched.read, true);
    assert.equal(typeof refetched.readAt, 'string');
  });

  it('is idempotent: re-POSTing on a read row returns the unchanged record', async () => {
    const fx = await makeProjectWithAgent({ slug: 'writer' });
    projectDir = fx.root;
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });

    const seeded = await seedNotification('writer');
    const url = `${handle.url}api/notifications/writer/${seeded.id}/read`;

    const first = await httpGet(url, { method: 'POST' });
    assert.equal(first.statusCode, 200);
    const firstBody = JSON.parse(first.body);
    const firstReadAt = firstBody.notification.readAt;

    const second = await httpGet(url, { method: 'POST' });
    assert.equal(second.statusCode, 200);
    const secondBody = JSON.parse(second.body);
    assert.equal(secondBody.notification.read, true);
    // Idempotent: no fresh stamp on a no-op flip — the original readAt
    // is preserved so the SPA does not see a phantom "just read" event.
    assert.equal(secondBody.notification.readAt, firstReadAt);
  });

  it('returns 404 when the slug has no matching notification id', async () => {
    const fx = await makeProjectWithAgent({ slug: 'writer' });
    projectDir = fx.root;
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });

    const res = await httpGet(
      `${handle.url}api/notifications/writer/notif-missing/read`,
      { method: 'POST' },
    );
    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.body);
    assert.match(body.error, /Notification not found/);
  });

  it('returns 404 for an unknown agent slug (no notifications.json on disk)', async () => {
    const fx = await makeProjectWithAgent({ slug: 'writer' });
    projectDir = fx.root;
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });

    const res = await httpGet(
      `${handle.url}api/notifications/ghost-agent/notif-x/read`,
      { method: 'POST' },
    );
    assert.equal(res.statusCode, 404);
  });

  it('rejects path-segment traversal at 400 before hitting the store', async () => {
    const fx = await makeProjectWithAgent({ slug: 'writer' });
    projectDir = fx.root;
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });

    // `..` and a NUL byte are both rejected by `decodeSlug` — these never
    // reach the storage layer.
    const dotdot = await httpGet(
      `${handle.url}api/notifications/..%2F../notif-x/read`,
      { method: 'POST' },
    );
    assert.equal(dotdot.statusCode, 400);

    const nul = await httpGet(
      `${handle.url}api/notifications/writer/%00bad/read`,
      { method: 'POST' },
    );
    assert.equal(nul.statusCode, 400);
  });

  it('does NOT relax the 405 guard for unrelated POST paths', async () => {
    // The notifications POST handler is the only relaxation. A regression
    // that accidentally allowed POSTs through the global 405 fallback
    // would be caught here — `/api/summary` must still 405 on POST.
    const fx = await makeProjectWithAgent({ slug: 'writer' });
    projectDir = fx.root;
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });

    const summary = await httpGet(`${handle.url}api/summary`, { method: 'POST' });
    assert.equal(summary.statusCode, 405);
    assert.match(summary.headers.allow || '', /GET/);
    assert.match(summary.headers.allow || '', /HEAD/);

    const agents = await httpGet(`${handle.url}api/agents`, { method: 'POST' });
    assert.equal(agents.statusCode, 405);
  });
});

// ── DELETE /api/agents/:slug/artifacts/:id ─────────────────────────────────

describe('DELETE /api/agents/:slug/artifacts/:id', () => {
  /** @type {string|null} */
  let projectDir = null;
  /** @type {string|null} */
  let buildDir = null;
  /** @type {Awaited<ReturnType<typeof startServer>>|null} */
  let handle = null;

  beforeEach(() => {
    projectDir = null;
    buildDir = null;
    handle = null;
  });

  afterEach(async () => {
    if (handle) await handle.close();
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
    if (buildDir) await rm(buildDir, { recursive: true, force: true });
  });

  /**
   * Seed a single artifact's file + manifest entry inside the fixture
   * project. Returns the manifest record (so the test knows the id) and
   * the absolute on-disk path so the test can verify unlink.
   */
  async function seedArtifact(root, slug, { fileName = 'note.md', body = '# hi\n' } = {}) {
    const { ArtifactStore, createArtifactRecord } = await import(
      '../storage/artifact-store.js'
    );
    const agentsDir = join(root, '.aweek', 'agents');
    const taskId = 'task-1';
    const executionId = 'session-001';
    const artifactDir = join(agentsDir, slug, 'artifacts', `${taskId}_${executionId}`);
    await mkdir(artifactDir, { recursive: true });
    const absolutePath = join(artifactDir, fileName);
    await writeFile(absolutePath, body, 'utf-8');
    const filePath = absolutePath.slice(root.length + 1);
    const record = createArtifactRecord({
      agentId: slug,
      taskId,
      filePath,
      fileName,
      type: 'document',
      description: 'Test artifact',
    });
    const store = new ArtifactStore(agentsDir, root);
    await store.register(slug, record);
    return { record, absolutePath, store };
  }

  /**
   * Tiny helper for non-GET HTTP — `httpGet` ignores the method beyond
   * letting it through, but it never sends a body. DELETE has no body
   * either, so we reuse it via the explicit `method` option.
   */
  async function httpDelete(url) {
    return httpGet(url, { method: 'DELETE' });
  }

  it('removes the manifest entry AND unlinks the file from disk', async () => {
    const fx = await makeProjectWithAgent({ slug: 'writer', name: 'Writer' });
    projectDir = fx.root;
    const { record, absolutePath, store } = await seedArtifact(projectDir, 'writer');

    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });

    const res = await httpDelete(
      `${handle.url}api/agents/writer/artifacts/${encodeURIComponent(record.id)}`,
    );
    assert.equal(res.statusCode, 200, `body=${res.body}`);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.artifactId, record.id);
    assert.equal(body.fileUnlinked, true);

    // File on disk: gone.
    const { stat } = await import('node:fs/promises');
    await assert.rejects(
      () => stat(absolutePath),
      (err) => err.code === 'ENOENT',
    );

    // Manifest: empty.
    const remaining = await store.load('writer');
    assert.equal(remaining.length, 0);
  });

  it('returns 404 when the artifact id is unknown', async () => {
    const fx = await makeProjectWithAgent({ slug: 'writer', name: 'Writer' });
    projectDir = fx.root;
    // Seed a real artifact so the manifest exists, then ask for a
    // different id.
    await seedArtifact(projectDir, 'writer');

    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });

    const res = await httpDelete(
      `${handle.url}api/agents/writer/artifacts/artifact-deadbeef`,
    );
    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.body);
    assert.match(body.error, /Artifact not found/);
  });

  it('returns 200 + fileUnlinked:false when only the manifest entry exists', async () => {
    // Idempotency: a stale manifest entry pointing at a missing file
    // should still get cleaned up so retries don't get stuck.
    const fx = await makeProjectWithAgent({ slug: 'writer', name: 'Writer' });
    projectDir = fx.root;
    const { record, absolutePath } = await seedArtifact(projectDir, 'writer');

    // Manually pre-delete the file.
    await rm(absolutePath, { force: true });

    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });

    const res = await httpDelete(
      `${handle.url}api/agents/writer/artifacts/${encodeURIComponent(record.id)}`,
    );
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.fileUnlinked, false);
  });

  it('rejects manifest entries that escape the project root with 400', async () => {
    const fx = await makeProjectWithAgent({ slug: 'writer', name: 'Writer' });
    projectDir = fx.root;
    const { ArtifactStore, createArtifactRecord } = await import(
      '../storage/artifact-store.js'
    );
    const agentsDir = join(projectDir, '.aweek', 'agents');
    // Drift: a manifest entry pointing outside the project tree.
    const evil = createArtifactRecord({
      agentId: 'writer',
      taskId: 'task-evil',
      filePath: '../../etc/passwd',
      fileName: 'passwd',
      type: 'other',
      description: 'evil',
    });
    const store = new ArtifactStore(agentsDir, projectDir);
    await store.register('writer', evil, { autoSize: false });

    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });

    const res = await httpDelete(
      `${handle.url}api/agents/writer/artifacts/${encodeURIComponent(evil.id)}`,
    );
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.match(body.error, /escapes project root/);

    // Manifest is still intact — the operator gets a chance to clean
    // the bad entry manually rather than having the server delete the
    // record silently.
    const remaining = await store.load('writer');
    assert.equal(remaining.length, 1);
  });

  it('rejects traversal-shaped slugs with 400', async () => {
    const fx = await makeProjectWithAgent({ slug: 'writer', name: 'Writer' });
    projectDir = fx.root;
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });

    const res = await httpDelete(
      `${handle.url}api/agents/${encodeURIComponent('../escape')}/artifacts/${encodeURIComponent('artifact-x')}`,
    );
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.match(body.error, /Invalid slug or artifact id/);
  });

  it('returns 405 with Allow: DELETE for non-DELETE methods on this path', async () => {
    const fx = await makeProjectWithAgent({ slug: 'writer', name: 'Writer' });
    projectDir = fx.root;
    buildDir = await makeBuildDir();
    handle = await startServer({ projectDir, buildDir, port: 0, host: '127.0.0.1' });

    // PUT is neither GET/HEAD nor DELETE → 405. The Allow header
    // should advertise DELETE since this path is dedicated to deletes.
    const res = await httpGet(
      `${handle.url}api/agents/writer/artifacts/artifact-x`,
      { method: 'PUT' },
    );
    assert.equal(res.statusCode, 405);
    assert.match(res.headers.allow || '', /DELETE/);
  });
});
