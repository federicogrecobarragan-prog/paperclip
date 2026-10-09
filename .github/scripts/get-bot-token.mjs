#!/usr/bin/env node
/**
 * get-bot-token.mjs
 * Selects the workflow credential without executing pull-request code.
 *
 * - `app`: generate a short-lived commitperclip installation token.
 * - `github-token`: use the workflow's ephemeral GITHUB_TOKEN (fork mode).
 *
 * The mode is mandatory so a missing upstream App key can never silently
 * downgrade the advisory workflow to the less-privileged fork contract.
 *
 * Also exports: generateJWT(privateKey), ghFetch(path, token, options)
 * These are used by all other gate scripts.
 */
import { createSign } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const APP_ID = '3718661';
const OWNER_PATTERN = /^[a-zA-Z0-9_.-]+$/;
const REPO_PATTERN = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
export const TOKEN_MODES = Object.freeze({
  APP: 'app',
  GITHUB_TOKEN: 'github-token',
});

export function generateJWT(privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iat: now - 10, exp: now + 60, iss: APP_ID };
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const data = `${header}.${body}`;
  const sig = createSign('RSA-SHA256').update(data).sign(privateKey, 'base64url');
  return `${data}.${sig}`;
}

// Per-call timeout so a single slow/hung GitHub endpoint cannot eat the entire
// workflow budget. Overridable via options.timeoutMs for callers that need
// different bounds.
export const GH_FETCH_DEFAULT_TIMEOUT_MS = 15_000;

export async function ghFetch(path, token, options = {}) {
  const { timeoutMs = GH_FETCH_DEFAULT_TIMEOUT_MS, signal: externalSignal, ...fetchOptions } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`ghFetch timeout after ${timeoutMs}ms: ${path}`)), timeoutMs);
  const abortOnExternal = () => controller.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) abortOnExternal();
    else externalSignal.addEventListener('abort', abortOnExternal, { once: true });
  }
  try {
    const res = await fetch(`https://api.github.com${path}`, {
      ...fetchOptions,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...fetchOptions.headers,
      },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`GitHub API ${fetchOptions.method ?? 'GET'} ${path} → ${res.status}: ${text}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', abortOnExternal);
  }
}

export async function resolveInstallationId(fetchInstallation, token, repo, owner) {
  if (repo) {
    if (!REPO_PATTERN.test(repo)) {
      throw new Error('ERROR: GH_REPO/GITHUB_REPOSITORY must be in owner/repo format.');
    }

    const installation = await fetchInstallation(`/repos/${repo}/installation`, token);
    return installation.id;
  }

  const installations = await fetchInstallation('/app/installations', token);
  if (!installations.length) {
    throw new Error(
      'ERROR: No installations found for commitperclip. Install URL: https://github.com/apps/commitperclip/installations/new'
    );
  }

  if (owner) {
    if (!OWNER_PATTERN.test(owner)) {
      throw new Error('ERROR: GITHUB_REPOSITORY_OWNER must be a valid GitHub owner name.');
    }

    const match = installations.find(
      installation => installation.account?.login?.toLowerCase() === owner.toLowerCase()
    );

    if (match) {
      return match.id;
    }
  }

  if (installations.length === 1) {
    return installations[0].id;
  }

  throw new Error(
    'ERROR: Multiple commitperclip installations found. Set GH_REPO or GITHUB_REPOSITORY so the correct installation can be selected.'
  );
}

export async function resolveWorkflowToken({
  mode,
  privateKey,
  githubToken,
  repo,
  owner,
  fetchFromGitHub = ghFetch,
  signJwt = generateJWT,
}) {
  if (mode === TOKEN_MODES.GITHUB_TOKEN) {
    if (!githubToken) {
      throw new Error('ERROR: GITHUB_TOKEN env var not set for explicit fork token mode.');
    }
    return { token: githubToken, mode, securityMode: 'report' };
  }

  if (mode !== TOKEN_MODES.APP) {
    throw new Error('ERROR: COMMITPERCLIP_TOKEN_MODE must be explicitly set to app or github-token.');
  }
  if (!privateKey) {
    throw new Error('ERROR: COMMITPERCLIP_KEY env var not set for upstream app mode.');
  }

  const jwt = signJwt(privateKey);
  const installationId = await resolveInstallationId(fetchFromGitHub, jwt, repo, owner);

  const { token } = await fetchFromGitHub(
    `/app/installations/${installationId}/access_tokens`,
    jwt,
    { method: 'POST', headers: { 'Content-Type': 'application/json' } }
  );

  if (!token) {
    throw new Error('ERROR: Failed to get installation token from GitHub API.');
  }

  return { token, mode, securityMode: 'advisory' };
}

export function writeWorkflowOutputs(outputPath, environmentPath, { token, mode, securityMode }) {
  if (!outputPath) {
    throw new Error('ERROR: GITHUB_OUTPUT env var not set.');
  }
  if (!environmentPath) {
    throw new Error('ERROR: GITHUB_ENV env var not set.');
  }
  if (/\r|\n/.test(token)) {
    throw new Error('ERROR: Refusing to write a multiline workflow token.');
  }

  // Keep the selected token out of step outputs. App mode can therefore never
  // fall through to github.token if an output is dropped by secret scanning.
  process.stdout.write(`::add-mask::${token}\n`);
  appendFileSync(environmentPath, `COMMITPERCLIP_REVIEW_TOKEN=${token}\n`, 'utf8');
  appendFileSync(outputPath, `mode=${mode}\nsecurity_mode=${securityMode}\n`, 'utf8');
}

async function main() {
  const repo = process.env.GH_REPO ?? process.env.GITHUB_REPOSITORY;
  const owner = process.env.GITHUB_REPOSITORY_OWNER ?? repo?.split('/')[0];
  const result = await resolveWorkflowToken({
    mode: process.env.COMMITPERCLIP_TOKEN_MODE,
    privateKey: process.env.COMMITPERCLIP_KEY,
    githubToken: process.env.GITHUB_TOKEN,
    repo,
    owner,
  });

  writeWorkflowOutputs(process.env.GITHUB_OUTPUT, process.env.GITHUB_ENV, result);
  console.log(`[token] selected explicit ${result.mode} mode`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e.message); process.exitCode = 1; });
}
