import { describe, expect, it } from "vitest";
import { RPC_UNSPECIFIED_ERROR_CODE as protocolCode } from "@vworlds/vecs-protocol";
import { RPC_UNSPECIFIED_ERROR_CODE } from "../src/index.js";
import { RPC_UNSPECIFIED_ERROR_CODE as clientCode } from "../../vecs-client/src/index.js";

describe("package index", () => {
  it("client and server re-export the protocol's RPC_UNSPECIFIED_ERROR_CODE", () => {
    expect(RPC_UNSPECIFIED_ERROR_CODE).toBe(protocolCode);
    expect(clientCode).toBe(protocolCode);
    expect(RPC_UNSPECIFIED_ERROR_CODE).toBe(1);
  });
});
