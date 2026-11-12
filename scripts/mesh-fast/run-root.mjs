import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/** Creates the artifacts directory and returns the canonical path fixture roots must use. */
export async function prepareArtifactsDirectory(directory) {
  await NodeFSP.mkdir(directory, { recursive: true });
  return NodeFSP.realpath(directory);
}

export async function createRunRoot(directory) {
  const artifactsDirectory = await prepareArtifactsDirectory(directory);
  const root = await NodeFSP.mkdtemp(NodePath.join(artifactsDirectory, "mesh-fast-"));
  return { artifactsDirectory, root };
}
