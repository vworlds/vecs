import { defineConfig } from "vitest/config";
import core from "./lib/vecs/vitest.config.js";
import physics from "./lib/vecs-physics/vitest.config.js";

export default defineConfig({
  test: {
    projects: [
      {
        ...core,
        test: {
          ...core.test,
          name: "vecs-tooling",
          root: "./lib/vecs",
          include: ["tests/**/*.tooling.test.ts"],
          exclude: ["**/*.stress.test.ts"],
        },
      },
      {
        ...physics,
        test: {
          ...physics.test,
          name: "vecs-physics-tooling",
          root: "./lib/vecs-physics",
          include: ["tests/**/*.tooling.test.ts"],
          exclude: ["**/*.stress.test.ts"],
        },
      },
    ],
  },
});
