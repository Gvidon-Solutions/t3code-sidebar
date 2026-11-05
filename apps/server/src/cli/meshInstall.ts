import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Argument, Command } from "effect/cli";
import * as Install from "../mesh/MeshInstall.ts";
import * as ProcessRunner from "../processRunner.ts";
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

const decodeInput = Schema.decodeEffect(Schema.fromJsonString(Install.InstallInput));
export const meshInstallCommand = Command.make("__mesh-install", {
  payload: Argument.String("payload"),
}).pipe(
  Command.unlisted,
  Command.withHandler(({ payload }) =>
    Effect.gen(function* () {
      const input = yield* decodeInput(Buffer.from(payload, "base64").toString("utf8"));
      const installed = yield* (yield* Install.MeshInstall).install(input);
      yield* Console.log(yield* encodeJson(installed));
    }).pipe(Effect.provide(Install.layer.pipe(Layer.provide(ProcessRunner.layer)))),
  ),
);
