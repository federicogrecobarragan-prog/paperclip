#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ghFetch } from './get-bot-token.mjs';

const REPO_PATTERN = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

export function parsePullRequestNumber(value) {
  if (!/^[1-9]\d*$/.test(value ?? '')) {
    throw new Error('PR_NUMBER must be a strict positive integer.');
  }
  return Number(value);
}

export async function resolveReviewContext({ token, repo, prNumber, fetchFromGitHub = ghFetch }) {
  if (!token) throw new Error('GITHUB_TOKEN is required.');
  if (!REPO_PATTERN.test(repo ?? '')) throw new Error('GH_REPO must be in owner/repo format.');

  const number = parsePullRequestNumber(prNumber);
  const pr = await fetchFromGitHub(`/repos/${repo}/pulls/${number}`, token);
  if (pr.base?.repo?.full_name !== repo) {
    throw new Error('The selected pull request does not target this repository.');
  }
  if (!pr.base?.sha || !pr.head?.sha || !pr.head?.ref || !pr.user?.login) {
    throw new Error('The pull request response is missing required immutable context.');
  }

  return {
    number,
    baseSha: pr.base.sha,
    headSha: pr.head.sha,
    headRef: pr.head.ref,
    author: pr.user.login,
  };
}

export function writeReviewContext(outputPath, context) {
  if (!outputPath) throw new Error('GITHUB_OUTPUT is required.');
  for (const value of Object.values(context)) {
    if (/\r|\n/.test(String(value))) throw new Error('Workflow output contains a newline.');
  }
  appendFileSync(
    outputPath,
    [
      `number=${context.number}`,
      `base_sha=${context.baseSha}`,
      `head_sha=${context.headSha}`,
      `head_ref=${context.headRef}`,
      `author=${context.author}`,
      '',
    ].join('\n'),
    'utf8',
  );
}

async function main() {
  const context = await resolveReviewContext({
    token: process.env.GITHUB_TOKEN,
    repo: process.env.GH_REPO,
    prNumber: process.env.PR_NUMBER,
  });
  writeReviewContext(process.env.GITHUB_OUTPUT, context);
  console.log(`[review-context] resolved PR #${context.number} without checking out pull-request code`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('[review-context] failed to resolve a strict pull-request context');
    process.exitCode = 1;
  });
}
