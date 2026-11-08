import * as Context from "effect/Context";
import type * as Tool from "effect/ai/Tool";

export type McpDomain = "threads" | "replicas" | "files" | "filesystem" | "mesh" | "owner";
export class McpDomainAnnotation extends Context.Reference<McpDomain | undefined>(
  "t3/mcp/ToolDomain",
  { defaultValue: () => undefined },
) {}
const catalog = new Map<string, McpDomain>();
export const declareMcpProtocol = <Name extends string>(name: Name, domain: McpDomain) => {
  const existing = catalog.get(name);
  if (existing !== undefined && existing !== domain)
    throw new Error(`Conflicting MCP domains for ${name}`);
  catalog.set(name, domain);
  return { name, domain } as const;
};
export const mcpDomain = (tool: Tool.Any) => Context.get(tool.annotations, McpDomainAnnotation);
export const registerMcpTools = (tools: Readonly<Record<string, Tool.Any>>) => {
  for (const tool of Object.values(tools)) {
    const domain = mcpDomain(tool);
    if (domain !== undefined) declareMcpProtocol(tool.name, domain);
  }
};
export const mcpDomainByName = (name: string) => catalog.get(name);
export const linkAllowsDomain = (
  domain: McpDomain | undefined,
  permissions: {
    readonly threads: boolean;
    readonly replicas: boolean;
    readonly files: "none" | "projects" | "all";
  },
  authenticatedPeer: boolean,
) => {
  if (!authenticatedPeer || domain === undefined || domain === "owner") return false;
  if (domain === "mesh") return true;
  if (domain === "files") return permissions.files !== "none";
  if (domain === "filesystem") return permissions.files === "all";
  return permissions[domain];
};
