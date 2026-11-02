import { createFilesAtoms } from "@t3tools/client-runtime/state/files";

import { connectionAtomRuntime } from "../connection/runtime";

/** T3 Mesh (fork): read or list a file on any connected machine. */
export const filesEnvironment = createFilesAtoms(connectionAtomRuntime);
