import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    alias: {
      "@vworlds/vecs": fileURLToPath(new URL("../vecs/src/index.ts", import.meta.url)),
      "@vworlds/vecs-phaser": fileURLToPath(
        new URL("../vecs-phaser/src/index.ts", import.meta.url)
      ),
      "@vworlds/vecs-physics": fileURLToPath(
        new URL("../vecs-physics/src/index.ts", import.meta.url)
      ),
      "@vworlds/vecs-protocol": fileURLToPath(
        new URL("../vecs-protocol/src/index.ts", import.meta.url)
      ),
      "@vworlds/vecs-server": fileURLToPath(
        new URL("../vecs-server/src/index.ts", import.meta.url)
      ),
      "@vworlds/vecs-wire": fileURLToPath(new URL("../vecs-wire/src/index.ts", import.meta.url)),
    },
  },
});
