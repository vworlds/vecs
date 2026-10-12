import config from "./vitest.config.js";

export default {
  ...config,
  test: { ...config.test, include: ["tests/**/*.stress.test.ts"], exclude: [] },
};
