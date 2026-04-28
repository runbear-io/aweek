/**
 * Integration test — `aweek exec artifact register` invoked mid-session.
 *
 * Sub-AC 4 of AC 2: simulate the subagent's exact runtime path. While the
 * Claude Code CLI is in the middle of executing an aweek task, the subagent
 * shells out to `aweek exec artifact register --input-json -` to register
 * a deliverable it just produced. The dispatcher must accept that JSON,
 * route it through `src/skills/artifact.ts → register`, and persist the
 * record via `ArtifactStore.register` with every expected metadata field
 * stamped onto it (executionId, mimeType, sha256 checksum, sizeBytes, …).
 *
 * Why this lives at the `bin/aweek.ts` boundary (not as a direct
 * `register()` call): the unit test in `artifact.test.ts` already covers
 * the function-level contract. This file is the *wiring* test — it spawns
 * the real CLI as a child process so a future regression in the dispatcher
 * registry, the bin's stdin/JSON plumbing, the short-alias mapping
 * (`task` / `execution` / `file`), or the underlying skill all surface
 * here loudly. Together with `artifact.test.ts` they pin both halves of
 * the contract: skill behaviour AND CLI surface.
 *
 * Pattern mirrors `src/serve/serve-cli.integration.test.ts`: spawn
 * `bin/aweek.ts` via `process.execPath` with the `tsx` ESM loader so the
 * test runs against TypeScript source without requiring `pnpm build`. The
 * subprocess approach is the only honest way to assert that the CLI
 * command an agent would type in real life produces a valid manifest
 * entry — calling `register()` directly would short-circuit the very
 * dispatcher we are trying to validate.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ArtifactStore } from '../storage/artifact-store.js';
import { WeeklyPlanStore, type WeeklyPlan } from '../storage/weekly-plan-store.js';

// Absolute path to the aweek CLI entry point. `bin/aweek.ts` is an ES
// module with a shebang; we spawn it via `process.execPath` so the
// integration test does not depend on the user's `$PATH` or on the bin
// being installed via `npm link`.
const BIN_PATH = fileURLToPath(new URL('../../bin/aweek.ts', import.meta.url));

// `bin/aweek.ts` is TypeScript source; the production CLI ships as a
// compiled `dist/bin/aweek.js`, but the integration tests run against
// the source so changes don't require a rebuild. Child invocations
// register the `tsx` ESM loader so Node can both consume the `.ts`
// entry point and map `.js` import paths inside it to their `.ts`
// source files.
const NODE_PREFIX_ARGS = ['--import', 'tsx'];

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn `aweek exec artifact register --input-json -` as a child
 * process, write the JSON payload to stdin, and resolve with the
 * captured exit code + stdout + stderr. Mirrors what a subagent would
 * do mid-session via a Bash tool call.
 *
 * Hard-times-out at 30s so a wedged child cannot hang the whole test
 * runner. `aweek exec` typically completes in <500ms, so 30s is
 * generously above any reasonable upper bound.
 */
function runArtifactRegisterCli(
  payload: Record<string, unknown>,
  opts: { cwd?: string } = {},
): Promise<CliResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const args = [
      ...NODE_PREFIX_ARGS,
      BIN_PATH,
      'exec',
      'artifact',
      'register',
      '--input-json',
      '-',
    ];
    const child = spawn(process.execPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: opts.cwd,
    });

    let stdoutBuf = '';
    let stderrBuf = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        rejectPromise(
          new Error(
            `aweek exec artifact register did not finish within 30s.\n` +
              `stdout: ${stdoutBuf}\nstderr: ${stderrBuf}`,
          ),
        );
      }
    }, 30_000);

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf-8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf-8');
    });
    child.once('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        rejectPromise(err);
      }
    });
    child.once('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolvePromise({ code, stdout: stdoutBuf, stderr: stderrBuf });
      }
    });

    // Stream the JSON payload to the child's stdin and close the pipe
    // so the bin's `--input-json -` reader knows the input is complete.
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

interface FixtureProject {
  projectDir: string;
  agentsDir: string;
  cleanup: () => Promise<void>;
}

async function makeFixtureProject(): Promise<FixtureProject> {
  const projectDir = await mkdtemp(join(tmpdir(), 'aweek-art-cli-int-'));
  const agentsDir = join(projectDir, '.aweek', 'agents');
  await mkdir(agentsDir, { recursive: true });
  return {
    projectDir,
    agentsDir,
    cleanup: () => rm(projectDir, { recursive: true, force: true }),
  };
}

/**
 * Seed a minimal valid weekly plan so the `taskId` lookup in
 * `register` succeeds (that check enforces "every artifact must belong
 * to a real plan task" — bypassing it would defeat the whole point of
 * the integration test).
 */
async function seedWeeklyPlan(
  agentsDir: string,
  agentId: string,
  taskIds: string[],
  week = '2026-W17',
): Promise<void> {
  const plan: WeeklyPlan = {
    week,
    month: '2026-04',
    tasks: taskIds.map((id) => ({
      id,
      title: `Title for ${id}`,
      prompt: `Prompt for ${id}`,
      status: 'in-progress',
    })),
    approved: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const store = new WeeklyPlanStore(agentsDir);
  await store.save(agentId, plan);
}

/**
 * Provision the per-execution artifact directory the same way the
 * session executor does (`<agentsDir>/<slug>/artifacts/<taskId>_<executionId>/`)
 * and drop a deliverable file inside it. Returns the project-relative
 * path the subagent would pass to `aweek exec artifact register`.
 */
async function dropDeliverable({
  projectDir,
  agentsDir,
  agentId,
  taskId,
  executionId,
  fileName,
  body,
}: {
  projectDir: string;
  agentsDir: string;
  agentId: string;
  taskId: string;
  executionId: string;
  fileName: string;
  body: string;
}): Promise<{ relPath: string; absPath: string; sizeBytes: number }> {
  const execDirAbs = join(
    agentsDir,
    agentId,
    'artifacts',
    `${taskId}_${executionId}`,
  );
  await mkdir(execDirAbs, { recursive: true });
  const absPath = join(execDirAbs, fileName);
  await writeFile(absPath, body, 'utf-8');
  // Compute the project-root-relative POSIX path the CLI accepts.
  const relPath = absPath
    .slice(projectDir.length + 1)
    .split(/[\\/]/)
    .join('/');
  return { relPath, absPath, sizeBytes: Buffer.byteLength(body, 'utf-8') };
}

describe('aweek exec artifact register — mid-session integration (Sub-AC 4)', () => {
  let fx: FixtureProject;

  beforeEach(async () => {
    fx = await makeFixtureProject();
  });

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('writes an ArtifactStore record with every expected metadata field when invoked via stdin JSON', async () => {
    const agentId = 'writer';
    const taskId = 'task-launch-plan';
    const executionId = 'session-1730000000000-deadbeef';
    const week = '2026-W17';

    await seedWeeklyPlan(fx.agentsDir, agentId, [taskId], week);
    const fileBody = '# Launch Plan\n\n- [ ] Draft outline\n';
    const { relPath, sizeBytes } = await dropDeliverable({
      projectDir: fx.projectDir,
      agentsDir: fx.agentsDir,
      agentId,
      taskId,
      executionId,
      fileName: 'plan.md',
      body: fileBody,
    });

    // Mid-session payload the subagent would JSON-stringify and pipe
    // into `aweek exec artifact register --input-json -`. Uses the
    // canonical long field names (taskId / executionId / filePath).
    const payload = {
      projectRoot: fx.projectDir,
      agentsDir: fx.agentsDir,
      agentId,
      taskId,
      executionId,
      filePath: relPath,
      type: 'document' as const,
      description: 'Launch plan draft',
      week,
      metadata: { source: 'mid-session-cli' },
    };

    const result = await runArtifactRegisterCli(payload);

    // ── CLI surface assertions ─────────────────────────────────────
    assert.equal(
      result.code,
      0,
      `CLI exited non-zero. stderr: ${result.stderr}\nstdout: ${result.stdout}`,
    );
    assert.equal(
      result.stderr.trim(),
      '',
      `CLI emitted unexpected stderr: ${result.stderr}`,
    );

    // The bin writes the full record as JSON to stdout — parse it and
    // assert against the wire shape the subagent would consume.
    const cliRecord = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.match(cliRecord.id as string, /^artifact-[a-f0-9]+$/);
    assert.equal(cliRecord.agentId, agentId);
    assert.equal(cliRecord.taskId, taskId);
    assert.equal(cliRecord.filePath, relPath);
    assert.equal(cliRecord.fileName, 'plan.md');
    assert.equal(cliRecord.type, 'document');
    assert.equal(cliRecord.description, 'Launch plan draft');
    assert.equal(cliRecord.week, week);
    assert.equal(cliRecord.sizeBytes, sizeBytes);
    assert.equal(typeof cliRecord.createdAt, 'string');

    const cliMeta = cliRecord.metadata as Record<string, unknown>;
    assert.equal(cliMeta.executionId, executionId);
    assert.equal(cliMeta.mimeType, 'text/markdown');
    assert.equal(cliMeta.checksumAlgorithm, 'sha256');
    const expectedChecksum = createHash('sha256').update(fileBody).digest('hex');
    assert.equal(cliMeta.checksum, expectedChecksum);
    assert.equal(cliMeta.source, 'mid-session-cli');

    // ── On-disk manifest assertions ────────────────────────────────
    // The CLI must have driven the persistence through ArtifactStore —
    // load the manifest a second time via the exact API the dashboard
    // reads from to prove the record landed where downstream consumers
    // will look for it.
    const store = new ArtifactStore(fx.agentsDir, fx.projectDir);
    const persisted = await store.load(agentId);
    assert.equal(persisted.length, 1, 'manifest should contain exactly one record');
    const [diskRecord] = persisted;
    assert.equal(diskRecord.id, cliRecord.id);
    assert.equal(diskRecord.agentId, agentId);
    assert.equal(diskRecord.taskId, taskId);
    assert.equal(diskRecord.filePath, relPath);
    assert.equal(diskRecord.fileName, 'plan.md');
    assert.equal(diskRecord.type, 'document');
    assert.equal(diskRecord.week, week);
    assert.equal(diskRecord.sizeBytes, sizeBytes);

    const diskMeta = diskRecord.metadata as Record<string, unknown>;
    assert.equal(diskMeta.executionId, executionId);
    assert.equal(diskMeta.mimeType, 'text/markdown');
    assert.equal(diskMeta.checksum, expectedChecksum);
    assert.equal(diskMeta.checksumAlgorithm, 'sha256');
    assert.equal(diskMeta.source, 'mid-session-cli');

    // ── Query surface assertions ───────────────────────────────────
    // Sub-AC contract is "queryable via the same store API the dashboard
    // uses". Exercise `query()` with the (taskId, week) filter the
    // dashboard's gatherAgentArtifacts will eventually issue.
    const byTask = await store.query(agentId, { taskId });
    assert.equal(byTask.length, 1);
    assert.equal(byTask[0].id, cliRecord.id);
  });

  it('accepts the short CLI-flag aliases (task / execution / file) per the dispatcher contract', async () => {
    // The dispatcher entry adapts both long and short field names so
    // skill markdown can stay terse. This test pins the alias contract:
    // a subagent firing `--input-json` with `{ task, execution, file }`
    // must produce a record byte-identical to the long-name path.
    const agentId = 'reporter';
    const taskId = 'task-quarterly-report';
    const executionId = 'session-aliases-001';
    await seedWeeklyPlan(fx.agentsDir, agentId, [taskId]);

    const fileBody = 'col1,col2\n1,2\n';
    const { relPath } = await dropDeliverable({
      projectDir: fx.projectDir,
      agentsDir: fx.agentsDir,
      agentId,
      taskId,
      executionId,
      fileName: 'metrics.csv',
      body: fileBody,
    });

    const payload = {
      projectRoot: fx.projectDir,
      agentsDir: fx.agentsDir,
      agentId,
      // Short aliases — what a terse skill markdown body would send.
      task: taskId,
      execution: executionId,
      file: relPath,
      type: 'data' as const,
      description: 'Quarterly metrics export',
    };

    const result = await runArtifactRegisterCli(payload);
    assert.equal(
      result.code,
      0,
      `CLI exited non-zero with short aliases. stderr: ${result.stderr}`,
    );

    const cliRecord = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(cliRecord.taskId, taskId);
    assert.equal(cliRecord.filePath, relPath);
    assert.equal(cliRecord.fileName, 'metrics.csv');
    assert.equal(cliRecord.type, 'data');

    const meta = cliRecord.metadata as Record<string, unknown>;
    assert.equal(meta.executionId, executionId);
    // CSV is not in the markdown/json/pdf shortlist; the inferMimeType
    // helper falls through to the canonical text/csv mapping.
    assert.equal(meta.mimeType, 'text/csv');
    assert.equal(meta.checksumAlgorithm, 'sha256');
    assert.equal(
      meta.checksum,
      createHash('sha256').update(fileBody).digest('hex'),
    );

    const store = new ArtifactStore(fx.agentsDir, fx.projectDir);
    const persisted = await store.load(agentId);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].id, cliRecord.id);
  });

  it('exits non-zero and writes nothing when the filePath escapes the project root (security guardrail)', async () => {
    // The path-traversal guard must hold *across* the CLI surface, not
    // just inside the unit-tested skill function. A subagent that tries
    // to register `/etc/passwd` mid-session must be rejected at the bin
    // level with a non-zero exit AND no manifest mutation.
    const agentId = 'attacker';
    const taskId = 'task-traversal';
    const executionId = 'session-traversal-001';
    await seedWeeklyPlan(fx.agentsDir, agentId, [taskId]);

    // Don't create the per-execution dir; the traversal check fires
    // before the directory existence check, but either way the
    // manifest must remain untouched.
    const payload = {
      projectRoot: fx.projectDir,
      agentsDir: fx.agentsDir,
      agentId,
      taskId,
      executionId,
      filePath: '../../../../etc/passwd',
      type: 'other' as const,
      description: 'should never persist',
    };

    const result = await runArtifactRegisterCli(payload);
    assert.notEqual(result.code, 0, 'CLI must reject traversal attempts');
    assert.match(result.stderr, /escapes the project root/);

    // Manifest must not exist (or, if it does, must be empty).
    const store = new ArtifactStore(fx.agentsDir, fx.projectDir);
    const persisted = await store.load(agentId);
    assert.deepEqual(persisted, [], 'no record should have been persisted');
  });
});
