import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["**/*.stress.test.ts", "**/*.tooling.test.ts"],
    setupFiles: ["./tests/setup.ts"],
    // Resolve `@vworlds/vecs` to this checkout's own source, mirroring the
    // `paths` mapping in `tsconfig.base.json`. Without it, vitest's node
    // resolution walks up to the repo-root `node_modules/@vworlds/vecs`
    // symlink, which may point at a different checkout's working tree.
    alias: {
      "@vworlds/vecs": fileURLToPath(new URL("../vecs/src/index.ts", import.meta.url)),
    },
  },
});
