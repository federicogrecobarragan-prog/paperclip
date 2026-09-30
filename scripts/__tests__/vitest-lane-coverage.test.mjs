// The guard for LAC-1384: a test that goes red when a declared Vitest project
// runs in no CI lane.
//
// It reads the lane split out of `run-vitest-stable.mjs --dry-run` rather than
// recomputing it, so it checks what CI actually runs. It also carries its own
// negative tests: the comparison is a pure function, fed drifted input here and
// asserted to report the gap — including a replay of the real pre-LAC-1384 split,
// which must name all six adapter packages that were invisible to CI.
//
// Runs on `node --test` with no third-party imports on purpose: the PR `policy`
// job gates before `pnpm install` has happened anywhere in the workflow.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import {
  findLaneCoverageGaps,
  findUndeclaredTestPackageDrift,
  formatLaneCoverageGaps,
  formatUndeclaredTestPackageDrift,
  LANE_EXCLUSIONS,
  listPackagesWithTests,
  UNDECLARED_TEST_PACKAGES,
} from "../vitest-lanes.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = path.join(repoRoot, "scripts", "run-vitest-stable.mjs");

/** The lane split exactly as `pnpm test:run:general` will execute it. */
function readLaneManifest() {
  const result = spawnSync(process.execPath, [script, "--mode", "all", "--dry-run"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `run-vitest-stable.mjs --dry-run failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

/**
 * Every exception this repo grants has to be visible in the log of the job that
 * grants it, otherwise the guard is just a differently shaped false green.
 */
function printExceptionTables() {
  const laneExceptions = Object.entries(LANE_EXCLUSIONS);
  console.log(
    `[vitest-lane-coverage] LANE_EXCLUSIONS: ${laneExceptions.length} declared project(s) deliberately in no lane`,
  );
  for (const [project, reason] of laneExceptions) {
    console.log(`[vitest-lane-coverage]   - ${project}: ${reason}`);
  }

  const inventory = Object.entries(UNDECLARED_TEST_PACKAGES);
  console.log(
    `[vitest-lane-coverage] UNDECLARED_TEST_PACKAGES: ${inventory.length} package(s) own tests and are not Vitest projects`,
  );
  for (const [dir, reason] of inventory) {
    console.log(`[vitest-lane-coverage]   - ${dir}: ${reason}`);
  }
}

test("every declared Vitest project runs in exactly one CI lane", () => {
  const manifest = readLaneManifest();

  for (const [lane, projects] of Object.entries(manifest.lanes)) {
    console.log(`[vitest-lane-coverage] lane ${lane}: ${projects.length} project(s) -> ${projects.join(", ")}`);
  }
  printExceptionTables();

  const gaps = findLaneCoverageGaps({
    declaredProjects: manifest.declaredProjects,
    lanes: manifest.lanes,
    exclusions: LANE_EXCLUSIONS,
  });

  assert.deepEqual(
    formatLaneCoverageGaps(gaps),
    [],
    "vitest.projects.mjs and the CI lanes have drifted apart",
  );
});

test("the adapter packages LAC-1384 found outside CI stay inside a lane", () => {
  const manifest = readLaneManifest();
  const covered = new Set(Object.values(manifest.lanes).flat());

  // Pinned by name: these six were declared to Vitest yet ran in no lane at all,
  // hiding 27 test files from CI. Removing one from a lane must break this test.
  for (const project of [
    "@paperclipai/adapter-claude-local",
    "@paperclipai/adapter-cursor-cloud",
    "@paperclipai/adapter-cursor-local",
    "@paperclipai/adapter-gemini-local",
    "@paperclipai/adapter-grok-local",
    "@paperclipai/adapter-pi-local",
  ]) {
    assert.ok(covered.has(project), `${project} must run in a CI lane (regression of LAC-1384)`);
  }
});

test("every declared project that owns test files is covered by a lane", () => {
  const manifest = readLaneManifest();
  const covered = new Set(Object.values(manifest.lanes).flat());

  for (const entry of manifest.declaredProjects) {
    if (entry.testFileCount === 0) {
      continue;
    }

    assert.ok(
      covered.has(entry.project) || entry.project in LANE_EXCLUSIONS,
      `${entry.project} (${entry.dir}) declares ${entry.testFileCount} test file(s) but no lane runs it`,
    );
  }
});

test("packages that own tests but are not Vitest projects stay inventoried", () => {
  const manifest = readLaneManifest();
  const drift = findUndeclaredTestPackageDrift({
    packagesWithTests: listPackagesWithTests(),
    declaredProjectDirs: manifest.declaredProjects.map((entry) => entry.dir),
    inventory: UNDECLARED_TEST_PACKAGES,
  });

  assert.deepEqual(
    formatUndeclaredTestPackageDrift(drift),
    [],
    "a package holding test files is neither a declared Vitest project nor an inventoried exception",
  );
});

// --- negative tests: the guard has to be seen red, not assumed red ------------

const DECLARED_FIXTURE = [
  { dir: "packages/alpha", project: "@fixture/alpha", testFileCount: 3 },
  { dir: "packages/beta", project: "@fixture/beta", testFileCount: 0 },
  { dir: "server", project: "@fixture/server", testFileCount: 9 },
];

test("a declared project with tests and no lane is reported", () => {
  const gaps = findLaneCoverageGaps({
    declaredProjects: DECLARED_FIXTURE,
    lanes: { "general-server": ["@fixture/server"], "general-workspaces-b": ["@fixture/beta"] },
  });

  assert.deepEqual(
    gaps.uncoveredProjectsWithTests.map((entry) => entry.project),
    ["@fixture/alpha"],
  );
  assert.match(formatLaneCoverageGaps(gaps)[0], /@fixture\/alpha .* runs in NO CI lane/);
});

test("a lane running a project nobody declared is reported", () => {
  const gaps = findLaneCoverageGaps({
    declaredProjects: DECLARED_FIXTURE,
    lanes: {
      "general-server": ["@fixture/server"],
      "general-workspaces-b": ["@fixture/alpha", "@fixture/beta", "@fixture/ghost"],
    },
  });

  assert.deepEqual(gaps.laneProjectsNotDeclared, ["@fixture/ghost"]);
});

test("a project wired into two lanes is reported", () => {
  const gaps = findLaneCoverageGaps({
    declaredProjects: DECLARED_FIXTURE,
    lanes: {
      "general-server": ["@fixture/server"],
      "general-workspaces-a": ["@fixture/alpha"],
      "general-workspaces-b": ["@fixture/alpha", "@fixture/beta"],
    },
  });

  assert.deepEqual(gaps.projectsInMultipleLanes, [
    { project: "@fixture/alpha", lanes: ["general-workspaces-a", "general-workspaces-b"] },
  ]);
});

test("an exclusion without a reason, or stale, is reported", () => {
  const gaps = findLaneCoverageGaps({
    declaredProjects: DECLARED_FIXTURE,
    lanes: { "general-server": ["@fixture/server"], "general-workspaces-b": ["@fixture/beta"] },
    exclusions: { "@fixture/alpha": "  ", "@fixture/beta": "still in a lane", "@fixture/gone": "not declared" },
  });

  assert.deepEqual(gaps.exclusionsWithoutReason, ["@fixture/alpha"]);
  assert.deepEqual(gaps.exclusionsStillInALane, ["@fixture/beta"]);
  assert.deepEqual(gaps.exclusionsNotDeclared, ["@fixture/gone"]);
});

test("the same package declared under two directories is reported", () => {
  const gaps = findLaneCoverageGaps({
    declaredProjects: [...DECLARED_FIXTURE, { dir: "packages/alpha-copy", project: "@fixture/alpha", testFileCount: 1 }],
    lanes: {
      "general-server": ["@fixture/server"],
      "general-workspaces-b": ["@fixture/alpha", "@fixture/beta"],
    },
  });

  assert.deepEqual(gaps.duplicateDeclarations, [
    { project: "@fixture/alpha", dirs: ["packages/alpha", "packages/alpha-copy"] },
  ]);
});

test("the pre-LAC-1384 lane split is reported as a gap, package by package", () => {
  // The exact `nonServerProjects` list that shipped in master before this guard
  // existed, replayed against today's declared projects. If the guard had been in
  // place, this is the failure CI would have shown instead of a green tick.
  const historicalNonServerProjects = [
    "@paperclipai/shared",
    "@paperclipai/skills-catalog",
    "@paperclipai/teams-catalog",
    "@paperclipai/db",
    "@paperclipai/adapter-utils",
    "@paperclipai/adapter-acpx-local",
    "@paperclipai/adapter-codex-local",
    "@paperclipai/adapter-opencode-local",
    "@paperclipai/plugin-sdk",
    "@paperclipai/create-paperclip-plugin",
    "@paperclipai/ui",
    "paperclipai",
  ];
  const laneA = ["@paperclipai/ui", "paperclipai"];
  const manifest = readLaneManifest();
  // Freeze the historical declaration set as well as the old lane list. New
  // enrollments have their own regression test below and were not part of this
  // original 27-file incident.
  const newlyEnrolledDirs = new Set(["packages/adapters/hermes", "packages/adapters/openclaw-gateway", "packages/mcp-server",
    "packages/plugins/paperclip-plugin-fake-sandbox", "packages/plugins/plugin-llm-wiki", "packages/plugins/plugin-workspace-diff"]);

  const gaps = findLaneCoverageGaps({
    declaredProjects: manifest.declaredProjects.filter((entry) => !newlyEnrolledDirs.has(entry.dir)),
    lanes: {
      "general-server": ["@paperclipai/server"],
      "general-workspaces-a": laneA,
      "general-workspaces-b": historicalNonServerProjects.filter((project) => !laneA.includes(project)),
    },
    exclusions: {},
  });

  assert.deepEqual(gaps.uncoveredProjectsWithTests.map((entry) => entry.project).sort(), [
    "@paperclipai/adapter-claude-local",
    "@paperclipai/adapter-cursor-cloud",
    "@paperclipai/adapter-cursor-local",
    "@paperclipai/adapter-gemini-local",
    "@paperclipai/adapter-grok-local",
    "@paperclipai/adapter-pi-local",
  ]);
  assert.equal(
    gaps.uncoveredProjectsWithTests.reduce((total, entry) => total + entry.testFileCount, 0),
    27,
    "the historical gap hid 27 test files",
  );
});

test("a new package with tests that nobody declared or inventoried is reported", () => {
  const drift = findUndeclaredTestPackageDrift({
    packagesWithTests: [
      { dir: "packages/alpha", testFileCount: 3 },
      { dir: "packages/brand-new", testFileCount: 2 },
      { dir: "packages/inventoried", testFileCount: 1 },
    ],
    declaredProjectDirs: ["packages/alpha"],
    inventory: { "packages/inventoried": "documented exception" },
  });

  assert.deepEqual(drift.newlyUndeclared, [{ dir: "packages/brand-new", testFileCount: 2 }]);
  assert.match(formatUndeclaredTestPackageDrift(drift)[0], /packages\/brand-new owns 2 test file/);
});

test("a stale or unexplained inventory entry is reported", () => {
  const drift = findUndeclaredTestPackageDrift({
    packagesWithTests: [{ dir: "packages/inventoried", testFileCount: 1 }],
    declaredProjectDirs: [],
    inventory: { "packages/inventoried": "", "packages/deleted": "was an exception once" },
  });

  assert.deepEqual(drift.inventoryWithoutReason, ["packages/inventoried"]);
  assert.deepEqual(drift.staleInventory, ["packages/deleted"]);
});

test("empty workspace lanes fail in the actual runner; deleting its guard produces a false green", () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "empty-lane-fixture-"));
  try {
    mkdirSync(path.join(fixture, "scripts"));
    mkdirSync(path.join(fixture, "server", "src", "__tests__"), { recursive: true });
    writeFileSync(path.join(fixture, "package.json"), '{"type":"module"}');
    // Inject composition only. The complete production runner still parses the
    // CLI and executes runProjectGroup; no mock of the guard or exit behavior.
    writeFileSync(path.join(fixture, "scripts", "vitest-lanes.mjs"), `
      export const LANE_EXCLUSIONS = {};
      export const SERVER_LANE = "general-server";
      export const WORKSPACES_A_LANE = "general-workspaces-a";
      export const WORKSPACES_B_LANE = "general-workspaces-b";
      export function computeLanes() {
        return { declaredProjects: [], lanes: {}, laneA: [], laneB: [], excluded: [] };
      }
    `);
    const source = readFileSync(script, "utf8").replace(/\r\n/g, "\n");
    const target = path.join(fixture, "scripts", "run-vitest-stable.mjs");
    copyFileSync(
      path.join(repoRoot, "scripts", "vitest-junit-guard.mjs"),
      path.join(fixture, "scripts", "vitest-junit-guard.mjs"),
    );
    const run = (group) => spawnSync(process.execPath, [target, "--mode", "general", "--group", group], {
      cwd: fixture, encoding: "utf8",
    });
    writeFileSync(target, source);
    for (const group of ["general-workspaces-a", "general-workspaces-b"]) {
      const result = run(group);
      assert.equal(result.status, 1, `${group} must reject emptiness: ${result.stderr}`);
      assert.match(result.stderr, /resolved to zero projects/);
    }
    const guard = '  if (projects.length === 0) {\n    fail(`${groupName} resolved to zero projects. An empty lane is a false green, not a pass.`);\n  }';
    assert.ok(source.includes(guard), "the mutation must delete the actual guarded branch");
    writeFileSync(target, source.replace(guard, ""));
    const mutant = run("general-workspaces-b");
    assert.equal(mutant.status, 0, `guardless counterfactual must expose the false green: ${mutant.stderr}`);
    assert.match(mutant.stdout, /all 0 project\(s\) passed/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("an exclusion needs a review reference even when its prose reason is nonempty", () => {
  const rejected = findLaneCoverageGaps({ declaredProjects: DECLARED_FIXTURE, lanes: {},
    exclusions: { "@fixture/alpha": "because this is inconvenient" } });
  assert.deepEqual(rejected.exclusionsWithoutReview, ["@fixture/alpha"]);
  assert.match(formatLaneCoverageGaps(rejected).join("\n"), /requires a LAC review reference/);
  const accepted = findLaneCoverageGaps({ declaredProjects: DECLARED_FIXTURE, lanes: {},
    exclusions: { "@fixture/alpha": "synthetic review LAC-0" } });
  assert.deepEqual(accepted.exclusionsWithoutReview, []);
});

test("only unchanged structural inventory entries are grandfathered", () => {
  const [dir, reason] = Object.entries(UNDECLARED_TEST_PACKAGES)[0];
  const check = (inventory) => findUndeclaredTestPackageDrift({
    packagesWithTests: [{ dir, testFileCount: 1 }], declaredProjectDirs: [], inventory,
  });
  assert.deepEqual(check({ [dir]: reason }).inventoryWithoutReview, []);
  assert.deepEqual(check({ [dir]: `${reason} changed` }).inventoryWithoutReview, [dir]);
  assert.deepEqual(check({ "packages/new-synthetic": reason }).inventoryWithoutReview, ["packages/new-synthetic"]);
  assert.deepEqual(check({ "packages/new-synthetic": "synthetic review LAC-0" }).inventoryWithoutReview, []);
});

test("all six previously pending workspace packages are routed into CI", () => {
  const manifest = readLaneManifest();
  for (const dir of ["packages/adapters/hermes", "packages/adapters/openclaw-gateway", "packages/mcp-server",
    "packages/plugins/paperclip-plugin-fake-sandbox", "packages/plugins/plugin-llm-wiki", "packages/plugins/plugin-workspace-diff"]) {
    const entry = manifest.declaredProjects.find((project) => project.dir === dir);
    assert.ok(entry, `${dir} must be declared`);
    assert.ok(entry.testFileCount > 0);
    assert.equal(Object.values(manifest.lanes).flat().filter((name) => name === entry.project).length, 1);
    assert.ok(!(dir in UNDECLARED_TEST_PACKAGES));
  }
});

test("inventory ordering is unchanged under hostile runtime collation", () => {
  const fixture = pathToFileURL(path.join(repoRoot, "scripts", "__tests__", "fixtures", "reverse-collation.mjs")).href;
  const probe = spawnSync(process.execPath, ["--import", fixture, "-e", "console.log('a'.localeCompare('b'))"], { encoding: "utf8" });
  assert.equal(probe.status, 0);
  assert.equal(probe.stdout.trim(), "1", "hostile collation must be armed");
  const source = `import { listPackagesWithTests } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, "scripts", "vitest-lanes.mjs")).href)}; console.log(JSON.stringify(listPackagesWithTests().map(x => x.dir)));`;
  const result = spawnSync(process.execPath, ["--import", fixture, "--input-type=module", "-e", source], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), listPackagesWithTests().map((entry) => entry.dir));
});
