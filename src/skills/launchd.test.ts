import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  LAUNCHD_LABEL_PREFIX,
  DEFAULT_LAUNCHD_INTERVAL_SECONDS,
  buildLaunchdPlist,
  cronScheduleToSeconds,
  installLaunchdHeartbeat,
  launchdLabel,
  launchdPlistPath,
  parseLaunchdPlist,
  queryLaunchdHeartbeat,
  uninstallLaunchdHeartbeat,
} from './launchd.js';
import type { LaunchctlResult } from './launchd.js';

describe('launchd — constants', () => {
  it('exposes a predictable label prefix', () => {
    assert.equal(LAUNCHD_LABEL_PREFIX, 'io.aweek.heartbeat');
  });

  it('DEFAULT_LAUNCHD_INTERVAL_SECONDS is 600 (10 minutes)', () => {
    assert.equal(DEFAULT_LAUNCHD_INTERVAL_SECONDS, 600);
  });
});

describe('launchd — cronScheduleToSeconds', () => {
  it('converts `every-N-minutes` to seconds', () => {
    assert.equal(cronScheduleToSeconds('*/10 * * * *'), 600);
    assert.equal(cronScheduleToSeconds('*/5 * * * *'), 300);
    assert.equal(cronScheduleToSeconds('*/1 * * * *'), 60);
  });

  it('rejects schedules that cannot be expressed as a single interval', () => {
    assert.throws(() => cronScheduleToSeconds('0 * * * *'), /Cannot convert/);
    assert.throws(() => cronScheduleToSeconds('*/10 9-17 * * *'), /Cannot convert/);
    assert.throws(() => cronScheduleToSeconds('random'), /Cannot convert/);
  });
});

describe('launchd — label + plistPath', () => {
  it('produces a stable label keyed on projectDir', () => {
    const a = launchdLabel('/tmp/projA');
    const b = launchdLabel('/tmp/projA');
    const c = launchdLabel('/tmp/projB');
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.ok(a.startsWith('io.aweek.heartbeat.'));
  });

  it('throws when projectDir is missing', () => {
    assert.throws(() => launchdLabel(), /projectDir is required/);
    assert.throws(() => launchdLabel(''), /projectDir is required/);
  });

  it('plistPath is inside ~/Library/LaunchAgents', () => {
    const p = launchdPlistPath('/tmp/proj', { home: '/Users/alice' });
    assert.ok(p.endsWith('.plist'));
    assert.ok(p.startsWith('/Users/alice/Library/LaunchAgents/io.aweek.heartbeat.'));
  });
});

describe('launchd — buildLaunchdPlist', () => {
  it('emits a well-formed plist with StartInterval, ProgramArguments, and log paths', () => {
    const plist = buildLaunchdPlist({
      projectDir: '/tmp/proj',
      intervalSeconds: 600,
    });
    assert.match(plist, /^<\?xml version="1\.0"/);
    assert.match(plist, /<key>Label<\/key>\s*<string>io\.aweek\.heartbeat\./);
    assert.match(plist, /<key>StartInterval<\/key>\s*<integer>600<\/integer>/);
    assert.match(plist, /<key>RunAtLoad<\/key>\s*<false\/>/);
    assert.match(plist, /<string>\/bin\/zsh<\/string>/);
    assert.match(plist, /<string>-lic<\/string>/);
    assert.match(
      plist,
      /<string>aweek heartbeat --all --project-dir &apos;\/tmp\/proj&apos;<\/string>/,
    );
    assert.match(plist, /\/tmp\/proj\/\.aweek\/logs\/heartbeat\.out\.log/);
  });

  it('accepts a cron schedule as convenience shorthand', () => {
    const plist = buildLaunchdPlist({
      projectDir: '/tmp/proj',
      schedule: '*/15 * * * *',
    });
    assert.match(plist, /<integer>900<\/integer>/);
  });

  it('xml-escapes projectDir characters that would break the plist', () => {
    const plist = buildLaunchdPlist({
      projectDir: '/tmp/with & <brackets>',
    });
    assert.ok(plist.includes('&amp;'));
    assert.ok(plist.includes('&lt;brackets&gt;'));
  });

  it('escapes embedded single quotes in projectDir inside the shell wrap', () => {
    const plist = buildLaunchdPlist({ projectDir: "/tmp/foo's proj" });
    // The single-quote inside the POSIX single-quoted word is `'\''`,
    // which the XML layer then apos-escapes character-by-character.
    assert.ok(plist.includes(`&apos;\\&apos;&apos;`));
  });

  it('rejects intervals below the 60-second floor', () => {
    assert.throws(
      () => buildLaunchdPlist({ projectDir: '/tmp/p', intervalSeconds: 30 }),
      /intervalSeconds must be >= 60/,
    );
  });

  it('throws when projectDir is missing', () => {
    assert.throws(() => buildLaunchdPlist({}), /projectDir is required/);
  });
});

describe('launchd — parseLaunchdPlist', () => {
  it('extracts StartInterval and ProgramArguments', () => {
    const plist = buildLaunchdPlist({
      projectDir: '/tmp/proj',
      intervalSeconds: 900,
    });
    const parsed = parseLaunchdPlist(plist);
    assert.ok(parsed);
    assert.equal(parsed!.intervalSeconds, 900);
    assert.equal(parsed!.programArguments.length, 3);
    assert.equal(parsed!.programArguments[0], '/bin/zsh');
    assert.equal(parsed!.programArguments[1], '-lic');
    assert.ok(parsed!.programArguments[2].includes('/tmp/proj'));
  });

  it('round-trips XML-escaped projectDir back to its original form', () => {
    const plist = buildLaunchdPlist({ projectDir: "/tmp/foo's proj" });
    const parsed = parseLaunchdPlist(plist);
    assert.ok(parsed!.programArguments[2].includes("'\\''"));
  });

  it('returns null on non-string / empty input', () => {
    assert.equal(parseLaunchdPlist(null), null);
    assert.equal(parseLaunchdPlist(''), null);
  });
});

/* ------------------------------------------------------------------ *
 * Fake launchctl + fake fs helpers for the install/query/uninstall
 * integration-style tests below.
 * ------------------------------------------------------------------ */

interface FakeFs {
  files: Map<string, string>;
  readFileFn: (p: string) => Promise<string>;
  writeFileFn: (p: string, content: string) => Promise<void>;
  unlinkFn: (p: string) => Promise<void>;
  statFn: (p: string) => Promise<{ size: number }>;
  mkdirFn: () => Promise<undefined>;
}

function makeFakeFs(): FakeFs {
  const files = new Map<string, string>();
  return {
    files,
    readFileFn: async (p: string): Promise<string> => {
      if (!files.has(p)) {
        const err = new Error(`ENOENT: no such file, open '${p}'`) as Error & { code?: string };
        err.code = 'ENOENT';
        throw err;
      }
      return files.get(p)!;
    },
    writeFileFn: async (p: string, content: string): Promise<void> => {
      files.set(p, content);
    },
    unlinkFn: async (p: string): Promise<void> => {
      if (!files.has(p)) {
        const err = new Error(`ENOENT`) as Error & { code?: string };
        err.code = 'ENOENT';
        throw err;
      }
      files.delete(p);
    },
    statFn: async (p: string): Promise<{ size: number }> => {
      if (!files.has(p)) {
        const err = new Error(`ENOENT`) as Error & { code?: string };
        err.code = 'ENOENT';
        throw err;
      }
      return { size: files.get(p)!.length };
    },
    mkdirFn: async (): Promise<undefined> => undefined,
  };
}

interface FakeLaunchctl {
  calls: string[][];
  loadedLabels: Set<string>;
  launchctlFn: (args: string[]) => Promise<LaunchctlResult>;
}

function makeFakeLaunchctl({ loadedLabels = new Set<string>() }: { loadedLabels?: Set<string> } = {}): FakeLaunchctl {
  const calls: string[][] = [];
  return {
    calls,
    loadedLabels,
    launchctlFn: async (args: string[]): Promise<LaunchctlResult> => {
      calls.push(args);
      const [verb, target, plistPath] = args;
      if (verb === 'print') {
        // target is `gui/<uid>/<label>`.
        const label = target!.split('/').slice(2).join('/');
        return loadedLabels.has(label)
          ? { code: 0, stdout: 'loaded', stderr: '' }
          : { code: 37, stdout: '', stderr: 'Could not find service' };
      }
      if (verb === 'bootstrap') {
        if (!plistPath) return { code: 22, stdout: '', stderr: 'missing plist' };
        // target is `gui/<uid>`. Extract label from plist path.
        const match = /io\.aweek\.heartbeat\.[a-f0-9]+/.exec(plistPath);
        if (match) loadedLabels.add(match[0]);
        return { code: 0, stdout: '', stderr: '' };
      }
      if (verb === 'bootout') {
        const label = target!.split('/').slice(2).join('/');
        if (loadedLabels.has(label)) {
          loadedLabels.delete(label);
          return { code: 0, stdout: '', stderr: '' };
        }
        return { code: 36, stdout: '', stderr: 'not loaded' };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
  };
}

describe('launchd — installLaunchdHeartbeat', () => {
  const projectDir = '/tmp/proj';
  const home = '/Users/alice';

  it('requires confirmed=true', async () => {
    await assert.rejects(
      installLaunchdHeartbeat({ projectDir, home }),
      /requires explicit user confirmation/,
    );
  });

  it('writes the plist, bootstraps launchd, and reports `created` on a fresh install', async () => {
    const fs = makeFakeFs();
    const lc = makeFakeLaunchctl();
    const result = await installLaunchdHeartbeat({
      projectDir,
      home,
      confirmed: true,
      readFileFn: fs.readFileFn,
      writeFileFn: fs.writeFileFn,
      mkdirFn: fs.mkdirFn,
      launchctlFn: lc.launchctlFn,
      getUidFn: () => 501,
    });
    assert.equal(result.outcome, 'created');
    assert.ok(result.plistPath.includes('/Users/alice/Library/LaunchAgents/'));
    assert.equal(fs.files.size, 1);
    assert.ok(fs.files.get(result.plistPath)!.includes('<integer>600</integer>'));

    const verbs = lc.calls.map((c) => c[0]);
    assert.ok(verbs.includes('bootout'));
    assert.ok(verbs.includes('bootstrap'));
  });

  it('reports `skipped` when plist content + launchctl state already match', async () => {
    const fs = makeFakeFs();
    const lc = makeFakeLaunchctl();
    await installLaunchdHeartbeat({
      projectDir,
      home,
      confirmed: true,
      readFileFn: fs.readFileFn,
      writeFileFn: fs.writeFileFn,
      mkdirFn: fs.mkdirFn,
      launchctlFn: lc.launchctlFn,
      getUidFn: () => 501,
    });
    // Second identical install — should early-return.
    lc.calls.length = 0;
    const result = await installLaunchdHeartbeat({
      projectDir,
      home,
      confirmed: true,
      readFileFn: fs.readFileFn,
      writeFileFn: fs.writeFileFn,
      mkdirFn: fs.mkdirFn,
      launchctlFn: lc.launchctlFn,
      getUidFn: () => 501,
    });
    assert.equal(result.outcome, 'skipped');
    // Only `print` should have run on the second pass — no bootout/bootstrap.
    const verbs = lc.calls.map((c) => c[0]);
    assert.deepEqual(verbs, ['print']);
  });

  it('reports `updated` when the on-disk plist differs from the requested one', async () => {
    const fs = makeFakeFs();
    const lc = makeFakeLaunchctl();
    await installLaunchdHeartbeat({
      projectDir,
      home,
      intervalSeconds: 600,
      confirmed: true,
      readFileFn: fs.readFileFn,
      writeFileFn: fs.writeFileFn,
      mkdirFn: fs.mkdirFn,
      launchctlFn: lc.launchctlFn,
      getUidFn: () => 501,
    });
    const result = await installLaunchdHeartbeat({
      projectDir,
      home,
      intervalSeconds: 900,
      confirmed: true,
      readFileFn: fs.readFileFn,
      writeFileFn: fs.writeFileFn,
      mkdirFn: fs.mkdirFn,
      launchctlFn: lc.launchctlFn,
      getUidFn: () => 501,
    });
    assert.equal(result.outcome, 'updated');
    assert.ok(fs.files.get(result.plistPath)!.includes('<integer>900</integer>'));
  });

  it('throws when launchctl bootstrap fails', async () => {
    const fs = makeFakeFs();
    const launchctlFn = async (args: string[]): Promise<LaunchctlResult> => {
      if (args[0] === 'bootstrap') return { code: 5, stdout: '', stderr: 'denied' };
      return { code: 0, stdout: '', stderr: '' };
    };
    await assert.rejects(
      installLaunchdHeartbeat({
        projectDir,
        home,
        confirmed: true,
        readFileFn: fs.readFileFn,
        writeFileFn: fs.writeFileFn,
        mkdirFn: fs.mkdirFn,
        launchctlFn,
        getUidFn: () => 501,
      }),
      /launchctl bootstrap failed/,
    );
  });
});

describe('launchd — queryLaunchdHeartbeat', () => {
  const projectDir = '/tmp/proj';
  const home = '/Users/alice';

  it('reports not-installed for a fresh machine', async () => {
    const fs = makeFakeFs();
    const lc = makeFakeLaunchctl();
    const result = await queryLaunchdHeartbeat({
      projectDir,
      home,
      readFileFn: fs.readFileFn,
      launchctlFn: lc.launchctlFn,
      getUidFn: () => 501,
    });
    assert.equal(result.installed, false);
    assert.equal(result.loaded, false);
    assert.equal(result.intervalSeconds, null);
  });

  it('reports installed+loaded after an install', async () => {
    const fs = makeFakeFs();
    const lc = makeFakeLaunchctl();
    await installLaunchdHeartbeat({
      projectDir,
      home,
      confirmed: true,
      readFileFn: fs.readFileFn,
      writeFileFn: fs.writeFileFn,
      mkdirFn: fs.mkdirFn,
      launchctlFn: lc.launchctlFn,
      getUidFn: () => 501,
    });
    const result = await queryLaunchdHeartbeat({
      projectDir,
      home,
      readFileFn: fs.readFileFn,
      launchctlFn: lc.launchctlFn,
      getUidFn: () => 501,
    });
    assert.equal(result.installed, true);
    assert.equal(result.loaded, true);
    assert.equal(result.intervalSeconds, 600);
    assert.equal(result.programArguments[0], '/bin/zsh');
  });
});

describe('launchd — uninstallLaunchdHeartbeat', () => {
  const projectDir = '/tmp/proj';
  const home = '/Users/alice';

  it('requires confirmed=true', async () => {
    await assert.rejects(
      uninstallLaunchdHeartbeat({ projectDir, home }),
      /requires explicit user confirmation/,
    );
  });

  it('removes the plist file and boots out the service', async () => {
    const fs = makeFakeFs();
    const lc = makeFakeLaunchctl();
    await installLaunchdHeartbeat({
      projectDir,
      home,
      confirmed: true,
      readFileFn: fs.readFileFn,
      writeFileFn: fs.writeFileFn,
      mkdirFn: fs.mkdirFn,
      launchctlFn: lc.launchctlFn,
      getUidFn: () => 501,
    });
    assert.equal(fs.files.size, 1);

    const result = await uninstallLaunchdHeartbeat({
      projectDir,
      home,
      confirmed: true,
      unlinkFn: fs.unlinkFn,
      statFn: fs.statFn,
      launchctlFn: lc.launchctlFn,
      getUidFn: () => 501,
    });
    assert.equal(result.outcome, 'removed');
    assert.equal(fs.files.size, 0);
    assert.equal(lc.loadedLabels.size, 0);
  });

  it('is idempotent when nothing is installed', async () => {
    const fs = makeFakeFs();
    const lc = makeFakeLaunchctl();
    const result = await uninstallLaunchdHeartbeat({
      projectDir,
      home,
      confirmed: true,
      unlinkFn: fs.unlinkFn,
      statFn: fs.statFn,
      launchctlFn: lc.launchctlFn,
      getUidFn: () => 501,
    });
    assert.equal(result.outcome, 'absent');
  });
});
