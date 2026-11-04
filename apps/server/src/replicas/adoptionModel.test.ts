import { expect, it } from "vite-plus/test";
import { DEFAULT_SIDEBAR_WORKSPACES_CONFIG } from "@t3tools/contracts";
import { adoptionSides } from "./adoptionModel.ts";

it.each([false, true])(
  "identifies the primary and replica when the manual endpoints are reversed: %s",
  (reversed) => {
    const primary = {
      environmentId: "source",
      path: "/source",
      role: "primary" as const,
      transport: "git" as const,
      createdAt: "",
    };
    const config = {
      ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
      machines: {
        source: {},
        target: { label: "target" },
      },
    };
    const local = { protocol: "local", path: "/source" },
      remote = { protocol: "ssh", host: "t3-target", path: "/chosen/copy" };
    const session = {
      identifier: "N-manual",
      paused: false,
      status: "watching",
      alpha: reversed ? remote : local,
      beta: reversed ? local : remote,
    };
    expect(adoptionSides(config, "source", [primary], session)).toEqual({
      source: primary,
      destination: remote,
      machine: "target",
    });
    expect(
      adoptionSides(config, "source", [primary], {
        ...session,
        alpha: { ...session.alpha, path: "/other" },
        beta: { ...session.beta, path: "/other" },
      }),
    ).toBeUndefined();
    expect(
      adoptionSides({ ...config, machines: {} }, "source", [primary], session),
    ).toBeUndefined();
    expect(
      adoptionSides({ ...config, machines: {} }, "source", [primary], session, "target"),
    ).toEqual({ source: primary, destination: remote, machine: "target" });
  },
);
