import { expect, it } from "vite-plus/test";
import { plainErrorMessage } from "./plainMessage.ts";

it("uses an error's own message instead of its class tag", () => {
  class RpcClientError extends Error {
    readonly _tag = "RpcClientError";
  }
  expect(plainErrorMessage(new RpcClientError("Machine did not answer"))).toBe(
    "Machine did not answer",
  );
  expect(plainErrorMessage("connection failed")).toBe("connection failed");
  expect(plainErrorMessage(new Error("  "))).toBe("Something went wrong. Try again.");
  expect(plainErrorMessage(undefined)).toBe("Something went wrong. Try again.");
  expect(plainErrorMessage(null, "Could not save")).toBe("Could not save");
});
