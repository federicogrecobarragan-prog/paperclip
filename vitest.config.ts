import { defineConfig } from "vitest/config";

// The project list lives in vitest.projects.mjs so scripts/run-vitest-stable.mjs
// can derive the CI lanes from the same array instead of duplicating it by hand.
import { vitestProjectDirs } from "./vitest.projects.mjs";

export default defineConfig({
  test: {
    projects: vitestProjectDirs,
  },
});
