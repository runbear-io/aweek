/**
 * Integration tests for the `aweek serve` CLI command (AC 7 sub-AC 4).
 *
 * Whereas `server.test.js` drives `startServer()` directly — a fine surface
 * for router and lifecycle invariants — these tests spawn
 * `bin/aweek.js serve` as a real child process. That is the surface the
 * user actually types, so these tests verify the CLI plumbing at the same
 * time as the HTTP behavior:
 *
 *   1. **Static asset serving** — hashed JS/CSS assets come back with the
 *      right MIME type and immutable caching headers, and `index.html` is
 *      served for GET `/`. A fake Vite build is seeded at
 *      `<packageRoot>/dist/` just for this suite (see `ensureBuildDir`)
 *      so the tests do not rely on a prior `pnpm build`.
 *   2. **JSON endpoint responses** — `/healthz` and the `/api/*` family
 *      all emit `application/json; charset=utf-8` with `Cache-Control:
 *      no-store` and the envelope shapes the SPA consumes.
 *   3. **SPA fallback behavior** — deep client-side routes (`/agents/...`)
 *      resolve to the same `index.html` HTML shell so the React router
 *      can take over; a missing hashed-asset path returns 404 (not the
 *      shell) so broken `<script>` tags surface loudly.
 *
 * We also regression-check the friendly `.aweek/`-missing failure mode,
 * which is the most common first-run CLI error.
 *
 * The subprocess helper waits for the `listening on http://...` line to
 * appear on stdout before returning, so tests never race the bind. Every
 * child is torn down via `stopCli()` in `afterEach` (SIGTERM, escalating
 * to SIGKILL) so a failing assertion cannot leak a stray server.
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';

// Absolute path to the aweek CLI entry point. `bin/aweek.js` is an ES
// module with a shebang; we invoke it via `process.execPath` so the
// integration tests do not depend on the user's `$PATH` or on the bin
// being installed via `npm link`.
const BIN_PATH = fileURLToPath(new URL('../../bin/aweek.js', import.meta.url));

// Absolute path to the Vite build directory the CLI will probe. Matches
// `resolveDefaultBuildDir()` in `server.js` and `build.outDir` in
// `vite.config.js`, which both land the SPA bundle at
// `src/serve/spa/dist/`. The CLI does not accept a `--build-dir` flag
// (that is intentionally a serve-internal knob, not a user-facing
// surface), so for the static-asset suite we seed our fixture files
// here and clean them up in `after`.
const BUILD_DIR = fileURLToPath(new URL('./spa/dist/', import.meta.url));
const FAKE_FILES = ['assets/app-abc123.js', 'assets/app-abc123.css', 'favicon.ico'];

// Indexed by the paths the fake build places under `<packageRoot>/dist/`.
// Keeping the content small keeps assertions precise and I/O cheap.
const FAKE_INDEX_HTML =
  '<!doctype html><html><head><title>aweek SPA fixture</title></head><body id="spa-root"></body></html>';
const FAKE_APP_JS = 'console.log("spa-fixture");\n';
const FAKE_APP_CSS = 'body{color:#0f0}\n';

/**
 * Seed a fake Vite build at `<packageRoot>/dist/` if and only if one is
 * not already present. Returns a handle that the `after` hook uses to
 * decide whether to clean up.
 *
 * The guard is critical: running `pnpm test` after `pnpm build` must not
 * remove the user's real build artifacts on test teardown. When a build
 * already exists we simply leave it alone and the suite runs against it.
 */
async function ensureBuildDir() {
  // Whether or not a real build exists, always seed the fixture files
  // the static-asset tests assert on (app-abc123.*, favicon.ico). They
  // use well-known paths that do not collide with the real hashed
  // bundle emitted by Vite, so layering them on top of a real build is
  // safe. `index.html` is only seeded when absent so we do not clobber
  // the real shell.
  const hadBuild = existsSync(BUILD_DIR);
  await mkdir(join(BUILD_DIR, 'assets'), { recursive: true });
  if (!hadBuild) {
    await writeFile(join(BUILD_DIR, 'index.html'), FAKE_INDEX_HTML, 'utf8');
  }
  await writeFile(join(BUILD_DIR, 'assets', 'app-abc123.js'), FAKE_APP_JS, 'utf8');
  await writeFile(join(BUILD_DIR, 'assets', 'app-abc123.css'), FAKE_APP_CSS, 'utf8');
  await writeFile(join(BUILD_DIR, 'favicon.ico'), Buffer.from([0, 0, 1, 0]));
  return { created: !hadBuild };
}

/**
 * Tear down the fake build directory only when `ensureBuildDir` created
 * it. No-op when a pre-existing build was detected, so we never clobber
 * developer state.
 */
async function teardownBuildDir(handle) {
  if (!handle) return;
  if (handle.created) {
    // Seed created the whole directory — remove it wholesale.
    await rm(BUILD_DIR, { recursive: true, force: true });
    return;
  }
  // A real build was present before this suite ran. Only remove the
  // fixture files we layered on top, leaving the developer's build
  // artifacts untouched.
  for (const rel of FAKE_FILES) {
    await rm(join(BUILD_DIR, rel), { force: true });
  }
}

/**
 * Spawn `aweek serve` as a child process and resolve once the CLI has
 * printed its `listening on http://...` announcement. The returned
 * handle carries the discovered URL + getters for buffered stdout /
 * stderr so assertions can inspect what the user would see in their
 * terminal.
 *
 * Rejects if the CLI exits before binding (e.g. ENOAWEEKDIR surface).
 */
function startCliServer({
  projectDir,
  port = 0,
  host = '127.0.0.1',
  extraArgs = [],
} = {}) {
  return new Promise((resolveStart, rejectStart) => {
    const args = [
      BIN_PATH,
      'serve',
      '--port',
      String(port),
      '--host',
      host,
      '--no-open',
      '--project-dir',
      projectDir,
      ...extraArgs,
    ];
    const child = spawn(process.execPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutBuf = '';
    let stderrBuf = '';
    let settled = false;

    // Hard timeout guards against an orphaned subprocess hanging the
    // whole test runner. The value is generous compared to normal
    // bind time (~50 ms) so slow CI machines do not flake.
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        rejectStart(
          new Error(
            `CLI did not announce a listening URL within 10s.\n` +
              `stdout: ${stdoutBuf}\nstderr: ${stderrBuf}`,
          ),
        );
      }
    }, 10_000);

    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString('utf-8');
      // The startup sequence in `runServe` prints (in order):
      //   `aweek dashboard listening on http://...`
      //   (optional LAN URL block for wildcard binds)
      //   `  Press Ctrl-C to stop.`
      // Wait for the trailing "Press Ctrl-C" sentinel so all startup
      // output has been flushed by the time the promise resolves —
      // otherwise individual lines race the `resolve()` call and
      // assertions against `stdout()` become flaky.
      const urlMatch = stdoutBuf.match(/listening on (http:\/\/\S+)/);
      const readyMatch = /Press Ctrl-C to stop\./.test(stdoutBuf);
      if (urlMatch && readyMatch && !settled) {
        settled = true;
        clearTimeout(timer);
        // Normalize trailing slash so callers can always append
        // `api/agents` or `healthz` directly.
        const url = urlMatch[1].endsWith('/')
          ? urlMatch[1]
          : `${urlMatch[1]}/`;
        resolveStart({
          child,
          url,
          stdout: () => stdoutBuf,
          stderr: () => stderrBuf,
        });
      }
    });
    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString('utf-8');
    });
    child.once('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        rejectStart(
          new Error(
            `CLI exited with code ${code} before binding.\n` +
              `stdout: ${stdoutBuf}\nstderr: ${stderrBuf}`,
          ),
        );
      }
    });
  });
}

/**
 * Gracefully stop a running CLI subprocess. Sends SIGTERM first (the
 * Node runtime closes its HTTP server and exits cleanly), then escalates
 * to SIGKILL after a short grace window so a wedged child cannot keep
 * the test runner alive.
 */
function stopCli(handle) {
  return new Promise((resolveStop) => {
    if (!handle || !handle.child || handle.child.exitCode !== null) {
      resolveStop();
      return;
    }
    handle.child.once('exit', () => resolveStop());
    try {
      handle.child.kill('SIGTERM');
    } catch {
      // Already exited — the `exit` listener above will fire.
    }
    setTimeout(() => {
      if (handle.child.exitCode === null) {
        try {
          handle.child.kill('SIGKILL');
        } catch {
          // Ignore — nothing else we can do.
        }
      }
    }, 2000);
  });
}

/**
 * Minimal HTTP client. Returning the buffered body as a UTF-8 string
 * keeps assertions terse; binary-safe tests can re-buffer via
 * `Buffer.from(res.body, 'binary')` if they ever need it.
 */
function httpGet(url, { method = 'GET' } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const u = new URL(url);
    const req = request(
      {
        method,
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
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
    req.on('error', rejectPromise);
    req.end();
  });
}

/**
 * Fresh temp project with an empty `.aweek/` folder. The HTTP server
 * refuses to start without that folder, so every positive-path test
 * needs one.
 */
async function makeProject() {
  const dir = await mkdtemp(join(tmpdir(), 'aweek-cli-serve-'));
  await mkdir(join(dir, '.aweek'), { recursive: true });
  return dir;
}

/**
 * Temp project seeded with a single hired agent. Mirrors the fixture
 * used by `server.test.js` so we exercise the same data path through
 * the CLI (and no further — the goal here is wiring, not re-testing
 * store internals).
 */
async function makeProjectWithAgent({
  slug = 'writer',
  name = 'Writer',
  description = 'Drafts copy.',
  weeklyTokenBudget = 10_000,
} = {}) {
  const root = await makeProject();
  const agentsDir = join(root, '.aweek', 'agents');
  await mkdir(agentsDir, { recursive: true });

  // Monday-of-week in UTC — the budget period anchor is not an integration
  // concern, but the downstream stores expect a valid ISO string.
  const now = new Date().toISOString();
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
      paused: false,
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

// ── Top-level build-dir lifecycle ─────────────────────────────────────────
//
// Created once for the whole file so every suite that needs `dist/` sees
// the same fixture. Absent any assertion mutating the directory, this is
// safe to share.
let buildDirHandle;

before(async () => {
  buildDirHandle = await ensureBuildDir();
});

after(async () => {
  await teardownBuildDir(buildDirHandle);
});

// ── Lifecycle + dashboard URL surface ─────────────────────────────────────

describe('aweek serve CLI — lifecycle', () => {
  let projectDir;
  let handle;

  beforeEach(async () => {
    projectDir = await makeProject();
    handle = null;
  });

  afterEach(async () => {
    await stopCli(handle);
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
  });

  it('prints the dashboard URL on stdout and binds to an ephemeral port', async () => {
    handle = await startCliServer({ projectDir });
    // Regex matches both trailing-slash and non-slash variants the
    // launcher might emit across platforms.
    assert.match(
      handle.stdout(),
      /aweek dashboard listening on http:\/\/127\.0\.0\.1:\d+\/?/,
    );
    assert.match(handle.stdout(), /Press Ctrl-C to stop/);
    // The URL the helper resolved must be reachable via HTTP.
    const res = await httpGet(`${handle.url}healthz`);
    assert.equal(res.statusCode, 200);
  });

  it('does not try to open a browser when --no-open is passed', async () => {
    handle = await startCliServer({ projectDir });
    // `runServe` logs `Could not auto-open a browser...` only when it
    // tried and failed. With --no-open it must not try at all.
    assert.doesNotMatch(handle.stdout(), /auto-open/);
  });
});

// ── JSON endpoint responses ───────────────────────────────────────────────

describe('aweek serve CLI — JSON endpoints', () => {
  let projectDir;
  let handle;

  beforeEach(() => {
    projectDir = null;
    handle = null;
  });

  afterEach(async () => {
    await stopCli(handle);
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
  });

  it('GET /healthz returns a JSON liveness probe', async () => {
    projectDir = await makeProject();
    handle = await startCliServer({ projectDir });
    const res = await httpGet(`${handle.url}healthz`);
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] || '', /application\/json/);
    assert.match(res.headers['cache-control'] || '', /no-store/);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.projectDir, projectDir);
  });

  it('GET /api/agents returns { agents: [] } for an empty project', async () => {
    projectDir = await makeProject();
    handle = await startCliServer({ projectDir });
    const res = await httpGet(`${handle.url}api/agents`);
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] || '', /application\/json/);
    assert.match(res.headers['cache-control'] || '', /no-store/);
    assert.deepEqual(JSON.parse(res.body), { agents: [] });
  });

  it('GET /api/agents returns the fixture agent when one is hired', async () => {
    const fx = await makeProjectWithAgent({
      slug: 'writer',
      name: 'Writer',
      description: 'Drafts copy.',
      weeklyTokenBudget: 7_500,
    });
    projectDir = fx.root;
    handle = await startCliServer({ projectDir });
    const res = await httpGet(`${handle.url}api/agents`);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.agents.length, 1);
    assert.equal(body.agents[0].slug, 'writer');
    assert.equal(body.agents[0].name, 'Writer');
    assert.equal(body.agents[0].description, 'Drafts copy.');
    assert.equal(body.agents[0].tokenLimit, 7_500);
    assert.equal(body.agents[0].missing, false);
  });

  it('GET /api/agents/:slug returns the detail envelope', async () => {
    const fx = await makeProjectWithAgent({
      slug: 'writer',
      name: 'Writer',
      weeklyTokenBudget: 12_345,
    });
    projectDir = fx.root;
    handle = await startCliServer({ projectDir });
    const res = await httpGet(`${handle.url}api/agents/writer`);
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] || '', /application\/json/);
    const body = JSON.parse(res.body);
    assert.ok(body.agent, 'expected { agent: {...} } envelope');
    assert.equal(body.agent.slug, 'writer');
    assert.equal(body.agent.name, 'Writer');
    assert.equal(body.agent.tokenLimit, 12_345);
    assert.equal(body.agent.paused, false);
  });

  it('GET /api/agents/:slug/plan returns the plan envelope', async () => {
    const fx = await makeProjectWithAgent({ slug: 'writer', name: 'Writer' });
    projectDir = fx.root;
    handle = await startCliServer({ projectDir });
    const res = await httpGet(`${handle.url}api/agents/writer/plan`);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.plan, 'expected { plan: {...} } envelope');
    assert.equal(body.plan.slug, 'writer');
    assert.equal(body.plan.name, 'Writer');
    assert.ok(Array.isArray(body.plan.weeklyPlans));
  });

  it('GET /api/agents/:slug/usage returns the budget envelope', async () => {
    const fx = await makeProjectWithAgent({
      slug: 'writer',
      name: 'Writer',
      weeklyTokenBudget: 10_000,
    });
    projectDir = fx.root;
    handle = await startCliServer({ projectDir });
    const res = await httpGet(`${handle.url}api/agents/writer/usage`);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.usage, 'expected { usage: {...} } envelope');
    assert.equal(body.usage.slug, 'writer');
    assert.equal(body.usage.tokenLimit, 10_000);
    assert.equal(body.usage.tokensUsed, 0);
    assert.ok(Array.isArray(body.usage.weeks));
  });

  it('GET /api/agents/:slug/logs returns the logs envelope', async () => {
    const fx = await makeProjectWithAgent({ slug: 'writer', name: 'Writer' });
    projectDir = fx.root;
    handle = await startCliServer({ projectDir });
    const res = await httpGet(`${handle.url}api/agents/writer/logs`);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.logs, 'expected { logs: {...} } envelope');
    assert.equal(body.logs.slug, 'writer');
    assert.equal(body.logs.dateRange, 'all');
    assert.deepEqual(body.logs.entries, []);
    assert.deepEqual(body.logs.executions, []);
  });

  it('GET /api/agents/:slug/logs?dateRange=this-week echoes the preset', async () => {
    const fx = await makeProjectWithAgent({ slug: 'writer', name: 'Writer' });
    projectDir = fx.root;
    handle = await startCliServer({ projectDir });
    const res = await httpGet(
      `${handle.url}api/agents/writer/logs?dateRange=this-week`,
    );
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.logs.dateRange, 'this-week');
  });

  it('GET /api/agents/does-not-exist returns a 404 JSON envelope', async () => {
    projectDir = await makeProject();
    handle = await startCliServer({ projectDir });
    const res = await httpGet(`${handle.url}api/agents/does-not-exist`);
    assert.equal(res.statusCode, 404);
    assert.match(res.headers['content-type'] || '', /application\/json/);
    const body = JSON.parse(res.body);
    assert.match(body.error, /Agent not found/);
  });

  it('POST / returns 405 Method Not Allowed', async () => {
    projectDir = await makeProject();
    handle = await startCliServer({ projectDir });
    const res = await httpGet(handle.url, { method: 'POST' });
    assert.equal(res.statusCode, 405);
    assert.match(res.headers.allow || '', /GET/);
  });
});

// ── Static asset serving + SPA fallback ──────────────────────────────────

describe('aweek serve CLI — static assets + SPA fallback', () => {
  let projectDir;
  let handle;

  beforeEach(async () => {
    projectDir = await makeProject();
    handle = null;
  });

  afterEach(async () => {
    await stopCli(handle);
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
  });

  it('GET / serves index.html from the Vite build directory', async () => {
    handle = await startCliServer({ projectDir });
    const res = await httpGet(handle.url);
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] || '', /text\/html/);
    // index.html must never be cached — new deploys must land immediately.
    assert.match(res.headers['cache-control'] || '', /no-store/);
    // Assert we got the shell, not a build-missing stub. The fake fixture
    // contains the marker `spa-root` in the body; a real pnpm-built shell
    // renders its own React root. Both include an `<html` tag, but the
    // build-missing stub contains the string "SPA bundle not found",
    // which we must NOT see here — the `before` hook seeds a valid dist.
    assert.match(res.body, /<html/i);
    assert.doesNotMatch(res.body, /SPA bundle not found/);
  });

  it('GET /assets/app-abc123.js serves the JS asset with immutable caching', async () => {
    handle = await startCliServer({ projectDir });
    const res = await httpGet(`${handle.url}assets/app-abc123.js`);
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] || '', /application\/javascript/);
    // Hashed assets live forever in the browser cache — the bundle name
    // itself changes on rebuild, so immutable caching is safe.
    assert.match(res.headers['cache-control'] || '', /max-age=31536000/);
    assert.match(res.headers['cache-control'] || '', /immutable/);
    // Confirm we actually streamed the fixture body.
    if (buildDirHandle && buildDirHandle.created) {
      assert.equal(res.body, FAKE_APP_JS);
    }
  });

  it('GET /assets/app-abc123.css serves the CSS asset', async () => {
    handle = await startCliServer({ projectDir });
    const res = await httpGet(`${handle.url}assets/app-abc123.css`);
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] || '', /text\/css/);
  });

  it('GET /agents/writer/calendar falls back to index.html (SPA routing)', async () => {
    handle = await startCliServer({ projectDir });
    // A deep React-router URL that has no matching file on disk. The
    // server must answer with the SPA shell so the client-side router
    // can take over.
    const res = await httpGet(`${handle.url}agents/writer/calendar`);
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] || '', /text\/html/);
    assert.match(res.body, /<html/i);
  });

  it('GET /assets/does-not-exist.js returns 404 (not the SPA shell)', async () => {
    handle = await startCliServer({ projectDir });
    // Missing asset-shaped path: the server must surface a real 404 so a
    // broken `<script src="...">` tag does not silently succeed by
    // falling through to index.html.
    const res = await httpGet(`${handle.url}assets/does-not-exist.js`);
    assert.equal(res.statusCode, 404);
    assert.match(res.headers['content-type'] || '', /text\/plain/);
    assert.match(res.body, /Not found/);
  });

  it('HEAD /assets/app-abc123.js returns headers without a body', async () => {
    handle = await startCliServer({ projectDir });
    const res = await httpGet(`${handle.url}assets/app-abc123.js`, {
      method: 'HEAD',
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] || '', /application\/javascript/);
    // Content-Length is required for HEAD to be useful as a probe.
    assert.ok(res.headers['content-length']);
    assert.equal(res.body, '');
  });
});

// ── Friendly error: missing .aweek/ ───────────────────────────────────────

describe('aweek serve CLI — missing .aweek/', () => {
  let emptyDir;

  beforeEach(async () => {
    emptyDir = await mkdtemp(join(tmpdir(), 'aweek-cli-noinit-'));
  });

  afterEach(async () => {
    if (emptyDir) await rm(emptyDir, { recursive: true, force: true });
  });

  it('exits 1 and prints the friendly ENOAWEEKDIR block when .aweek/ is missing', async () => {
    const args = [
      BIN_PATH,
      'serve',
      '--port',
      '0',
      '--host',
      '127.0.0.1',
      '--no-open',
      '--project-dir',
      emptyDir,
    ];
    const { code, stderr } = await new Promise((resolvePromise) => {
      const child = spawn(process.execPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderrBuf = '';
      child.stderr.on('data', (chunk) => {
        stderrBuf += chunk.toString('utf-8');
      });
      child.once('exit', (c) => resolvePromise({ code: c, stderr: stderrBuf }));
    });
    assert.equal(code, 1);
    // Friendly formatter output includes the header, the expected path,
    // and the three "try one of" remediation bullets.
    assert.match(stderr, /No \.aweek\/ folder found\./);
    assert.match(stderr, /aweek serve expects a \.aweek\/ folder at:/);
    assert.match(stderr, /\/\.aweek/);
    assert.match(stderr, /aweek init/);
    assert.match(stderr, /--project-dir/);
  });
});

// ── Flag parsing — --port / --host / --no-open / --project-dir (AC 8) ────
//
// The rest of this file already exercises all four flags while standing up
// fixtures, which is sufficient for smoke testing. AC 8 pins the contract
// that these flags *continue to work* after the SSR → Vite SPA migration,
// so this suite adds dedicated assertions that each flag independently
// produces its observable side effect. Keeping them in one block makes it
// obvious at review time which surface the AC locks down.

describe('aweek serve CLI — flags (AC 8)', () => {
  let projectDir;
  let handle;

  beforeEach(async () => {
    projectDir = await makeProject();
    handle = null;
  });

  afterEach(async () => {
    await stopCli(handle);
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
  });

  it('--port <n> binds to the explicit port and echoes it in the dashboard URL', async () => {
    // Ask the OS for an unused ephemeral port ahead of time so the test
    // does not collide with anything else on the machine. We then feed
    // that concrete port to the CLI as an explicit `--port <n>` value
    // to prove the flag is honored (rather than the CLI defaulting to
    // 3000 or another ephemeral port).
    const { createServer } = await import('node:http');
    const probe = createServer();
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    const requestedPort = probe.address().port;
    await new Promise((r) => probe.close(r));

    handle = await startCliServer({ projectDir, port: requestedPort });

    // Both the stdout announcement and the resolved handle URL must
    // carry the requested port — otherwise the flag was silently
    // discarded and the server bound elsewhere.
    assert.match(
      handle.stdout(),
      new RegExp(`listening on http://127\\.0\\.0\\.1:${requestedPort}/?`),
      `expected --port ${requestedPort} in stdout; saw:\n${handle.stdout()}`,
    );
    assert.ok(
      handle.url.includes(`:${requestedPort}/`),
      `expected URL to carry :${requestedPort}/, got ${handle.url}`,
    );

    // Sanity-check the bind end-to-end — /healthz only answers if we
    // really are listening on that port.
    const res = await httpGet(`${handle.url}healthz`);
    assert.equal(res.statusCode, 200);
  });

  it('--host <addr> binds to the requested host and prints it in the URL', async () => {
    // 127.0.0.1 (loopback) is the only host we can reliably test across
    // every CI environment: 0.0.0.0 wildcard is covered by the unit
    // tests (`startServer` with `DEFAULT_HOST`), and binding to a LAN IP
    // is fragile on sandboxed machines. What matters here is that the
    // CLI propagates the flag rather than falling through to the
    // default wildcard bind.
    handle = await startCliServer({ projectDir, host: '127.0.0.1' });
    assert.match(
      handle.stdout(),
      /listening on http:\/\/127\.0\.0\.1:\d+\/?/,
      `expected --host 127.0.0.1 in stdout; saw:\n${handle.stdout()}`,
    );
    // Wildcard-bind marker must NOT appear — we asked for an explicit
    // loopback bind, so the "  LAN:" block from bin/aweek.js should
    // stay silent.
    assert.doesNotMatch(handle.stdout(), /^\s*LAN:/m);
  });

  it('--no-open suppresses browser launch (no "auto-open" diagnostic)', async () => {
    // The CLI only prints the `Could not auto-open a browser...`
    // diagnostic when it *attempted* to launch a browser and failed.
    // With --no-open it must not attempt at all, so that line must be
    // absent. `startCliServer` always passes --no-open, making this a
    // regression guard against a future refactor that forgets to read
    // the flag.
    handle = await startCliServer({ projectDir });
    assert.doesNotMatch(handle.stdout(), /auto-open/);
    // The URL line still prints, so the server is up — absence of
    // "auto-open" is not because startup itself was skipped.
    assert.match(handle.stdout(), /Press Ctrl-C to stop/);
  });

  it('--project-dir <dir> scopes /healthz.projectDir to that path', async () => {
    // `/healthz` echoes the resolved `projectDir`, so a successful
    // request against a fresh temp project whose parent we created
    // locally is the cleanest way to prove --project-dir was applied
    // rather than falling through to `process.cwd()`.
    handle = await startCliServer({ projectDir });
    const res = await httpGet(`${handle.url}healthz`);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.projectDir, projectDir);
  });

  it('rejects an unknown flag with exit code 1 and a usage error', async () => {
    // `runServe` throws `EUSAGE` for unknown flags; the bin wrapper
    // prints `Serve failed [EUSAGE]: ...` and exits 1. This keeps the
    // CLI surface closed so a misspelled flag (`--port3000` instead of
    // `--port 3000`) fails loud rather than silently binding the
    // default.
    const args = [
      BIN_PATH,
      'serve',
      '--port',
      '0',
      '--host',
      '127.0.0.1',
      '--no-open',
      '--project-dir',
      projectDir,
      '--definitely-not-a-real-flag',
    ];
    const { code, stderr } = await new Promise((resolvePromise) => {
      const child = spawn(process.execPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderrBuf = '';
      child.stderr.on('data', (chunk) => {
        stderrBuf += chunk.toString('utf-8');
      });
      child.once('exit', (c) => resolvePromise({ code: c, stderr: stderrBuf }));
    });
    assert.equal(code, 1);
    assert.match(stderr, /Unknown flag/i);
    assert.match(stderr, /--definitely-not-a-real-flag/);
  });

  it('--help prints the serve usage banner and exits 0 without binding', async () => {
    // `aweek serve --help` is a pure documentation surface: it must
    // exit 0, never start the HTTP server (so we don't need a temp
    // .aweek/), and list all four documented flags. This guards against
    // a future refactor that moves flag parsing around and forgets to
    // keep the usage line in lockstep with the actual parser.
    const { code, stdout, stderr } = await new Promise((resolvePromise) => {
      const child = spawn(
        process.execPath,
        [BIN_PATH, 'serve', '--help'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stdoutBuf = '';
      let stderrBuf = '';
      child.stdout.on('data', (chunk) => {
        stdoutBuf += chunk.toString('utf-8');
      });
      child.stderr.on('data', (chunk) => {
        stderrBuf += chunk.toString('utf-8');
      });
      child.once('exit', (c) =>
        resolvePromise({ code: c, stdout: stdoutBuf, stderr: stderrBuf }),
      );
    });
    assert.equal(code, 0, `stderr: ${stderr}`);
    assert.match(stdout, /aweek serve/);
    assert.match(stdout, /--port/);
    assert.match(stdout, /--host/);
    assert.match(stdout, /--no-open/);
    assert.match(stdout, /--project-dir/);
  });
});
