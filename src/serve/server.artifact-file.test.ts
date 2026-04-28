/**
 * Integration tests for `GET /api/agents/:slug/artifacts/:id/file` —
 * the artifact file-streaming endpoint added by AC 4.
 *
 * These tests live in their own file (rather than `server.test.ts`) so
 * concurrent agents adding sibling artifact endpoints (list, delete)
 * can extend this surface without merge conflicts. Coverage:
 *
 *   - 200: streams the raw bytes back with the right Content-Type and
 *     Content-Length headers (markdown + binary path)
 *   - 200: HEAD returns headers but no body
 *   - Cache-Control: no-store so updates surface immediately
 *   - 400: invalid slug / id
 *   - 400: filePath escapes project root (path-traversal guard)
 *   - 404: unknown agent / unknown artifact / file missing on disk
 *
 * Fixture pattern mirrors `server.test.ts` (`makeProject`,
 * `makeBuildDir`, `httpGet`) so the asserts stay symmetrical.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';

import { startServer } from './server.js';
import {
  ArtifactStore,
  createArtifactRecord,
  type ArtifactType,
} from '../storage/artifact-store.js';

interface HttpResult {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

async function makeProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'aweek-artifact-file-srv-'));
  await mkdir(join(dir, '.aweek'), { recursive: true });
  return dir;
}

async function makeBuildDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'aweek-spa-artifact-file-'));
  await mkdir(join(dir, 'assets'), { recursive: true });
  await writeFile(
    join(dir, 'index.html'),
    '<!doctype html><html><body>spa</body></html>',
    'utf8',
  );
  return dir;
}

async function makeProjectWithAgent({
  slug = 'writer',
}: { slug?: string } = {}): Promise<{ root: string; slug: string; agentsDir: string }> {
  const root = await makeProject();
  const agentsDir = join(root, '.aweek', 'agents');
  await mkdir(agentsDir, { recursive: true });
  const now = new Date().toISOString();
  // Monday-of-week in UTC (matches the harness used by server.test.ts).
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
    weeklyTokenBudget: 10_000,
    budget: {
      weeklyTokenLimit: 10_000,
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
  return { root, slug, agentsDir };
}

async function registerArtifact({
  agentsDir,
  projectRoot,
  slug,
  taskId = 'task-1',
  filePath,
  fileName,
  type = 'document' as ArtifactType,
  description = 'fixture',
}: {
  agentsDir: string;
  projectRoot: string;
  slug: string;
  taskId?: string;
  filePath: string;
  fileName: string;
  type?: ArtifactType;
  description?: string;
}) {
  const store = new ArtifactStore(agentsDir, projectRoot);
  const record = createArtifactRecord({
    agentId: slug,
    taskId,
    filePath,
    fileName,
    type,
    description,
  });
  await store.register(slug, record, { autoSize: false });
  return record;
}

function httpGet(
  url: string,
  { method = 'GET' }: { method?: string } = {},
): Promise<HttpResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = new URL(url);
    const r = httpRequest(
      {
        method,
        hostname: req.hostname,
        port: req.port,
        path: req.pathname + req.search,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk as Buffer));
        res.on('end', () => {
          resolvePromise({
            statusCode: res.statusCode || 0,
            headers: res.headers as Record<string, string | string[] | undefined>,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    r.on('error', rejectPromise);
    r.end();
  });
}

// ── /api/agents/:slug/artifacts/:id/file ────────────────────────────────────

describe('GET /api/agents/:slug/artifacts/:id/file', () => {
  let projectDir: string | null;
  let buildDir: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let handle: any;

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

  it('streams the raw bytes of a markdown artifact with text/markdown Content-Type', async () => {
    const fx = await makeProjectWithAgent();
    projectDir = fx.root;
    buildDir = await makeBuildDir();

    const filePath = 'reports/weekly.md';
    const body = '# Weekly Report\n\nHello world.\n';
    await mkdir(join(fx.root, 'reports'), { recursive: true });
    await writeFile(join(fx.root, filePath), body, 'utf-8');

    const record = await registerArtifact({
      agentsDir: fx.agentsDir,
      projectRoot: fx.root,
      slug: fx.slug,
      filePath,
      fileName: 'weekly.md',
      type: 'report',
    });

    handle = await startServer({
      projectDir,
      buildDir,
      port: 0,
      host: '127.0.0.1',
    });

    const res = await httpGet(
      `${handle.url}api/agents/${fx.slug}/artifacts/${record.id}/file`,
    );
    assert.equal(res.statusCode, 200);
    assert.match(
      String(res.headers['content-type'] || ''),
      /^text\/markdown; charset=utf-8$/,
    );
    assert.equal(
      Number(res.headers['content-length']),
      Buffer.byteLength(body, 'utf-8'),
    );
    // Artifact files can be overwritten in place; never cache.
    assert.match(String(res.headers['cache-control'] || ''), /no-store/);
    // Content-Disposition surfaces the on-disk filename for downloads.
    // Known/renderable Content-Types (markdown here) ride the `inline`
    // disposition so the SPA's in-page <Markdown> preview keeps working.
    assert.match(
      String(res.headers['content-disposition'] || ''),
      /^inline; filename="weekly\.md"$/,
    );
    assert.equal(res.body.toString('utf-8'), body);
  });

  it('falls back to application/octet-stream + Content-Disposition: attachment for unknown extensions (AC 9)', async () => {
    const fx = await makeProjectWithAgent();
    projectDir = fx.root;
    buildDir = await makeBuildDir();

    const filePath = 'out/blob.xyz';
    const body = Buffer.from([0x00, 0x01, 0x02, 0xff]);
    await mkdir(join(fx.root, 'out'), { recursive: true });
    await writeFile(join(fx.root, filePath), body);

    const record = await registerArtifact({
      agentsDir: fx.agentsDir,
      projectRoot: fx.root,
      slug: fx.slug,
      filePath,
      fileName: 'blob.xyz',
      type: 'other',
    });

    handle = await startServer({
      projectDir,
      buildDir,
      port: 0,
      host: '127.0.0.1',
    });

    const res = await httpGet(
      `${handle.url}api/agents/${fx.slug}/artifacts/${record.id}/file`,
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'application/octet-stream');
    assert.equal(Number(res.headers['content-length']), body.length);
    assert.deepEqual(Buffer.from(res.body), body);
    // AC 9: unknown file types must ride `attachment` so the browser
    // unconditionally triggers a download dialog (no inline render of
    // an opaque body, no script-execution risk for misnamed extensions).
    // The original filename is still surfaced via the `filename=` hint.
    assert.match(
      String(res.headers['content-disposition'] || ''),
      /^attachment; filename="blob\.xyz"$/,
    );
  });

  it('uses Content-Disposition: attachment for files with no extension at all (AC 9)', async () => {
    const fx = await makeProjectWithAgent();
    projectDir = fx.root;
    buildDir = await makeBuildDir();

    const filePath = 'Makefile';
    const body = 'all:\n\techo hi\n';
    await writeFile(join(fx.root, filePath), body, 'utf-8');

    const record = await registerArtifact({
      agentsDir: fx.agentsDir,
      projectRoot: fx.root,
      slug: fx.slug,
      filePath,
      fileName: 'Makefile',
      type: 'other',
    });

    handle = await startServer({
      projectDir,
      buildDir,
      port: 0,
      host: '127.0.0.1',
    });

    const res = await httpGet(
      `${handle.url}api/agents/${fx.slug}/artifacts/${record.id}/file`,
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'application/octet-stream');
    assert.match(
      String(res.headers['content-disposition'] || ''),
      /^attachment; filename="Makefile"$/,
    );
  });

  it('HEAD returns the headers without a body', async () => {
    const fx = await makeProjectWithAgent();
    projectDir = fx.root;
    buildDir = await makeBuildDir();

    const filePath = 'notes.txt';
    const body = 'just a note\n';
    await writeFile(join(fx.root, filePath), body, 'utf-8');

    const record = await registerArtifact({
      agentsDir: fx.agentsDir,
      projectRoot: fx.root,
      slug: fx.slug,
      filePath,
      fileName: 'notes.txt',
      type: 'document',
    });

    handle = await startServer({
      projectDir,
      buildDir,
      port: 0,
      host: '127.0.0.1',
    });

    const res = await httpGet(
      `${handle.url}api/agents/${fx.slug}/artifacts/${record.id}/file`,
      { method: 'HEAD' },
    );
    assert.equal(res.statusCode, 200);
    assert.equal(
      Number(res.headers['content-length']),
      Buffer.byteLength(body, 'utf-8'),
    );
    assert.equal(res.body.length, 0);
  });

  it('returns 404 when the agent slug is unknown', async () => {
    projectDir = await makeProject();
    buildDir = await makeBuildDir();
    handle = await startServer({
      projectDir,
      buildDir,
      port: 0,
      host: '127.0.0.1',
    });

    const res = await httpGet(
      `${handle.url}api/agents/missing/artifacts/artifact-deadbeef/file`,
    );
    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.body.toString('utf-8'));
    assert.match(body.error, /Agent not found/);
  });

  it('returns 404 when the artifact id is unknown', async () => {
    const fx = await makeProjectWithAgent();
    projectDir = fx.root;
    buildDir = await makeBuildDir();
    handle = await startServer({
      projectDir,
      buildDir,
      port: 0,
      host: '127.0.0.1',
    });

    const res = await httpGet(
      `${handle.url}api/agents/${fx.slug}/artifacts/artifact-deadbeef/file`,
    );
    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.body.toString('utf-8'));
    assert.match(body.error, /Artifact not found/);
  });

  it('returns 404 when the manifest entry exists but the file is gone from disk', async () => {
    const fx = await makeProjectWithAgent();
    projectDir = fx.root;
    buildDir = await makeBuildDir();

    const record = await registerArtifact({
      agentsDir: fx.agentsDir,
      projectRoot: fx.root,
      slug: fx.slug,
      filePath: 'reports/never-existed.md',
      fileName: 'never-existed.md',
      type: 'report',
    });

    handle = await startServer({
      projectDir,
      buildDir,
      port: 0,
      host: '127.0.0.1',
    });

    const res = await httpGet(
      `${handle.url}api/agents/${fx.slug}/artifacts/${record.id}/file`,
    );
    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.body.toString('utf-8'));
    assert.match(body.error, /missing on disk/);
  });

  it('returns 400 when filePath escapes the project root (path-traversal guard)', async () => {
    const fx = await makeProjectWithAgent();
    projectDir = fx.root;
    buildDir = await makeBuildDir();

    // Manifest entry pointing outside the tmp project root.
    const record = await registerArtifact({
      agentsDir: fx.agentsDir,
      projectRoot: fx.root,
      slug: fx.slug,
      filePath: '../../../../../../../../etc/passwd',
      fileName: 'passwd',
      type: 'other',
    });

    handle = await startServer({
      projectDir,
      buildDir,
      port: 0,
      host: '127.0.0.1',
    });

    const res = await httpGet(
      `${handle.url}api/agents/${fx.slug}/artifacts/${record.id}/file`,
    );
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body.toString('utf-8'));
    assert.match(body.error, /escapes project root/);
  });

  it('returns 400 when an absolute filePath escapes the project root', async () => {
    const fx = await makeProjectWithAgent();
    projectDir = fx.root;
    buildDir = await makeBuildDir();

    const record = await registerArtifact({
      agentsDir: fx.agentsDir,
      projectRoot: fx.root,
      slug: fx.slug,
      filePath: '/etc/passwd',
      fileName: 'passwd',
      type: 'other',
    });

    handle = await startServer({
      projectDir,
      buildDir,
      port: 0,
      host: '127.0.0.1',
    });

    const res = await httpGet(
      `${handle.url}api/agents/${fx.slug}/artifacts/${record.id}/file`,
    );
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body.toString('utf-8'));
    assert.match(body.error, /escapes project root/);
  });

  it('rejects traversal-shaped slugs with 400', async () => {
    projectDir = await makeProject();
    buildDir = await makeBuildDir();
    handle = await startServer({
      projectDir,
      buildDir,
      port: 0,
      host: '127.0.0.1',
    });

    const res = await httpGet(
      `${handle.url}api/agents/..%2F..%2Fetc%2Fpasswd/artifacts/artifact-x/file`,
    );
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body.toString('utf-8'));
    assert.match(body.error, /Invalid slug or artifact id/);
  });

  it('rejects traversal-shaped artifact ids with 400', async () => {
    const fx = await makeProjectWithAgent();
    projectDir = fx.root;
    buildDir = await makeBuildDir();
    handle = await startServer({
      projectDir,
      buildDir,
      port: 0,
      host: '127.0.0.1',
    });

    const res = await httpGet(
      `${handle.url}api/agents/${fx.slug}/artifacts/..%2F..%2Fetc%2Fpasswd/file`,
    );
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body.toString('utf-8'));
    assert.match(body.error, /Invalid slug or artifact id/);
  });

  it('serves PNG images with the right Content-Type', async () => {
    const fx = await makeProjectWithAgent();
    projectDir = fx.root;
    buildDir = await makeBuildDir();

    // 1x1 transparent PNG (minimal valid bytes).
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
      'hex',
    );
    await writeFile(join(fx.root, 'pixel.png'), png);

    const record = await registerArtifact({
      agentsDir: fx.agentsDir,
      projectRoot: fx.root,
      slug: fx.slug,
      filePath: 'pixel.png',
      fileName: 'pixel.png',
      type: 'other',
    });

    handle = await startServer({
      projectDir,
      buildDir,
      port: 0,
      host: '127.0.0.1',
    });

    const res = await httpGet(
      `${handle.url}api/agents/${fx.slug}/artifacts/${record.id}/file`,
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'image/png');
    assert.equal(Number(res.headers['content-length']), png.length);
    assert.deepEqual(Buffer.from(res.body), png);
    // Images carry a known Content-Type so they ride the `inline`
    // disposition — the SPA renders them via an <img> tag (AC 7).
    assert.match(
      String(res.headers['content-disposition'] || ''),
      /^inline; filename="pixel\.png"$/,
    );
  });

  it('handles trailing slash on the file path', async () => {
    const fx = await makeProjectWithAgent();
    projectDir = fx.root;
    buildDir = await makeBuildDir();

    const filePath = 'notes.md';
    const body = '# notes\n';
    await writeFile(join(fx.root, filePath), body, 'utf-8');

    const record = await registerArtifact({
      agentsDir: fx.agentsDir,
      projectRoot: fx.root,
      slug: fx.slug,
      filePath,
      fileName: 'notes.md',
      type: 'document',
    });

    handle = await startServer({
      projectDir,
      buildDir,
      port: 0,
      host: '127.0.0.1',
    });

    const res = await httpGet(
      `${handle.url}api/agents/${fx.slug}/artifacts/${record.id}/file/`,
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.toString('utf-8'), body);
  });
});
