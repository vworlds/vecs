import { configDefaults, defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.js";

// Preserve Vite's workspace-source aliases so tests also run before any build.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: { exclude: [...configDefaults.exclude, "**/*.stress.test.ts"] },
  })
);
