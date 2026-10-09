#!/usr/bin/env node
/**
 * run-quality-gates.mjs
 * Orchestrates all quality gates. Fetches PR data once, runs all gates,
 * posts or updates a single consolidated comment via commitperclip.
 *
 * Env: GH_TOKEN, GH_REPO, PR_NUMBER, PR_AUTHOR, PR_BRANCH
 * Exit: 0 if all quality gates pass, 1 if any fail.
 */
import { fileURLToPath } from 'node:url';
import { ghFetch } from './get-bot-token.mjs';
import { fetchAllPullRequestFiles } from './fetch-pr-files.mjs';
import { checkTemplate } from './check-pr-template.mjs';
import { checkLinkedIssue } from './check-pr-linked-issue.mjs';
import { checkDedupSearch } from './check-pr-dedup-search.mjs';
import { checkTestCoverage } from './check-pr-test-coverage.mjs';
import { checkLockfile } from './check-pr-lockfile.mjs';
import { checkDependencies } from './check-pr-dependencies.mjs';

const COMMENT_SIGNATURE = '— commitperclip';
const COMMENT_AUTHORS = new Set([
  'commitperclip[bot]',
  'commitperclip',
  'github-actions[bot]',
]);

function buildComment(author, failures, informational) {
  if (failures.length === 0 && informational.length === 0) {
    return `✅ All checks passing — ready for Greptile review and maintainer approval.\n\n${COMMENT_SIGNATURE}`;
  }

  const lines = [
    `Hey @${author}! Before this PR can be reviewed, a few things need attention:\n`,
  ];

  if (failures.length > 0) {
    lines.push('**Missing or incomplete:**');
    for (const f of failures) lines.push(`- [ ] ${f}`);
  }

  if (informational.length > 0) {
    if (failures.length > 0) lines.push('');
    lines.push('**Informational:**');
    for (const i of informational) lines.push(`- ${i}`);
  }

  lines.push(
    '\nOnce updated, push a new commit and these checks will re-run automatically.\n',
    COMMENT_SIGNATURE
  );

  return lines.join('\n');
}

export async function findExistingComment(fetchFromGitHub, token, repo, prNumber, allowedAuthors = COMMENT_AUTHORS) {
  const allowed = allowedAuthors instanceof Set ? allowedAuthors : new Set(allowedAuthors);
  for (let page = 1; ; page += 1) {
    const comments = await fetchFromGitHub(
      `/repos/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`,
      token
    );

    const existing = comments.find(
      c => allowed.has(c.user?.login) &&
           typeof c.body === 'string' &&
           c.body.includes(COMMENT_SIGNATURE)
    );
    if (existing) return existing;

    if (comments.length < 100) return null;
  }
}

async function upsertComment(token, repo, prNumber, body, existing) {
  if (existing) {
    await ghFetch(`/repos/${repo}/issues/comments/${existing.id}`, token, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
  } else {
    await ghFetch(`/repos/${repo}/issues/${prNumber}/comments`, token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
  }
}

async function main() {
  const { GH_REPO, PR_NUMBER, PR_AUTHOR, PR_BRANCH, QUALITY_COMMENT_AUTHORS } = process.env;
  const GH_TOKEN = process.env.COMMITPERCLIP_REVIEW_TOKEN ?? process.env.GH_TOKEN;

  if (!GH_TOKEN || !GH_REPO || !PR_NUMBER) {
    console.error('ERROR: GH_TOKEN, GH_REPO, PR_NUMBER env vars required');
    process.exit(1);
  }

  // Sanitize inputs before use in URL construction (prevents SSRF)
  if (!/^[1-9]\d*$/.test(PR_NUMBER)) {
    console.error('ERROR: PR_NUMBER must be a positive integer');
    process.exit(1);
  }
  const prNumber = Number(PR_NUMBER);
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(GH_REPO)) {
    console.error('ERROR: GH_REPO must be in owner/repo format');
    process.exit(1);
  }

  // Fetch PR data once — gates use this, no redundant API calls
  const [pr, files] = await Promise.all([
    ghFetch(`/repos/${GH_REPO}/pulls/${prNumber}`, GH_TOKEN),
    fetchAllPullRequestFiles(ghFetch, GH_REPO, prNumber, GH_TOKEN),
  ]);

  const prBody = pr.body ?? '';
  const author = PR_AUTHOR ?? pr.user.login;
  const branch = PR_BRANCH ?? pr.head.ref;

  // Run all quality gates (pure functions run sync, deps check is async)
  const prTitle = pr.title ?? '';
  const [templateResult, issueResult, dedupResult, testResult, lockfileResult, depsResult] =
    await Promise.all([
      Promise.resolve(checkTemplate(prBody)),
      Promise.resolve(checkLinkedIssue(prBody, prTitle)),
      Promise.resolve(checkDedupSearch(prBody, prTitle)),
      Promise.resolve(checkTestCoverage(files, prTitle)),
      Promise.resolve(checkLockfile(files, author, branch)),
      checkDependencies(files, GH_TOKEN, GH_REPO, prNumber, pr.base?.ref),
    ]);

  const allFailures = [
    ...templateResult.failures,
    ...issueResult.failures,
    ...dedupResult.failures,
    ...testResult.failures,
    ...lockfileResult.failures,
  ];
  const informational = depsResult.informational ?? [];
  const allPassed = allFailures.length === 0;

  const commentBody = buildComment(author, allFailures, informational);

  // Post comment if there are failures/informational, or update existing comment
  const allowedCommentAuthors = QUALITY_COMMENT_AUTHORS
    ? QUALITY_COMMENT_AUTHORS.split(',').map(value => value.trim()).filter(Boolean)
    : COMMENT_AUTHORS;
  const existing = await findExistingComment(ghFetch, GH_TOKEN, GH_REPO, prNumber, allowedCommentAuthors);
  if (allFailures.length > 0 || informational.length > 0 || existing) {
    await upsertComment(GH_TOKEN, GH_REPO, prNumber, commentBody, existing);
  }

  console.log(JSON.stringify({ passed: allPassed, failures: allFailures, informational }));
  process.exit(allPassed ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
