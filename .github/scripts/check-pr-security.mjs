#!/usr/bin/env node
/**
 * check-pr-security.mjs
 * Runs 6 security checks against a PR diff. Never posts public comments.
 * Upstream app mode creates a draft advisory for findings; fork report mode
 * stores only sanitized metadata in a durable workflow artifact.
 *
 * Env: GH_TOKEN, GH_REPO, PR_NUMBER, SECURITY_REPORT_MODE,
 *      SECURITY_REPORT_PATH
 * Exit: 0 after scan/report/check-run completion. Infrastructure failures
 *       fail closed; findings remain neutral for human review.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ghFetch } from './get-bot-token.mjs';
import { fetchAllPullRequestFiles } from './fetch-pr-files.mjs';
import { resolveBaseRef } from './check-pr-dependencies.mjs';

// ── Pure check functions (exported for testing) ───────────────────────────────

const SECRET_PATTERNS = [
  { name: 'OpenAI API key', re: /sk-[a-zA-Z0-9]{32,}/ },
  { name: 'Google API key', re: /AIza[0-9A-Za-z\-_]{35}/ },
  { name: 'AWS access key', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'Private key', re: /-----BEGIN (RSA|EC|OPENSSH) PRIVATE KEY-----/ },
  { name: 'High-entropy secret', re: /[a-zA-Z_]*(key|token|secret|password|credential)[a-zA-Z_]*\s*[=:]\s*["'][^"']{20,}["']/i },
];

export function scanSecrets(files) {
  const flags = [];
  for (const file of files) {
    if (!file.patch) continue;
    const added = file.patch.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));
    for (const line of added) {
      for (const { name, re } of SECRET_PATTERNS) {
        if (re.test(line)) {
          // Never persist or log the matching line: it may contain the secret.
          flags.push({ check: 'secret-scan', file: file.filename, pattern: name });
        }
      }
    }
  }
  return flags;
}

const CI_BUILD_SCRIPTS = [
  'scripts/release.sh',
  'scripts/check-docker-deps-stage.mjs',
  'scripts/check-release-package-bootstrap.mjs',
  'scripts/release-package-map.mjs',
  'scripts/docker-onboard-smoke.sh',
];

export function scanCITampering(files) {
  return files
    .filter(f => f.filename.startsWith('.github/workflows/') && f.status !== 'removed')
    .map(f => ({ check: 'ci-tampering', file: f.filename }));
}

export function scanBuildScripts(files) {
  return files
    .filter(f => CI_BUILD_SCRIPTS.includes(f.filename) && f.status !== 'removed')
    .map(f => ({ check: 'build-script-change', file: f.filename }));
}

export function scanSupplyChain(files) {
  const lockfile = files.find(f => f.filename === 'pnpm-lock.yaml');
  if (!lockfile?.patch) return [];

  const added = new Set();
  const removed = new Set();

  for (const line of lockfile.patch.split('\n')) {
    const entry = parseLockfilePackageDiffEntry(line);
    if (!entry) continue;
    if (entry.sign === '+') added.add(entry.packageName);
    if (entry.sign === '-') removed.add(entry.packageName);
  }

  const netNew = [...added].filter(p => !removed.has(p));
  return netNew.length ? [{ check: 'supply-chain', packages: netNew }] : [];
}

function parseLockfilePackageDiffEntry(line) {
  const match = line.match(/^([+-])\s*(.+?)\s*$/);
  if (!match) return null;

  let [, sign, rawEntry] = match;
  if (!rawEntry.endsWith(':')) return null;

  rawEntry = rawEntry.slice(0, -1).trim();
  if ((rawEntry.startsWith("'") && rawEntry.endsWith("'")) || (rawEntry.startsWith('"') && rawEntry.endsWith('"'))) {
    rawEntry = rawEntry.slice(1, -1);
  }
  rawEntry = rawEntry.replace(/\(.*$/, '').trim();

  const versionSep = rawEntry.lastIndexOf('@');
  if (versionSep <= 0 || versionSep === rawEntry.length - 1) return null;

  const packageName = rawEntry.slice(0, versionSep);
  if (!/^(?:@[^/\s:]+\/)?[A-Za-z0-9._-][A-Za-z0-9._/-]*$/.test(packageName)) return null;

  return { sign, packageName };
}

const TEST_FILE_RE = /\.(test|spec)\.(ts|js|tsx|jsx)$|\/(?:__tests__|tests?)\//;
const SUSPICIOUS_PATTERNS = [
  { name: 'outbound-network', re: /\+.*(fetch\(|axios\.|http\.request|https\.request)/ },
  { name: 'env-var-read', re: /\+.*process\.env\.(?!(?:NODE_ENV|CI|TEST|VITEST|npm_))([A-Z_]{4,})/ },
  { name: 'shell-exec', re: /\+.*(execSync\(|spawnSync\(|exec\(|spawn\()/ },
  { name: 'absolute-file-read', re: /\+.*(readFile|readFileSync)\s*\(\s*["'`]?\// },
];

export function scanTestPatterns(files) {
  const flags = [];
  for (const file of files) {
    if (!TEST_FILE_RE.test(file.filename) || !file.patch) continue;
    for (const { name, re } of SUSPICIOUS_PATTERNS) {
      if (re.test(file.patch)) {
        flags.push({ check: 'suspicious-test', file: file.filename, pattern: name });
      }
    }
  }
  return flags;
}

const SENSITIVE_PATHS = [
  // Advisory 1: codex-local adapter (inherited ChatGPT/Gmail OAuth scopes)
  'packages/adapters/codex-local/',
  // Advisory 2 & 11: OS command injection / privilege escalation via provisionCommand / cleanupCommand
  'server/src/services/workspace-realization.ts',
  'server/src/routes/execution-workspaces.ts',
  'server/src/routes/workspace-command-authz.ts',
  // Advisory 3 & 6: Cross-tenant agent API key minting and IDOR on /agents/:id/keys
  'server/src/routes/agents.ts',
  // Advisory 4: Approval decision attribution spoofing via decidedByUserId
  'server/src/routes/approvals.ts',
  // Advisory 5: Stored XSS via javascript: URLs in MarkdownBody (urlTransform)
  'ui/src/components/MarkdownBody.tsx',
  // Advisory 7: Unauthenticated access to authenticated-mode endpoints
  'server/src/routes/authz.ts',
  // Advisory 8: Unauthenticated RCE via import authorization bypass
  'server/src/routes/companies.ts',
  // Advisory 9: Malicious skills able to exfiltrate / destroy user data
  'server/src/routes/company-skills.ts',
  // Advisory 10: Arbitrary file read via agent-controlled instructionsFilePath
  'server/src/services/agent-instructions.ts',
];

export function scanSensitivePaths(files) {
  return files
    .filter(f => f.status !== 'removed' && SENSITIVE_PATHS.some(p => f.filename.startsWith(p)))
    .map(f => ({
      check: 'sensitive-path',
      file: f.filename,
      advisoryPath: SENSITIVE_PATHS.find(p => f.filename.startsWith(p)),
    }));
}

export const SECURITY_CHECK_NAMES = Object.freeze([
  'secret-scan',
  'ci-tampering',
  'build-script-change',
  'supply-chain',
  'suspicious-test',
  'sensitive-path',
]);

export function scanSecurityFlags(files) {
  return [
    ...scanSecrets(files),
    ...scanCITampering(files),
    ...scanBuildScripts(files),
    ...scanSupplyChain(files),
    ...scanTestPatterns(files),
    ...scanSensitivePaths(files),
  ];
}

function buildContentsPath(repo, filename, ref) {
  return `/repos/${repo}/contents/${filename}?${new URLSearchParams({ ref }).toString()}`;
}

export async function validateSensitivePaths(token, repo, prNumber, baseRef, fetchFromGitHub = ghFetch) {
  const resolvedBaseRef = await resolveBaseRef(fetchFromGitHub, token, repo, prNumber, baseRef);
  const stale = [];
  await Promise.all(SENSITIVE_PATHS.map(async (path) => {
    try {
      await fetchFromGitHub(buildContentsPath(repo, path, resolvedBaseRef), token);
    } catch (err) {
      // 404 means the file/directory no longer exists at this path
      if (String(err.message).includes('404')) stale.push(path);
      // Other errors (network, rate limit) — re-throw so we don't silently miss them
      else throw err;
    }
  }));
  return stale;
}

// ── Advisory creation ─────────────────────────────────────────────────────────

const SEVERITY_MAP = {
  'supply-chain': 'critical',
  'sensitive-path': 'critical',
  'secret-scan': 'high',
  'ci-tampering': 'high',
  'suspicious-test': 'high',
  'build-script-change': 'medium',
};

const SEVERITY_ORDER = ['low', 'medium', 'high', 'critical'];

function worstSeverity(flags) {
  return flags.reduce((worst, f) => {
    const s = SEVERITY_MAP[f.check] ?? 'medium';
    return SEVERITY_ORDER.indexOf(s) > SEVERITY_ORDER.indexOf(worst) ? s : worst;
  }, 'low');
}

export function buildAdvisoryPayload(prNumber, prTitle, flags) {
  const checkNames = [...new Set(flags.map(f => f.check))].join(', ');
  return {
    summary: `🚨 Security flag — PR #${prNumber}: ${checkNames}`,
    description: [
    `**PR:** #${prNumber} — ${prTitle}`,
    `**Checks triggered:** ${checkNames}`,
    '',
    '**Details:**',
    ...flags.map(f => [
      `- \`${f.check}\`: ${f.file ?? ''}`,
      f.pattern ? ` (pattern: ${f.pattern})` : '',
      f.packages ? ` (packages: ${f.packages.join(', ')})` : '',
      f.line ? `\n  \`${f.line}\`` : '',
    ].join('')),
    '',
    '> This advisory was created automatically by commitperclip. Review and dismiss if not a real concern.',
    ].join('\n'),
    severity: worstSeverity(flags),
    vulnerabilities: [],
  };
}

export async function syncDraftAdvisory(fetchImpl, token, repo, prNumber, prTitle, flags) {
  const existing = await findExistingDraftAdvisory(fetchImpl, token, repo, prNumber);
  const payload = buildAdvisoryPayload(prNumber, prTitle, flags);

  if (existing) {
    const advisoryId = existing.ghsa_id ?? existing.id;
    if (!advisoryId) {
      throw new Error(`Existing advisory for PR #${prNumber} is missing both ghsa_id and id.`);
    }

    // PATCH rejects `vulnerabilities: []` with 422 ("Advisory must have at least one vulnerability").
    // The field is only valid on POST when creating the draft; updates must omit it.
    const { vulnerabilities, ...patchPayload } = payload;

    return fetchImpl(`/repos/${repo}/security-advisories/${advisoryId}`, token, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patchPayload),
    });
  }

  return fetchImpl(`/repos/${repo}/security-advisories`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

// Cap pagination so a large backlog of unrelated draft advisories cannot stall
// the security gate (it runs inside a 5-minute workflow timeout).
const MAX_DRAFT_ADVISORY_PAGES = 20;

export async function findExistingDraftAdvisory(fetchImpl, token, repo, prNumber) {
  const prMarker = `PR #${prNumber}`;

  for (let page = 1; page <= MAX_DRAFT_ADVISORY_PAGES; page += 1) {
    const advisories = await fetchImpl(
      `/repos/${repo}/security-advisories?state=draft&per_page=100&page=${page}`,
      token,
    );

    if (!Array.isArray(advisories) || advisories.length === 0) return null;

    const existing = advisories.find(advisory =>
      typeof advisory?.summary === 'string' && advisory.summary.includes(prMarker)
    );
    if (existing) return existing;

    if (advisories.length < 100) return null;
  }

  console.warn(
    `[security] findExistingDraftAdvisory: hit ${MAX_DRAFT_ADVISORY_PAGES}-page cap without finding PR #${prNumber}; ` +
    'treating as new advisory. A duplicate draft may be created.',
  );
  return null;
}

const PUBLIC_METADATA_MAX_LENGTH = 240;
const PUBLIC_SECRET_REDACTIONS = [
  /sk-[a-zA-Z0-9]{32,}/g,
  /AIza[0-9A-Za-z\-_]{35}/g,
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN (?:RSA|EC|OPENSSH) PRIVATE KEY-----/g,
  /((?:key|token|secret|password|credential)[^=:\r\n]{0,32}[=:]\s*)[^\s]{20,}/gi,
];

export function sanitizePublicMetadata(value) {
  let sanitized = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  for (const pattern of PUBLIC_SECRET_REDACTIONS) {
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }
  return sanitized.slice(0, PUBLIC_METADATA_MAX_LENGTH);
}

export function buildSecurityReport({ repo, prNumber, headSha, mode, flags, checkRunCreated = false, advisorySynced = false }) {
  if (mode !== 'advisory' && mode !== 'report') {
    throw new Error('SECURITY_REPORT_MODE must be advisory or report.');
  }

  const checks = SECURITY_CHECK_NAMES.map(check => {
    const matches = flags.filter(flag => flag.check === check);
    return {
      check,
      count: matches.length,
      files: [...new Set(matches.map(flag => flag.file).filter(Boolean).map(sanitizePublicMetadata))],
      patterns: [...new Set(matches.flatMap(flag => {
        if (flag.pattern) return [sanitizePublicMetadata(flag.pattern)];
        if (Array.isArray(flag.packages) && flag.packages.length > 0) return ['net-new-package'];
        return [];
      }))],
    };
  });
  const totalFindings = checks.reduce((total, check) => total + check.count, 0);

  return {
    schemaVersion: 1,
    repository: sanitizePublicMetadata(repo),
    pullRequest: prNumber,
    headSha: sanitizePublicMetadata(headSha),
    mode,
    scanCompleted: true,
    reportWritten: true,
    checkRunCreated,
    advisorySynced,
    totalFindings,
    conclusion: totalFindings > 0 ? 'neutral' : 'success',
    outcome: totalFindings > 0 ? 'review_required' : 'clear',
    checks,
  };
}

export async function writeSecurityReport(reportPath, report) {
  if (!reportPath) throw new Error('SECURITY_REPORT_PATH is required.');
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function buildReportModeCheckSummary(report) {
  const lines = [
    `Sanitized security report: ${report.totalFindings} finding(s) across ${SECURITY_CHECK_NAMES.length} checks.`,
  ];
  for (const check of report.checks.filter(item => item.count > 0)) {
    const metadata = [];
    if (check.files.length > 0) metadata.push(`files: ${check.files.join(', ')}`);
    if (check.patterns.length > 0) metadata.push(`patterns: ${check.patterns.join(', ')}`);
    lines.push(`- ${check.check}: ${check.count}${metadata.length > 0 ? ` (${metadata.join('; ')})` : ''}`);
  }
  lines.push('Review the commitperclip-security-report artifact; no matching source lines or secret values are included.');
  return lines.join('\n').slice(0, 60_000);
}

export async function postSecurityCheckRun(fetchImpl, token, repo, headSha, reportOrHasFlags) {
  const report = typeof reportOrHasFlags === 'boolean'
    ? { mode: 'advisory', totalFindings: reportOrHasFlags ? 1 : 0 }
    : reportOrHasFlags;
  const hasFlags = report.totalFindings > 0;
  const flaggedOutput = report.mode === 'report'
    ? {
        title: 'Security Review Required',
        summary: buildReportModeCheckSummary(report),
      }
    : {
        title: 'Security Review Recommended',
        summary: 'Draft advisory filed for maintainer review. Not a merge block — review the advisory at your leisure.',
      };
  await fetchImpl(`/repos/${repo}/check-runs`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(hasFlags ? {
      name: 'security-review',
      head_sha: headSha,
      // `completed/neutral` instead of `in_progress` so the check doesn't put
      // the PR in `mergeStateStatus: BLOCKED`. The draft advisory is the
      // durable signal for maintainers; there is no completion path that
      // could ever flip an `in_progress` check-run back to completed on the
      // same head SHA, so it would hang forever.
      status: 'completed',
      conclusion: 'neutral',
      output: flaggedOutput,
    } : {
      name: 'security-review',
      head_sha: headSha,
      status: 'completed',
      conclusion: 'success',
      output: {
        title: 'Security Review Passed',
        summary: 'No security concerns detected.',
      },
    }),
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

// Wall-clock budget for the whole script. The workflow job has a 5-minute
// timeout-minutes, and `continue-on-error: true` on a step does NOT override
// a job-level timeout — it only suppresses step failures. So if any API call
// (e.g. security-advisories POST/PATCH) hangs, the whole job is cancelled,
// failing the `review` check. This watchdog enforces the script's documented
// fail-closed contract regardless of API behaviour.
export const SCRIPT_WATCHDOG_MS = 90_000;

export function startScriptWatchdog(timeoutMs = SCRIPT_WATCHDOG_MS, exit = process.exit) {
  const timer = setTimeout(() => {
    console.warn(
      `[security] script exceeded ${timeoutMs}ms wall-clock budget; failing closed`
    );
    exit(1);
  }, timeoutMs);
  // Don't keep the event loop alive solely for the watchdog.
  timer.unref?.();
  return timer;
}

export async function runSecurityReview({
  token,
  repo,
  prNumber,
  mode,
  reportPath,
  fetchFromGitHub = ghFetch,
  fetchPullRequestFiles = fetchAllPullRequestFiles,
}) {
  if (!token || !repo || !Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error('A token, repository, and positive PR number are required.');
  }
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo)) {
    throw new Error('GH_REPO must be in owner/repo format.');
  }
  if (mode !== 'advisory' && mode !== 'report') {
    throw new Error('SECURITY_REPORT_MODE must be advisory or report.');
  }

  const stalePaths = await validateSensitivePaths(token, repo, prNumber, undefined, fetchFromGitHub);
  if (stalePaths.length > 0) {
    throw new Error('Sensitive path policy is stale.');
  }

  const [pr, files] = await Promise.all([
    fetchFromGitHub(`/repos/${repo}/pulls/${prNumber}`, token),
    fetchPullRequestFiles(fetchFromGitHub, repo, prNumber, token),
  ]);
  const flags = scanSecurityFlags(files);
  let report = buildSecurityReport({
    repo,
    prNumber,
    headSha: pr.head.sha,
    mode,
    flags,
  });

  // Persist the completed scan before any follow-up API writes. If advisory
  // or check-run creation fails, the verifier sees the missing completion bit
  // and the workflow remains red.
  await writeSecurityReport(reportPath, report);

  if (flags.length > 0 && mode === 'advisory') {
    await syncDraftAdvisory(fetchFromGitHub, token, repo, prNumber, pr.title, flags);
    report = { ...report, advisorySynced: true };
    await writeSecurityReport(reportPath, report);
  }

  await postSecurityCheckRun(fetchFromGitHub, token, repo, pr.head.sha, report);
  report = { ...report, checkRunCreated: true };
  await writeSecurityReport(reportPath, report);

  console.log(
    flags.length > 0
      ? `[security] ${flags.length} sanitized finding(s); human review requested`
      : '[security] all six scan families completed with no findings',
  );
  return report;
}

async function main() {
  const watchdog = startScriptWatchdog();

  const { GH_REPO, PR_NUMBER, SECURITY_REPORT_MODE, SECURITY_REPORT_PATH } = process.env;
  const GH_TOKEN = process.env.COMMITPERCLIP_REVIEW_TOKEN ?? process.env.GH_TOKEN;

  if (!GH_TOKEN || !GH_REPO || !PR_NUMBER || !SECURITY_REPORT_MODE || !SECURITY_REPORT_PATH) {
    throw new Error('Required security workflow environment is missing.');
  }

  // Sanitize inputs before use in URL construction (prevents SSRF)
  if (!/^[1-9]\d*$/.test(PR_NUMBER)) {
    throw new Error('PR_NUMBER must be a positive integer.');
  }
  const prNumber = Number(PR_NUMBER);
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(GH_REPO)) {
    console.error('ERROR: GH_REPO must be in owner/repo format');
    process.exit(1);
  }

  try {
    await runSecurityReview({
      token: GH_TOKEN,
      repo: GH_REPO,
      prNumber,
      mode: SECURITY_REPORT_MODE,
      reportPath: SECURITY_REPORT_PATH,
    });
  } finally {
    clearTimeout(watchdog);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // API responses and matching source lines can contain attacker-controlled
    // data. Keep failure logging generic and fail closed.
    console.error('[security] processing failed; review the failed step without printing response bodies');
    process.exitCode = 1;
  });
}
