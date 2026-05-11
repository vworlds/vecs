import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    alias: {
      "@vworlds/vecs": fileURLToPath(new URL("../../lib/vecs/src/index.ts", import.meta.url)),
      "@vworlds/vecs-client": fileURLToPath(
        new URL("../../lib/vecs-client/src/index.ts", import.meta.url)
      ),
      "@vworlds/vecs-wire": fileURLToPath(
        new URL("../../lib/vecs-wire/src/index.ts", import.meta.url)
      ),
    },
  },
});
