import { expect, it } from "vite-plus/test";
import { authenticatedPeerHops, parseHops, formatHops, relayHopsAllowed } from "./peerIdentity.ts";

it("preserves absent and malformed hop headers for identity validation", () => {
  expect(parseHops(undefined)).toBeUndefined();
  for (const hops of [["peer"], ["origin", "peer"], [""], ["origin", "", "peer"]])
    expect(parseHops(formatHops(hops))).toEqual(hops);
  for (const hops of [
    [],
    [""],
    ["peer", "peer"],
    ["self", "peer"],
    ["origin", "other"],
    ["a", "b", "peer"],
  ])
    expect(authenticatedPeerHops(hops, "peer", "self")).toBe(false);
  expect(authenticatedPeerHops(undefined, "peer", "self")).toBe(true);
  expect(authenticatedPeerHops(["peer"], "peer", "self")).toBe(true);
  expect(authenticatedPeerHops(["origin", "peer"], "peer", "self")).toBe(true);
  expect(authenticatedPeerHops(["self"], "self", "self")).toBe(false);
});

it("allows a single relay without loops", () => {
  expect(relayHopsAllowed(["origin"], "relay", "target")).toBe(true);
  for (const hops of [[], [""], ["relay"], ["target"], ["a", "b"]])
    expect(relayHopsAllowed(hops, "relay", "target")).toBe(false);
  expect(relayHopsAllowed(["origin"], "self", "self")).toBe(false);
});
