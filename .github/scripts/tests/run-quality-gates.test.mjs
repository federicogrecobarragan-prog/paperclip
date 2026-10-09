import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findExistingComment } from '../run-quality-gates.mjs';

test('findExistingComment: paginates until it finds the commitperclip comment', async () => {
  const seenPaths = [];
  const comment = await findExistingComment(async (path) => {
    seenPaths.push(path);
    if (path.endsWith('page=1')) {
      return Array.from({ length: 100 }, (_, index) => ({
        id: index + 1,
        user: { login: 'someone-else' },
        body: 'unrelated',
      }));
    }
    if (path.endsWith('page=2')) {
      return [{
        id: 200,
        user: { login: 'commitperclip[bot]' },
        body: 'Looks good.\n\n— commitperclip',
      }];
    }
    return [];
  }, 'token', 'paperclipai/paperclip', 6469);

  assert.equal(comment.id, 200);
  assert.deepEqual(seenPaths, [
    '/repos/paperclipai/paperclip/issues/6469/comments?per_page=100&page=1',
    '/repos/paperclipai/paperclip/issues/6469/comments?per_page=100&page=2',
  ]);
});

test('findExistingComment: returns null when no signed comment exists', async () => {
  const comment = await findExistingComment(async () => ([
    {
      id: 1,
      user: { login: 'commitperclip[bot]' },
      body: 'Unsigned status update',
    },
  ]), 'token', 'paperclipai/paperclip', 6469);

  assert.equal(comment, null);
});

test('findExistingComment: fork mode updates the signed github-actions bot comment idempotently', async () => {
  const comment = await findExistingComment(async () => ([
    {
      id: 77,
      user: { login: 'github-actions[bot]' },
      body: 'Fork review status\n\n— commitperclip',
    },
  ]), 'token', 'fork-owner/paperclip', 13);

  assert.equal(comment.id, 77);
});

test('findExistingComment: explicit fork author never selects an app-authored comment', async () => {
  const comment = await findExistingComment(async () => ([
    {
      id: 70,
      user: { login: 'commitperclip[bot]' },
      body: 'App status\n\n— commitperclip',
    },
    {
      id: 77,
      user: { login: 'github-actions[bot]' },
      body: 'Fork status\n\n— commitperclip',
    },
  ]), 'token', 'fork-owner/paperclip', 13, ['github-actions[bot]']);

  assert.equal(comment.id, 77);
});

test('findExistingComment: a user cannot claim the signature to hijack updates', async () => {
  const comment = await findExistingComment(async () => ([
    {
      id: 88,
      user: { login: 'untrusted-user' },
      body: 'Spoofed\n\n— commitperclip',
    },
  ]), 'token', 'fork-owner/paperclip', 13);

  assert.equal(comment, null);
});
