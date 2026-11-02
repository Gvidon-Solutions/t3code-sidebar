import { createMeshLayoutAtoms } from "@t3tools/client-runtime/state/mesh-layout-client";

import { connectionAtomRuntime } from "../connection/runtime";

/** T3 Mesh (fork): layout RPC atoms for the web client. */
export const meshLayoutAtoms = createMeshLayoutAtoms(connectionAtomRuntime);
