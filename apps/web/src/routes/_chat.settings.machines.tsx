import { createFileRoute } from "@tanstack/react-router";

import { MeshSettingsPanel } from "../components/workspaces/MeshSettingsPanel";

/** The old Machines page is now the Mesh page; the address stays so old links keep working. */
export const Route = createFileRoute("/_chat/settings/machines")({
  component: MeshSettingsPanel,
});
