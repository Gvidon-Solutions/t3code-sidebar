import { PRIMARY_LOCAL_ENVIRONMENT_ID, type EnvironmentId } from "@t3tools/contracts";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { isStrictlyNewerSemver } from "@t3tools/shared/semver";

export interface ServerUiSource {
  readonly httpBaseUrl: string | null;
}

/**
 * The server UI is worth loading only when it is newer than the bundled client; the
 * shell decides that for trusted clients. A reduced server UI re-selecting itself is
 * not held to the rule.
 */
export function resolveServerUiSource(input: {
  readonly environmentId: EnvironmentId;
  readonly httpBaseUrl: string | null;
  readonly prepared: PreparedConnection | null;
  readonly primaryBearerToken: string | null;
  readonly trustedClient: boolean;
  readonly serverVersion: string | null | undefined;
  readonly bundledVersion: string;
}): ServerUiSource {
  if (input.httpBaseUrl === null) return { httpBaseUrl: null };
  if (!input.trustedClient) return { httpBaseUrl: input.httpBaseUrl };
  if (!isStrictlyNewerSemver(input.serverVersion ?? "", input.bundledVersion))
    return { httpBaseUrl: null };
  const authorization = input.prepared?.httpAuthorization;
  if (authorization?._tag === "Bearer" && authorization.token.length > 0) {
    return { httpBaseUrl: input.httpBaseUrl };
  }
  if (
    input.environmentId === PRIMARY_LOCAL_ENVIRONMENT_ID &&
    input.primaryBearerToken !== null &&
    input.primaryBearerToken.length > 0
  ) {
    return { httpBaseUrl: input.httpBaseUrl };
  }
  return { httpBaseUrl: null };
}
