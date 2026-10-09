import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const yaml = readFileSync(new URL('../.github/workflows/pr.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const block = yaml.split('\n  verify:\n')[1]?.split(/\n  [a-z][a-z_]*:\n/)[0];
const families = ['policy', 'typecheck_release_registry', 'teams_catalog_freshness', 'general_tests',
  'build', 'verify_serialized_server', 'canary_dry_run', 'e2e'];
const bindings = [...block.matchAll(/^          (\w+): \$\{\{ needs\.(\w+)\.result \}\}$/gm)];
const script = block.split('        run: |\n')[1].split('\n').filter(line => line.startsWith('          '))
  .map(line => line.slice(10)).join('\n');
const bash = process.platform === 'win32' && existsSync('C:/Program Files/Git/bin/bash.exe')
  ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
function execute(results) {
  const env = { ...process.env };
  for (const [, name, family] of bindings) env[name] = results[family];
  const result = spawnSync(bash, ['-e', '-c', script], { env, encoding: 'utf8' });
  if (result.error) throw result.error;
  return result.status;
}
test('stable verify waits for every CI family and always reports', () => {
  const needs = /needs: \[([^\]]+)\]/.exec(block)[1].split(',').map(s => s.trim());
  assert.deepEqual([...needs].sort(), [...families].sort());
  assert.match(block, /if: \$\{\{ always\(\) \}\}/);
  assert.match(block, /name: verify/);
});
function assertRequiredJUnitStep(workflow) {
  const job = workflow.split('\n  typecheck_release_registry:\n')[1]?.split(/\n  [a-z][a-z_]*:\n/)[0];
  const command = 'run: node --test ./scripts/__tests__/run-vitest-stable-shard.test.mjs';
  assert.ok(job, 'the required typecheck job must exist');
  assert.ok(job.indexOf('run: pnpm install --frozen-lockfile') >= 0, 'the parser dependency must be installed');
  assert.ok(job.indexOf(command) > job.indexOf('run: pnpm install --frozen-lockfile'),
    'the required job must run JUnit validation after installing its parser');
  const steps = job.split(/^      - /m).slice(1);
  const matches = steps.filter(step => step.includes(command));
  assert.equal(matches.length, 1, 'exactly one step must run the JUnit validation');
  // YAML mapping order is immaterial: inspect the entire step, including keys after run.
  assert.doesNotMatch(matches[0], /^(?:        )?(?:if|continue-on-error)\s*:/m,
    'JUnit validation must not be skipped or allowed to fail');
}

test('required typecheck job runs shard and JUnit validation after installing dependencies', () => {
  assertRequiredJUnitStep(yaml);
});

for (const option of ['if: ${{ false }}', 'continue-on-error: true']) {
  for (const position of ['before', 'after']) {
    test(`JUnit step guard rejects ${option} ${position} run`, () => {
      const run = '        run: node --test ./scripts/__tests__/run-vitest-stable-shard.test.mjs';
      const replacement = position === 'before' ? `        ${option}\n${run}` : `${run}\n        ${option}`;
      assert.throws(() => assertRequiredJUnitStep(yaml.replace(run, replacement)),
        { code: 'ERR_ASSERTION', message: 'JUnit validation must not be skipped or allowed to fail' });
    });
  }
}

test('JUnit step guard does not borrow options from the following step', () => {
  const next = '      - name: Typecheck workspaces whose build scripts skip TypeScript';
  assertRequiredJUnitStep(yaml.replace(next, `${next}\n        if: always()`));
});
test('actual aggregator shell passes when every dependency succeeds', () => {
  assert.equal(execute(Object.fromEntries(families.map(f => [f, 'success']))), 0);
});
for (const family of families) {
  for (const state of ['failure', 'cancelled', 'skipped']) {
    test(`actual aggregator rejects ${family}=${state}`, () => {
      const results = Object.fromEntries(families.map(f => [f, 'success']));
      results[family] = state;
      assert.notEqual(execute(results), 0);
    });
  }
}
