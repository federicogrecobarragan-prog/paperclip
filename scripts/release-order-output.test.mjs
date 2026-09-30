import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const compare = (a,b) => a < b ? -1 : a > b ? 1 : 0;
const paths = ['cli', 'packages/db', 'packages/shared', 'packages/adapter-utils',
  'packages/adapters/claude-local', 'packages/adapters/codex-local', 'packages/adapters/hermes-gateway',
  'packages/adapters/hermes', 'packages/adapters/opencode-local', 'packages/adapters/openclaw-gateway', 'server'];
test('generated publishable keys are binary ordered even with hostile locale collation', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-order-output-'));
  try {
    mkdirSync(join(root,'scripts'));
    cpSync(new URL('./generate-npm-package-json.mjs', import.meta.url), join(root,'scripts/generate.mjs'));
    writeFileSync(join(root,'reverse.mjs'), "String.prototype.localeCompare = function(other) { return this < other ? 1 : this > other ? -1 : 0; };\n");
    for (const path of paths) {
      mkdirSync(join(root,path), { recursive:true });
      writeFileSync(join(root,path,'package.json'), JSON.stringify({ name: 'synthetic-package', version:'1.0.0',
        dependencies: { zebra:'1', Alpha:'1', alpha:'1', '@scope/pkg':'1' },
        optionalDependencies: { omega:'1', Beta:'1', beta:'1' } }));
    }
    const run = spawnSync(process.execPath, ['--import', pathToFileURL(join(root,'reverse.mjs')).href, join(root,'scripts/generate.mjs')], { encoding:'utf8' });
    assert.equal(run.status,0,run.stderr);
    const output = JSON.parse(readFileSync(join(root,'cli/package.json'),'utf8'));
    for (const key of ['dependencies','optionalDependencies']) {
      const names=Object.keys(output[key]);
      assert.deepEqual(names,[...names].sort(compare));
    }
  } finally { rmSync(root,{recursive:true,force:true}); }
});
test('publication order is invariant under hostile locale collation', async () => {
  const script = `import {sortTopologically} from ${JSON.stringify(new URL('./release-package-map.mjs',import.meta.url).href)}; const packages=['zeta','Alpha','alpha'].map(dir=>({name:dir,dir,pkg:{}})); console.log(JSON.stringify(sortTopologically(packages).map(p=>p.dir)));`;
  const baseline=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8'});
  const reversed=spawnSync(process.execPath,['--input-type=module','-e',"String.prototype.localeCompare = function(other) { return this < other ? 1 : this > other ? -1 : 0; };"+script],{encoding:'utf8'});
  assert.equal(baseline.status,0,baseline.stderr);
  assert.equal(reversed.status,0,reversed.stderr);
  assert.deepEqual(JSON.parse(reversed.stdout),JSON.parse(baseline.stdout));
  assert.deepEqual(JSON.parse(baseline.stdout),['Alpha','alpha','zeta']);
});
