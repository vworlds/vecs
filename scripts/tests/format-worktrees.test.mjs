import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("repository formatting never descends into task worktrees", () => {
  mkdirSync(join(root, ".tmp"), { recursive: true });
  const fixture = mkdtempSync(join(root, ".tmp/format-worktrees."));
  const locked = join(fixture, ".worktrees/x/.tmp/unreadable");
  mkdirSync(locked, { recursive: true });
  try {
    for (const file of [
      "package.json",
      ".prettierrc",
      ".prettierignore",
      "scripts/agent/check-markdown.sh",
      "scripts/vmethod-hooks/verify",
      ".agents/skills/release/release.sh",
      "apps/client/docker/nginx.conf",
      "apps/client/docker/entrypoint.sh",
      "apps/server/docker/Dockerfile",
    ]) {
      mkdirSync(dirname(join(fixture, file)), { recursive: true });
      copyFileSync(join(root, file), join(fixture, file));
    }
    symlinkSync(join(root, "node_modules"), join(fixture, "node_modules"), "dir");
    chmodSync(locked, 0o000);
    // Fail rather than silently claiming permission coverage when run as root.
    assert.throws(() => readdirSync(locked), { code: "EACCES" });
    const nested = join(fixture, ".worktrees/x/unformatted.json");
    const unformatted = '{"keep":true}';
    writeFileSync(nested, unformatted);

    const run = (script) => spawnSync("npm", ["run", script], { cwd: fixture, encoding: "utf8" });
    const passes = (script) => {
      const result = run(script);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    };
    passes("format:check");
    passes("format");
    assert.equal(readFileSync(nested, "utf8"), unformatted);

    // Excluding worktrees must not disable formatting checks on repository files.
    writeFileSync(join(fixture, "unformatted.json"), unformatted);
    const badFile = run("format:check");
    assert.equal(badFile.status, 1, `${badFile.stdout}\n${badFile.stderr}`);
    assert.match(badFile.stderr, /unformatted\.json/);
    passes("format");
    passes("format:check");
  } finally {
    chmodSync(locked, 0o700);
    rmSync(fixture, { recursive: true, force: true });
  }
});
