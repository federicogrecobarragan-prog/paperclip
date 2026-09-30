import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureCodexSkillsInjected } from "@paperclipai/adapter-codex-local/server";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createPaperclipRepoSkill(root: string, skillName: string) {
  await fs.mkdir(path.join(root, "server"), { recursive: true });
  await fs.mkdir(path.join(root, "packages", "adapter-utils"), { recursive: true });
  await fs.mkdir(path.join(root, "skills", skillName), { recursive: true });
  await fs.writeFile(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n", "utf8");
  await fs.writeFile(path.join(root, "package.json"), '{"name":"paperclip"}\n', "utf8");
  await fs.writeFile(
    path.join(root, "skills", skillName, "SKILL.md"),
    `---\nname: ${skillName}\n---\n`,
    "utf8",
  );
}

async function createCustomSkill(root: string, skillName: string) {
  await fs.mkdir(path.join(root, "custom", skillName), { recursive: true });
  await fs.writeFile(
    path.join(root, "custom", skillName, "SKILL.md"),
    `---\nname: ${skillName}\n---\n`,
    "utf8",
  );
}

async function createDirectoryLink(source: string, target: string): Promise<void> {
  if (process.platform === "win32") {
    await fs.symlink(path.resolve(source), path.resolve(target), "junction");
    return;
  }

  await fs.symlink(source, target);
}

describe("codex local adapter skill injection", () => {
  const paperclipKey = "paperclipai/paperclip/paperclip";
  const createAgentKey = "paperclipai/paperclip/paperclip-create-agent";
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("creates a readable Codex skill directory link and remains idempotent", async () => {
    const currentRepo = await makeTempDir("paperclip-codex-current-");
    const skillsHome = await makeTempDir("paperclip-codex-home-");
    cleanupDirs.add(currentRepo);
    cleanupDirs.add(skillsHome);

    await createPaperclipRepoSkill(currentRepo, "paperclip");
    const source = path.join(currentRepo, "skills", "paperclip");
    const target = path.join(skillsHome, "paperclip");
    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    const options = {
      skillsHome,
      skillsEntries: [{ key: paperclipKey, runtimeName: "paperclip", source }],
    };

    await ensureCodexSkillsInjected(async (stream, chunk) => {
      logs.push({ stream, chunk });
    }, options);
    await ensureCodexSkillsInjected(async (stream, chunk) => {
      logs.push({ stream, chunk });
    }, options);

    expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
    expect(await fs.realpath(target)).toBe(await fs.realpath(source));
    expect(await fs.readFile(path.join(target, "SKILL.md"), "utf8")).toContain("name: paperclip");
    expect(
      logs.filter(({ chunk }) => chunk.includes('Injected Codex skill "paperclip"')),
    ).toHaveLength(1);

    if (process.platform === "win32") {
      expect(path.isAbsolute(await fs.readlink(target))).toBe(true);
    }
  });

  it("preserves the custom linkSkill source and target contract", async () => {
    const currentRepo = await makeTempDir("paperclip-codex-current-");
    const skillsHome = await makeTempDir("paperclip-codex-home-");
    cleanupDirs.add(currentRepo);
    cleanupDirs.add(skillsHome);

    await createPaperclipRepoSkill(currentRepo, "paperclip");
    const source = path.join(currentRepo, "skills", "paperclip");
    const target = path.join(skillsHome, "paperclip");
    const calls: Array<{ source: string; target: string }> = [];

    await ensureCodexSkillsInjected(async () => {}, {
      skillsHome,
      skillsEntries: [{ key: paperclipKey, runtimeName: "paperclip", source }],
      linkSkill: async (receivedSource, receivedTarget) => {
        calls.push({ source: receivedSource, target: receivedTarget });
        await createDirectoryLink(receivedSource, receivedTarget);
      },
    });

    expect(calls).toEqual([{ source, target }]);
    expect(await fs.realpath(target)).toBe(await fs.realpath(source));
  });

  it("repairs a Codex Paperclip skill symlink that still points at another live checkout", async () => {
    const currentRepo = await makeTempDir("paperclip-codex-current-");
    const oldRepo = await makeTempDir("paperclip-codex-old-");
    const skillsHome = await makeTempDir("paperclip-codex-home-");
    cleanupDirs.add(currentRepo);
    cleanupDirs.add(oldRepo);
    cleanupDirs.add(skillsHome);

    await createPaperclipRepoSkill(currentRepo, "paperclip");
    await createPaperclipRepoSkill(currentRepo, "paperclip-create-agent");
    await createPaperclipRepoSkill(oldRepo, "paperclip");
    await createDirectoryLink(
      path.join(oldRepo, "skills", "paperclip"),
      path.join(skillsHome, "paperclip"),
    );

    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    await ensureCodexSkillsInjected(
      async (stream, chunk) => {
        logs.push({ stream, chunk });
      },
      {
        skillsHome,
        skillsEntries: [
          {
            key: paperclipKey,
            runtimeName: "paperclip",
            source: path.join(currentRepo, "skills", "paperclip"),
          },
          {
            key: createAgentKey,
            runtimeName: "paperclip-create-agent",
            source: path.join(currentRepo, "skills", "paperclip-create-agent"),
          },
        ],
      },
    );

    expect(await fs.realpath(path.join(skillsHome, "paperclip"))).toBe(
      await fs.realpath(path.join(currentRepo, "skills", "paperclip")),
    );
    expect(await fs.realpath(path.join(skillsHome, "paperclip-create-agent"))).toBe(
      await fs.realpath(path.join(currentRepo, "skills", "paperclip-create-agent")),
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        stream: "stdout",
        chunk: expect.stringContaining('Repaired Codex skill "paperclip"'),
      }),
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        stream: "stdout",
        chunk: expect.stringContaining('Injected Codex skill "paperclip-create-agent"'),
      }),
    );
  });

  it("preserves a real user-owned Codex skill directory", async () => {
    const currentRepo = await makeTempDir("paperclip-codex-current-");
    const skillsHome = await makeTempDir("paperclip-codex-home-");
    cleanupDirs.add(currentRepo);
    cleanupDirs.add(skillsHome);

    await createPaperclipRepoSkill(currentRepo, "paperclip");
    const userSkill = path.join(skillsHome, "paperclip");
    await fs.mkdir(userSkill);
    await fs.writeFile(path.join(userSkill, "SKILL.md"), "user-owned\n", "utf8");

    await ensureCodexSkillsInjected(async () => {}, {
      skillsHome,
      skillsEntries: [{
        key: paperclipKey,
        runtimeName: "paperclip",
        source: path.join(currentRepo, "skills", "paperclip"),
      }],
    });

    expect((await fs.lstat(userSkill)).isDirectory()).toBe(true);
    expect((await fs.lstat(userSkill)).isSymbolicLink()).toBe(false);
    expect(await fs.readFile(path.join(userSkill, "SKILL.md"), "utf8")).toBe("user-owned\n");
  });

  it("preserves a valid custom Codex skill link outside approved Paperclip runtimes", async () => {
    const currentRepo = await makeTempDir("paperclip-codex-current-");
    const customRoot = await makeTempDir("paperclip-codex-custom-");
    const skillsHome = await makeTempDir("paperclip-codex-home-");
    cleanupDirs.add(currentRepo);
    cleanupDirs.add(customRoot);
    cleanupDirs.add(skillsHome);

    await createPaperclipRepoSkill(currentRepo, "paperclip");
    await createCustomSkill(customRoot, "paperclip");
    await createDirectoryLink(
      path.join(customRoot, "custom", "paperclip"),
      path.join(skillsHome, "paperclip"),
    );

    await ensureCodexSkillsInjected(async () => {}, {
      skillsHome,
      skillsEntries: [{
        key: paperclipKey,
        runtimeName: "paperclip",
        source: path.join(currentRepo, "skills", "paperclip"),
      }],
    });

    expect(await fs.realpath(path.join(skillsHome, "paperclip"))).toBe(
      await fs.realpath(path.join(customRoot, "custom", "paperclip")),
    );
  });

  it("prunes broken symlinks for unavailable Paperclip repo skills before Codex starts", async () => {
    const currentRepo = await makeTempDir("paperclip-codex-current-");
    const oldRepo = await makeTempDir("paperclip-codex-old-");
    const skillsHome = await makeTempDir("paperclip-codex-home-");
    cleanupDirs.add(currentRepo);
    cleanupDirs.add(oldRepo);
    cleanupDirs.add(skillsHome);

    await createPaperclipRepoSkill(currentRepo, "paperclip");
    await createPaperclipRepoSkill(oldRepo, "agent-browser");
    const staleTarget = path.join(oldRepo, "skills", "agent-browser");
    await createDirectoryLink(staleTarget, path.join(skillsHome, "agent-browser"));
    await fs.rm(staleTarget, { recursive: true, force: true });

    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    await ensureCodexSkillsInjected(
      async (stream, chunk) => {
        logs.push({ stream, chunk });
      },
      {
        skillsHome,
        skillsEntries: [{
          key: paperclipKey,
          runtimeName: "paperclip",
          source: path.join(currentRepo, "skills", "paperclip"),
        }],
      },
    );

    await expect(fs.lstat(path.join(skillsHome, "agent-browser"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(logs).toContainEqual(
      expect.objectContaining({
        stream: "stdout",
        chunk: expect.stringContaining('Removed stale Codex skill "agent-browser"'),
      }),
    );
  });

  it("preserves other live Paperclip skill symlinks in the shared workspace skill directory", async () => {
    const currentRepo = await makeTempDir("paperclip-codex-current-");
    const skillsHome = await makeTempDir("paperclip-codex-home-");
    cleanupDirs.add(currentRepo);
    cleanupDirs.add(skillsHome);

    await createPaperclipRepoSkill(currentRepo, "paperclip");
    await createPaperclipRepoSkill(currentRepo, "agent-browser");
    await createDirectoryLink(
      path.join(currentRepo, "skills", "agent-browser"),
      path.join(skillsHome, "agent-browser"),
    );

    await ensureCodexSkillsInjected(async () => {}, {
      skillsHome,
      skillsEntries: [{
        key: paperclipKey,
        runtimeName: "paperclip",
        source: path.join(currentRepo, "skills", "paperclip"),
      }],
    });

    expect((await fs.lstat(path.join(skillsHome, "paperclip"))).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(path.join(skillsHome, "agent-browser"))).isSymbolicLink()).toBe(true);
    expect(await fs.realpath(path.join(skillsHome, "agent-browser"))).toBe(
      await fs.realpath(path.join(currentRepo, "skills", "agent-browser")),
    );
  });
});
