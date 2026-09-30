import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parsePullRequestNumber, resolveReviewContext } from '../resolve-review-context.mjs';

const testDir = dirname(fileURLToPath(import.meta.url));
const workflowPath = resolve(testDir, '../../workflows/commitperclip-review.yml');

test('parsePullRequestNumber: accepts only a strict positive integer', () => {
  assert.equal(parsePullRequestNumber('13'), 13);
  for (const invalid of ['13abc', '0', '-1', ' 13', '13 ', '', undefined]) {
    assert.throws(() => parsePullRequestNumber(invalid), /strict positive integer/);
  }
});

test('resolveReviewContext: requires the PR to target the current repository', async () => {
  await assert.rejects(
    resolveReviewContext({
      token: 'token',
      repo: 'fork-owner/paperclip',
      prNumber: '13',
      fetchFromGitHub: async () => ({
        base: { repo: { full_name: 'someone-else/paperclip' }, sha: 'base' },
        head: { sha: 'head', ref: 'feature' },
        user: { login: 'author' },
      }),
    }),
    /does not target this repository/,
  );
});

test('review workflow: never checks out PR head code and supports a strict manual canary', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const checkoutBlock = workflow.match(/- name: Checkout trusted workflow source[\s\S]*?\n\s*- name: Set up Node/)?.[0] ?? '';

  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /PR_NUMBER: .*inputs\.pr_number/);
  assert.match(checkoutBlock, /github\.event\.pull_request\.base\.sha/);
  assert.doesNotMatch(checkoutBlock, /pull_request\.head/);
  assert.match(checkoutBlock, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /TOKEN=\$\(/);
});

test('review workflow: fork report, always-upload, and final fail-closed verifier are wired', async () => {
  const workflow = await readFile(workflowPath, 'utf8');

  assert.match(workflow, /github\.event_name == 'pull_request_target' && github\.repository == 'paperclipai\/paperclip' && 'app' \|\| 'github-token'/);
  assert.match(workflow, /github\.event_name == 'pull_request_target' && github\.repository == 'paperclipai\/paperclip' && secrets\.COMMITPERCLIP_KEY \|\| ''/);
  assert.match(workflow, /SECURITY_REPORT_MODE: \$\{\{ steps\.token\.outputs\.security_mode \}\}/);
  assert.match(workflow, /QUALITY_COMMENT_AUTHORS: .*github-actions\[bot\]/);
  assert.doesNotMatch(workflow, /steps\.token\.outputs\.value/);
  assert.match(workflow, /name: Upload durable sanitized security report[\s\S]*?if: always\(\)/);
  assert.match(workflow, /if-no-files-found: error/);
  assert.match(workflow, /name: Verify every review control completed[\s\S]*?if: always\(\)/);
  assert.match(workflow, /actions\/upload-artifact@[0-9a-f]{40}/);
});
