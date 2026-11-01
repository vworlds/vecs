import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createVitest } from "vitest/node";

const root = fileURLToPath(new URL("../../", import.meta.url));

test(
  "root projects preserve workspace resolution and separate unit/tooling tiers",
  {
    timeout: 30_000,
  },
  async () => {
    const unit = await createVitest("test", {
      root,
      config: `${root}vitest.config.ts`,
      watch: false,
      maxWorkers: 2,
    });
    let tooling;
    try {
      await unit.standalone();
      assert.equal(unit.config.maxWorkers, 2);
      assert.equal(unit.projects.length, 11);
      const units = await unit.globTestSpecifications();
      assert.ok(units.length > 200);
      assert.ok(units.every(({ moduleId }) => !/\.(stress|tooling)\.test\.ts$/.test(moduleId)));
      assert.ok(units.every(({ moduleId }) => !moduleId.startsWith(`${root}apps/client/`)));
      assert.equal(
        units.filter(({ moduleId }) => moduleId.startsWith(`${root}apps/server/`)).length,
        3
      );
      for (const project of unit.projects) {
        const relativeRoot = project.config.root.slice(root.length);
        const workspace = await createVitest("test", {
          root: project.config.root,
          config: `${project.config.root}/vitest.config.ts`,
          watch: false,
          maxWorkers: 2,
        });
        try {
          await workspace.standalone();
          const aliases = (value) =>
            value.vite.config.resolve.alias.filter(
              ({ find }) => String(find).startsWith("@vworlds/") || find === "phaser"
            );
          assert.deepEqual(aliases(project), aliases(workspace.projects[0]), relativeRoot);
          assert.deepEqual(
            project.config.setupFiles,
            workspace.projects[0].config.setupFiles,
            relativeRoot
          );
          const direct = await workspace.globTestSpecifications();
          assert.deepEqual(
            units
              .filter((spec) => spec.project === project)
              .map((spec) => spec.moduleId)
              .sort(),
            direct.map((spec) => spec.moduleId).sort(),
            relativeRoot
          );
        } finally {
          await workspace.close();
        }
      }

      tooling = await createVitest("test", {
        root,
        config: `${root}vitest.tooling.config.ts`,
        watch: false,
        maxWorkers: 2,
      });
      await tooling.standalone();
      const tools = await tooling.globTestSpecifications();
      assert.deepEqual(tools.map(({ moduleId }) => moduleId.slice(root.length)).sort(), [
        "lib/vecs-physics/tests/lifecycle/world_disposal.tooling.test.ts",
        "lib/vecs/tests/publish_preparation.tooling.test.ts",
        "lib/vecs/tests/testing-export.tooling.test.ts",
      ]);
      assert.ok(
        units.some(({ moduleId }) => moduleId.endsWith("/lifecycle/world_disposal.test.ts"))
      );
    } finally {
      await tooling?.close();
      await unit.close();
    }
  }
);
