/**
 * Tests for src/skills/init.js (Sub-AC 2 of AC 1).
 *
 * Exercises the two init primitives in isolation:
 *   - `ensureDataDir` creates `.aweek/{agents,logs,state}` and is idempotent.
 *   - `installDependencies` runs pnpm install with correct args, respects
 *     exit codes, and distinguishes fresh-install vs refresh outcomes.
 *
 * Uses injected spawners + tmpdirs so no real pnpm call is required.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AWEEK_SUBDIRS,
  DEFAULT_ADD_AGENT_PROMPT_TEXT,
  DEFAULT_DATA_DIR,
  DEFAULT_HEARTBEAT_SCHEDULE,
  DEFAULT_HIRE_PROMPT_TEXT,
  DEFAULT_PACKAGE_MANAGER,
  HIRE_SKILL_NAME,
  PROJECT_HEARTBEAT_MARKER_PREFIX,
  buildHeartbeatCommand,
  buildHeartbeatEntry,
  buildHireLaunchInstruction,
  detectInitState,
  ensureDataDir,
  finalizeInit,
  formatHireLaunchPrompt,
  hasExistingAgents,
  installDependencies,
  installHeartbeat,
  parseProjectHeartbeat,
  projectHeartbeatMarker,
  queryHeartbeat,
  removeProjectHeartbeat,
  resolveProjectDir,
  shouldLaunchHire,
  __internals,
} from './init.js';

/**
 * Make a fresh tmp project dir for a test. Always call `cleanup` in the
 * matching `after`/`afterEach` block.
 */
async function makeTmpProject(prefix = 'aweek-init-test-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/**
 * Build a scriptable fake spawner so we can assert on invocation shape and
 * control the resolved `{ code, stdout, stderr }` without running pnpm.
 */
function makeFakeSpawn({ code = 0, stdout = '', stderr = '' } = {}) {
  const calls = [];
  async function spawnFn(args) {
    calls.push(args);
    return { code, stdout, stderr };
  }
  return { spawnFn, calls };
}

describe('init — module constants', () => {
  it('exposes the canonical aweek subdirectories', () => {
    assert.deepEqual([...AWEEK_SUBDIRS], ['agents', 'logs', 'state']);
  });

  it('AWEEK_SUBDIRS is frozen to prevent ad-hoc mutation', () => {
    assert.equal(Object.isFrozen(AWEEK_SUBDIRS), true);
  });

  it('DEFAULT_DATA_DIR is the .aweek root', () => {
    assert.equal(DEFAULT_DATA_DIR, '.aweek');
  });

  it('DEFAULT_PACKAGE_MANAGER is pnpm (matches package.json)', () => {
    assert.equal(DEFAULT_PACKAGE_MANAGER, 'pnpm');
  });
});

describe('init — resolveProjectDir', () => {
  it('resolves relative paths to absolute', () => {
    const result = resolveProjectDir('./foo');
    assert.equal(result.startsWith('/'), true);
    assert.equal(result.endsWith('/foo'), true);
  });

  it('falls back to process.cwd() when no dir is provided', () => {
    assert.equal(resolveProjectDir(), process.cwd());
    assert.equal(resolveProjectDir(undefined), process.cwd());
  });

  it('passes through absolute paths unchanged', () => {
    const abs = '/tmp/aweek-resolve-test';
    assert.equal(resolveProjectDir(abs), abs);
  });
});

describe('init — ensureDataDir (fresh project)', () => {
  let proj;

  before(async () => {
    proj = await makeTmpProject();
  });

  after(async () => {
    await proj.cleanup();
  });

  it('creates .aweek/ plus all three subdirectories on a fresh project', async () => {
    const result = await ensureDataDir({ projectDir: proj.dir });

    assert.equal(result.outcome, 'created');
    assert.equal(result.root, join(proj.dir, '.aweek'));

    for (const sub of AWEEK_SUBDIRS) {
      assert.ok(result.subdirs[sub], `expected subdirs.${sub} in result`);
      assert.equal(result.subdirs[sub].outcome, 'created');
      const s = await stat(result.subdirs[sub].path);
      assert.ok(s.isDirectory(), `${sub} should be a directory`);
    }

    assert.equal(result.agentsPath, join(proj.dir, '.aweek', 'agents'));
    assert.equal(result.logsPath, join(proj.dir, '.aweek', 'logs'));
    assert.equal(result.statePath, join(proj.dir, '.aweek', 'state'));
  });
});

describe('init — ensureDataDir (idempotent)', () => {
  let proj;

  before(async () => {
    proj = await makeTmpProject();
  });

  after(async () => {
    await proj.cleanup();
  });

  it('reports `skipped` on a second invocation with no filesystem changes', async () => {
    const first = await ensureDataDir({ projectDir: proj.dir });
    assert.equal(first.outcome, 'created');

    const second = await ensureDataDir({ projectDir: proj.dir });
    assert.equal(second.outcome, 'skipped');
    for (const sub of AWEEK_SUBDIRS) {
      assert.equal(
        second.subdirs[sub].outcome,
        'skipped',
        `subdir ${sub} should be skipped on second run`,
      );
    }
  });

  it('reports partial `created` when only some subdirs exist', async () => {
    // Manually pre-create just .aweek/ and .aweek/agents/ — init should
    // report agents as skipped but logs/state as created.
    const tmp = await makeTmpProject();
    try {
      await mkdir(join(tmp.dir, '.aweek', 'agents'), { recursive: true });

      const result = await ensureDataDir({ projectDir: tmp.dir });

      assert.equal(result.outcome, 'skipped'); // .aweek/ itself pre-existed
      assert.equal(result.subdirs.agents.outcome, 'skipped');
      assert.equal(result.subdirs.logs.outcome, 'created');
      assert.equal(result.subdirs.state.outcome, 'created');
    } finally {
      await tmp.cleanup();
    }
  });
});

describe('init — ensureDataDir (dataDir normalization)', () => {
  it('accepts `.aweek/agents` as dataDir and still creates the siblings', async () => {
    // Backwards compat with the historical skill-markdown default.
    const tmp = await makeTmpProject();
    try {
      const result = await ensureDataDir({
        projectDir: tmp.dir,
        dataDir: '.aweek/agents',
      });

      assert.equal(result.root, join(tmp.dir, '.aweek'));
      assert.equal(result.subdirs.agents.outcome, 'created');
      assert.equal(result.subdirs.logs.outcome, 'created');
      assert.equal(result.subdirs.state.outcome, 'created');

      // All three subdirs actually exist under the resolved root.
      for (const sub of AWEEK_SUBDIRS) {
        const s = await stat(join(tmp.dir, '.aweek', sub));
        assert.ok(s.isDirectory());
      }
    } finally {
      await tmp.cleanup();
    }
  });

  it('accepts an absolute dataDir path', async () => {
    const tmp = await makeTmpProject();
    try {
      const absoluteRoot = join(tmp.dir, 'custom-aweek');
      const result = await ensureDataDir({
        projectDir: tmp.dir,
        dataDir: absoluteRoot,
      });

      assert.equal(result.root, absoluteRoot);
      for (const sub of AWEEK_SUBDIRS) {
        const s = await stat(join(absoluteRoot, sub));
        assert.ok(s.isDirectory());
      }
    } finally {
      await tmp.cleanup();
    }
  });
});

describe('init — ensureDataDir (error handling)', () => {
  it('throws ENOTDIR if .aweek already exists as a regular file', async () => {
    const tmp = await makeTmpProject();
    try {
      // Pre-create .aweek as a FILE, not a directory.
      await writeFile(join(tmp.dir, '.aweek'), 'not a directory');

      await assert.rejects(
        ensureDataDir({ projectDir: tmp.dir }),
        (err) => {
          assert.equal(err.code, 'ENOTDIR');
          assert.match(err.message, /not a directory/i);
          return true;
        },
      );
    } finally {
      await tmp.cleanup();
    }
  });
});

describe('init — installDependencies (happy path)', () => {
  let proj;

  beforeEach(async () => {
    proj = await makeTmpProject();
    // Minimal package.json so install is not skipped.
    await writeFile(
      join(proj.dir, 'package.json'),
      JSON.stringify({ name: 'test', version: '0.0.0', private: true }),
    );
  });

  it('invokes the configured package manager with [install] by default', async () => {
    const spawner = makeFakeSpawn({ code: 0, stdout: 'ok' });

    const result = await installDependencies({
      projectDir: proj.dir,
      spawnFn: spawner.spawnFn,
    });

    assert.equal(spawner.calls.length, 1);
    assert.equal(spawner.calls[0].command, 'pnpm');
    assert.deepEqual(spawner.calls[0].args, ['install']);
    assert.equal(spawner.calls[0].cwd, proj.dir);

    assert.equal(result.outcome, 'created');
    assert.equal(result.packageManager, 'pnpm');
    assert.equal(result.cwd, proj.dir);
    assert.equal(result.stdout, 'ok');

    await proj.cleanup();
  });

  it('reports `updated` when node_modules already exists', async () => {
    await mkdir(join(proj.dir, 'node_modules'), { recursive: true });

    const spawner = makeFakeSpawn({ code: 0 });
    const result = await installDependencies({
      projectDir: proj.dir,
      spawnFn: spawner.spawnFn,
    });

    assert.equal(result.outcome, 'updated');
    await proj.cleanup();
  });

  it('accepts an alternate package manager and forwarded args', async () => {
    const spawner = makeFakeSpawn({ code: 0 });
    const result = await installDependencies({
      projectDir: proj.dir,
      packageManager: 'npm',
      args: ['ci', '--no-audit'],
      spawnFn: spawner.spawnFn,
    });

    assert.equal(spawner.calls[0].command, 'npm');
    assert.deepEqual(spawner.calls[0].args, ['ci', '--no-audit']);
    assert.equal(result.packageManager, 'npm');

    await proj.cleanup();
  });
});

describe('init — installDependencies (error handling)', () => {
  it('skips when there is no package.json (no throw)', async () => {
    const tmp = await makeTmpProject();
    try {
      const spawner = makeFakeSpawn({ code: 0 });
      const result = await installDependencies({
        projectDir: tmp.dir,
        spawnFn: spawner.spawnFn,
      });

      assert.equal(result.outcome, 'skipped');
      assert.match(result.reason, /no package\.json/i);
      // Must NOT have invoked the package manager.
      assert.equal(spawner.calls.length, 0);
    } finally {
      await tmp.cleanup();
    }
  });

  it('throws EINSTALL with captured stderr on non-zero exit', async () => {
    const tmp = await makeTmpProject();
    try {
      await writeFile(
        join(tmp.dir, 'package.json'),
        JSON.stringify({ name: 'fail', version: '0.0.0', private: true }),
      );

      const spawner = makeFakeSpawn({
        code: 1,
        stdout: 'some output',
        stderr: 'ERR_PNPM_NO_LOCKFILE',
      });

      await assert.rejects(
        installDependencies({
          projectDir: tmp.dir,
          spawnFn: spawner.spawnFn,
        }),
        (err) => {
          assert.equal(err.code, 'EINSTALL');
          assert.equal(err.exitCode, 1);
          assert.equal(err.stderr, 'ERR_PNPM_NO_LOCKFILE');
          assert.match(err.message, /pnpm install failed/i);
          return true;
        },
      );
    } finally {
      await tmp.cleanup();
    }
  });

  it('throws EPKGMGR_MISSING when the package manager binary is not on PATH', async () => {
    const tmp = await makeTmpProject();
    try {
      await writeFile(
        join(tmp.dir, 'package.json'),
        JSON.stringify({ name: 'miss', version: '0.0.0', private: true }),
      );

      async function enoentSpawn() {
        const err = new Error('spawn pnpm ENOENT');
        err.code = 'ENOENT';
        throw err;
      }

      await assert.rejects(
        installDependencies({
          projectDir: tmp.dir,
          spawnFn: enoentSpawn,
        }),
        (err) => {
          assert.equal(err.code, 'EPKGMGR_MISSING');
          assert.match(err.message, /not installed or not on PATH/i);
          assert.equal(err.cause?.code, 'ENOENT');
          return true;
        },
      );
    } finally {
      await tmp.cleanup();
    }
  });

  it('rethrows unexpected spawn errors verbatim', async () => {
    const tmp = await makeTmpProject();
    try {
      await writeFile(
        join(tmp.dir, 'package.json'),
        JSON.stringify({ name: 'other', version: '0.0.0', private: true }),
      );

      async function weirdSpawn() {
        const err = new Error('something else broke');
        err.code = 'EPERM';
        throw err;
      }

      await assert.rejects(
        installDependencies({
          projectDir: tmp.dir,
          spawnFn: weirdSpawn,
        }),
        (err) => {
          assert.equal(err.code, 'EPERM');
          return true;
        },
      );
    } finally {
      await tmp.cleanup();
    }
  });
});

/* ------------------------------------------------------------------ *
 * Heartbeat crontab scaffolding (Sub-AC 3 of AC 1)
 * ------------------------------------------------------------------ */

/**
 * Build an in-memory fake crontab with scriptable read/write functions
 * so we can exercise installHeartbeat end-to-end without touching the
 * real system crontab.
 */
function makeFakeCrontab(initialContent = '') {
  let content = initialContent;
  const writeCalls = [];

  async function readCrontabFn() {
    return content;
  }

  async function writeCrontabFn(nextContent) {
    content = nextContent;
    writeCalls.push(nextContent);
  }

  return {
    readCrontabFn,
    writeCrontabFn,
    get content() { return content; },
    set content(val) { content = val; },
    writeCalls,
  };
}

describe('init — heartbeat constants', () => {
  it('DEFAULT_HEARTBEAT_SCHEDULE is every 10 minutes', () => {
    assert.equal(DEFAULT_HEARTBEAT_SCHEDULE, '*/10 * * * *');
  });

  it('PROJECT_HEARTBEAT_MARKER_PREFIX is distinct from per-agent prefix', () => {
    assert.equal(PROJECT_HEARTBEAT_MARKER_PREFIX, 'aweek:project-heartbeat:');
    // Sanity: must not collide with the per-agent marker in crontab-manager.js
    assert.notEqual(PROJECT_HEARTBEAT_MARKER_PREFIX, 'aweek:heartbeat:');
  });
});

describe('init — projectHeartbeatMarker', () => {
  it('concatenates prefix with the absolute project path', () => {
    assert.equal(
      projectHeartbeatMarker('/tmp/my-proj'),
      'aweek:project-heartbeat:/tmp/my-proj',
    );
  });

  it('throws when projectDir is missing', () => {
    assert.throws(() => projectHeartbeatMarker(), /projectDir is required/i);
    assert.throws(() => projectHeartbeatMarker(''), /projectDir is required/i);
  });
});

describe('init — buildHeartbeatCommand', () => {
  it('emits the canonical aweek heartbeat --all CLI', () => {
    const cmd = buildHeartbeatCommand({ projectDir: '/tmp/p' });
    assert.equal(cmd, 'aweek heartbeat --all --project-dir /tmp/p');
  });

  it('throws when projectDir is missing', () => {
    assert.throws(
      () => buildHeartbeatCommand({}),
      /projectDir is required/i,
    );
  });
});

describe('init — buildHeartbeatEntry', () => {
  it('builds a two-line entry with default schedule and default command', () => {
    const entry = buildHeartbeatEntry({ projectDir: '/tmp/p' });
    assert.equal(
      entry,
      '# aweek:project-heartbeat:/tmp/p\n*/10 * * * * aweek heartbeat --all --project-dir /tmp/p',
    );
  });

  it('honors a custom schedule', () => {
    const entry = buildHeartbeatEntry({
      projectDir: '/tmp/p',
      schedule: '*/15 * * * *',
    });
    assert.ok(entry.includes('*/15 * * * *'));
  });

  it('honors a custom command', () => {
    const entry = buildHeartbeatEntry({
      projectDir: '/tmp/p',
      command: '/usr/local/bin/aweek beat',
    });
    assert.ok(entry.includes('/usr/local/bin/aweek beat'));
  });

  it('throws when projectDir is missing', () => {
    assert.throws(
      () => buildHeartbeatEntry({}),
      /projectDir is required/i,
    );
  });
});

describe('init — parseProjectHeartbeat', () => {
  it('returns null on empty crontab', () => {
    assert.equal(parseProjectHeartbeat('', '/tmp/p'), null);
  });

  it('returns null when no entry for the project exists', () => {
    const text = '# aweek:project-heartbeat:/other/proj\n0 * * * * aweek heartbeat --all';
    assert.equal(parseProjectHeartbeat(text, '/tmp/p'), null);
  });

  it('parses a matching entry with schedule and command', () => {
    const text = [
      '# aweek:project-heartbeat:/tmp/p',
      '0 * * * * aweek heartbeat --all --project-dir /tmp/p',
    ].join('\n');

    const result = parseProjectHeartbeat(text, '/tmp/p');
    assert.ok(result);
    assert.equal(result.marker, 'aweek:project-heartbeat:/tmp/p');
    assert.equal(result.schedule, '0 * * * *');
    assert.equal(result.command, 'aweek heartbeat --all --project-dir /tmp/p');
  });

  it('does not match partial projectDir prefixes', () => {
    // "/tmp/p" should NOT match a marker for "/tmp/p-extended"
    const text = [
      '# aweek:project-heartbeat:/tmp/p-extended',
      '0 * * * * aweek heartbeat --all --project-dir /tmp/p-extended',
    ].join('\n');

    assert.equal(parseProjectHeartbeat(text, '/tmp/p'), null);
  });

  it('ignores a marker that has no following cron line', () => {
    const text = '# aweek:project-heartbeat:/tmp/p\n# another comment';
    assert.equal(parseProjectHeartbeat(text, '/tmp/p'), null);
  });

  it('ignores a trailing marker with no next line', () => {
    const text = '# aweek:project-heartbeat:/tmp/p';
    assert.equal(parseProjectHeartbeat(text, '/tmp/p'), null);
  });

  it('preserves surrounding non-aweek entries when matching', () => {
    const text = [
      '30 2 * * * /usr/bin/backup.sh',
      '# aweek:project-heartbeat:/tmp/p',
      '0 * * * * aweek heartbeat --all --project-dir /tmp/p',
      '# another job',
      '15 3 * * * /usr/bin/thing',
    ].join('\n');

    const parsed = parseProjectHeartbeat(text, '/tmp/p');
    assert.ok(parsed);
    assert.equal(parsed.schedule, '0 * * * *');
  });
});

describe('init — removeProjectHeartbeat', () => {
  it('is a no-op when no matching entry exists', () => {
    const text = '30 2 * * * /usr/bin/backup.sh\n';
    assert.equal(removeProjectHeartbeat(text, '/tmp/p'), text);
  });

  it('removes only the target project entry', () => {
    const text = [
      '# aweek:project-heartbeat:/tmp/a',
      '0 * * * * aweek heartbeat --all --project-dir /tmp/a',
      '# aweek:project-heartbeat:/tmp/b',
      '0 * * * * aweek heartbeat --all --project-dir /tmp/b',
    ].join('\n');

    const result = removeProjectHeartbeat(text, '/tmp/a');
    assert.ok(!result.includes('/tmp/a'));
    assert.ok(result.includes('/tmp/b'));
  });

  it('preserves non-aweek entries', () => {
    const text = [
      '30 2 * * * /usr/bin/backup.sh',
      '# aweek:project-heartbeat:/tmp/p',
      '0 * * * * aweek heartbeat --all --project-dir /tmp/p',
      '15 3 * * * /usr/bin/cleanup.sh',
    ].join('\n');

    const result = removeProjectHeartbeat(text, '/tmp/p');
    assert.ok(result.includes('/usr/bin/backup.sh'));
    assert.ok(result.includes('/usr/bin/cleanup.sh'));
    assert.ok(!result.includes('aweek:project-heartbeat:/tmp/p'));
  });

  it('handles empty input', () => {
    assert.equal(removeProjectHeartbeat('', '/tmp/p'), '');
  });
});

describe('init — installHeartbeat (confirmation gate)', () => {
  it('throws EHB_NOT_CONFIRMED when confirmed is not passed', async () => {
    const fake = makeFakeCrontab('');
    await assert.rejects(
      installHeartbeat({
        projectDir: '/tmp/p',
        readCrontabFn: fake.readCrontabFn,
        writeCrontabFn: fake.writeCrontabFn,
      }),
      (err) => {
        assert.equal(err.code, 'EHB_NOT_CONFIRMED');
        assert.match(err.message, /explicit user confirmation/i);
        return true;
      },
    );
    // Must NOT have written anything to crontab.
    assert.equal(fake.writeCalls.length, 0);
  });

  it('throws EHB_NOT_CONFIRMED when confirmed is a truthy non-boolean', async () => {
    const fake = makeFakeCrontab('');
    await assert.rejects(
      installHeartbeat({
        projectDir: '/tmp/p',
        confirmed: 'yes', // only strict `true` is accepted
        readCrontabFn: fake.readCrontabFn,
        writeCrontabFn: fake.writeCrontabFn,
      }),
      (err) => err.code === 'EHB_NOT_CONFIRMED',
    );
    assert.equal(fake.writeCalls.length, 0);
  });
});

describe('init — installHeartbeat (happy path)', () => {
  it('reports `created` on a fresh crontab and writes the entry', async () => {
    const fake = makeFakeCrontab('');

    const result = await installHeartbeat({
      projectDir: '/tmp/p',
      confirmed: true,
      readCrontabFn: fake.readCrontabFn,
      writeCrontabFn: fake.writeCrontabFn,
    });

    assert.equal(result.outcome, 'created');
    assert.equal(result.projectDir, '/tmp/p');
    assert.equal(result.schedule, DEFAULT_HEARTBEAT_SCHEDULE);
    assert.equal(
      result.command,
      'aweek heartbeat --all --project-dir /tmp/p',
    );
    assert.equal(result.marker, 'aweek:project-heartbeat:/tmp/p');
    assert.equal(result.previous, null);

    assert.equal(fake.writeCalls.length, 1);
    assert.ok(fake.content.includes('# aweek:project-heartbeat:/tmp/p'));
    assert.ok(fake.content.includes('*/10 * * * *'));
    assert.ok(fake.content.endsWith('\n'));
  });

  it('reports `skipped` when an identical entry already exists', async () => {
    const fake = makeFakeCrontab('');

    await installHeartbeat({
      projectDir: '/tmp/p',
      confirmed: true,
      readCrontabFn: fake.readCrontabFn,
      writeCrontabFn: fake.writeCrontabFn,
    });
    const before = fake.writeCalls.length;

    const result = await installHeartbeat({
      projectDir: '/tmp/p',
      confirmed: true,
      readCrontabFn: fake.readCrontabFn,
      writeCrontabFn: fake.writeCrontabFn,
    });

    assert.equal(result.outcome, 'skipped');
    assert.ok(result.previous);
    assert.equal(result.previous.schedule, DEFAULT_HEARTBEAT_SCHEDULE);
    // Must NOT re-write the crontab on a no-op.
    assert.equal(fake.writeCalls.length, before);
  });

  it('reports `updated` when the schedule changes', async () => {
    const fake = makeFakeCrontab('');

    await installHeartbeat({
      projectDir: '/tmp/p',
      confirmed: true,
      readCrontabFn: fake.readCrontabFn,
      writeCrontabFn: fake.writeCrontabFn,
    });

    const result = await installHeartbeat({
      projectDir: '/tmp/p',
      schedule: '*/30 * * * *',
      confirmed: true,
      readCrontabFn: fake.readCrontabFn,
      writeCrontabFn: fake.writeCrontabFn,
    });

    assert.equal(result.outcome, 'updated');
    assert.ok(result.previous);
    assert.equal(result.previous.schedule, '*/10 * * * *');
    assert.ok(fake.content.includes('*/30 * * * *'));
    // Only one entry for this project — no duplicates after update.
    const occurrences = fake.content.match(/# aweek:project-heartbeat:\/tmp\/p$/gm) || [];
    assert.equal(occurrences.length, 1);
  });

  it('reports `updated` when the command changes', async () => {
    const fake = makeFakeCrontab('');

    await installHeartbeat({
      projectDir: '/tmp/p',
      confirmed: true,
      readCrontabFn: fake.readCrontabFn,
      writeCrontabFn: fake.writeCrontabFn,
    });

    const result = await installHeartbeat({
      projectDir: '/tmp/p',
      command: '/usr/local/bin/aweek beat',
      confirmed: true,
      readCrontabFn: fake.readCrontabFn,
      writeCrontabFn: fake.writeCrontabFn,
    });

    assert.equal(result.outcome, 'updated');
    assert.ok(fake.content.includes('/usr/local/bin/aweek beat'));
  });

  it('preserves pre-existing non-aweek crontab entries', async () => {
    const fake = makeFakeCrontab('30 2 * * * /usr/bin/backup.sh\n');

    await installHeartbeat({
      projectDir: '/tmp/p',
      confirmed: true,
      readCrontabFn: fake.readCrontabFn,
      writeCrontabFn: fake.writeCrontabFn,
    });

    assert.ok(fake.content.includes('/usr/bin/backup.sh'));
    assert.ok(fake.content.includes('aweek:project-heartbeat:/tmp/p'));
  });

  it('coexists with per-agent heartbeat entries from crontab-manager.js', async () => {
    const fake = makeFakeCrontab(
      [
        '# aweek:heartbeat:agent-writer-abc12345',
        '0 * * * * node run-heartbeat.js agent-writer-abc12345',
        '',
      ].join('\n'),
    );

    await installHeartbeat({
      projectDir: '/tmp/p',
      confirmed: true,
      readCrontabFn: fake.readCrontabFn,
      writeCrontabFn: fake.writeCrontabFn,
    });

    // Per-agent marker untouched.
    assert.ok(fake.content.includes('# aweek:heartbeat:agent-writer-abc12345'));
    // Project marker added.
    assert.ok(fake.content.includes('# aweek:project-heartbeat:/tmp/p'));
  });
});

describe('init — queryHeartbeat', () => {
  it('reports installed=false on an empty crontab', async () => {
    const fake = makeFakeCrontab('');

    const result = await queryHeartbeat({
      projectDir: '/tmp/p',
      readCrontabFn: fake.readCrontabFn,
    });

    assert.equal(result.installed, false);
    assert.equal(result.schedule, null);
    assert.equal(result.command, null);
    assert.equal(result.entry, null);
    assert.equal(result.marker, 'aweek:project-heartbeat:/tmp/p');
  });

  it('round-trips installHeartbeat → queryHeartbeat', async () => {
    const fake = makeFakeCrontab('');

    await installHeartbeat({
      projectDir: '/tmp/p',
      schedule: '*/15 * * * *',
      confirmed: true,
      readCrontabFn: fake.readCrontabFn,
      writeCrontabFn: fake.writeCrontabFn,
    });

    const result = await queryHeartbeat({
      projectDir: '/tmp/p',
      readCrontabFn: fake.readCrontabFn,
    });

    assert.equal(result.installed, true);
    assert.equal(result.schedule, '*/15 * * * *');
    assert.equal(
      result.command,
      'aweek heartbeat --all --project-dir /tmp/p',
    );
  });

  it('only reports the entry for the requested projectDir', async () => {
    const fake = makeFakeCrontab('');

    await installHeartbeat({
      projectDir: '/tmp/a',
      confirmed: true,
      readCrontabFn: fake.readCrontabFn,
      writeCrontabFn: fake.writeCrontabFn,
    });
    await installHeartbeat({
      projectDir: '/tmp/b',
      schedule: '*/10 * * * *',
      confirmed: true,
      readCrontabFn: fake.readCrontabFn,
      writeCrontabFn: fake.writeCrontabFn,
    });

    const a = await queryHeartbeat({
      projectDir: '/tmp/a',
      readCrontabFn: fake.readCrontabFn,
    });
    const b = await queryHeartbeat({
      projectDir: '/tmp/b',
      readCrontabFn: fake.readCrontabFn,
    });
    const c = await queryHeartbeat({
      projectDir: '/tmp/c',
      readCrontabFn: fake.readCrontabFn,
    });

    assert.equal(a.installed, true);
    assert.equal(a.schedule, '*/10 * * * *');
    assert.equal(b.installed, true);
    assert.equal(b.schedule, '*/10 * * * *');
    assert.equal(c.installed, false);
  });
});

/* ------------------------------------------------------------------ *
 * Hire-flow handoff (Sub-AC 4 of AC 1)
 * ------------------------------------------------------------------ */

describe('init — hire-launch constants', () => {
  it('HIRE_SKILL_NAME is the canonical /aweek:hire slash command', () => {
    assert.equal(HIRE_SKILL_NAME, '/aweek:hire');
  });

  it('DEFAULT_HIRE_PROMPT_TEXT is non-empty and mentions /aweek:hire', () => {
    assert.equal(typeof DEFAULT_HIRE_PROMPT_TEXT, 'string');
    assert.ok(DEFAULT_HIRE_PROMPT_TEXT.length > 0);
    assert.match(DEFAULT_HIRE_PROMPT_TEXT, /\/aweek:hire/);
  });
});

describe('init — hasExistingAgents', () => {
  it('returns false when .aweek/agents/ does not exist', async () => {
    const tmp = await makeTmpProject();
    try {
      assert.equal(
        await hasExistingAgents({ projectDir: tmp.dir }),
        false,
      );
    } finally {
      await tmp.cleanup();
    }
  });

  it('returns false when .aweek/agents/ exists but is empty', async () => {
    const tmp = await makeTmpProject();
    try {
      await ensureDataDir({ projectDir: tmp.dir });
      assert.equal(
        await hasExistingAgents({ projectDir: tmp.dir }),
        false,
      );
    } finally {
      await tmp.cleanup();
    }
  });

  it('returns true when agents/ contains at least one .json file', async () => {
    const tmp = await makeTmpProject();
    try {
      const { agentsPath } = await ensureDataDir({ projectDir: tmp.dir });
      await writeFile(
        join(agentsPath, 'agent-writer-abc12345.json'),
        JSON.stringify({ id: 'agent-writer-abc12345' }),
      );
      assert.equal(
        await hasExistingAgents({ projectDir: tmp.dir }),
        true,
      );
    } finally {
      await tmp.cleanup();
    }
  });

  it('ignores non-json files in agents/', async () => {
    const tmp = await makeTmpProject();
    try {
      const { agentsPath } = await ensureDataDir({ projectDir: tmp.dir });
      await writeFile(join(agentsPath, 'notes.md'), '# not an agent');
      await writeFile(join(agentsPath, '.DS_Store'), '');
      assert.equal(
        await hasExistingAgents({ projectDir: tmp.dir }),
        false,
      );
    } finally {
      await tmp.cleanup();
    }
  });

  it('accepts .aweek/agents as dataDir (normalized to .aweek root)', async () => {
    const tmp = await makeTmpProject();
    try {
      const { agentsPath } = await ensureDataDir({
        projectDir: tmp.dir,
        dataDir: '.aweek/agents',
      });
      await writeFile(
        join(agentsPath, 'agent-x.json'),
        '{"id":"agent-x"}',
      );
      assert.equal(
        await hasExistingAgents({
          projectDir: tmp.dir,
          dataDir: '.aweek/agents',
        }),
        true,
      );
    } finally {
      await tmp.cleanup();
    }
  });
});

describe('init — shouldLaunchHire', () => {
  it('returns true when no agents exist (fresh project)', async () => {
    const tmp = await makeTmpProject();
    try {
      assert.equal(
        await shouldLaunchHire({ projectDir: tmp.dir }),
        true,
      );
    } finally {
      await tmp.cleanup();
    }
  });

  it('returns false when at least one agent exists', async () => {
    const tmp = await makeTmpProject();
    try {
      const { agentsPath } = await ensureDataDir({ projectDir: tmp.dir });
      await writeFile(
        join(agentsPath, 'agent-writer-abc12345.json'),
        '{"id":"agent-writer-abc12345"}',
      );
      assert.equal(
        await shouldLaunchHire({ projectDir: tmp.dir }),
        false,
      );
    } finally {
      await tmp.cleanup();
    }
  });

  it('honors an injected hasAgentsFn override', async () => {
    const calls = [];
    async function fakeHasAgents(opts) {
      calls.push(opts);
      return true;
    }
    const result = await shouldLaunchHire({
      projectDir: '/tmp/x',
      hasAgentsFn: fakeHasAgents,
    });
    assert.equal(result, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].projectDir, '/tmp/x');
  });
});

describe('init — buildHireLaunchInstruction', () => {
  it('emits the canonical /aweek:hire handoff payload', () => {
    const result = buildHireLaunchInstruction({ projectDir: '/tmp/p' });
    assert.equal(result.skill, '/aweek:hire');
    assert.equal(result.projectDir, '/tmp/p');
    assert.equal(result.promptText, DEFAULT_HIRE_PROMPT_TEXT);
    assert.match(result.reason, /hire/i);
  });

  it('honors a custom promptText override', () => {
    const result = buildHireLaunchInstruction({
      projectDir: '/tmp/p',
      promptText: 'Bootstrap your first teammate now?',
    });
    assert.equal(result.promptText, 'Bootstrap your first teammate now?');
  });

  it('resolves a relative projectDir to absolute', () => {
    const result = buildHireLaunchInstruction({ projectDir: './foo' });
    assert.ok(result.projectDir.startsWith('/'));
    assert.ok(result.projectDir.endsWith('/foo'));
  });
});

describe('init — formatHireLaunchPrompt', () => {
  it('returns the default prompt text by default', () => {
    assert.equal(formatHireLaunchPrompt(), DEFAULT_HIRE_PROMPT_TEXT);
    assert.equal(formatHireLaunchPrompt({}), DEFAULT_HIRE_PROMPT_TEXT);
  });

  it('returns the provided override verbatim', () => {
    assert.equal(
      formatHireLaunchPrompt({ promptText: 'Custom copy.' }),
      'Custom copy.',
    );
  });
});

describe('init — finalizeInit', () => {
  it('launches /aweek:hire on a fresh project with no agents (mode=first-agent)', async () => {
    const tmp = await makeTmpProject();
    try {
      await ensureDataDir({ projectDir: tmp.dir });

      const result = await finalizeInit({ projectDir: tmp.dir });

      assert.equal(result.launchHire, true);
      assert.equal(result.nextSkill, '/aweek:hire');
      assert.equal(result.mode, 'first-agent');
      assert.equal(result.isReRun, false);
      assert.equal(result.promptText, DEFAULT_HIRE_PROMPT_TEXT);
      assert.ok(result.instruction);
      assert.equal(result.instruction.skill, '/aweek:hire');
      assert.equal(result.instruction.projectDir, tmp.dir);
      assert.match(result.reason, /no agents/i);
    } finally {
      await tmp.cleanup();
    }
  });

  it('offers /aweek:hire to add another agent on re-run (mode=add-another)', async () => {
    // AC 2 idempotency contract: re-running /aweek:init against an
    // already-initialized project must still surface the hire flow so
    // users have a clear next action.
    const tmp = await makeTmpProject();
    try {
      const { agentsPath } = await ensureDataDir({ projectDir: tmp.dir });
      await writeFile(
        join(agentsPath, 'agent-writer-abc12345.json'),
        '{"id":"agent-writer-abc12345"}',
      );

      const result = await finalizeInit({ projectDir: tmp.dir });

      assert.equal(result.launchHire, true);
      assert.equal(result.nextSkill, '/aweek:hire');
      assert.equal(result.mode, 'add-another');
      assert.equal(result.isReRun, true);
      assert.equal(result.promptText, DEFAULT_ADD_AGENT_PROMPT_TEXT);
      assert.ok(result.instruction);
      assert.equal(result.instruction.promptText, DEFAULT_ADD_AGENT_PROMPT_TEXT);
      assert.match(result.reason, /add another/i);
    } finally {
      await tmp.cleanup();
    }
  });

  it('falls back to first-agent mode when the agents directory is missing entirely', async () => {
    // Covers the pre-ensureDataDir path — should still be launchHire=true
    // because "no agents" is the forgiving interpretation of a missing dir.
    const tmp = await makeTmpProject();
    try {
      const result = await finalizeInit({ projectDir: tmp.dir });
      assert.equal(result.launchHire, true);
      assert.equal(result.nextSkill, '/aweek:hire');
      assert.equal(result.mode, 'first-agent');
      assert.equal(result.isReRun, false);
    } finally {
      await tmp.cleanup();
    }
  });

  it('honors an injected hasAgentsFn for pure control flow', async () => {
    const result = await finalizeInit({
      projectDir: '/tmp/fake',
      hasAgentsFn: async () => false,
    });

    assert.equal(result.launchHire, true);
    assert.equal(result.nextSkill, '/aweek:hire');
    assert.equal(result.mode, 'first-agent');
    assert.equal(result.projectDir, '/tmp/fake');
    assert.ok(result.instruction);
    assert.equal(result.instruction.projectDir, '/tmp/fake');
  });

  it('propagates a custom first-agent promptText into the instruction payload', async () => {
    const result = await finalizeInit({
      projectDir: '/tmp/fake',
      promptText: 'Spin up your first agent?',
      hasAgentsFn: async () => false,
    });

    assert.equal(result.promptText, 'Spin up your first agent?');
    assert.equal(result.instruction.promptText, 'Spin up your first agent?');
  });

  it('propagates a custom addAnotherPromptText when agents already exist', async () => {
    const result = await finalizeInit({
      projectDir: '/tmp/fake',
      addAnotherPromptText: 'Hire another teammate?',
      hasAgentsFn: async () => true,
    });

    assert.equal(result.mode, 'add-another');
    assert.equal(result.isReRun, true);
    assert.equal(result.promptText, 'Hire another teammate?');
    assert.equal(result.instruction.promptText, 'Hire another teammate?');
  });
});

/* ------------------------------------------------------------------ *
 * detectInitState (AC 2 — idempotency)
 * ------------------------------------------------------------------ */

describe('init — detectInitState', () => {
  it('reports a fully uninitialized project on a bare tmp dir', async () => {
    const tmp = await makeTmpProject();
    try {
      const fake = makeFakeCrontab('');
      const state = await detectInitState({
        projectDir: tmp.dir,
        readCrontabFn: fake.readCrontabFn,
      });

      assert.equal(state.dataDir.exists, false);
      assert.equal(state.dataDir.agentCount, 0);
      assert.equal(state.heartbeat.installed, false);
      assert.equal(state.heartbeat.schedule, null);
      assert.equal(state.needsWork.dataDir, true);
      assert.equal(state.needsWork.heartbeat, true);
      assert.equal(state.fullyInitialized, false);
    } finally {
      await tmp.cleanup();
    }
  });

  it('reports dataDir.exists=true after ensureDataDir runs', async () => {
    const tmp = await makeTmpProject();
    try {
      await ensureDataDir({ projectDir: tmp.dir });
      const fake = makeFakeCrontab('');

      const state = await detectInitState({
        projectDir: tmp.dir,
        readCrontabFn: fake.readCrontabFn,
      });

      assert.equal(state.dataDir.exists, true);
      assert.equal(state.dataDir.agentCount, 0);
      assert.equal(state.needsWork.dataDir, false);
    } finally {
      await tmp.cleanup();
    }
  });

  it('counts only .json files as agents', async () => {
    const tmp = await makeTmpProject();
    try {
      const { agentsPath } = await ensureDataDir({ projectDir: tmp.dir });
      await writeFile(join(agentsPath, 'agent-a.json'), '{"id":"agent-a"}');
      await writeFile(join(agentsPath, 'agent-b.json'), '{"id":"agent-b"}');
      await writeFile(join(agentsPath, 'README.md'), '# not an agent');
      await writeFile(join(agentsPath, '.DS_Store'), '');

      const fake = makeFakeCrontab('');
      const state = await detectInitState({
        projectDir: tmp.dir,
        readCrontabFn: fake.readCrontabFn,
      });

      assert.equal(state.dataDir.agentCount, 2);
    } finally {
      await tmp.cleanup();
    }
  });

  it('reflects the heartbeat crontab entry when installed', async () => {
    const tmp = await makeTmpProject();
    try {
      const fake = makeFakeCrontab('');
      await installHeartbeat({
        projectDir: tmp.dir,
        schedule: '*/15 * * * *',
        confirmed: true,
        readCrontabFn: fake.readCrontabFn,
        writeCrontabFn: fake.writeCrontabFn,
      });

      const state = await detectInitState({
        projectDir: tmp.dir,
        readCrontabFn: fake.readCrontabFn,
      });

      assert.equal(state.heartbeat.installed, true);
      assert.equal(state.heartbeat.schedule, '*/15 * * * *');
      assert.match(state.heartbeat.command, /aweek heartbeat --all/);
      assert.equal(state.needsWork.heartbeat, false);
    } finally {
      await tmp.cleanup();
    }
  });

  it('reports fullyInitialized=true when every step is complete', async () => {
    const tmp = await makeTmpProject();
    try {
      await ensureDataDir({ projectDir: tmp.dir });

      const fake = makeFakeCrontab('');
      await installHeartbeat({
        projectDir: tmp.dir,
        confirmed: true,
        readCrontabFn: fake.readCrontabFn,
        writeCrontabFn: fake.writeCrontabFn,
      });

      const state = await detectInitState({
        projectDir: tmp.dir,
        readCrontabFn: fake.readCrontabFn,
      });

      assert.equal(state.fullyInitialized, true);
      assert.equal(state.needsWork.dataDir, false);
      assert.equal(state.needsWork.heartbeat, false);
    } finally {
      await tmp.cleanup();
    }
  });

  it('accepts .aweek/agents as dataDir (normalized)', async () => {
    const tmp = await makeTmpProject();
    try {
      await ensureDataDir({
        projectDir: tmp.dir,
        dataDir: '.aweek/agents',
      });

      const fake = makeFakeCrontab('');
      const state = await detectInitState({
        projectDir: tmp.dir,
        dataDir: '.aweek/agents',
        readCrontabFn: fake.readCrontabFn,
      });

      assert.equal(state.dataDir.exists, true);
    } finally {
      await tmp.cleanup();
    }
  });

  it('honors an injected readCrontabFn for deterministic tests', async () => {
    const tmp = await makeTmpProject();
    try {
      const readCalls = [];
      async function readCrontabFn() {
        readCalls.push('read');
        return '';
      }

      const state = await detectInitState({
        projectDir: tmp.dir,
        readCrontabFn,
      });

      // At least one read should have happened via queryHeartbeat.
      assert.ok(readCalls.length >= 1);
      assert.equal(state.heartbeat.installed, false);
    } finally {
      await tmp.cleanup();
    }
  });

  it('does not mutate the filesystem or crontab', async () => {
    const tmp = await makeTmpProject();
    try {
      const fake = makeFakeCrontab('existing\n');
      const before = fake.content;

      await detectInitState({
        projectDir: tmp.dir,
        readCrontabFn: fake.readCrontabFn,
      });

      assert.equal(fake.content, before);
      assert.equal(fake.writeCalls.length, 0);
      // .aweek/ should NOT have been created by a read-only probe.
      await assert.rejects(stat(join(tmp.dir, '.aweek')));
    } finally {
      await tmp.cleanup();
    }
  });
});

describe('init — __internals (normalizeAweekRoot)', () => {
  it('treats an /agents leaf as the aweek root parent', () => {
    assert.equal(
      __internals.normalizeAweekRoot('/tmp/x/.aweek/agents'),
      '/tmp/x/.aweek',
    );
  });

  it('treats a /logs leaf as the aweek root parent', () => {
    assert.equal(
      __internals.normalizeAweekRoot('/tmp/x/.aweek/logs'),
      '/tmp/x/.aweek',
    );
  });

  it('leaves a non-subdir path untouched', () => {
    assert.equal(
      __internals.normalizeAweekRoot('/tmp/x/.aweek'),
      '/tmp/x/.aweek',
    );
    assert.equal(
      __internals.normalizeAweekRoot('/tmp/x/custom'),
      '/tmp/x/custom',
    );
  });
});
