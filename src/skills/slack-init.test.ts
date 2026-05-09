import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAweekSlackManifest,
  ESLACK_INIT_NOT_CONFIRMED,
  parseSlackCredentials,
  persistSlackCredentials,
  previewCredentialOverwrite,
  provisionSlackApp,
  slackChannelDir,
  slackConfigPath,
  slackInit,
  type SlackManifestApiCtor,
  type RotateConfigTokenFn,
  type SlackCredentials,
} from './slack-init.js';

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

function makeStubManifestApi(state: {
  receivedManifest?: object;
  receivedAppId?: string;
  receivedTokenName?: string;
  receivedScopes?: string[];
  receivedAccessToken?: string;
}): SlackManifestApiCtor {
  return class StubManifestApi {
    accessToken: string;
    constructor(opts: { accessToken: string }) {
      this.accessToken = opts.accessToken;
      state.receivedAccessToken = opts.accessToken;
    }
    async createAppFromManifest(manifest: object) {
      state.receivedManifest = manifest;
      return {
        ok: true as const,
        app_id: 'A0TEST123',
        credentials: {
          client_id: 'cid-1',
          client_secret: 'csec-1',
          signing_secret: 'sigsec-1',
          verification_token: 'vtoken-1',
        },
        oauth_authorize_url: 'https://slack.com/oauth/authorize?app=A0TEST123',
      };
    }
    async generateAppLevelToken(appId: string, tokenName?: string, scopes?: string[]) {
      state.receivedAppId = appId;
      state.receivedTokenName = tokenName;
      state.receivedScopes = scopes;
      return {
        ok: true as const,
        token: 'xapp-stub-1',
        type: 'app_token',
        expires_in: 0,
      };
    }
  } as unknown as SlackManifestApiCtor;
}

function makeStubRotate(record: { received?: string }): RotateConfigTokenFn {
  return async (refreshToken: string) => {
    record.received = refreshToken;
    return {
      ok: true as const,
      token: 'xoxe-access-rotated',
      refresh_token: 'xoxe-refresh-new',
      exp: 1234567890,
      team: { id: 'T0WORKSPACE', name: 'Test Workspace' },
      bot_user_id: 'U0BOT',
    };
  };
}

interface FsMemory {
  files: Map<string, string>;
  mkdirCalls: string[];
}

function makeMemoryFs(initial: Record<string, string> = {}): FsMemory & {
  writeFileFn: (path: string, contents: string) => Promise<void>;
  readFileFn: (path: string) => Promise<string>;
  mkdirFn: (path: string, opts?: { recursive?: boolean }) => Promise<unknown>;
} {
  const fs: FsMemory = {
    files: new Map(Object.entries(initial)),
    mkdirCalls: [],
  };
  return {
    ...fs,
    writeFileFn: async (path: string, contents: string) => {
      fs.files.set(path, contents);
    },
    readFileFn: async (path: string) => {
      const v = fs.files.get(path);
      if (v === undefined) {
        const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return v;
    },
    mkdirFn: async (path: string) => {
      fs.mkdirCalls.push(path);
      return undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

describe('slackChannelDir / slackConfigPath', () => {
  it('roots paths under <projectDir>/.aweek/channels/slack', () => {
    const dir = slackChannelDir('/tmp/proj');
    assert.equal(dir, '/tmp/proj/.aweek/channels/slack');
    const cfg = slackConfigPath('/tmp/proj');
    assert.equal(cfg, '/tmp/proj/.aweek/channels/slack/config.json');
  });
});

// ---------------------------------------------------------------------------
// Manifest builder
// ---------------------------------------------------------------------------

describe('buildAweekSlackManifest', () => {
  it('produces an aweek-branded manifest with Socket Mode enabled', () => {
    const m = buildAweekSlackManifest() as Record<string, any>;
    assert.equal(m.display_information.name, 'aweek');
    assert.match(m.display_information.description, /aweek/i);
    assert.equal(m.settings.socket_mode_enabled, true);
    assert.ok(Array.isArray(m.oauth_config.scopes.bot));
    assert.ok(m.oauth_config.scopes.bot.includes('chat:write'));
    assert.ok(m.oauth_config.scopes.bot.includes('app_mentions:read'));
    assert.ok(m.settings.event_subscriptions.bot_events.includes('app_mention'));
    assert.ok(m.settings.event_subscriptions.bot_events.includes('message.im'));
  });

  it('honors custom appName / appDescription', () => {
    const m = buildAweekSlackManifest({
      appName: 'aweek-staging',
      appDescription: 'Staging copy',
    }) as Record<string, any>;
    assert.equal(m.display_information.name, 'aweek-staging');
    assert.equal(m.display_information.description, 'Staging copy');
  });
});

// ---------------------------------------------------------------------------
// provisionSlackApp
// ---------------------------------------------------------------------------

describe('provisionSlackApp', () => {
  it('throws ESLACK_INIT_NOT_CONFIRMED when confirmed is missing', async () => {
    await assert.rejects(
      () => provisionSlackApp({ refreshToken: 'xoxe-1' }),
      (err: any) => {
        assert.equal(err.code, ESLACK_INIT_NOT_CONFIRMED);
        return true;
      },
    );
  });

  it('throws ESLACK_INIT_NOT_CONFIRMED when confirmed is explicitly false', async () => {
    // Sub-AC 13.2 gate — `confirmed: false` is the unanswered-AskUserQuestion
    // default and MUST be rejected (not coerced to "good enough").
    await assert.rejects(
      () =>
        provisionSlackApp({
          confirmed: false,
          refreshToken: 'xoxe-1',
        }),
      (err: any) => {
        assert.equal(err.code, ESLACK_INIT_NOT_CONFIRMED);
        return true;
      },
    );
  });

  it('throws ESLACK_INIT_NOT_CONFIRMED for truthy-but-non-true confirmed values', async () => {
    // The gate is `=== true`, so 1 / "true" / "yes" / {} are all rejected.
    // This guards against accidental string passthrough from JSON payloads
    // where the user said "yes" but the markdown forwarded it as a string.
    for (const confirmed of [1, 'true', 'yes', {}, []] as const) {
      await assert.rejects(
        () =>
          provisionSlackApp({
            confirmed: confirmed as unknown as boolean,
            refreshToken: 'xoxe-1',
          }),
        (err: any) => {
          assert.equal(err.code, ESLACK_INIT_NOT_CONFIRMED);
          return true;
        },
      );
    }
  });

  it('throws when confirmed is true but refreshToken is missing', async () => {
    await assert.rejects(
      () => provisionSlackApp({ confirmed: true }),
      /Refresh Token/,
    );
  });

  it('rotates the refresh token, creates the app, and generates the app-level token', async () => {
    const apiState: any = {};
    const rotateRecord: any = {};
    const result = await provisionSlackApp({
      confirmed: true,
      refreshToken: 'xoxe-original',
      manifestApiCtor: makeStubManifestApi(apiState),
      rotateConfigTokenFn: makeStubRotate(rotateRecord),
    });

    assert.equal(rotateRecord.received, 'xoxe-original');
    assert.equal(apiState.receivedAccessToken, 'xoxe-access-rotated');
    assert.equal(apiState.receivedAppId, 'A0TEST123');
    assert.equal(apiState.receivedTokenName, 'aweek-socket');
    assert.deepEqual(apiState.receivedScopes, ['connections:write']);
    assert.equal(
      (apiState.receivedManifest as any).display_information.name,
      'aweek',
    );

    assert.equal(result.appId, 'A0TEST123');
    assert.equal(result.appToken, 'xapp-stub-1');
    assert.equal(result.signingSecret, 'sigsec-1');
    assert.equal(result.clientId, 'cid-1');
    assert.equal(result.clientSecret, 'csec-1');
    assert.equal(result.refreshToken, 'xoxe-refresh-new');
    assert.equal(result.teamId, 'T0WORKSPACE');
    assert.match(result.oauthAuthorizeUrl, /A0TEST123/);
  });

  it('passes custom appName / appDescription through to the manifest', async () => {
    const apiState: any = {};
    await provisionSlackApp({
      confirmed: true,
      refreshToken: 'xoxe-1',
      appName: 'aweek-staging',
      appDescription: 'Staging copy',
      manifestApiCtor: makeStubManifestApi(apiState),
      rotateConfigTokenFn: makeStubRotate({}),
    });
    assert.equal(
      (apiState.receivedManifest as any).display_information.name,
      'aweek-staging',
    );
    assert.equal(
      (apiState.receivedManifest as any).display_information.description,
      'Staging copy',
    );
  });
});

// ---------------------------------------------------------------------------
// persistSlackCredentials
// ---------------------------------------------------------------------------

describe('persistSlackCredentials', () => {
  it('throws ESLACK_INIT_NOT_CONFIRMED without confirmation', async () => {
    await assert.rejects(
      () =>
        persistSlackCredentials({
          credentials: { botToken: 'xoxb-1' },
        } as any),
      (err: any) => {
        assert.equal(err.code, ESLACK_INIT_NOT_CONFIRMED);
        return true;
      },
    );
  });

  it('writes nothing to disk when confirmed is false', async () => {
    // Sub-AC 13.2 gate — verify the rejection happens BEFORE any
    // filesystem call, so an unanswered AskUserQuestion never lets a
    // partial write slip through.
    const fs = makeMemoryFs();
    await assert.rejects(
      () =>
        persistSlackCredentials({
          confirmed: false,
          credentials: { botToken: 'xoxb-1' },
          projectDir: '/tmp/proj',
          writeFileFn: fs.writeFileFn,
          readFileFn: fs.readFileFn,
          mkdirFn: fs.mkdirFn,
        }),
      (err: any) => {
        assert.equal(err.code, ESLACK_INIT_NOT_CONFIRMED);
        return true;
      },
    );
    assert.equal(fs.files.size, 0, 'no files should be written');
    assert.deepEqual(fs.mkdirCalls, [], 'no directories should be created');
  });

  it('writes the merged JSON to .aweek/channels/slack/config.json', async () => {
    const fs = makeMemoryFs();
    const result = await persistSlackCredentials({
      confirmed: true,
      projectDir: '/tmp/proj',
      credentials: { botToken: 'xoxb-1', appId: 'A1' },
      now: () => 1700000000000,
      writeFileFn: fs.writeFileFn,
      readFileFn: fs.readFileFn,
      mkdirFn: fs.mkdirFn,
    });

    assert.equal(result.outcome, 'created');
    assert.equal(result.configPath, '/tmp/proj/.aweek/channels/slack/config.json');
    assert.deepEqual(fs.mkdirCalls, ['/tmp/proj/.aweek/channels/slack']);

    const written = fs.files.get('/tmp/proj/.aweek/channels/slack/config.json');
    assert.ok(written, 'expected config.json to be written');
    const parsed = JSON.parse(written!) as SlackCredentials;
    assert.equal(parsed.botToken, 'xoxb-1');
    assert.equal(parsed.appId, 'A1');
    assert.equal(parsed.updatedAt, 1700000000000);
  });

  it('merges with the existing on-disk document', async () => {
    const fs = makeMemoryFs({
      '/tmp/proj/.aweek/channels/slack/config.json': JSON.stringify({
        botToken: 'xoxb-old',
        appToken: 'xapp-old',
        signingSecret: 'sigsec-old',
        updatedAt: 1,
      }),
    });

    const result = await persistSlackCredentials({
      confirmed: true,
      projectDir: '/tmp/proj',
      credentials: { botToken: 'xoxb-new' },
      now: () => 2,
      writeFileFn: fs.writeFileFn,
      readFileFn: fs.readFileFn,
      mkdirFn: fs.mkdirFn,
    });

    assert.equal(result.outcome, 'updated');
    assert.equal(result.credentials.botToken, 'xoxb-new');
    assert.equal(result.credentials.appToken, 'xapp-old');
    assert.equal(result.credentials.signingSecret, 'sigsec-old');
    assert.equal(result.credentials.updatedAt, 2);
  });
});

// ---------------------------------------------------------------------------
// parseSlackCredentials
// ---------------------------------------------------------------------------

describe('parseSlackCredentials', () => {
  it('returns an empty doc on malformed JSON', () => {
    assert.deepEqual(parseSlackCredentials('not json {{'), {});
  });

  it('drops unknown keys and accepts the schema', () => {
    const out = parseSlackCredentials(
      JSON.stringify({
        botToken: 'xoxb-1',
        appToken: 'xapp-1',
        rogue: 'ignored',
        updatedAt: 42,
      }),
    );
    assert.deepEqual(out, { botToken: 'xoxb-1', appToken: 'xapp-1', updatedAt: 42 });
  });

  it('drops non-string values for string fields', () => {
    const out = parseSlackCredentials(JSON.stringify({ botToken: 123 }));
    assert.deepEqual(out, {});
  });
});

// ---------------------------------------------------------------------------
// previewCredentialOverwrite
// ---------------------------------------------------------------------------

describe('previewCredentialOverwrite', () => {
  it('reports fileExists=false and no presence when the file does not exist', async () => {
    const fs = makeMemoryFs();
    const out = await previewCredentialOverwrite({
      projectDir: '/tmp/proj',
      proposed: { botToken: 'xoxb-1', appToken: 'xapp-1' },
      readFileFn: fs.readFileFn,
    });
    assert.equal(out.ok, true);
    assert.equal(out.configPath, '/tmp/proj/.aweek/channels/slack/config.json');
    assert.equal(out.fileExists, false);
    assert.equal(out.fileMalformed, false);
    assert.deepEqual(out.fieldsCurrentlyPresent, []);
    assert.deepEqual(out.fieldsThatWouldBeOverwritten, []);
    assert.deepEqual(out.fieldsThatWouldBeAdded.sort(), ['appToken', 'botToken']);
  });

  it('flags fields that would be overwritten vs. added vs. unchanged', async () => {
    const fs = makeMemoryFs({
      '/tmp/proj/.aweek/channels/slack/config.json': JSON.stringify({
        botToken: 'xoxb-old',
        appToken: 'xapp-keep',
        signingSecret: 'sigsec-old',
        updatedAt: 1,
      }),
    });
    const out = await previewCredentialOverwrite({
      projectDir: '/tmp/proj',
      proposed: {
        botToken: 'xoxb-new', // overwrite
        appToken: 'xapp-keep', // unchanged → not in any list, but currentlyPresent
        appId: 'A0NEW', // add
      },
      readFileFn: fs.readFileFn,
    });
    assert.equal(out.fileExists, true);
    assert.equal(out.fileMalformed, false);
    assert.deepEqual(
      out.fieldsCurrentlyPresent.sort(),
      ['appToken', 'botToken', 'signingSecret'],
    );
    assert.deepEqual(out.fieldsThatWouldBeOverwritten, ['botToken']);
    assert.deepEqual(out.fieldsThatWouldBeAdded, ['appId']);
    // Same-value field should NOT show up in either overwrite or add list.
    assert.ok(!out.fieldsThatWouldBeOverwritten.includes('appToken'));
    assert.ok(!out.fieldsThatWouldBeAdded.includes('appToken'));
  });

  it('marks an existing-but-malformed config as fileMalformed', async () => {
    const fs = makeMemoryFs({
      '/tmp/proj/.aweek/channels/slack/config.json': '{not valid json',
    });
    const out = await previewCredentialOverwrite({
      projectDir: '/tmp/proj',
      proposed: { botToken: 'xoxb-1' },
      readFileFn: fs.readFileFn,
    });
    assert.equal(out.fileExists, true);
    assert.equal(out.fileMalformed, true);
    assert.deepEqual(out.fieldsCurrentlyPresent, []);
    assert.deepEqual(out.fieldsThatWouldBeAdded, ['botToken']);
  });

  it('treats an empty proposal as a no-op preview (read-only inspection)', async () => {
    const fs = makeMemoryFs({
      '/tmp/proj/.aweek/channels/slack/config.json': JSON.stringify({
        botToken: 'xoxb-1',
        appToken: 'xapp-1',
      }),
    });
    const out = await previewCredentialOverwrite({
      projectDir: '/tmp/proj',
      readFileFn: fs.readFileFn,
    });
    assert.equal(out.fileExists, true);
    assert.deepEqual(out.fieldsCurrentlyPresent.sort(), ['appToken', 'botToken']);
    assert.deepEqual(out.fieldsThatWouldBeOverwritten, []);
    assert.deepEqual(out.fieldsThatWouldBeAdded, []);
    assert.deepEqual(out.changes, []);
  });

  it('does NOT require confirmed:true (read-only)', async () => {
    const fs = makeMemoryFs();
    // Should not throw — no `confirmed` argument is passed.
    const out = await previewCredentialOverwrite({
      projectDir: '/tmp/proj',
      proposed: { botToken: 'xoxb-1' },
      readFileFn: fs.readFileFn,
    });
    assert.equal(out.ok, true);
  });

  it('propagates non-ENOENT read errors instead of silently treating them as empty', async () => {
    const eaccesReader = async (_path: string) => {
      const err = new Error('EACCES') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    };
    await assert.rejects(
      () =>
        previewCredentialOverwrite({
          projectDir: '/tmp/proj',
          proposed: { botToken: 'xoxb-1' },
          readFileFn: eaccesReader,
        }),
      /EACCES/,
    );
  });
});

// ---------------------------------------------------------------------------
// slackInit (composite)
// ---------------------------------------------------------------------------

describe('slackInit', () => {
  it('throws ESLACK_INIT_NOT_CONFIRMED without confirmation', async () => {
    await assert.rejects(
      () => slackInit({ refreshToken: 'xoxe-1' }),
      (err: any) => {
        assert.equal(err.code, ESLACK_INIT_NOT_CONFIRMED);
        return true;
      },
    );
  });

  it('throws ESLACK_INIT_NOT_CONFIRMED before any side-effect when confirmed is false', async () => {
    // Sub-AC 13.2 — composite entry must reject before calling either
    // the manifest API or the filesystem. Both stubs assert no calls.
    const fs = makeMemoryFs();
    const apiState: any = {};
    const stubCtor = makeStubManifestApi(apiState);
    const rotateRecord: any = {};
    await assert.rejects(
      () =>
        slackInit({
          confirmed: false,
          refreshToken: 'xoxe-1',
          botToken: 'xoxb-1',
          projectDir: '/tmp/proj',
          manifestApiCtor: stubCtor,
          rotateConfigTokenFn: makeStubRotate(rotateRecord),
          writeFileFn: fs.writeFileFn,
          readFileFn: fs.readFileFn,
          mkdirFn: fs.mkdirFn,
        }),
      (err: any) => {
        assert.equal(err.code, ESLACK_INIT_NOT_CONFIRMED);
        return true;
      },
    );
    assert.equal(rotateRecord.received, undefined, 'rotateConfigToken must not be called');
    assert.equal(apiState.receivedAppId, undefined, 'manifest API must not be called');
    assert.equal(fs.files.size, 0, 'no files should be written');
    assert.deepEqual(fs.mkdirCalls, [], 'no directories should be created');
  });

  it('runs provisioning + persistence end-to-end with a refresh token', async () => {
    const fs = makeMemoryFs();
    const apiState: any = {};
    const result = await slackInit({
      confirmed: true,
      projectDir: '/tmp/proj',
      refreshToken: 'xoxe-original',
      botToken: 'xoxb-after-oauth',
      manifestApiCtor: makeStubManifestApi(apiState),
      rotateConfigTokenFn: makeStubRotate({}),
      now: () => 1700000000000,
      writeFileFn: fs.writeFileFn,
      readFileFn: fs.readFileFn,
      mkdirFn: fs.mkdirFn,
    });

    assert.equal(result.ok, true);
    assert.ok(result.provision !== null);
    assert.equal(result.provision!.appId, 'A0TEST123');
    assert.equal(result.credentials.botToken, 'xoxb-after-oauth');
    assert.equal(result.credentials.appToken, 'xapp-stub-1');
    assert.equal(result.credentials.appId, 'A0TEST123');
    assert.equal(result.credentials.refreshToken, 'xoxe-refresh-new');
    assert.equal(result.credentials.teamId, 'T0WORKSPACE');

    const written = JSON.parse(
      fs.files.get('/tmp/proj/.aweek/channels/slack/config.json')!,
    );
    assert.equal(written.botToken, 'xoxb-after-oauth');
    assert.equal(written.appToken, 'xapp-stub-1');
  });

  it('persists credentials only when skipProvision is set', async () => {
    const fs = makeMemoryFs();
    const apiState: any = {};
    const stubCtor = makeStubManifestApi(apiState);
    const result = await slackInit({
      confirmed: true,
      projectDir: '/tmp/proj',
      skipProvision: true,
      botToken: 'xoxb-direct',
      credentials: { signingSecret: 'sigsec-pre' },
      manifestApiCtor: stubCtor,
      rotateConfigTokenFn: makeStubRotate({}),
      writeFileFn: fs.writeFileFn,
      readFileFn: fs.readFileFn,
      mkdirFn: fs.mkdirFn,
    });

    assert.equal(result.provision, null);
    assert.equal(apiState.receivedAppId, undefined, 'manifest API should not be called');
    assert.equal(result.credentials.botToken, 'xoxb-direct');
    assert.equal(result.credentials.signingSecret, 'sigsec-pre');
  });

  it('skips provisioning when no refresh token is supplied', async () => {
    const fs = makeMemoryFs();
    const apiState: any = {};
    const result = await slackInit({
      confirmed: true,
      projectDir: '/tmp/proj',
      botToken: 'xoxb-only',
      manifestApiCtor: makeStubManifestApi(apiState),
      rotateConfigTokenFn: makeStubRotate({}),
      writeFileFn: fs.writeFileFn,
      readFileFn: fs.readFileFn,
      mkdirFn: fs.mkdirFn,
    });

    assert.equal(result.provision, null);
    assert.equal(result.credentials.botToken, 'xoxb-only');
    assert.equal(apiState.receivedAppId, undefined);
  });
});
