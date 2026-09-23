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
import path from "node:path";
import { fileURLToPath } from "node:url";
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

  const gaps = findLaneCoverageGaps({
    declaredProjects: manifest.declaredProjects,
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
