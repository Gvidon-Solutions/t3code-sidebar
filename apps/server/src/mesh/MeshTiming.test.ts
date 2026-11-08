// @effect-diagnostics nodeBuiltinImport:off -- A separate Node process verifies module-load environment selection.
import * as NodeChildProcess from "node:child_process";
import { expect, it } from "vite-plus/test";
import { meshMillis, resolveMeshTimeScale, resolveMeshAssetUrl } from "./MeshTiming.ts";

it("retains production timings even with a hostile test environment", () => {
  for (const value of [undefined, "0.001", "0", "NaN", "", "-1", "2"])
    expect(resolveMeshTimeScale(value, true)).toBe(1);
  for (const origin of [undefined, "http://127.0.0.1:1234", "not-a-url"])
    expect(resolveMeshAssetUrl("https://github.com/fixture/archive", origin, true)).toBe(
      "https://github.com/fixture/archive",
    );
});

it("retains all default mesh durations at scale one", () => {
  expect(resolveMeshTimeScale(undefined, false)).toBe(1);
  expect(resolveMeshTimeScale("1", false)).toBe(1);
  for (const value of [200, 1000, 15_000, 30_000, 45_000, 60_000, 120_000, 600_000, 2_592_000_000])
    expect(meshMillis(value)).toBe(value);
  expect(resolveMeshAssetUrl("https://github.com/fixture/archive", undefined, false)).toBe(
    "https://github.com/fixture/archive",
  );
});

it("scales test time and refuses invalid multipliers", () => {
  expect(resolveMeshTimeScale("0.01", false)).toBe(0.01);
  for (const value of ["0", "NaN", "", "-1", "2", "Infinity"])
    expect(() => resolveMeshTimeScale(value, false)).toThrow("T3_MESH_TIME_SCALE");
  expect(
    resolveMeshAssetUrl("https://github.com/fixture/archive", "http://127.0.0.1:1234", false),
  ).toBe("http://127.0.0.1:1234/fixture/archive");
  for (const origin of [
    "http://example.com",
    "https://127.0.0.1",
    "http://127.0.0.1/path",
    "http://user@127.0.0.1",
  ])
    expect(() => resolveMeshAssetUrl("https://github.com/fixture/archive", origin, false)).toThrow(
      "loopback HTTP origin",
    );
});

it("accelerates the real peer heartbeat and reconnect schedule in a source process", () => {
  const source = new URL("../peer/connection/PeerChannel.ts", import.meta.url).href;
  const result = NodeChildProcess.execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { PeerChannel, reconnectDelay } from ${JSON.stringify(source)};
    let now = 0;
    const frames = [], closed = [];
    const peer = new PeerChannel({ now: () => now, send: (wire) => frames.push(JSON.parse(wire)),
      close: (error) => closed.push(error.message), call: async () => null, event: () => {}, pipe: () => {} });
    now = 149; peer.tick();
    if (frames.length) throw Error("Heartbeat fired early");
    now = 150; peer.tick();
    if (frames[0]?.type !== "ping") throw Error("Heartbeat was not scaled");
    now = 450; peer.tick();
    if (closed[0] !== "Peer heartbeat timed out") throw Error("Dead detection was not scaled");
    if (reconnectDelay(0, 1) !== 10 || reconnectDelay(10, 1) !== 150) throw Error("Backoff was not scaled");
    console.log("scaled peer timers verified");
  `,
    ],
    { env: { ...process.env, NODE_ENV: "test", T3_MESH_TIME_SCALE: "0.01" }, encoding: "utf8" },
  );
  expect(result.trim()).toBe("scaled peer timers verified");
});
