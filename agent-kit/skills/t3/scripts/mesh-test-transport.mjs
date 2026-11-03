import * as NodeFS from "node:fs";
const { appendFileSync, readdirSync } = NodeFS;
const log = (name, args) =>
  appendFileSync(process.env.T3CTL_TEST_LOG, JSON.stringify({ name, args }) + "\n");
const self = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  peer = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const rep = {
  environmentId: self,
  path: "/repo",
  projectId: "p",
  role: "primary",
  transport: "git",
};
const config = {
  workspaces: [],
  machines: {
    [self]: { label: "atlas", tag: "AT", aliases: ["офис"], reach: { [peer]: { ssh: "lab" } } },
    [peer]: { label: "lab", tag: "LB", aliases: ["лаборатория", "лаборатории"], color: "#123456" },
  },
  projectMounts: {
    repo: [
      rep,
      {
        environmentId: peer,
        path: "/replica",
        source: self,
        role: "replica",
        transport: "mutagen",
      },
    ],
  },
  projectTitles: { "lp-remote": "Remote project" },
};
config.projectMounts["lp-remote"] = [
  { ...rep, environmentId: peer, path: "/remote", projectId: "remote-p" },
];
if (process.env.T3CTL_TEST_REMOTE_DRIVER)
  config.machines[peer].reach = { [self]: { ssh: "atlas" } };
const snapshot = { environmentId: self, config, document: {} };
const thread = {
  threadId: process.env.T3CTL_TEST_FULL_ID ? "mcp:full-thread-example-0123456789" : "thread-1",
  title: process.env.T3CTL_TEST_LONG_TITLE
    ? "Mount: a long thread title that needs mesh name resolution"
    : "mount work",
  projectId: "p",
  status: "completed",
  updatedAt: new Date().toISOString(),
};
const env = (id = self) => ({
  environmentId: id,
  label: id === self ? "atlas" : "lab",
  serverVersion: "0.1.5",
});
const tools = ["t3_project_place", "t3_project_machines", "t3_pending_request"].map((name) => ({
  name,
}));
function call(name, args) {
  log(name, args);
  switch (name) {
    case "t3_environment_read":
      return env(args.environmentId);
    case "t3_project_list":
      return { projects: [{ id: "p", title: "Demo", workspaceRoot: "/repo" }], nextCursor: null };
    case "t3_thread_list":
      return {
        threads: [
          {
            ...thread,
            environmentId: args.environmentId === "all" ? peer : args.environmentId || self,
          },
        ],
        nextCursor: null,
      };
    case "t3_thread_read":
      if (process.env.T3CTL_TEST_LONG_TITLE && args.threadId === thread.title)
        throw Error(
          JSON.stringify({ code: "thread_not_found", message: "No id matches that title." }),
        );
      return { thread, items: [{ type: "assistant_message", text: "done" }], hasMore: false };
    case "t3_thread_search":
      if (args.environmentId === "all" && process.env.T3CTL_TEST_FALLBACK)
        throw Error("unsupported all");
      return {
        matches: [
          {
            ...thread,
            environmentId: args.environmentId === "all" ? peer : args.environmentId || self,
          },
        ],
      };
    case "t3_project_machines":
      if (args.project === "Remote project")
        return {
          logicalKey: "lp-remote",
          title: "Remote project",
          representations: config.projectMounts["lp-remote"],
        };
      return {
        representations: process.env.T3CTL_TEST_EXISTING
          ? [{ ...rep, environmentId: peer, projectId: "remote-p" }]
          : [],
      };
    case "replicas.adopt":
      return { logicalKey: "repo", representation: rep, ready: false };
    case "t3_project_place":
      return {
        logicalKey: "repo",
        representation:
          args.action === "remove" ? null : { ...rep, environmentId: peer, projectId: "remote-p" },
        ready: true,
      };
    case "t3_thread_send":
    case "t3_thread_interrupt":
      return { sequence: 1 };
    case "t3_thread_self":
      return { threadId: thread.threadId, representation: { role: "replica" } };
    case "t3_thread_wait":
      return { status: "completed", timedOut: false };
    case "t3_pending_request":
      if (args.action === "read")
        return {
          requestId: args.requestId,
          questions: [{ id: "q", question: "Which?", options: [] }],
        };
      if (args.action === "respond") return { sequence: 1 };
      return { requestIds: process.env.T3CTL_TEST_QUESTION ? ["request"] : [] };
    case "orchestrator_capabilities":
      return {
        providers: [
          {
            providerInstanceId: "custom",
            driverKind: "codex",
            models: [{ id: "model-from-destination", isDefault: true, options: [] }],
          },
        ],
      };
    case "t3_thread_launch":
      return { ...thread, modelSelection: args.modelSelection };
    case "ui_open":
      return { clients: 1 };
    case "meshLayout.get":
      return snapshot;
    case "meshLayout.apply":
      if (
        Object.values(args.entries).some((entry) => entry.h.startsWith("0000000000000.")) &&
        readdirSync(`${process.env.XDG_STATE_HOME}/t3-mesh-migrate`).length < 2
      )
        throw Error("backups missing before apply");
      return snapshot;
    case "peerLinks.list":
      return {
        links: [
          {
            ...env(peer),
            status: "reachable",
            label: "lab",
            urls: ["http://peer"],
            access: "full-access",
          },
        ],
      };
    case "peerLinks.link":
      return { ...env(peer), urls: ["http://peer"], access: "full-access" };
    case "peerLinks.unlink":
      return { removed: true };
    case "replicas.status":
      return { replicas: [] };
    case "replicas.retry":
      return { state: "watching" };
    case "files.read":
      return { contents: "hello from lab", byteLength: 14, truncated: false };
    case "server.getConfig":
      return { settings: { sidebarWorkspaces: config, meshEnabled: true } };
    default:
      throw Error("unexpected call " + name);
  }
}
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith("https://api.github.com/")) {
    log("publicRelease", { url: String(url), headers: init?.headers });
    return process.env.T3CTL_TEST_SSH_INSTALL
      ? new Response("unavailable", { status: 404 })
      : Response.json({
          tag_name: "0.0.9-N",
          assets: [
            {
              name: "t3-0.0.9-N-linux-x64.tar.gz",
              browser_download_url: "https://release.example/N-archive",
            },
          ],
        });
  }
  if (String(url) === "https://release.example/N-archive")
    return new Response(NodeFS.readFileSync(process.env.T3CTL_TEST_PUBLIC_ARCHIVE));
  if (String(url).includes("websocket-ticket")) return Response.json({ ticket: "test" });
  const body = JSON.parse(init.body);
  let result;
  if (body.method === "initialize") result = { serverInfo: { version: "0.1.5" } };
  else if (body.method === "notifications/initialized") return new Response("");
  else if (body.method === "tools/list") result = { tools };
  else {
    try {
      result = { structuredContent: call(body.params.name, body.params.arguments), content: [] };
    } catch (e) {
      result = { isError: true, content: [{ type: "text", text: e.message }] };
    }
  }
  return Response.json({ id: body.id, result });
};
globalThis.WebSocket = class {
  constructor() {
    queueMicrotask(() => this.onopen?.());
  }
  send(text) {
    const m = JSON.parse(text);
    if (m._tag !== "Request") return;
    const value = call(m.tag, m.payload);
    queueMicrotask(() =>
      this.onmessage({
        data: JSON.stringify(
          m.tag === "replicas.status"
            ? { _tag: "Chunk", requestId: m.id, values: [value] }
            : { _tag: "Exit", requestId: m.id, exit: { _tag: "Success", value } },
        ),
      }),
    );
  }
  close() {}
};
