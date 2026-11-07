import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";
import { captureBarrier, hasReachedBarrier } from "./convergence.ts";

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const [operation, barrierFile, ...snapshotFiles] = process.argv.slice(2);
  const snapshots = await Promise.all(
    snapshotFiles.map(async (file) => JSON.parse(await NodeFSP.readFile(file, "utf8"))),
  );
  if (operation === "capture") {
    await NodeFSP.writeFile(
      barrierFile,
      JSON.stringify(captureBarrier(snapshots.map((s) => s.document))),
    );
  } else if (operation === "check") {
    const barrier = JSON.parse(await NodeFSP.readFile(barrierFile, "utf8"));
    process.exitCode = snapshots.every((s) => hasReachedBarrier(barrier, s.document)) ? 0 : 1;
  } else {
    throw Error("Usage: convergence.mjs capture|check BARRIER SNAPSHOT...");
  }
}
