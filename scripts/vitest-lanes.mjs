// Derives the CI test lanes from the single Vitest project list, and provides the
// pure comparison the coverage guard uses to prove nothing fell through.
//
// Before LAC-1384 this repo kept two hand-maintained lists in two different
// formats — `test.projects` in vitest.config.ts (by path) and `nonServerProjects`
// in scripts/run-vitest-stable.mjs (by package name) — with nothing comparing
// them. Six adapter packages holding 27 test files had drifted out of the second
// list, so they ran in no lane at all and CI stayed green. The fix is structural:
// there is now one list, and the lanes are computed from it.
//
// Everything that is deliberately *not* run lives in `LANE_EXCLUSIONS` or
// `UNDECLARED_TEST_PACKAGES` below, each with a reason. The guard prints both
// tables on every run and fails closed on anything it cannot account for: a
// silent exception would turn the guard back into a false green.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { vitestProjectDirs } from "../vitest.projects.mjs";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The server project runs sharded in its own lane, never in the workspace lanes. */
export const SERVER_PROJECT = "@paperclipai/server";

export const SERVER_LANE = "general-server";
export const WORKSPACES_A_LANE = "general-workspaces-a";
export const WORKSPACES_B_LANE = "general-workspaces-b";

/**
 * The two slowest workspaces get a lane to themselves so the remaining packages
 * stay off the PR critical path. Pinned by name; `computeLanes` fails loudly if a
 * pin stops matching a declared project, so a rename can't silently empty a lane.
 */
export const WORKSPACES_A_PROJECTS = ["@paperclipai/ui", "paperclipai"];

/**
 * Projects declared in vitest.projects.mjs that deliberately run in no lane.
 * Key: `package.json#name`. Value: why — an empty or missing reason fails the guard.
 *
 * Empty on purpose: today every declared project runs somewhere.
 */
export const LANE_EXCLUSIONS = Object.freeze({});

/**
 * Packages that own `.test.*` files but are not declared as Vitest projects at all.
 *
 * This is a ratchet, not an endorsement: the inventory below is the state LAC-1384
 * found in master, it is printed on every guard run, and the guard fails if a *new*
 * package joins it — so the backlog can shrink but never grow in silence. Routing
 * these into a lane (or deleting the dead ones) is separate work; none of it is
 * covered by this repo's Vitest lanes today.
 *
 * Key: repo-relative package directory. Value: why it is not a Vitest project.
 */
export const UNDECLARED_TEST_PACKAGES = Object.freeze({
  "packages/adapters/hermes":
    "preexisting: adapter never declared as a Vitest project; inventoried by LAC-1384, routing pending",
  "packages/adapters/openclaw-gateway":
    "preexisting: adapter never declared as a Vitest project; inventoried by LAC-1384, routing pending",
  "packages/mcp-server":
    "preexisting: package never declared as a Vitest project; inventoried by LAC-1384, routing pending",
  "packages/plugins/examples/plugin-authoring-smoke-example":
    "plugin authoring fixture, installed standalone and excluded from the pnpm workspace root install",
  "packages/plugins/examples/plugin-orchestration-smoke-example":
    "plugin orchestration fixture, excluded from pnpm-workspace.yaml so PRs need not churn the lockfile",
  "packages/plugins/paperclip-plugin-fake-sandbox":
    "preexisting: plugin never declared as a Vitest project; inventoried by LAC-1384, routing pending",
  "packages/plugins/plugin-llm-wiki":
    "preexisting: plugin never declared as a Vitest project; inventoried by LAC-1384, routing pending",
  "packages/plugins/plugin-workspace-diff":
    "preexisting: plugin never declared as a Vitest project; inventoried by LAC-1384, routing pending",
  "packages/plugins/sandbox-providers/cloudflare":
    "sandbox provider plugin, excluded from pnpm-workspace.yaml so its third-party deps stay out of the root lockfile",
  "packages/plugins/sandbox-providers/cloudflare/bridge-template":
    "template shipped inside the cloudflare provider plugin, not a workspace package",
  "packages/plugins/sandbox-providers/daytona":
    "sandbox provider plugin, excluded from pnpm-workspace.yaml so its third-party deps stay out of the root lockfile",
  "packages/plugins/sandbox-providers/e2b":
    "sandbox provider plugin, excluded from pnpm-workspace.yaml so its third-party deps stay out of the root lockfile",
  "packages/plugins/sandbox-providers/exe-dev":
    "sandbox provider plugin, excluded from pnpm-workspace.yaml so its third-party deps stay out of the root lockfile",
  "packages/plugins/sandbox-providers/kubernetes":
    "sandbox provider plugin, excluded from pnpm-workspace.yaml so its third-party deps stay out of the root lockfile",
  "packages/plugins/sandbox-providers/modal":
    "sandbox provider plugin, excluded from pnpm-workspace.yaml so its third-party deps stay out of the root lockfile",
  "packages/plugins/sandbox-providers/novita":
    "sandbox provider plugin, excluded from pnpm-workspace.yaml so its third-party deps stay out of the root lockfile",
  ".": "repo root: scripts/**/*.test.mjs run under `node --test` in the PR policy job and `pnpm test:release-registry`; tests/** run under Playwright in the e2e lane",
});

const TEST_FILE_PATTERN = /\.(test|spec)\.[cm]?[jt]sx?$/;
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".turbo",
  ".next",
  "storybook-static",
  "playwright-report",
  "test-results",
]);

function toRepoRelative(absolutePath) {
  const relative = path.relative(repoRoot, absolutePath).split(path.sep).join("/");
  return relative === "" ? "." : relative;
}

function walkRepo(absoluteDir, visit) {
  let entries;
  try {
    entries = readdirSync(absoluteDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) {
        continue;
      }

      walkRepo(path.join(absoluteDir, entry.name), visit);
      continue;
    }

    if (entry.isFile()) {
      visit(path.join(absoluteDir, entry.name), entry.name);
    }
  }
}

export function readPackageName(projectDir) {
  const manifestPath = path.join(repoRoot, projectDir, "package.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read ${projectDir}/package.json: ${error.message}`);
  }

  if (typeof manifest.name !== "string" || manifest.name.trim() === "") {
    throw new Error(`${projectDir}/package.json has no usable "name"; lanes are keyed by package name.`);
  }

  return manifest.name;
}

export function countTestFiles(projectDir) {
  const absoluteDir = path.join(repoRoot, projectDir);
  try {
    if (!statSync(absoluteDir).isDirectory()) {
      return 0;
    }
  } catch {
    return 0;
  }

  let count = 0;
  walkRepo(absoluteDir, (_absolute, fileName) => {
    if (TEST_FILE_PATTERN.test(fileName)) {
      count += 1;
    }
  });
  return count;
}

/** `[{ dir, project, testFileCount }]` for everything vitest.projects.mjs declares. */
export function describeDeclaredProjects(projectDirs = vitestProjectDirs) {
  return projectDirs.map((dir) => ({
    dir,
    project: readPackageName(dir),
    testFileCount: countTestFiles(dir),
  }));
}

/**
 * Split the declared projects into the lanes CI actually runs.
 * The workspace lanes are derived, never typed out: that is what makes the drift
 * this guard exists for structurally impossible rather than merely detectable.
 */
export function computeLanes({
  declaredProjects = describeDeclaredProjects(),
  exclusions = LANE_EXCLUSIONS,
  serverProject = SERVER_PROJECT,
  workspacesAProjects = WORKSPACES_A_PROJECTS,
} = {}) {
  const declaredNames = declaredProjects.map((entry) => entry.project);
  const excluded = declaredNames.filter((project) => project in exclusions);
  const runnable = declaredNames.filter((project) => !(project in exclusions));
  const serverProjects = runnable.filter((project) => project === serverProject);
  const workspaceProjects = runnable.filter((project) => project !== serverProject);

  const unmatchedPins = workspacesAProjects.filter((project) => !workspaceProjects.includes(project));
  if (unmatchedPins.length > 0) {
    throw new Error(
      `${WORKSPACES_A_LANE} pins ${unmatchedPins.join(", ")}, which vitest.projects.mjs no longer declares as a runnable project. ` +
        "Update WORKSPACES_A_PROJECTS in scripts/vitest-lanes.mjs deliberately instead of letting a lane silently empty out.",
    );
  }

  const laneA = workspacesAProjects.filter((project) => workspaceProjects.includes(project));
  const laneB = workspaceProjects.filter((project) => !laneA.includes(project));

  return {
    declaredProjects,
    excluded,
    serverProjects,
    laneA,
    laneB,
    lanes: {
      [SERVER_LANE]: serverProjects,
      [WORKSPACES_A_LANE]: laneA,
      [WORKSPACES_B_LANE]: laneB,
    },
  };
}

/**
 * Compare what is declared against what the lanes actually run.
 *
 * Deliberately pure — every input is injected — because the only way to prove a
 * guard works is to feed it drifted input and watch it go red (LAC-1384 DoD 4).
 */
export function findLaneCoverageGaps({ declaredProjects, lanes, exclusions = {} }) {
  const lanesByProject = new Map();
  for (const [lane, projects] of Object.entries(lanes)) {
    for (const project of projects) {
      lanesByProject.set(project, [...(lanesByProject.get(project) ?? []), lane]);
    }
  }

  const declaredByProject = new Map();
  const duplicateDeclarations = [];
  for (const entry of declaredProjects) {
    const previous = declaredByProject.get(entry.project);
    if (previous) {
      duplicateDeclarations.push({ project: entry.project, dirs: [previous.dir, entry.dir] });
      continue;
    }

    declaredByProject.set(entry.project, entry);
  }

  const uncoveredProjects = declaredProjects.filter(
    (entry) => !lanesByProject.has(entry.project) && !(entry.project in exclusions),
  );

  return {
    // The headline defect: declared, holds tests, runs nowhere.
    uncoveredProjectsWithTests: uncoveredProjects.filter((entry) => entry.testFileCount > 0),
    uncoveredProjectsWithoutTests: uncoveredProjects.filter((entry) => entry.testFileCount === 0),
    duplicateDeclarations,
    projectsInMultipleLanes: [...lanesByProject.entries()]
      .filter(([, laneNames]) => laneNames.length > 1)
      .map(([project, laneNames]) => ({ project, lanes: laneNames })),
    laneProjectsNotDeclared: [...lanesByProject.keys()].filter((project) => !declaredByProject.has(project)),
    exclusionsWithoutReason: Object.entries(exclusions)
      .filter(([, reason]) => typeof reason !== "string" || reason.trim() === "")
      .map(([project]) => project),
    exclusionsNotDeclared: Object.keys(exclusions).filter((project) => !declaredByProject.has(project)),
    exclusionsStillInALane: Object.keys(exclusions).filter((project) => lanesByProject.has(project)),
  };
}

export function formatLaneCoverageGaps(gaps) {
  const lines = [];
  for (const entry of gaps.uncoveredProjectsWithTests) {
    lines.push(
      `${entry.project} (${entry.dir}) declares ${entry.testFileCount} test file(s) and runs in NO CI lane. ` +
        "Every declared project must land in a lane, or be listed in LANE_EXCLUSIONS with a reason.",
    );
  }
  for (const entry of gaps.uncoveredProjectsWithoutTests) {
    lines.push(`${entry.project} (${entry.dir}) runs in no CI lane (it currently has no test files).`);
  }
  for (const entry of gaps.duplicateDeclarations) {
    lines.push(`${entry.project} is declared twice: ${entry.dirs.join(" and ")}.`);
  }
  for (const entry of gaps.projectsInMultipleLanes) {
    lines.push(`${entry.project} runs in more than one lane: ${entry.lanes.join(", ")}.`);
  }
  for (const project of gaps.laneProjectsNotDeclared) {
    lines.push(`lane runs ${project}, which vitest.projects.mjs does not declare.`);
  }
  for (const project of gaps.exclusionsWithoutReason) {
    lines.push(`LANE_EXCLUSIONS["${project}"] has no reason. A silent exception is a false green.`);
  }
  for (const project of gaps.exclusionsNotDeclared) {
    lines.push(`LANE_EXCLUSIONS lists ${project}, which is not a declared project. Remove the stale entry.`);
  }
  for (const project of gaps.exclusionsStillInALane) {
    lines.push(`LANE_EXCLUSIONS lists ${project}, but a lane still runs it. Remove the stale entry.`);
  }
  return lines;
}

/**
 * Every package directory in the repo that owns at least one `.test.*` file.
 * Used for the ratchet on packages that are not Vitest projects at all.
 */
export function listPackagesWithTests() {
  const packageDirs = [];
  const testFiles = [];

  walkRepo(repoRoot, (absolutePath, fileName) => {
    if (fileName === "package.json") {
      packageDirs.push(toRepoRelative(path.dirname(absolutePath)));
      return;
    }

    if (TEST_FILE_PATTERN.test(fileName)) {
      testFiles.push(toRepoRelative(absolutePath));
    }
  });

  const packageDirSet = new Set(packageDirs);
  const countsByPackageDir = new Map();
  for (const testFile of testFiles) {
    let dir = path.posix.dirname(testFile);
    while (!packageDirSet.has(dir) && dir !== "." && dir !== "/") {
      dir = path.posix.dirname(dir);
    }

    const owner = packageDirSet.has(dir) ? dir : ".";
    countsByPackageDir.set(owner, (countsByPackageDir.get(owner) ?? 0) + 1);
  }

  return [...countsByPackageDir.entries()]
    .map(([dir, testFileCount]) => ({ dir, testFileCount }))
    .sort((a, b) => a.dir.localeCompare(b.dir));
}

/**
 * Ratchet for packages that own tests but are not declared Vitest projects:
 * a new one must be declared or explicitly inventoried, and a stale inventory
 * entry must be removed. Pure for the same reason as `findLaneCoverageGaps`.
 */
export function findUndeclaredTestPackageDrift({
  packagesWithTests,
  declaredProjectDirs,
  inventory = UNDECLARED_TEST_PACKAGES,
}) {
  const declared = new Set(declaredProjectDirs);
  const undeclared = packagesWithTests.filter((entry) => !declared.has(entry.dir));
  const undeclaredDirs = new Set(undeclared.map((entry) => entry.dir));

  return {
    newlyUndeclared: undeclared.filter((entry) => !(entry.dir in inventory)),
    inventoryWithoutReason: Object.entries(inventory)
      .filter(([, reason]) => typeof reason !== "string" || reason.trim() === "")
      .map(([dir]) => dir),
    staleInventory: Object.keys(inventory).filter((dir) => !undeclaredDirs.has(dir)),
  };
}

export function formatUndeclaredTestPackageDrift(drift) {
  const lines = [];
  for (const entry of drift.newlyUndeclared) {
    lines.push(
      `${entry.dir} owns ${entry.testFileCount} test file(s) but is not a declared Vitest project. ` +
        "Add it to vitest.projects.mjs so a lane runs it, or inventory it in UNDECLARED_TEST_PACKAGES with a reason.",
    );
  }
  for (const dir of drift.inventoryWithoutReason) {
    lines.push(`UNDECLARED_TEST_PACKAGES["${dir}"] has no reason. A silent exception is a false green.`);
  }
  for (const dir of drift.staleInventory) {
    lines.push(
      `UNDECLARED_TEST_PACKAGES lists ${dir}, which is now either a declared project or has no test files. ` +
        "Remove the stale entry so the inventory keeps meaning something.",
    );
  }
  return lines;
}
