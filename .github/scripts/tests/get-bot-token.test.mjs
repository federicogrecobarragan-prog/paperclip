import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveInstallationId,
  resolveWorkflowToken,
  TOKEN_MODES,
  writeWorkflowOutputs,
} from '../get-bot-token.mjs';

test('resolveInstallationId: uses the repo installation endpoint when repo context is available', async () => {
  const seenPaths = [];
  const installationId = await resolveInstallationId(async (path) => {
    seenPaths.push(path);
    return { id: 42 };
  }, 'jwt', 'paperclipai/paperclip', 'paperclipai');

  assert.equal(installationId, 42);
  assert.deepEqual(seenPaths, ['/repos/paperclipai/paperclip/installation']);
});

test('resolveInstallationId: falls back to the matching owner installation', async () => {
  const installationId = await resolveInstallationId(async () => ([
    { id: 1, account: { login: 'someone-else' } },
    { id: 7, account: { login: 'PaperclipAI' } },
  ]), 'jwt', undefined, 'paperclipai');

  assert.equal(installationId, 7);
});

test('resolveInstallationId: rejects ambiguous installations without repo or owner context', async () => {
  await assert.rejects(
    resolveInstallationId(async () => ([
      { id: 1, account: { login: 'org-one' } },
      { id: 2, account: { login: 'org-two' } },
    ]), 'jwt'),
    /Multiple commitperclip installations found/
  );
});

test('resolveWorkflowToken: explicit fork mode uses only the ephemeral GitHub token', async () => {
  let fetched = false;
  const result = await resolveWorkflowToken({
    mode: TOKEN_MODES.GITHUB_TOKEN,
    githubToken: 'ephemeral-test-token',
    fetchFromGitHub: async () => { fetched = true; },
  });

  assert.deepEqual(result, {
    token: 'ephemeral-test-token',
    mode: 'github-token',
    securityMode: 'report',
  });
  assert.equal(fetched, false);
});

test('resolveWorkflowToken: upstream app mode preserves installation-token flow', async () => {
  const calls = [];
  const result = await resolveWorkflowToken({
    mode: TOKEN_MODES.APP,
    privateKey: 'fake-private-key-for-injected-signer',
    repo: 'paperclipai/paperclip',
    owner: 'paperclipai',
    signJwt: () => 'signed-test-jwt',
    fetchFromGitHub: async (path, token, options) => {
      calls.push({ path, token, options });
      if (path.endsWith('/installation')) return { id: 42 };
      return { token: 'installation-test-token' };
    },
  });

  assert.equal(result.mode, 'app');
  assert.equal(result.securityMode, 'advisory');
  assert.equal(result.token, 'installation-test-token');
  assert.deepEqual(calls.map(call => call.path), [
    '/repos/paperclipai/paperclip/installation',
    '/app/installations/42/access_tokens',
  ]);
});

test('resolveWorkflowToken: missing upstream key fails closed instead of downgrading', async () => {
  await assert.rejects(
    resolveWorkflowToken({ mode: TOKEN_MODES.APP, githubToken: 'must-not-be-used' }),
    /COMMITPERCLIP_KEY/,
  );
});

test('writeWorkflowOutputs: keeps the selected token out of step outputs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'commitperclip-token-output-'));
  const outputPath = join(dir, 'output.txt');
  const environmentPath = join(dir, 'environment.txt');
  const originalWrite = process.stdout.write;
  process.stdout.write = () => true;
  try {
    writeWorkflowOutputs(outputPath, environmentPath, {
      token: 'ephemeral-test-token',
      mode: 'github-token',
      securityMode: 'report',
    });
  } finally {
    process.stdout.write = originalWrite;
  }

  const output = await readFile(outputPath, 'utf8');
  const environment = await readFile(environmentPath, 'utf8');
  assert.equal(output.includes('ephemeral-test-token'), false);
  assert.match(output, /mode=github-token/);
  assert.match(environment, /COMMITPERCLIP_REVIEW_TOKEN=ephemeral-test-token/);
});
