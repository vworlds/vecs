import { defineConfig } from "vite";

const workspaceRoot = new URL("../..", import.meta.url).pathname;
const packages = [
  "@vworlds/vecs",
  "@vworlds/vecs-phaser",
  "@vworlds/vecs-phaser-server",
  "@vworlds/vecs-physics",
  "@vworlds/vecs-protocol",
  "@vworlds/vecs-server",
  "@vworlds/vecs-wire",
];

export default defineConfig({
  resolve: {
    alias: {
      "@vworlds/vecs": new URL("../../lib/vecs/src/index.ts", import.meta.url).pathname,
      "@vworlds/vecs-phaser": new URL("../../lib/vecs-phaser/src/index.ts", import.meta.url)
        .pathname,
      "@vworlds/vecs-phaser-server": new URL(
        "../../lib/vecs-phaser-server/src/index.ts",
        import.meta.url
      ).pathname,
      "@vworlds/vecs-physics": new URL("../../lib/vecs-physics/src/index.ts", import.meta.url)
        .pathname,
      "@vworlds/vecs-protocol": new URL("../../lib/vecs-protocol/src/index.ts", import.meta.url)
        .pathname,
      "@vworlds/vecs-server": new URL("../../lib/vecs-server/src/index.ts", import.meta.url)
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
