import { beforeAll } from "vitest";

import { preloadPhysics } from "../src/adapter/runtime.js";

beforeAll(async () => {
  await preloadPhysics();
});
