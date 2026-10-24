import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const cli = join(root, "node_modules/@vworlds/vmethod/dist/vmethod.mjs");
const hook = join(root, "scripts/vmethod-hooks/verify");

function scratch(t) {
  mkdirSync(join(root, ".tmp"), { recursive: true });
  const directory = mkdtempSync(join(root, ".tmp/adoption."));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, VMETHOD_ROOT: root, VMETHOD_BOARD: "off" },
    ...options,
  });
  assert.ifError(result.error);
  return result;
}

function config(key) {
  const result = run(process.execPath, [cli, "config", "get", key]);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test(
  "consumer config preserves vecs state, hooks and owner merge choice",
  { timeout: 30_000 },
  () => {
    assert.equal(config("repo"), "vworlds/vecs");
    assert.equal(config("stateName"), "vecs");
    assert.equal(config("legacyState"), "- vecs-watch");
    const workerUser = run(process.execPath, [cli, "config", "get", "workerUser"]);
    assert.equal(workerUser.status, 1);
    assert.match(workerUser.stderr, /Unknown config key: workerUser/);
    assert.equal(config("postMerge.trigger"), "package-lock.json");
    assert.equal(config("postMerge.install"), "HUSKY=0 npm ci --no-audit --no-fund");
    assert.equal(config("merge.requireCurrentBase"), "false");
    assert.equal(config("branches.worktreePrefix"), "auto-");
    assert.equal(config("branches.mainCheckout"), "/home/jm/src/vecs");
    assert.equal(
      config("legacyWorkers"),
      "- vecs-orchestrator/workers\n- vecs-orchestrator/claude-workers"
    );
    assert.equal(config("scope.fastPath"), "- bug");
    assert.equal(config("vmethod.repo"), "off");
    assert.equal(config("board.repos"), "- vworlds/vecs\n- vworlds/spacerocks");
  }
);

test("dependency pins and peer versions match the installed release", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json")));
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json")));
  assert.equal(manifest.devDependencies["@vworlds/vmethod"], "1.0.0-rc.6");
  assert.equal(lock.packages["node_modules/@vworlds/vmethod"].version, "1.0.0-rc.6");
  assert.equal(manifest.devDependencies.mermaid, "12.1.0");
  assert.equal(manifest.devDependencies.jsdom, "26.1.0");
});

test(
  "compatibility stubs route to the consumer local bin without network fallbacks",
  { timeout: 30_000 },
  (t) => {
    const directory = scratch(t);
    const bin = join(directory, "node_modules/.bin");
    mkdirSync(bin, { recursive: true });
    const fake = join(bin, "vmethod");
    writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
    chmodSync(fake, 0o755);
    let count = 0;
    for (const folder of ["scripts/agent", "scripts/orchestrator"]) {
      for (const file of readdirSync(join(root, folder))) {
        if (!file.endsWith(".sh")) continue;
        const path = join(root, folder, file);
        if (!readFileSync(path, "utf8").includes("# vmethod stub\n")) continue;
        const verb = file === "watch-prs.sh" ? "watch" : file.slice(0, -3);
        const result = run("bash", [path, "--consumer-probe", "with spaces"], {
          env: { PATH: process.env.PATH, VMETHOD_ROOT: directory },
        });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, `${verb}\n--consumer-probe\nwith spaces\n`);
        count++;
      }
    }
    assert.equal(count, 39);
    rmSync(fake);
    const missing = run("bash", [join(root, "scripts/agent/push.sh")], {
      env: { PATH: process.env.PATH, VMETHOD_ROOT: directory },
    });
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /run npm ci/);
  }
);

function fakeNpm(directory) {
  const bin = join(directory, "bin");
  mkdirSync(bin);
  const path = join(bin, "npm");
  writeFileSync(
    path,
    `#!/bin/sh
printf '%s|%s\\n' "\${HUSKY:-}" "$*" >> "$CALLS"
if [ "$*" = "run bench:sector" ]; then echo 'checksum fixture trace'; fi
if [ "$*" = "\${FAIL_STEP:-}" ]; then echo 'intentional offline failure' >&2; exit 7; fi
`
  );
  chmodSync(path, 0o755);
  return {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    CALLS: join(directory, "calls"),
  };
}

test(
  "verify hook narrows only tests and keeps the full recipe and benchmark",
  { timeout: 30_000 },
  (t) => {
    const directory = scratch(t);
    const env = fakeNpm(directory);
    const logs = join(directory, "logs");
    const result = run(
      "bash",
      [hook, "--logs", logs, "--packages", "@vworlds/vecs @vworlds/vecs-wire", "--bench"],
      { env }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readFileSync(env.CALLS, "utf8"),
      [
        "0|ci",
        "|run typecheck",
        "|run lint",
        "|run format:check",
        "|run test -w @vworlds/vecs",
        "|run test -w @vworlds/vecs-wire",
        "|run test:tooling",
        "|run build",
        "|run bench:sector",
        "",
      ].join("\n")
    );
    assert.match(readFileSync(join(logs, "bench.log"), "utf8"), /checksum fixture trace/);
  }
);

test(
  "verify hook defaults to full tests and stops at the first failure with logs",
  { timeout: 30_000 },
  (t) => {
    const directory = scratch(t);
    const env = fakeNpm(directory);
    let result = run("bash", [hook, "--logs", join(directory, "full")], { env });
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(env.CALLS, "utf8"), /\|run test\n/);
    writeFileSync(env.CALLS, "");
    result = run("bash", [hook, "--logs", join(directory, "failed")], {
      env: { ...env, FAIL_STEP: "run lint" },
    });
    assert.equal(result.status, 7);
    assert.equal(readFileSync(env.CALLS, "utf8"), "0|ci\n|run typecheck\n|run lint\n");
    assert.match(
      readFileSync(join(directory, "failed/lint.log"), "utf8"),
      /intentional offline failure/
    );
    assert.match(result.stderr, /FAIL  lint/);
    assert.equal(run("bash", [hook, "--logs", "relative"], { env }).status, 1);
    assert.equal(run("bash", [hook, "--unknown"], { env }).status, 1);
  }
);

test("verify hook merge scope installs, typechecks and lints only", { timeout: 30_000 }, (t) => {
  const directory = scratch(t);
  const env = fakeNpm(directory);
  let result = run("bash", [hook, "--logs", join(directory, "merge"), "--scope", "merge"], {
    env,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(env.CALLS, "utf8"), "0|ci\n|run typecheck\n|run lint\n");
  writeFileSync(env.CALLS, "");
  result = run("bash", [hook, "--logs", join(directory, "other"), "--scope", "release"], {
    env,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown verify-hook scope: release/);
  assert.equal(readFileSync(env.CALLS, "utf8"), "");
});

test(
  "release dependencies still exist and export the functions release.sh calls",
  { timeout: 30_000 },
  () => {
    const result = run("bash", [
      "-c",
      `set -euo pipefail
    . scripts/lib/changelog.sh
    . scripts/lib/release-publish.sh
    declare -F collect_changelog wait_release_publish release_workspace_packages
    test -s scripts/published-packages.txt
    bash -n .agents/skills/release/release.sh scripts/orchestrator/publish-beta.sh
    bash scripts/agent/check-changelog.sh
  `,
    ]);
    assert.equal(result.status, 0, result.stderr);
  }
);
