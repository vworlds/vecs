import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["**/*.stress.test.ts", "**/*.tooling.test.ts"],
    setupFiles: ["tests/setup.ts"],
    globals: false,
  },
});
