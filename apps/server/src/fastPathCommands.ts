// Commands that dispatch from the executable bootstrap without loading the full CLI module graph.
const fastPathCommands = [
  "__run-worker",
  "__replica-command",
  "run",
  "__run-guardian",
  "__document-text",
  "__managed-chatgpt-token",
  "acp-mcp-bridge",
  "acp-mcp-call",
] as const;

export type FastPathCommand = (typeof fastPathCommands)[number];

export const isFastPathCommand = (command: string | undefined): command is FastPathCommand =>
  command !== undefined && (fastPathCommands as readonly string[]).includes(command);
