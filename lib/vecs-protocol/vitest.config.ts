import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    alias: {
      "@vworlds/vecs": fileURLToPath(new URL("../vecs/src/index.ts", import.meta.url)),
      "@vworlds/vecs-wire": fileURLToPath(new URL("../vecs-wire/src/index.ts", import.meta.url)),
    },
  },
});
