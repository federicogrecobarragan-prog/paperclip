#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { SECURITY_CHECK_NAMES } from './check-pr-security.mjs';

const SUCCESS = 'success';

export function verifyReviewArtifacts({
  dependencyOutcome,
  qualityOutcome,
  qualityRequired,
  securityOutcome,
  uploadOutcome,
  report,
}) {
  const failures = [];
  if (dependencyOutcome !== SUCCESS) failures.push('dependency review did not succeed');
  if (qualityRequired && qualityOutcome !== SUCCESS) failures.push('quality gates did not succeed');
  if (securityOutcome !== SUCCESS) failures.push('security scan did not succeed');
  if (uploadOutcome !== SUCCESS) failures.push('security artifact upload did not succeed');
  if (report?.scanCompleted !== true) failures.push('security report does not prove a completed scan');
  if (report?.reportWritten !== true) failures.push('security report completion marker is missing');
  if (report?.checkRunCreated !== true) failures.push('security check-run completion marker is missing');

  const reportedChecks = new Set(Array.isArray(report?.checks) ? report.checks.map(item => item?.check) : []);
  for (const check of SECURITY_CHECK_NAMES) {
    if (!reportedChecks.has(check)) failures.push(`security report is missing ${check}`);
  }

  if (
    report?.mode === 'advisory' &&
    Number(report?.totalFindings) > 0 &&
    report?.advisorySynced !== true
  ) {
    failures.push('upstream advisory mode did not persist the draft advisory');
  }
  if (report?.mode !== 'advisory' && report?.mode !== 'report') {
    failures.push('security report mode is invalid');
  }

  if (failures.length > 0) {
    throw new Error(`Review workflow failed closed: ${failures.join('; ')}`);
  }
  return true;
}

async function main() {
  let report;
  try {
    report = JSON.parse(await readFile(process.env.SECURITY_REPORT_PATH, 'utf8'));
  } catch {
    throw new Error('Review workflow failed closed: security report is missing or invalid');
  }

  verifyReviewArtifacts({
    dependencyOutcome: process.env.DEPENDENCY_OUTCOME,
    qualityOutcome: process.env.QUALITY_OUTCOME,
    qualityRequired: process.env.QUALITY_REQUIRED === 'true',
    securityOutcome: process.env.SECURITY_OUTCOME,
    uploadOutcome: process.env.UPLOAD_OUTCOME,
    report,
  });
  console.log('[review-verifier] dependency, quality, scan, report, check-run, and artifact evidence complete');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
