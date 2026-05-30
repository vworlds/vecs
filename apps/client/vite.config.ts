import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

const workspaceRoot = new URL("../..", import.meta.url).pathname;
const packages = [
  "@vworlds/vecs",
  "@vworlds/vecs-client",
  "@vworlds/vecs-protocol",
  "@vworlds/vecs-wire",
];

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      "@vworlds/vecs": new URL("../../lib/vecs/src/index.ts", import.meta.url).pathname,
      "@vworlds/vecs-client": new URL("../../lib/vecs-client/src/index.ts", import.meta.url)
        .pathname,
      "@vworlds/vecs-protocol": new URL("../../lib/vecs-protocol/src/index.ts", import.meta.url)
        .pathname,
      "@vworlds/vecs-wire": new URL("../../lib/vecs-wire/src/index.ts", import.meta.url).pathname,
    },
  },
  optimizeDeps: {
    exclude: packages,
  },
  server: {
    fs: {
      allow: [workspaceRoot],
    },
  },
});
