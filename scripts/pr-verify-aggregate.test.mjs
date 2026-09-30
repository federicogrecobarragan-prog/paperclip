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
