import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { plainErrorMessage } from "./plainMessage.ts";

it("uses an error's own message instead of its class tag", () => {
  class RpcClientError extends Schema.TaggedError<RpcClientError>()("RpcClientError", {
    message: Schema.String,
  }) {}
  expect(plainErrorMessage(new RpcClientError({ message: "Machine did not answer" }))).toBe(
    "Machine did not answer",
  );
  expect(plainErrorMessage("connection failed")).toBe("connection failed");
  expect(plainErrorMessage(new Error("  "))).toBe("Something went wrong. Try again.");
  expect(plainErrorMessage(undefined)).toBe("Something went wrong. Try again.");
  expect(plainErrorMessage(null, "Could not save")).toBe("Could not save");
});
