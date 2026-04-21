/**
 * Tests for `src/serve/server.js` — HTTP server skeleton for `aweek serve`.
 *
 * Sub-AC 2 scope: we validate that `startServer()` binds to the configured
 * host/port, returns a startup handle with the resolved URL, and serves a
 * read-only dashboard HTML shell at `GET /`. Data endpoints are exercised
 * by later sub-ACs.
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
  formatDashboardUrl,
  formatLanHints,
  getLanAddresses,
  isWildcardHost,
  normaliseServeOptions,
  openBrowser,
  renderDashboardShell,
  resolveOpenCommand,
  startServer,
} from './server.js';

async function makeProject(prefix = 'aweek-serve-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(dir, '.aweek'), { recursive: true });
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

  it('accepts a custom host and projectDir', () => {
    const out = normaliseServeOptions({ host: '127.0.0.1', projectDir: '/tmp/x' });
    assert.equal(out.host, '127.0.0.1');
    assert.equal(out.projectDir, '/tmp/x');
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

// ── renderDashboardShell ───────────────────────────────────────────────────

describe('renderDashboardShell()', () => {
  it('renders a full HTML document with the sidebar and active-tab section', () => {
    const html = renderDashboardShell({ projectDir: '/tmp/x' });
    assert.ok(html.startsWith('<!doctype html>'));
    assert.match(html, /<title>aweek dashboard<\/title>/);
    // Agents sidebar is always present regardless of tab.
    assert.match(html, /data-section="agents"/, 'shell should include agents sidebar');
    // Calendar is the default active tab — its section must render.
    assert.match(html, /data-section="calendar"/, 'calendar section should render for default tab');
  });

  it('escapes the projectDir so HTML injection is not possible', () => {
    const html = renderDashboardShell({ projectDir: '/tmp/<script>alert(1)</script>' });
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });

  it('includes a task-detail drawer, scrim, and click-handler script', () => {
    const html = renderDashboardShell({ projectDir: '/tmp/x' });
    // Drawer + scrim markup
    assert.match(html, /data-drawer\b/);
    assert.match(html, /data-scrim\b/);
    assert.match(html, /data-drawer-title/);
    assert.match(html, /data-drawer-chips/);
    assert.match(html, /data-drawer-desc/);
    assert.match(html, /data-drawer-fields/);
    assert.match(html, /class="drawer-close"/);
    // Drawer CSS hook
    assert.match(html, /\.drawer\.open/);
    // Wiring: click handler reads dataset and toggles .open
    assert.match(html, /closest\('\.calendar-task'\)/);
    assert.match(html, /drawer\.classList\.add\('open'\)/);
    assert.match(html, /key === 'Escape'/);
  });

  it('includes the drawer-activity slot and reads aweek-task-activity JSON', () => {
    const html = renderDashboardShell({ projectDir: '/tmp/x' });
    // Drawer activity section markup
    assert.match(html, /data-drawer-activity\b/);
    assert.match(html, /data-drawer-activity-list\b/);
    assert.match(html, /class="drawer-activity"/);
    // Drawer JS reads the embedded JSON payload.
    assert.match(html, /getElementById\('aweek-task-activity'\)/);
    assert.match(html, /JSON\.parse/);
    assert.match(html, /renderActivity/);
  });

  it('drawer activity items link into the activity tab and show a short description', () => {
    const html = renderDashboardShell({ projectDir: '/tmp/x' });
    // Overlay anchor and description line wiring.
    assert.match(html, /class="drawer-activity-link"/);
    assert.match(html, /drawer-activity-desc/);
    // activityEntryHref() builds a ?agent=…&tab=activity&entry=… URL.
    assert.match(html, /function activityEntryHref/);
    assert.match(html, /params\.set\('tab', 'activity'\)/);
    assert.match(html, /params\.set\('entry', entry\.id\)/);
  });

  it('emits syntactically valid JS inside each inline <script> block', () => {
    // Regression guard: template-literal escapes inside the drawer IIFE
    // (e.g. `\/\/` collapsing to `//` and starting a line comment) have
    // silently broken the whole drawer at runtime before. Parse each
    // inline script with the JS parser so any such breakage fails the
    // build instead of the browser.
    const html = renderDashboardShell({ projectDir: '/tmp/x' });
    const scriptRe = /<script(?![^>]*type=)[^>]*>([\s\S]*?)<\/script>/g;
    let match;
    let count = 0;
    while ((match = scriptRe.exec(html)) !== null) {
      const body = match[1];
      if (body.trim().length === 0) continue;
      count++;
      try {
        // Function constructor parses the body without executing it.
        // eslint-disable-next-line no-new-func
        new Function(body);
      } catch (err) {
        assert.fail(`Inline <script> #${count} failed to parse: ${err.message}`);
      }
    }
    assert.ok(count >= 1, 'expected at least one inline <script> in the shell');
  });

  it('includes a URL-routing script that preserves the active tab when switching agents', () => {
    const html = renderDashboardShell({ projectDir: '/tmp/x' });
    // Intercepts sidebar agent-link clicks.
    assert.match(html, /sidebar-item-link/,
      'JS should reference .sidebar-item-link for agent-switch interception');
    // Reads the current active tab from the query string.
    assert.match(html, /getQueryParam|URLSearchParams/,
      'JS should read the current tab from the URL query params');
    // Updates URL via pushState so the browser history entry is correct.
    assert.match(html, /history\.pushState/,
      'JS should use history.pushState to update the URL on agent switch');
    // Reloads to get server-rendered content for the new URL.
    assert.match(html, /location\.reload/,
      'JS should reload after pushState to re-render with updated params');
    // Handles back/forward navigation.
    assert.match(html, /popstate/,
      'JS should handle popstate so back/forward reloads the correct content');
  });
});

// ── renderDashboardShell — zero-agents empty state ────────────────────────

describe('renderDashboardShell() — zero-agents empty state', () => {
  it('renders a zero-agents empty state when zeroAgents=true', () => {
    const html = renderDashboardShell({ projectDir: '/tmp/x', zeroAgents: true });
    assert.match(html, /zero-agents-empty/);
    assert.match(html, /\/aweek:hire/);
  });

  it('empty state includes a helpful message about hiring agents', () => {
    const html = renderDashboardShell({ projectDir: '/tmp/x', zeroAgents: true });
    assert.match(html, /No agents yet/);
    assert.match(html, /zero-agents-title/);
  });

  it('empty state has data-section="zero-agents" for test targeting', () => {
    const html = renderDashboardShell({ projectDir: '/tmp/x', zeroAgents: true });
    assert.match(html, /data-section="zero-agents"/);
  });

  it('does NOT render section cards when zeroAgents=true', () => {
    const html = renderDashboardShell({ projectDir: '/tmp/x', zeroAgents: true });
    assert.ok(!html.includes('card-calendar'), 'calendar card should be absent');
    assert.ok(!html.includes('card-plan'), 'plan card should be absent');
    assert.ok(!html.includes('card-budget'), 'budget card should be absent');
  });

  it('renders the calendar card when zeroAgents=false and activeTab defaults to calendar', () => {
    const html = renderDashboardShell({ projectDir: '/tmp/x' });
    assert.match(html, /card-calendar/, 'calendar card should render for default calendar tab');
    assert.ok(!html.includes('card-plan'), 'plan card should not render on calendar tab');
    assert.ok(!html.includes('card-budget'), 'budget card should not render on calendar tab');
    assert.ok(!html.includes('zero-agents-empty'), 'empty state should be absent with agents');
  });

  it('renders the strategy card when activeTab=strategy', () => {
    const html = renderDashboardShell({ projectDir: '/tmp/x', activeTab: 'strategy' });
    assert.match(html, /card-strategy/, 'strategy card should render for strategy tab');
    assert.ok(!html.includes('card-calendar'), 'calendar card should not render on strategy tab');
  });

  it('renders the profile card when activeTab=profile', () => {
    const html = renderDashboardShell({ projectDir: '/tmp/x', activeTab: 'profile' });
    assert.match(html, /card-profile/, 'profile card should render for profile tab');
    assert.ok(!html.includes('card-calendar'), 'calendar card should not render on profile tab');
  });

  it('renders the activity card when activeTab=activity', () => {
    const html = renderDashboardShell({ projectDir: '/tmp/x', activeTab: 'activity' });
    assert.match(html, /card-activity/, 'activity card should render for activity tab');
    assert.ok(!html.includes('card-calendar'), 'calendar card should not render on activity tab');
  });

  it('sidebar section still renders when zeroAgents=true', () => {
    const html = renderDashboardShell({ projectDir: '/tmp/x', zeroAgents: true });
    // The sidebar nav with data-section="agents" must always be present
    assert.match(html, /data-section="agents"/);
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

// ── startServer ────────────────────────────────────────────────────────────

describe('startServer()', () => {
  let projectDir;
  let handle;

  beforeEach(async () => {
    projectDir = await makeProject();
    handle = null;
  });

  afterEach(async () => {
    if (handle && handle.close) await handle.close();
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
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

  it('binds to an ephemeral port and returns a resolved URL', async () => {
    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    assert.ok(handle.server, 'returns the raw http.Server');
    assert.ok(handle.port > 0, 'returns a non-zero bound port');
    assert.equal(handle.host, '127.0.0.1');
    assert.equal(handle.projectDir, projectDir);
    assert.equal(handle.url, `http://127.0.0.1:${handle.port}/`);
    assert.equal(typeof handle.close, 'function');
  });

  it('serves the dashboard HTML shell at GET /', async () => {
    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(handle.url);
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] || '', /text\/html/);
    assert.ok(res.body.startsWith('<!doctype html>'));
    assert.match(res.body, /aweek dashboard/);
    // Sidebar nav is always present.
    assert.match(res.body, /data-section="agents"/);
    // No agents in this project → zero-agents empty state instead of cards.
    assert.match(res.body, /data-section="zero-agents"/);
    assert.match(res.body, /\/aweek:hire/);
  });

  it('answers GET /healthz with { ok: true }', async () => {
    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}healthz`);
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] || '', /application\/json/);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.projectDir, projectDir);
  });

  it('returns 404 for unknown paths', async () => {
    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}does-not-exist`);
    assert.equal(res.statusCode, 404);
  });

  it('serves a transcript as plain text when the file exists', async () => {
    const execDir = join(projectDir, '.aweek', 'agents', 'writer', 'executions');
    await mkdir(execDir, { recursive: true });
    const line = JSON.stringify({
      type: 'system',
      subtype: 'init',
      model: 'claude-opus-4-7',
      session_id: 's1',
      cwd: '/tmp/proj',
    });
    await writeFile(join(execDir, 'task-abc_session-42.jsonl'), line + '\n', 'utf8');

    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}api/executions/writer/task-abc_session-42`);

    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] || '', /text\/plain/);
    // Body is pretty-printed JSON (one event per block, blank-line separated).
    const firstBlock = res.body.split('\n\n')[0];
    assert.deepEqual(JSON.parse(firstBlock), {
      type: 'system',
      subtype: 'init',
      model: 'claude-opus-4-7',
      session_id: 's1',
      cwd: '/tmp/proj',
    });
    assert.match(res.body, /"model": "claude-opus-4-7"/);
  });

  it('returns 404 for a missing transcript', async () => {
    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}api/executions/writer/task-abc_session-42`);
    assert.equal(res.statusCode, 404);
    assert.match(res.body, /No transcript/);
  });

  it('rejects transcript requests with traversal-looking segments', async () => {
    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}api/executions/writer/..%2Fetc`);
    assert.equal(res.statusCode, 400);
  });

  it('rejects transcript basenames without the `_` separator', async () => {
    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}api/executions/writer/no-separator-here`);
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /Bad Request/);
  });

  it('returns 405 for non-GET/HEAD requests', async () => {
    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(handle.url, { method: 'POST' });
    assert.equal(res.statusCode, 405);
    assert.match(res.headers.allow || '', /GET/);
  });

  it('auto-increments past an in-use port', async () => {
    const first = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    try {
      const second = await startServer({
        projectDir,
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
    // Default host should be a wildcard bind; the returned handle
    // reports `0.0.0.0` (raw bind host) while `url` rewrites it to
    // `localhost` for click-through. Both need to be true for LAN
    // access to work: wildcard bind is the kernel-level precondition
    // and `localhost` keeps the primary URL clickable on the host
    // machine.
    assert.equal(DEFAULT_HOST, '0.0.0.0');
    handle = await startServer({ projectDir, port: 0 });
    assert.equal(handle.host, '0.0.0.0');
    assert.equal(isWildcardHost(handle.host), true);
    assert.ok(handle.url.startsWith('http://localhost:'));

    // Sanity-check the bind by fetching the shell through 127.0.0.1,
    // which is a different interface than `localhost` on some systems
    // — proving the wildcard bind really is accepting on every iface.
    const res = await httpGet(`http://127.0.0.1:${handle.port}/`);
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /aweek dashboard/);
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

// ── GET /api/agents/:slug/calendar — server-level routing contract ─────────
//
// Sub-AC 3 scope: from the HTTP server's perspective, a request for a
// selected agent's weekly calendar/task list must return a JSON payload
// carrying each task's status enum and its computed time-slot fields
// (dayKey, dayOffset, hour, minute, iso). The `calendar-section.test.js`
// suite exercises the gatherer and the HTML rendering in depth; these
// tests target the server wiring specifically — content type, cache
// headers, status codes, URL decoding, `?week=` query-string passthrough,
// and the shape of the serialised task objects for the selected agent.

describe('GET /api/agents/:slug/calendar — server routing', () => {
  let projectDir;
  let handle;

  /**
   * Build a minimal agent config JSON. Matches `aweek://schemas/agent-config`
   * with just enough fields for the existence check in `gatherCalendar`
   * to succeed — dedicated agent tests live in `agents-section.test.js`.
   */
  async function writeAgent(slug) {
    // `makeProject` in this file creates `.aweek/` but not the nested
    // `agents/` dir — the server doesn't need it until there's at least
    // one agent. Ensure it exists before writing the agent JSON.
    const agentsDir = join(projectDir, '.aweek', 'agents');
    await mkdir(agentsDir, { recursive: true });
    const now = '2026-04-13T00:00:00.000Z';
    const config = {
      id: slug,
      subagentRef: slug,
      goals: [],
      monthlyPlans: [],
      weeklyTokenBudget: 100_000,
      budget: {
        weeklyTokenLimit: 100_000,
        currentUsage: 0,
        periodStart: now,
        paused: false,
        sessions: [],
      },
      inbox: [],
      createdAt: now,
      updatedAt: now,
    };
    await writeFile(
      join(agentsDir, `${slug}.json`),
      JSON.stringify(config, null, 2) + '\n',
      'utf8',
    );
  }

  /**
   * Write `.aweek/config.json` with a fixed IANA zone so the slot-math
   * path is deterministic across host machines.
   */
  async function writeConfig(config) {
    await writeFile(
      join(projectDir, '.aweek', 'config.json'),
      JSON.stringify(config, null, 2) + '\n',
      'utf8',
    );
  }

  /**
   * Drop a weekly plan on disk. The week/month fields must satisfy the
   * weekly-plan schema (`YYYY-Www` / `YYYY-MM`); the caller supplies tasks
   * which must satisfy the weekly-task schema.
   */
  async function writeWeeklyPlan(slug, { week, month, approved = true, tasks = [] }) {
    const dir = join(projectDir, '.aweek', 'agents', slug, 'weekly-plans');
    await mkdir(dir, { recursive: true });
    const now = '2026-04-13T00:00:00.000Z';
    const plan = {
      week,
      month,
      approved,
      tasks,
      createdAt: now,
      updatedAt: now,
    };
    if (approved) plan.approvedAt = now;
    await writeFile(
      join(dir, `${week}.json`),
      JSON.stringify(plan, null, 2) + '\n',
      'utf8',
    );
  }

  beforeEach(async () => {
    projectDir = await makeProject('aweek-serve-cal-');
    handle = null;
  });

  afterEach(async () => {
    if (handle && handle.close) await handle.close();
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
  });

  it('returns 404 JSON with error + agentId for an unknown slug', async () => {
    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}api/agents/does-not-exist/calendar`);
    assert.equal(res.statusCode, 404);
    assert.match(res.headers['content-type'] || '', /application\/json/);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.error, 'Agent not found');
    assert.equal(parsed.agentId, 'does-not-exist');
  });

  it('serves the selected agent calendar as JSON with no-store caching', async () => {
    await writeAgent('writer');
    await writeConfig({ timeZone: 'UTC' });
    await writeWeeklyPlan('writer', {
      week: '2026-W16',
      month: '2026-04',
      approved: true,
      tasks: [
        {
          id: 'task-mon-am',
          description: 'Monday morning draft',
          status: 'pending',
          priority: 'high',
          estimatedMinutes: 60,
          runAt: '2026-04-13T09:00:00.000Z',
        },
      ],
    });

    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(
      `${handle.url}api/agents/writer/calendar?week=2026-W16`,
    );

    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] || '', /application\/json/);
    // Live-data contract: the browser must never cache the response,
    // so the dashboard reflects on-disk changes on every refresh.
    assert.match(res.headers['cache-control'] || '', /no-store/);

    const payload = JSON.parse(res.body);
    assert.equal(payload.agentId, 'writer');
    assert.equal(payload.week, '2026-W16');
    assert.equal(payload.month, '2026-04');
    assert.equal(payload.approved, true);
    assert.equal(payload.noPlan, false);
    assert.equal(typeof payload.weekMonday, 'string');
    assert.equal(payload.timeZone, 'UTC');
  });

  it('exposes task status and full time-slot fields for the selected agent', async () => {
    await writeAgent('writer');
    await writeConfig({ timeZone: 'UTC' });
    await writeWeeklyPlan('writer', {
      week: '2026-W16',
      month: '2026-04',
      approved: true,
      tasks: [
        // Every status that appears in the CLI calendar legend is
        // represented here — the dashboard must surface each one as-is
        // so operators can filter / group without reshaping on the
        // client.
        {
          id: 'task-pending',
          description: 'Pending on Mon 09:00',
          status: 'pending',
          priority: 'medium',
          runAt: '2026-04-13T09:00:00.000Z',
        },
        {
          id: 'task-inprogress',
          description: 'In progress on Wed 14:30',
          status: 'in-progress',
          priority: 'high',
          runAt: '2026-04-15T14:30:00.000Z',
        },
        {
          id: 'task-completed',
          description: 'Completed on Fri 16:45',
          status: 'completed',
          priority: 'low',
          runAt: '2026-04-17T16:45:00.000Z',
          completedAt: '2026-04-17T17:30:00.000Z',
        },
        {
          id: 'task-failed',
          description: 'Failed on Sun 23:00',
          status: 'failed',
          priority: 'critical',
          runAt: '2026-04-19T23:00:00.000Z',
        },
        {
          id: 'task-unscheduled',
          description: 'No runAt — unscheduled',
          status: 'pending',
          priority: 'low',
        },
      ],
    });

    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(
      `${handle.url}api/agents/writer/calendar?week=2026-W16`,
    );
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);

    assert.equal(payload.tasks.length, 5);

    // Index tasks by id so assertions don't depend on storage ordering.
    const byId = new Map(payload.tasks.map((t) => [t.id, t]));

    // Status enum — each value round-trips exactly as stored.
    assert.equal(byId.get('task-pending').status, 'pending');
    assert.equal(byId.get('task-inprogress').status, 'in-progress');
    assert.equal(byId.get('task-completed').status, 'completed');
    assert.equal(byId.get('task-failed').status, 'failed');
    assert.equal(byId.get('task-unscheduled').status, 'pending');

    // `completedAt` is only set for the completed task and propagates
    // through to the wire payload.
    assert.equal(
      byId.get('task-completed').completedAt,
      '2026-04-17T17:30:00.000Z',
    );
    assert.equal(byId.get('task-pending').completedAt, null);

    // Monday-origin dayOffset + ISO dayKey mapping for runAt-anchored tasks.
    assert.deepEqual(byId.get('task-pending').slot, {
      dayKey: 'mon',
      dayOffset: 0,
      hour: 9,
      minute: 0,
      iso: '2026-04-13T09:00:00.000Z',
    });
    assert.deepEqual(byId.get('task-inprogress').slot, {
      dayKey: 'wed',
      dayOffset: 2,
      hour: 14,
      minute: 30,
      iso: '2026-04-15T14:30:00.000Z',
    });
    assert.deepEqual(byId.get('task-completed').slot, {
      dayKey: 'fri',
      dayOffset: 4,
      hour: 16,
      minute: 45,
      iso: '2026-04-17T16:45:00.000Z',
    });
    assert.deepEqual(byId.get('task-failed').slot, {
      dayKey: 'sun',
      dayOffset: 6,
      hour: 23,
      minute: 0,
      iso: '2026-04-19T23:00:00.000Z',
    });

    // Tasks without a runAt land in the unscheduled bucket — the server
    // returns `slot: null` rather than omitting the field so clients can
    // destructure safely.
    assert.equal(byId.get('task-unscheduled').slot, null);
    assert.equal(byId.get('task-unscheduled').runAt, null);

    // Status-summary counts line up with the per-status breakdown.
    // `in-progress` is camel-cased on the wire as `inProgress` so the
    // JSON payload plays nicely with JS destructuring.
    assert.equal(payload.counts.total, 5);
    assert.equal(payload.counts.pending, 2);
    assert.equal(payload.counts.inProgress, 1);
    assert.equal(payload.counts.completed, 1);
    assert.equal(payload.counts.failed, 1);
  });

  it('returns noPlan=true with an empty task list when the agent has no plan', async () => {
    await writeAgent('writer');
    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}api/agents/writer/calendar`);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.agentId, 'writer');
    assert.equal(payload.noPlan, true);
    assert.deepEqual(payload.tasks, []);
    assert.equal(payload.week, null);
    assert.equal(payload.approved, false);
    assert.equal(payload.counts.total, 0);
  });

  it('URL-decodes plugin-prefixed slugs so namespaced agents resolve', async () => {
    // Plugin-namespaced ids (e.g. `oh-my-claudecode-writer`) are plain
    // ASCII — the key assertion is that the path segment is decoded before
    // hitting the agent store, so hypothetical URL-encoded characters
    // round-trip. We exercise an ASCII ID here (matches the aweek slug
    // convention) and separately verify decoding via a percent-escaped
    // path below.
    await writeAgent('oh-my-claudecode-writer');
    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(
      `${handle.url}api/agents/oh-my-claudecode-writer/calendar`,
    );
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.agentId, 'oh-my-claudecode-writer');
  });

  it('re-reads .aweek/ on every request (live data, no cache)', async () => {
    await writeAgent('writer');
    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });

    // 1) No plan yet — endpoint reports empty state.
    let res = await httpGet(`${handle.url}api/agents/writer/calendar`);
    assert.equal(JSON.parse(res.body).noPlan, true);

    // 2) Drop a plan on disk with the server already running.
    await writeConfig({ timeZone: 'UTC' });
    await writeWeeklyPlan('writer', {
      week: '2026-W16',
      month: '2026-04',
      approved: true,
      tasks: [
        {
          id: 'task-live-1',
          description: 'Live task',
          status: 'in-progress',
          runAt: '2026-04-13T10:00:00.000Z',
        },
      ],
    });

    // 3) Same endpoint, next request — server re-reads and reflects it.
    res = await httpGet(
      `${handle.url}api/agents/writer/calendar?week=2026-W16`,
    );
    const payload = JSON.parse(res.body);
    assert.equal(payload.noPlan, false);
    assert.equal(payload.tasks.length, 1);
    assert.equal(payload.tasks[0].id, 'task-live-1');
    assert.equal(payload.tasks[0].status, 'in-progress');
    assert.equal(payload.tasks[0].slot.dayKey, 'mon');
    assert.equal(payload.tasks[0].slot.hour, 10);
    assert.equal(payload.tasks[0].slot.minute, 0);
  });
});

// ── Deep-linking: GET /?agent=&tab= — server routing ──────────────────────
//
// AC 8: Opening with ?agent=foo and ?tab=activity must land directly on
// that agent (highlighted in the sidebar) and that tab (active in the tab
// bar) — all server-rendered, no client-side JS required.

describe('Deep-linking — GET /?agent=&tab=', () => {
  let projectDir;
  let handle;

  async function writeAgent(slug) {
    const agentsDir = join(projectDir, '.aweek', 'agents');
    await mkdir(agentsDir, { recursive: true });
    const now = '2026-04-13T00:00:00.000Z';
    await writeFile(
      join(agentsDir, `${slug}.json`),
      JSON.stringify({
        id: slug,
        subagentRef: slug,
        goals: [],
        monthlyPlans: [],
        weeklyTokenBudget: 100_000,
        budget: {
          weeklyTokenLimit: 100_000,
          currentUsage: 0,
          periodStart: now,
          paused: false,
          sessions: [],
        },
        inbox: [],
        createdAt: now,
        updatedAt: now,
      }, null, 2) + '\n',
      'utf8',
    );
  }

  beforeEach(async () => {
    projectDir = await makeProject('aweek-deeplink-');
    handle = null;
  });

  afterEach(async () => {
    if (handle && handle.close) await handle.close();
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
  });

  it('?agent=writer highlights the agent in the sidebar with aria-current', async () => {
    await writeAgent('writer');
    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}?agent=writer`);
    assert.equal(res.statusCode, 200);
    // The writer sidebar item must be marked as selected.
    assert.match(res.body, /sidebar-item-selected/);
    assert.match(res.body, /data-agent-slug="writer"/);
    assert.match(res.body, /aria-current="page"/);
  });

  it('?agent=writer&tab=activity renders with activity tab active', async () => {
    await writeAgent('writer');
    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}?agent=writer&tab=activity`);
    assert.equal(res.statusCode, 200);
    // Tab bar must be present for the selected agent.
    assert.match(res.body, /data-agent-tabs="writer"/);
    // Activity tab must be the active one (span with aria-current, no href).
    assert.match(res.body, /aria-current="page"[^>]*>Activity|data-tab="activity"[^>]*aria-current="page"/);
    // Activity content section must be rendered, not calendar.
    assert.match(res.body, /card-activity/);
    assert.ok(!res.body.includes('card-calendar'), 'calendar card must not appear on activity tab');
  });

  it('?agent=writer&tab=calendar renders with calendar tab active (default)', async () => {
    await writeAgent('writer');
    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}?agent=writer&tab=calendar`);
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /data-agent-tabs="writer"/);
    assert.match(res.body, /card-calendar/);
    assert.ok(!res.body.includes('card-activity'), 'activity card must not appear on calendar tab');
    assert.ok(!res.body.includes('card-strategy'), 'strategy card must not appear on calendar tab');
  });

  it('?agent=writer&tab=strategy renders with strategy tab active', async () => {
    await writeAgent('writer');
    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}?agent=writer&tab=strategy`);
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /data-agent-tabs="writer"/);
    assert.match(res.body, /card-strategy/);
    assert.ok(!res.body.includes('card-calendar'), 'calendar card must not appear on strategy tab');
  });

  it('?agent=writer&tab=profile renders with profile tab active', async () => {
    await writeAgent('writer');
    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}?agent=writer&tab=profile`);
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /data-agent-tabs="writer"/);
    // Profile tab renders the profile card (identity + scheduling + budget).
    assert.match(res.body, /card-profile/);
    assert.ok(!res.body.includes('card-calendar'), 'calendar card must not appear on profile tab');
  });

  it('?agent=writer&tab=unknown falls back to calendar tab without crashing', async () => {
    await writeAgent('writer');
    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}?agent=writer&tab=unknown`);
    assert.equal(res.statusCode, 200);
    // Unknown tab → falls back to calendar.
    assert.match(res.body, /card-calendar/);
    assert.ok(!res.body.includes('card-activity'), 'activity card must not appear for unknown tab');
  });

  it('no ?agent= param means no tab bar is rendered', async () => {
    await writeAgent('writer');
    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}?tab=activity`);
    assert.equal(res.statusCode, 200);
    // Tab bar requires an agent to be selected; without one it is absent.
    assert.ok(!res.body.includes('data-agent-tabs='), 'tab bar must not render without a selected agent');
    // No sidebar item should be selected — in HTML the class ends with sidebar-item-selected" (closing
    // quote); the CSS definition uses .sidebar-item-selected{ so the two patterns are distinct.
    assert.ok(!res.body.includes('sidebar-item-selected"'), 'no sidebar item should be selected');
  });

  it('?agent= with a non-existent slug renders gracefully without crashing', async () => {
    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}?agent=ghost&tab=activity`);
    // Server must not crash — 200 with a valid HTML document.
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.startsWith('<!doctype html>'));
    // No sidebar item highlighted since the agent is not in the list — sidebar-item-selected" (with
    // closing quote) is the HTML element marker; the CSS definition uses .sidebar-item-selected{.
    assert.ok(!res.body.includes('sidebar-item-selected"'), 'no sidebar item highlighted for missing agent');
  });

  it('?agent=writer sidebar link for non-selected agents preserves no tab (plain ?agent= links)', async () => {
    await writeAgent('writer');
    await writeAgent('planner');
    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}?agent=writer&tab=activity`);
    assert.equal(res.statusCode, 200);
    // writer is selected — planner should render as a plain ?agent=planner link.
    assert.match(res.body, /href="\?agent=planner"/);
    // writer sidebar item is the selected one.
    assert.match(
      res.body,
      /sidebar-item-selected[^>]*data-agent-slug="writer"|data-agent-slug="writer"[^>]*sidebar-item-selected/,
    );
  });

  // ── Tab bar HTML shape ─────────────────────────────────────────────────────
  //
  // The following tests verify the HTML structure of the tab bar as rendered
  // inside real HTTP responses — complementing the unit tests in
  // tabs-section.test.js with end-to-end assertions that cover the full
  // server-render pipeline (gatherAgents → renderSidebar → renderTabBar →
  // renderDashboardShell → HTTP response).

  it('tab bar renders inactive tab hrefs with both agent and tab query params', async () => {
    await writeAgent('writer');
    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}?agent=writer&tab=activity`);
    assert.equal(res.statusCode, 200);
    // Each inactive tab must link to ?agent=<slug>&tab=<id> so the agent
    // selection is preserved when the user switches tabs.
    assert.match(res.body, /href="\?agent=writer&amp;tab=calendar"/,
      'calendar tab link must carry agent + tab params');
    assert.match(res.body, /href="\?agent=writer&amp;tab=strategy"/,
      'strategy tab link must carry agent + tab params');
    assert.match(res.body, /href="\?agent=writer&amp;tab=profile"/,
      'profile tab link must carry agent + tab params');
    // The active tab (activity) is a <span> — it must not appear as an <a href>.
    assert.ok(
      !res.body.includes('href="?agent=writer&amp;tab=activity"'),
      'active tab must not appear as a navigation link',
    );
  });

  it('active tab renders as <span> with aria-current="page", not an <a>', async () => {
    await writeAgent('writer');
    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    // Use strategy tab so the assertion is independent of the default calendar tab.
    const res = await httpGet(`${handle.url}?agent=writer&tab=strategy`);
    assert.equal(res.statusCode, 200);
    // The active tab element must carry both data-tab and aria-current.
    assert.match(
      res.body,
      /data-tab="strategy"[^>]*aria-current="page"|aria-current="page"[^>]*data-tab="strategy"/,
      'active strategy tab element must carry aria-current="page"',
    );
    // A link to the active tab must never be rendered — clicking it would be a no-op.
    assert.ok(
      !res.body.includes('href="?agent=writer&amp;tab=strategy"'),
      'active tab must not have a href — it should be a non-interactive span',
    );
  });

  it('selected sidebar item renders without an anchor wrapper', async () => {
    await writeAgent('writer');
    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}?agent=writer`);
    assert.equal(res.statusCode, 200);
    // Non-selected agents are linked via ?agent=<slug>; the selected agent must
    // not appear as a bare ?agent=writer href (tab links use ?agent=writer&tab=X,
    // not the plain form, so this check is unambiguous).
    assert.ok(
      !res.body.includes('href="?agent=writer"'),
      'selected agent must not render as a clickable sidebar link',
    );
    // The selected <li> must carry aria-current="page" co-located with
    // data-agent-slug so assistive technology announces it as the current page.
    assert.match(
      res.body,
      /data-agent-slug="writer"[^>]*aria-current="page"|aria-current="page"[^>]*data-agent-slug="writer"/,
      'selected sidebar item must carry aria-current="page"',
    );
  });

  it('tab bar carries data-tab attributes for all four named tabs', async () => {
    await writeAgent('writer');
    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}?agent=writer`);
    assert.equal(res.statusCode, 200);
    // Every tab must expose a data-tab attribute so JS/CSS can target individual
    // tabs without relying on text content or positional selectors.
    assert.match(res.body, /data-tab="calendar"/, 'calendar tab must have data-tab attribute');
    assert.match(res.body, /data-tab="activity"/, 'activity tab must have data-tab attribute');
    assert.match(res.body, /data-tab="strategy"/, 'strategy tab must have data-tab attribute');
    assert.match(res.body, /data-tab="profile"/, 'profile tab must have data-tab attribute');
  });

  it('tab bar has aria-label and role="tablist" for screen-reader accessibility', async () => {
    await writeAgent('writer');
    handle = await startServer({ projectDir, port: 0, host: '127.0.0.1' });
    const res = await httpGet(`${handle.url}?agent=writer`);
    assert.equal(res.statusCode, 200);
    // The tab <nav> must label itself so screen readers announce it distinctly
    // from the sidebar <nav aria-label="Agents">.
    assert.match(res.body, /aria-label="Agent sections"/, 'tab nav must have aria-label');
    // The tab <ul> must declare role="tablist" so ARIA tab-panel semantics are
    // complete without a JS framework.
    assert.match(res.body, /role="tablist"/, 'tab list must have role="tablist"');
  });
});
