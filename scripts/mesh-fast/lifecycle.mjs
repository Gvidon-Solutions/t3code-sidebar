import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import { run } from "./client.mjs";

const prefix = "io.t3.mesh-fast";
const runId = NodeCrypto.randomUUID();
let identity;

export const defaultJobs = (cores) => Math.min(8, Math.max(1, Math.floor(cores / 4)));

async function processIdentity(pid) {
  try {
    const file = `/proc/${pid}/stat`;
    const stat = await NodeFSP.readFile(file, "utf8");
    return {
      uid: (await NodeFSP.stat(`/proc/${pid}`)).uid,
      start: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19],
    };
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH") return null;
    throw error;
  }
}

export function ownership() {
  identity ??= (async () => {
    const processInfo = await processIdentity(process.pid);
    if (!processInfo) throw Error("Runner process identity disappeared");
    const machineId = (await NodeFSP.readFile("/etc/machine-id", "utf8")).trim();
    if (!machineId) throw Error("A stable Linux machine-id is required for reboot recovery");
    return {
      machine: NodeCrypto.createHash("sha256").update(machineId).digest("hex"),
      boot: (await NodeFSP.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
      uid: processInfo.uid,
      pid: process.pid,
      start: processInfo.start,
      runId,
      hostname: NodeOS.hostname(),
      cores: NodeOS.availableParallelism(),
    };
  })();
  return identity;
}

export function ownershipLabels(owner) {
  return {
    [prefix]: "1",
    ...Object.fromEntries(
      ["machine", "boot", "uid", "pid", "start", "runId"].map((key) => [
        `${prefix}.${key}`,
        String(owner[key]),
      ]),
    ),
  };
}

export const labelArgs = (owner) =>
  Object.entries(ownershipLabels(owner)).flatMap(([key, value]) => ["--label", key + "=" + value]);

export async function ownerIsActive(owner, current) {
  if (owner.boot !== current.boot) return false;
  const process = await processIdentity(owner.pid);
  return process?.uid === owner.uid && process.start === owner.start;
}

async function stale(labels, current) {
  if (
    labels?.[prefix] !== "1" ||
    labels[`${prefix}.machine`] !== current.machine ||
    labels[`${prefix}.uid`] !== String(current.uid)
  )
    return false;
  for (const key of ["boot", "runId"])
    if (!/^[a-f0-9-]{36}$/.test(labels[`${prefix}.${key}`] ?? ""))
      throw Error("Malformed mesh-fast ownership label: " + key);
  for (const key of ["pid", "start"])
    if (!/^[0-9]+$/.test(labels[`${prefix}.${key}`] ?? ""))
      throw Error("Malformed mesh-fast ownership label: " + key);
  return !(await ownerIsActive(
    {
      boot: labels[`${prefix}.boot`],
      uid: current.uid,
      pid: Number(labels[`${prefix}.pid`]),
      start: labels[`${prefix}.start`],
    },
    current,
  ));
}

export async function recoverStale(current) {
  current ??= await ownership();
  const filters = [
    "--filter",
    `label=${prefix}=1`,
    "--filter",
    `label=${prefix}.machine=${current.machine}`,
    "--filter",
    `label=${prefix}.uid=${current.uid}`,
  ];
  const containerIds = (await run("docker", ["ps", "-aq", ...filters]))
    .split(/\s+/)
    .filter(Boolean);
  const networkIds = (await run("docker", ["network", "ls", "-q", ...filters]))
    .split(/\s+/)
    .filter(Boolean);
  const containers = containerIds.length
    ? JSON.parse(await run("docker", ["container", "inspect", ...containerIds]))
    : [];
  const networks = networkIds.length
    ? JSON.parse(await run("docker", ["network", "inspect", ...networkIds]))
    : [];
  const abandonedContainers = [];
  const abandonedNetworks = [];
  for (const container of containers)
    if (await stale(container.Config.Labels, current)) abandonedContainers.push(container);
  for (const network of networks)
    if (await stale(network.Labels, current)) abandonedNetworks.push(network);
  const ownedIds = new Set(abandonedContainers.map((container) => container.Id));
  for (const network of abandonedNetworks)
    if (Object.keys(network.Containers ?? {}).some((id) => !ownedIds.has(id)))
      throw Error(
        "Abandoned mesh-fast network has an active or unowned attachment: " + network.Name,
      );
  const recovered = { containers: [], networks: [], interruptedRuns: [] };
  const runs = new Set();
  for (const container of abandonedContainers) {
    const logs = await run("docker", ["logs", "--tail", "200", container.Id]);
    await run("docker", ["rm", "--force", container.Id]);
    runs.add(container.Config.Labels[`${prefix}.runId`]);
    recovered.containers.push({ id: container.Id, name: container.Name, logs });
  }
  for (const network of abandonedNetworks) {
    await run("docker", ["network", "rm", network.Id]);
    runs.add(network.Labels[`${prefix}.runId`]);
    recovered.networks.push({ id: network.Id, name: network.Name });
  }
  recovered.interruptedRuns = [...runs];
  return recovered;
}

export async function assertHostLease() {
  const fd = process.env.MESH_FAST_HOST_LEASE_FD;
  if (!fd || !/^[0-9]+$/.test(fd)) throw Error("Run mesh-fast through run.sh or pnpm mesh:fast");
  const info = await NodeFSP.readFile(`/proc/self/fdinfo/${fd}`, "utf8");
  if (!info.split("\n").some((line) => line.startsWith("lock:") && /FLOCK.*WRITE/.test(line)))
    throw Error("The mesh-fast host admission lock is not held");
}
