// @effect-diagnostics nodeBuiltinImport:off -- The service launcher starts before the CLI runtime.
import * as NodeModule from "node:module";
import * as NodeSea from "node:sea";
import * as NodeURL from "node:url";

import { isEntrypoint } from "./entrypoint.ts";
import { isFastPathCommand } from "./fastPathCommands.ts";

// Loads an embedded module outside the launcher's module graph. Packaged builds embed each one as a raw asset.
async function loadEmbedded<T>(asset: string, development: () => Promise<T>): Promise<T> {
  if (!NodeSea.isSea()) return development();

  // Keep the executable's module URL so the module finds the web client and native packages beside it.
  const require = NodeModule.createRequire(import.meta.url);
  // require() resolves links in the executable path, such as a Windows junction.
  const cliUrl = NodeURL.pathToFileURL(require.resolve(process.execPath)).href;
  const hook = NodeModule.registerHooks({
    load(url, context, next) {
      if (url !== cliUrl) return next(url, context);
      return {
        format: "module",
        source: new Uint8Array(NodeSea.getRawAsset(asset)),
        shortCircuit: true,
      };
    },
  });
  try {
    return require(process.execPath) as T;
  } finally {
    hook.deregister();
  }
}

const loadCliMain = () =>
  loadEmbedded<typeof import("./binMain.ts")>("binMain.mjs", () => import("./binMain.ts"));
const loadFastMain = () =>
  loadEmbedded<typeof import("./fastMain.ts")>("fastMain.mjs", () => import("./fastMain.ts"));

if (
  isEntrypoint({
    moduleUrl: import.meta.url,
    entryPath: process.argv[1],
    runtimeMain: import.meta.main,
  })
) {
  const command = process.argv[2];
  // Guard sockets before either dispatch path can load outbound-capable modules.
  const { ignoreMacosTypeOfServiceEinval } = await import("./outboundHttp.ts");
  ignoreMacosTypeOfServiceEinval();
  // The launcher owns shutdown until its child exits, so it bypasses the Effect CLI runtime.
  // The service unit passes no arguments; flags and help go through the full CLI.
  if (command === "__service-launcher" && process.argv.length === 3) {
    const { runServiceLauncherCli } = await import("./cli/serviceLauncher.ts");
    await runServiceLauncherCli();
  } else if (isFastPathCommand(command)) {
    const { runFastPath } = await loadFastMain();
    await runFastPath(command);
  } else {
    const { runCliCommand } = await loadCliMain();
    await runCliCommand();
  }
}
