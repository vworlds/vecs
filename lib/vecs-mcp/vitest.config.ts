import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["**/*.stress.test.ts"],
    alias: {
      "@vworlds/vecs-client": fileURLToPath(
        new URL("../vecs-client/src/index.ts", import.meta.url)
      ),
      "@vworlds/vecs-server": fileURLToPath(
        new URL("../vecs-server/src/index.ts", import.meta.url)
      ),
      "@vworlds/vecs-protocol": fileURLToPath(
        new URL("../vecs-protocol/src/index.ts", import.meta.url)
      ),
      "@vworlds/vecs": fileURLToPath(new URL("../vecs/src/index.ts", import.meta.url)),
      "@vworlds/vecs-wire": fileURLToPath(new URL("../vecs-wire/src/index.ts", import.meta.url)),
    },
  },
});
