// Single source of truth for the Vitest projects in this repository.
//
// `vitest.config.ts` hands this list to Vitest, and `scripts/run-vitest-stable.mjs`
// derives the CI lanes from the very same array (resolving each directory to its
// `package.json#name`). One list means a project can no longer be declared to
// Vitest while being absent from every CI lane: that drift kept 27 test files in
// six adapter packages invisible to CI until LAC-1384.
//
// Adding a project here is all it takes to get it running in CI. If a project
// must deliberately stay out of the lanes, say so in `LANE_EXCLUSIONS`
// (scripts/vitest-lanes.mjs) with a reason — the coverage guard prints that
// table on every run and fails closed on anything it cannot account for.

/** @type {string[]} */
export const vitestProjectDirs = [
  "packages/shared",
  "packages/skills-catalog",
  "packages/teams-catalog",
  "packages/db",
  "packages/adapter-utils",
  "packages/adapters/acpx-local",
  "packages/adapters/claude-local",
  "packages/adapters/codex-local",
  "packages/adapters/cursor-cloud",
  "packages/adapters/cursor-local",
  "packages/adapters/gemini-local",
  "packages/adapters/grok-local",
  "packages/adapters/opencode-local",
  "packages/adapters/pi-local",
  "packages/plugins/sdk",
  "packages/plugins/create-paperclip-plugin",
  "server",
  "ui",
  "cli",
];
