// The embedded fast-path asset. Like binMain.mjs it loads outside the launcher's module graph;
// only commands that need it pay for its imports.
import type { FastPathCommand } from "./fastPathCommands.ts";

export async function runFastPath(command: FastPathCommand): Promise<void> {
  if (command === "__run-worker") {
    const { runWorker } = await import("./run/RunWorkerEntry.ts");
    runWorker(process.argv[3]!);
  } else if (command === "__replica-command") {
    const { runShim } = await import("./run/RunShim.ts");
    await runShim(process.argv[3]!, process.argv.slice(4));
  } else if (command === "run") {
    const { runCli } = await import("./run/RunCli.ts");
    await runCli(process.argv.slice(3));
  } else if (command === "__run-guardian") {
    const { runGuardian } = await import("./run/RunGuardian.ts");
    await runGuardian(process.argv[3]!);
  } else if (command === "__document-text") {
    const { extractDocumentText } = await import("./provider/documentTextWorker.ts");
    try {
      process.stdout.write(await extractDocumentText(process.argv[3]!, process.argv[4]!));
    } catch (error) {
      if (error instanceof Error && "code" in error && /^E[A-Z0-9]+$/.test(String(error.code))) {
        throw error;
      }
      // Exit 2 identifies document rejections; OS and process failures remain retryable.
      process.exitCode = 2;
    }
  } else if (command === "__managed-chatgpt-token") {
    const { runManagedChatGptTokenCli } = await import("./cli/managedChatGptToken.ts");
    await runManagedChatGptTokenCli(process.argv.slice(3));
  } else if (command === "acp-mcp-bridge" || command === "acp-mcp-call") {
    const { runAcpMcpCliFastPath } = await import("./mcp/AcpMcpStdioBridge.ts");
    await runAcpMcpCliFastPath(command, process.argv.slice(3));
  }
}
