import { expect, it } from "@effect/vitest";
import {
  bindingsFromLayout,
  parseConfig,
  repairMachineIdentity,
  renameMachineBindings,
} from "@t3tools/shared/meshConfig";
import { merge, type MeshLayoutDocument } from "@t3tools/shared/meshLayout";
import { sshFiles } from "../replicas/sshBlocks.ts";

it("routes colliding machine names and a renamed binding to their original environments", () => {
  const h = "0000000000001.00000.studio";
  const doc = parseConfig({ schema: 1, machines: { studio: { title: "Studio" } } });
  const document: MeshLayoutDocument = {
    "mesh.machineBinding/studio": { v: "beta", h },
    ...Object.fromEntries(
      ["alpha", "beta"].map((id) => [
        `mesh.machineClaim/${id}`,
        { v: { name: "studio", machine: { title: "Studio" } }, h },
      ]),
    ),
  };
  const repaired = repairMachineIdentity(document, doc);
  const fixed = merge(
    document,
    Object.fromEntries(
      Object.entries(repaired.updates).map(([key, v]) => [
        key,
        { v, h: "0000000000002.00000.studio" },
      ]),
    ),
  );
  const routes = (state: MeshLayoutDocument, config: typeof doc) =>
    sshFiles(
      Object.entries(bindingsFromLayout(state)).map(([name, environmentId]) => ({
        name,
        environmentId,
        settings: config.machines[name]!,
        facts: {
          reported: {
            user: "developer",
            version: "1",
            reportedAt: "",
            platform: { os: "linux", arch: "x64", release: "test" },
            meshPublicKey: "ssh-ed25519 AAAA",
            sshd: { port: 22, hostKeys: ["ssh-ed25519 BBBB"] },
          },
        },
      })),
      {
        runtime: ["t3"],
        baseDir: "/mesh-test",
        identity: "/mesh-test/key",
        knownHosts: "/mesh-test/known",
      },
    ).config.join("\n");
  const stanza = (text: string, host: string) =>
    text.split(/^Host /m).find((block) => block.startsWith(`${host}\n`));
  const initial = routes(fixed, repaired.doc);
  expect(stanza(initial, "t3-studio")).toContain("'alpha'");
  expect(stanza(initial, "t3-studio-2")).toContain("'beta'");
  const { studio, ...others } = repaired.doc.machines;
  const renamed = { ...repaired.doc, machines: { ...others, desk: studio! } };
  const moved = merge(
    fixed,
    Object.fromEntries(
      Object.entries(renameMachineBindings(fixed, repaired.doc, renamed)).map(([key, v]) => [
        key,
        { v, h: "0000000000003.00000.studio" },
      ]),
    ),
  );
  const after = routes(moved, renamed);
  expect(after).toContain("Host t3-desk\n");
  expect(after).not.toContain("Host t3-studio\n");
  expect(stanza(after, "t3-desk")).toContain("'alpha'");
  expect(stanza(after, "t3-studio-2")).toContain("'beta'");
});
