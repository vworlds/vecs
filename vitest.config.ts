import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The server app now has regression tests; the empty client app stays out.
    projects: ["lib/*/vitest.config.ts", "apps/server/vitest.config.ts"],
  },
});
