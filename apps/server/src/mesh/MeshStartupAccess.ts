import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http";
import { EnvironmentAuth } from "../auth/EnvironmentAuth.ts";
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const controls = new Set([
  "t3_mesh_exchange",
  "t3_mesh_routes",
  "t3_mesh_update_vote",
  "t3_mesh_update_health",
]);
export function meshControlRequest(body: unknown): boolean {
  if (!object(body)) return false;
  if (body.method === "initialize" || body.method === "notifications/initialized") return true;
  if (body.method !== "tools/call" || !object(body.params)) return false;
  const { name, arguments: args } = body.params;
  return (
    typeof name === "string" &&
    (controls.has(name) ||
      (name === "t3_mesh_relay" &&
        object(args) &&
        typeof args.tool === "string" &&
        controls.has(args.tool)))
  );
}
export const allowed = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const path = request.url.split("?")[0];
  if ((path === "/peer" || path === "/.well-known/t3/environment") && request.method === "GET")
    return true;
  if (path !== "/mcp" || request.method !== "POST") return false;
  const auth = yield* EnvironmentAuth;
  const session = yield* auth.authenticateMcpClient(request).pipe(Effect.result);
  if (
    session._tag === "Failure" ||
    !session.success.peerLink ||
    session.success.access !== "full-access"
  )
    return false;
  const body = yield* request.json.pipe(Effect.result);
  return body._tag === "Success" && meshControlRequest(body.success);
});
