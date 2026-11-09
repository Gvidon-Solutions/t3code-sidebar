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

describe("resolveServerUiSource", () => {
  it("hands the shell the saved bearer for a remote server UI", () => {
    expect(
      resolveServerUiSource({
        environmentId: REMOTE,
        httpBaseUrl: "https://studio.example/",
        prepared: prepared(REMOTE, { _tag: "Bearer", token: "saved-token" }),
        primaryBearerToken: null,
        trustedClient: true,
      }),
    ).toEqual({ httpBaseUrl: "https://studio.example/", authorization: "saved-token" });
  });

  it("uses the shell's local credential for the local primary", () => {
    expect(
      resolveServerUiSource({
        environmentId: LOCAL,
        httpBaseUrl: "http://127.0.0.1:3773/",
        prepared: prepared(LOCAL, null),
        primaryBearerToken: "local-token",
        trustedClient: true,
      }),
    ).toEqual({ httpBaseUrl: "http://127.0.0.1:3773/", authorization: "local-token" });
  });

  it("falls back to the bundled UI when no credential can authenticate server UI", () => {
    expect(
      resolveServerUiSource({
        environmentId: REMOTE,
        httpBaseUrl: "https://studio.example/",
        prepared: prepared(REMOTE, null),
        primaryBearerToken: null,
        trustedClient: true,
      }),
    ).toEqual({ httpBaseUrl: null });
  });

  it("never downgrades a running server UI while it re-selects itself", () => {
    expect(
      resolveServerUiSource({
        environmentId: REMOTE,
        httpBaseUrl: "https://studio.example/",
        prepared: prepared(REMOTE, null),
        primaryBearerToken: null,
        trustedClient: false,
      }),
    ).toEqual({ httpBaseUrl: "https://studio.example/" });
  });
});
