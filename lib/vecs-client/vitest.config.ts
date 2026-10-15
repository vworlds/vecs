import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["**/*.stress.test.ts"],
    alias: {
      "@vworlds/vecs": fileURLToPath(new URL("../vecs/src/index.ts", import.meta.url)),
      "@vworlds/vecs-protocol": fileURLToPath(
        new URL("../vecs-protocol/src/index.ts", import.meta.url)
      ),
      "@vworlds/vecs-wire": fileURLToPath(new URL("../vecs-wire/src/index.ts", import.meta.url)),
    },
  },
});
