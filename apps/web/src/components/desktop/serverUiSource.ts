import { PRIMARY_LOCAL_ENVIRONMENT_ID, type EnvironmentId } from "@t3tools/contracts";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";

export interface ServerUiSource {
  readonly httpBaseUrl: string | null;
}

/**
 * Picks the server UI source together with the credential the shell needs to proxy its
 * first-party session. The trusted client never hands the server UI a saved credential:
 * the shell keeps it in memory. A direct source with no usable credential falls back to
 * the bundled client, which still has the saved connections.
 */
export function resolveServerUiSource(input: {
  readonly environmentId: EnvironmentId;
  readonly httpBaseUrl: string | null;
  readonly prepared: PreparedConnection | null;
  readonly primaryBearerToken: string | null;
  readonly trustedClient: boolean;
}): ServerUiSource {
  if (input.httpBaseUrl === null) return { httpBaseUrl: null };
  if (!input.trustedClient) return { httpBaseUrl: input.httpBaseUrl };
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
