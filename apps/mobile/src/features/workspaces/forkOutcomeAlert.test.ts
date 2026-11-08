import { describe, expect, it } from "vite-plus/test";
import { forkOutcomeAlert } from "./forkOutcomeAlert";

describe("forkOutcomeAlert", () => {
  it("explains a missing source thread like web does", () => {
    expect(forkOutcomeAlert({ kind: "source-missing" })).toEqual({
      title: "Could not fork thread",
      message: "This thread is no longer available.",
    });
  });
  it("shows a plain failure message and stays quiet otherwise", () => {
    expect(forkOutcomeAlert({ kind: "failed", message: "Machine did not answer" })).toEqual({
      title: "Could not fork thread",
      message: "Machine did not answer",
    });
    expect(forkOutcomeAlert({ kind: "interrupted" })).toBeNull();
  });
});
