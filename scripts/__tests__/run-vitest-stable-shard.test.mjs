import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import {
  HEARTBEAT_WINDOWS_OWNERSHIP_REPAIR_SUITE,
  requiredJUnitGuardForSuite,
  verifyVitestJUnitReport,
} from "../vitest-junit-guard.mjs";

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

function junitSuite({ tests = 9, failures = 0, errors = 0, skipped = 0 } = {}) {
  const cases = Array.from({ length: tests }, (_, index) => {
    const outcome =
      index < failures
        ? "<failure/>"
        : index < failures + errors
          ? "<error/>"
          : index < failures + errors + skipped
            ? "<skipped/>"
            : "";
    return `<testcase name="synthetic-${index + 1}">${outcome}</testcase>`;
  }).join("");
  return (
    `<testsuites tests="${tests}" failures="${failures}" errors="${errors}">` +
    `<testsuite name="${HEARTBEAT_WINDOWS_OWNERSHIP_REPAIR_SUITE}" tests="${tests}" ` +
    `failures="${failures}" errors="${errors}" skipped="${skipped}">${cases}</testsuite>` +
    "</testsuites>"
  );
}

test("the durable ownership suite requires nine passing JUnit cases", () => {
  const guard = requiredJUnitGuardForSuite(HEARTBEAT_WINDOWS_OWNERSHIP_REPAIR_SUITE);
  assert.deepEqual(guard, {
    suiteName: HEARTBEAT_WINDOWS_OWNERSHIP_REPAIR_SUITE,
    minimumTests: 9,
  });
  assert.deepEqual(verifyVitestJUnitReport(junitSuite(), guard), {
    tests: 9,
    failures: 0,
    errors: 0,
    skipped: 0,
  });
  assert.equal(requiredJUnitGuardForSuite("server/src/__tests__/synthetic-posix-family.test.ts"), null);
});

test("the durable ownership JUnit guard rejects every inconclusive result", () => {
  const guard = requiredJUnitGuardForSuite(HEARTBEAT_WINDOWS_OWNERSHIP_REPAIR_SUITE);
  for (const report of [
    junitSuite({ tests: 8 }),
    junitSuite({ skipped: 9 }),
    junitSuite({ failures: 1 }),
    junitSuite({ errors: 1 }),
  ]) {
    assert.throws(() => verifyVitestJUnitReport(report, guard), /must run at least 9 passing tests/);
  }
});

test("the durable ownership JUnit guard rejects missing, ambiguous, and malformed XML", () => {
  const guard = requiredJUnitGuardForSuite(HEARTBEAT_WINDOWS_OWNERSHIP_REPAIR_SUITE);
  const valid = junitSuite();
  const suite = valid.match(/<testsuite\b[\s\S]*<\/testsuite>/)?.[0];
  assert.ok(suite, "synthetic JUnit suite must be extractable");

  assert.throws(() => verifyVitestJUnitReport("", guard), /Malformed JUnit XML/);
  assert.throws(
    () => verifyVitestJUnitReport(valid.replace("</testsuites>", `${suite}</testsuites>`), guard),
    /exactly one suite/,
  );
  assert.throws(
    () => verifyVitestJUnitReport(valid.replace("</testsuites>", ""), guard),
    /Malformed JUnit XML/,
  );
  assert.throws(
    () => verifyVitestJUnitReport(valid.replace("</testcase>", ""), guard),
    /Malformed JUnit XML/,
  );
});

test("the JUnit guard rejects malformed character references and XML syntax", () => {
  const guard = requiredJUnitGuardForSuite(HEARTBEAT_WINDOWS_OWNERSHIP_REPAIR_SUITE);
  const valid = junitSuite();
  const corruptions = {
    closingWhitespace: valid.replace("</testsuite>", "</ testsuite>"),
    zeroReference: valid.replace("synthetic-1", "synthetic-1&#0;"),
    literalNul: valid.replace("synthetic-1", "synthetic-1\u0000"),
    surrogateReference: valid.replace("synthetic-1", "synthetic-1&#xD800;"),
    outOfRangeReference: valid.replace("synthetic-1", "synthetic-1&#x110000;"),
    forbiddenNoncharacter: valid.replace("synthetic-1", "synthetic-1&#xFFFF;"),
    literalSurrogate: valid.replace("synthetic-1", "synthetic-1\uD800"),
    nulInText: valid.replace("</testcase>", "\u0000</testcase>"),
    nulInComment: `<!--\u0000-->${valid}`,
    nulInCdata: valid.replace("</testcase>", "<![CDATA[\u0000]]></testcase>"),
    selfClosingWhitespace: valid.replace("</testcase>", "<output / ></testcase>"),
    invalidAttributeWhitespace: valid.replace(' tests="9"', '\u00a0tests="9"'),
    duplicateAttribute: valid.replace('tests="9"', 'tests="9" tests="9"'),
    invalidProcessingInstruction: `<??>${valid}`,
    repeatedDeclaration: `<?xml version="1.0"?><?xml version="1.0"?>${valid}`,
    strayCdataClose: valid.replace("</testcase>", "]]></testcase>"),
    invalidEntity: valid.replace("synthetic-1", "synthetic-1&unknown;"),
    internalDoctype: `<!DOCTYPE testsuites [<!ENTITY value "synthetic">]>${valid}`,
    externalDoctype: `<!DOCTYPE testsuites SYSTEM "https://example.invalid/junit.dtd">${valid}`,
  };
  for (const [name, report] of Object.entries(corruptions)) {
    assert.throws(
      () => verifyVitestJUnitReport(report, guard),
      /Malformed JUnit XML/,
      `${name} must be rejected even when all nine test cases appear to pass`,
    );
  }
});

test("the JUnit guard preserves valid entities, Unicode, comments, and CDATA", () => {
  const suiteName = "synthetic & résumé 🧪";
  const guard = { suiteName, minimumTests: 9 };
  const report = junitSuite()
    .replace(HEARTBEAT_WINDOWS_OWNERSHIP_REPAIR_SUITE, "synthetic &amp; r&#233;sum&#xE9; &#x1F9EA;")
    .replace("synthetic-1", "valid-&#9;&#10;&#13;&#32;&#xD7FF;&#xE000;&#xFFFD;&#x10000;&#x10FFFF;&amp;&quot;&apos;&lt;&gt;résumé 🧪")
    .replace("</testcase>", "<![CDATA[<failure/> & 🧪]]></testcase>");
  const decorated = `\uFEFF<?xml version="1.0"?>\n<!-- valid 🧪 --><?audit ready?>${report}`;
  assert.deepEqual(verifyVitestJUnitReport(decorated, guard), {
    tests: 9,
    failures: 0,
    errors: 0,
    skipped: 0,
  });
});

test("the serialized runner executes and propagates the required JUnit guard", (t) => {
  const fixtureDir = mkdtempSync(path.join(os.tmpdir(), "paperclip-junit-guard-"));
  t.after(() => rmSync(fixtureDir, { recursive: true, force: true }));

  const spawnFixture = path.join(fixtureDir, "spawn-vitest-junit.mjs");
  const inventory = dryRunJson([
    "--mode", "serialized", "--shard-index", "0", "--shard-count", "1",
  ]);
  const targetIndex = inventory.selectedSerializedSuites.indexOf(
    HEARTBEAT_WINDOWS_OWNERSHIP_REPAIR_SUITE,
  );
  assert.notEqual(targetIndex, -1, "mandatory ownership suite must be present in the serialized lane");

  const valid = junitSuite();
  const reports = {
    skipped: junitSuite({ skipped: 9 }),
    closingWhitespace: valid.replace("</testsuite>", "</ testsuite>"),
    zeroReference: valid.replace("synthetic-1", "synthetic-1&#0;"),
    literalNul: valid.replace("synthetic-1", "synthetic-1\u0000"),
    selfClosingWhitespace: valid.replace("</testcase>", "<output / ></testcase>"),
    invalidAttributeWhitespace: valid.replace(' tests="9"', '\u00a0tests="9"'),
    strayCdataClose: valid.replace("</testcase>", "]]></testcase>"),
  };
  for (const [name, report] of Object.entries(reports)) {
    writeFileSync(
      spawnFixture,
      `import childProcess from "node:child_process";\n` +
        `import { writeFileSync } from "node:fs";\n` +
        `import { syncBuiltinESMExports } from "node:module";\n` +
        `childProcess.spawnSync = (_command, args = []) => {\n` +
        `  const output = args.find((arg) => arg.startsWith("--outputFile.junit="));\n` +
        `  if (!output) return { status: 42, signal: null, error: undefined };\n` +
        `  writeFileSync(output.slice("--outputFile.junit=".length), ${JSON.stringify(report)});\n` +
        `  return { status: 0, signal: null, error: undefined };\n` +
        `};\n` +
        `syncBuiltinESMExports();\n`,
      "utf8",
    );
    const result = spawnSync(
      process.execPath,
      [
        "--import", pathToFileURL(spawnFixture).href,
        script,
        "--mode", "serialized",
        "--shard-index", String(targetIndex),
        "--shard-count", String(inventory.serializedSuiteCount),
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: process.env,
      },
    );

    assert.equal(
      result.status,
      1,
      `serialized runner accepted ${name}; stdout=${result.stdout} stderr=${result.stderr}`,
    );
    assert.match(result.stderr, /required JUnit guard failed/);
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
