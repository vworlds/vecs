import { describe, expect, it } from "vitest";
import { RPC_UNSPECIFIED_ERROR_CODE as protocolCode } from "@vworlds/vecs-protocol";
import { RPC_UNSPECIFIED_ERROR_CODE } from "../src/index.js";

describe("package index", () => {
  it("re-exports the protocol's RPC_UNSPECIFIED_ERROR_CODE", () => {
    expect(RPC_UNSPECIFIED_ERROR_CODE).toBe(protocolCode);
    expect(RPC_UNSPECIFIED_ERROR_CODE).toBe(1);
  });
});
