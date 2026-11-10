import { EnvironmentId, PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { describe, expect, it } from "vite-plus/test";

import { resolveServerUiSource } from "./serverUiSource";

const REMOTE = EnvironmentId.make("env-remote");
const LOCAL = EnvironmentId.make(PRIMARY_LOCAL_ENVIRONMENT_ID);

function prepared(
  environmentId: EnvironmentId,
  httpAuthorization: PreparedConnection["httpAuthorization"],
): PreparedConnection {
  return {
    environmentId,
    label: "Studio",
    httpBaseUrl: "https://studio.example/",
    socketUrl: "wss://studio.example/ws",
    httpAuthorization,
    target: {
      _tag: "PrimaryConnectionTarget",
      environmentId,
      label: "Studio",
      httpBaseUrl: "https://studio.example/",
      wsBaseUrl: "wss://studio.example/",
    },
  } as PreparedConnection;
}

const newer: Parameters<typeof resolveServerUiSource>[0] = {
  environmentId: REMOTE,
  httpBaseUrl: "https://studio.example/",
  prepared: prepared(REMOTE, { _tag: "Bearer", token: "saved-token" }),
  primaryBearerToken: null,
  trustedClient: true,
  serverVersion: "0.1.7",
  bundledVersion: "0.1.6",
};

describe("resolveServerUiSource", () => {
  it("hands the shell the saved bearer for a newer remote server UI", () => {
    expect(resolveServerUiSource(newer)).toEqual({ httpBaseUrl: "https://studio.example/" });
  });

  it("uses the shell's local credential for a newer local primary", () => {
    expect(
      resolveServerUiSource({
        ...newer,
        environmentId: LOCAL,
        httpBaseUrl: "http://127.0.0.1:3773/",
        prepared: prepared(LOCAL, null),
        primaryBearerToken: "local-token",
      }),
    ).toEqual({ httpBaseUrl: "http://127.0.0.1:3773/" });
  });

  it("keeps the bundled client when the server UI is equal, older or unknown", () => {
    for (const serverVersion of ["0.1.6", "0.1.5", "studio-1", "", null, undefined]) {
      expect(resolveServerUiSource({ ...newer, serverVersion })).toEqual({ httpBaseUrl: null });
    }
  });

  it("keeps the bundled client when the bundled version is unknown", () => {
    expect(resolveServerUiSource({ ...newer, bundledVersion: "shell-dev" })).toEqual({
      httpBaseUrl: null,
    });
  });

  it("falls back to the bundled UI when no credential can authenticate server UI", () => {
    expect(
      resolveServerUiSource({
        ...newer,
        prepared: prepared(REMOTE, null),
        primaryBearerToken: null,
      }),
    ).toEqual({ httpBaseUrl: null });
  });

  it("never downgrades a running server UI while it re-selects itself", () => {
    expect(
      resolveServerUiSource({
        ...newer,
        serverVersion: "0.1.6",
        prepared: prepared(REMOTE, null),
        primaryBearerToken: null,
        trustedClient: false,
      }),
    ).toEqual({ httpBaseUrl: "https://studio.example/" });
  });
});
