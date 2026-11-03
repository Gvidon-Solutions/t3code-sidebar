import { expect, it } from "@effect/vitest";
import { threadContextNote } from "./ReplicaInstructions.ts";
it("injects identity on primary and replica turns within 600 UTF-8 bytes", () => {
  for (const note of [
    "",
    "This is a synchronized replica. Git and builds run on the primary. " + "я".repeat(1000),
  ]) {
    const context = threadContextNote("mcp:thread", "machine", note);
    expect(context).toContain("mcp:thread");
    expect(context).toContain("machine");
    expect(context).toContain("Call t3_thread_self for details");
    expect(new TextEncoder().encode(context).length).toBeLessThanOrEqual(600);
    expect(context).toContain(note ? "primary" : "primary on this machine");
    const longIdentity = threadContextNote("t".repeat(2000), "м".repeat(2000), note);
    expect(new TextEncoder().encode(longIdentity).length).toBeLessThanOrEqual(600);
    expect(longIdentity).toContain("Call t3_thread_self for details");
  }
});
