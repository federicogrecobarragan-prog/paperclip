import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SECURITY_CHECK_NAMES } from '../check-pr-security.mjs';
import { verifyReviewArtifacts } from '../verify-review-artifacts.mjs';

function completeReport(overrides = {}) {
  return {
    mode: 'report',
    scanCompleted: true,
    reportWritten: true,
    checkRunCreated: true,
    advisorySynced: false,
    totalFindings: 1,
    checks: SECURITY_CHECK_NAMES.map(check => ({ check, count: 0, files: [], patterns: [] })),
    ...overrides,
  };
}

function completeOutcomes(overrides = {}) {
  return {
    dependencyOutcome: 'success',
    qualityOutcome: 'success',
    qualityRequired: true,
    securityOutcome: 'success',
    uploadOutcome: 'success',
    report: completeReport(),
    ...overrides,
  };
}

test('verifyReviewArtifacts: accepts a complete fork report path', () => {
  assert.equal(verifyReviewArtifacts(completeOutcomes()), true);
});

test('verifyReviewArtifacts: missing artifact upload fails red', () => {
  assert.throws(
    () => verifyReviewArtifacts(completeOutcomes({ uploadOutcome: 'failure' })),
    /artifact upload did not succeed/,
  );
});

test('verifyReviewArtifacts: missing check-run fails red', () => {
  assert.throws(
    () => verifyReviewArtifacts(completeOutcomes({ report: completeReport({ checkRunCreated: false }) })),
    /check-run completion marker is missing/,
  );
});

test('verifyReviewArtifacts: security/API step failure cannot become a false green', () => {
  assert.throws(
    () => verifyReviewArtifacts(completeOutcomes({ securityOutcome: 'failure' })),
    /security scan did not succeed/,
  );
});

test('verifyReviewArtifacts: upstream findings require durable advisory evidence', () => {
  assert.throws(
    () => verifyReviewArtifacts(completeOutcomes({
      report: completeReport({ mode: 'advisory', advisorySynced: false }),
    })),
    /did not persist the draft advisory/,
  );
});
