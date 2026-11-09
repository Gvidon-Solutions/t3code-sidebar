import { expect, it } from "vite-plus/test";
import { peerSessionLabel } from "./PeerCredentials.ts";

it("keeps a peer label on one bounded line", () => {
  expect(peerSessionLabel("cloudbox")).toBe("Linked machine · cloudbox");
  expect(peerSessionLabel(undefined)).toBe("Linked machine");
  expect(peerSessionLabel("   ")).toBe("Linked machine");
  expect(peerSessionLabel("cloud\nbox\tstudio")).toBe("Linked machine · cloud box studio");
  expect(peerSessionLabel("bad\u0000label\u001b[31m")).toBe("Linked machine · bad label [31m");
  const long = peerSessionLabel("x".repeat(200));
  expect(long.startsWith("Linked machine · ")).toBe(true);
  expect(long.length).toBe("Linked machine · ".length + 64);
  expect(long.endsWith("…")).toBe(true);
});
