import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = path.join(repoRoot, "scripts", "run-vitest-stable.mjs");
const reverseCollationFixture = pathToFileURL(
  path.join(repoRoot, "scripts", "__tests__", "fixtures", "reverse-collation.mjs"),
).href;

function dryRun(args, nodeArgs = []) {
  const result = spawnSync(process.execPath, [...nodeArgs, script, ...args, "--dry-run"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return result;
}

function dryRunJson(args, nodeArgs = []) {
  const result = dryRun(args, nodeArgs);
  assert.equal(result.status, 0, `expected success for ${args.join(" ")}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

const SHARD_COUNT = 3;

// UTF-16 code unit order. Deliberately not `localeCompare`: this is the order
// the script itself must produce, so the assertion cannot borrow the same
// locale-dependent primitive it is checking.
const compareCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// `--shard-count 1` selects `index % 1 === 0`, i.e. the whole list in the order
// the script computed it; `selectedSerializedSuites` in `general` mode is the
// full route/authz list in its own computed order. One dry-run therefore
// exposes both ordered lists that feed a partition.
function orderedSuiteLists(nodeArgs = []) {
  const dry = dryRunJson(
    ["--mode", "general", "--group", "general-server", "--shard-index", "0", "--shard-count", "1"],
    nodeArgs,
  );
  return {
    generalServer: dry.selectedGeneralServerSuites,
    serialized: dry.selectedSerializedSuites,
  };
}

test("the general-server shards form a complete, non-overlapping partition", () => {
  const shards = Array.from({ length: SHARD_COUNT }, (_, index) =>
    dryRunJson(["--mode", "general", "--group", "general-server", "--shard-index", String(index), "--shard-count", String(SHARD_COUNT)]),
  );

  const total = shards[0].generalServerSuiteCount;
  assert.ok(total > 0, "expected a non-empty general-server suite set");

  const seen = new Set();
  let selectedTotal = 0;
  for (const shard of shards) {
    assert.equal(shard.generalServerSuiteCount, total, "suite count must be stable across shards");
    for (const file of shard.selectedGeneralServerSuites) {
      assert.ok(!seen.has(file), `suite assigned to more than one shard: ${file}`);
      seen.add(file);
      selectedTotal += 1;
    }
  }

  // Every suite runs exactly once: union covers the whole set with no overlap.
  assert.equal(selectedTotal, total, "every suite must be selected exactly once");
  assert.equal(seen.size, total, "union of shards must cover the whole suite set");
});

test("a route/authz suite never leaks into the general-server shards", () => {
  const shard = dryRunJson(["--mode", "general", "--group", "general-server", "--shard-index", "0", "--shard-count", SHARD_COUNT.toString()]);
  for (const file of shard.selectedGeneralServerSuites) {
    assert.ok(
      !/[^/]*(?:route|routes|authz)[^/]*\.test\.ts$/.test(file),
      `route/authz suite must stay in the serialized lane, not general-server: ${file}`,
    );
  }
});

test("shard flags are rejected for the parallel workspace groups", () => {
  const result = dryRun(["--mode", "general", "--group", "general-workspaces-a", "--shard-index", "0", "--shard-count", "3"]);
  assert.notEqual(result.status, 0, "workspace groups must not accept shard flags");
});

// LAC-1394. The split is positional (`index % shardCount === shardIndex`), so
// the sort order IS the partition. If two runners of the same workflow resolved
// different collations they would compute different partitions: one suite would
// run twice and another never, with every job still green. The two tests below
// turn "the runners happen to agree" into "the order cannot depend on the
// runtime at all".

test("the suite lists that feed a partition are in code unit order", () => {
  const { generalServer, serialized } = orderedSuiteLists();

  assert.ok(generalServer.length > 0, "expected a non-empty general-server suite set");
  assert.ok(serialized.length > 0, "expected a non-empty serialized suite set");

  assert.deepEqual(
    generalServer,
    [...generalServer].sort(compareCodeUnits),
    "general-server suites must be sorted by code unit, not by the runtime collation",
  );
  assert.deepEqual(
    serialized,
    [...serialized].sort(compareCodeUnits),
    "serialized suites must be sorted by code unit, not by the runtime collation",
  );
});

test("the partition is identical under a hostile runtime collation", () => {
  // Arm check first: if `--import` silently failed the comparison below would
  // diff two identical runs and pass while proving nothing. A control only
  // protects if it is armed where it runs.
  const probe = spawnSync(
    process.execPath,
    ["--import", reverseCollationFixture, "-e", "process.stdout.write(String('a'.localeCompare('b')))"],
    { encoding: "utf8" },
  );
  assert.equal(probe.status, 0, `reverse-collation fixture failed to load: ${probe.stderr}`);
  assert.equal(
    probe.stdout,
    "1",
    "reverse-collation fixture is not armed: 'a'.localeCompare('b') must be reversed to 1",
  );

  const nodeArgs = ["--import", reverseCollationFixture];

  assert.deepEqual(
    orderedSuiteLists(nodeArgs),
    orderedSuiteLists(),
    "suite order changed when the runtime collation changed: the ordering still calls localeCompare",
  );

  for (let shardIndex = 0; shardIndex < SHARD_COUNT; shardIndex += 1) {
    const args = [
      "--mode",
      "general",
      "--group",
      "general-server",
      "--shard-index",
      String(shardIndex),
      "--shard-count",
      String(SHARD_COUNT),
    ];
    assert.deepEqual(
      dryRunJson(args, nodeArgs).selectedGeneralServerSuites,
      dryRunJson(args).selectedGeneralServerSuites,
      `shard ${shardIndex + 1}/${SHARD_COUNT} changed with the runtime collation`,
    );
  }
});
